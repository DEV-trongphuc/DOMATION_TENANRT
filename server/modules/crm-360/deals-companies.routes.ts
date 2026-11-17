import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requireAnyPermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import { emitDomainEventDetached } from '../../core/events/event-bus.ts';
import {
  clampLimit,
  parseJsonSafe,
  resolveCrmActorContext,
} from './schema.ts';

export const dealsCompaniesRouter = Router();

const CANONICAL_DEAL_STAGES = new Set([
  'qualification',
  'discovery',
  'proposal',
  'negotiation',
  'won',
  'lost',
]);

function normalizeCanonicalDealStage(raw: unknown): string {
  const s = String(raw || 'qualification').trim().toLowerCase();
  if (CANONICAL_DEAL_STAGES.has(s)) return s;
  if (s.includes('won') || s.includes('chot') || s.includes('closed_won')) return 'won';
  if (s.includes('lost') || s.includes('that_bai') || s.includes('closed_lost')) return 'lost';
  if (s.includes('negot') || s.includes('dam_phan')) return 'negotiation';
  if (s.includes('propos') || s.includes('bao_gia')) return 'proposal';
  if (s.includes('discov') || s.includes('khao_sat')) return 'discovery';
  return 'qualification';
}

const DEFAULT_STAGE_PROBABILITIES: Record<string, number> = {
  qualification: 20,
  discovery: 40,
  proposal: 60,
  negotiation: 80,
  won: 100,
  lost: 0,
};

