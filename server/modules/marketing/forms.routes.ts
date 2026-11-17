import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import { upsertMasterContactInTx } from '../audiences/audiences.service.ts';
import {
  canUserUnmaskMarketingPii,
  generatePublicToken,
  parseJsonCol,
  slugifyMarketingKey,
} from './utils.ts';

export const formsRouter = Router();

formsRouter.use(requireEntitlement('mkt_forms'));

export interface FormFieldSchemaDto {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'phone' | 'email' | 'select' | 'textarea' | 'number' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

function mapFormRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name || ''),
    description: row.description ? String(row.description) : '',
    public_token: String(row.public_token || ''),
    status: String(row.status || 'active'),
    routing_mode: String(row.routing_mode || 'marketing_nurture') as 'marketing_nurture' | 'sale_round',
    target_audience_id: row.target_audience_id ? String(row.target_audience_id) : null,
    target_audience_name: row.target_audience_name ? String(row.target_audience_name) : null,
    distribution_round_id: row.distribution_round_id ? String(row.distribution_round_id) : null,
    distribution_round_name: row.distribution_round_name ? String(row.distribution_round_name) : null,
    require_otp: Boolean(row.require_otp),
    otp_channel: String(row.otp_channel || 'email') as 'email' | 'sms',
    fields: parseJsonCol<FormFieldSchemaDto[]>(row.fields_json, []),
    theme: parseJsonCol<Record<string, unknown>>(row.theme_json, {}),
    thank_you: parseJsonCol<Record<string, unknown>>(row.thank_you_json, {}),
    submission_count: Number(row.submission_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// OTPTriggersTab: OTP Rate-Limit & Verification Audit Inspector
formsRouter.get('/otp/audit', requirePermission('mkt_forms', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const [rowsRes, statsRes] = await Promise.all([
        client.query(
          `SELECT id, channel, recipient, purpose, attempts, verified, expires_at, verified_at, created_at
           FROM mkt_otp_verifications
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 150`,
          [ctx.tenantId]
        ),
        client.query<{
          total_sent: number;
          verified_cnt: number;
          email_cnt: number;
          sms_cnt: number;
          blocked_cnt: number;
        }>(
          `SELECT COUNT(*)::int AS total_sent,
                  COALESCE(SUM(CASE WHEN verified = true THEN 1 ELSE 0 END), 0)::int AS verified_cnt,
                  COALESCE(SUM(CASE WHEN channel = 'email' THEN 1 ELSE 0 END), 0)::int AS email_cnt,
                  COALESCE(SUM(CASE WHEN channel = 'sms' THEN 1 ELSE 0 END), 0)::int AS sms_cnt,
                  COALESCE(SUM(CASE WHEN attempts >= 5 THEN 1 ELSE 0 END), 0)::int AS blocked_cnt
           FROM mkt_otp_verifications
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
      ]);

      const nowMs = Date.now();
      const logs = rowsRes.rows.map((r) => {
        const rec = String(r.recipient || '');
        const isEmail = rec.includes('@');
        const masked = maskContactPiiIfDisallowed(
          { phone: isEmail ? null : rec, email: isEmail ? rec : null },
          canUnmask,
          cfg
        );
        const expired = !r.verified && new Date(String(r.expires_at)).getTime() < nowMs;
        const blocked = Number(r.attempts || 0) >= 5;
        return {
          ...r,
          recipient: isEmail ? masked.email || rec : masked.phone || rec,
          audit_status: r.verified ? 'verified' : blocked ? 'rate_limited' : expired ? 'expired' : 'pending',
        };
      });

      const st = statsRes.rows[0];
      const totalSent = Number(st?.total_sent || 0);
      const verifiedCnt = Number(st?.verified_cnt || 0);

      return {
        policy: {
          max_attempts: 5,
          ttl_seconds: 300,
          hash_algorithm: 'HMAC-SHA256',
        },
        summary: {
          total_sent: totalSent,
          verified_count: verifiedCnt,
          verification_rate_pct: totalSent > 0 ? Number(((verifiedCnt / totalSent) * 100).toFixed(1)) : 0,
          email_count: Number(st?.email_cnt || 0),
          sms_count: Number(st?.sms_cnt || 0),
          rate_limited_count: Number(st?.blocked_cnt || 0),
        },
        logs,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'OTP_AUDIT_FAILED', err?.message || 'Không thể tải nhật ký kiểm toán OTP.');
  }
});

// List Forms + Audiences + Sale Rounds + Custom/Purchase Events + OTP stats
formsRouter.get('/', requirePermission('mkt_forms', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [formsRes, audRes, roundsRes, eventsRes, otpStatsRes] = await Promise.all([
        client.query(
          `SELECT f.*,
                  a.name AS target_audience_name,
                  r.name AS distribution_round_name
           FROM mkt_forms f
           LEFT JOIN tenant_audiences a ON a.tenant_id = f.tenant_id AND a.id = f.target_audience_id
           LEFT JOIN distribution_rounds r ON r.tenant_id = f.tenant_id AND r.id = f.distribution_round_id
           WHERE f.tenant_id = $1 AND f.status != 'archived'
           ORDER BY f.created_at DESC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, audience_type, cached_member_count
           FROM tenant_audiences
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, pipeline_id
           FROM distribution_rounds
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY priority ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT * FROM mkt_custom_events
           WHERE tenant_id = $1
           ORDER BY created_at DESC`,
          [ctx.tenantId]
        ),
        client.query<{ total_sent: number; verified_cnt: number }>(
          `SELECT COUNT(*)::int AS total_sent,
                  COALESCE(SUM(CASE WHEN verified = true THEN 1 ELSE 0 END), 0)::int AS verified_cnt
           FROM mkt_otp_verifications
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
      ]);

      return {
        items: formsRes.rows.map(mapFormRow),
        audiences: audRes.rows,
        rounds: roundsRes.rows,
        events: eventsRes.rows.map((ev) => ({
          ...ev,
          schema_json: parseJsonCol(ev.schema_json, {}),
          total_revenue_vnd: Number(ev.total_revenue_vnd || 0),
          trigger_count: Number(ev.trigger_count || 0),
        })),
        otp_summary: {
          total_sent: Number(otpStatsRes.rows[0]?.total_sent || 0),
          verified_count: Number(otpStatsRes.rows[0]?.verified_cnt || 0),
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_FORMS_FAILED', err?.message || 'Không thể tải danh sách Form & Triggers.');
  }
});

// Create Form (supports Phone-only, Email-only, or Multi-field — never forces Email if Phone is present)
formsRouter.post('/', requirePermission('mkt_forms', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'FORM_NAME_REQUIRED', 'Vui lòng nhập tên Biểu mẫu (Form).');
      return;
    }

    const rawFields: FormFieldSchemaDto[] = Array.isArray(req.body?.fields) && req.body.fields.length > 0
      ? req.body.fields
      : [
          { id: 'f_name', key: 'name', label: 'Họ và tên', type: 'text', required: true, placeholder: 'Nguyễn Văn A' },
          { id: 'f_phone', key: 'phone', label: 'Số điện thoại', type: 'phone', required: true, placeholder: '0909...' },
        ];

    const hasContactField = rawFields.some(
      (f) => f.key === 'phone' || f.type === 'phone' || f.key === 'email' || f.type === 'email'
    );
    if (!hasContactField) {
      sendApiError(
        res,
        422,
        'FORM_CONTACT_FIELD_REQUIRED',
        'Form cần ít nhất 1 trường Số điện thoại hoặc Email để định danh khách hàng (không bắt buộc phải có cả hai).'
      );
      return;
    }

    const routingMode = req.body?.routing_mode === 'sale_round' ? 'sale_round' : 'marketing_nurture';
    const targetAudienceId = req.body?.target_audience_id ? String(req.body.target_audience_id) : null;
    const distributionRoundId = req.body?.distribution_round_id ? String(req.body.distribution_round_id) : null;
    const requireOtp = Boolean(req.body?.require_otp);
    const otpChannel = req.body?.otp_channel === 'sms' ? 'sms' : 'email';
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const theme = req.body?.theme && typeof req.body.theme === 'object'
      ? req.body.theme
      : { primaryColor: '#1E40FF', buttonLabel: 'Đăng ký ngay', layout: 'card' };
    const thankYou = req.body?.thank_you && typeof req.body.thank_you === 'object'
      ? req.body.thank_you
      : { title: 'Cảm ơn bạn đã đăng ký!', message: 'Thông tin đã được ghi nhận thành công.' };

    const id = crypto.randomUUID();
    const publicToken = generatePublicToken('frm');

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_forms (
           id, tenant_id, name, description, public_token, status, routing_mode,
           target_audience_id, distribution_round_id, require_otp, otp_channel,
           fields_json, theme_json, thank_you_json, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, 'active', $6,
           $7, $8, $9, $10,
           $11::jsonb, $12::jsonb, $13::jsonb, $14
         )`,
        [
          id,
          ctx.tenantId,
          name,
          description,
          publicToken,
          routingMode,
          targetAudienceId,
          distributionRoundId,
          requireOtp,
          otpChannel,
          JSON.stringify(rawFields),
          JSON.stringify(theme),
          JSON.stringify(thankYou),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_forms WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return mapFormRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_FORM_FAILED', err?.message || 'Không thể tạo Biểu mẫu mới.');
  }
});

// Update Form
formsRouter.put('/:id', requirePermission('mkt_forms', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query('SELECT * FROM mkt_forms WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(ex.name);
      const description =
        req.body?.description !== undefined ? String(req.body.description).trim() : ex.description;
      const status = req.body?.status !== undefined ? String(req.body.status) : String(ex.status);
      const routingMode =
        req.body?.routing_mode !== undefined
          ? req.body.routing_mode === 'sale_round'
            ? 'sale_round'
            : 'marketing_nurture'
          : String(ex.routing_mode);
      const targetAudienceId =
        req.body?.target_audience_id !== undefined
          ? req.body.target_audience_id
            ? String(req.body.target_audience_id)
            : null
          : ex.target_audience_id;
      const distributionRoundId =
        req.body?.distribution_round_id !== undefined
          ? req.body.distribution_round_id
            ? String(req.body.distribution_round_id)
            : null
          : ex.distribution_round_id;
      const requireOtp =
        req.body?.require_otp !== undefined ? Boolean(req.body.require_otp) : Boolean(ex.require_otp);
      const otpChannel =
        req.body?.otp_channel !== undefined
          ? req.body.otp_channel === 'sms'
            ? 'sms'
            : 'email'
          : String(ex.otp_channel || 'email');
      const fields = Array.isArray(req.body?.fields)
        ? req.body.fields
        : parseJsonCol(ex.fields_json, []);
      const theme =
        req.body?.theme && typeof req.body.theme === 'object'
          ? req.body.theme
          : parseJsonCol(ex.theme_json, {});
      const thankYou =
        req.body?.thank_you && typeof req.body.thank_you === 'object'
          ? req.body.thank_you
          : parseJsonCol(ex.thank_you_json, {});

      await client.query(
        `UPDATE mkt_forms
         SET name = $3,
             description = $4,
             status = $5,
             routing_mode = $6,
             target_audience_id = $7,
             distribution_round_id = $8,
             require_otp = $9,
             otp_channel = $10,
             fields_json = $11::jsonb,
             theme_json = $12::jsonb,
             thank_you_json = $13::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          description,
          status,
          routingMode,
          targetAudienceId,
          distributionRoundId,
          requireOtp,
          otpChannel,
          JSON.stringify(fields),
          JSON.stringify(theme),
          JSON.stringify(thankYou),
        ]
      );

      const r = await client.query('SELECT * FROM mkt_forms WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return mapFormRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'FORM_NOT_FOUND', 'Không tìm thấy Biểu mẫu.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_FORM_FAILED', err?.message || 'Không thể cập nhật Biểu mẫu.');
  }
});

