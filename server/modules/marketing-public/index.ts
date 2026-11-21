import crypto from 'node:crypto';
import express, { Router, type Request } from 'express';
import { APP_CONFIG } from '../../config.ts';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import { sendApiError } from '../../core/security/rbac.ts';
import { createSlidingWindowRateLimiter, extractClientIp } from '../../middleware/rate-limit.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import { runUnassignedLeadDrainer } from '../../cron/subroutines/lead-drainer.ts';
import {
  evaluateAllDynamicAudiencesForTenant,
  promoteLeadsToSaleRoundInTx,
  refreshAudienceCachedCount,
  upsertMasterContactInTx,
} from '../audiences/audiences.service.ts';
import { slugifyKeyLower } from '../org-rbac/org-rbac.service.ts';
import { ensureMarketingSchema } from '../marketing/schema.ts';
import { registerFlowEventListeners } from '../marketing/flow-engine.service.ts';
import {
  buildCountdownTimerSvg,
  generateShortCode,
  hashOtpCode,
  normalizeSuppressionRecipient,
  parseJsonCol,
  readTenantChannelVault,
  resolvePublicRequestOrigin,
  verifyUnsubscribeHmac,
} from '../marketing/utils.ts';
import { dispatchMarketingEmail, dispatchSmsOtpNotification } from '../marketing/dispatchers.ts';
import type { FormFieldSchemaDto } from '../marketing/forms.routes.ts';
import type { SurveyBlockItemDto } from '../marketing/surveys.routes.ts';
import {
  extractContactEntitiesFromText,
  generateBotReplyFromRag,
  resolveBotReplyInTx,
  type FaqRuleItemDto,
} from '../marketing/social-bot.routes.ts';
import {
  resolveMetaMessengerVaultConfig,
  sendMetaMessengerMessage,
  verifyMetaWebhookSignature,
} from '../../services/meta-messenger.service.ts';
import { handleSesSnsWebhook } from '../../services/ses-sns.service.ts';

export const router = Router();

// Public AWS SES/SNS webhook alias (`POST /api/v1/public/marketing/sns-webhook`)
router.post(
  '/sns-webhook',
  express.text({ type: () => true, limit: '2mb' }),
  handleSesSnsWebhook
);

// Public Dynamic Countdown SVG (`GET /api/v1/public/marketing/timer`)
router.get('/timer', (req, res) => {
  const target = String(req.query.target || new Date(Date.now() + 86400_000 * 3).toISOString());
  const accent = String(req.query.color || req.query.accent || '#1E40FF');
  const bg = req.query.bg !== undefined ? String(req.query.bg) : undefined;
  const label = String(req.query.label || 'Ưu đãi kết thúc sau');
  const svg = buildCountdownTimerSvg(target, accent, label, bg);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(svg);
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 1x1 Transparent GIF Pixel for Open Tracking
const TRANSPARENT_GIF_1X1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

router.use(async (_req, res, next) => {
  try {
    await ensureMarketingSchema();
    registerFlowEventListeners();
    next();
  } catch (err: any) {
    sendApiError(res, 500, 'PUBLIC_MARKETING_SCHEMA_FAILED', err?.message || 'Lỗi khởi tạo cổng Public Marketing.');
  }
});

/**
 * Audited Pre-Auth Tenant Resolver for Public Endpoints:
 * Maps `tenant_slug` / `X-Tenant-Slug` / `form_token` / `site_key` -> `tenant_id`
 * before entering RLS-enforced `withTenantTransaction`.
 */
async function resolvePublicTenantId(req: Request): Promise<string | null> {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const rawTenantId = String(body.tenant_id || req.query.tenant_id || '').trim();
  const rawSlug = String(
    req.header('X-Tenant-Slug') || body.tenant_slug || req.query.tenant_slug || ''
  )
    .trim()
    .toLowerCase();
  const formToken = String(body.form_token || req.query.form_token || '').trim();
  const siteKey = String(body.site_key || req.query.site_key || '').trim();

  return withSystemPrivilege(async (client) => {
    if (formToken) {
      const f = await client.query<{ tenant_id: string }>(
        `SELECT f.tenant_id
         FROM mkt_forms f
         INNER JOIN tenants t ON t.id = f.tenant_id
         WHERE f.public_token = $1 AND t.status != 'deleted'
         LIMIT 1`,
        [formToken]
      );
      if (f.rows[0]?.tenant_id) return f.rows[0].tenant_id;
    }

    if (siteKey) {
      const p = await client.query<{ tenant_id: string }>(
        `SELECT p.tenant_id
         FROM mkt_web_properties p
         INNER JOIN tenants t ON t.id = p.tenant_id
         WHERE p.site_key = $1 AND t.status != 'deleted'
         LIMIT 1`,
        [siteKey]
      );
      if (p.rows[0]?.tenant_id) return p.rows[0].tenant_id;
    }

    if (rawSlug) {
      const t = await client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE (slug = $1 OR obfuscated_slug = $1) AND status != 'deleted' LIMIT 1`,
        [rawSlug]
      );
      if (t.rows[0]?.id) return t.rows[0].id;
    }

    if (rawTenantId && UUID_REGEX.test(rawTenantId)) {
      const t = await client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE id = $1 AND status != 'deleted' LIMIT 1`,
        [rawTenantId]
      );
      if (t.rows[0]?.id) return t.rows[0].id;
    }

    return null;
  });
}

// ============================================================================
// 1. Public Form Schema & Submission (`/api/v1/public/marketing/forms/:token`)
// ============================================================================
router.get('/forms/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const resolved = await withSystemPrivilege(async (client) => {
      const r = await client.query<{ tenant_id: string; form_id: string; company_name: string }>(
        `SELECT f.tenant_id, f.id AS form_id, t.name AS company_name
         FROM mkt_forms f
         INNER JOIN tenants t ON t.id = f.tenant_id
         WHERE f.public_token = $1 AND f.status = 'active' AND t.status != 'deleted'
         LIMIT 1`,
        [token]
      );
      return r.rows[0] || null;
    });

    if (!resolved) {
      sendApiError(res, 404, 'PUBLIC_FORM_NOT_FOUND', 'Biểu mẫu không tồn tại hoặc đã tạm ngưng.');
      return;
    }

    const data = await withTenantTransaction(resolved.tenant_id, async (client) => {
      const r = await client.query('SELECT * FROM mkt_forms WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        resolved.tenant_id,
        resolved.form_id,
      ]);
      const f = r.rows[0];
      if (!f) return null;
      return {
        id: String(f.id),
        name: String(f.name),
        description: f.description ? String(f.description) : '',
        company_name: resolved.company_name,
        require_otp: Boolean(f.require_otp),
        otp_channel: String(f.otp_channel || 'email'),
        fields: parseJsonCol<FormFieldSchemaDto[]>(f.fields_json, []),
        theme: parseJsonCol(f.theme_json, {}),
        thank_you: parseJsonCol(f.thank_you_json, {}),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_PUBLIC_FORM_FAILED', err?.message || 'Không thể tải Biểu mẫu.');
  }
});

const publicFormSurveyRateLimiter = createSlidingWindowRateLimiter({
  name: 'mkt_public_submit',
  windowMs: 60_000,
  maxRequests: 30,
  message: 'Quá nhiều lượt gửi form/khảo sát từ địa chỉ IP này. Vui lòng thử lại sau 1 phút.',
});

const publicOtpRateLimiter = createSlidingWindowRateLimiter({
  name: 'mkt_public_otp',
  windowMs: 60_000,
  maxRequests: 10,
  keyFn: (req) => {
    const rec = String((req.body && typeof req.body === 'object' ? (req.body as any).recipient : '') || '')
      .trim()
      .toLowerCase();
    return `${extractClientIp(req)}:${rec || 'anon'}`;
  },
  message: 'Bạn yêu cầu mã OTP quá nhiều lần. Vui lòng thử lại sau 1 phút.',
});

const publicWebTrackRateLimiter = createSlidingWindowRateLimiter({
  name: 'mkt_public_track',
  windowMs: 60_000,
  maxRequests: 180,
  message: 'Web tracking rate limit exceeded.',
});

router.post('/forms/:token/submit', publicFormSurveyRateLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const resolved = await withSystemPrivilege(async (client) => {
      const r = await client.query<{ tenant_id: string; form_id: string }>(
        `SELECT f.tenant_id, f.id AS form_id
         FROM mkt_forms f
         INNER JOIN tenants t ON t.id = f.tenant_id
         WHERE f.public_token = $1 AND f.status = 'active' AND t.status != 'deleted'
         LIMIT 1`,
        [token]
      );
      return r.rows[0] || null;
    });

    if (!resolved) {
      sendApiError(res, 404, 'PUBLIC_FORM_NOT_FOUND', 'Biểu mẫu không tồn tại hoặc đã đóng.');
      return;
    }

    const cfg = await getTenantSettingsCached(resolved.tenant_id);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
    const rawValues: Record<string, any> =
      body.values && typeof body.values === 'object'
        ? { ...body.values }
        : body.data && typeof body.data === 'object'
          ? { ...body.data }
          : { ...body };

    const phoneVal = String(rawValues.phone || rawValues.mobile || rawValues.sdt || '').trim();
    const emailVal = String(rawValues.email || '').trim().toLowerCase();

    // Never hard-require email if phone is present (and vice-versa)!
    if (!phoneVal && !emailVal) {
      sendApiError(
        res,
        422,
        'CONTACT_REQUIRED',
        'Vui lòng nhập Số điện thoại hoặc Email để gửi biểu mẫu.'
      );
      return;
    }

    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '')
      .split(',')[0]
      .trim()
      .slice(0, 64);

    let drainSaleRound = false;
    const txOut = await withTenantTransaction(resolved.tenant_id, async (client) => {
      const fRes = await client.query('SELECT * FROM mkt_forms WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        resolved.tenant_id,
        resolved.form_id,
      ]);
      const form = fRes.rows[0];
      if (!form) return { errorCode: 'FORM_MISSING' as const };

      // Verify OTP if required by form (atomic single-use consumption)
      let otpVerified = false;
      if (form.require_otp) {
        const expectedChannel = form.otp_channel === 'sms' ? 'sms' : 'email';
        const recipient = expectedChannel === 'sms' ? phoneVal : emailVal;
        const otpId = String(body.otp_id || rawValues.otp_id || '').trim();
        const otpCode = String(body.otp_code || rawValues.otp_code || '').trim();

        let otpOk = false;
        if (otpId) {
          if (UUID_REGEX.test(otpId) && recipient) {
            if (otpCode) {
              const expectedHash = hashOtpCode(resolved.tenant_id, recipient, otpCode);
              const consumeRes = await client.query(
                `UPDATE mkt_otp_verifications
                 SET verified = true,
                     verified_at = COALESCE(verified_at, clock_timestamp()),
                     consumed_at = clock_timestamp()
                 WHERE tenant_id = $1
                   AND id = $2
                   AND (verified = true OR code_hash = $5)
                   AND consumed_at IS NULL
                   AND LOWER(recipient) = $3
                   AND LOWER(channel) = $4
                   AND expires_at >= clock_timestamp()`,
                [resolved.tenant_id, otpId, recipient.trim().toLowerCase(), expectedChannel, expectedHash]
              );
              otpOk = (consumeRes.rowCount || 0) === 1;
            } else {
              const consumeRes = await client.query(
                `UPDATE mkt_otp_verifications
                 SET consumed_at = clock_timestamp()
                 WHERE tenant_id = $1
                   AND id = $2
                   AND verified = true
                   AND consumed_at IS NULL
                   AND LOWER(recipient) = $3
                   AND LOWER(channel) = $4
                   AND expires_at >= clock_timestamp()`,
                [resolved.tenant_id, otpId, recipient.trim().toLowerCase(), expectedChannel]
              );
              otpOk = (consumeRes.rowCount || 0) === 1;
            }
          }
        } else if (otpCode && recipient) {
          const expectedHash = hashOtpCode(resolved.tenant_id, recipient, otpCode);
          const vRes = await client.query<{ id: string }>(
            `SELECT id FROM mkt_otp_verifications
             WHERE tenant_id = $1
               AND LOWER(channel) = $2
               AND LOWER(recipient) = $3
               AND code_hash = $4
               AND consumed_at IS NULL
               AND expires_at >= clock_timestamp()
             ORDER BY created_at DESC LIMIT 1`,
            [resolved.tenant_id, expectedChannel, recipient.toLowerCase(), expectedHash]
          );
          if (vRes.rows[0]?.id) {
            const consumeRes = await client.query(
              `UPDATE mkt_otp_verifications
               SET verified = true,
                   verified_at = COALESCE(verified_at, clock_timestamp()),
                   consumed_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2 AND consumed_at IS NULL`,
              [resolved.tenant_id, vRes.rows[0].id]
            );
            otpOk = (consumeRes.rowCount || 0) === 1;
          }
        }

        if (!otpOk) {
          return { errorCode: 'OTP_REQUIRED_OR_INVALID' as const };
        }
        otpVerified = true;
      }

      const routingMode = String(form.routing_mode || 'marketing_nurture') as 'marketing_nurture' | 'sale_round';
      const defaultStatus = routingMode === 'sale_round' ? 'unassigned_pending' : 'marketing_nurture';

      const customFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawValues)) {
        if (!['name', 'full_name', 'phone', 'mobile', 'sdt', 'email', 'product_interest', 'otp_code', 'otp_id'].includes(k)) {
          customFields[k] = v;
        }
      }

      const upserted = await upsertMasterContactInTx(
        client,
        resolved.tenant_id,
        {
          name: rawValues.name || rawValues.full_name,
          phone: phoneVal || undefined,
          email: emailVal || undefined,
          product_interest: rawValues.product_interest || form.name,
          source: `Form: ${form.name}`,
          campaign: body.utm_campaign || rawValues.utm_campaign || form.name,
          custom_fields: customFields,
        },
        {
          defaultStatus,
          defaultSource: `Form: ${form.name}`,
          dialCode: cfg.default_dial_code,
        }
      );

      // Attach to target `tenant_audiences` if configured
      let enteredAudienceId: string | null = null;
      if (form.target_audience_id) {
        const insAud = await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'form_submit', $5::jsonb)
           ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [
            crypto.randomUUID(),
            resolved.tenant_id,
            form.target_audience_id,
            upserted.leadId,
            JSON.stringify({ form_id: form.id }),
          ]
        );
        if ((insAud.rowCount || 0) > 0) {
          enteredAudienceId = String(form.target_audience_id);
        }
        await refreshAudienceCachedCount(client, resolved.tenant_id, String(form.target_audience_id));
      }

      // Mode B ("Chia Sale Auto Data ngay"): promote to `unassigned_pending` + `distribution_round_id`
      if (routingMode === 'sale_round') {
        await promoteLeadsToSaleRoundInTx(client, resolved.tenant_id, [upserted.leadId], {
          roundId: form.distribution_round_id ? String(form.distribution_round_id) : null,
          actorName: `Form: ${form.name}`,
          reasonTitle: `Đăng ký từ Form "${form.name}" (Chế độ Chia Sale Auto Data ngay)`,
        });
        drainSaleRound = true;
      }

      const utmData = {
        utm_source: body.utm_source || rawValues.utm_source || null,
        utm_medium: body.utm_medium || rawValues.utm_medium || null,
        utm_campaign: body.utm_campaign || rawValues.utm_campaign || null,
      };

      const subId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_form_submissions (
           id, tenant_id, form_id, lead_id, routing_mode, submitted_data, utm_data, otp_verified, client_ip
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          subId,
          resolved.tenant_id,
          form.id,
          upserted.leadId,
          routingMode,
          JSON.stringify(rawValues),
          JSON.stringify(utmData),
          otpVerified,
          clientIp || null,
        ]
      );

      await client.query(
        `UPDATE mkt_forms
         SET submission_count = submission_count + 1,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [resolved.tenant_id, form.id]
      );

      await client.query(
        `INSERT INTO lead_timeline_events (
           id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
         ) VALUES ($1, $2, $3, 'form_submitted', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
        [
          crypto.randomUUID(),
          resolved.tenant_id,
          upserted.leadId,
          `Form: ${form.name}`,
          `Điền biểu mẫu đăng ký: ${form.name}`,
          routingMode === 'sale_round'
            ? 'Đã định tuyến thẳng vào Vòng chia Sale Auto Data'
            : 'Đã lưu vào kho Marketing Nurture',
          JSON.stringify({ form_id: form.id, submission_id: subId, routing_mode: routingMode }),
        ]
      );

      return {
        errorCode: null,
        submission_id: subId,
        lead_id: upserted.leadId,
        routing_mode: routingMode,
        status: defaultStatus,
        form_id: String(form.id),
        form_name: String(form.name),
        entered_audience_id: enteredAudienceId,
        thank_you: parseJsonCol(form.thank_you_json, {}),
      };
    });

    if (txOut.errorCode === 'OTP_REQUIRED_OR_INVALID') {
      sendApiError(res, 422, 'OTP_VERIFICATION_FAILED', 'Mã xác thực OTP không chính xác hoặc đã hết hạn.');
      return;
    }
    if (txOut.errorCode || !txOut.lead_id) {
      sendApiError(res, 404, 'FORM_NOT_FOUND', 'Không tìm thấy Biểu mẫu.');
      return;
    }

    if (drainSaleRound) {
      await runUnassignedLeadDrainer(resolved.tenant_id).catch(() => {});
    }

    if (txOut.entered_audience_id && txOut.lead_id) {
      await emitDomainEvent('audience.entered', {
        tenantId: resolved.tenant_id,
        audienceId: txOut.entered_audience_id,
        audienceName: txOut.form_name || 'Form Audience',
        audienceType: 'static_list',
        leadId: txOut.lead_id,
      });
    }

    // Emit `'form.submitted'` engagement event (triggers Dynamic Audiences & Automation Flows!)
    await emitDomainEvent('marketing.engaged', {
      tenantId: resolved.tenant_id,
      leadId: txOut.lead_id,
      engagementType: 'form.submitted',
      channel: 'form',
      scoreDelta: 15,
      metadata: {
        event: 'form.submitted',
        formId: txOut.form_id,
        formName: txOut.form_name,
        routingMode: txOut.routing_mode,
      },
    });

    res.status(201).json({ success: true, data: txOut });
  } catch (err: any) {
    sendApiError(res, 500, 'SUBMIT_PUBLIC_FORM_FAILED', err?.message || 'Không thể tiếp nhận thông tin Biểu mẫu.');
  }
});

