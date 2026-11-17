import zlib from 'node:zlib';
import { once } from 'node:events';
import { Router } from 'express';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import {
  requireTenantAuth,
  requireRoles,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../core/security/rbac.ts';
import { acceptsGzipEncoding } from '../core/http/encoding.ts';
import { buildScopedLeadWhereClause } from '../core/repository/tenant-query-decorator.ts';
import {
  transformLeadForActor,
  shouldMaskPiiForActor,
  shouldHideInternalNotesForActor,
  maskPiiInText,
  maskPhoneString,
  maskEmailString,
} from '../core/security/pii-masker.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import {
  ingestAndDistributeLead,
  validateAndSanitizeCustomFields,
} from '../services/distribution.service.ts';
import { dispatchStageCapiEventDetached } from '../services/capi.service.ts';
import { enqueueOutboundWebhookEvent } from '../services/webhook.service.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { emitDomainEvent } from '../core/events/event-bus.ts';
import { upsertMasterContactInTx } from '../modules/audiences/audiences.service.ts';
import {
  listPersonalLeadsHandler,
  createPersonalLeadHandler,
  deletePersonalLeadHandler,
} from './operations.routes.ts';

export const leadsRouter = Router();

leadsRouter.use(requireTenantAuth);

leadsRouter.get('/personal', listPersonalLeadsHandler);
leadsRouter.post('/personal', createPersonalLeadHandler);
leadsRouter.delete('/personal/:id', deletePersonalLeadHandler);

leadsRouter.post('/quick-test', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { name, phone, email, source, campaign, product_interest, note } = req.body || {};
    const out = await ingestAndDistributeLead(ctx.tenantId, {
      name: String(name || 'Khách hàng Test Webhook').trim(),
      phone: String(phone || '0901234567').trim(),
      email: email ? String(email).trim() : undefined,
      source: String(source || 'Webhook Test').trim(),
      campaign: campaign ? String(campaign).trim() : undefined,
      product_interest: product_interest ? String(product_interest).trim() : undefined,
      note: note ? String(note).trim() : undefined,
    });
    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('DUPLICATE_LEAD_REJECTED')) {
      sendApiError(res, 409, 'DUPLICATE_LEAD_REJECTED', msg);
      return;
    }
    sendApiError(res, 422, 'QUICK_TEST_FAILED', msg || 'Không thể bắn Lead thử.');
  }
});

// Real-Time Dashboard KPI Summary (Scoped by Role & Optional Pipeline)
leadsRouter.get('/stats/summary', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.query.pipeline_id ? String(req.query.pipeline_id).trim() : null;
    const scoped = buildScopedLeadWhereClause(ctx, 1);

    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const summary = await withTenantTransaction(ctx.tenantId, async (client) => {
      const kpiParams = [...scoped.values];
      let kpiWhere = scoped.clause;
      if (pipelineId) {
        kpiParams.push(pipelineId);
        kpiWhere += ` AND leads.pipeline_id = $${kpiParams.length}`;
      }

      const kpiRes = await client.query(
        `SELECT
           COUNT(*)::int AS total_leads,
           COUNT(*) FILTER (WHERE leads.status = 'assigned')::int AS assigned_leads,
           COUNT(*) FILTER (WHERE leads.status = 'unassigned_pending')::int AS unassigned_leads,
           COUNT(*) FILTER (WHERE leads.is_accepted = true)::int AS accepted_leads,
           COUNT(*) FILTER (WHERE leads.is_duplicate_reminder = true)::int AS duplicate_reminders,
           COUNT(*) FILTER (WHERE leads.sla_breached = true)::int AS sla_breached_leads,
           COUNT(*) FILTER (WHERE s.is_won_stage = true)::int AS won_leads
         FROM leads
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = leads.tenant_id AND s.id = leads.stage_id
         WHERE ${kpiWhere}`,
        kpiParams
      );

      const stageParams = [...scoped.values];
      let stageWhere = 's.tenant_id = $1';
      if (pipelineId) {
        stageParams.push(pipelineId);
        stageWhere += ` AND s.pipeline_id = $${stageParams.length}`;
      }

      const byStageRes = await client.query(
        `SELECT s.id, s.pipeline_id, s.stage_name, s.color_hex, s.capi_event_mapping,
                COUNT(leads.id)::int AS count
         FROM tenant_pipeline_stages s
         LEFT JOIN leads ON leads.tenant_id = s.tenant_id AND leads.stage_id = s.id AND (${scoped.clause})
         WHERE ${stageWhere}
         GROUP BY s.id, s.pipeline_id, s.stage_name, s.color_hex, s.capi_event_mapping, s.stage_order
         ORDER BY s.stage_order ASC`,
        stageParams
      );

      const bySourceRes = await client.query(
        `SELECT leads.source, COUNT(*)::int AS count
         FROM leads
         WHERE ${kpiWhere}
         GROUP BY leads.source
         ORDER BY count DESC
         LIMIT 8`,
        kpiParams
      );

      const capiCountRes = await client.query<{ sent_ok: number }>(
        `SELECT COUNT(*)::int AS sent_ok
         FROM capi_logs
         WHERE tenant_id = $1 AND response_status = 200`,
        [ctx.tenantId]
      );

      const latencyRes = await client.query<{ avg_ms: string | null }>(
        `SELECT AVG(lat)::text AS avg_ms
         FROM (
           SELECT (metadata->>'latency_ms')::numeric AS lat
           FROM lead_timeline_events
           WHERE tenant_id = $1
             AND event_type IN ('lead_distributed', 'duplicate_reminder')
             AND (metadata->>'latency_ms') ~ '^[0-9]+(\\.[0-9]+)?$'
           ORDER BY created_at DESC
           LIMIT 200
         ) recent`,
        [ctx.tenantId]
      );
      const rawAvgMs = latencyRes.rows[0]?.avg_ms ? Number(latencyRes.rows[0].avg_ms) : null;
      const avgDistSeconds =
        rawAvgMs !== null && Number.isFinite(rawAvgMs) && rawAvgMs > 0
          ? Math.max(0.05, Number((rawAvgMs / 1000).toFixed(2)))
          : 0;

      const row = kpiRes.rows[0] || {};
      const total = Number(row.total_leads || 0);
      const accepted = Number(row.accepted_leads || 0);
      const slaRate = total > 0 ? Math.round(((total - Number(row.sla_breached_leads || 0)) / total) * 100) : 100;

      return {
        total_leads: total,
        assigned_leads: Number(row.assigned_leads || 0),
        unassigned_leads: Number(row.unassigned_leads || 0),
        accepted_leads: accepted,
        acceptance_rate_pct: total > 0 ? Math.round((accepted / total) * 100) : 0,
        sla_compliance_pct: slaRate,
        won_leads: Number(row.won_leads || 0),
        duplicate_reminders: Number(row.duplicate_reminders || 0),
        capi_200_count: Number(capiCountRes.rows[0]?.sent_ok || 0),
        avg_distribution_seconds: avgDistSeconds,
        sla_target_seconds: cfg.sla_target_seconds,
        by_stage: byStageRes.rows,
        by_source: bySourceRes.rows,
      };
    });

    res.json({ success: true, data: summary });
  } catch (err: any) {
    sendApiError(res, 500, 'LEAD_STATS_FAILED', err?.message || 'Không thể tải thống kê Dashboard.');
  }
});