// ============================================================================
// 1. Multi-Deals Kanban & List View + Forecast Rollup
// ============================================================================
dealsCompaniesRouter.get(
  '/deals',
  requireAnyPermission([
    ['deals', 'view'],
    ['pipelines', 'view'],
    ['crm_b2b', 'view'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const search = String(req.query.search || '').trim();
      const stageFilter = String(req.query.stage || '').trim();
      const pipelineId = String(req.query.pipeline_id || '').trim();
      const ownerId = String(req.query.owner_id || '').trim();
      const companyId = String(req.query.company_id || '').trim();
      const leadId = String(req.query.lead_id || '').trim();
      const limit = clampLimit(req.query.limit, 200, 500);

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac, canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const dealPerm =
          rbac.effectivePermissions.deals ||
          rbac.effectivePermissions.crm_b2b ||
          rbac.effectivePermissions.pipelines;
        const scope = dealPerm?.scope || 'company';

        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg!,
          scope,
          {
            tenantColumn: 'd.tenant_id',
            ownerColumn: 'd.owner_user_id',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const conds: string[] = [scopeSql.clause];
        const vals: unknown[] = [...scopeSql.values];
        let pIdx = scopeSql.nextIndex;

        if (search) {
          conds.push(
            `(LOWER(d.title) LIKE LOWER($${pIdx}) OR LOWER(d.deal_code) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(c.name, '')) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(l.name, '')) LIKE LOWER($${pIdx}))`
          );
          vals.push(`%${search}%`);
          pIdx++;
        }
        if (stageFilter) {
          conds.push(`(d.stage = $${pIdx} OR d.stage_id = $${pIdx})`);
          vals.push(stageFilter);
          pIdx++;
        }
        if (pipelineId) {
          conds.push(`d.pipeline_id = $${pIdx}`);
          vals.push(pipelineId);
          pIdx++;
        }
        if (ownerId) {
          conds.push(`d.owner_user_id = $${pIdx}`);
          vals.push(ownerId);
          pIdx++;
        }
        if (companyId) {
          conds.push(`d.company_id = $${pIdx}`);
          vals.push(companyId);
          pIdx++;
        }
        if (leadId) {
          conds.push(`d.lead_id = $${pIdx}`);
          vals.push(leadId);
          pIdx++;
        }

        const whereStr = conds.join(' AND ');

        const [rowsRes, kpiRes, pipelinesRes, stagesRes, companiesRes, staffRes] =
          await Promise.all([
            client.query<Record<string, any>>(
              `SELECT d.*,
                      c.name AS company_name, c.tier AS company_tier,
                      l.name AS contact_name, l.phone AS contact_phone, l.email AS contact_email, l.lead_score,
                      u.full_name AS owner_name
               FROM tenant_deals d
               LEFT JOIN tenant_b2b_companies c ON c.tenant_id = d.tenant_id AND c.id = d.company_id
               LEFT JOIN leads l ON l.tenant_id = d.tenant_id AND l.id = d.lead_id
               LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.owner_user_id
               WHERE ${whereStr}
               ORDER BY d.updated_at DESC, d.created_at DESC
               LIMIT $${pIdx}`,
              [...vals, limit]
            ),
            client.query<{
              total_deals: string | number;
              pipeline_value_vnd: string | number;
              weighted_forecast_vnd: string | number;
              won_value_vnd: string | number;
              won_count: string | number;
              closed_count: string | number;
            }>(
              `SELECT COUNT(*) AS total_deals,
                      COALESCE(SUM(CASE WHEN d.stage != 'lost' THEN d.amount_vnd ELSE 0 END), 0) AS pipeline_value_vnd,
                      COALESCE(SUM(CASE WHEN d.stage != 'lost' THEN (d.amount_vnd * d.probability) / 100 ELSE 0 END), 0) AS weighted_forecast_vnd,
                      COALESCE(SUM(CASE WHEN d.stage = 'won' THEN d.amount_vnd ELSE 0 END), 0) AS won_value_vnd,
                      COALESCE(SUM(CASE WHEN d.stage = 'won' THEN 1 ELSE 0 END), 0) AS won_count,
                      COALESCE(SUM(CASE WHEN d.stage IN ('won', 'lost') THEN 1 ELSE 0 END), 0) AS closed_count
               FROM tenant_deals d
               LEFT JOIN tenant_b2b_companies c ON c.tenant_id = d.tenant_id AND c.id = d.company_id
               LEFT JOIN leads l ON l.tenant_id = d.tenant_id AND l.id = d.lead_id
               WHERE ${whereStr}`,
              vals
            ),
            client.query(
              'SELECT id, name, is_default FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, pipeline_id, stage_key, stage_name, color_hex, stage_order, is_won_stage, is_lost_stage FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, code, name, tier FROM tenant_b2b_companies WHERE tenant_id = $1 ORDER BY name ASC LIMIT 200',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, full_name, email, role FROM users WHERE tenant_id = $1 AND is_system_bot = false ORDER BY full_name ASC',
              [ctx.tenantId]
            ),
          ]);

        const piiCfg = parseJsonSafe<Record<string, any>>(tenantSettings, {});
        const items = rowsRes.rows.map((d) => {
          const maskedContact = maskContactPiiIfDisallowed(
            { phone: d.contact_phone, email: d.contact_email },
            canUnmaskLeads,
            piiCfg
          );
          return {
            ...d,
            amount_vnd: Number(d.amount_vnd || 0),
            probability: Number(d.probability ?? 30),
            contact_phone: maskedContact.phone,
            contact_email: maskedContact.email,
            pii_masked: maskedContact.pii_masked,
            tags_json: parseJsonSafe(d.tags_json, []),
            custom_fields: parseJsonSafe(d.custom_fields, {}),
            metadata: parseJsonSafe(d.metadata, {}),
          };
        });

        const k = kpiRes.rows[0];
        const closedCount = Number(k?.closed_count || 0);
        const wonCount = Number(k?.won_count || 0);

        return {
          items,
          kpis: {
            total_deals: Number(k?.total_deals || 0),
            pipeline_value_vnd: Number(k?.pipeline_value_vnd || 0),
            weighted_forecast_vnd: Math.round(Number(k?.weighted_forecast_vnd || 0)),
            won_value_vnd: Number(k?.won_value_vnd || 0),
            won_count: wonCount,
            win_rate_pct: closedCount > 0 ? Math.round((wonCount / closedCount) * 100) : 0,
          },
          pipelines: pipelinesRes.rows,
          stages: stagesRes.rows,
          companies: companiesRes.rows,
          staff: staffRes.rows,
        };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_DEALS_LIST_FAILED', err?.message || 'Không thể tải danh sách cơ hội kinh doanh.');
    }
  }
);

// ============================================================================
// 2. Create Deal + Initial Stage History Audit Row
// ============================================================================
dealsCompaniesRouter.post(
  '/deals',
  requireAnyPermission([
    ['deals', 'create'],
    ['pipelines', 'create'],
    ['crm_b2b', 'create'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const title = String(b.title || '').trim();
      if (!title) {
        sendApiError(res, 400, 'INVALID_DEAL_TITLE', 'Vui lòng nhập tên cơ hội / giao dịch.');
        return;
      }

      const canonicalStage = normalizeCanonicalDealStage(b.stage);
      const amountVnd = Math.max(0, Math.round(Number(b.amount_vnd ?? b.value ?? 0)));
      const probability = Math.max(
        0,
        Math.min(100, Number(b.probability ?? DEFAULT_STAGE_PROBABILITIES[canonicalStage] ?? 30))
      );

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const dealId = crypto.randomUUID();
        const dealCode =
          String(b.deal_code || '').trim() ||
          `DEAL-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 90 + 10)}`;

        await client.query(
          `INSERT INTO tenant_deals (
             id, tenant_id, deal_code, title, company_id, lead_id, owner_user_id,
             pipeline_id, stage_id, stage, amount_vnd, probability,
             expected_close_date, actual_close_date, lost_reason, notes, tags_json, custom_fields, metadata
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12,
             $13, $14, $15, $16, $17, $18, $19
           )`,
          [
            dealId,
            ctx.tenantId,
            dealCode.slice(0, 50),
            title.slice(0, 255),
            b.company_id || null,
            b.lead_id || null,
            b.owner_user_id || ctx.userId,
            b.pipeline_id || null,
            b.stage_id || null,
            canonicalStage,
            amountVnd,
            probability,
            b.expected_close_date || null,
            canonicalStage === 'won' || canonicalStage === 'lost'
              ? new Date().toISOString().slice(0, 10)
              : null,
            b.lost_reason ? String(b.lost_reason) : null,
            b.notes ? String(b.notes) : null,
            JSON.stringify(Array.isArray(b.tags_json) ? b.tags_json : []),
            JSON.stringify(b.custom_fields && typeof b.custom_fields === 'object' ? b.custom_fields : {}),
            JSON.stringify(b.metadata && typeof b.metadata === 'object' ? b.metadata : {}),
          ]
        );

        await client.query(
          `INSERT INTO tenant_deal_stage_history (
             id, tenant_id, deal_id, pipeline_id, from_stage, to_stage, from_stage_id, to_stage_id,
             probability, amount_vnd, duration_seconds, note, changed_by, changed_by_name, metadata
           ) VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7, $8, 0, $9, $10, $11, '{}')`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            dealId,
            b.pipeline_id || null,
            canonicalStage,
            b.stage_id || null,
            probability,
            amountVnd,
            'Khởi tạo cơ hội kinh doanh mới',
            ctx.userId,
            actorName,
          ]
        );

        const r = await client.query('SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          dealId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_DEAL_CREATE_FAILED', err?.message || 'Không thể tạo cơ hội kinh doanh.');
    }
  }
);

// ============================================================================
// 3. DealDrawer Full 360° Details + Stage History + Quotes + Activities
// ============================================================================
dealsCompaniesRouter.get(
  '/deals/:id',
  requireAnyPermission([
    ['deals', 'view'],
    ['pipelines', 'view'],
    ['crm_b2b', 'view'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const dealId = String(req.params.id || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const dealRes = await client.query<Record<string, any>>(
          `SELECT d.*,
                  c.name AS company_name, c.tax_code AS company_tax_code, c.tier AS company_tier,
                  l.name AS contact_name, l.phone AS contact_phone, l.email AS contact_email,
                  u.full_name AS owner_name
           FROM tenant_deals d
           LEFT JOIN tenant_b2b_companies c ON c.tenant_id = d.tenant_id AND c.id = d.company_id
           LEFT JOIN leads l ON l.tenant_id = d.tenant_id AND l.id = d.lead_id
           LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.owner_user_id
           WHERE d.tenant_id = $1 AND d.id = $2
           LIMIT 1`,
          [ctx.tenantId, dealId]
        );
        if (dealRes.rows.length === 0) return null;
        const d = dealRes.rows[0];

        const [historyRes, actRes, quotesRes, ordersRes, productsRes] = await Promise.all([
          client.query(
            `SELECT * FROM tenant_deal_stage_history
             WHERE tenant_id = $1 AND deal_id = $2
             ORDER BY created_at DESC`,
            [ctx.tenantId, dealId]
          ),
          client.query(
            `SELECT * FROM tenant_crm_activities
             WHERE tenant_id = $1 AND deal_id = $2
             ORDER BY created_at DESC LIMIT 50`,
            [ctx.tenantId, dealId]
          ),
          client.query(
            `SELECT * FROM tenant_quotes
             WHERE tenant_id = $1 AND deal_id = $2
             ORDER BY created_at DESC`,
            [ctx.tenantId, dealId]
          ),
          client.query(
            `SELECT * FROM tenant_sales_orders
             WHERE tenant_id = $1 AND deal_id = $2
             ORDER BY created_at DESC`,
            [ctx.tenantId, dealId]
          ),
          client.query(
            `SELECT id, sku, name, unit, sale_price_vnd, tax_rate_pct
             FROM tenant_products
             WHERE tenant_id = $1 AND is_active = true
             ORDER BY name ASC LIMIT 100`,
            [ctx.tenantId]
          ),
        ]);

        const maskedContact = maskContactPiiIfDisallowed(
          { phone: d.contact_phone, email: d.contact_email },
          canUnmaskLeads,
          parseJsonSafe(tenantSettings, {})
        );

        return {
          deal: {
            ...d,
            amount_vnd: Number(d.amount_vnd || 0),
            probability: Number(d.probability ?? 30),
            contact_phone: maskedContact.phone,
            contact_email: maskedContact.email,
            tags_json: parseJsonSafe(d.tags_json, []),
            custom_fields: parseJsonSafe(d.custom_fields, {}),
            metadata: parseJsonSafe(d.metadata, {}),
          },
          stage_history: historyRes.rows,
          activities: actRes.rows,
          quotes: quotesRes.rows.map((q: any) => ({ ...q, items_json: parseJsonSafe(q.items_json, []) })),
          sales_orders: ordersRes.rows,
          products_catalog: productsRes.rows,
        };
      });

      if (!data) {
        sendApiError(res, 404, 'DEAL_NOT_FOUND', 'Không tìm thấy cơ hội kinh doanh.');
        return;
      }
      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_DEAL_GET_FAILED', err?.message || 'Không thể tải chi tiết cơ hội.');
    }
  }
);

// ============================================================================
// 4. Update Deal & Kanban Drag-Drop Stage Transition (`tenant_deal_stage_history`)
// ============================================================================
async function transitionDealStageInTx(
  client: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  params: {
    tenantId: string;
    dealId: string;
    nextStageRaw: string;
    nextStageId?: string | null;
    probability?: number;
    amountVnd?: number;
    lostReason?: string | null;
    note?: string | null;
    actorId: string;
    actorName: string;
  }
): Promise<{ deal: Record<string, any>; becameWon: boolean }> {
  const curRes = await client.query<Record<string, any>>(
    'SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [params.tenantId, params.dealId]
  );
  if (curRes.rows.length === 0) {
    throw new Error('DEAL_NOT_FOUND');
  }
  const cur = curRes.rows[0];
  const nextStage = normalizeCanonicalDealStage(params.nextStageRaw);
  const nextProb =
    params.probability !== undefined
      ? Math.max(0, Math.min(100, Number(params.probability)))
      : DEFAULT_STAGE_PROBABILITIES[nextStage] ?? Number(cur.probability || 30);
  const nextAmount =
    params.amountVnd !== undefined
      ? Math.max(0, Math.round(Number(params.amountVnd)))
      : Number(cur.amount_vnd || 0);

  const lastHistRes = await client.query<{ created_at: string }>(
    'SELECT created_at FROM tenant_deal_stage_history WHERE tenant_id = $1 AND deal_id = $2 ORDER BY created_at DESC LIMIT 1',
    [params.tenantId, params.dealId]
  );
  const prevMs = lastHistRes.rows[0]?.created_at
    ? new Date(lastHistRes.rows[0].created_at).getTime()
    : new Date(cur.created_at).getTime();
  const durationSeconds = Math.max(0, Math.round((Date.now() - prevMs) / 1000));

  const actualCloseDate =
    nextStage === 'won' || nextStage === 'lost'
      ? new Date().toISOString().slice(0, 10)
      : cur.actual_close_date;

  await client.query(
    `UPDATE tenant_deals
     SET stage = $3,
         stage_id = $4,
         probability = $5,
         amount_vnd = $6,
         lost_reason = $7,
         actual_close_date = $8,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [
      params.tenantId,
      params.dealId,
      nextStage,
      params.nextStageId !== undefined ? params.nextStageId : cur.stage_id,
      nextProb,
      nextAmount,
      nextStage === 'lost' ? params.lostReason || cur.lost_reason || 'Khách hàng tạm hoãn' : cur.lost_reason,
      actualCloseDate,
    ]
  );

  await client.query(
    `INSERT INTO tenant_deal_stage_history (
       id, tenant_id, deal_id, pipeline_id, from_stage, to_stage, from_stage_id, to_stage_id,
       probability, amount_vnd, duration_seconds, note, changed_by, changed_by_name, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, '{}')`,
    [
      crypto.randomUUID(),
      params.tenantId,
      params.dealId,
      cur.pipeline_id || null,
      cur.stage,
      nextStage,
      cur.stage_id || null,
      params.nextStageId ?? cur.stage_id ?? null,
      nextProb,
      nextAmount,
      durationSeconds,
      params.note ||
        (nextStage === 'lost' && params.lostReason
          ? `Lý do thất bại: ${params.lostReason}`
          : `Chuyển bước phễu: ${cur.stage} → ${nextStage}`),
      params.actorId,
      params.actorName,
    ]
  );

  const becameWon = cur.stage !== 'won' && nextStage === 'won';
  if (becameWon && cur.lead_id && nextAmount > 0) {
    await client.query(
      `UPDATE leads
       SET total_revenue_vnd = COALESCE(total_revenue_vnd, 0) + $3,
           lifecycle_stage = 'customer',
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [params.tenantId, cur.lead_id, nextAmount]
    );
  }

  const fresh = await client.query('SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
    params.tenantId,
    params.dealId,
  ]);
  return { deal: fresh.rows[0], becameWon };
}