// ============================================================================
// 2. Transactional Email / SMS OTP (`/api/v1/public/marketing/otp/send|verify`)
// ============================================================================
router.post('/otp/send', publicOtpRateLimiter, async (req, res) => {
  try {
    const tenantId = await resolvePublicTenantId(req);
    if (!tenantId) {
      sendApiError(res, 400, 'TENANT_REQUIRED', 'Thiếu định danh doanh nghiệp (tenant_slug hoặc form_token).');
      return;
    }

    const recipient = String(req.body?.recipient || req.body?.email || req.body?.phone || '').trim();
    if (!recipient) {
      sendApiError(res, 422, 'RECIPIENT_REQUIRED', 'Vui lòng nhập Email hoặc Số điện thoại nhận mã OTP.');
      return;
    }

    const channel = req.body?.channel === 'sms' || (!recipient.includes('@') && /\d{8,}/.test(recipient)) ? 'sms' : 'email';
    const purpose = String(req.body?.purpose || 'form_submit').trim();
    const rawCode = String(crypto.randomInt(100000, 999999));
    const codeHash = hashOtpCode(tenantId, recipient, rawCode);
    const otpId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

    const deliveryInfo = await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_otp_verifications (id, tenant_id, channel, recipient, purpose, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [otpId, tenantId, channel, recipient.toLowerCase(), purpose, codeHash, expiresAt]
      );

      if (channel === 'email') {
        const [tenantRes, emailVault] = await Promise.all([
          client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [tenantId]),
          readTenantChannelVault(client, tenantId, ['aws_ses', 'smtp', 'appscript', 'resend']),
        ]);
        const tenantName = tenantRes.rows[0]?.name || 'DOMATION';
        const escapeHtml = (s: string) =>
          String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const safeTenantName = escapeHtml(tenantName);
        const safePurpose = escapeHtml(purpose);
        const otpSubject = `[${tenantName}] Mã xác thực OTP của bạn: ${rawCode}`;
        const otpHtml = `<div style="font-family:Inter,Arial,sans-serif;padding:24px;color:#0F172A;"><h2>Mã xác thực OTP</h2><p>Mã xác thực của bạn từ <strong>${safeTenantName}</strong> là:</p><div style="font-size:28px;font-weight:800;letter-spacing:0.15em;color:#1E40FF;margin:12px 0;">${rawCode}</div><p>Mã có hiệu lực trong 5 phút (mục đích: ${safePurpose}).</p></div>`;
        const emailRes = await dispatchMarketingEmail({
          tenantId,
          client,
          to: recipient.toLowerCase(),
          subject: otpSubject,
          text: `Ma xac thuc OTP tu ${tenantName}: ${rawCode}. Hieu luc 5 phut.`,
          html: otpHtml,
          category: 'system_alert',
          meta: { otp_id: otpId, purpose },
          emailVaultConfigured: emailVault.configured,
          emailVaultType: emailVault.integrationType,
        });
        return { dispatched: emailRes.sent, provider: emailRes.provider };
      }

      const smsRes = await dispatchSmsOtpNotification(
        {
          tenantId,
          phone: recipient,
          code: rawCode,
          purpose,
          message: `Ma OTP xac thuc cua ban la ${rawCode} (hieu luc 5 phut).`,
        },
        client
      );
      return { dispatched: smsRes.sent, provider: smsRes.provider };
    });

    const responseData: Record<string, unknown> = {
      otp_id: otpId,
      channel,
      recipient,
      expires_in_seconds: 300,
      dispatched: deliveryInfo.dispatched,
      delivery_provider: deliveryInfo.provider,
    };

    if (isOutboundSilentMode() || APP_CONFIG.nodeEnv !== 'production') {
      responseData.sandbox_otp_code = rawCode;
    }

    res.status(201).json({ success: true, data: responseData });
  } catch (err: any) {
    sendApiError(res, 500, 'OTP_SEND_FAILED', err?.message || 'Không thể gửi mã xác thực OTP.');
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const otpId = String(req.body?.otp_id || '').trim();
    const code = String(req.body?.code || req.body?.otp_code || '').trim();
    const recipient = String(req.body?.recipient || req.body?.email || req.body?.phone || '').trim();

    if (!code) {
      sendApiError(res, 422, 'OTP_CODE_REQUIRED', 'Vui lòng nhập mã OTP 6 chữ số.');
      return;
    }

    let tenantId = await resolvePublicTenantId(req);
    if (!tenantId && otpId && UUID_REGEX.test(otpId)) {
      tenantId = await withSystemPrivilege(async (client) => {
        const r = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM mkt_otp_verifications WHERE id = $1 LIMIT 1',
          [otpId]
        );
        return r.rows[0]?.tenant_id || null;
      });
    }

    if (!tenantId) {
      sendApiError(res, 400, 'TENANT_REQUIRED', 'Không xác định được ngữ cảnh xác thực OTP.');
      return;
    }

    const result = await withTenantTransaction(tenantId, async (client) => {
      let row: Record<string, unknown> | undefined;
      if (otpId) {
        if (!UUID_REGEX.test(otpId)) return { ok: false, reason: 'OTP_NOT_FOUND' };
        const r = await client.query('SELECT * FROM mkt_otp_verifications WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          tenantId,
          otpId,
        ]);
        row = r.rows[0];
      } else if (recipient) {
        const r = await client.query(
          `SELECT * FROM mkt_otp_verifications
           WHERE tenant_id = $1 AND LOWER(recipient) = $2 AND consumed_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId, recipient.toLowerCase()]
        );
        row = r.rows[0];
      }

      if (!row) return { ok: false, reason: 'OTP_NOT_FOUND' };
      if (row.consumed_at) return { ok: false, reason: 'OTP_ALREADY_CONSUMED' };
      if (Number(row.attempts || 0) >= 5) return { ok: false, reason: 'OTP_MAX_ATTEMPTS' };
      if (new Date(String(row.expires_at)).getTime() < Date.now()) return { ok: false, reason: 'OTP_EXPIRED' };

      const expectedHash = hashOtpCode(tenantId, String(row.recipient), code);
      if (expectedHash !== String(row.code_hash)) {
        await client.query(
          'UPDATE mkt_otp_verifications SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2',
          [tenantId, row.id]
        );
        return { ok: false, reason: 'OTP_MISMATCH' };
      }

      await client.query(
        'UPDATE mkt_otp_verifications SET verified = true, verified_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [tenantId, row.id]
      );
      return { ok: true, otp_id: String(row.id) };
    });

    if (!result.ok) {
      sendApiError(res, 422, result.reason || 'OTP_INVALID', 'Mã xác thực OTP không hợp lệ hoặc đã hết hạn.');
      return;
    }

    res.json({ success: true, data: { verified: true, otp_id: result.otp_id } });
  } catch (err: any) {
    sendApiError(res, 500, 'OTP_VERIFY_FAILED', err?.message || 'Không thể kiểm tra mã OTP.');
  }
});

// ============================================================================
// 3. Public Survey & Quiz (`/api/v1/public/marketing/surveys/:slug`)
// ============================================================================
router.get('/surveys/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    const tenantSlugHint = String(req.query.tenant_slug || req.header('X-Tenant-Slug') || '').trim().toLowerCase();

    const resolved = await withSystemPrivilege(async (client) => {
      let sql = `
        SELECT s.tenant_id, s.id AS survey_id, t.name AS company_name
        FROM mkt_surveys s
        INNER JOIN tenants t ON t.id = s.tenant_id
        WHERE s.slug = $1 AND s.status = 'active' AND t.status != 'deleted'
      `;
      const params: unknown[] = [slug];
      if (tenantSlugHint) {
        params.push(tenantSlugHint);
        sql += ` AND (t.slug = $2 OR t.obfuscated_slug = $2)`;
      }
      sql += ` LIMIT 1`;
      const r = await client.query<{ tenant_id: string; survey_id: string; company_name: string }>(sql, params);
      return r.rows[0] || null;
    });

    if (!resolved) {
      sendApiError(res, 404, 'PUBLIC_SURVEY_NOT_FOUND', 'Khảo sát không tồn tại hoặc đã đóng.');
      return;
    }

    const data = await withTenantTransaction(resolved.tenant_id, async (client) => {
      const r = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        resolved.tenant_id,
        resolved.survey_id,
      ]);
      const s = r.rows[0];
      if (!s) return null;
      return {
        id: String(s.id),
        title: String(s.title),
        slug: String(s.slug),
        description: s.description ? String(s.description) : '',
        survey_type: String(s.survey_type),
        company_name: resolved.company_name,
        blocks: parseJsonCol<SurveyBlockItemDto[]>(s.blocks_json, []),
        theme: parseJsonCol(s.theme_json, {}),
        settings: parseJsonCol(s.settings_json, {}),
        redirect_rules: parseJsonCol(s.redirect_rules_json, []),
        thank_you: parseJsonCol(s.thank_you_json, {}),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_PUBLIC_SURVEY_FAILED', err?.message || 'Không thể tải Khảo sát.');
  }
});

router.post('/surveys/:slug', publicFormSurveyRateLimiter, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    const tenantSlugHint = String(
      req.body?.tenant_slug || req.query.tenant_slug || req.header('X-Tenant-Slug') || ''
    )
      .trim()
      .toLowerCase();

    const resolved = await withSystemPrivilege(async (client) => {
      let sql = `
        SELECT s.tenant_id, s.id AS survey_id
        FROM mkt_surveys s
        INNER JOIN tenants t ON t.id = s.tenant_id
        WHERE s.slug = $1 AND s.status = 'active' AND t.status != 'deleted'
      `;
      const params: unknown[] = [slug];
      if (tenantSlugHint) {
        params.push(tenantSlugHint);
        sql += ` AND (t.slug = $2 OR t.obfuscated_slug = $2)`;
      }
      sql += ` LIMIT 1`;
      const r = await client.query<{ tenant_id: string; survey_id: string }>(sql, params);
      return r.rows[0] || null;
    });

    if (!resolved) {
      sendApiError(res, 404, 'PUBLIC_SURVEY_NOT_FOUND', 'Khảo sát không tồn tại hoặc đã kết thúc.');
      return;
    }

    const cfg = await getTenantSettingsCached(resolved.tenant_id);
    const answers: Record<string, unknown> =
      req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '')
      .split(',')[0]
      .trim()
      .slice(0, 64);

    const txOut = await withTenantTransaction(resolved.tenant_id, async (client) => {
      const sRes = await client.query('SELECT * FROM mkt_surveys WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        resolved.tenant_id,
        resolved.survey_id,
      ]);
      const survey = sRes.rows[0];
      if (!survey) return null;

      const blocks = parseJsonCol<SurveyBlockItemDto[]>(survey.blocks_json, []);
      const settings = parseJsonCol<Record<string, unknown>>(survey.settings_json, {});

      let quizScore = Number(settings.base_lead_score || 0);
      let npsScore: number | null = null;
      const tagsToApply = new Set<string>();
      if (settings.auto_tag && String(settings.auto_tag).trim()) {
        tagsToApply.add(String(settings.auto_tag).trim());
      }

      let contactPhone = String(req.body?.phone || '').trim();
      let contactEmail = String(req.body?.email || '').trim().toLowerCase();
      let contactName = String(req.body?.name || '').trim();

      for (const b of blocks) {
        const val = answers[b.id];
        if (val === undefined || val === null || val === '') continue;

        if (b.type === 'phone' && !contactPhone) contactPhone = String(val).trim();
        if (b.type === 'email' && !contactEmail) contactEmail = String(val).trim().toLowerCase();
        if (b.type === 'short_text' && !contactName && /tên|name/i.test(b.label)) {
          contactName = String(val).trim();
        }

        if (b.type === 'nps') {
          const n = Math.min(10, Math.max(0, Math.round(Number(val))));
          if (Number.isFinite(n)) {
            npsScore = n;
            if (n >= 9) {
              quizScore += 15;
              tagsToApply.add('NPS Promoter');
            } else if (n <= 6) {
              tagsToApply.add('NPS Detractor');
            }
          }
        } else if (b.type === 'csat_stars') {
          const stars = Math.round(Number(val));
          if (stars >= 4) quizScore += 10;
        } else if (b.type === 'quiz_scored') {
          if (b.correctValue !== undefined && String(val) === String(b.correctValue)) {
            quizScore += Number(b.points ?? 10);
          } else if (Array.isArray(b.options)) {
            const opt = b.options.find((o) => o.value === String(val) || o.label === String(val));
            if (opt?.points) quizScore += Number(opt.points);
          }
        } else if (Array.isArray(b.options)) {
          const selectedVals = Array.isArray(val) ? val.map(String) : [String(val)];
          for (const sv of selectedVals) {
            const opt = b.options.find((o) => o.value === sv || o.label === sv);
            if (opt?.points) quizScore += Number(opt.points);
          }
        }

        if (b.tagOnAnswer) {
          tagsToApply.add(String(b.tagOnAnswer).trim());
        }
      }

      // Evaluate redirect_rules BEFORE DB tag persistence so assignTag is written into tenant_tags & lead_tags
      const rawRedirectRules = parseJsonCol<Array<Record<string, unknown>>>(survey.redirect_rules_json, []);
      const redirectRules =
        rawRedirectRules.length > 0
          ? rawRedirectRules
          : Array.isArray(settings.redirect_rules)
            ? (settings.redirect_rules as Array<Record<string, unknown>>)
            : [];
      const baseThankYou = parseJsonCol<Record<string, unknown>>(survey.thank_you_json, {});

      let matchedRedirectUrl: string | null = null;
      let matchedThankYou: Record<string, unknown> = { ...baseThankYou };
      let rewardVoucherPoolId: string | null = settings.voucher_campaign_id
        ? String(settings.voucher_campaign_id)
        : null;

      for (const rule of redirectRules) {
        const minSc = Number(rule.minScore ?? rule.min_score ?? 0);
        const maxSc = Number(rule.maxScore ?? rule.max_score ?? 999999);
        if (quizScore >= minSc && quizScore <= maxSc) {
          if (rule.redirectUrl || rule.redirect_url) {
            matchedRedirectUrl = String(rule.redirectUrl || rule.redirect_url);
          }
          if (rule.thankYouTitle || rule.thank_you_title) {
            matchedThankYou = {
              ...matchedThankYou,
              title: String(rule.thankYouTitle || rule.thank_you_title),
              message: String(rule.thankYouMessage || rule.thank_you_message || matchedThankYou.message || ''),
            };
          }
          if (rule.assignTag || rule.assign_tag) {
            tagsToApply.add(String(rule.assignTag || rule.assign_tag).trim());
          }
          if (rule.voucherCampaignId || rule.voucher_campaign_id) {
            rewardVoucherPoolId = String(rule.voucherCampaignId || rule.voucher_campaign_id);
          }
          break;
        }
      }

      let leadId: string | null = null;
      if (contactPhone || contactEmail) {
        const upserted = await upsertMasterContactInTx(
          client,
          resolved.tenant_id,
          {
            name: contactName,
            phone: contactPhone || undefined,
            email: contactEmail || undefined,
            source: `Survey: ${survey.title}`,
          },
          {
            defaultStatus: 'marketing_nurture',
            defaultSource: `Survey: ${survey.title}`,
            dialCode: cfg.default_dial_code,
          }
        );
        leadId = upserted.leadId;

        if (quizScore !== 0) {
          await client.query(
            `UPDATE leads
             SET lead_score = lead_score + $3,
                 last_engaged_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [resolved.tenant_id, leadId, quizScore]
          );
        }

        for (const rawTag of tagsToApply) {
          const tSlug = slugifyKeyLower(rawTag, 'survey-tag');
          await client.query(
            `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category)
             VALUES ($1, $2, $3, $4, '#1E40FF', 'survey')
             ON CONFLICT (tenant_id, slug) DO NOTHING`,
            [crypto.randomUUID(), resolved.tenant_id, rawTag, tSlug]
          );
          const tagRow = await client.query<{ id: string }>(
            'SELECT id FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
            [resolved.tenant_id, tSlug]
          );
          if (tagRow.rows[0]?.id) {
            await client.query(
              `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
              [crypto.randomUUID(), resolved.tenant_id, leadId, tagRow.rows[0].id]
            );
          }
        }

        if (settings.target_audience_id) {
          await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'survey', '{}'::jsonb)
             ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), resolved.tenant_id, String(settings.target_audience_id), leadId]
          );
          await refreshAudienceCachedCount(client, resolved.tenant_id, String(settings.target_audience_id));
        }

        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'survey_completed', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
          [
            crypto.randomUUID(),
            resolved.tenant_id,
            leadId,
            `Survey: ${survey.title}`,
            `Hoàn thành khảo sát "${survey.title}" (+${quizScore} Lead Score)`,
            npsScore !== null ? `NPS: ${npsScore}/10` : `Điểm Quiz: ${quizScore}`,
            JSON.stringify({ survey_id: survey.id, quiz_score: quizScore, nps_score: npsScore }),
          ]
        );
      }

      let rewardVoucherCode: string | null = null;
      if (rewardVoucherPoolId) {
        const vpRes = await client.query<{ id: string; code_prefix: string }>(
          'SELECT id, code_prefix FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [resolved.tenant_id, rewardVoucherPoolId]
        );
        if (vpRes.rows[0]) {
          rewardVoucherCode = `${String(vpRes.rows[0].code_prefix || 'DOM').toUpperCase()}-${generateShortCode(6).toUpperCase()}`;
          await client.query(
            `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status, lead_id, claimed_at)
             VALUES ($1, $2, $3, $4, 'claimed', $5, clock_timestamp())
             ON CONFLICT (tenant_id, code) DO NOTHING`,
            [crypto.randomUUID(), resolved.tenant_id, vpRes.rows[0].id, rewardVoucherCode, leadId]
          );
          await client.query(
            'UPDATE mkt_voucher_campaigns SET total_codes = total_codes + 1, claimed_codes = claimed_codes + 1 WHERE tenant_id = $1 AND id = $2',
            [resolved.tenant_id, vpRes.rows[0].id]
          );
        }
      }

      const respId = crypto.randomUUID();
      const appliedTagsArr = Array.from(tagsToApply);
      await client.query(
        `INSERT INTO mkt_survey_responses (
           id, tenant_id, survey_id, lead_id, answers_json, quiz_score, nps_score, tags_applied, client_ip
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9)`,
        [
          respId,
          resolved.tenant_id,
          survey.id,
          leadId,
          JSON.stringify(answers),
          quizScore,
          npsScore,
          JSON.stringify(appliedTagsArr),
          clientIp || null,
        ]
      );

      const aggRes = await client.query<{ cnt: number; avg_sc: number }>(
        `SELECT COUNT(*)::int AS cnt, COALESCE(AVG(quiz_score), 0) AS avg_sc
         FROM mkt_survey_responses
         WHERE tenant_id = $1 AND survey_id = $2`,
        [resolved.tenant_id, survey.id]
      );
      await client.query(
        `UPDATE mkt_surveys
         SET response_count = $3,
             avg_score = $4,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          resolved.tenant_id,
          survey.id,
          Number(aggRes.rows[0]?.cnt || 1),
          Number(Number(aggRes.rows[0]?.avg_sc || 0).toFixed(2)),
        ]
      );

      return {
        response_id: respId,
        survey_id: String(survey.id),
        lead_id: leadId,
        quiz_score: quizScore,
        nps_score: npsScore,
        tags_applied: appliedTagsArr,
        redirect_url: matchedRedirectUrl,
        thank_you: matchedThankYou,
        voucher_code: rewardVoucherCode,
      };
    });

    if (!txOut) {
      sendApiError(res, 404, 'SURVEY_NOT_FOUND', 'Không tìm thấy Khảo sát.');
      return;
    }

    if (txOut.lead_id) {
      await emitDomainEvent('marketing.engaged', {
        tenantId: resolved.tenant_id,
        leadId: txOut.lead_id,
        engagementType: 'survey_completed',
        channel: 'survey',
        scoreDelta: txOut.quiz_score,
        metadata: { surveyId: txOut.survey_id, quizScore: txOut.quiz_score, npsScore: txOut.nps_score },
      });
    }

    res.status(201).json({ success: true, data: txOut });
  } catch (err: any) {
    sendApiError(res, 500, 'SUBMIT_PUBLIC_SURVEY_FAILED', err?.message || 'Không thể ghi nhận phản hồi Khảo sát.');
  }
});