// 5.1 List Leads (Scoped by Role Op 13/14/15 + Kernel RLS + Configurable PII Masking)
leadsRouter.get('/', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const pipelineId = req.query.pipeline_id ? String(req.query.pipeline_id).trim() : null;
    const stageId = req.query.stage_id ? String(req.query.stage_id) : null;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const qualityFilter = req.query.quality_status ? String(req.query.quality_status) : null;
    const assignedFilter = req.query.assigned_to ? String(req.query.assigned_to) : null;
    const search = req.query.search ? String(req.query.search).trim() : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(cfg.max_page_size || 200, Math.max(1, Number(req.query.limit || 50)));
    const offset = (page - 1) * limit;

    const scoped = buildScopedLeadWhereClause(ctx, 1);
    const params = [...scoped.values];
    let where = `${scoped.clause} AND leads.is_deleted = false`;
    const roundId = req.query.round_id ? String(req.query.round_id).trim() : null;

    if (roundId) {
      params.push(roundId);
      where += ` AND leads.round_id = $${params.length}`;
    }

    if (pipelineId) {
      params.push(pipelineId);
      where += ` AND leads.pipeline_id = $${params.length}`;
    }
    if (stageId) {
      params.push(stageId);
      where += ` AND leads.stage_id = $${params.length}`;
    }
    if (statusFilter) {
      params.push(statusFilter);
      where += ` AND leads.status = $${params.length}`;
    }
    if (qualityFilter) {
      params.push(qualityFilter);
      where += ` AND leads.quality_status = $${params.length}`;
    }
    if (assignedFilter && ctx.userRole !== 'sale') {
      params.push(assignedFilter);
      where += ` AND leads.assigned_to = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      const pIdx = `$${params.length}`;
      const digitsOnly = search.replace(/\D/g, '');
      if (digitsOnly.length >= 6) {
        const strippedZero = digitsOnly.replace(/^0+/, '');
        params.push(`%${strippedZero || digitsOnly}%`);
        const dIdx = `$${params.length}`;
        where += ` AND (leads.name ILIKE ${pIdx} OR leads.phone ILIKE ${pIdx} OR leads.phone ILIKE ${dIdx} OR COALESCE(leads.email, '') ILIKE ${pIdx} OR COALESCE(leads.campaign, '') ILIKE ${pIdx})`;
      } else {
        where += ` AND (leads.name ILIKE ${pIdx} OR leads.phone ILIKE ${pIdx} OR COALESCE(leads.email, '') ILIKE ${pIdx} OR COALESCE(leads.campaign, '') ILIKE ${pIdx})`;
      }
    }

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [countRes, rbac] = await Promise.all([
        client.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total FROM leads WHERE ${where}`,
          params
        ),
        resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId),
      ]);
      const canUnmaskPhone = rbac.effectivePermissions.leads?.actions.unmask_phone;

      const queryParams = [...params, limit, offset];
      const rowsRes = await client.query(
        `SELECT
           leads.id, leads.pipeline_id, leads.stage_id, leads.assigned_to, leads.round_id, leads.status,
           leads.lifecycle_stage, leads.lead_score, leads.email_consent, leads.zns_consent,
           leads.total_revenue_vnd, leads.last_engaged_at,
           leads.name, leads.phone, leads.email, leads.source, leads.campaign,
           leads.product_interest, leads.budget_range, leads.utm_source, leads.ad_id, leads.campaign_id,
           leads.ai_screener_status, leads.ai_evaluation,
           leads.custom_fields, leads.is_accepted, leads.accepted_at, leads.sla_breached,
           leads.is_duplicate_reminder, leads.quality_status, leads.created_at, leads.updated_at,
           s.stage_key, s.stage_name, s.color_hex, s.capi_event_mapping,
           u.full_name AS assigned_sale_name, u.email AS assigned_sale_email,
           dr.name AS round_name
         FROM leads
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = leads.tenant_id AND s.id = leads.stage_id
         LEFT JOIN users u ON u.tenant_id = leads.tenant_id AND u.id = leads.assigned_to
         LEFT JOIN distribution_rounds dr ON dr.tenant_id = leads.tenant_id AND dr.id = leads.round_id
         WHERE ${where}
         ORDER BY leads.created_at DESC
         LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
        queryParams
      );

      const items = rowsRes.rows.map((r) => {
        const transformed = transformLeadForActor(
          {
            id: r.id,
            pipeline_id: r.pipeline_id,
            round_id: r.round_id,
            round_name: r.round_name || null,
            name: r.name,
            phone: r.phone,
            email: r.email,
            source: r.source,
            campaign: r.campaign,
            product_interest: r.product_interest,
            budget_range: r.budget_range,
            utm_source: r.utm_source,
            ad_id: r.ad_id,
            campaign_id: r.campaign_id,
            ai_screener_status: r.ai_screener_status,
            ai_evaluation: r.ai_evaluation,
            status: r.status,
            lifecycle_stage: r.lifecycle_stage,
            lead_score: Number(r.lead_score || 0),
            email_consent: r.email_consent,
            zns_consent: r.zns_consent,
            total_revenue_vnd: Number(r.total_revenue_vnd || 0),
            last_engaged_at: r.last_engaged_at,
            custom_fields: r.custom_fields,
            stage: r.stage_id
              ? {
                  id: r.stage_id,
                  key: r.stage_key,
                  name: r.stage_name,
                  color: r.color_hex,
                  capi_event: r.capi_event_mapping,
                }
              : null,
            assigned_sale: r.assigned_to
              ? { id: r.assigned_to, name: r.assigned_sale_name, email: r.assigned_sale_email }
              : null,
            is_accepted: r.is_accepted,
            accepted_at: r.accepted_at,
            sla_breached: r.sla_breached,
            is_duplicate_reminder: r.is_duplicate_reminder,
            quality_status: r.quality_status,
            created_at: r.created_at,
            updated_at: r.updated_at,
          },
          ctx,
          cfg,
          canUnmaskPhone
        );
        return transformed;
      });

      const total = countRes.rows[0]?.total || 0;
      return {
        items,
        pagination: {
          total,
          page,
          total_pages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_LEADS_FAILED', err?.message || 'Không thể tải danh sách khách hàng.');
  }
});

function escapeCsvCell(val: unknown): string {
  const s =
    val === null || val === undefined
      ? ''
      : typeof val === 'object'
        ? JSON.stringify(val)
        : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Op 18: Export Lead Data CSV (Tenant Admin by default; Manager if `allow_manager_export_csv` enabled)
leadsRouter.get('/export', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.query.pipeline_id ? String(req.query.pipeline_id).trim() : null;

    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const rbacExport = await withTenantTransaction(ctx.tenantId, (client) =>
      resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId)
    );
    const leadPerm = rbacExport.effectivePermissions.leads;
    const canExport =
      Boolean(leadPerm?.actions.export) ||
      ctx.userRole === 'tenant_admin' ||
      (ctx.userRole === 'manager' && cfg.role_permissions.allow_manager_export_csv);
    const canUnmaskExport = leadPerm ? Boolean(leadPerm.actions.unmask_phone) : true;

    if (!canExport) {
      sendApiError(res, 403, 'FORBIDDEN_ROLE', `Vai trò '${ctx.userRole}' không có quyền thực hiện tác vụ này.`);
      return;
    }

    const maxExportRows = Math.min(50_000, Math.max(10, cfg.max_export_rows || 5000));
    const EXPORT_BATCH_SIZE = 1000;

    type ExportLeadRow = {
      id: string;
      name: string;
      phone: string;
      email: string | null;
      source: string;
      campaign: string | null;
      status: string;
      stage_name: string | null;
      assigned_sale_name: string | null;
      is_accepted: boolean;
      sla_breached: boolean;
      quality_status: string;
      custom_fields: Record<string, unknown> | null;
      created_at: string;
    };

    const fetchExportBatch = async (
      batchLimit: number,
      cursor?: { createdAt: string; id: string },
      includeCustomKeys = false
    ): Promise<{ rows: ExportLeadRow[]; customKeys: string[] }> =>
      withTenantTransaction(ctx.tenantId, async (client) => {
        const params: unknown[] = [ctx.tenantId];
        let where = 'l.tenant_id = $1 AND l.is_deleted = false';
        if (pipelineId) {
          params.push(pipelineId);
          where += ` AND l.pipeline_id = $${params.length}`;
        }
        if (cursor) {
          params.push(cursor.createdAt, cursor.id);
          const tsIdx = params.length - 1;
          const idIdx = params.length;
          where += ` AND (l.created_at < $${tsIdx}::timestamptz OR (l.created_at = $${tsIdx}::timestamptz AND l.id < $${idIdx}::uuid))`;
        }
        params.push(batchLimit);

        const r = await client.query<ExportLeadRow>(
          `SELECT l.id, l.name, l.phone, l.email, l.source, l.campaign, l.status,
                  s.stage_name, u.full_name AS assigned_sale_name,
                  l.is_accepted, l.sla_breached, l.quality_status, l.custom_fields, l.created_at
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           WHERE ${where}
           ORDER BY l.created_at DESC, l.id DESC
           LIMIT $${params.length}`,
          params
        );

        let customKeys: string[] = [];
        if (includeCustomKeys) {
          const cfRes = await client.query<{ field_key: string }>(
            `SELECT DISTINCT field_key FROM tenant_pipeline_custom_fields WHERE tenant_id = $1 ORDER BY field_key ASC`,
            [ctx.tenantId]
          );
          customKeys = cfRes.rows.map((c) => c.field_key);
        }
        return { rows: r.rows, customKeys };
      });

    const initialLimit = Math.min(EXPORT_BATCH_SIZE, maxExportRows);
    const firstBatch = await fetchExportBatch(initialLimit, undefined, true);
    const customKeys = firstBatch.customKeys;

    const useMachineHeaders = String(req.query.header_style || '').toLowerCase() === 'machine';
    const headers = useMachineHeaders
      ? [
          'lead_id',
          'name',
          'phone',
          'email',
          'source',
          'campaign',
          'stage',
          'assigned_sale',
          'status',
          'is_accepted',
          'sla_breached',
          'quality_status',
          ...customKeys.map((k) => `cf_${k}`),
          'created_at',
        ]
      : [
          'ID',
          'Khách hàng',
          'Số điện thoại',
          'Email',
          'Nguồn',
          'Chiến dịch',
          'Bước Pipeline',
          'Sale phụ trách',
          'Trạng thái',
          'Đã tiếp nhận',
          'Quá hạn SLA',
          'Chất lượng Data',
          ...customKeys.map((k) => `cf_${k}`),
          'Ngày tạo',
        ];

    const formatRowsChunk = (rows: ExportLeadRow[]): string => {
      if (rows.length === 0) return '';
      return rows
        .map((r) =>
          [
            r.id,
            r.name,
            canUnmaskExport ? r.phone || '' : maskPhoneString(r.phone, cfg),
            canUnmaskExport ? r.email || '' : maskEmailString(r.email, cfg) || '',
            r.source,
            r.campaign || '',
            r.stage_name || '',
            r.assigned_sale_name || '',
            r.status,
            r.is_accepted ? 'true' : 'false',
            r.sla_breached ? 'true' : 'false',
            r.quality_status,
            ...customKeys.map((k) => (r.custom_fields ? r.custom_fields[k] : '')),
            r.created_at,
          ]
            .map(escapeCsvCell)
            .join(',')
        )
        .join('\r\n');
    };

    const useGzip =
      req.method !== 'HEAD' &&
      acceptsGzipEncoding(String(req.headers['accept-encoding'] || '')) &&
      firstBatch.rows.length > 8;

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leads-${ctx.tenantSlug}-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.vary('Accept-Encoding');

    const gzipStream = useGzip ? zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED }) : null;
    if (gzipStream) {
      res.setHeader('Content-Encoding', 'gzip');
      gzipStream.pipe(res);
    }
    const sink: NodeJS.WritableStream = gzipStream || res;

    const writeChunk = async (chunk: string): Promise<void> => {
      if (!chunk || res.writableEnded || res.destroyed) return;
      if (!sink.write(chunk)) {
        await once(sink, 'drain');
      }
    };

    const firstRowsCsv = formatRowsChunk(firstBatch.rows);
    await writeChunk(`\uFEFF${headers.join(',')}${firstRowsCsv ? `\r\n${firstRowsCsv}` : ''}`);

    let exportedCount = firstBatch.rows.length;
    let lastRow = firstBatch.rows[firstBatch.rows.length - 1];

    while (
      lastRow &&
      firstBatch.rows.length === initialLimit &&
      exportedCount < maxExportRows &&
      !res.writableEnded &&
      !res.destroyed
    ) {
      const nextLimit = Math.min(EXPORT_BATCH_SIZE, maxExportRows - exportedCount);
      const rawTs: unknown = lastRow.created_at;
      const nextBatch = await fetchExportBatch(nextLimit, {
        createdAt: rawTs instanceof Date ? rawTs.toISOString() : String(rawTs),
        id: lastRow.id,
      });
      if (nextBatch.rows.length === 0) break;
      await writeChunk(`\r\n${formatRowsChunk(nextBatch.rows)}`);
      exportedCount += nextBatch.rows.length;
      lastRow = nextBatch.rows[nextBatch.rows.length - 1];
      if (nextBatch.rows.length < nextLimit) break;
    }

    await new Promise<void>((resolve, reject) => {
      res.once('finish', resolve);
      res.once('close', resolve);
      res.once('error', reject);
      sink.end();
    });
  } catch (err: any) {
    if (!res.headersSent) {
      sendApiError(res, 500, 'EXPORT_LEADS_FAILED', err?.message || 'Không thể xuất file CSV danh sách khách hàng.');
    } else {
      res.destroy();
    }
  }
});

// Op 12: Create or Bulk Import Leads (Tenant Admin & Manager; Sale if `allow_sale_create_lead` enabled)
leadsRouter.post('/', async (req, res) => {
  try {
    const ctx = getTenantContext();

    const tenantCfg = await getTenantSettingsCached(ctx.tenantId);
    const tenantRolePerms = tenantCfg.role_permissions;

    if (ctx.userRole !== 'tenant_admin' && ctx.userRole !== 'manager' && !tenantRolePerms.allow_sale_create_lead) {
      sendApiError(res, 403, 'FORBIDDEN_ROLE', `Vai trò '${ctx.userRole}' không có quyền thực hiện tác vụ này.`);
      return;
    }

    const resolveForcedAssignee = (rawItem: Record<string, unknown>): string | undefined => {
      const rawAssignee = rawItem.force_assigned_to || rawItem.assigned_to;
      const cleanAssignee = typeof rawAssignee === 'string' && rawAssignee.trim() ? rawAssignee.trim() : undefined;
      if (ctx.userRole === 'sale') {
        if (cleanAssignee && cleanAssignee !== ctx.userId && tenantRolePerms.allow_sale_reassign_lead) {
          return cleanAssignee;
        }
        return ctx.userId;
      }
      return cleanAssignee;
    };

    const formatIngestResult = (r: Awaited<ReturnType<typeof ingestAndDistributeLead>>) => ({
      ...r,
      id: r.leadId,
      lead_id: r.leadId,
      phone_normalized: r.phoneNormalized,
      assigned_to: r.assignedTo,
      assigned_name: r.assignedName,
      is_duplicate_reminder: r.isDuplicateReminder,
      dispatch_reason: r.dispatchReason,
      distribution_type: r.dispatchReason,
      distribution_latency_ms: r.distributionLatencyMs,
    });

    const body = req.body || {};

    // Marketing Nurture / Email-Only Master Contact Creation (bypasses Sale distribution queue!)
    const isMarketingNurture =
      body.status === 'marketing_nurture' ||
      body.nurture_only === true ||
      (!body.phone && Boolean(body.email));

    if (isMarketingNurture && !Array.isArray(body.items)) {
      const createdContact = await withTenantTransaction(ctx.tenantId, async (client) => {
        const upserted = await upsertMasterContactInTx(client, ctx.tenantId, body, {
          defaultStatus: 'marketing_nurture',
          defaultSource: body.source || 'Marketing Form',
          dialCode: tenantCfg.default_dial_code,
        });
        const r = await client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          upserted.leadId,
        ]);
        return { lead: r.rows[0], created: upserted.created };
      });

      await emitDomainEvent(createdContact.created ? 'lead.created' : 'lead.updated', {
        tenantId: ctx.tenantId,
        leadId: createdContact.lead.id,
        status: 'marketing_nurture',
        lifecycleStage: createdContact.lead.lifecycle_stage,
        source: createdContact.lead.source,
        actorId: ctx.userId,
      });

      res.status(201).json({
        success: true,
        data: {
          ...createdContact.lead,
          leadId: createdContact.lead.id,
          lead_id: createdContact.lead.id,
          status: 'marketing_nurture',
          assignedTo: null,
          assigned_to: null,
        },
      });
      return;
    }

    if (Array.isArray(body.items)) {
      const results = [];
      const errors = [];
      for (const item of body.items) {
        try {
          const forcedAssignee = resolveForcedAssignee(item || {});
          const payloadItem = forcedAssignee ? { ...item, force_assigned_to: forcedAssignee } : item;
          const r = await ingestAndDistributeLead(ctx.tenantId, payloadItem);
          results.push(formatIngestResult(r));
          enqueueOutboundWebhookEvent({
            tenantId: ctx.tenantId,
            eventType: 'lead.created',
            payload: { lead_id: r.leadId, status: r.status, assigned_to: r.assignedTo },
          });
          await emitDomainEvent('lead.created', {
            tenantId: ctx.tenantId,
            leadId: r.leadId,
            status: r.status,
            actorId: ctx.userId,
          });
        } catch (e: any) {
          errors.push({ phone: item?.phone, error: e?.message });
        }
      }
      res.status(201).json({
        success: true,
        data: { imported_count: results.length, failed_count: errors.length, items: results, errors },
      });
      return;
    }

    const forcedAssignee = resolveForcedAssignee(body);
    const singleInput = forcedAssignee ? { ...body, force_assigned_to: forcedAssignee } : body;

    const result = await ingestAndDistributeLead(ctx.tenantId, singleInput);
    enqueueOutboundWebhookEvent({
      tenantId: ctx.tenantId,
      eventType: 'lead.created',
      payload: { lead_id: result.leadId, status: result.status, assigned_to: result.assignedTo },
    });
    await emitDomainEvent('lead.created', {
      tenantId: ctx.tenantId,
      leadId: result.leadId,
      status: result.status,
      actorId: ctx.userId,
    });

    res.status(201).json({ success: true, data: formatIngestResult(result) });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('SUBSCRIPTION_EXPIRED')) {
      sendApiError(res, 402, 'SUBSCRIPTION_EXPIRED', msg);
      return;
    }
    if (msg.startsWith('PLAN_QUOTA_EXCEEDED')) {
      sendApiError(res, 402, 'PLAN_QUOTA_EXCEEDED', msg);
      return;
    }
    if (msg.startsWith('DUPLICATE_LEAD_REJECTED')) {
      sendApiError(res, 409, 'DUPLICATE_LEAD_REJECTED', msg);
      return;
    }
    const isValidation = msg.startsWith('INVALID_PHONE') || msg.startsWith('CUSTOM_FIELD');
    sendApiError(res, isValidation ? 422 : 500, 'INGEST_LEAD_FAILED', msg || 'Không thể tạo khách hàng mới.');
  }
});

// Update Lead Profile & Custom Fields (`PATCH /leads/:id`)
leadsRouter.patch('/:id', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;
    const {
      name,
      email,
      source,
      campaign,
      quality_status,
      custom_fields,
      lifecycle_stage,
      lead_score,
      email_consent,
      zns_consent,
      total_revenue_vnd,
    } = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const leadRes = await client.query<{
        id: string;
        pipeline_id: string | null;
        assigned_to: string | null;
        custom_fields: Record<string, unknown> | null;
      }>(
        'SELECT id, pipeline_id, assigned_to, custom_fields FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, leadId]
      );
      const lead = leadRes.rows[0];
      if (!lead) throw new Error('LEAD_NOT_FOUND');
      if (ctx.userRole === 'sale' && lead.assigned_to !== ctx.userId) {
        throw new Error('FORBIDDEN_NOT_ASSIGNED');
      }

      let nextCustomFields: Record<string, unknown> | null = null;
      if (custom_fields && typeof custom_fields === 'object') {
        if (lead.pipeline_id) {
          const cfDefs = await client.query<{
            field_key: string;
            field_label: string;
            field_type: string;
            is_required: boolean;
            options_json: string[];
            config_json: Record<string, unknown>;
          }>(
            `SELECT field_key, field_label, field_type, is_required, options_json, config_json
             FROM tenant_pipeline_custom_fields
             WHERE tenant_id = $1 AND pipeline_id = $2`,
            [ctx.tenantId, lead.pipeline_id]
          );
          const merged = { ...(lead.custom_fields || {}), ...(custom_fields as Record<string, unknown>) };
          nextCustomFields = validateAndSanitizeCustomFields(cfDefs.rows, merged);
        } else {
          nextCustomFields = { ...(lead.custom_fields || {}), ...(custom_fields as Record<string, unknown>) };
        }
      }

      const [cfg, rbac] = await Promise.all([
        getTenantSettingsCached(ctx.tenantId, client),
        resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId),
      ]);

      const r = await client.query(
        `UPDATE leads
         SET name = COALESCE($3, name),
             email = CASE WHEN $4::boolean THEN $5 ELSE email END,
             source = COALESCE($6, source),
             campaign = CASE WHEN $7::boolean THEN $8 ELSE campaign END,
             quality_status = COALESCE($9, quality_status),
             custom_fields = COALESCE($10::jsonb, custom_fields),
             lifecycle_stage = COALESCE($11, lifecycle_stage),
             lead_score = COALESCE($12, lead_score),
             email_consent = COALESCE($13, email_consent),
             zns_consent = COALESCE($14, zns_consent),
             total_revenue_vnd = COALESCE($15, total_revenue_vnd),
             last_engaged_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          leadId,
          name ? String(name).trim() : null,
          email !== undefined,
          email ? String(email).trim() : null,
          source ? String(source).trim() : null,
          campaign !== undefined,
          campaign ? String(campaign).trim() : null,
          quality_status ? String(quality_status).trim() : null,
          nextCustomFields ? JSON.stringify(nextCustomFields) : null,
          lifecycle_stage ? String(lifecycle_stage).trim() : null,
          typeof lead_score === 'number' ? Math.round(lead_score) : null,
          email_consent ? String(email_consent).trim() : null,
          zns_consent ? String(zns_consent).trim() : null,
          typeof total_revenue_vnd === 'number' ? Math.round(total_revenue_vnd) : null,
        ]
      );

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'lead_updated', 'note', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          ctx.tenantId,
          leadId,
          ctx.userId,
          ctx.userRole,
          ctx.userName || 'Staff',
          'Cập nhật thông tin hồ sơ & trường dữ liệu khách hàng',
          null,
          JSON.stringify({ updated_custom_fields: Boolean(nextCustomFields) }),
        ]
      );

      return transformLeadForActor(
        r.rows[0],
        ctx,
        cfg,
        rbac.effectivePermissions.leads?.actions.unmask_phone
      );
    });

    await emitDomainEvent('lead.updated', {
      tenantId: ctx.tenantId,
      leadId,
      actorId: ctx.userId,
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg === 'FORBIDDEN_NOT_ASSIGNED') {
      sendApiError(res, 403, 'FORBIDDEN_LEAD_ACCESS', 'Bạn chỉ được phép chỉnh sửa khách hàng được phân bổ cho mình.');
      return;
    }
    if (msg === 'LEAD_NOT_FOUND') {
      sendApiError(res, 404, 'LEAD_NOT_FOUND', 'Không tìm thấy khách hàng.');
      return;
    }
    if (msg.startsWith('CUSTOM_FIELD')) {
      sendApiError(res, 422, 'CUSTOM_FIELD_VALIDATION_ERROR', msg);
      return;
    }
    sendApiError(res, 500, 'UPDATE_LEAD_FAILED', msg || 'Không thể cập nhật thông tin khách hàng.');
  }
});