dealsCompaniesRouter.patch(
  '/deals/:id/stage',
  requireAnyPermission([
    ['deals', 'edit'],
    ['pipelines', 'edit'],
    ['crm_b2b', 'edit'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const dealId = String(req.params.id || '').trim();
      const b = req.body || {};

      const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        return transitionDealStageInTx(client, {
          tenantId: ctx.tenantId,
          dealId,
          nextStageRaw: String(b.stage || 'qualification'),
          nextStageId: b.stage_id || null,
          probability: b.probability !== undefined ? Number(b.probability) : undefined,
          amountVnd: b.amount_vnd !== undefined ? Number(b.amount_vnd) : undefined,
          lostReason: b.lost_reason || null,
          note: b.note || null,
          actorId: ctx.userId,
          actorName,
        });
      });

      if (outcome.becameWon && outcome.deal.lead_id) {
        emitDomainEventDetached('deal.won', {
          tenantId: ctx.tenantId,
          leadId: String(outcome.deal.lead_id),
          dealId,
          amountVnd: Number(outcome.deal.amount_vnd || 0),
          sourceEntity: 'deal',
          actorId: ctx.userId,
        });
      }

      res.json({ success: true, data: outcome.deal });
    } catch (err: any) {
      if (err?.message === 'DEAL_NOT_FOUND') {
        sendApiError(res, 404, 'DEAL_NOT_FOUND', 'Không tìm thấy cơ hội kinh doanh.');
        return;
      }
      sendApiError(res, 500, 'CRM_DEAL_STAGE_FAILED', err?.message || 'Không thể chuyển bước cơ hội.');
    }
  }
);