// ============================================================================
// 4. Shortlink Click Redirect + UTM Analytics (`/api/v1/public/marketing/r/:code`)
// ============================================================================
router.get('/r/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const resolved = await withSystemPrivilege(async (client) => {
      const r = await client.query<{ tenant_id: string; link_id: string }>(
        `SELECT sl.tenant_id, sl.id AS link_id
         FROM mkt_short_links sl
         INNER JOIN tenants t ON t.id = sl.tenant_id
         WHERE sl.short_code = $1 AND sl.is_active = true AND t.status != 'deleted'
         LIMIT 1`,
        [code]
      );
      return r.rows[0] || null;
    });

    if (!resolved) {
      sendApiError(res, 404, 'SHORTLINK_NOT_FOUND', 'Liên kết rút gọn không tồn tại hoặc đã ngưng hoạt động.');
      return;
    }

    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    const device = /mobile|iphone|android/.test(ua) ? 'mobile' : 'desktop';
    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '')
      .split(',')[0]
      .trim()
      .slice(0, 64);
    const leadIdParam = String(req.query.lid || req.query.lead_id || '').trim();

    const redirectInfo = await withTenantTransaction(resolved.tenant_id, async (client) => {
      const lRes = await client.query('SELECT * FROM mkt_short_links WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        resolved.tenant_id,
        resolved.link_id,
      ]);
      const link = lRes.rows[0];
      if (!link) return null;

      const validLeadId = leadIdParam && UUID_REGEX.test(leadIdParam) ? leadIdParam : null;
      let existingLeadId: string | null = null;
      if (validLeadId) {
        const lChk = await client.query<{ id: string }>(
          'SELECT id FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1',
          [resolved.tenant_id, validLeadId]
        );
        existingLeadId = lChk.rows[0]?.id || null;
      }

      const visitorHash = crypto
        .createHash('sha256')
        .update(existingLeadId ? `lead:${existingLeadId}` : `${clientIp || 'noip'}|${ua || 'noua'}`)
        .digest('hex')
        .slice(0, 24);

      const priorClicksRes = await client.query<{ lead_id: string | null; utm_json: unknown }>(
        `SELECT lead_id, utm_json
         FROM mkt_short_link_clicks
         WHERE tenant_id = $1 AND short_link_id = $2
         ORDER BY clicked_at DESC
         LIMIT 500`,
        [resolved.tenant_id, link.id]
      );
      const alreadyVisited = priorClicksRes.rows.some((row) => {
        if (existingLeadId && row.lead_id && String(row.lead_id) === existingLeadId) return true;
        const utm = parseJsonCol<Record<string, unknown>>(row.utm_json, {});
        return utm.visitor_hash === visitorHash;
      });
      const uniqueDelta = alreadyVisited ? 0 : 1;

      await client.query(
        `INSERT INTO mkt_short_link_clicks (id, tenant_id, short_link_id, lead_id, referrer, device_type, client_ip, utm_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          crypto.randomUUID(),
          resolved.tenant_id,
          link.id,
          existingLeadId,
          req.headers.referer ? String(req.headers.referer) : null,
          device,
          clientIp || null,
          JSON.stringify({
            utm_source: link.utm_source || req.query.utm_source || null,
            utm_medium: link.utm_medium || req.query.utm_medium || null,
            utm_campaign: link.utm_campaign || req.query.utm_campaign || null,
            visitor_hash: visitorHash,
          }),
        ]
      );

      await client.query(
        `UPDATE mkt_short_links
         SET click_count = click_count + 1,
             unique_click_count = unique_click_count + $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [resolved.tenant_id, link.id, uniqueDelta]
      );

      const finalUrl = new URL(String(link.target_url));
      if (link.utm_source && !finalUrl.searchParams.has('utm_source')) {
        finalUrl.searchParams.set('utm_source', String(link.utm_source));
      }
      if (link.utm_medium && !finalUrl.searchParams.has('utm_medium')) {
        finalUrl.searchParams.set('utm_medium', String(link.utm_medium));
      }
      if (link.utm_campaign && !finalUrl.searchParams.has('utm_campaign')) {
        finalUrl.searchParams.set('utm_campaign', String(link.utm_campaign));
      }

      return { targetUrl: finalUrl.toString(), validLeadId: existingLeadId };
    });

    if (!redirectInfo) {
      sendApiError(res, 404, 'SHORTLINK_NOT_FOUND', 'Không tìm thấy liên kết.');
      return;
    }

    if (redirectInfo.validLeadId) {
      await emitDomainEvent('marketing.engaged', {
        tenantId: resolved.tenant_id,
        leadId: redirectInfo.validLeadId,
        engagementType: 'link_clicked',
        channel: 'web',
        scoreDelta: 5,
      });
    }

    if (req.query.json === '1') {
      res.json({ success: true, data: { redirect_url: redirectInfo.targetUrl } });
      return;
    }

    res.redirect(302, redirectInfo.targetUrl);
  } catch (err: any) {
    sendApiError(res, 500, 'SHORTLINK_REDIRECT_FAILED', err?.message || 'Không thể chuyển hướng liên kết.');
  }
});

// ============================================================================
// 5. Campaign Open / Click / HMAC Unsubscribe Tracking
// ============================================================================
router.get('/track/open/:claimId', async (req, res) => {
  try {
    const claimId = String(req.params.claimId || '').trim();
    if (UUID_REGEX.test(claimId)) {
      const resolved = await withSystemPrivilege(async (client) => {
        const r = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM mkt_send_claims WHERE id = $1 LIMIT 1',
          [claimId]
        );
        return r.rows[0]?.tenant_id || null;
      });

      if (resolved) {
        const evtInfo = await withTenantTransaction(resolved, async (client) => {
          const cRes = await client.query(
            'SELECT id, campaign_id, lead_id, opened_at FROM mkt_send_claims WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [resolved, claimId]
          );
          const cl = cRes.rows[0];
          if (!cl) return null;

          if (!cl.opened_at) {
            const openUpd = await client.query(
              `UPDATE mkt_send_claims
               SET status = CASE WHEN status = 'clicked' THEN 'clicked' ELSE 'opened' END,
                   opened_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2 AND opened_at IS NULL`,
              [resolved, claimId]
            );
            if ((openUpd.rowCount || 0) > 0) {
              await client.query(
                'UPDATE mkt_campaigns SET opened_count = opened_count + 1 WHERE tenant_id = $1 AND id = $2',
                [resolved, cl.campaign_id]
              );
              await client.query(
                `INSERT INTO lead_timeline_events (
                   id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, metadata
                 ) VALUES ($1, $2, $3, 'email_opened', 'communication', 'tenant_admin', 'Email Tracker', 'Đã mở Email chiến dịch', $4::jsonb)`,
                [
                  crypto.randomUUID(),
                  resolved,
                  cl.lead_id,
                  JSON.stringify({ campaign_id: cl.campaign_id, claim_id: claimId }),
                ]
              );
              return { leadId: String(cl.lead_id), campaignId: String(cl.campaign_id) };
            }
          }
          return null;
        });

        if (evtInfo) {
          await emitDomainEvent('marketing.engaged', {
            tenantId: resolved,
            leadId: evtInfo.leadId,
            engagementType: 'email_opened',
            channel: 'email',
            scoreDelta: 5,
            metadata: { campaignId: evtInfo.campaignId },
          });
        }
      }
    }
  } catch {
    // Always return pixel cleanly
  }

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(TRANSPARENT_GIF_1X1);
});

