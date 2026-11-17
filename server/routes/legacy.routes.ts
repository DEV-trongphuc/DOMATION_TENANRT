import { Router } from 'express';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { requireTenantAuth, sendApiError } from '../core/security/rbac.ts';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import {
  buildLegacyDateFilter,
  cleanQueryAction,
  formatDateTimeVnSql,
  mapPgLeadRowToLegacy,
} from './legacy/legacy-helpers.ts';
import { maskPhoneString } from '../core/security/pii-masker.ts';
import { handleLegacyAnalytics } from './legacy/legacy-analytics.ts';
import { handleLegacyCrm, handleLegacyCrmStandalone } from './legacy/legacy-crm.ts';
import { handleLegacyAdmin, handleLegacyAdminStandalone } from './legacy/legacy-admin.ts';

export const legacyRouter = Router();

legacyRouter.use(requireTenantAuth);

legacyRouter.all('/', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const { action, inlineParams } = cleanQueryAction(req.query.action);
    const mergedParams = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === 'action' || k === 'token' || v === undefined) continue;
      mergedParams.set(k, Array.isArray(v) ? String(v[0]) : String(v));
    }
    inlineParams.forEach((v, k) => {
      if (!mergedParams.has(k)) mergedParams.set(k, v);
    });

    if (!action) {
      sendApiError(res, 400, 'MISSING_ACTION', 'Thiếu tham số action.');
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // Standalone multi-transaction CRM & Email flows
    const standaloneRes = await handleLegacyCrmStandalone(action, mergedParams, body, ctx, cfg);
    if (standaloneRes !== null) {
      if (typeof standaloneRes === 'object' && '_status' in standaloneRes) {
        const { _status, ...payload } = standaloneRes as Record<string, any>;
        res.status(Number(_status)).json(payload);
        return;
      }
      res.json(standaloneRes);
      return;
    }

    const adminStandaloneRes = await handleLegacyAdminStandalone(action, mergedParams, body, ctx);
    if (adminStandaloneRes !== null) {
      if (typeof adminStandaloneRes === 'object' && '_status' in adminStandaloneRes) {
        const { _status, ...payload } = adminStandaloneRes as Record<string, any>;
        res.status(Number(_status)).json(payload);
        return;
      }
      res.json(adminStandaloneRes);
      return;
    }

    // Export CSV directly streaming UTF-8 BOM CSV
    if (action === 'export_csv') {
      const dateFilter = buildLegacyDateFilter(mergedParams.get('date') || 'Tháng này');
      const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
        const qParams: unknown[] = [ctx.tenantId];
        const dCond = dateFilter.bindSql('l.created_at', qParams);
        const r = await client.query(
          `SELECT l.*, u.full_name AS assigned_to_name, r.name AS round_name
           FROM leads l
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
           WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived' AND (${dCond})
             ${ctx.userRole === 'sale' ? `AND l.assigned_to = '${ctx.userId}'` : ''}
           ORDER BY l.created_at DESC
           LIMIT 5000`,
          qParams
        );
        return r.rows.map((row) => mapPgLeadRowToLegacy(row, ctx, cfg));
      });

      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['ID', 'Khách hàng', 'SĐT', 'Email', 'Nguồn', 'Trạng thái', 'Chất lượng', 'Đại lý', 'Vòng', 'Thời gian nhận'];
      const lines = [
        header.map(esc).join(','),
        ...rows.map((r) =>
          [
            r.id,
            r.name,
            r.phone,
            r.email,
            r.source,
            r.status,
            r.quality_status,
            r.assigned_to_name,
            r.round_name,
            r.created_at,
          ]
            .map(esc)
            .join(',')
        ),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="autodata-leads-export.csv"');
      res.send(`\uFEFF${lines.join('\n')}`);
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (action === 'get_report_context') {
        const leadId = String(mergedParams.get('lead_id') || '').trim();
        const r = await client.query(
          `SELECT l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone, l.source AS lead_source,
                  l.round_id, r.name AS round_name, l.assigned_to AS sale_id,
                  u.full_name AS consultant_name, u.email AS consultant_email, l.created_at
           FROM leads l
           LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           WHERE l.tenant_id = $1 AND l.id = $2
           LIMIT 1`,
          [ctx.tenantId, leadId]
        );
        const row = r.rows[0];
        if (!row) return { success: false, message: 'Không tìm thấy dữ liệu Khách hàng.' };
        const shouldMask = ctx.isExternalAgency || (ctx.userRole === 'sale' && row.sale_id !== ctx.userId);
        const displayPhone = shouldMask && row.lead_phone ? maskPhoneString(row.lead_phone, cfg) : row.lead_phone;
        return {
          success: true,
          data: {
            ...row,
            lead_phone: displayPhone,
            phone: displayPhone,
            created_at: formatDateTimeVnSql(row.created_at),
            is_allowed_to_report: true,
            report_error_reasons: (cfg.ticket_reasons || []).map((x) => ({
              reason: x.label || x.value,
              note: x.value,
            })),
          },
          lead: {
            id: row.lead_id,
            name: row.lead_name,
            lead_phone: displayPhone,
            phone: displayPhone,
            assigned_to: row.sale_id,
            round_name: row.round_name,
            created_at: formatDateTimeVnSql(row.created_at),
          },
        };
      }

      const analyticsRes = await handleLegacyAnalytics(action, mergedParams, client, ctx, cfg);
      if (analyticsRes !== null) return analyticsRes;

      const crmRes = await handleLegacyCrm(action, mergedParams, body, client, ctx, cfg);
      if (crmRes !== null) return crmRes;

      const adminRes = await handleLegacyAdmin(action, mergedParams, body, client, ctx, cfg);
      if (adminRes !== null) return adminRes;

      return {
        success: true,
        data: [],
        message: `Hành động '${action}' đã được ghi nhận trên Multi-Tenant Kernel.`,
      };
    });

    if (result && typeof result === 'object' && '_status' in result) {
      const { _status, ...payload } = result as Record<string, any>;
      res.status(Number(_status)).json(payload);
      return;
    }

    res.json(result);
  } catch (err: any) {
    sendApiError(res, 500, 'LEGACY_ACTION_FAILED', err?.message || 'Lỗi xử lý thao tác hệ thống.');
  }
});
