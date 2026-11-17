import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { requireTenantAuth, requireRoles, sendApiError } from '../core/security/rbac.ts';
import { validateAndNormalizePhone } from '../services/phone.service.ts';
import { ingestAndDistributeLead } from '../services/distribution.service.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import { formatDateTimeVnSql } from './legacy/legacy-helpers.ts';

export const operationsRouter = Router();

operationsRouter.use(requireTenantAuth);

// ============================================================================
// 1. Co-Managers per Consultant/Agency (Max 3 active Co-Managers)
// ============================================================================
operationsRouter.get('/co-managers/:userId', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const targetUserId = req.params.userId;
    if (ctx.userRole === 'sale' && ctx.userId !== targetUserId) {
      sendApiError(res, 403, 'FORBIDDEN', 'Bạn chỉ được xem Người đồng quản lý của chính mình.');
      return;
    }
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT id, consultant_user_id, name, email, phone, zalo_chat_id, zalo_verified, status, created_at
         FROM consultant_managers
         WHERE tenant_id = $1 AND consultant_user_id = $2
         ORDER BY created_at ASC`,
        [ctx.tenantId, targetUserId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CO_MANAGERS_FAILED', err?.message || 'Không thể tải danh sách người quản lý.');
  }
});

operationsRouter.post('/co-managers/:userId', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const targetUserId = req.params.userId;
    if (ctx.userRole === 'sale' && ctx.userId !== targetUserId) {
      sendApiError(res, 403, 'FORBIDDEN', 'Bạn chỉ được thêm Người đồng quản lý cho chính mình.');
      return;
    }

    const { name, email, phone, zalo_chat_id } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanName || !cleanEmail) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên và Email người quản lý là bắt buộc.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tenantCfg = await getTenantSettingsCached(ctx.tenantId, client);
      const maxCoManagers = tenantCfg.max_co_managers_per_consultant;
      if (maxCoManagers <= 0) {
        const err: any = new Error('CO_MANAGERS_DISABLED');
        err.limit = maxCoManagers;
        throw err;
      }

      const cntRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM consultant_managers
         WHERE tenant_id = $1 AND consultant_user_id = $2 AND status = 'active'`,
        [ctx.tenantId, targetUserId]
      );
      if (Number(cntRes.rows[0]?.cnt || 0) >= maxCoManagers) {
        const err: any = new Error('MAX_CO_MANAGERS_REACHED');
        err.limit = maxCoManagers;
        throw err;
      }

      const r = await client.query(
        `INSERT INTO consultant_managers (
           tenant_id, consultant_user_id, name, email, phone, zalo_chat_id, zalo_verified, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         RETURNING *`,
        [
          ctx.tenantId,
          targetUserId,
          cleanName,
          cleanEmail,
          phone ? String(phone).trim() : null,
          zalo_chat_id ? String(zalo_chat_id).trim() : null,
          Boolean(zalo_chat_id && String(zalo_chat_id).trim().length > 0),
        ]
      );
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    if (err?.message === 'CO_MANAGERS_DISABLED') {
      sendApiError(res, 403, 'CO_MANAGERS_DISABLED', 'Chức năng Người đồng quản lý hiện đang tạm tắt theo cấu hình Workspace.');
      return;
    }
    if (err?.message === 'MAX_CO_MANAGERS_REACHED') {
      const lim = Number(err?.limit ?? 3);
      sendApiError(res, 422, 'MAX_CO_MANAGERS_REACHED', `Mỗi Đại lý / Sale chỉ được gắn tối đa ${lim} người đồng quản lý.`);
      return;
    }
    sendApiError(res, 500, 'CREATE_CO_MANAGER_FAILED', err?.message || 'Không thể thêm người đồng quản lý.');
  }
});