// 5.2 Transition Lead Stage & Auto-Trigger Meta CAPI (Op 16)
leadsRouter.patch('/:id/stage', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;
    const { stage_id, note, deal_value_vnd, deal_value } = req.body || {};

    if (!stage_id) {
      sendApiError(res, 422, 'MISSING_STAGE_ID', 'Vui lòng chọn bước Pipeline cần chuyển.');
      return;
    }

    const txState = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);

      const leadRes = await client.query<{
        id: string;
        stage_id: string;
        assigned_to: string | null;
        name: string;
        phone: string;
        email: string | null;
        product_interest: string | null;
        budget_range: string | null;
        source: string | null;
        campaign: string | null;
        utm_source: string | null;
        meta_lead_id: string | null;
        fbclid: string | null;
        fbc: string | null;
        fbp: string | null;
        custom_fields: Record<string, unknown> | null;
        old_stage_key: string;
        old_stage_name: string;
      }>(
        `SELECT l.id, l.stage_id, l.assigned_to, l.name, l.phone, l.email,
                l.product_interest, l.budget_range, l.source, l.campaign, l.utm_source,
                l.meta_lead_id, l.fbclid, l.fbc, l.fbp, l.custom_fields,
                s.stage_key AS old_stage_key, s.stage_name AS old_stage_name
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE l.tenant_id = $1 AND l.id = $2
         FOR UPDATE OF l`,
        [ctx.tenantId, leadId]
      );
      const lead = leadRes.rows[0];
      if (!lead) {
        throw new Error('LEAD_NOT_FOUND');
      }

      if (ctx.userRole === 'sale' && lead.assigned_to !== ctx.userId) {
        throw new Error('FORBIDDEN_NOT_ASSIGNED');
      }

      const targetStageRes = await client.query<{
        id: string;
        pipeline_id: string;
        stage_key: string;
        stage_name: string;
        capi_event_mapping: string;
        sla_timeout_minutes: number;
        score_delta: number;
        required_fields: string[] | null;
        is_won_stage: boolean;
        is_lost_stage: boolean;
      }>(
        `SELECT id, pipeline_id, stage_key, stage_name, capi_event_mapping, sla_timeout_minutes,
                score_delta, required_fields, is_won_stage, is_lost_stage
         FROM tenant_pipeline_stages
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [ctx.tenantId, stage_id]
      );
      const targetStage = targetStageRes.rows[0];
      if (!targetStage) {
        throw new Error('TARGET_STAGE_NOT_FOUND');
      }

      // Enforce Stage-level & Dynamic Stage Transition Rules (`tenant_stage_transition_rules`)
      const stageReqFields = Array.isArray(targetStage.required_fields) ? targetStage.required_fields : [];
      for (const fKey of stageReqFields) {
        const cf = lead.custom_fields || {};
        const topVal = (lead as any)[fKey];
        const cfVal = cf[fKey];
        if (
          (topVal === undefined || topVal === null || String(topVal).trim() === '') &&
          (cfVal === undefined || cfVal === null || String(cfVal).trim() === '')
        ) {
          throw new Error(`STAGE_RULE_FIELD_REQUIRED:${fKey}`);
        }
      }

      const rulesRes = await client.query<{
        required_fields: string[];
        allowed_role_ids: string[];
        allowed_roles: string[];
        require_note: boolean;
        score_delta: number;
      }>(
        `SELECT required_fields, allowed_role_ids, allowed_roles, require_note, score_delta
         FROM tenant_stage_transition_rules
         WHERE tenant_id = $1
           AND to_stage_id = $2
           AND is_active = true
           AND (from_stage_id IS NULL OR from_stage_id = $3)`,
        [ctx.tenantId, targetStage.id, lead.stage_id]
      );

      let actorRoleResolved = false;
      let actorIsTenantOwner = false;
      let actorEffectiveRoleId: string | null = null;

      let extraRuleScoreDelta = 0;
      for (const rule of rulesRes.rows) {
        if (rule.require_note && (!note || !String(note).trim())) {
          throw new Error('STAGE_RULE_NOTE_REQUIRED');
        }
        const reqFields = Array.isArray(rule.required_fields) ? rule.required_fields : [];
        for (const fKey of reqFields) {
          const cf = lead.custom_fields || {};
          const topVal = (lead as any)[fKey];
          const cfVal = cf[fKey];
          if (
            (topVal === undefined || topVal === null || String(topVal).trim() === '') &&
            (cfVal === undefined || cfVal === null || String(cfVal).trim() === '')
          ) {
            throw new Error(`STAGE_RULE_FIELD_REQUIRED:${fKey}`);
          }
        }

        const hasRoleIdGate = Array.isArray(rule.allowed_role_ids) && rule.allowed_role_ids.length > 0;
        const hasRoleKeyGate = Array.isArray(rule.allowed_roles) && rule.allowed_roles.length > 0;
        if ((hasRoleIdGate || hasRoleKeyGate) && ctx.userRole !== 'tenant_admin') {
          if (!actorRoleResolved) {
            actorRoleResolved = true;
            const uRoleRes = await client.query<{ is_tenant_owner: boolean; role_id: string | null; role: string }>(
              'SELECT is_tenant_owner, role_id, role FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
              [ctx.tenantId, ctx.userId]
            );
            const uRow = uRoleRes.rows[0];
            actorIsTenantOwner = Boolean(uRow?.is_tenant_owner);
            actorEffectiveRoleId = uRow?.role_id || null;
            if (!actorEffectiveRoleId && (uRow?.role || ctx.userRole)) {
              const rLookup = await client.query<{ id: string }>(
                'SELECT id FROM tenant_roles WHERE tenant_id = $1 AND LOWER(role_key) = LOWER($2) LIMIT 1',
                [ctx.tenantId, uRow?.role || ctx.userRole]
              );
              actorEffectiveRoleId = rLookup.rows[0]?.id || null;
            }
          }
          if (!actorIsTenantOwner) {
            const passById = hasRoleIdGate && actorEffectiveRoleId ? rule.allowed_role_ids.includes(actorEffectiveRoleId) : false;
            const passByKey = hasRoleKeyGate ? rule.allowed_roles.includes(ctx.userRole) : false;
            if (hasRoleIdGate && hasRoleKeyGate) {
              if (!passById && !passByKey) {
                throw new Error('STAGE_RULE_ROLE_FORBIDDEN');
              }
            } else if (hasRoleIdGate && !passById) {
              throw new Error('STAGE_RULE_ROLE_FORBIDDEN');
            } else if (hasRoleKeyGate && !passByKey) {
              throw new Error('STAGE_RULE_ROLE_FORBIDDEN');
            }
          }
        }
        extraRuleScoreDelta += Number(rule.score_delta || 0);
      }

      const totalScoreDelta = Number(targetStage.score_delta || 0) + extraRuleScoreDelta;
      const nextQuality = targetStage.is_won_stage
        ? 'Won'
        : targetStage.is_lost_stage
          ? 'Disqualified'
          : 'Qualified';

      const explicitDealValNum =
        typeof deal_value === 'number'
          ? deal_value
          : typeof deal_value_vnd === 'number'
            ? deal_value_vnd
            : 0;
      const addedRevenue = targetStage.is_won_stage && explicitDealValNum > 0 ? Math.round(explicitDealValNum) : 0;

      await client.query(
        `UPDATE leads
         SET pipeline_id = COALESCE(pipeline_id, $5),
             stage_id = $3,
             is_accepted = true,
             accepted_at = COALESCE(accepted_at, clock_timestamp()),
             quality_status = $4,
             lifecycle_stage = CASE
               WHEN $6::boolean THEN 'customer'
               WHEN $7::boolean THEN 'disqualified'
               ELSE lifecycle_stage
             END,
             lead_score = lead_score + $8,
             total_revenue_vnd = total_revenue_vnd + $9,
             last_engaged_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          leadId,
          targetStage.id,
          nextQuality,
          targetStage.pipeline_id,
          Boolean(targetStage.is_won_stage),
          Boolean(targetStage.is_lost_stage),
          totalScoreDelta,
          addedRevenue,
        ]
      );

      const effectiveStageSla =
        Number(targetStage.sla_timeout_minutes) > 0
          ? Number(targetStage.sla_timeout_minutes)
          : cfg.use_default_sla_fallback && !targetStage.is_won_stage && !targetStage.is_lost_stage
            ? cfg.default_sla_minutes
            : 0;

      const explicitDealVal =
        typeof deal_value === 'number'
          ? deal_value
          : typeof deal_value_vnd === 'number'
            ? deal_value_vnd
            : undefined;

      // Append immutable stage_transition timeline event inside the short row-locked transaction
      const tlRes = await client.query<{ id: string }>(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'stage_transition', 'pipeline', $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING id`,
        [
          ctx.tenantId,
          leadId,
          ctx.userId,
          ctx.userRole,
          ctx.userName || 'Staff',
          `Chuyển bước: ${lead.old_stage_name || 'Trước'} → ${targetStage.stage_name}`,
          note ? String(note).trim() : null,
          JSON.stringify({
            previous_stage_key: lead.old_stage_key,
            current_stage_key: targetStage.stage_key,
            deal_value_vnd: explicitDealVal ?? null,
          }),
        ]
      );

      return {
        cfg,
        lead,
        targetStage,
        effectiveStageSla,
        explicitDealVal,
        timelineEventId: tlRes.rows[0].id,
      };
    });

    // Clear previous stage SLA timer & schedule next SLA timer outside the DB row lock
    await tenantRedis.zrem('sla_queue', `${leadId}:${txState.lead.stage_id}`, ctx.tenantId);
    if (
      txState.effectiveStageSla > 0 &&
      !txState.targetStage.is_won_stage &&
      !txState.targetStage.is_lost_stage
    ) {
      const deadlineMs = Date.now() + txState.effectiveStageSla * 60_000;
      await tenantRedis.zadd('sla_queue', deadlineMs, `${leadId}:${txState.targetStage.id}`, ctx.tenantId);
    }

    // Auto-trigger Meta Conversions API completely outside any DB transaction / row lock
    let capiDispatched = null;
    if (txState.targetStage.capi_event_mapping && txState.targetStage.capi_event_mapping !== 'Skip') {
      const capiRes = await dispatchStageCapiEventDetached({
        tenantId: ctx.tenantId,
        tenantSlug: ctx.tenantSlug,
        eventName: txState.targetStage.capi_event_mapping,
        tenantSettings: txState.cfg,
        lead: {
          leadId: txState.lead.id,
          name: txState.lead.name,
          phone: txState.lead.phone,
          email: txState.lead.email,
          metaLeadId: txState.lead.meta_lead_id,
          fbclid: txState.lead.fbclid,
          fbc: txState.lead.fbc,
          fbp: txState.lead.fbp,
          dealValue: txState.explicitDealVal,
          customFields: txState.lead.custom_fields,
        },
        timelineAudit: {
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          stageName: txState.targetStage.stage_name,
        },
      });
      capiDispatched = {
        event_name: capiRes.event_name,
        event_id: capiRes.event_id,
        status: capiRes.status,
        http_status: capiRes.status,
        status_label: capiRes.status_label,
        fbtrace_id: capiRes.fbtrace_id,
        currency: capiRes.currency,
        value: capiRes.value,
      };
    }

    const outcome = {
      lead_id: leadId,
      previous_stage: txState.lead.old_stage_key,
      current_stage: txState.targetStage.stage_key,
      timeline_event_id: txState.timelineEventId,
      capi_dispatched: capiDispatched,
    };

    enqueueOutboundWebhookEvent({
      tenantId: ctx.tenantId,
      eventType: 'lead.stage_changed',
      payload: outcome as unknown as Record<string, unknown>,
    });

    await emitDomainEvent('lead.stage_changed', {
      tenantId: ctx.tenantId,
      leadId,
      pipelineId: txState.targetStage.pipeline_id,
      previousStageId: txState.lead.stage_id,
      currentStageId: txState.targetStage.id,
      currentStageKey: txState.targetStage.stage_key,
      isWonStage: Boolean(txState.targetStage.is_won_stage),
      willEmitDealWon: Boolean(txState.targetStage.is_won_stage),
      dealValueVnd: txState.explicitDealVal ?? null,
      actorId: ctx.userId,
    });

    if (txState.targetStage.is_won_stage) {
      await emitDomainEvent('deal.won', {
        tenantId: ctx.tenantId,
        leadId,
        amountVnd: Math.max(0, Number(txState.explicitDealVal || 0)),
        sourceEntity: 'lead_stage',
        actorId: ctx.userId,
      });
    }

    res.json({ success: true, data: outcome });
  } catch (err: any) {
    const errMsg = String(err?.message || '');
    if (errMsg === 'STAGE_RULE_NOTE_REQUIRED') {
      sendApiError(res, 422, 'STAGE_RULE_NOTE_REQUIRED', 'Luật chuyển bước bắt buộc nhập ghi chú khi chuyển sang bước này.');
      return;
    }
    if (errMsg.startsWith('STAGE_RULE_FIELD_REQUIRED:')) {
      const f = errMsg.split(':')[1] || '';
      sendApiError(res, 422, 'STAGE_RULE_FIELD_REQUIRED', `Vui lòng điền đầy đủ trường bắt buộc '${f}' trước khi chuyển bước.`);
      return;
    }
    if (errMsg === 'STAGE_RULE_ROLE_FORBIDDEN') {
      sendApiError(res, 403, 'STAGE_RULE_ROLE_FORBIDDEN', 'Vai trò của bạn không được phép chuyển hồ sơ vào bước này.');
      return;
    }
    if (err?.message === 'FORBIDDEN_NOT_ASSIGNED') {
      sendApiError(res, 403, 'FORBIDDEN_LEAD_ACCESS', 'Bạn chỉ được phép cập nhật khách hàng được phân bổ cho mình.');
      return;
    }
    if (err?.message === 'LEAD_NOT_FOUND' || err?.message === 'TARGET_STAGE_NOT_FOUND') {
      sendApiError(res, 404, err.message, 'Không tìm thấy khách hàng hoặc bước Pipeline.');
      return;
    }
    sendApiError(res, 500, 'STAGE_TRANSITION_FAILED', err?.message || 'Không thể chuyển bước Pipeline.');
  }
});

// 5.3 Accept Lead ("Tiếp Nhận Data")
leadsRouter.post('/:id/accept', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const leadRes = await client.query<{
        id: string;
        stage_id: string;
        assigned_to: string | null;
        created_at: string;
      }>(
        'SELECT id, stage_id, assigned_to, created_at FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, leadId]
      );
      const lead = leadRes.rows[0];
      if (!lead) throw new Error('LEAD_NOT_FOUND');
      if (ctx.userRole === 'sale' && lead.assigned_to !== ctx.userId) {
        throw new Error('FORBIDDEN_NOT_ASSIGNED');
      }

      const acceptedAt = new Date().toISOString();
      const latencySeconds = Math.max(1, Math.round((Date.now() - new Date(lead.created_at).getTime()) / 1000));

      await client.query(
        `UPDATE leads
         SET is_accepted = true, accepted_at = $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, leadId, acceptedAt]
      );

      await tenantRedis.zrem('sla_queue', `${leadId}:${lead.stage_id}`, ctx.tenantId);

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'lead_accepted', 'communication', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          ctx.tenantId,
          leadId,
          ctx.userId,
          ctx.userRole,
          ctx.userName || 'Sale',
          `Đã bấm Tiếp Nhận Data (Phản hồi sau ${latencySeconds}s)`,
          'Bắt đầu quy trình gọi điện tư vấn khách hàng.',
          JSON.stringify({ response_latency_seconds: latencySeconds }),
        ]
      );

      return {
        lead_id: leadId,
        is_accepted: true,
        response_latency_seconds: latencySeconds,
        accepted_at: acceptedAt,
      };
    });

    enqueueOutboundWebhookEvent({
      tenantId: ctx.tenantId,
      eventType: 'lead.accepted',
      payload: data as unknown as Record<string, unknown>,
    });

    res.json({ success: true, data });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_NOT_ASSIGNED') {
      sendApiError(res, 403, 'FORBIDDEN_NOT_ASSIGNED', 'Bạn không phải người phụ trách khách hàng này.');
      return;
    }
    if (err?.message === 'LEAD_NOT_FOUND') {
      sendApiError(res, 404, 'LEAD_NOT_FOUND', 'Không tìm thấy khách hàng.');
      return;
    }
    sendApiError(res, 500, 'ACCEPT_LEAD_FAILED', err?.message || 'Không thể tiếp nhận khách hàng.');
  }
});

