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
    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_custom_events (id, tenant_id, event_key, event_name, event_category, description, schema_json, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (tenant_id, event_key) DO UPDATE SET
           event_name = EXCLUDED.event_name,
           description = EXCLUDED.description,
           updated_at = clock_timestamp()`,
        [id, ctx.tenantId, rawKey, eventName, eventCategory, description, JSON.stringify(schemaJson), ctx.userId]
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