router.get('/track/click/:claimId', async (req, res) => {
  const targetUrl = String(req.query.url || 'https://domation.net').replace(/[\r\n]/g, '').trim();
  const safeRedirect = /^https?:\/\//i.test(targetUrl) ? targetUrl : 'https://domation.net';
  try {
    const claimId = String(req.params.claimId || '').trim();
    if (UUID_REGEX.test(claimId)) {
      const resolved = await withSystemPrivilege(async (client) => {
        const r = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM mkt_send_claims WHERE id = $1 LIMIT 1',
          [claimId]
        );
        return r.rows[0]?.tenant_id || null;
      });

      if (resolved) {
        const evtInfo = await withTenantTransaction(resolved, async (client) => {
          const cRes = await client.query(
            'SELECT id, campaign_id, lead_id, opened_at, clicked_at FROM mkt_send_claims WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [resolved, claimId]
          );
          const cl = cRes.rows[0];
          if (!cl) return null;

          const openUpd = await client.query(
            `UPDATE mkt_send_claims
             SET opened_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2 AND opened_at IS NULL`,
            [resolved, claimId]
          );
          const openedDelta = (openUpd.rowCount || 0) > 0 ? 1 : 0;

          const clickUpd = await client.query(
            `UPDATE mkt_send_claims
             SET status = 'clicked',
                 clicked_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2 AND clicked_at IS NULL`,
            [resolved, claimId]
          );
          const clickedDelta = (clickUpd.rowCount || 0) > 0 ? 1 : 0;

          if (openedDelta > 0 || clickedDelta > 0) {
            await client.query(
              `UPDATE mkt_campaigns
               SET clicked_count = clicked_count + $3,
                   opened_count = opened_count + $4
               WHERE tenant_id = $1 AND id = $2`,
              [resolved, cl.campaign_id, clickedDelta, openedDelta]
            );
          }

          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
             ) VALUES ($1, $2, $3, 'email_clicked', 'communication', 'tenant_admin', 'Email Tracker', 'Đã click liên kết trong Email', $4, $5::jsonb)`,
            [
              crypto.randomUUID(),
              resolved,
              cl.lead_id,
              safeRedirect,
              JSON.stringify({ campaign_id: cl.campaign_id, claim_id: claimId, url: safeRedirect }),
            ]
          );
          return { leadId: String(cl.lead_id), campaignId: String(cl.campaign_id), isFirstClick: clickedDelta > 0 };
        });

        if (evtInfo && evtInfo.isFirstClick) {
          await emitDomainEvent('marketing.engaged', {
            tenantId: resolved,
            leadId: evtInfo.leadId,
            engagementType: 'email_clicked',
            channel: 'email',
            scoreDelta: 10,
            metadata: { campaignId: evtInfo.campaignId, url: safeRedirect },
          });
        }
      }
    }
  } catch {
    // Still redirect cleanly
  }

  if (req.query.json === '1') {
    res.json({ success: true, data: { redirect_url: safeRedirect } });
    return;
  }
  res.redirect(302, safeRedirect);
});

router.all('/unsubscribe', async (req, res) => {
  try {
    const tenantId = String(req.body?.tenant_id || req.query.tenant_id || '').trim();
    const leadId = String(req.body?.lead_id || req.query.lead_id || '').trim();
    const channel = String(req.body?.channel || req.query.channel || 'email').trim();
    const sig = String(req.body?.sig || req.query.sig || '').trim();
    const claimId = String(req.body?.claim_id || req.query.claim_id || '').trim();

    if (!UUID_REGEX.test(tenantId) || !UUID_REGEX.test(leadId) || !verifyUnsubscribeHmac(tenantId, leadId, channel, sig)) {
      sendApiError(res, 403, 'INVALID_UNSUBSCRIBE_SIGNATURE', 'Chữ ký hủy đăng ký không hợp lệ.');
      return;
    }

    await withTenantTransaction(tenantId, async (client) => {
      const lRes = await client.query<{ email: string | null; phone: string | null }>(
        'SELECT email, phone FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [tenantId, leadId]
      );
      const lead = lRes.rows[0];
      if (!lead) return;

      if (channel === 'zns') {
        await client.query("UPDATE leads SET zns_consent = 'opted_out' WHERE tenant_id = $1 AND id = $2", [
          tenantId,
          leadId,
        ]);
      } else {
        await client.query("UPDATE leads SET email_consent = 'unsubscribed' WHERE tenant_id = $1 AND id = $2", [
          tenantId,
          leadId,
        ]);
      }

      const rawRecipient = channel === 'zns' ? lead.phone : lead.email;
      const recipient = rawRecipient ? normalizeSuppressionRecipient(channel, rawRecipient) : '';
      if (recipient) {
        await client.query(
          `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
           VALUES ($1, $2, $3, $4, 'unsubscribed')
           ON CONFLICT (tenant_id, channel, recipient) DO UPDATE SET reason = 'unsubscribed'`,
          [crypto.randomUUID(), tenantId, channel, recipient]
        );
      }

      if (claimId && UUID_REGEX.test(claimId)) {
        const claimRow = await client.query<{ campaign_id: string }>(
          'SELECT campaign_id FROM mkt_send_claims WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [tenantId, claimId]
        );
        const updClaim = await client.query(
          `UPDATE mkt_send_claims
           SET status = 'unsubscribed'
           WHERE tenant_id = $1 AND id = $2 AND lead_id = $3 AND status != 'unsubscribed'`,
          [tenantId, claimId, leadId]
        );
        if ((updClaim.rowCount || 0) > 0 && claimRow.rows[0]?.campaign_id) {
          await client.query(
            'UPDATE mkt_campaigns SET unsubscribed_count = unsubscribed_count + 1 WHERE tenant_id = $1 AND id = $2',
            [tenantId, claimRow.rows[0].campaign_id]
          );
        }
      }
    });

    res.json({ success: true, data: { unsubscribed: true, channel } });
  } catch (err: any) {
    sendApiError(res, 500, 'UNSUBSCRIBE_FAILED', err?.message || 'Không thể xử lý yêu cầu hủy đăng ký.');
  }
});

// ============================================================================
// 6. Web Tracking JS SDK & Event / Heatmap / Identity Ingestion (`/track`)
// ============================================================================
function parseUserAgentHints(rawUa: string): {
  deviceType: 'bot' | 'tablet' | 'mobile' | 'desktop';
  os: string;
  browser: string;
} {
  const ua = String(rawUa || '');
  const lower = ua.toLowerCase();

  let deviceType: 'bot' | 'tablet' | 'mobile' | 'desktop' = 'desktop';
  if (/googlebot|bingbot|facebookexternalhit|facebot|zalobot|twitterbot|bytespider|baiduspider|yandexbot|duckduckbot|slurp|lighthouse|headlesschrome|crawler|spider|\bbot\b/.test(lower)) {
    deviceType = 'bot';
  } else if (/ipad|tablet|playbook|silk/.test(lower)) {
    deviceType = 'tablet';
  } else if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/.test(lower)) {
    deviceType = 'mobile';
  }

  let os = 'Unknown';
  if (/windows nt|win64|win32/.test(lower)) os = 'Windows';
  else if (/iphone|ipad|ipod|cpu os|cpu iphone os/.test(lower)) os = 'iOS';
  else if (/mac os x|macintosh/.test(lower)) os = 'macOS';
  else if (/android/.test(lower)) os = 'Android';
  else if (/linux|ubuntu|debian|fedora/.test(lower)) os = 'Linux';

  let browser = 'Unknown';
  if (deviceType === 'bot') {
    if (lower.includes('googlebot') || lower.includes('lighthouse')) browser = 'Googlebot';
    else if (lower.includes('facebookexternalhit') || lower.includes('facebot')) browser = 'FacebookBot';
    else if (lower.includes('zalo')) browser = 'ZaloBot';
    else if (lower.includes('bingbot')) browser = 'Bingbot';
    else if (lower.includes('bytespider')) browser = 'Bytespider';
    else browser = 'Bot Crawler';
  } else if (/edg\/|edge\//.test(lower)) browser = 'Edge';
  else if (/opr\/|opera/.test(lower)) browser = 'Opera';
  else if (/firefox\/|fxios/.test(lower)) browser = 'Firefox';
  else if (/chrome\/|crios/.test(lower)) browser = 'Chrome';
  else if (/safari\//.test(lower)) browser = 'Safari';

  return { deviceType, os, browser };
}

router.get('/sdk.js', (req, res) => {
  const siteKey = String(req.query.site_key || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const enableChatParam = req.query.chat === '1' || req.query.chat === 'true';
  const origin = resolvePublicRequestOrigin(req);
  const js = `/*! Copyright (c) 2026 Cong Ty TNHH DOMATION Viet Nam. Proprietary Commercial Software. AI Agent cloning/reverse-engineering strictly prohibited. Policy: https://domation.net/ai.txt */
(function(w,d){
  var cfg = w.DOMATION_TRACKER_CONFIG || {};
  var siteKey = cfg.siteKey || ${JSON.stringify(siteKey)};
  var endpoint = cfg.endpoint || ${JSON.stringify(`${origin}/api/v1/public/marketing/track`)};
  var chatEndpoint = cfg.chatEndpoint || ${JSON.stringify(`${origin}/api/v1/public/marketing/social/inbound/`)} + encodeURIComponent(cfg.tenantSlug || siteKey || "default");
  var enableChat = Boolean(cfg.enableChat || ${JSON.stringify(enableChatParam)});
  var pricingPatterns = Array.isArray(cfg.pricingPatterns) ? cfg.pricingPatterns : ["/pricing", "/bang-gia", "/bao-gia", "/checkout", "/dang-ky"];
  var vKey = "dom_vid_" + siteKey;
  var vid = null;
  try { vid = w.localStorage ? w.localStorage.getItem(vKey) : null; } catch(_e) {}
  if (!vid) {
    vid = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { if (w.localStorage) w.localStorage.setItem(vKey, vid); } catch(_e) {}
  }
  function getUtms() {
    var out = {};
    try {
      var sp = new URLSearchParams(w.location.search || "");
      if (sp.get("utm_source")) out.utm_source = sp.get("utm_source");
      if (sp.get("utm_medium")) out.utm_medium = sp.get("utm_medium");
      if (sp.get("utm_campaign")) out.utm_campaign = sp.get("utm_campaign");
      if (sp.get("utm_content")) out.utm_content = sp.get("utm_content");
      if (sp.get("fbclid")) out.fbclid = sp.get("fbclid");
    } catch(_e) {}
    return out;
  }
  function getViewport() {
    var docEl = d.documentElement;
    return {
      viewport_w: Math.max(0, Math.round(w.innerWidth || (docEl ? docEl.clientWidth : 0) || 0)),
      viewport_h: Math.max(0, Math.round(w.innerHeight || (docEl ? docEl.clientHeight : 0) || 0))
    };
  }
  function buildSelector(el) {
    if (!el || !el.tagName) return "BODY";
    var tag = String(el.tagName).toLowerCase();
    if (el.id) {
      return "#" + String(el.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    }
    var cls = "";
    if (typeof el.className === "string" && el.className.trim()) {
      var parts = el.className.trim().split(/\\s+/).filter(function(c){ return c && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c); }).slice(0, 2);
      if (parts.length) cls = "." + parts.join(".");
    }
    var selfSel = (tag + cls).slice(0, 120);
    if (el.parentElement && el.parentElement.id) {
      return ("#" + String(el.parentElement.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) + " > " + selfSel).slice(0, 160);
    }
    return selfSel || "body";
  }
  function extractElementText(el) {
    if (!el) return "";
    var raw = "";
    try {
      raw = el.getAttribute && (el.getAttribute("data-cta") || el.getAttribute("aria-label") || el.getAttribute("title")) || "";
      if (!raw && typeof el.innerText === "string") raw = el.innerText;
      if (!raw && typeof el.textContent === "string") raw = el.textContent;
      if (!raw && typeof el.value === "string" && el.type !== "password") raw = el.value;
      if (!raw && el.getAttribute) raw = el.getAttribute("alt") || "";
    } catch(_e) {}
    return String(raw || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  }
  function postPayload(payloadObj, preferBeacon) {
    var bodyStr = JSON.stringify(payloadObj);
    if (preferBeacon && w.navigator && typeof w.navigator.sendBeacon === "function") {
      try {
        var blob = new Blob([bodyStr], { type: "application/json" });
        if (w.navigator.sendBeacon(endpoint, blob)) return;
      } catch(_e) {}
    }
    fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyStr, keepalive: true }).catch(function(){});
  }
  function send(type, extra, preferBeacon) {
    var extraObj = extra || {};
    var vp = getViewport();
    var meta = Object.assign({ page_title: d.title || "", viewport_w: vp.viewport_w, viewport_h: vp.viewport_h }, extraObj.metadata || {});
    var payload = Object.assign({
      site_key: siteKey,
      visitor_token: vid,
      event_type: type,
      page_url: location.href,
      referrer: d.referrer,
      viewport_w: vp.viewport_w,
      viewport_h: vp.viewport_h
    }, getUtms(), extraObj, { metadata: meta });
    postPayload(payload, Boolean(preferBeacon));
  }
  function sendChatMessage(messageText, customerName) {
    return fetch(chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "web_chat", thread_id: vid, customer_name: customerName || "Khách Website", message: messageText })
    }).then(function(r){ return r.json(); });
  }

  // --- 1. GA4-Grade Active Engagement Time Tracker (30s idle window, visibility & blur aware) ---
  var IDLE_TIMEOUT_MS = 30000;
  var MAX_SINGLE_FLUSH_SEC = 1800;
  var activeMs = 0;
  var isVisible = d.visibilityState !== "hidden";
  var isFocused = typeof d.hasFocus === "function" ? d.hasFocus() : true;
  var lastTickAt = Date.now();
  var lastActivityAt = Date.now();
  var lastActivityStamp = 0;

  function accumulateActiveMs(nowTs) {
    var now = nowTs || Date.now();
    if (isVisible && isFocused && (now - lastActivityAt) <= IDLE_TIMEOUT_MS) {
      var delta = now - lastTickAt;
      if (delta > 0 && delta <= 60000) {
        activeMs += delta;
      }
    }
    lastTickAt = now;
  }
  function markUserActivity() {
    var now = Date.now();
    if (now - lastActivityStamp < 400) return;
    lastActivityStamp = now;
    accumulateActiveMs(now);
    lastActivityAt = now;
    lastTickAt = now;
  }
  var activeTickInterval = w.setInterval(function() {
    accumulateActiveMs(Date.now());
  }, 1000);
  ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "pointerdown"].forEach(function(evtName) {
    w.addEventListener(evtName, markUserActivity, { passive: true });
  });
  w.addEventListener("blur", function() {
    accumulateActiveMs(Date.now());
    isFocused = false;
  });
  w.addEventListener("focus", function() {
    isFocused = true;
    var now = Date.now();
    lastActivityAt = now;
    lastTickAt = now;
  });

  // --- 2. Accurate Scroll Depth Milestones (25, 50, 75, 90, 100) ---
  var SCROLL_MILESTONES = [25, 50, 75, 90, 100];
  var emittedMilestones = {};
  var maxScrollPct = 0;
  var scrollTimer = null;

  function computeScrollPct() {
    var docEl = d.documentElement;
    var body = d.body;
    var docH = Math.max(docEl ? docEl.scrollHeight : 0, body ? body.scrollHeight : 0, 1);
    var viewH = w.innerHeight || (docEl ? docEl.clientHeight : 0) || 0;
    var top = w.scrollY || (docEl ? docEl.scrollTop : 0) || (body ? body.scrollTop : 0) || 0;
    return Math.min(100, Math.max(0, Math.round(((top + viewH) / Math.max(docH, 1)) * 100)));
  }
  function flushScrollMilestones() {
    scrollTimer = null;
    var pct = Math.max(maxScrollPct, computeScrollPct());
    maxScrollPct = pct;
    var crossed = [];
    for (var i = 0; i < SCROLL_MILESTONES.length; i++) {
      var m = SCROLL_MILESTONES[i];
      if (pct >= m && !emittedMilestones[m]) {
        emittedMilestones[m] = true;
        crossed.push(m);
      }
    }
    if (crossed.length > 0) {
      var highestMilestone = crossed[crossed.length - 1];
      send("scroll", {
        scroll_depth_pct: highestMilestone,
        metadata: { percent: highestMilestone, max_scroll_pct: pct, milestones_reached: crossed }
      });
    }
  }
  w.addEventListener("scroll", function() {
    markUserActivity();
    var pct = computeScrollPct();
    if (pct > maxScrollPct) {
      maxScrollPct = pct;
      if (!scrollTimer) {
        scrollTimer = setTimeout(flushScrollMilestones, 800);
      }
    }
  }, { passive: true });

  // --- 3. Initial Pageview + Pricing Intent Auto-Detection ---
  var pricingIntentSent = false;
  function checkPricingIntent(hintUrl, hintText) {
    if (pricingIntentSent) return;
    var hay = (String(hintUrl || location.href) + " " + String(hintText || "")).toLowerCase();
    for (var i = 0; i < pricingPatterns.length; i++) {
      var pat = String(pricingPatterns[i] || "").trim().toLowerCase();
      if (pat && hay.indexOf(pat) !== -1) {
        pricingIntentSent = true;
        send("pricing_intent", { metadata: { matched_pattern: pat, hint_text: String(hintText || "").slice(0, 120) } });
        return;
      }
    }
  }
  send("pageview");
  checkPricingIntent(location.href, d.title);

  // --- 4. Full Click, CTA, Gesture & Outbound Link Capture ---
  d.addEventListener("click", function(e) {
    markUserActivity();
    var rawTarget = e.target;
    var el = (rawTarget && typeof rawTarget.closest === "function")
      ? (rawTarget.closest('a,button,[role="button"],input[type="submit"],[data-track]') || rawTarget)
      : rawTarget;
    var docEl = d.documentElement;
    var docH = Math.max(docEl ? docEl.scrollHeight : 0, d.body ? d.body.scrollHeight : 0, 1);
    var vp = getViewport();
    var x = Math.round((e.clientX / Math.max(1, vp.viewport_w || w.innerWidth)) * 1000) / 10;
    var y = Math.round(((e.clientY + (w.scrollY || 0)) / Math.max(1, docH)) * 1000) / 10;
    var tag = (el && el.tagName) ? String(el.tagName).toUpperCase() : "BODY";
    var sel = buildSelector(el);
    var elText = extractElementText(el);
    var href = "";
    var dataCta = "";
    try {
      href = (el && el.getAttribute && (el.getAttribute("href") || el.href)) ? String(el.getAttribute("href") || el.href).slice(0, 500) : "";
      dataCta = (el && el.getAttribute && (el.getAttribute("data-track") || el.getAttribute("data-cta"))) ? String(el.getAttribute("data-track") || el.getAttribute("data-cta")).slice(0, 120) : "";
    } catch(_err) {}

    var isOutbound = false;
    if (href && /^https?:\\/\\//i.test(href)) {
      try {
        var parsedHref = new URL(href, location.href);
        if (parsedHref.hostname && parsedHref.hostname !== location.hostname) {
          isOutbound = true;
        }
      } catch(_uErr) {}
    }

    var clickPayload = {
      x_pct: x,
      y_pct: y,
      element_tag: tag,
      element_text: elText,
      element_selector: sel,
      href: href || undefined,
      data_cta: dataCta || undefined,
      metadata: {
        text: elText,
        element_text: elText,
        element_tag: tag,
        element_selector: sel,
        element: sel,
        href: href || undefined,
        data_cta: dataCta || undefined,
        is_outbound: isOutbound,
        viewport_w: vp.viewport_w,
        viewport_h: vp.viewport_h
      }
    };
    send("click", clickPayload);
    if (isOutbound) {
      send("outbound_click", clickPayload, true);
    }
    if (dataCta && /pricing|bang-gia|bao-gia|quote|checkout/i.test(dataCta + " " + elText + " " + href)) {
      checkPricingIntent(href || location.href, elText || dataCta);
    }
  }, { passive: true });

  // --- 5. Form Focus Capture (deduplicated per form) ---
  var focusedForms = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  d.addEventListener("focusin", function(e) {
    markUserActivity();
    var target = e.target;
    if (!target || !target.tagName) return;
    var tName = String(target.tagName).toUpperCase();
    if (tName !== "INPUT" && tName !== "TEXTAREA" && tName !== "SELECT") return;
    var formEl = target.form || (target.closest ? target.closest("form") : null);
    if (!formEl) return;
    if (focusedForms) {
      if (focusedForms.has(formEl)) return;
      focusedForms.add(formEl);
    } else if (formEl.__domFocused) {
      return;
    } else {
      formEl.__domFocused = true;
    }
    var formSel = buildSelector(formEl);
    var fieldName = String(target.name || target.id || target.placeholder || "").slice(0, 80);
    send("form_focus", {
      element_tag: "FORM",
      element_selector: formSel,
      element_text: String(formEl.getAttribute && (formEl.getAttribute("name") || formEl.getAttribute("aria-label") || formEl.id) || formSel).slice(0, 120),
      metadata: {
        form_selector: formSel,
        first_field: fieldName,
        text: "Focus Form: " + (fieldName || formSel)
      }
    });
  }, { passive: true });

  // --- 6. Exit & Visibility Active Duration Flush via sendBeacon (keepalive fallback) ---
  var exitFlushed = false;
  function flushEngagementExit(reason) {
    accumulateActiveMs(Date.now());
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
    var activeSec = Math.max(0, Math.min(MAX_SINGLE_FLUSH_SEC, Math.round(activeMs / 1000)));
    var finalScroll = Math.max(maxScrollPct, computeScrollPct());
    if (exitFlushed && activeSec <= 0) return;
    exitFlushed = true;
    activeMs = 0;
    lastTickAt = Date.now();
    send("page_exit", {
      active_duration_seconds: activeSec,
      duration_seconds: activeSec,
      scroll_depth_pct: finalScroll > 0 ? finalScroll : undefined,
      metadata: {
        active_duration_seconds: activeSec,
        duration_seconds: activeSec,
        max_scroll_pct: finalScroll,
        exit_reason: reason || "pagehide",
        page_title: d.title || ""
      }
    }, true);
  }
  d.addEventListener("visibilitychange", function() {
    if (d.visibilityState === "hidden") {
      isVisible = false;
      flushEngagementExit("visibility_hidden");
    } else if (d.visibilityState === "visible") {
      isVisible = true;
      exitFlushed = false;
      var now = Date.now();
      lastActivityAt = now;
      lastTickAt = now;
    }
  });
  w.addEventListener("pagehide", function() {
    if (activeTickInterval) { try { w.clearInterval(activeTickInterval); } catch(_e) {} }
    flushEngagementExit("pagehide");
  });

  if (enableChat && d.body) {
    var box = d.createElement("div");
    box.id = "domation-chat-widget";
    box.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:99999;font-family:Inter,Arial,sans-serif;";
    var btn = d.createElement("button");
    btn.type = "button";
    btn.textContent = cfg.chatLabel || "Hỗ trợ AI";
    btn.style.cssText = "background:#1E40FF;color:#fff;border:none;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(30,64,255,0.28);";
    var panel = d.createElement("div");
    panel.style.cssText = "display:none;width:320px;background:#fff;border:1px solid #E2E8F0;border-radius:16px;box-shadow:0 16px 40px rgba(15,23,42,0.16);overflow:hidden;margin-bottom:10px;";
    panel.innerHTML = '<div style="background:#1E40FF;color:#fff;padding:12px 14px;font-weight:700;font-size:13px;">DOM Agent Trợ Lý</div><div id="dom-chat-log" style="height:200px;overflow:auto;padding:10px;font-size:13px;background:#F8FAFC;"></div><form id="dom-chat-form" style="display:flex;border-top:1px solid #E2E8F0;"><input id="dom-chat-input" placeholder="Nhập câu hỏi..." style="flex:1;border:none;padding:10px;font-size:13px;outline:none;"/><button type="submit" style="background:#1E40FF;color:#fff;border:none;padding:0 14px;font-weight:700;cursor:pointer;">Gửi</button></form>';
    btn.addEventListener("click", function(){ panel.style.display = panel.style.display === "none" ? "block" : "none"; });
    panel.querySelector("#dom-chat-form").addEventListener("submit", function(ev){
      ev.preventDefault();
      var inp = panel.querySelector("#dom-chat-input");
      var log = panel.querySelector("#dom-chat-log");
      var msg = (inp.value || "").trim();
      if (!msg) return;
      inp.value = "";
      var uDiv = d.createElement("div"); uDiv.textContent = "Bạn: " + msg; uDiv.style.marginBottom = "6px"; log.appendChild(uDiv);
      sendChatMessage(msg).then(function(res){
        var bDiv = d.createElement("div"); bDiv.textContent = "Bot: " + ((res && res.data && res.data.reply) || "Đã ghi nhận!"); bDiv.style.cssText = "margin-bottom:8px;color:#1E40FF;"; log.appendChild(bDiv);
        log.scrollTop = log.scrollHeight;
      }).catch(function(){});
    });
    box.appendChild(panel);
    box.appendChild(btn);
    d.body.appendChild(box);
  }
  w.DomationChatWidget = { send: sendChatMessage, threadId: vid };
  w.DomationTracker = {
    track: send,
    identify: function(info) { send("identify", info); },
    chat: sendChatMessage,
    getActiveSeconds: function() { accumulateActiveMs(Date.now()); return Math.round(activeMs / 1000); },
    getMaxScrollPct: function() { return Math.max(maxScrollPct, computeScrollPct()); }
  };
})(window, document);`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(js);
});

router.post('/track', publicWebTrackRateLimiter, async (req, res) => {
  try {
    const siteKey = String(req.body?.site_key || '').trim();
    let propLookup: { tenant_id: string; property_id: string } | null = null;

    if (siteKey) {
      propLookup = await withSystemPrivilege(async (client) => {
        const r = await client.query<{ tenant_id: string; property_id: string }>(
          `SELECT p.tenant_id, p.id AS property_id
           FROM mkt_web_properties p
           INNER JOIN tenants t ON t.id = p.tenant_id
           WHERE p.site_key = $1 AND p.is_active = true AND t.status != 'deleted'
           LIMIT 1`,
          [siteKey]
        );
        return r.rows[0] || null;
      });
    } else {
      const fallbackTenantId = await resolvePublicTenantId(req);
      if (fallbackTenantId) {
        propLookup = await withTenantTransaction(fallbackTenantId, async (client) => {
          const r = await client.query<{ id: string }>(
            'SELECT id FROM mkt_web_properties WHERE tenant_id = $1 AND is_active = true ORDER BY created_at ASC LIMIT 1',
            [fallbackTenantId]
          );
          return r.rows[0] ? { tenant_id: fallbackTenantId, property_id: r.rows[0].id } : null;
        });
      }
    }

    if (!propLookup) {
      sendApiError(res, 404, 'WEB_PROPERTY_NOT_FOUND', 'Không tìm thấy cấu hình Website (site_key) hợp lệ.');
      return;
    }

    const cfg = await getTenantSettingsCached(propLookup.tenant_id);
    const visitorToken = String(
      req.body?.visitor_token || req.body?.visitor_id || `anon_${crypto.randomBytes(6).toString('hex')}`
    ).trim();
    const pageUrl = String(req.body?.page_url || 'https://domation.net/').trim();
    const eventType = String(req.body?.event_type || 'pageview').trim().toLowerCase();
    const rawUa = String(req.headers['user-agent'] || '');
    const uaHints = parseUserAgentHints(rawUa);
    const deviceType = String(req.body?.device_type || uaHints.deviceType).trim().toLowerCase() || 'desktop';
    const browserName = String(req.body?.browser || uaHints.browser || 'Unknown').slice(0, 60);
    const osName = String(req.body?.os || uaHints.os || 'Unknown').slice(0, 60);
    const clientIp = String(req.headers['x-forwarded-for'] || req.ip || '')
      .split(',')[0]
      .trim()
      .slice(0, 64);

    let urlUtmSource: string | null = null;
    let urlUtmMedium: string | null = null;
    let urlUtmCampaign: string | null = null;
    try {
      const parsedUrl = new URL(pageUrl);
      urlUtmSource = parsedUrl.searchParams.get('utm_source');
      urlUtmMedium = parsedUrl.searchParams.get('utm_medium');
      urlUtmCampaign = parsedUrl.searchParams.get('utm_campaign');
    } catch {
      // Ignore malformed relative URLs
    }
    const utmSource = req.body?.utm_source ? String(req.body.utm_source).slice(0, 100) : urlUtmSource?.slice(0, 100) || null;
    const utmMedium = req.body?.utm_medium ? String(req.body.utm_medium).slice(0, 100) : urlUtmMedium?.slice(0, 100) || null;
    const utmCampaign = req.body?.utm_campaign ? String(req.body.utm_campaign).slice(0, 150) : urlUtmCampaign?.slice(0, 150) || null;

    const rawBodyMeta =
      req.body?.metadata && typeof req.body.metadata === 'object'
        ? (req.body.metadata as Record<string, unknown>)
        : {};

    // Cap single-ping active duration safely to <= 1800s against background tab / clock-jump corruption
    const MAX_SINGLE_PING_DURATION_SEC = 1800;
    const rawDuration =
      req.body?.active_duration_seconds ??
      rawBodyMeta.active_duration_seconds ??
      req.body?.duration_seconds ??
      req.body?.duration ??
      rawBodyMeta.duration_seconds;
    const durationDelta =
      rawDuration !== undefined && rawDuration !== null && Number.isFinite(Number(rawDuration))
        ? Math.min(MAX_SINGLE_PING_DURATION_SEC, Math.max(0, Math.round(Number(rawDuration))))
        : 0;

    const elementTextRaw =
      req.body?.element_text ??
      rawBodyMeta.element_text ??
      rawBodyMeta.text ??
      '';
    const elementText = String(elementTextRaw || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const elementTag = String(req.body?.element_tag ?? rawBodyMeta.element_tag ?? '')
      .trim()
      .toUpperCase()
      .slice(0, 32);
    const elementSelectorRaw =
      req.body?.element_selector ??
      rawBodyMeta.element_selector ??
      rawBodyMeta.element ??
      elementTag;
    const elementSelector = elementSelectorRaw ? String(elementSelectorRaw).trim().slice(0, 255) : null;
    const elementHrefRaw = req.body?.href ?? rawBodyMeta.href ?? '';
    const elementHref = elementHrefRaw ? String(elementHrefRaw).trim().slice(0, 500) : null;
    const dataCtaRaw = req.body?.data_cta ?? rawBodyMeta.data_cta ?? '';
    const dataCta = dataCtaRaw ? String(dataCtaRaw).trim().slice(0, 120) : null;
    const viewportW = Number.isFinite(Number(req.body?.viewport_w ?? rawBodyMeta.viewport_w))
      ? Math.max(0, Math.min(10000, Math.round(Number(req.body?.viewport_w ?? rawBodyMeta.viewport_w))))
      : null;
    const viewportH = Number.isFinite(Number(req.body?.viewport_h ?? rawBodyMeta.viewport_h))
      ? Math.max(0, Math.min(10000, Math.round(Number(req.body?.viewport_h ?? rawBodyMeta.viewport_h))))
      : null;

    const rawScrollDepth =
      req.body?.scroll_depth_pct !== undefined
        ? req.body.scroll_depth_pct
        : rawBodyMeta.max_scroll_pct !== undefined
          ? rawBodyMeta.max_scroll_pct
          : rawBodyMeta.percent;
    const scrollDepth =
      rawScrollDepth !== undefined && rawScrollDepth !== null && Number.isFinite(Number(rawScrollDepth))
        ? Math.min(100, Math.max(0, Math.round(Number(rawScrollDepth))))
        : null;

    const outcome = await withTenantTransaction(propLookup.tenant_id, async (client) => {
      const pRes = await client.query(
        'SELECT * FROM mkt_web_properties WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [propLookup!.tenant_id, propLookup!.property_id]
      );
      const prop = pRes.rows[0];

      // Visitor-to-Lead Identity Stitching (explicit lead_id or phone/email)
      const identifyObj =
        req.body?.identify && typeof req.body.identify === 'object'
          ? (req.body.identify as Record<string, unknown>)
          : null;
      const trackName = identifyObj?.name ?? req.body?.name;
      const trackPhone = identifyObj?.phone ?? req.body?.phone;
      const trackEmail = identifyObj?.email ?? req.body?.email;
      const explicitLeadId = String(req.body?.lead_id || identifyObj?.lead_id || '').trim();
      let stitchedLeadId: string | null = null;
      if (explicitLeadId && UUID_REGEX.test(explicitLeadId)) {
        const lChk = await client.query<{ id: string }>(
          'SELECT id FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1',
          [propLookup!.tenant_id, explicitLeadId]
        );
        if (lChk.rows[0]?.id) {
          stitchedLeadId = lChk.rows[0].id;
        }
      }
      if (!stitchedLeadId && (trackPhone || trackEmail)) {
        const upserted = await upsertMasterContactInTx(
          client,
          propLookup!.tenant_id,
          {
            name: trackName,
            phone: trackPhone,
            email: trackEmail,
            source: `Web Tracking (${prop.domain})`,
          },
          {
            defaultStatus: 'marketing_nurture',
            defaultSource: `Web Tracking (${prop.domain})`,
            dialCode: cfg.default_dial_code,
          }
        );
        stitchedLeadId = upserted.leadId;
      }

      // Check Pricing-Page Intent pattern
      const patterns = String(prop.pricing_url_pattern || '/pricing,/bang-gia')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const pageLower = pageUrl.toLowerCase();
      const isPricingIntent =
        eventType === 'pricing_intent' ||
        ((eventType === 'pageview' || eventType === 'identify') && patterns.some((pat) => pat && pageLower.includes(pat)));

      const sessCandidateId = crypto.randomUUID();
      const pageviewDelta = eventType === 'pageview' ? 1 : 0;
      await client.query(
        `INSERT INTO mkt_web_sessions (
           id, tenant_id, property_id, visitor_token, lead_id, entry_url, last_url,
           referrer, utm_source, utm_medium, utm_campaign, device_type, browser, os,
           duration_seconds, pageviews_count, pricing_intent_detected
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $14, $15, $16, $13, $12)
         ON CONFLICT (tenant_id, property_id, visitor_token) DO UPDATE SET
           lead_id = COALESCE(EXCLUDED.lead_id, mkt_web_sessions.lead_id),
           last_url = EXCLUDED.last_url,
           utm_source = COALESCE(mkt_web_sessions.utm_source, EXCLUDED.utm_source),
           utm_medium = COALESCE(mkt_web_sessions.utm_medium, EXCLUDED.utm_medium),
           utm_campaign = COALESCE(mkt_web_sessions.utm_campaign, EXCLUDED.utm_campaign),
           browser = COALESCE(NULLIF(EXCLUDED.browser, 'Unknown'), mkt_web_sessions.browser, EXCLUDED.browser),
           os = COALESCE(NULLIF(EXCLUDED.os, 'Unknown'), mkt_web_sessions.os, EXCLUDED.os),
           duration_seconds = LEAST(86400, COALESCE(mkt_web_sessions.duration_seconds, 0) + $16),
           pageviews_count = mkt_web_sessions.pageviews_count + $13,
           pricing_intent_detected = CASE WHEN EXCLUDED.pricing_intent_detected = true THEN true ELSE mkt_web_sessions.pricing_intent_detected END,
           last_seen_at = clock_timestamp()`,
        [
          sessCandidateId,
          propLookup!.tenant_id,
          propLookup!.property_id,
          visitorToken,
          stitchedLeadId,
          pageUrl,
          req.body?.referrer ? String(req.body.referrer) : null,
          utmSource,
          utmMedium,
          utmCampaign,
          deviceType,
          isPricingIntent,
          pageviewDelta,
          browserName,
          osName,
          durationDelta,
        ]
      );

      const sessRes = await client.query<{ id: string; lead_id: string | null; duration_seconds: number }>(
        `SELECT id, lead_id, COALESCE(duration_seconds, 0)::int AS duration_seconds FROM mkt_web_sessions
         WHERE tenant_id = $1 AND property_id = $2 AND visitor_token = $3
         LIMIT 1`,
        [propLookup!.tenant_id, propLookup!.property_id, visitorToken]
      );
      const sess = sessRes.rows[0];
      const effectiveLeadId = stitchedLeadId || sess.lead_id;

      // Retroactively stitch historical events in this session to the newly identified Lead!
      if (effectiveLeadId) {
        await client.query(
          'UPDATE mkt_web_events SET lead_id = $3 WHERE tenant_id = $1 AND session_id = $2 AND lead_id IS NULL',
          [propLookup!.tenant_id, sess.id, effectiveLeadId]
        );
      }

      const xPct = req.body?.x_pct !== undefined ? Math.min(100, Math.max(0, Number(req.body.x_pct))) : null;
      const yPct = req.body?.y_pct !== undefined ? Math.min(100, Math.max(0, Number(req.body.y_pct))) : null;

      const eventMeta: Record<string, unknown> = {
        ...rawBodyMeta,
        ...(clientIp ? { client_ip: clientIp } : {}),
        ...(durationDelta > 0
          ? { active_duration_seconds: durationDelta, duration_seconds: durationDelta }
          : {}),
        ...(req.body?.page_title ? { page_title: String(req.body.page_title).slice(0, 255) } : {}),
        ...(elementText ? { text: elementText, element_text: elementText } : {}),
        ...(elementTag ? { element_tag: elementTag } : {}),
        ...(elementSelector ? { element_selector: elementSelector } : {}),
        ...(elementHref ? { href: elementHref } : {}),
        ...(dataCta ? { data_cta: dataCta } : {}),
        ...(scrollDepth !== null ? { scroll_depth_pct: scrollDepth, percent: scrollDepth, max_scroll_pct: scrollDepth } : {}),
        ...(viewportW !== null ? { viewport_w: viewportW } : {}),
        ...(viewportH !== null ? { viewport_h: viewportH } : {}),
      };

      await client.query(
        `INSERT INTO mkt_web_events (
           id, tenant_id, property_id, session_id, lead_id, event_type,
           page_url, element_selector, x_pct, y_pct, scroll_depth_pct, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [
          crypto.randomUUID(),
          propLookup!.tenant_id,
          propLookup!.property_id,
          sess.id,
          effectiveLeadId,
          isPricingIntent && eventType === 'pageview' ? 'pricing_intent' : eventType,
          pageUrl,
          elementSelector,
          xPct,
          yPct,
          scrollDepth,
          JSON.stringify(eventMeta),
        ]
      );

      // If Pricing-Page Intent detected for an identified Lead -> boost score, log timeline `web_page_view` & attach to target Audience!
      if (effectiveLeadId && (eventType === 'pageview' || isPricingIntent || stitchedLeadId)) {
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'web_page_view', 'communication', 'tenant_admin', 'DOM Web Tracker', $4, $5, $6::jsonb)`,
          [
            crypto.randomUUID(),
            propLookup!.tenant_id,
            effectiveLeadId,
            isPricingIntent ? `Cảnh báo Intent: Xem trang Bảng giá (${prop.domain})` : `Truy cập trang Web (${prop.domain})`,
            pageUrl,
            JSON.stringify({ url: pageUrl, pricing_intent: isPricingIntent }),
          ]
        );

        if (isPricingIntent) {
          await client.query(
            `UPDATE leads
             SET lead_score = lead_score + 15,
                 last_engaged_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [propLookup!.tenant_id, effectiveLeadId]
          );

          if (prop.target_audience_id) {
            await client.query(
              `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
               VALUES ($1, $2, $3, $4, 'pricing_intent', '{}'::jsonb)
               ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
              [crypto.randomUUID(), propLookup!.tenant_id, prop.target_audience_id, effectiveLeadId]
            );
            await refreshAudienceCachedCount(client, propLookup!.tenant_id, String(prop.target_audience_id));
          }
        }
      }

      return {
        session_id: sess.id,
        lead_id: effectiveLeadId,
        stitched: Boolean(effectiveLeadId),
        pricing_intent_detected: isPricingIntent,
        active_duration_seconds: durationDelta,
        session_duration_seconds: Number(sess.duration_seconds || 0),
        scroll_depth_pct: scrollDepth,
        element_text: elementText || null,
        element_selector: elementSelector,
        href: elementHref,
      };
    });

    if (outcome.lead_id) {
      const commonMeta = {
        pageUrl,
        pricingIntent: outcome.pricing_intent_detected,
        elementText: outcome.element_text,
        elementSelector: outcome.element_selector,
        href: outcome.href,
        dataCta: dataCta || null,
        scrollDepthPct: outcome.scroll_depth_pct,
        activeDurationSeconds: outcome.active_duration_seconds,
        sessionDurationSeconds: outcome.session_duration_seconds,
        utmSource,
        utmMedium,
        utmCampaign,
      };

      if (outcome.pricing_intent_detected) {
        await emitDomainEvent('marketing.engaged', {
          tenantId: propLookup.tenant_id,
          leadId: outcome.lead_id,
          engagementType: 'web.pricing_intent',
          channel: 'web',
          scoreDelta: 15,
          metadata: commonMeta,
        });
      }

      if (eventType === 'click' || eventType === 'outbound_click') {
        await emitDomainEvent('marketing.engaged', {
          tenantId: propLookup.tenant_id,
          leadId: outcome.lead_id,
          engagementType: 'web.cta_click',
          channel: 'web',
          scoreDelta: 3,
          metadata: { ...commonMeta, isOutbound: eventType === 'outbound_click' || Boolean(rawBodyMeta.is_outbound) },
        });
      } else if (eventType === 'scroll' && outcome.scroll_depth_pct !== null && outcome.scroll_depth_pct > 0) {
        await emitDomainEvent('marketing.engaged', {
          tenantId: propLookup.tenant_id,
          leadId: outcome.lead_id,
          engagementType: 'web.scroll_depth',
          channel: 'web',
          scoreDelta: 0,
          metadata: commonMeta,
        });
      } else if (eventType === 'page_exit' && (outcome.active_duration_seconds >= 15 || outcome.session_duration_seconds >= 30)) {
        await emitDomainEvent('marketing.engaged', {
          tenantId: propLookup.tenant_id,
          leadId: outcome.lead_id,
          engagementType: 'web.engaged_session',
          channel: 'web',
          scoreDelta: 0,
          metadata: commonMeta,
        });
      } else if (!outcome.pricing_intent_detected) {
        await emitDomainEvent('marketing.engaged', {
          tenantId: propLookup.tenant_id,
          leadId: outcome.lead_id,
          engagementType: 'web.pageview',
          channel: 'web',
          scoreDelta: 2,
          metadata: commonMeta,
        });
      }

      await evaluateAllDynamicAudiencesForTenant(propLookup.tenant_id);
    }

    res.status(201).json({ success: true, data: outcome });
  } catch (err: any) {
    sendApiError(res, 500, 'WEB_TRACK_INGEST_FAILED', err?.message || 'Không thể ghi nhận sự kiện Web Tracking.');
  }
});

// ============================================================================
// 7. Public Voucher Info & Claim (`/claim/:id` or `/vouchers/:slug`) + Social Ingress
// ============================================================================
async function resolvePublicVoucherPool(idOrSlug: string): Promise<{ tenant_id: string; pool_id: string; company_name: string } | null> {
  const clean = String(idOrSlug || '').trim();
  if (!clean) return null;
  const isUuid = UUID_REGEX.test(clean);

  return withSystemPrivilege(async (client) => {
    const cond = isUuid ? 'vc.id = $1' : 'vc.slug = $1';
    const r = await client.query<{ tenant_id: string; pool_id: string; company_name: string }>(
      `SELECT vc.tenant_id, vc.id AS pool_id, t.name AS company_name
       FROM mkt_voucher_campaigns vc
       INNER JOIN tenants t ON t.id = vc.tenant_id
       WHERE ${cond} AND vc.status = 'active' AND t.status != 'deleted'
       LIMIT 1`,
      [clean]
    );
    return r.rows[0] || null;
  });
}

router.get('/vouchers/:slug', async (req, res) => {
  try {
    const resolved = await resolvePublicVoucherPool(String(req.params.slug || ''));
    if (!resolved) {
      sendApiError(res, 404, 'VOUCHER_CAMPAIGN_NOT_FOUND', 'Chiến dịch ưu đãi không tồn tại hoặc đã kết thúc.');
      return;
    }

    const data = await withTenantTransaction(resolved.tenant_id, async (client) => {
      const pRes = await client.query(
        'SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [resolved.tenant_id, resolved.pool_id]
      );
      const p = pRes.rows[0];
      if (!p) return null;
      return {
        id: String(p.id),
        slug: String(p.slug),
        name: String(p.name),
        description: p.description ? String(p.description) : '',
        company_name: resolved.company_name,
        discount_type: String(p.discount_type || 'percentage'),
        discount_value: Number(p.discount_value || 0),
        min_order_vnd: Number(p.min_order_vnd || 0),
        expires_at: p.expires_at || null,
        total_codes: Number(p.total_codes || 0),
        claimed_codes: Number(p.claimed_codes || 0),
        qr_design: parseJsonCol(p.qr_design_json, {}),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_PUBLIC_VOUCHER_FAILED', err?.message || 'Không thể tải thông tin chiến dịch ưu đãi.');
  }
});

router.post('/vouchers/:slug/claim', async (req, res) => {
  try {
    const resolved = await resolvePublicVoucherPool(String(req.params.slug || ''));
    if (!resolved) {
      sendApiError(res, 404, 'VOUCHER_CAMPAIGN_NOT_FOUND', 'Chiến dịch ưu đãi không tồn tại hoặc đã kết thúc.');
      return;
    }

    const phoneVal = String(req.body?.phone || '').trim();
    const emailVal = String(req.body?.email || '').trim().toLowerCase();
    if (!phoneVal && !emailVal) {
      sendApiError(res, 422, 'CONTACT_REQUIRED', 'Vui lòng nhập Số điện thoại hoặc Email để nhận mã ưu đãi.');
      return;
    }

    const cfg = await getTenantSettingsCached(resolved.tenant_id);
    const out = await withTenantTransaction(resolved.tenant_id, async (client) => {
      const upserted = await upsertMasterContactInTx(
        client,
        resolved.tenant_id,
        {
          name: req.body?.name,
          phone: req.body?.phone,
          email: req.body?.email,
          source: 'Public Voucher Claim',
        },
        {
          defaultStatus: 'marketing_nurture',
          defaultSource: 'Public Voucher Claim',
          dialCode: cfg.default_dial_code,
        }
      );

      const pRes = await client.query(
        'SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [resolved.tenant_id, resolved.pool_id]
      );
      const pool = pRes.rows[0];
      if (!pool || String(pool.status || '') !== 'active') {
        return { errorCode: 'VOUCHER_CAMPAIGN_INACTIVE' as const };
      }
      if (pool.expires_at && new Date(String(pool.expires_at)).getTime() < Date.now()) {
        return { errorCode: 'VOUCHER_CAMPAIGN_EXPIRED' as const };
      }

      // Find an available code (with atomic status guard) or mint one on demand
      const availRes = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM mkt_voucher_codes
         WHERE tenant_id = $1 AND voucher_campaign_id = $2 AND status = 'available'
         ORDER BY created_at ASC LIMIT 1`,
        [resolved.tenant_id, pool.id]
      );

      let claimedCode = '';
      if (availRes.rows[0]) {
        const claimUpd = await client.query(
          `UPDATE mkt_voucher_codes
           SET status = 'claimed', lead_id = $3, claimed_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2 AND status = 'available'`,
          [resolved.tenant_id, availRes.rows[0].id, upserted.leadId]
        );
        if ((claimUpd.rowCount || 0) === 1) {
          claimedCode = availRes.rows[0].code;
          await client.query(
            'UPDATE mkt_voucher_campaigns SET claimed_codes = claimed_codes + 1 WHERE tenant_id = $1 AND id = $2',
            [resolved.tenant_id, pool.id]
          );
        }
      }
      if (!claimedCode) {
        claimedCode = `${String(pool.code_prefix || 'DOM').toUpperCase()}-${generateShortCode(6).toUpperCase()}`;
        await client.query(
          `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status, lead_id, claimed_at)
           VALUES ($1, $2, $3, $4, 'claimed', $5, clock_timestamp())`,
          [crypto.randomUUID(), resolved.tenant_id, pool.id, claimedCode, upserted.leadId]
        );
        await client.query(
          `UPDATE mkt_voucher_campaigns
           SET total_codes = total_codes + 1, claimed_codes = claimed_codes + 1
           WHERE tenant_id = $1 AND id = $2`,
          [resolved.tenant_id, pool.id]
        );
      }

      return { errorCode: null, code: claimedCode, lead_id: upserted.leadId, pool_name: String(pool.name) };
    });

    if (out.errorCode === 'VOUCHER_CAMPAIGN_EXPIRED') {
      sendApiError(res, 410, 'VOUCHER_CAMPAIGN_EXPIRED', 'Chiến dịch ưu đãi đã hết hạn.');
      return;
    }
    if (out.errorCode || !out.lead_id) {
      sendApiError(res, 404, 'VOUCHER_CAMPAIGN_NOT_FOUND', 'Chiến dịch ưu đãi không tồn tại hoặc đã kết thúc.');
      return;
    }

    await emitDomainEvent('marketing.engaged', {
      tenantId: resolved.tenant_id,
      leadId: out.lead_id,
      engagementType: 'voucher_claimed',
      channel: 'voucher',
      scoreDelta: 10,
      metadata: { code: out.code },
    });

    res.status(201).json({ success: true, data: { code: out.code, lead_id: out.lead_id, pool_name: out.pool_name } });
  } catch (err: any) {
    sendApiError(res, 500, 'CLAIM_VOUCHER_FAILED', err?.message || 'Không thể nhận mã ưu đãi.');
  }
});