// Op 17: Reassign Lead (Tenant Admin & Manager; Sale on own lead if `allow_sale_reassign_lead` enabled)
leadsRouter.post('/:id/reassign', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;
    const { target_user_id, reason } = req.body || {};
    if (!target_user_id) {
      sendApiError(res, 422, 'MISSING_TARGET_USER', 'Vui lòng chọn nhân sự nhận bàn giao.');
      return;
    }

    const { data, slaMember, slaDeadlineMs } = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);

      if (ctx.userRole !== 'tenant_admin' && ctx.userRole !== 'manager') {
        if (!cfg.role_permissions.allow_sale_reassign_lead) {
          throw new Error('FORBIDDEN_ROLE');
        }
        const ownCheck = await client.query<{ assigned_to: string | null }>(
          'SELECT assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, leadId]
        );
        if (!ownCheck.rows[0] || ownCheck.rows[0].assigned_to !== ctx.userId) {
          throw new Error('FORBIDDEN_ROLE');
        }
      }

      const uRes = await client.query<{ id: string; full_name: string }>(
        'SELECT id, full_name FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, target_user_id]
      );
      if (!uRes.rows[0]) throw new Error('TARGET_USER_NOT_FOUND');

      const lRes = await client.query<{ id: string; stage_id: string }>(
        `UPDATE leads
         SET assigned_to = $3, status = 'assigned', is_accepted = false, accepted_at = NULL, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING id, stage_id`,
        [ctx.tenantId, leadId, target_user_id]
      );
      if (!lRes.rows[0]) throw new Error('LEAD_NOT_FOUND');

      const stageRes = await client.query<{
        sla_timeout_minutes: number;
        is_won_stage: boolean;
        is_lost_stage: boolean;
      }>(
        `SELECT sla_timeout_minutes, is_won_stage, is_lost_stage
         FROM tenant_pipeline_stages
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [ctx.tenantId, lRes.rows[0].stage_id]
      );
      const st = stageRes.rows[0];
      const effectiveSla =
        st && !st.is_won_stage && !st.is_lost_stage
          ? Number(st.sla_timeout_minutes) > 0
            ? Number(st.sla_timeout_minutes)
            : cfg.use_default_sla_fallback
              ? cfg.default_sla_minutes
              : 0
          : 0;

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'lead_reassigned', 'system', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          ctx.tenantId,
          leadId,
          ctx.userId,
          ctx.userRole,
          ctx.userName || 'Manager',
          `Điều chuyển khách hàng sang ${uRes.rows[0].full_name}`,
          reason ? String(reason).trim() : 'Điều phối thủ công bởi quản lý.',
          JSON.stringify({ target_user_id }),
        ]
      );

      return {
        data: { lead_id: leadId, assigned_to: target_user_id, assigned_name: uRes.rows[0].full_name },
        slaMember: `${leadId}:${lRes.rows[0].stage_id}`,
        slaDeadlineMs: effectiveSla > 0 ? Date.now() + effectiveSla * 60_000 : null,
      };
    });

    await tenantRedis.zrem('sla_queue', slaMember, ctx.tenantId);
    if (slaDeadlineMs) {
      await tenantRedis.zadd('sla_queue', slaDeadlineMs, slaMember, ctx.tenantId);
    }

    enqueueOutboundWebhookEvent({
      tenantId: ctx.tenantId,
      eventType: 'lead.assigned',
      payload: data as unknown as Record<string, unknown>,
    });

    res.json({ success: true, data });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_ROLE') {
      sendApiError(res, 403, 'FORBIDDEN_ROLE', `Vai trò '${getTenantContext().userRole}' không có quyền điều chuyển Lead.`);
      return;
    }
    sendApiError(res, 500, 'REASSIGN_FAILED', err?.message || 'Không thể điều chuyển khách hàng.');
  }
});

// 8.1 Query Lead Interaction Timeline Feed (Reverse-Chronological + Configurable Role/PII Masking)
leadsRouter.get('/:id/timeline', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;
    const category = req.query.category ? String(req.query.category) : null;
    const beforeTs = req.query.before_ts ? String(req.query.before_ts) : null;
    const rawReqLimit = Number(req.query.limit || 30);

    const events = await withTenantTransaction(ctx.tenantId, async (client) => {
      const leadCheck = await client.query<{ assigned_to: string | null; is_accepted: boolean }>(
        'SELECT assigned_to, is_accepted FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!leadCheck.rows[0]) {
        throw new Error('LEAD_NOT_FOUND');
      }
      if (ctx.userRole === 'sale' && leadCheck.rows[0].assigned_to !== ctx.userId) {
        throw new Error('FORBIDDEN_TIMELINE_ACCESS');
      }

      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const limit = Math.min(cfg.max_page_size, Math.max(1, Number.isFinite(rawReqLimit) ? rawReqLimit : 30));
      const maskActive = shouldMaskPiiForActor(ctx, cfg, leadCheck.rows[0]);
      const hideInternal = shouldHideInternalNotesForActor(ctx, cfg);

      const internalOnlyValues = Array.from(
        new Set([
          'INTERNAL_NOTE',
          ...cfg.note_types.filter((nt) => nt.internal_only).map((nt) => nt.value),
        ])
      );

      const params: unknown[] = [ctx.tenantId, leadId];
      let where = 'tenant_id = $1 AND lead_id = $2';
      if (category) {
        if (category === 'communication') {
          where += ` AND event_category IN ('communication', 'call')`;
        } else {
          params.push(category);
          where += ` AND event_category = $${params.length}`;
        }
      }
      if (beforeTs) {
        params.push(beforeTs);
        where += ` AND created_at < $${params.length}::timestamptz`;
      }
      if (hideInternal && internalOnlyValues.length > 0) {
        params.push(internalOnlyValues);
        where += ` AND NOT (COALESCE(metadata->>'note_category', '') = ANY($${params.length}::text[]))`;
      }

      params.push(limit);
      const rows = await client.query(
        `SELECT id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata, created_at
         FROM lead_timeline_events
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
      );

      return rows.rows.map((ev) => ({
        id: ev.id,
        event_type: ev.event_type,
        event_category: ev.event_category,
        actor: {
          id: ev.actor_id,
          name: ev.actor_name || 'System',
          role: ev.actor_role,
        },
        title: maskActive ? maskPiiInText(ev.title, cfg) : ev.title,
        content: maskActive ? maskPiiInText(ev.content, cfg) : ev.content,
        metadata: ev.metadata,
        created_at: ev.created_at,
      }));
    });

    res.json({ success: true, data: events });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_TIMELINE_ACCESS') {
      sendApiError(res, 403, 'FORBIDDEN_TIMELINE_ACCESS', 'Bạn không có quyền xem dòng thời gian của khách hàng này.');
      return;
    }
    if (err?.message === 'LEAD_NOT_FOUND') {
      sendApiError(res, 404, 'LEAD_NOT_FOUND', 'Không tìm thấy khách hàng.');
      return;
    }
    sendApiError(res, 500, 'TIMELINE_FETCH_FAILED', err?.message || 'Không thể tải lịch sử tương tác.');
  }
});