operationsRouter.patch('/co-managers/:managerId', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { name, email, phone, zalo_chat_id, status } = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query<{ consultant_user_id: string }>(
        'SELECT consultant_user_id FROM consultant_managers WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.managerId]
      );
      if (!existing.rows[0]) throw new Error('NOT_FOUND');
      if (ctx.userRole === 'sale' && existing.rows[0].consultant_user_id !== ctx.userId) {
        throw new Error('FORBIDDEN');
      }

      const r = await client.query(
        `UPDATE consultant_managers
         SET name = COALESCE($3, name),
             email = COALESCE($4, email),
             phone = COALESCE($5, phone),
             zalo_chat_id = COALESCE($6, zalo_chat_id),
             zalo_verified = CASE WHEN $6 IS NOT NULL THEN (length(trim($6)) > 0) ELSE zalo_verified END,
             status = COALESCE($7, status),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.managerId,
          name ? String(name).trim() : null,
          email ? String(email).trim().toLowerCase() : null,
          phone !== undefined ? (phone ? String(phone).trim() : null) : null,
          zalo_chat_id !== undefined ? (zalo_chat_id ? String(zalo_chat_id).trim() : '') : null,
          status || null,
        ]
      );
      return r.rows[0];
    });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN') {
      sendApiError(res, 403, 'FORBIDDEN', 'Không có quyền cập nhật.');
      return;
    }
    sendApiError(res, 500, 'UPDATE_CO_MANAGER_FAILED', err?.message || 'Không thể cập nhật người đồng quản lý.');
  }
});

operationsRouter.delete('/co-managers/:managerId', async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query<{ consultant_user_id: string }>(
        'SELECT consultant_user_id FROM consultant_managers WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.managerId]
      );
      if (!existing.rows[0]) return;
      if (ctx.userRole === 'sale' && existing.rows[0].consultant_user_id !== ctx.userId) {
        throw new Error('FORBIDDEN');
      }
      await client.query('DELETE FROM consultant_managers WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.managerId,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN') {
      sendApiError(res, 403, 'FORBIDDEN', 'Không có quyền xóa.');
      return;
    }
    sendApiError(res, 500, 'DELETE_CO_MANAGER_FAILED', err?.message || 'Không thể xóa người đồng quản lý.');
  }
});

// ============================================================================
// 2. Personal Leads (Sale Portal Tab — quota_impact = 0, sla_recall_exempt = true)
// ============================================================================
export const listPersonalLeadsHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const ownerFilter =
      ctx.userRole === 'sale'
        ? ctx.userId
        : req.query.owner_user_id
          ? String(req.query.owner_user_id)
          : ctx.userId;

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT pl.id, pl.owner_user_id, u.full_name AS sale_owner_name,
                pl.name, pl.phone, pl.email, pl.product_interest, pl.note, pl.status,
                pl.sheet_sync_status, pl.quota_impact, pl.sla_recall_exempt, pl.custom_fields, pl.created_at
         FROM personal_leads pl
         LEFT JOIN users u ON u.tenant_id = pl.tenant_id AND u.id = pl.owner_user_id
         WHERE pl.tenant_id = $1 AND pl.owner_user_id = $2
         ORDER BY pl.created_at DESC
         LIMIT 200`,
        [ctx.tenantId, ownerFilter]
      );
      return r.rows.map((row) => ({
        ...row,
        bypass_round_robin: true,
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_PERSONAL_LEADS_FAILED', err?.message || 'Không thể tải danh sách Data cá nhân.');
  }
};

export const createPersonalLeadHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const body = req.body || {};
    const rawCandidates: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [body];

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const inserted: any[] = [];
      for (const item of rawCandidates.slice(0, 200)) {
        const name = String(item.name || '').trim();
        const rawPhone = String(item.phone || '').trim();
        const phoneCheck = validateAndNormalizePhone(rawPhone, {
          default_dial_code: cfg.default_dial_code,
          allow_international_phones: cfg.allow_international_phones,
          allow_landline_phones: cfg.allow_landline_phones,
          vn_mobile_prefixes: cfg.vn_mobile_prefixes,
          custom_phone_regex: cfg.custom_phone_regex,
          block_repeated_digits: cfg.block_repeated_digits,
        });
        if (!name || !phoneCheck.valid) continue;

        const sheetEnabled = item.sheet_sync_enabled !== false && body.sheet_sync_enabled !== false;
        const ownerName = String(item.sale_owner_name || ctx.userName || 'Sale').trim();
        const syncStatus = sheetEnabled
          ? `Đồng bộ 2 chiều ↔ Google Sheet riêng (${ownerName})`
          : 'Lưu nội bộ trên Cổng Sale Cá Nhân';

        const r = await client.query(
          `INSERT INTO personal_leads (
             tenant_id, owner_user_id, name, phone, email, product_interest, note,
             status, sheet_sync_status, quota_impact, sla_recall_exempt, custom_fields
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, 0, true, $9::jsonb)
           RETURNING *`,
          [
            ctx.tenantId,
            ctx.userId,
            name,
            phoneCheck.normalizedE164,
            item.email ? String(item.email).trim() : null,
            String(item.product_interest || body.product_interest || 'Khách hàng khai thác cá nhân').trim(),
            String(item.note || body.note || 'Khách tự nhập tại Cổng Sale Cá Nhân').trim(),
            syncStatus,
            JSON.stringify(item.custom_fields && typeof item.custom_fields === 'object' ? item.custom_fields : {}),
          ]
        );
        inserted.push({ ...r.rows[0], sale_owner_name: ownerName, bypass_round_robin: true });
      }
      return inserted;
    });

    if (created.length === 0) {
      sendApiError(res, 422, 'INVALID_PERSONAL_LEAD', 'Vui lòng nhập Họ tên và Số điện thoại hợp lệ.');
      return;
    }

    res.status(201).json({
      success: true,
      data: {
        item: created[0],
        items: created,
        imported_count: created.length,
        policy_summary: 'Đã lưu thẳng vào Cổng Sale Cá Nhân: Bỏ qua Vòng Chia, Không trừ Quota Ads (0 Quota).',
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_PERSONAL_LEAD_FAILED', err?.message || 'Không thể lưu Data cá nhân.');
  }
};

export const deletePersonalLeadHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        'DELETE FROM personal_leads WHERE tenant_id = $1 AND id = $2 AND owner_user_id = $3',
        [ctx.tenantId, req.params.id, ctx.userId]
      );
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_PERSONAL_LEAD_FAILED', err?.message || 'Không thể xóa Data cá nhân.');
  }
};

