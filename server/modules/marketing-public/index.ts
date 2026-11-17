import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { APP_CONFIG } from '../../config.ts';
import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import { sendApiError } from '../../core/security/rbac.ts';
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
  generateShortCode,
  hashOtpCode,
  parseJsonCol,
  verifyUnsubscribeHmac,
} from '../marketing/utils.ts';
import type { FormFieldSchemaDto } from '../marketing/forms.routes.ts';
import type { SurveyBlockItemDto } from '../marketing/surveys.routes.ts';
import {
  extractContactEntitiesFromText,
  generateBotReplyFromRag,
  type FaqRuleItemDto,
} from '../marketing/social-bot.routes.ts';

export const router = Router();

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

router.post('/forms/:token/submit', async (req, res) => {
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
      body.values && typeof body.values === 'object' ? { ...body.values } : { ...body };

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

      // Verify OTP if required by form
      let otpVerified = false;
      if (form.require_otp) {
        const recipient = form.otp_channel === 'sms' ? phoneVal : emailVal || phoneVal;
        const otpId = String(body.otp_id || rawValues.otp_id || '').trim();
        const otpCode = String(body.otp_code || rawValues.otp_code || '').trim();

        let otpOk = false;
        if (otpId) {
          const vRes = await client.query<{ verified: boolean }>(
            'SELECT verified FROM mkt_otp_verifications WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [resolved.tenant_id, otpId]
          );
          otpOk = Boolean(vRes.rows[0]?.verified);
        } else if (otpCode && recipient) {
          const expectedHash = hashOtpCode(resolved.tenant_id, recipient, otpCode);
          const vRes = await client.query<{ id: string; expires_at: string }>(
            `SELECT id, expires_at FROM mkt_otp_verifications
             WHERE tenant_id = $1 AND LOWER(recipient) = $2 AND code_hash = $3
             ORDER BY created_at DESC LIMIT 1`,
            [resolved.tenant_id, recipient.toLowerCase(), expectedHash]
          );
          if (vRes.rows[0] && new Date(String(vRes.rows[0].expires_at)).getTime() >= Date.now()) {
            otpOk = true;
            await client.query(
              'UPDATE mkt_otp_verifications SET verified = true, verified_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
              [resolved.tenant_id, vRes.rows[0].id]
            );
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
      if (form.target_audience_id) {
        await client.query(
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
router.post('/otp/send', async (req, res) => {
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

    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_otp_verifications (id, tenant_id, channel, recipient, purpose, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [otpId, tenantId, channel, recipient.toLowerCase(), purpose, codeHash, expiresAt]
      );
    });

    const responseData: Record<string, unknown> = {
      otp_id: otpId,
      channel,
      recipient,
      expires_in_seconds: 300,
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
        const r = await client.query('SELECT * FROM mkt_otp_verifications WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          tenantId,
          otpId,
        ]);
        row = r.rows[0];
      } else if (recipient) {
        const r = await client.query(
          `SELECT * FROM mkt_otp_verifications
           WHERE tenant_id = $1 AND LOWER(recipient) = $2
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId, recipient.toLowerCase()]
        );
        row = r.rows[0];
      }

      if (!row) return { ok: false, reason: 'OTP_NOT_FOUND' };
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

router.post('/surveys/:slug', async (req, res) => {
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

      const redirectRules = parseJsonCol<Array<Record<string, unknown>>>(
        survey.redirect_rules_json,
        Array.isArray(settings.redirect_rules) ? (settings.redirect_rules as Array<Record<string, unknown>>) : []
      );
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
      await client.query(
        `INSERT INTO mkt_short_link_clicks (id, tenant_id, short_link_id, lead_id, referrer, device_type, client_ip, utm_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          crypto.randomUUID(),
          resolved.tenant_id,
          link.id,
          validLeadId,
          req.headers.referer ? String(req.headers.referer) : null,
          device,
          clientIp || null,
          JSON.stringify({
            utm_source: link.utm_source || req.query.utm_source || null,
            utm_medium: link.utm_medium || req.query.utm_medium || null,
            utm_campaign: link.utm_campaign || req.query.utm_campaign || null,
          }),
        ]
      );

      await client.query(
        `UPDATE mkt_short_links
         SET click_count = click_count + 1,
             unique_click_count = unique_click_count + 1,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [resolved.tenant_id, link.id]
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

      return { targetUrl: finalUrl.toString(), validLeadId };
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
            await client.query(
              `UPDATE mkt_send_claims
               SET status = CASE WHEN status = 'clicked' THEN 'clicked' ELSE 'opened' END,
                   opened_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [resolved, claimId]
            );
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
          }
          return { leadId: String(cl.lead_id), campaignId: String(cl.campaign_id) };
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
  const targetUrl = String(req.query.url || 'https://domation.net').trim();
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

          if (!cl.clicked_at) {
            await client.query(
              `UPDATE mkt_send_claims
               SET status = 'clicked',
                   opened_at = COALESCE(opened_at, clock_timestamp()),
                   clicked_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [resolved, claimId]
            );
            await client.query(
              `UPDATE mkt_campaigns
               SET clicked_count = clicked_count + 1,
                   opened_count = opened_count + $3
               WHERE tenant_id = $1 AND id = $2`,
              [resolved, cl.campaign_id, !cl.opened_at ? 1 : 0]
            );
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
          }
          return { leadId: String(cl.lead_id), campaignId: String(cl.campaign_id) };
        });

        if (evtInfo) {
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

      const recipient = channel === 'zns' ? lead.phone : lead.email?.toLowerCase();
      if (recipient) {
        await client.query(
          `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
           VALUES ($1, $2, $3, $4, 'unsubscribed')
           ON CONFLICT (tenant_id, channel, recipient) DO UPDATE SET reason = 'unsubscribed'`,
          [crypto.randomUUID(), tenantId, channel, recipient]
        );
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
router.get('/sdk.js', (req, res) => {
  const siteKey = String(req.query.site_key || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const js = `(function(w,d){
  var cfg = w.DOMATION_TRACKER_CONFIG || {};
  var siteKey = cfg.siteKey || "${siteKey}";
  var endpoint = cfg.endpoint || "/api/v1/public/marketing/track";
  var vKey = "dom_vid_" + siteKey;
  var vid = localStorage.getItem(vKey);
  if (!vid) { vid = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(vKey, vid); }
  function send(type, extra) {
    var payload = Object.assign({ site_key: siteKey, visitor_token: vid, event_type: type, page_url: location.href, referrer: d.referrer }, extra || {});
    fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: true }).catch(function(){});
  }
  send("pageview");
  d.addEventListener("click", function(e) {
    var x = Math.round((e.clientX / Math.max(1, w.innerWidth)) * 1000) / 10;
    var y = Math.round(((e.clientY + w.scrollY) / Math.max(1, d.documentElement.scrollHeight)) * 1000) / 10;
    send("click", { x_pct: x, y_pct: y, element_selector: (e.target && e.target.tagName) || "BODY" });
  }, { passive: true });
  w.DomationTracker = { track: send, identify: function(info) { send("identify", info); } };
})(window, document);`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(js);
});

router.post('/track', async (req, res) => {
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
    const visitorToken = String(req.body?.visitor_token || `anon_${crypto.randomBytes(6).toString('hex')}`).trim();
    const pageUrl = String(req.body?.page_url || 'https://domation.net/').trim();
    const eventType = String(req.body?.event_type || 'pageview').trim();
    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    const deviceType = String(req.body?.device_type || (/mobile|iphone|android/.test(ua) ? 'mobile' : 'desktop'));

    const outcome = await withTenantTransaction(propLookup.tenant_id, async (client) => {
      const pRes = await client.query(
        'SELECT * FROM mkt_web_properties WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [propLookup!.tenant_id, propLookup!.property_id]
      );
      const prop = pRes.rows[0];

      // Visitor-to-Lead Identity Stitching if phone or email is passed
      let stitchedLeadId: string | null = null;
      if (req.body?.phone || req.body?.email) {
        const upserted = await upsertMasterContactInTx(
          client,
          propLookup!.tenant_id,
          {
            name: req.body?.name,
            phone: req.body?.phone,
            email: req.body?.email,
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
        eventType === 'pricing_intent' || patterns.some((pat) => pat && pageLower.includes(pat));

      const sessCandidateId = crypto.randomUUID();
      const pageviewDelta = eventType === 'pageview' ? 1 : 0;
      await client.query(
        `INSERT INTO mkt_web_sessions (
           id, tenant_id, property_id, visitor_token, lead_id, entry_url, last_url,
           referrer, utm_source, utm_medium, utm_campaign, device_type, pageviews_count, pricing_intent_detected
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, 1, $12)
         ON CONFLICT (tenant_id, property_id, visitor_token) DO UPDATE SET
           lead_id = COALESCE(EXCLUDED.lead_id, mkt_web_sessions.lead_id),
           last_url = EXCLUDED.last_url,
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
          req.body?.utm_source ? String(req.body.utm_source) : null,
          req.body?.utm_medium ? String(req.body.utm_medium) : null,
          req.body?.utm_campaign ? String(req.body.utm_campaign) : null,
          deviceType,
          isPricingIntent,
          pageviewDelta,
        ]
      );

      const sessRes = await client.query<{ id: string; lead_id: string | null }>(
        `SELECT id, lead_id FROM mkt_web_sessions
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
      const scrollDepth =
        req.body?.scroll_depth_pct !== undefined
          ? Math.min(100, Math.max(0, Math.round(Number(req.body.scroll_depth_pct))))
          : null;

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
          req.body?.element_selector ? String(req.body.element_selector).slice(0, 255) : null,
          xPct,
          yPct,
          scrollDepth,
          JSON.stringify(req.body?.metadata || {}),
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
      };
    });

    if (outcome.lead_id) {
      await emitDomainEvent('marketing.engaged', {
        tenantId: propLookup.tenant_id,
        leadId: outcome.lead_id,
        engagementType: outcome.pricing_intent_detected ? 'pricing_intent' : 'page_visited',
        channel: 'web',
        scoreDelta: outcome.pricing_intent_detected ? 15 : 2,
        metadata: { pageUrl, pricingIntent: outcome.pricing_intent_detected },
      });
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

      // Find an available code or mint one on demand
      const availRes = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM mkt_voucher_codes
         WHERE tenant_id = $1 AND voucher_campaign_id = $2 AND status = 'available'
         ORDER BY created_at ASC LIMIT 1`,
        [resolved.tenant_id, pool.id]
      );

      let claimedCode = availRes.rows[0]?.code || '';
      if (availRes.rows[0]) {
        await client.query(
          `UPDATE mkt_voucher_codes
           SET status = 'claimed', lead_id = $3, claimed_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [resolved.tenant_id, availRes.rows[0].id, upserted.leadId]
        );
        await client.query(
          'UPDATE mkt_voucher_campaigns SET claimed_codes = claimed_codes + 1 WHERE tenant_id = $1 AND id = $2',
          [resolved.tenant_id, pool.id]
        );
      } else {
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

      return { code: claimedCode, lead_id: upserted.leadId, pool_name: String(pool.name) };
    });

    await emitDomainEvent('marketing.engaged', {
      tenantId: resolved.tenant_id,
      leadId: out.lead_id,
      engagementType: 'voucher_claimed',
      channel: 'voucher',
      scoreDelta: 10,
      metadata: { code: out.code },
    });

    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'CLAIM_VOUCHER_FAILED', err?.message || 'Không thể nhận mã ưu đãi.');
  }
});

router.post('/social/inbound/:tenantSlug', async (req, res) => {
  try {
    const slug = String(req.params.tenantSlug || '').trim().toLowerCase();
    const tenantId = await withSystemPrivilege(async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE (slug = $1 OR obfuscated_slug = $1) AND status != 'deleted' LIMIT 1`,
        [slug]
      );
      return r.rows[0]?.id || null;
    });

    if (!tenantId) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
      return;
    }

    const cfg = await getTenantSettingsCached(tenantId);
    const channel = req.body?.channel === 'zalo_oa' ? 'zalo_oa' : 'messenger';
    const threadId = String(req.body?.thread_id || `ext_${crypto.randomBytes(4).toString('hex')}`).trim();
    const customerName = String(req.body?.customer_name || 'Khách hàng Chat').trim();
    const text = String(req.body?.message || req.body?.text || '').trim();
    if (!text) {
      sendApiError(res, 422, 'MESSAGE_REQUIRED', 'Nội dung tin nhắn trống.');
      return;
    }

    const out = await withTenantTransaction(tenantId, async (client) => {
      const botRes = await client.query('SELECT * FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [tenantId]);
      const bot = botRes.rows[0];
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

      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
         VALUES ($1, $2, $3, 'customer', $4, $5, $6::jsonb)`,
        [crypto.randomUUID(), tenantId, conv.id, customerName, text, JSON.stringify(extracted)]
      );

      let leadId: string | null = conv.lead_id ? String(conv.lead_id) : null;
      if ((extracted.phone || extracted.email) && (!bot || bot.auto_extract_contact)) {
        const upserted = await upsertMasterContactInTx(
          client,
          tenantId,
          { name: customerName, phone: extracted.phone, email: extracted.email },
          { defaultStatus: 'marketing_nurture', defaultSource: `Social (${channel})`, dialCode: cfg.default_dial_code }
        );
        leadId = upserted.leadId;
        await client.query('UPDATE mkt_social_conversations SET lead_id = $3 WHERE tenant_id = $1 AND id = $2', [
          tenantId,
          conv.id,
          leadId,
        ]);
      }

      const faqRules = bot ? parseJsonCol<FaqRuleItemDto[]>(bot.faq_rules_json, []) : [];
      const rag = generateBotReplyFromRag(
        text,
        bot ? String(bot.bot_name) : 'DOM Agent CSKH',
        bot ? String(bot.brand_persona || '') : '',
        faqRules,
        extracted
      );

      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
         VALUES ($1, $2, $3, 'bot', $4, $5, '{}'::jsonb)`,
        [crypto.randomUUID(), tenantId, conv.id, bot ? String(bot.bot_name) : 'DOM Agent CSKH', rag.reply]
      );

      return { conversation_id: String(conv.id), lead_id: leadId, reply: rag.reply, extracted };
    });

    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'SOCIAL_INBOUND_WEBHOOK_FAILED', err?.message || 'Không thể xử lý Webhook Social.');
  }
});

export default router;