formsRouter.delete('/:id', requirePermission('mkt_forms', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const count = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM mkt_forms WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rowCount;
    });
    if (!count) {
      sendApiError(res, 404, 'FORM_NOT_FOUND', 'Không tìm thấy Biểu mẫu cần xóa.');
      return;
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_FORM_FAILED', err?.message || 'Không thể xóa Biểu mẫu.');
  }
});

// List Submissions for a Form (with Server PII Masking)
formsRouter.get('/:id/submissions', requirePermission('mkt_forms', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const r = await client.query(
        `SELECT s.id, s.form_id, s.lead_id, s.routing_mode, s.submitted_data, s.utm_data, s.otp_verified, s.created_at,
                l.name, l.phone, l.email, l.status AS lead_status
         FROM mkt_form_submissions s
         LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
         WHERE s.tenant_id = $1 AND s.form_id = $2
         ORDER BY s.created_at DESC
         LIMIT 100`,
        [ctx.tenantId, req.params.id]
      );

      return r.rows.map((row) => {
        const masked = maskContactPiiIfDisallowed(row, canUnmask, cfg);
        return {
          ...masked,
          submitted_data: parseJsonCol(row.submitted_data, {}),
          utm_data: parseJsonCol(row.utm_data, {}),
        };
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SUBMISSIONS_FAILED', err?.message || 'Không thể tải danh sách lượt điền Form.');
  }
});

// Custom & Purchase Event Definitions
formsRouter.post('/events', requirePermission('mkt_forms', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const eventName = String(req.body?.event_name || '').trim();
    if (!eventName) {
      sendApiError(res, 422, 'EVENT_NAME_REQUIRED', 'Vui lòng nhập tên sự kiện Trigger.');
      return;
    }
    const eventCategory =
      req.body?.event_category === 'purchase'
        ? 'purchase'
        : req.body?.event_category === 'otp'
          ? 'otp'
          : 'custom';
    const rawKey = String(req.body?.event_key || slugifyMarketingKey(eventName, 'evt')).replace(/-/g, '_');
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const schemaJson = req.body?.schema_json && typeof req.body.schema_json === 'object' ? req.body.schema_json : {};

    const id = crypto.randomUUID();
    const secret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_custom_events (id, tenant_id, event_key, event_name, event_category, description, schema_json, webhook_secret, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (tenant_id, event_key) DO UPDATE SET
           event_name = EXCLUDED.event_name,
           description = EXCLUDED.description,
           updated_at = clock_timestamp()`,
        [id, ctx.tenantId, rawKey, eventName, eventCategory, description, JSON.stringify(schemaJson), secret, ctx.userId]
      );
      const r = await client.query(
        'SELECT * FROM mkt_custom_events WHERE tenant_id = $1 AND event_key = $2 LIMIT 1',
        [ctx.tenantId, rawKey]
      );
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CUSTOM_EVENT_FAILED', err?.message || 'Không thể tạo định nghĩa sự kiện.');
  }
});

// CustomEventDetailModal & PurchaseEventDetailModal Inspector + Webhook Secret Rotation
formsRouter.get('/events/:id', requirePermission('mkt_forms', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const evRes = await client.query('SELECT * FROM mkt_custom_events WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ev = evRes.rows[0];
      if (!ev) return null;

      let webhookSecret = ev.webhook_secret ? String(ev.webhook_secret) : '';
      if (!webhookSecret) {
        webhookSecret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
        await client.query(
          'UPDATE mkt_custom_events SET webhook_secret = $3 WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, ev.id, webhookSecret]
        );
      }

      const logsRes = await client.query(
        `SELECT id, lead_id, event_type, title, content, metadata, created_at
         FROM lead_timeline_events
         WHERE tenant_id = $1 AND event_type IN ('custom_event', 'purchase_event')
         ORDER BY created_at DESC
         LIMIT 50`,
        [ctx.tenantId]
      );

      const matchedLogs = logsRes.rows
        .map((r) => ({ ...r, metadata: parseJsonCol<Record<string, unknown>>(r.metadata, {}) }))
        .filter((r) => !r.metadata.event_key || r.metadata.event_key === ev.event_key);

      return {
        event: {
          ...ev,
          schema_json: parseJsonCol(ev.schema_json, {}),
          webhook_secret: webhookSecret,
          total_revenue_vnd: Number(ev.total_revenue_vnd || 0),
          trigger_count: Number(ev.trigger_count || 0),
        },
        recent_triggers: matchedLogs.slice(0, 25),
      };
    });

    if (!data) {
      sendApiError(res, 404, 'EVENT_NOT_FOUND', 'Không tìm thấy định nghĩa sự kiện.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_EVENT_DETAIL_FAILED', err?.message || 'Không thể tải chi tiết sự kiện.');
  }
});

formsRouter.post('/events/:id/rotate-secret', requirePermission('mkt_forms', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const newSecret = `whsec_${crypto.randomBytes(18).toString('hex')}`;
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE mkt_custom_events
         SET webhook_secret = $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, newSecret]
      );
      return r.rowCount ? newSecret : null;
    });
    if (!updated) {
      sendApiError(res, 404, 'EVENT_NOT_FOUND', 'Không tìm thấy định nghĩa sự kiện.');
      return;
    }
    res.json({ success: true, data: { webhook_secret: updated } });
  } catch (err: any) {
    sendApiError(res, 500, 'ROTATE_WEBHOOK_SECRET_FAILED', err?.message || 'Không thể xoay khóa bí mật Webhook.');
  }
});

// Multi-Theme Form Embed Widget Generator (`iframe` | `popup_modal` | `floating_bar` | `slide_in`)
formsRouter.get('/:id/embed-config', requirePermission('mkt_forms', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const form = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM mkt_forms WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      return r.rows[0] ? mapFormRow(r.rows[0]) : null;
    });
    if (!form) {
      sendApiError(res, 404, 'FORM_NOT_FOUND', 'Không tìm thấy Biểu mẫu.');
      return;
    }

    const token = form.public_token;
    const primary = String((form.theme as Record<string, unknown>)?.primaryColor || '#1E40FF');
    const snippets = {
      iframe: `<iframe src="https://app.domation.net/embed/form/${token}" width="100%" height="520" style="border:0;border-radius:16px;overflow:hidden;" loading="lazy"></iframe>`,
      popup_modal: `<script src="https://app.domation.net/sdk/form-widget.js" data-form-token="${token}" data-mode="popup_modal" data-primary="${primary}" defer></script>`,
      floating_bar: `<script src="https://app.domation.net/sdk/form-widget.js" data-form-token="${token}" data-mode="floating_bar" data-primary="${primary}" defer></script>`,
      slide_in: `<script src="https://app.domation.net/sdk/form-widget.js" data-form-token="${token}" data-mode="slide_in" data-primary="${primary}" defer></script>`,
    };

    res.json({ success: true, data: { form, snippets } });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_FORM_EMBED_FAILED', err?.message || 'Không thể tạo mã nhúng Form.');
  }
});

// Fire a Custom or Purchase Event for a Contact (updates revenue & triggers Automation Flows!)
formsRouter.post('/events/:id/trigger', requirePermission('mkt_forms', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const amountVnd = Math.max(0, Math.round(Number(req.body?.amount_vnd || 0)));

    const txOut = await withTenantTransaction(ctx.tenantId, async (client) => {
      const evRes = await client.query(
        'SELECT * FROM mkt_custom_events WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const ev = evRes.rows[0];
      if (!ev) return null;

      const upserted = await upsertMasterContactInTx(
        client,
        ctx.tenantId,
        {
          name: req.body?.name,
          phone: req.body?.phone,
          email: req.body?.email,
          source: `Event: ${ev.event_name}`,
        },
        {
          defaultStatus: 'marketing_nurture',
          defaultSource: `Event: ${ev.event_name}`,
          dialCode: cfg.default_dial_code,
        }
      );

      await client.query(
        `UPDATE mkt_custom_events
         SET trigger_count = trigger_count + 1,
             total_revenue_vnd = total_revenue_vnd + $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, ev.id, amountVnd]
      );

      if (ev.event_category === 'purchase' && amountVnd > 0) {
        await client.query(
          `UPDATE leads
           SET total_revenue_vnd = total_revenue_vnd + $3,
               lifecycle_stage = 'customer',
               last_engaged_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, upserted.leadId, amountVnd]
        );
      }

      await client.query(
        `INSERT INTO lead_timeline_events (
           id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
         ) VALUES ($1, $2, $3, $4, 'communication', $5, 'tenant_admin', $6, $7, $8, $9::jsonb)`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          upserted.leadId,
          ev.event_category === 'purchase' ? 'purchase_event' : 'custom_event',
          ctx.userId,
          ctx.userName || 'API Trigger',
          `Sự kiện: ${ev.event_name}`,
          amountVnd > 0 ? `Giá trị đơn hàng: ${amountVnd.toLocaleString('vi-VN')}₫` : `Mã sự kiện: ${ev.event_key}`,
          JSON.stringify({ event_key: ev.event_key, amount_vnd: amountVnd, payload: req.body?.payload || {} }),
        ]
      );

      return { ev, leadId: upserted.leadId };
    });

    if (!txOut) {
      sendApiError(res, 404, 'EVENT_NOT_FOUND', 'Không tìm thấy định nghĩa sự kiện.');
      return;
    }

    await emitDomainEvent('marketing.engaged', {
      tenantId: ctx.tenantId,
      leadId: txOut.leadId,
      engagementType: txOut.ev.event_category === 'purchase' ? 'purchase_event' : 'webhook_received',
      channel: 'web',
      scoreDelta: txOut.ev.event_category === 'purchase' ? 25 : 10,
      metadata: { eventKey: txOut.ev.event_key, amountVnd },
    });

    if (txOut.ev.event_category === 'purchase' && amountVnd > 0) {
      await emitDomainEvent('deal.won', {
        tenantId: ctx.tenantId,
        leadId: txOut.leadId,
        amountVnd,
        sourceEntity: 'sales_order',
        actorId: ctx.userId,
      });
    }

    res.json({
      success: true,
      data: {
        triggered: true,
        lead_id: txOut.leadId,
        event_key: txOut.ev.event_key,
        amount_vnd: amountVnd,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'TRIGGER_EVENT_FAILED', err?.message || 'Không thể kích hoạt sự kiện.');
  }
});

formsRouter.delete('/events/:id', requirePermission('mkt_forms', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_custom_events WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_EVENT_FAILED', err?.message || 'Không thể xóa sự kiện.');
  }
});