operationsRouter.get('/personal-leads', listPersonalLeadsHandler);
operationsRouter.post('/personal-leads', createPersonalLeadHandler);
operationsRouter.delete('/personal-leads/:id', deletePersonalLeadHandler);

// ============================================================================
// 3. AI Gatekeeper (`ai_screener_configs`, `held_leads`, `blacklist_entries`)
// ============================================================================
operationsRouter.get('/gatekeeper/config', requireRoles('tenant_admin', 'manager'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM ai_screener_configs WHERE tenant_id = $1 LIMIT 1', [ctx.tenantId]);
      return (
        r.rows[0] || {
          tenant_id: ctx.tenantId,
          mode: 'ai',
          is_enabled: false,
          model_name: 'gemini-3.5-flash-lite',
          prompt_rules: '',
          manual_action: 'hold',
          manual_rules: [],
          target_round_ids: [],
          fallback_enabled: false,
          fallback_round_id: null,
        }
      );
    });
    res.json({ success: true, data: cfg });
  } catch (err: any) {
    sendApiError(res, 500, 'GATEKEEPER_CONFIG_FAILED', err?.message || 'Không thể tải cấu hình AI Gatekeeper.');
  }
});

operationsRouter.put('/gatekeeper/config', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      mode = 'ai',
      is_enabled = false,
      model_name = 'gemini-3.5-flash-lite',
      prompt_rules = '',
      manual_action = 'hold',
      manual_rules = [],
      target_round_ids = [],
      fallback_enabled = false,
      fallback_round_id = null,
    } = req.body || {};

    const validMode = ['ai', 'manual', 'hybrid'].includes(mode) ? mode : 'ai';

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO ai_screener_configs (
           tenant_id, mode, is_enabled, model_name, prompt_rules,
           manual_action, manual_rules, target_round_ids, fallback_enabled, fallback_round_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         ON CONFLICT (tenant_id) DO UPDATE SET
           mode = EXCLUDED.mode,
           is_enabled = EXCLUDED.is_enabled,
           model_name = EXCLUDED.model_name,
           prompt_rules = EXCLUDED.prompt_rules,
           manual_action = EXCLUDED.manual_action,
           manual_rules = EXCLUDED.manual_rules,
           target_round_ids = EXCLUDED.target_round_ids,
           fallback_enabled = EXCLUDED.fallback_enabled,
           fallback_round_id = EXCLUDED.fallback_round_id,
           updated_at = clock_timestamp()
         RETURNING *`,
        [
          ctx.tenantId,
          validMode,
          Boolean(is_enabled),
          String(model_name || 'gemini-3.5-flash-lite'),
          String(prompt_rules || ''),
          String(manual_action || 'hold'),
          JSON.stringify(Array.isArray(manual_rules) ? manual_rules : []),
          JSON.stringify(Array.isArray(target_round_ids) ? target_round_ids : []),
          Boolean(fallback_enabled),
          fallback_round_id || null,
        ]
      );
      return r.rows[0];
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'GATEKEEPER_SAVE_FAILED', err?.message || 'Không thể lưu cấu hình AI Gatekeeper.');
  }
});

operationsRouter.get('/gatekeeper/held-leads', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = req.query.status ? String(req.query.status) : 'held';
    const search = req.query.search ? String(req.query.search).trim() : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 25)));
    const offset = (page - 1) * limit;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'tenant_id = $1';
      if (statusFilter !== 'all') {
        params.push(statusFilter);
        where += ` AND status = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR COALESCE(email, '') ILIKE $${params.length})`;
      }

      const [cntRes, statsRes, rowsRes] = await Promise.all([
        client.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM held_leads WHERE ${where}`, params),
        client.query<{ held: number; approved: number; rejected: number; blacklisted: number }>(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'held')::int AS held,
             COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
             COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
             COUNT(*) FILTER (WHERE status = 'blacklisted')::int AS blacklisted
           FROM held_leads WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT * FROM held_leads WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);

      const total = Number(cntRes.rows[0]?.total || 0);
      return {
        items: rowsRes.rows,
        stats: statsRes.rows[0] || { held: 0, approved: 0, rejected: 0, blacklisted: 0 },
        pagination: { total, page, total_pages: Math.max(1, Math.ceil(total / limit)) },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'HELD_LEADS_FAILED', err?.message || 'Không thể tải danh sách Data giữ lại.');
  }
});