// 8.2 Append Sale Note to Timeline
leadsRouter.post('/:id/timeline/notes', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;
    const { category = 'note', note_type = 'CALL_CONNECTED', title, content, metadata = {} } = req.body || {};

    if (!title && !content) {
      sendApiError(res, 422, 'EMPTY_NOTE', 'Vui lòng nhập tiêu đề hoặc nội dung ghi chú tương tác.');
      return;
    }

    const allowedCategories = new Set(['pipeline', 'communication', 'call', 'zalo', 'note', 'system', 'ticket', 'capi']);
    const rawCat = String(category);
    const normalizedCat = allowedCategories.has(rawCat)
      ? rawCat === 'call' || rawCat === 'zalo'
        ? 'communication'
        : rawCat
      : 'note';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const leadCheck = await client.query<{ assigned_to: string | null; is_accepted: boolean }>(
        'SELECT assigned_to, is_accepted FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!leadCheck.rows[0]) throw new Error('LEAD_NOT_FOUND');
      if (ctx.userRole === 'sale' && leadCheck.rows[0].assigned_to !== ctx.userId) {
        throw new Error('FORBIDDEN_TIMELINE_WRITE');
      }

      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const matchedNoteCfg = cfg.note_types.find(
        (nt) => nt.value.toUpperCase() === String(note_type || '').trim().toUpperCase()
      );
      if (matchedNoteCfg?.internal_only && shouldHideInternalNotesForActor(ctx, cfg)) {
        throw new Error('FORBIDDEN_INTERNAL_NOTE');
      }

      const effectiveCatRaw =
        req.body?.category !== undefined && String(req.body.category).trim()
          ? String(req.body.category).trim()
          : matchedNoteCfg?.cat || rawCat;
      const effectiveEventCat = allowedCategories.has(effectiveCatRaw)
        ? effectiveCatRaw === 'call' || effectiveCatRaw === 'zalo'
          ? 'communication'
          : effectiveCatRaw
        : 'note';
      const effectiveEventType =
        effectiveCatRaw === 'call' ? 'call_log' : effectiveCatRaw === 'zalo' ? 'zalo_chat' : 'note';

      const mergedMeta = {
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        note_category: note_type,
      };

      const r = await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        RETURNING *`,
        [
          ctx.tenantId,
          leadId,
          effectiveEventType,
          effectiveEventCat,
          ctx.userId,
          ctx.userRole,
          ctx.userName || 'Sale',
          String(title || matchedNoteCfg?.label || note_type).trim(),
          content ? String(content).trim() : null,
          JSON.stringify(mergedMeta),
        ]
      );
      const row = r.rows[0];
      if (shouldMaskPiiForActor(ctx, cfg, leadCheck.rows[0])) {
        return {
          ...row,
          title: maskPiiInText(row.title, cfg),
          content: maskPiiInText(row.content, cfg),
        };
      }
      return row;
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_TIMELINE_WRITE' || err?.message === 'FORBIDDEN_INTERNAL_NOTE') {
      sendApiError(res, 403, 'FORBIDDEN_TIMELINE_WRITE', 'Bạn không được phép ghi chú nội bộ hoặc ghi chú trên khách hàng của người khác.');
      return;
    }
    sendApiError(res, 500, 'APPEND_NOTE_FAILED', err?.message || 'Không thể lưu ghi chú tương tác.');
  }
});

// Dispute / Error Tickets (`data_reports`) - Op 23 & Op 24
leadsRouter.get('/tickets/list', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rawLimit = Number(req.query.limit || 0);
    const rawOffset = Math.max(0, Math.floor(Number(req.query.offset || 0) || 0));

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(cfg.max_page_size, Math.max(1, Math.floor(rawLimit)))
          : cfg.max_page_size;

      const params: unknown[] = [ctx.tenantId];
      let where = 'dr.tenant_id = $1';
      if (ctx.userRole === 'sale') {
        params.push(ctx.userId);
        where += ` AND dr.reporter_id = $2`;
      }
      params.push(limit, rawOffset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;

      const r = await client.query(
        `SELECT dr.id, dr.lead_id, dr.reporter_id, dr.reason, dr.description,
                dr.status, dr.resolution_note, dr.compensation_granted, dr.created_at,
                l.name AS lead_name, l.phone AS lead_phone, l.is_accepted,
                u.full_name AS reporter_name
         FROM data_reports dr
         INNER JOIN leads l ON l.tenant_id = dr.tenant_id AND l.id = dr.lead_id
         INNER JOIN users u ON u.tenant_id = dr.tenant_id AND u.id = dr.reporter_id
         WHERE ${where}
         ORDER BY dr.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      );
      return r.rows.map((row) => {
        const maskRow = shouldMaskPiiForActor(ctx, cfg, { is_accepted: row.is_accepted });
        return {
          ...row,
          lead_phone: maskRow && row.lead_phone ? maskPhoneString(row.lead_phone, cfg) : row.lead_phone,
          description: maskRow ? maskPiiInText(row.description, cfg) : row.description,
        };
      });
    });
    res.json({ success: true, data: items });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TICKETS_FAILED', err?.message || 'Không thể tải danh sách khiếu nại.');
  }
});