async function resolveTenantBySlugOrSiteKey(rawHint: string): Promise<string | null> {
  const clean = String(rawHint || '').trim();
  const lower = clean.toLowerCase();
  if (!clean) return null;
  return withSystemPrivilege(async (client) => {
    const tRes = await client.query<{ id: string }>(
      `SELECT id FROM tenants WHERE (slug = $1 OR obfuscated_slug = $1) AND status != 'deleted' LIMIT 1`,
      [lower]
    );
    if (tRes.rows[0]?.id) return tRes.rows[0].id;
    const pRes = await client.query<{ tenant_id: string }>(
      `SELECT p.tenant_id
       FROM mkt_web_properties p
       INNER JOIN tenants t ON t.id = p.tenant_id
       WHERE p.site_key = $1 AND p.is_active = true AND t.status != 'deleted'
       LIMIT 1`,
      [clean]
    );
    return pRes.rows[0]?.tenant_id || null;
  });
}

// Meta Messenger Webhook Verification Challenge (`GET /social/inbound/:tenantSlug`)
router.get('/social/inbound/:tenantSlug', async (req, res) => {
  try {
    const tenantId = await resolveTenantBySlugOrSiteKey(String(req.params.tenantSlug || ''));
    if (!tenantId) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
      return;
    }

    const mode = String(req.query['hub.mode'] || '').trim();
    const token = String(req.query['hub.verify_token'] || '').trim();
    const challenge = String(req.query['hub.challenge'] || '');
    if (mode !== 'subscribe' || !token) {
      sendApiError(res, 403, 'WEBHOOK_VERIFICATION_FAILED', 'Tham số xác thực Meta Webhook không hợp lệ.');
      return;
    }

    const expectedToken = await withTenantTransaction(tenantId, async (client) => {
      const cfg = await resolveMetaMessengerVaultConfig(client, tenantId);
      if (cfg.verifyToken) return cfg.verifyToken;
      const tRes = await client.query<{ settings: Record<string, unknown> }>(
        'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
        [tenantId]
      );
      const settings = (tRes.rows[0]?.settings || {}) as Record<string, unknown>;
      return String(settings.meta_verify_token || '').trim();
    });

    const a = Buffer.from(expectedToken, 'utf8');
    const b = Buffer.from(token, 'utf8');
    const matched = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!matched) {
      sendApiError(res, 403, 'INVALID_VERIFY_TOKEN', 'Verify token không khớp.');
      return;
    }

    res.status(200).type('text/plain').send(challenge);
  } catch (err: any) {
    sendApiError(res, 500, 'SOCIAL_VERIFY_FAILED', err?.message || 'Không thể xác thực Webhook Social.');
  }
});