operationsRouter.post('/gatekeeper/held-leads/:id/resolve', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { action = 'approve' } = req.body || {};
    if (!['approve', 'reject', 'blacklist', 'fallback'].includes(action)) {
      sendApiError(res, 422, 'INVALID_ACTION', 'Hành động không hợp lệ.');
      return;
    }

    const heldRow = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<any>(
        'SELECT * FROM held_leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, req.params.id]
      );
      const row = r.rows[0];
      if (!row) throw new Error('HELD_LEAD_NOT_FOUND');

      const nextStatus =
        action === 'approve' || action === 'fallback'
          ? 'approved'
          : action === 'blacklist'
            ? 'blacklisted'
            : 'rejected';

      await client.query(
        `UPDATE held_leads
         SET status = $3, resolved_by = $4, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, nextStatus, ctx.userId]
      );

      if (action === 'blacklist' && row.phone) {
        await client.query(
          `INSERT INTO blacklist_entries (tenant_id, entry_type, value, reason, created_by)
           VALUES ($1, 'phone', $2, $3, $4)
           ON CONFLICT (tenant_id, entry_type, value) DO NOTHING`,
          [ctx.tenantId, row.phone, row.hold_reason || 'Blocked from Gatekeeper', ctx.userId]
        );
      }

      return { ...row, nextStatus };
    });

    let distributedLead: any = null;
    if (action === 'approve' || action === 'fallback') {
      const payload = (heldRow.payload_json && typeof heldRow.payload_json === 'object' ? heldRow.payload_json : {}) as any;
      distributedLead = await ingestAndDistributeLead(ctx.tenantId, {
        name: heldRow.name,
        phone: heldRow.phone,
        email: heldRow.email || undefined,
        source: heldRow.source || 'Gatekeeper Approved',
        campaign: heldRow.campaign || undefined,
        custom_fields: payload.custom_fields || {},
        skip_gatekeeper: true,
        skip_blacklist: true,
      });
    }

    res.json({ success: true, data: { resolved: heldRow, distributed_lead: distributedLead } });
  } catch (err: any) {
    sendApiError(res, 500, 'RESOLVE_HELD_LEAD_FAILED', err?.message || 'Không thể xử lý Data giữ lại.');
  }
});

operationsRouter.get('/gatekeeper/blacklist', requireRoles('tenant_admin', 'manager'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM blacklist_entries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_BLACKLIST_FAILED', err?.message || 'Không thể tải danh sách chặn.');
  }
});

operationsRouter.post('/gatekeeper/blacklist', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { entry_type = 'phone', value, reason = '' } = req.body || {};
    const cleanVal = String(value || '').trim();
    if (!cleanVal || !['phone', 'email', 'ip', 'keyword'].includes(entry_type)) {
      sendApiError(res, 422, 'INVALID_BLACKLIST_ENTRY', 'Giá trị chặn không hợp lệ.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO blacklist_entries (tenant_id, entry_type, value, reason, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, entry_type, value) DO UPDATE SET reason = EXCLUDED.reason
         RETURNING *`,
        [ctx.tenantId, entry_type, entry_type === 'email' ? cleanVal.toLowerCase() : cleanVal, String(reason).trim(), ctx.userId]
      );
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'ADD_BLACKLIST_FAILED', err?.message || 'Không thể thêm vào danh sách chặn.');
  }
});