leadsRouter.post('/:id/tickets', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;
    const { reason = 'Sai số / Thuê bao', description = '' } = req.body || {};

    const ticket = await withTenantTransaction(ctx.tenantId, async (client) => {
      const leadCheck = await client.query<{ assigned_to: string | null }>(
        'SELECT assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!leadCheck.rows[0]) throw new Error('LEAD_NOT_FOUND');
      if (ctx.userRole === 'sale' && leadCheck.rows[0].assigned_to !== ctx.userId) {
        throw new Error('FORBIDDEN_NOT_ASSIGNED');
      }

      const r = await client.query(
        `INSERT INTO data_reports (tenant_id, lead_id, reporter_id, reason, description, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [ctx.tenantId, leadId, ctx.userId, String(reason).trim(), String(description).trim()]
      );

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, 'ticket_raised', 'ticket', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          ctx.tenantId,
          leadId,
          ctx.userId,
          ctx.userRole,
          ctx.userName || 'Sale',
          `Báo lỗi Data / Yêu cầu hoàn lượt: ${reason}`,
          String(description).trim() || null,
          JSON.stringify({ ticket_id: r.rows[0].id }),
        ]
      );

      return r.rows[0];
    });

    enqueueOutboundWebhookEvent({
      tenantId: ctx.tenantId,
      eventType: 'ticket.created',
      payload: {
        ticket_id: ticket.id,
        lead_id: leadId,
        reporter_id: ctx.userId,
        reason: ticket.reason,
      },
    });

    res.status(201).json({ success: true, data: ticket });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_NOT_ASSIGNED') {
      sendApiError(res, 403, 'FORBIDDEN_NOT_ASSIGNED', 'Bạn chỉ được báo lỗi trên khách hàng được giao cho mình.');
      return;
    }
    sendApiError(res, 500, 'CREATE_TICKET_FAILED', err?.message || 'Không thể gửi phiếu báo lỗi.');
  }
});

// Op 24: Approve / Reject Dispute Ticket (Triggers Configurable Compensation Quota)
leadsRouter.post('/tickets/:ticketId/resolve', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const ticketId = req.params.ticketId;
    const { decision, resolution_note = '', compensation_credits } = req.body || {};

    if (decision !== 'approved' && decision !== 'rejected') {
      sendApiError(res, 422, 'INVALID_DECISION', "Quyết định phải là 'approved' hoặc 'rejected'.");
      return;
    }

    const resolved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);

      const tkRes = await client.query<{
        id: string;
        lead_id: string;
        reporter_id: string;
        reason: string;
        status: string;
      }>(
        'SELECT id, lead_id, reporter_id, reason, status FROM data_reports WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [ctx.tenantId, ticketId]
      );
      const tk = tkRes.rows[0];
      if (!tk) throw new Error('TICKET_NOT_FOUND');
      if (tk.status !== 'pending') throw new Error('TICKET_ALREADY_RESOLVED');

      const creditsToGrant =
        decision === 'approved'
          ? compensation_credits !== undefined && compensation_credits !== null
            ? Math.max(0, Math.min(50, Math.round(Number(compensation_credits))))
            : cfg.enable_compensation_credits
              ? cfg.compensation_credits_per_ticket
              : 0
          : 0;

      const grantComp = creditsToGrant > 0;
      const upd = await client.query(
        `UPDATE data_reports
         SET status = $3,
             resolved_by = $4,
             resolution_note = $5,
             compensation_granted = $6,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [ctx.tenantId, ticketId, decision, ctx.userId, String(resolution_note).trim(), grantComp]
      );

      if (creditsToGrant > 0) {
        const updRc = await client.query<{ round_id: string }>(
          `UPDATE round_consultants
           SET compensation_count = compensation_count + $3
           WHERE id = (
             SELECT rc.id
             FROM round_consultants rc
             INNER JOIN distribution_rounds dr ON dr.tenant_id = rc.tenant_id AND dr.id = rc.round_id
             WHERE rc.tenant_id = $1 AND rc.user_id = $2 AND dr.is_active = true
             ORDER BY dr.priority ASC, rc.created_at ASC
             LIMIT 1
           )
           RETURNING round_id`,
          [ctx.tenantId, tk.reporter_id, creditsToGrant]
        );
        if (updRc.rows[0]?.round_id) {
          await client.query(
            `INSERT INTO active_compensation_logs (
               tenant_id, round_id, consultant_user_id, admin_user_id, ticket_id, amount, reason, source_type
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ticket')`,
            [
              ctx.tenantId,
              updRc.rows[0].round_id,
              tk.reporter_id,
              ctx.userId,
              ticketId,
              creditsToGrant,
              String(resolution_note || tk.reason || 'Duyệt ticket lỗi data').trim().slice(0, 255),
            ]
          );
        }
      }

      const matchedReasonCfg = cfg.ticket_reasons.find(
        (r) =>
          r.value.toLowerCase() === String(tk.reason || '').trim().toLowerCase() ||
          r.label.toLowerCase() === String(tk.reason || '').trim().toLowerCase()
      );
      const shouldDisqualify =
        decision === 'approved' &&
        cfg.auto_disqualify_on_ticket_approve &&
        (matchedReasonCfg ? matchedReasonCfg.auto_disqualify !== false : true);

      if (shouldDisqualify) {
        await client.query(
          `UPDATE leads SET quality_status = 'Disqualified', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, tk.lead_id]
        );
      }

      await client.query(
        `INSERT INTO lead_timeline_events (
          tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          ctx.tenantId,
          tk.lead_id,
          'ticket_resolved',
          'ticket',
          ctx.userId,
          ctx.userRole,
          ctx.userName || 'Manager',
          decision === 'approved'
            ? `Đã duyệt báo lỗi • Tự động cộng +${creditsToGrant} lượt bù data ưu tiên`
            : 'Từ chối phiếu báo lỗi data',
          String(resolution_note).trim() || null,
          JSON.stringify({
            ticket_id: ticketId,
            decision,
            compensation_granted: grantComp,
            compensation_credits: creditsToGrant,
            granted_credits: creditsToGrant,
          }),
        ]
      );

      return { ...upd.rows[0], compensation_credits: creditsToGrant, granted_credits: creditsToGrant };
    });

    enqueueOutboundWebhookEvent({
      tenantId: ctx.tenantId,
      eventType: 'ticket.resolved',
      payload: {
        ticket_id: ticketId,
        lead_id: resolved.lead_id,
        decision,
        compensation_granted: resolved.compensation_granted,
        compensation_credits: resolved.compensation_credits,
      },
    });

    res.json({ success: true, data: resolved });
  } catch (err: any) {
    sendApiError(res, 500, 'RESOLVE_TICKET_FAILED', err?.message || 'Không thể xử lý phiếu khiếu nại.');
  }
});