const INBOUND_DEDUP_TTL_MS = 15 * 60_000;
const INBOUND_DEDUP_MAX_SIZE = 5000;
const recentInboundMessageIds = new Map<string, number>();

function pruneInboundDedupCache(now: number): void {
  if (recentInboundMessageIds.size <= INBOUND_DEDUP_MAX_SIZE) return;
  for (const [k, exp] of recentInboundMessageIds.entries()) {
    if (exp <= now) recentInboundMessageIds.delete(k);
  }
  if (recentInboundMessageIds.size > INBOUND_DEDUP_MAX_SIZE) {
    const excess = recentInboundMessageIds.size - Math.floor(INBOUND_DEDUP_MAX_SIZE * 0.8);
    let dropped = 0;
    for (const k of recentInboundMessageIds.keys()) {
      recentInboundMessageIds.delete(k);
      dropped++;
      if (dropped >= excess) break;
    }
  }
}

function makeInboundDedupKey(tenantId: string, channel: string, externalMsgId: string): string {
  return `${tenantId}:${channel}:${externalMsgId}`;
}

function isInMemoryInboundDuplicate(tenantId: string, channel: string, externalMsgId: string): boolean {
  if (!externalMsgId) return false;
  const now = Date.now();
  const key = makeInboundDedupKey(tenantId, channel, externalMsgId);
  const exp = recentInboundMessageIds.get(key);
  if (exp && exp > now) return true;
  if (exp) recentInboundMessageIds.delete(key);
  return false;
}