operationsRouter.delete('/gatekeeper/blacklist/:id', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM blacklist_entries WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_BLACKLIST_FAILED', err?.message || 'Không thể xóa mục chặn.');
  }
});

// ============================================================================
// 4. Admin Audit Logs & Rollback (`admin_audit_logs`)
// ============================================================================
operationsRouter.get('/admin-audit', requireRoles('tenant_admin'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM admin_audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_AUDIT_FAILED', err?.message || 'Không thể tải nhật ký Admin.');
  }
});

operationsRouter.post('/admin-audit/:id/rollback', requireRoles('tenant_admin'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const logRes = await client.query<any>(
        'SELECT * FROM admin_audit_logs WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, req.params.id]
      );
      const log = logRes.rows[0];
      if (!log) throw new Error('AUDIT_LOG_NOT_FOUND');
      if (log.is_rolled_back) throw new Error('ALREADY_ROLLED_BACK');

      const snap = log.before_snapshot && typeof log.before_snapshot === 'object' ? log.before_snapshot : {};

      if (log.entity_type === 'lead_import_batch' && log.entity_id) {
        await client.query(
          'UPDATE leads SET is_deleted = true, updated_at = clock_timestamp() WHERE tenant_id = $1 AND batch_id = $2',
          [ctx.tenantId, log.entity_id]
        );
        await client.query(
          "UPDATE lead_import_batches SET status = 'rolled_back' WHERE tenant_id = $1 AND id = $2",
          [ctx.tenantId, log.entity_id]
        );
      } else if (log.entity_type === 'tenant_settings' && Object.keys(snap).length > 0) {
        await client.query(
          'UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
          [ctx.tenantId, JSON.stringify(snap)]
        );
      }

      const upd = await client.query(
        `UPDATE admin_audit_logs
         SET is_rolled_back = true, rolled_back_at = clock_timestamp(), rolled_back_by = $3
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [ctx.tenantId, req.params.id, ctx.userId]
      );
      return upd.rows[0];
    });
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'ROLLBACK_FAILED', err?.message || 'Không thể hoàn tác thao tác này.');
  }
});

// ============================================================================
// 5. Batch Duplicate Check & Silent Import (`lead_import_batches`)
// ============================================================================
operationsRouter.post('/leads/batch-check', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 1000) : [];

    const results = await withTenantTransaction(ctx.tenantId, async (client) => {
      const normalizedList = rows.map((r: any, idx: number) => {
        const phoneCheck = validateAndNormalizePhone(String(r.phone || ''), {
          default_dial_code: cfg.default_dial_code,
          allow_international_phones: cfg.allow_international_phones,
          allow_landline_phones: cfg.allow_landline_phones,
          vn_mobile_prefixes: cfg.vn_mobile_prefixes,
          custom_phone_regex: cfg.custom_phone_regex,
          block_repeated_digits: cfg.block_repeated_digits,
        });
        return {
          row_index: idx,
          name: String(r.name || '').trim(),
          raw_phone: String(r.phone || '').trim(),
          normalized_phone: phoneCheck.valid ? phoneCheck.normalizedE164 : '',
          email: r.email ? String(r.email).trim().toLowerCase() : null,
          valid: phoneCheck.valid,
        };
      });

      const validPhones = Array.from(new Set(normalizedList.map((x: any) => x.normalized_phone).filter(Boolean)));
      const existingMap = new Map<string, any>();

      if (validPhones.length > 0) {
        const exRes = await client.query(
          `SELECT DISTINCT ON (l.phone) l.phone, l.id, l.name, l.created_at, u.full_name AS owner_name
           FROM leads l
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           WHERE l.tenant_id = $1 AND l.phone = ANY($2::text[]) AND l.is_deleted = false
           ORDER BY l.phone, l.created_at DESC`,
          [ctx.tenantId, validPhones]
        );
        for (const ex of exRes.rows) {
          existingMap.set(ex.phone, ex);
        }
      }

      return normalizedList.map((item: any) => {
        const match = item.normalized_phone ? existingMap.get(item.normalized_phone) : null;
        return {
          ...item,
          is_duplicate: Boolean(match),
          existing_lead: match || null,
        };
      });
    });

    res.json({ success: true, data: { results } });
  } catch (err: any) {
    sendApiError(res, 500, 'BATCH_CHECK_FAILED', err?.message || 'Không thể kiểm tra trùng dữ liệu.');
  }
});

operationsRouter.get('/leads/import-batches', requireRoles('tenant_admin', 'manager'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM lead_import_batches WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_IMPORT_BATCHES_FAILED', err?.message || 'Không thể tải lịch sử import.');
  }
});

operationsRouter.post('/leads/batch-import', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { file_name = 'import.xlsx', rows = [], is_silent = true, skip_duplicates = true } = req.body || {};
    const list = Array.isArray(rows) ? rows.slice(0, 500) : [];
    const batchId = crypto.randomUUID();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const summary = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pipeRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC LIMIT 1',
        [ctx.tenantId]
      );
      const pipelineId = pipeRes.rows[0]?.id;
      const stageRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC LIMIT 1',
        [ctx.tenantId, pipelineId]
      );
      const stageId = stageRes.rows[0]?.id;
      if (!pipelineId || !stageId) throw new Error('PIPELINE_NOT_CONFIGURED');

      let importedCount = 0;
      let duplicateCount = 0;
      let skippedCount = 0;

      interface ValidItem {
        item: any;
        normalizedPhone: string;
      }
      const validItems: ValidItem[] = [];

      for (const item of list) {
        const phoneCheck = validateAndNormalizePhone(String(item.phone || ''), {
          default_dial_code: cfg.default_dial_code,
          allow_international_phones: cfg.allow_international_phones,
          allow_landline_phones: cfg.allow_landline_phones,
          vn_mobile_prefixes: cfg.vn_mobile_prefixes,
          custom_phone_regex: cfg.custom_phone_regex,
          block_repeated_digits: cfg.block_repeated_digits,
        });
        if (!phoneCheck.valid) {
          skippedCount++;
          continue;
        }
        validItems.push({
          item,
          normalizedPhone: phoneCheck.normalizedE164,
        });
      }

      // Single set-based query for existing phone numbers
      const phonesToCheck = Array.from(new Set(validItems.map((x) => x.normalizedPhone)));
      const existingDbPhoneSet = new Set<string>();
      if (phonesToCheck.length > 0) {
        const ex = await client.query<{ phone: string }>(
          'SELECT phone FROM leads WHERE tenant_id = $1 AND phone = ANY($2::text[]) AND is_deleted = false',
          [ctx.tenantId, phonesToCheck]
        );
        for (const row of ex.rows) {
          existingDbPhoneSet.add(row.phone);
        }
      }

      // Filter and prepare leads for multi-row insertion
      interface LeadToInsert {
        name: string;
        phone: string;
        email: string | null;
        source: string;
        custom_fields: any;
        is_accepted: boolean;
        is_duplicated: boolean;
      }

      const toInsert: LeadToInsert[] = [];
      const seenInBatch = new Set<string>();

      for (const { item, normalizedPhone } of validItems) {
        const isDuplicated = existingDbPhoneSet.has(normalizedPhone) || seenInBatch.has(normalizedPhone);
        if (isDuplicated) {
          duplicateCount++;
          if (skip_duplicates) continue;
        }
        seenInBatch.add(normalizedPhone);

        toInsert.push({
          name: String(item.name || 'Khách hàng Import').trim(),
          phone: normalizedPhone,
          email: item.email ? String(item.email).trim().toLowerCase() : null,
          source: String(item.source || 'Historical Import').trim(),
          custom_fields: { silent_import: Boolean(is_silent), file_name },
          is_accepted: Boolean(is_silent),
          is_duplicated: isDuplicated,
        });
      }

      // Multi-row batch inserts with parameterized chunking (100 rows per batch)
      const CHUNK_SIZE = 100;
      for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
        const chunk = toInsert.slice(i, i + CHUNK_SIZE);
        const valuePlaceholders: string[] = [];
        const params: any[] = [];
        let pIdx = 1;

        for (const row of chunk) {
          valuePlaceholders.push(
            `($${pIdx}, $${pIdx + 1}, $${pIdx + 2}, 'unassigned_pending', $${pIdx + 3}, $${pIdx + 4}, $${pIdx + 5}, $${pIdx + 6}, $${pIdx + 7}::jsonb, $${pIdx + 8}, $${pIdx + 9}, $${pIdx + 10})`
          );
          params.push(
            ctx.tenantId,
            pipelineId,
            stageId,
            row.name,
            row.phone,
            row.email,
            row.source,
            JSON.stringify(row.custom_fields),
            row.is_accepted,
            batchId,
            row.is_duplicated
          );
          pIdx += 11;
        }

        await client.query(
          `INSERT INTO leads (
             tenant_id, pipeline_id, stage_id, status, name, phone, email, source,
             custom_fields, is_accepted, batch_id, is_duplicated
           ) VALUES ${valuePlaceholders.join(', ')}`,
          params
        );
        importedCount += chunk.length;
      }

      await client.query(
        `INSERT INTO lead_import_batches (
           id, tenant_id, file_name, total_rows, imported_count, duplicate_count, skipped_count, is_silent, imported_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [batchId, ctx.tenantId, String(file_name), list.length, importedCount, duplicateCount, skippedCount, Boolean(is_silent), ctx.userId]
      );

      await client.query(
        `INSERT INTO admin_audit_logs (
           tenant_id, actor_id, actor_name, action, entity_type, entity_id, details
         ) VALUES ($1, $2, $3, 'batch_import_leads', 'lead_import_batch', $4, $5::jsonb)`,
        [
          ctx.tenantId,
          ctx.userId,
          ctx.userName || 'Admin',
          batchId,
          JSON.stringify({ file_name, importedCount, duplicateCount, skippedCount, is_silent }),
        ]
      );

      return { batch_id: batchId, total_rows: list.length, imported_count: importedCount, duplicate_count: duplicateCount, skipped_count: skippedCount };
    });

    res.status(201).json({ success: true, data: summary });
  } catch (err: any) {
    sendApiError(res, 500, 'BATCH_IMPORT_FAILED', err?.message || 'Không thể import dữ liệu.');
  }
});