dealsCompaniesRouter.put(
  '/deals/:id',
  requireAnyPermission([
    ['deals', 'edit'],
    ['pipelines', 'edit'],
    ['crm_b2b', 'edit'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const dealId = String(req.params.id || '').trim();
      const b = req.body || {};

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const curRes = await client.query<Record<string, any>>(
          'SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, dealId]
        );
        if (curRes.rows.length === 0) return null;
        const cur = curRes.rows[0];

        const nextStage = b.stage ? normalizeCanonicalDealStage(b.stage) : cur.stage;
        if (nextStage !== cur.stage) {
          await transitionDealStageInTx(client, {
            tenantId: ctx.tenantId,
            dealId,
            nextStageRaw: nextStage,
            nextStageId: b.stage_id !== undefined ? b.stage_id : cur.stage_id,
            probability: b.probability !== undefined ? Number(b.probability) : undefined,
            amountVnd: b.amount_vnd !== undefined ? Number(b.amount_vnd) : undefined,
            lostReason: b.lost_reason || null,
            note: b.stage_note || null,
            actorId: ctx.userId,
            actorName,
          });
        }

        const curMeta = parseJsonSafe<Record<string, unknown>>(cur.metadata, {});
        const nextMeta =
          b.metadata && typeof b.metadata === 'object'
            ? { ...curMeta, ...(b.metadata as Record<string, unknown>) }
            : curMeta;

        await client.query(
          `UPDATE tenant_deals
           SET title = $3,
               company_id = $4,
               lead_id = $5,
               owner_user_id = $6,
               amount_vnd = $7,
               probability = $8,
               expected_close_date = $9,
               lost_reason = $10,
               notes = $11,
               tags_json = $12,
               custom_fields = $13,
               metadata = $14,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            dealId,
            b.title !== undefined ? String(b.title).trim().slice(0, 255) : cur.title,
            b.company_id !== undefined ? b.company_id || null : cur.company_id,
            b.lead_id !== undefined ? b.lead_id || null : cur.lead_id,
            b.owner_user_id !== undefined ? b.owner_user_id || null : cur.owner_user_id,
            b.amount_vnd !== undefined ? Math.max(0, Math.round(Number(b.amount_vnd))) : Number(cur.amount_vnd || 0),
            b.probability !== undefined ? Math.max(0, Math.min(100, Number(b.probability))) : Number(cur.probability || 30),
            b.expected_close_date !== undefined ? b.expected_close_date || null : cur.expected_close_date,
            b.lost_reason !== undefined ? b.lost_reason || null : cur.lost_reason,
            b.notes !== undefined ? b.notes || null : cur.notes,
            JSON.stringify(Array.isArray(b.tags_json) ? b.tags_json : parseJsonSafe(cur.tags_json, [])),
            JSON.stringify(
              b.custom_fields && typeof b.custom_fields === 'object'
                ? b.custom_fields
                : parseJsonSafe(cur.custom_fields, {})
            ),
            JSON.stringify(nextMeta),
          ]
        );

        const fresh = await client.query('SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          dealId,
        ]);
        return fresh.rows[0];
      });

      if (!updated) {
        sendApiError(res, 404, 'DEAL_NOT_FOUND', 'Không tìm thấy cơ hội kinh doanh.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_DEAL_UPDATE_FAILED', err?.message || 'Không thể cập nhật cơ hội.');
    }
  }
);

dealsCompaniesRouter.delete(
  '/deals/:id',
  requireAnyPermission([
    ['deals', 'delete'],
    ['pipelines', 'delete'],
    ['crm_b2b', 'delete'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query('DELETE FROM tenant_deal_stage_history WHERE tenant_id = $1 AND deal_id = $2', [
          ctx.tenantId,
          String(req.params.id),
        ]);
        await client.query('DELETE FROM tenant_deals WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          String(req.params.id),
        ]);
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_DEAL_DELETE_FAILED', err?.message || 'Không thể xóa cơ hội.');
    }
  }
);

// ============================================================================
// 5. B2B Companies: Hierarchy, Tax Code/MST Lookup, Linked Contacts & Rollups
// ============================================================================
dealsCompaniesRouter.get(
  '/companies/mst-lookup',
  requireAnyPermission([
    ['companies', 'view'],
    ['crm_b2b', 'view'],
    ['leads', 'view'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const rawTax = String(req.query.tax_code || '').replace(/\s+/g, '');
      const validFormat = /^\d{10}(-\d{3})?$/.test(rawTax);

      const existing = await withTenantTransaction(ctx.tenantId, async (client) => {
        if (!rawTax) return null;
        const r = await client.query(
          'SELECT id, code, name, tax_code, billing_address, representative_name, tier FROM tenant_b2b_companies WHERE tenant_id = $1 AND tax_code = $2 LIMIT 1',
          [ctx.tenantId, rawTax]
        );
        return r.rows[0] || null;
      });

      res.json({
        success: true,
        data: {
          tax_code: rawTax,
          is_valid_mst_format: validFormat,
          is_branch_mst: rawTax.includes('-'),
          existing_company: existing,
        },
      });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_MST_LOOKUP_FAILED', err?.message || 'Không thể tra cứu mã số thuế.');
    }
  }
);

dealsCompaniesRouter.get(
  '/companies',
  requireAnyPermission([
    ['companies', 'view'],
    ['crm_b2b', 'view'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const search = String(req.query.search || '').trim();
      const tierFilter = String(req.query.tier || '').trim();
      const statusFilter = String(req.query.status || '').trim();
      const hierarchyFilter = String(req.query.hierarchy || '').trim();
      const limit = clampLimit(req.query.limit, 100, 300);

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const compPerm = rbac.effectivePermissions.companies || rbac.effectivePermissions.crm_b2b;
        const scope = compPerm?.scope || 'company';
        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg!,
          scope,
          {
            tenantColumn: 'c.tenant_id',
            ownerColumn: 'c.owner_user_id',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const conds: string[] = [scopeSql.clause];
        const vals: unknown[] = [...scopeSql.values];
        let pIdx = scopeSql.nextIndex;

        if (search) {
          conds.push(
            `(LOWER(c.name) LIKE LOWER($${pIdx}) OR LOWER(c.code) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(c.tax_code, '')) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(c.representative_name, '')) LIKE LOWER($${pIdx}))`
          );
          vals.push(`%${search}%`);
          pIdx++;
        }
        if (tierFilter) {
          conds.push(`c.tier = $${pIdx}`);
          vals.push(tierFilter);
          pIdx++;
        }
        if (statusFilter) {
          conds.push(`c.status = $${pIdx}`);
          vals.push(statusFilter);
          pIdx++;
        }
        if (hierarchyFilter === 'parent_only') {
          conds.push('c.parent_company_id IS NULL');
        } else if (hierarchyFilter === 'subsidiaries') {
          conds.push('c.parent_company_id IS NOT NULL');
        }

        const whereStr = conds.join(' AND ');

        const rowsRes = await client.query<Record<string, any>>(
          `SELECT c.*,
                  parent.name AS parent_company_name,
                  u.full_name AS owner_name,
                  (SELECT COUNT(*) FROM tenant_b2b_companies sub WHERE sub.tenant_id = c.tenant_id AND sub.parent_company_id = c.id) AS subsidiaries_count,
                  (SELECT COUNT(*) FROM leads l WHERE l.tenant_id = c.tenant_id AND l.company_id = c.id AND l.is_deleted = false) AS contact_count,
                  (SELECT COUNT(*) FROM tenant_deals d WHERE d.tenant_id = c.tenant_id AND d.company_id = c.id) AS deal_count,
                  (SELECT COALESCE(SUM(CASE WHEN d2.stage = 'won' THEN d2.amount_vnd ELSE 0 END), 0) FROM tenant_deals d2 WHERE d2.tenant_id = c.tenant_id AND d2.company_id = c.id) AS won_revenue_vnd,
                  (SELECT COALESCE(SUM(CASE WHEN d3.stage != 'lost' THEN d3.amount_vnd ELSE 0 END), 0) FROM tenant_deals d3 WHERE d3.tenant_id = c.tenant_id AND d3.company_id = c.id) AS pipeline_value_vnd
           FROM tenant_b2b_companies c
           LEFT JOIN tenant_b2b_companies parent ON parent.tenant_id = c.tenant_id AND parent.id = c.parent_company_id
           LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.owner_user_id
           WHERE ${whereStr}
           ORDER BY c.created_at DESC
           LIMIT $${pIdx}`,
          [...vals, limit]
        );

        const items: Array<Record<string, any>> = rowsRes.rows.map((r: Record<string, any>) => ({
          ...r,
          subsidiaries_count: Number(r.subsidiaries_count || 0),
          contact_count: Number(r.contact_count || 0),
          deal_count: Number(r.deal_count || 0),
          won_revenue_vnd: Number(r.won_revenue_vnd || 0),
          pipeline_value_vnd: Number(r.pipeline_value_vnd || 0),
          tags_json: parseJsonSafe(r.tags_json, []),
          contacts_json: parseJsonSafe(r.contacts_json, []),
          custom_fields: parseJsonSafe(r.custom_fields, {}),
        }));

        const kpis = {
          total_companies: items.length,
          enterprise_gold_count: items.filter((i) => i.tier === 'enterprise' || i.tier === 'gold').length,
          subsidiaries_total: items.filter((i) => Boolean(i.parent_company_id)).length,
          linked_contacts_total: items.reduce((s, i) => s + i.contact_count, 0),
          total_won_revenue_vnd: items.reduce((s, i) => s + i.won_revenue_vnd, 0),
          total_pipeline_vnd: items.reduce((s, i) => s + i.pipeline_value_vnd, 0),
        };

        return { items, total: items.length, kpis };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_COMPANIES_LIST_FAILED', err?.message || 'Không thể tải danh sách doanh nghiệp B2B.');
    }
  }
);

dealsCompaniesRouter.post(
  '/companies',
  requireAnyPermission([
    ['companies', 'create'],
    ['crm_b2b', 'create'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name) {
        sendApiError(res, 400, 'INVALID_COMPANY_NAME', 'Vui lòng nhập tên doanh nghiệp / đối tác.');
        return;
      }

      const tier = ['standard', 'silver', 'gold', 'enterprise'].includes(String(b.tier || ''))
        ? String(b.tier)
        : 'standard';

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const compId = crypto.randomUUID();
        const code =
          String(b.code || '').trim().toUpperCase() ||
          `B2B-${Date.now().toString().slice(-6)}`;

        await client.query(
          `INSERT INTO tenant_b2b_companies (
             id, tenant_id, code, name, tax_code, industry, company_size, website,
             billing_address, phone, email, representative_name, owner_user_id,
             primary_lead_id, parent_company_id, status, tier, sla_tier,
             contacts_json, tags_json, custom_fields, notes
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $17,
             $18, $19, $20, $21
           )`,
          [
            compId,
            ctx.tenantId,
            code.slice(0, 50),
            name.slice(0, 255),
            b.tax_code ? String(b.tax_code).trim().slice(0, 50) : null,
            b.industry ? String(b.industry).slice(0, 100) : null,
            b.company_size ? String(b.company_size).slice(0, 50) : null,
            b.website ? String(b.website).slice(0, 255) : null,
            b.billing_address ? String(b.billing_address) : null,
            b.phone ? String(b.phone).slice(0, 40) : null,
            b.email ? String(b.email).slice(0, 255) : null,
            b.representative_name ? String(b.representative_name).slice(0, 150) : null,
            b.owner_user_id || ctx.userId,
            b.primary_lead_id || null,
            b.parent_company_id || null,
            String(b.status || 'active'),
            tier,
            JSON.stringify(Array.isArray(b.contacts_json) ? b.contacts_json : []),
            JSON.stringify(Array.isArray(b.tags_json) ? b.tags_json : []),
            JSON.stringify(b.custom_fields && typeof b.custom_fields === 'object' ? b.custom_fields : {}),
            b.notes ? String(b.notes) : null,
          ]
        );

        const r = await client.query('SELECT * FROM tenant_b2b_companies WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          compId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_COMPANY_CREATE_FAILED', err?.message || 'Không thể tạo hồ sơ doanh nghiệp B2B.');
    }
  }
);

dealsCompaniesRouter.get(
  '/companies/:id',
  requireAnyPermission([
    ['companies', 'view'],
    ['crm_b2b', 'view'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const compId = String(req.params.id || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const compRes = await client.query<Record<string, any>>(
          `SELECT c.*, parent.name AS parent_company_name, u.full_name AS owner_name
           FROM tenant_b2b_companies c
           LEFT JOIN tenant_b2b_companies parent ON parent.tenant_id = c.tenant_id AND parent.id = c.parent_company_id
           LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.owner_user_id
           WHERE c.tenant_id = $1 AND c.id = $2
           LIMIT 1`,
          [ctx.tenantId, compId]
        );
        if (compRes.rows.length === 0) return null;
        const comp = compRes.rows[0];

        const [
          subsidiariesRes,
          contactsRes,
          dealsRes,
          quotesRes,
          soRes,
          poRes,
          invoicesRes,
          activitiesRes,
        ] = await Promise.all([
          client.query(
            'SELECT id, code, name, tax_code, tier, status, billing_address FROM tenant_b2b_companies WHERE tenant_id = $1 AND parent_company_id = $2 ORDER BY name ASC',
            [ctx.tenantId, compId]
          ),
          client.query<Record<string, any>>(
            `SELECT l.id, l.name, l.phone, l.email, l.job_title, l.lifecycle_stage, l.lead_score, l.total_revenue_vnd,
                    ps.stage_name, ps.color_hex AS stage_color
             FROM leads l
             LEFT JOIN tenant_pipeline_stages ps ON ps.tenant_id = l.tenant_id AND ps.id = l.stage_id
             WHERE l.tenant_id = $1 AND l.company_id = $2 AND l.is_deleted = false
             ORDER BY l.created_at DESC`,
            [ctx.tenantId, compId]
          ),
          client.query(
            `SELECT d.*, u.full_name AS owner_name
             FROM tenant_deals d
             LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.owner_user_id
             WHERE d.tenant_id = $1 AND d.company_id = $2
             ORDER BY d.created_at DESC`,
            [ctx.tenantId, compId]
          ),
          client.query(
            'SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC',
            [ctx.tenantId, compId]
          ),
          client.query(
            'SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC',
            [ctx.tenantId, compId]
          ),
          client.query(
            'SELECT * FROM tenant_purchase_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20',
            [ctx.tenantId]
          ),
          client.query(
            'SELECT * FROM tenant_invoices WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC',
            [ctx.tenantId, compId]
          ),
          client.query(
            'SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 50',
            [ctx.tenantId, compId]
          ),
        ]);

        const piiCfg = parseJsonSafe<Record<string, any>>(tenantSettings, {});
        const maskedContacts = contactsRes.rows.map((c) =>
          maskContactPiiIfDisallowed(c, canUnmaskLeads, piiCfg)
        );

        const wonDealsVnd = dealsRes.rows
          .filter((d: any) => d.stage === 'won')
          .reduce((acc: number, d: any) => acc + Number(d.amount_vnd || 0), 0);
        const soPaidVnd = soRes.rows.reduce(
          (acc: number, o: any) => acc + Number(o.paid_vnd || 0),
          0
        );

        return {
          company: {
            ...comp,
            tags_json: parseJsonSafe(comp.tags_json, []),
            contacts_json: parseJsonSafe(comp.contacts_json, []),
            custom_fields: parseJsonSafe(comp.custom_fields, {}),
          },
          subsidiaries: subsidiariesRes.rows,
          contacts: maskedContacts,
          deals: dealsRes.rows,
          quotes: quotesRes.rows,
          sales_orders: soRes.rows,
          purchase_orders: poRes.rows,
          invoices: invoicesRes.rows,
          activities: activitiesRes.rows,
          rollup: {
            contacts_count: maskedContacts.length,
            subsidiaries_count: subsidiariesRes.rows.length,
            deals_count: dealsRes.rows.length,
            won_deals_vnd: wonDealsVnd,
            sales_orders_paid_vnd: soPaidVnd,
            total_revenue_rollup_vnd: Math.max(wonDealsVnd, soPaidVnd),
          },
        };
      });

      if (!data) {
        sendApiError(res, 404, 'COMPANY_NOT_FOUND', 'Không tìm thấy hồ sơ doanh nghiệp.');
        return;
      }
      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_COMPANY_GET_FAILED', err?.message || 'Không thể tải chi tiết doanh nghiệp B2B.');
    }
  }
);

dealsCompaniesRouter.put(
  '/companies/:id',
  requireAnyPermission([
    ['companies', 'edit'],
    ['crm_b2b', 'edit'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const compId = String(req.params.id || '').trim();
      const b = req.body || {};

      if (b.parent_company_id && String(b.parent_company_id) === compId) {
        sendApiError(res, 400, 'CIRCULAR_COMPANY_HIERARCHY', 'Công ty mẹ không thể là chính công ty hiện tại.');
        return;
      }

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const curRes = await client.query<Record<string, any>>(
          'SELECT * FROM tenant_b2b_companies WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, compId]
        );
        if (curRes.rows.length === 0) return null;
        const cur = curRes.rows[0];
        const nextTier =
          b.tier && ['standard', 'silver', 'gold', 'enterprise'].includes(String(b.tier))
            ? String(b.tier)
            : cur.tier;

        await client.query(
          `UPDATE tenant_b2b_companies
           SET name = $3,
               tax_code = $4,
               industry = $5,
               company_size = $6,
               website = $7,
               billing_address = $8,
               phone = $9,
               email = $10,
               representative_name = $11,
               owner_user_id = $12,
               parent_company_id = $13,
               status = $14,
               tier = $15,
               sla_tier = $15,
               tags_json = $16,
               custom_fields = $17,
               notes = $18,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            compId,
            b.name !== undefined ? String(b.name).trim().slice(0, 255) : cur.name,
            b.tax_code !== undefined ? (b.tax_code ? String(b.tax_code).trim().slice(0, 50) : null) : cur.tax_code,
            b.industry !== undefined ? b.industry || null : cur.industry,
            b.company_size !== undefined ? b.company_size || null : cur.company_size,
            b.website !== undefined ? b.website || null : cur.website,
            b.billing_address !== undefined ? b.billing_address || null : cur.billing_address,
            b.phone !== undefined ? b.phone || null : cur.phone,
            b.email !== undefined ? b.email || null : cur.email,
            b.representative_name !== undefined ? b.representative_name || null : cur.representative_name,
            b.owner_user_id !== undefined ? b.owner_user_id || null : cur.owner_user_id,
            b.parent_company_id !== undefined ? b.parent_company_id || null : cur.parent_company_id,
            b.status !== undefined ? String(b.status) : cur.status,
            nextTier,
            JSON.stringify(Array.isArray(b.tags_json) ? b.tags_json : parseJsonSafe(cur.tags_json, [])),
            JSON.stringify(
              b.custom_fields && typeof b.custom_fields === 'object'
                ? b.custom_fields
                : parseJsonSafe(cur.custom_fields, {})
            ),
            b.notes !== undefined ? b.notes || null : cur.notes,
          ]
        );

        const fresh = await client.query('SELECT * FROM tenant_b2b_companies WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          compId,
        ]);
        return fresh.rows[0];
      });

      if (!updated) {
        sendApiError(res, 404, 'COMPANY_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_COMPANY_UPDATE_FAILED', err?.message || 'Không thể cập nhật doanh nghiệp.');
    }
  }
);

dealsCompaniesRouter.delete(
  '/companies/:id',
  requireAnyPermission([
    ['companies', 'delete'],
    ['crm_b2b', 'delete'],
  ]),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const compId = String(req.params.id || '').trim();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'UPDATE tenant_b2b_companies SET parent_company_id = NULL WHERE tenant_id = $1 AND parent_company_id = $2',
          [ctx.tenantId, compId]
        );
        await client.query(
          'UPDATE leads SET company_id = NULL WHERE tenant_id = $1 AND company_id = $2',
          [ctx.tenantId, compId]
        );
        await client.query('DELETE FROM tenant_b2b_companies WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          compId,
        ]);
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_COMPANY_DELETE_FAILED', err?.message || 'Không thể xóa doanh nghiệp.');
    }
  }
);