function markInMemoryInboundProcessed(tenantId: string, channel: string, externalMsgId: string): void {
  if (!externalMsgId) return;
  const now = Date.now();
  pruneInboundDedupCache(now);
  recentInboundMessageIds.set(makeInboundDedupKey(tenantId, channel, externalMsgId), now + INBOUND_DEDUP_TTL_MS);
}

async function isInboundMessageDuplicateInTx(
  client: DbClient,
  tenantId: string,
  channel: string,
  externalMsgId: string
): Promise<boolean> {
  if (!externalMsgId) return false;
  if (isInMemoryInboundDuplicate(tenantId, channel, externalMsgId)) return true;
  try {
    const r = await client.query<{ id: string }>(
      `SELECT m.id
       FROM mkt_social_messages m
       INNER JOIN mkt_social_conversations c
         ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
       WHERE m.tenant_id = $1
         AND c.channel = $2
         AND m.sender_type = 'customer'
         AND m.extracted_entities->>'external_msg_id' = $3
       LIMIT 1`,
      [tenantId, channel, externalMsgId]
    );
    if (r.rows[0]?.id) {
      markInMemoryInboundProcessed(tenantId, channel, externalMsgId);
      return true;
    }
  } catch {
    // Fallback to in-memory dedup if dialect lacks ->>
  }
  return false;
}

async function dispatchZaloOaCsReply(params: {
  tenantId: string;
  client: DbClient;
  recipientUserId: string;
  text: string;
}): Promise<{ sent: boolean; silent?: boolean; queued?: boolean; provider: string; external_message_id?: string; error?: string }> {
  const fallbackMsgId = `zalo_cs_${crypto.randomUUID()}`;
  try {
    if (isOutboundSilentMode()) {
      return {
        sent: true,
        silent: true,
        provider: 'zalo_oa:silent_guard',
        external_message_id: fallbackMsgId,
      };
    }

    const vault = await readTenantChannelVault(params.client, params.tenantId, ['zalo_oa', 'zalo_zns']);
    const accessToken = String(vault.config.access_token || '').trim();
    const tokenLower = accessToken.toLowerCase();
    const isSandbox = tokenLower.startsWith('sandbox_') || tokenLower.startsWith('demo_') || tokenLower.startsWith('test_');

    if (!vault.configured || !accessToken || isSandbox) {
      return {
        sent: true,
        queued: true,
        provider: isSandbox ? 'zalo_oa:silent_guard' : 'zalo_oa:vault_queued',
        external_message_id: fallbackMsgId,
      };
    }

    const resp = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        access_token: accessToken,
      },
      body: JSON.stringify({
        recipient: { user_id: String(params.recipientUserId) },
        message: { text: String(params.text || '').slice(0, 2000) },
      }),
      signal: AbortSignal.timeout(8000),
    });

    const data = (await resp.json().catch(() => null)) as {
      error?: number;
      message?: string;
      data?: { message_id?: string };
    } | null;

    if (!resp.ok || (data && typeof data.error === 'number' && data.error !== 0)) {
      return {
        sent: false,
        provider: 'zalo_oa',
        external_message_id: fallbackMsgId,
        error: data?.message || `Zalo OA HTTP ${resp.status}`,
      };
    }

    return {
      sent: true,
      provider: 'zalo_oa',
      external_message_id: String(data?.data?.message_id || fallbackMsgId),
    };
  } catch (err: any) {
    return {
      sent: false,
      provider: 'zalo_oa',
      external_message_id: fallbackMsgId,
      error: err?.message || 'ZALO_OA_DISPATCH_ERROR',
    };
  }
}