// Standardized notification status endpoint (POST /api/v1/operations/leads/notification-status)
operationsRouter.post('/leads/notification-status', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = String(req.body?.lead_id || req.query?.lead_id || '').trim();
    if (!leadId) {
      return sendApiError(res, 400, 'LEAD_ID_REQUIRED', 'Thiếu lead_id cần tra cứu trạng thái.');
    }

    const r = await withTenantTransaction(ctx.tenantId, async (client) => {
      return client.query(
        `SELECT l.zalo_notify_status, l.email_notify_status, l.is_accepted, l.accepted_at, l.created_at,
                u.full_name AS consultant_name, u.email AS consultant_email, p.zalo_chat_id
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = l.tenant_id AND p.user_id = l.assigned_to
         WHERE l.tenant_id = $1 AND l.id = $2
         LIMIT 1`,
        [ctx.tenantId, leadId]
      );
    });

    const row = r.rows[0];
    const zaloStatus = row?.zalo_notify_status || 'none';
    const emailStatus = row?.email_notify_status || 'none';
    const sentAt = row?.created_at ? formatDateTimeVnSql(row.created_at) : null;
    const acceptedAt = row?.accepted_at ? formatDateTimeVnSql(row.accepted_at) : null;

    res.json({
      success: true,
      data: {
        zalo_status: zaloStatus,
        email_status: emailStatus,
        is_accepted: Boolean(row?.is_accepted),
        accepted_at: acceptedAt,
        sent_at: sentAt,
        consultant_name: row?.consultant_name || '-',
        consultant_email: row?.consultant_email || '-',
        has_zalo: Boolean(row?.zalo_chat_id),
        email: {
          status: emailStatus,
          sent_at: sentAt,
          last_sent_at: sentAt,
          target: row?.consultant_email || '-',
          id: null,
          error: null,
        },
        zalo: {
          status: zaloStatus,
          sent_at: sentAt,
          last_sent_at: sentAt,
          target: row?.zalo_chat_id || '-',
          id: null,
          error: null,
        },
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_NOTIFICATION_STATUS_FAILED', err?.message || 'Không thể lấy trạng thái thông báo.');
  }
});