router.post('/social/inbound/:tenantSlug', async (req, res) => {
  try {
    const tenantId = await resolveTenantBySlugOrSiteKey(String(req.params.tenantSlug || ''));
    if (!tenantId) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
      return;
    }

    const cfg = await getTenantSettingsCached(tenantId);
    const isMetaGraphEnvelope = req.body?.object === 'page' && Array.isArray(req.body?.entry);

    if (isMetaGraphEnvelope) {
      const sigHeader = req.header('x-hub-signature-256') || '';
      const rawBody: Buffer | string = (req as any).rawBody || JSON.stringify(req.body || {});
      const preferredPageId = String(req.body?.entry?.[0]?.id || '').trim() || undefined;
      const metaVault = await withTenantTransaction(tenantId, async (client) =>
        resolveMetaMessengerVaultConfig(client, tenantId, preferredPageId)
      );

      if (metaVault.appSecret || sigHeader) {
        if (!metaVault.appSecret || !verifyMetaWebhookSignature(rawBody, metaVault.appSecret, sigHeader)) {
          sendApiError(res, 401, 'INVALID_META_SIGNATURE', 'Chữ ký X-Hub-Signature-256 không hợp lệ.');
          return;
        }
      }

      const incomingEvents: Array<{ pageId: string; threadId: string; text: string; customerName: string; mid: string }> = [];
      for (const entry of req.body.entry as Array<Record<string, unknown>>) {
        const pageId = String(entry?.id || metaVault.pageId || '').trim();
        const messaging = Array.isArray(entry?.messaging) ? (entry.messaging as Array<Record<string, unknown>>) : [];
        for (const ev of messaging) {
          const msgObj = (ev?.message && typeof ev.message === 'object' ? ev.message : null) as Record<string, unknown> | null;
          if (!msgObj || msgObj.is_echo === true) continue;
          const text = String(msgObj.text || '').trim();
          const senderId = String((ev?.sender as Record<string, unknown> | undefined)?.id || '').trim();
          const mid = String(msgObj.mid || '').trim();
          if (!text || !senderId) continue;
          incomingEvents.push({
            pageId,
            threadId: senderId,
            text,
            customerName: String((ev?.sender as Record<string, unknown> | undefined)?.name || `Messenger ${senderId.slice(-6)}`).trim(),
            mid,
          });
        }
      }

      let drainAfterCommit = false;
      const enteredAudiences: Array<{ audienceId: string; leadId: string }> = [];
      const engagedLeads: string[] = [];
      const processed: Array<Record<string, unknown>> = [];
      const newlyProcessedMids: string[] = [];

      if (incomingEvents.length > 0) {
        await withTenantTransaction(tenantId, async (client) => {
          const botRes = await client.query('SELECT * FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
          const bot = botRes.rows[0];
          const botName = bot ? String(bot.bot_name || 'DOM Agent CSKH') : 'DOM Agent CSKH';
          const brandPersona = bot ? String(bot.brand_persona || '') : '';
          const faqRules = bot ? parseJsonCol<FaqRuleItemDto[]>(bot.faq_rules_json, []) : [];
          const routingMode = String(bot?.routing_mode || 'audience');
          const botActive = bot ? Boolean(bot.is_active) : true;

          for (const ev of incomingEvents) {
            if (ev.mid && (newlyProcessedMids.includes(ev.mid) || (await isInboundMessageDuplicateInTx(client, tenantId, 'messenger', ev.mid)))) {
              processed.push({
                duplicate: true,
                skipped: true,
                external_msg_id: ev.mid,
              });
              continue;
            }

            const extracted = extractContactEntitiesFromText(ev.text);
            await client.query(
              `INSERT INTO mkt_social_conversations (
                 id, tenant_id, channel, external_thread_id, customer_name, extracted_phone, extracted_email, last_message_preview, unread_count
               ) VALUES ($1, $2, 'messenger', $3, $4, $5, $6, $7, 1)
               ON CONFLICT (tenant_id, channel, external_thread_id) DO UPDATE SET
                 extracted_phone = COALESCE(EXCLUDED.extracted_phone, mkt_social_conversations.extracted_phone),
                 extracted_email = COALESCE(EXCLUDED.extracted_email, mkt_social_conversations.extracted_email),
                 last_message_preview = EXCLUDED.last_message_preview,
                 unread_count = mkt_social_conversations.unread_count + 1,
                 last_message_at = clock_timestamp()`,
              [crypto.randomUUID(), tenantId, ev.threadId, ev.customerName, extracted.phone, extracted.email, ev.text.slice(0, 200)]
            );

            const convRes = await client.query(
              "SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = 'messenger' AND external_thread_id = $2 LIMIT 1",
              [tenantId, ev.threadId]
            );
            const conv = convRes.rows[0];

            const storedEntities = ev.mid ? { ...extracted, external_msg_id: ev.mid } : extracted;
            await client.query(
              `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
               VALUES ($1, $2, $3, 'customer', $4, $5, $6::jsonb)`,
              [crypto.randomUUID(), tenantId, conv.id, ev.customerName, ev.text, JSON.stringify(storedEntities)]
            );
            if (ev.mid) newlyProcessedMids.push(ev.mid);

            let leadId: string | null = conv.lead_id ? String(conv.lead_id) : null;
            if ((extracted.phone || extracted.email) && (!bot || bot.auto_extract_contact)) {
              const defaultStatus = routingMode === 'sale_round' ? 'unassigned_pending' : 'marketing_nurture';
              const upserted = await upsertMasterContactInTx(
                client,
                tenantId,
                {
                  name: ev.customerName,
                  phone: extracted.phone || conv.extracted_phone,
                  email: extracted.email || conv.extracted_email,
                },
                { defaultStatus, defaultSource: 'Social (messenger)', dialCode: cfg.default_dial_code }
              );
              leadId = upserted.leadId;
              await client.query(
                'UPDATE mkt_social_conversations SET lead_id = $3, status = $4 WHERE tenant_id = $1 AND id = $2',
                [tenantId, conv.id, leadId, routingMode === 'sale_round' ? 'routed_to_sale' : 'open']
              );

              if (bot?.target_audience_id) {
                const insAud = await client.query(
                  `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
                   VALUES ($1, $2, $3, $4, 'social_bot', '{}'::jsonb)
                   ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
                  [crypto.randomUUID(), tenantId, bot.target_audience_id, leadId]
                );
                if ((insAud.rowCount || 0) > 0) {
                  enteredAudiences.push({ audienceId: String(bot.target_audience_id), leadId });
                }
                await refreshAudienceCachedCount(client, tenantId, String(bot.target_audience_id));
              }

              if (routingMode === 'sale_round') {
                await promoteLeadsToSaleRoundInTx(client, tenantId, [leadId], {
                  roundId: bot?.distribution_round_id ? String(bot.distribution_round_id) : null,
                  actorName: botName,
                  reasonTitle: `Thu thập SĐT/Email tự động từ MESSENGER (${botName})`,
                });
                drainAfterCommit = true;
              }
            }

            if (leadId) engagedLeads.push(leadId);

            let botReply: string | null = null;
            let delivery: Record<string, unknown> | null = null;
            if (botActive && !conv.bot_paused) {
              const rag = await resolveBotReplyInTx(
                client,
                tenantId,
                'messenger',
                ev.text,
                { bot_name: botName, brand_persona: brandPersona, faq_rules: faqRules },
                extracted
              );
              botReply = rag.reply;
              await client.query(
                `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
                 VALUES ($1, $2, $3, 'bot', $4, $5, '{}'::jsonb)`,
                [crypto.randomUUID(), tenantId, conv.id, botName, botReply]
              );
              try {
                const sendRes = await sendMetaMessengerMessage({
                  tenantId,
                  client,
                  pageId: ev.pageId || undefined,
                  recipientPsid: ev.threadId,
                  text: botReply,
                  messagingType: 'RESPONSE',
                });
                delivery = {
                  sent: sendRes.sent,
                  provider: sendRes.provider,
                  external_message_id: sendRes.messageId,
                  ...(sendRes.error ? { error: sendRes.error } : {}),
                };
              } catch (sendErr: any) {
                delivery = {
                  sent: false,
                  provider: 'meta_messenger',
                  error: sendErr?.message || 'META_OUTBOUND_FAILED',
                };
              }
            }

            processed.push({
              conversation_id: String(conv.id),
              lead_id: leadId,
              reply: botReply,
              delivery,
              ...(ev.mid ? { external_msg_id: ev.mid } : {}),
            });
          }
        });
      }

      for (const mid of newlyProcessedMids) {
        markInMemoryInboundProcessed(tenantId, 'messenger', mid);
      }

      if (drainAfterCommit) {
        await runUnassignedLeadDrainer(tenantId).catch(() => {});
      }
      for (const item of enteredAudiences) {
        await emitDomainEvent('audience.entered', {
          tenantId,
          audienceId: item.audienceId,
          audienceName: 'Social Inbound Audience',
          audienceType: 'static_list',
          leadId: item.leadId,
        });
      }
      for (const lid of engagedLeads) {
        await emitDomainEvent('marketing.engaged', {
          tenantId,
          leadId: lid,
          engagementType: 'webhook_received',
          channel: 'social',
          scoreDelta: 10,
        });
      }

      res.status(200).json({ success: true, data: { processed_count: processed.length, items: processed } });
      return;
    }

    // Zalo OA Webhook Envelope (`event_name`, `sender.id`, `message.text`, `message.msg_id`)
    const zaloEventName = String(req.body?.event_name || '').trim().toLowerCase();
    const isZaloOaEnvelope = Boolean(
      zaloEventName &&
        (req.body?.sender ||
          req.body?.follower ||
          req.body?.oa_id ||
          zaloEventName.startsWith('user_') ||
          zaloEventName.startsWith('oa_') ||
          zaloEventName === 'follow' ||
          zaloEventName === 'unfollow')
    );

    if (isZaloOaEnvelope) {
      // Ignore OA echoes, delivery/seen receipts, and unfollow events cleanly with 200 OK
      if (
        zaloEventName.startsWith('oa_send_') ||
        zaloEventName === 'user_seen_message' ||
        zaloEventName === 'user_received_message' ||
        zaloEventName === 'unfollow' ||
        req.body?.is_echo === true
      ) {
        res.status(200).json({ success: true, data: { ignored: true, event_name: zaloEventName } });
        return;
      }

      const senderObj = (req.body?.sender && typeof req.body.sender === 'object' ? req.body.sender : {}) as Record<string, unknown>;
      const followerObj = (req.body?.follower && typeof req.body.follower === 'object' ? req.body.follower : {}) as Record<string, unknown>;
      const msgObj = (req.body?.message && typeof req.body.message === 'object' ? req.body.message : {}) as Record<string, unknown>;

      const senderId = String(senderObj.id || followerObj.id || '').trim();
      const msgId = String(msgObj.msg_id || req.body?.msg_id || '').trim();
      const text = String(msgObj.text || '').trim();
      const customerName = String(senderObj.name || followerObj.name || (senderId ? `Zalo ${senderId.slice(-6)}` : 'Khách Zalo OA')).trim();

      if (!senderId || (!text && zaloEventName !== 'follow')) {
        res.status(200).json({
          success: true,
          data: { ignored: true, event_name: zaloEventName, reason: !senderId ? 'MISSING_SENDER' : 'NON_TEXT_MESSAGE' },
        });
        return;
      }

      if (msgId && isInMemoryInboundDuplicate(tenantId, 'zalo_oa', msgId)) {
        res.status(200).json({ success: true, data: { duplicate: true, skipped: true, msg_id: msgId } });
        return;
      }

      const effectiveText = text || (zaloEventName === 'follow' ? '[Khách hàng quan tâm Zalo OA]' : '');
      let drainAfterCommit = false;
      let enteredAudienceId: string | null = null;

      const zaloOut = await withTenantTransaction(tenantId, async (client) => {
        if (msgId && (await isInboundMessageDuplicateInTx(client, tenantId, 'zalo_oa', msgId))) {
          return { duplicate: true as const, msg_id: msgId };
        }

        const botRes = await client.query('SELECT * FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
        const bot = botRes.rows[0];
        const botName = bot ? String(bot.bot_name || 'DOM Agent CSKH') : 'DOM Agent CSKH';
        const brandPersona = bot ? String(bot.brand_persona || '') : '';
        const faqRules = bot ? parseJsonCol<FaqRuleItemDto[]>(bot.faq_rules_json, []) : [];
        const routingMode = String(bot?.routing_mode || 'audience');
        const botActive = bot ? Boolean(bot.is_active) : true;
        const extracted = extractContactEntitiesFromText(effectiveText);

        await client.query(
          `INSERT INTO mkt_social_conversations (
             id, tenant_id, channel, external_thread_id, customer_name, extracted_phone, extracted_email, last_message_preview, unread_count
           ) VALUES ($1, $2, 'zalo_oa', $3, $4, $5, $6, $7, 1)
           ON CONFLICT (tenant_id, channel, external_thread_id) DO UPDATE SET
             extracted_phone = COALESCE(EXCLUDED.extracted_phone, mkt_social_conversations.extracted_phone),
             extracted_email = COALESCE(EXCLUDED.extracted_email, mkt_social_conversations.extracted_email),
             last_message_preview = EXCLUDED.last_message_preview,
             unread_count = mkt_social_conversations.unread_count + 1,
             last_message_at = clock_timestamp()`,
          [crypto.randomUUID(), tenantId, senderId, customerName, extracted.phone, extracted.email, effectiveText.slice(0, 200)]
        );

        const convRes = await client.query(
          "SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = 'zalo_oa' AND external_thread_id = $2 LIMIT 1",
          [tenantId, senderId]
        );
        const conv = convRes.rows[0];

        const storedEntities = msgId ? { ...extracted, external_msg_id: msgId, event_name: zaloEventName } : { ...extracted, event_name: zaloEventName };
        await client.query(
          `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
           VALUES ($1, $2, $3, 'customer', $4, $5, $6::jsonb)`,
          [crypto.randomUUID(), tenantId, conv.id, customerName, effectiveText, JSON.stringify(storedEntities)]
        );

        let leadId: string | null = conv.lead_id ? String(conv.lead_id) : null;
        if ((extracted.phone || extracted.email) && (!bot || bot.auto_extract_contact)) {
          const defaultStatus = routingMode === 'sale_round' ? 'unassigned_pending' : 'marketing_nurture';
          const upserted = await upsertMasterContactInTx(
            client,
            tenantId,
            {
              name: customerName,
              phone: extracted.phone || conv.extracted_phone,
              email: extracted.email || conv.extracted_email,
            },
            { defaultStatus, defaultSource: 'Social (zalo_oa)', dialCode: cfg.default_dial_code }
          );
          leadId = upserted.leadId;
          await client.query(
            'UPDATE mkt_social_conversations SET lead_id = $3, status = $4 WHERE tenant_id = $1 AND id = $2',
            [tenantId, conv.id, leadId, routingMode === 'sale_round' ? 'routed_to_sale' : 'open']
          );

          if (bot?.target_audience_id) {
            const insAud = await client.query(
              `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
               VALUES ($1, $2, $3, $4, 'social_bot', '{}'::jsonb)
               ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
              [crypto.randomUUID(), tenantId, bot.target_audience_id, leadId]
            );
            if ((insAud.rowCount || 0) > 0) {
              enteredAudienceId = String(bot.target_audience_id);
            }
            await refreshAudienceCachedCount(client, tenantId, String(bot.target_audience_id));
          }

          if (routingMode === 'sale_round') {
            await promoteLeadsToSaleRoundInTx(client, tenantId, [leadId], {
              roundId: bot?.distribution_round_id ? String(bot.distribution_round_id) : null,
              actorName: botName,
              reasonTitle: `Thu thập SĐT/Email tự động từ ZALO_OA (${botName})`,
            });
            drainAfterCommit = true;
          }
        }

        let botReply: string | null = null;
        let matchedQuestion: string | null = null;
        let scenarioId: string | null = null;
        let delivery: Record<string, unknown> | null = null;

        if (botActive && !conv.bot_paused) {
          if (zaloEventName === 'follow') {
            const welcomeRes = await client.query<{ id: string; name: string; nodes_json: unknown; settings_json: unknown }>(
              `SELECT id, name, nodes_json, settings_json
               FROM mkt_automation_scenarios
               WHERE tenant_id = $1 AND is_active = true AND channel IN ('zalo_oa', 'omnichannel') AND trigger_type = 'welcome'
               ORDER BY updated_at DESC LIMIT 1`,
              [tenantId]
            );
            const wRow = welcomeRes.rows[0];
            if (wRow) {
              const wSettings = parseJsonCol<Record<string, unknown>>(wRow.settings_json, {});
              const wNodes = parseJsonCol<Array<Record<string, unknown>>>(wRow.nodes_json, []);
              const wFirstNode = wNodes[0] as Record<string, unknown> | undefined;
              const wNodeCfg = (wFirstNode?.config && typeof wFirstNode.config === 'object' ? wFirstNode.config : {}) as Record<string, unknown>;
              botReply = String(wSettings.content || wNodeCfg.message || bot?.welcome_message || '').trim() || null;
              if (botReply) {
                scenarioId = String(wRow.id);
                matchedQuestion = `scenario:${String(wRow.name)}`;
                await client.query(
                  'UPDATE mkt_automation_scenarios SET matched_count = matched_count + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
                  [tenantId, wRow.id]
                );
              }
            } else if (bot?.welcome_message) {
              botReply = String(bot.welcome_message).trim();
            }
          } else {
            const rag = await resolveBotReplyInTx(
              client,
              tenantId,
              'zalo_oa',
              effectiveText,
              { bot_name: botName, brand_persona: brandPersona, faq_rules: faqRules },
              extracted
            );
            botReply = rag.reply;
            matchedQuestion = rag.matchedQuestion;
            scenarioId = rag.scenarioId;
          }

          if (botReply) {
            await client.query(
              `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
               VALUES ($1, $2, $3, 'bot', $4, $5, '{}'::jsonb)`,
              [crypto.randomUUID(), tenantId, conv.id, botName, botReply]
            );

            if (req.body?.dispatch_outbound !== false) {
              delivery = await dispatchZaloOaCsReply({
                tenantId,
                client,
                recipientUserId: senderId,
                text: botReply,
              });
            }
          }
        }

        return {
          duplicate: false as const,
          conversation_id: String(conv.id),
          channel: 'zalo_oa' as const,
          event_name: zaloEventName,
          msg_id: msgId || null,
          lead_id: leadId,
          bot_paused: Boolean(conv.bot_paused),
          reply: botReply,
          matched_question: matchedQuestion,
          scenario_id: scenarioId,
          extracted,
          ...(delivery ? { delivery } : {}),
        };
      });

      if (zaloOut.duplicate) {
        res.status(200).json({ success: true, data: { duplicate: true, skipped: true, msg_id: zaloOut.msg_id } });
        return;
      }

      if (msgId) markInMemoryInboundProcessed(tenantId, 'zalo_oa', msgId);

      if (drainAfterCommit) {
        await runUnassignedLeadDrainer(tenantId).catch(() => {});
      }
      if (enteredAudienceId && zaloOut.lead_id) {
        await emitDomainEvent('audience.entered', {
          tenantId,
          audienceId: enteredAudienceId,
          audienceName: 'Social Inbound Audience',
          audienceType: 'static_list',
          leadId: zaloOut.lead_id,
        });
      }
      if (zaloOut.lead_id) {
        await emitDomainEvent('marketing.engaged', {
          tenantId,
          leadId: zaloOut.lead_id,
          engagementType: 'webhook_received',
          channel: 'social',
          scoreDelta: 10,
        });
      }

      res.status(200).json({ success: true, data: zaloOut });
      return;
    }

    if (req.body?.is_echo === true) {
      res.status(200).json({ success: true, data: { ignored: true, reason: 'ECHO_MESSAGE' } });
      return;
    }

    const rawChannel = String(req.body?.channel || '').trim();
    const channel: 'zalo_oa' | 'web_chat' | 'messenger' =
      rawChannel === 'zalo_oa' ? 'zalo_oa' : rawChannel === 'web_chat' ? 'web_chat' : 'messenger';
    const threadId = String(
      req.body?.thread_id ||
        req.body?.external_thread_id ||
        req.body?.visitor_id ||
        `ext_${crypto.randomBytes(4).toString('hex')}`
    ).trim();
    const customerName = String(req.body?.customer_name || 'Khách hàng Chat').trim();
    const text = String(req.body?.message || req.body?.text || '').trim();
    const externalMsgId = String(req.body?.mid || req.body?.msg_id || req.body?.external_msg_id || '').trim();
    if (!text) {
      sendApiError(res, 422, 'MESSAGE_REQUIRED', 'Nội dung tin nhắn trống.');
      return;
    }

    if (externalMsgId && isInMemoryInboundDuplicate(tenantId, channel, externalMsgId)) {
      res.status(200).json({ success: true, data: { duplicate: true, skipped: true, external_msg_id: externalMsgId } });
      return;
    }

    let drainAfterCommit = false;
    let enteredAudienceId: string | null = null;
    const out = await withTenantTransaction(tenantId, async (client) => {
      if (externalMsgId && (await isInboundMessageDuplicateInTx(client, tenantId, channel, externalMsgId))) {
        return { duplicate: true as const, external_msg_id: externalMsgId };
      }

      const botRes = await client.query('SELECT * FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
      const bot = botRes.rows[0];
      const botName = bot ? String(bot.bot_name || 'DOM Agent CSKH') : 'DOM Agent CSKH';
      const brandPersona = bot ? String(bot.brand_persona || '') : '';
      const faqRules = bot ? parseJsonCol<FaqRuleItemDto[]>(bot.faq_rules_json, []) : [];
      const routingMode = String(bot?.routing_mode || 'audience');
      const botActive = bot ? Boolean(bot.is_active) : true;
      const extracted = extractContactEntitiesFromText(text);

      await client.query(
        `INSERT INTO mkt_social_conversations (
           id, tenant_id, channel, external_thread_id, customer_name, extracted_phone, extracted_email, last_message_preview, unread_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
         ON CONFLICT (tenant_id, channel, external_thread_id) DO UPDATE SET
           extracted_phone = COALESCE(EXCLUDED.extracted_phone, mkt_social_conversations.extracted_phone),
           extracted_email = COALESCE(EXCLUDED.extracted_email, mkt_social_conversations.extracted_email),
           last_message_preview = EXCLUDED.last_message_preview,
           unread_count = mkt_social_conversations.unread_count + 1,
           last_message_at = clock_timestamp()`,
        [
          crypto.randomUUID(),
          tenantId,
          channel,
          threadId,
          customerName,
          extracted.phone,
          extracted.email,
          text.slice(0, 200),
        ]
      );

      const convRes = await client.query(
        'SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = $2 AND external_thread_id = $3 LIMIT 1',
        [tenantId, channel, threadId]
      );
      const conv = convRes.rows[0];

      const storedEntities = externalMsgId ? { ...extracted, external_msg_id: externalMsgId } : extracted;
      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
         VALUES ($1, $2, $3, 'customer', $4, $5, $6::jsonb)`,
        [crypto.randomUUID(), tenantId, conv.id, customerName, text, JSON.stringify(storedEntities)]
      );

      let leadId: string | null = conv.lead_id ? String(conv.lead_id) : null;
      if ((extracted.phone || extracted.email) && (!bot || bot.auto_extract_contact)) {
        const defaultStatus = routingMode === 'sale_round' ? 'unassigned_pending' : 'marketing_nurture';
        const upserted = await upsertMasterContactInTx(
          client,
          tenantId,
          {
            name: customerName,
            phone: extracted.phone || conv.extracted_phone,
            email: extracted.email || conv.extracted_email,
          },
          { defaultStatus, defaultSource: `Social (${channel})`, dialCode: cfg.default_dial_code }
        );
        leadId = upserted.leadId;
        await client.query(
          'UPDATE mkt_social_conversations SET lead_id = $3, status = $4 WHERE tenant_id = $1 AND id = $2',
          [tenantId, conv.id, leadId, routingMode === 'sale_round' ? 'routed_to_sale' : 'open']
        );

        if (bot?.target_audience_id) {
          const insAud = await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'social_bot', '{}'::jsonb)
             ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), tenantId, bot.target_audience_id, leadId]
          );
          if ((insAud.rowCount || 0) > 0) {
            enteredAudienceId = String(bot.target_audience_id);
          }
          await refreshAudienceCachedCount(client, tenantId, String(bot.target_audience_id));
        }

        if (routingMode === 'sale_round') {
          const promoted = await promoteLeadsToSaleRoundInTx(client, tenantId, [leadId], {
            roundId: bot?.distribution_round_id ? String(bot.distribution_round_id) : null,
            actorName: botName,
            reasonTitle: `Thu thập SĐT/Email tự động từ ${channel.toUpperCase()} (${botName})`,
          });
          if (promoted.length > 0 || defaultStatus === 'unassigned_pending') {
            drainAfterCommit = true;
          }
        }
      }

      let botReply: string | null = null;
      let matchedQuestion: string | null = null;
      let scenarioId: string | null = null;
      let delivery: Record<string, unknown> | null = null;
      if (botActive && !conv.bot_paused) {
        const rag = await resolveBotReplyInTx(
          client,
          tenantId,
          channel,
          text,
          { bot_name: botName, brand_persona: brandPersona, faq_rules: faqRules },
          extracted
        );
        botReply = rag.reply;
        matchedQuestion = rag.matchedQuestion;
        scenarioId = rag.scenarioId;

        await client.query(
          `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
           VALUES ($1, $2, $3, 'bot', $4, $5, '{}'::jsonb)`,
          [crypto.randomUUID(), tenantId, conv.id, botName, botReply]
        );

        if (channel === 'messenger' && req.body?.dispatch_outbound !== false) {
          try {
            const sendRes = await sendMetaMessengerMessage({
              tenantId,
              client,
              recipientPsid: threadId,
              text: botReply,
              messagingType: 'RESPONSE',
            });
            delivery = {
              sent: sendRes.sent,
              provider: sendRes.provider,
              external_message_id: sendRes.messageId,
              ...(sendRes.error ? { error: sendRes.error } : {}),
            };
          } catch (sendErr: any) {
            delivery = {
              sent: false,
              provider: 'meta_messenger',
              error: sendErr?.message || 'META_OUTBOUND_FAILED',
            };
          }
        } else if (channel === 'zalo_oa' && req.body?.dispatch_outbound !== false) {
          delivery = await dispatchZaloOaCsReply({
            tenantId,
            client,
            recipientUserId: threadId,
            text: botReply,
          });
        }
      }

      return {
        duplicate: false as const,
        conversation_id: String(conv.id),
        channel,
        lead_id: leadId,
        bot_paused: Boolean(conv.bot_paused),
        reply: botReply,
        matched_question: matchedQuestion,
        scenario_id: scenarioId,
        extracted,
        ...(externalMsgId ? { external_msg_id: externalMsgId } : {}),
        ...(delivery ? { delivery } : {}),
      };
    });

    if (out.duplicate) {
      res.status(200).json({ success: true, data: { duplicate: true, skipped: true, external_msg_id: out.external_msg_id } });
      return;
    }

    if (externalMsgId) markInMemoryInboundProcessed(tenantId, channel, externalMsgId);

    if (drainAfterCommit) {
      await runUnassignedLeadDrainer(tenantId).catch(() => {});
    }
    if (enteredAudienceId && out.lead_id) {
      await emitDomainEvent('audience.entered', {
        tenantId,
        audienceId: enteredAudienceId,
        audienceName: 'Social Inbound Audience',
        audienceType: 'static_list',
        leadId: out.lead_id,
      });
    }
    if (out.lead_id) {
      await emitDomainEvent('marketing.engaged', {
        tenantId,
        leadId: out.lead_id,
        engagementType: 'webhook_received',
        channel: 'social',
        scoreDelta: 10,
      });
    }

    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'SOCIAL_INBOUND_WEBHOOK_FAILED', err?.message || 'Không thể xử lý Webhook Social.');
  }
});

export default router;
