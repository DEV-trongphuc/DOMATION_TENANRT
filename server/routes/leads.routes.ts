import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDatabasePool, type DbClient } from '../core/database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  checkEffectivePermission,
  getResolvedUserRbac,
  requirePermission,
  requireTenantAuth,
  resolveDescendantDepartmentIds,
  resolveUserEffectivePermissions,
  sendApiError,
  type GranularAction,
  type ResolvedUserRbacResult,
} from '../core/security/rbac.ts';
import { acceptsGzipEncoding } from '../core/http/encoding.ts';
import {
  derivePiiActorFlagsFromRbac,
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

// ============================================================================
// Self-Initializing Wave A Public Databank Schema (`crm_public_leads_pool`)
// ============================================================================
const databankPoolsInit = new WeakSet<object>();
const databankPoolsPending = new WeakMap<object, Promise<void>>();

async function ensureDatabankSchema(): Promise<void> {
  const pool = getDatabasePool();
  if (databankPoolsInit.has(pool)) return;
  let running = databankPoolsPending.get(pool);
  if (!running) {
    running = (async () => {
      await withSystemPrivilege(async (client) => {
        if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
          await client.query(`
            CREATE TABLE IF NOT EXISTS crm_public_leads_pool (
              id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
              tenant_id VARCHAR(36) NOT NULL,
              lead_id VARCHAR(36) NOT NULL,
              branch_id VARCHAR(36) NULL,
              released_by VARCHAR(36) NULL,
              release_reason TEXT NULL,
              pool_status VARCHAR(30) NOT NULL DEFAULT 'available',
              claimed_by VARCHAR(36) NULL,
              claimed_at DATETIME(6) NULL,
              expires_at DATETIME(6) NULL,
              metadata_json JSON NULL,
              created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
              updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
              CONSTRAINT uk_public_pool_lead UNIQUE (tenant_id, lead_id),
              INDEX idx_public_pool_status (tenant_id, pool_status, created_at DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          `);
        } else {
          const pgStmts = [
            `CREATE TABLE IF NOT EXISTS crm_public_leads_pool (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
              lead_id UUID NOT NULL,
              branch_id UUID,
              released_by UUID,
              release_reason TEXT,
              pool_status VARCHAR(30) NOT NULL DEFAULT 'available',
              claimed_by UUID,
              claimed_at TIMESTAMPTZ,
              expires_at TIMESTAMPTZ,
              metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
              created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
              CONSTRAINT uk_public_pool_lead UNIQUE (tenant_id, lead_id)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_public_pool_status
              ON crm_public_leads_pool (tenant_id, pool_status, created_at DESC)`,
            `ALTER TABLE crm_public_leads_pool ENABLE ROW LEVEL SECURITY`,
            `ALTER TABLE crm_public_leads_pool FORCE ROW LEVEL SECURITY`,
            `DROP POLICY IF EXISTS tenant_isolation_crm_public_leads_pool ON crm_public_leads_pool`,
            `CREATE POLICY tenant_isolation_crm_public_leads_pool ON crm_public_leads_pool
              USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
              WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)`,
            `GRANT SELECT, INSERT, UPDATE, DELETE ON crm_public_leads_pool TO autodata_app`,
          ];
          for (const stmt of pgStmts) {
            await client.query(stmt);
          }
        }
      });
      databankPoolsInit.add(pool);
    })().finally(() => {
      databankPoolsPending.delete(pool);
    });
    databankPoolsPending.set(pool, running);
  }
  await running;
}

async function ensureDatabankMiddleware(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await ensureDatabankSchema();
    next();
  } catch (err: any) {
    sendApiError(res, 500, 'DATABANK_SCHEMA_FAILED', err?.message || 'Không thể khởi tạo kho số Public Databank.');
  }
}

// ============================================================================
// Granular RBAC Scope Helpers for Leads (Zero Role-String Short-Circuits)
// ============================================================================
async function buildRbacLeadScopeInTx(
  client: DbClient,
  tenantId: string,
  resolved: ResolvedUserRbacResult,
  startParamIndex = 1,
  action: GranularAction = 'view',
  aliases?: { tenantColumn?: string; ownerColumn?: string }
): Promise<{ clause: string; values: unknown[]; nextIndex: number }> {
  const tenantCol = aliases?.tenantColumn || 'leads.tenant_id';
  const ownerCol = aliases?.ownerColumn || 'leads.assigned_to';
  const check = checkEffectivePermission(resolved, 'leads', action);
  if (!check.allowed || !resolved.userOrg) {
    return { clause: `${tenantCol} = $${startParamIndex} AND 1 = 0`, values: [tenantId], nextIndex: startParamIndex + 1 };
  }
  if (resolved.userOrg.is_tenant_owner || check.scope === 'company') {
    return { clause: `${tenantCol} = $${startParamIndex}`, values: [tenantId], nextIndex: startParamIndex + 1 };
  }
  if (
    check.scope === 'department' &&
    !resolved.userOrg.department_id &&
    (resolved.userOrg.role || '').toLowerCase() === 'manager'
  ) {
    const deptCnt = await client.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM tenant_departments WHERE tenant_id = $1',
      [tenantId]
    );
    if (Number(deptCnt.rows[0]?.cnt || 0) === 0) {
      return { clause: `${tenantCol} = $${startParamIndex}`, values: [tenantId], nextIndex: startParamIndex + 1 };
    }
  }
  return buildGranularScopeWhereClause(client, tenantId, resolved.userOrg, check.scope, {
    tenantColumn: tenantCol,
    ownerColumn: ownerCol,
    startParamIndex,
    allowUnassignedForManagers: check.scope !== 'own',
  });
}

async function canActorAccessLeadInTx(
  client: DbClient,
  tenantId: string,
  resolved: ResolvedUserRbacResult,
  leadAssignedTo: string | null,
  action: GranularAction = 'edit'
): Promise<boolean> {
  const check = checkEffectivePermission(resolved, 'leads', action);
  if (!check.allowed || !resolved.userOrg) return false;
  if (resolved.userOrg.is_tenant_owner || check.scope === 'company') return true;
  if (leadAssignedTo && leadAssignedTo === resolved.userOrg.user_id) return true;
  if (!leadAssignedTo) {
    return check.scope !== 'own' && check.scope !== 'none';
  }
  if (check.scope === 'own') return false;

  if (
    check.scope === 'department' &&
    !resolved.userOrg.department_id &&
    (resolved.userOrg.role || '').toLowerCase() === 'manager'
  ) {
    const deptCnt = await client.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM tenant_departments WHERE tenant_id = $1',
      [tenantId]
    );
    if (Number(deptCnt.rows[0]?.cnt || 0) === 0) return true;
  }

  const targetRes = await client.query<{
    branch_id: string | null;
    department_id: string | null;
    team_id: string | null;
  }>(
    'SELECT branch_id, department_id, team_id FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [tenantId, leadAssignedTo]
  );
  const tUser = targetRes.rows[0];
  if (!tUser) return false;

  if (check.scope === 'team') {
    return Boolean(resolved.userOrg.team_id && tUser.team_id === resolved.userOrg.team_id);
  }
  if (check.scope === 'department') {
    return Boolean(resolved.userOrg.department_id && tUser.department_id === resolved.userOrg.department_id);
  }
  if (check.scope === 'sub_departments') {
    if (!resolved.userOrg.department_id || !tUser.department_id) return false;
    const allDepts = await client.query<{ id: string; parent_department_id: string | null }>(
      'SELECT id, parent_department_id FROM tenant_departments WHERE tenant_id = $1',
      [tenantId]
    );
    const descendants = resolveDescendantDepartmentIds(allDepts.rows, resolved.userOrg.department_id);
    return descendants.includes(String(tUser.department_id));
  }
  if (check.scope === 'branch') {
    return Boolean(resolved.userOrg.branch_id && tUser.branch_id === resolved.userOrg.branch_id);
  }
  return false;
}

// ============================================================================
// Public Databank Pool (`/api/v1/leads/databank`) — BEFORE `/:id` routes
// ============================================================================
leadsRouter.use('/databank', ensureDatabankMiddleware);

leadsRouter.get('/databank', requirePermission('leads', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const actorFlags = derivePiiActorFlagsFromRbac(resolved, ctx);
    const statusFilter = req.query.status ? String(req.query.status).trim().toLowerCase() : 'available';
    const search = req.query.search ? String(req.query.search).trim() : '';
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = (page - 1) * limit;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const params: unknown[] = [ctx.tenantId];
      let where = 'p.tenant_id = $1';
      if (statusFilter && statusFilter !== 'all') {
        params.push(statusFilter);
        where += ` AND p.pool_status = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        const pIdx = `$${params.length}`;
        where += ` AND (COALESCE(l.name, '') ILIKE ${pIdx} OR COALESCE(l.phone, '') ILIKE ${pIdx} OR COALESCE(l.email, '') ILIKE ${pIdx})`;
      }

      const [statsRes, cntRes, rowsRes] = await Promise.all([
        client.query<{
          available: number;
          claimed: number;
          blocked: number;
          restored: number;
          total: number;
        }>(
          `SELECT
             COALESCE(SUM(CASE WHEN pool_status = 'available' THEN 1 ELSE 0 END), 0) AS available,
             COALESCE(SUM(CASE WHEN pool_status = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed,
             COALESCE(SUM(CASE WHEN pool_status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
             COALESCE(SUM(CASE WHEN pool_status = 'restored' THEN 1 ELSE 0 END), 0) AS restored,
             COUNT(*) AS total
           FROM crm_public_leads_pool
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ total: number }>(
          `SELECT COUNT(*) AS total
           FROM crm_public_leads_pool p
           LEFT JOIN leads l ON l.tenant_id = p.tenant_id AND l.id = p.lead_id
           WHERE ${where}`,
          params
        ),
        client.query(
          `SELECT p.*, p.pool_status AS status, p.release_reason AS reason, p.created_at AS released_at,
                  l.name, l.phone, l.email, l.source, l.campaign, l.product_interest, l.lead_score,
                  l.is_accepted, rb.full_name AS released_by_name, cb.full_name AS claimed_by_name
           FROM crm_public_leads_pool p
           LEFT JOIN leads l ON l.tenant_id = p.tenant_id AND l.id = p.lead_id
           LEFT JOIN users rb ON rb.tenant_id = p.tenant_id AND rb.id = p.released_by
           LEFT JOIN users cb ON cb.tenant_id = p.tenant_id AND cb.id = p.claimed_by
           WHERE ${where}
           ORDER BY p.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);

      const items = rowsRes.rows.map((r) => {
        const masked = transformLeadForActor(
          {
            phone: r.phone || '',
            email: r.email || null,
            is_accepted: r.pool_status === 'claimed' ? Boolean(r.is_accepted) : false,
          },
          ctx,
          cfg,
          actorFlags.canUnmaskPhone,
          actorFlags
        );
        return {
          ...r,
          phone: masked.phone,
          email: masked.email,
          pii_masked: masked.pii_masked,
        };
      });

      const st = statsRes.rows[0] || { available: 0, claimed: 0, blocked: 0, restored: 0, total: 0 };
      const total = Number(cntRes.rows[0]?.total || 0);
      return {
        items,
        stats: {
          available: Number(st.available || 0),
          claimed: Number(st.claimed || 0),
          blocked: Number(st.blocked || 0),
          restored: Number(st.restored || 0),
          total: Number(st.total || 0),
        },
        pagination: { total, page, total_pages: Math.max(1, Math.ceil(total / limit)) },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'DATABANK_LIST_FAILED', err?.message || 'Không thể tải danh sách Kho Số Chung.');
  }
});

async function handleDatabankRelease(req: Request, res: Response) {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const b = req.body || {};
    const leadIdsRaw = Array.isArray(b.lead_ids)
      ? b.lead_ids
      : [req.params.id || b.lead_id || b.id].filter(Boolean);
    const leadIds = Array.from(new Set(leadIdsRaw.map((x: unknown) => String(x || '').trim()).filter(Boolean)));
    if (leadIds.length === 0) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần cung cấp ít nhất 1 lead_id để thả vào Kho Số.');
      return;
    }
    const reason = String(b.reason || 'Thả số về Kho Số Chung (Public Databank)').trim();

    const released = await withTenantTransaction(ctx.tenantId, async (client) => {
      const results: any[] = [];
      for (const lid of leadIds) {
        const lRes = await client.query<{
          id: string;
          stage_id: string;
          phone: string;
          assigned_to: string | null;
        }>(
          'SELECT id, stage_id, phone, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
          [ctx.tenantId, lid]
        );
        const lead = lRes.rows[0];
        if (!lead) continue;
        const canAccess = await canActorAccessLeadInTx(client, ctx.tenantId, resolved, lead.assigned_to, 'edit');
        if (!canAccess) {
          throw new Error('FORBIDDEN_NOT_ASSIGNED');
        }

        const poolId = crypto.randomUUID();
        await client.query(
          `INSERT INTO crm_public_leads_pool (
             id, tenant_id, lead_id, branch_id, released_by, release_reason,
             pool_status, claimed_by, claimed_at, metadata_json
           ) VALUES ($1, $2, $3, $4, $5, $6, 'available', NULL, NULL, $7::jsonb)
           ON CONFLICT (tenant_id, lead_id)
           DO UPDATE SET
             pool_status = 'available',
             release_reason = EXCLUDED.release_reason,
             released_by = EXCLUDED.released_by,
             claimed_by = NULL,
             claimed_at = NULL,
             metadata_json = EXCLUDED.metadata_json,
             updated_at = clock_timestamp()`,
          [
            poolId,
            ctx.tenantId,
            lid,
            resolved.userOrg?.branch_id || null,
            ctx.userId,
            reason,
            JSON.stringify({ previous_owner: lead.assigned_to }),
          ]
        );
        await client.query(
          `UPDATE leads
           SET status = 'recalled', assigned_to = NULL, is_accepted = false, accepted_at = NULL, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, lid]
        );
        await client.query(
          `INSERT INTO lead_timeline_events (
             tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, 'databank_release', 'system', $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            ctx.tenantId,
            lid,
            ctx.userId,
            String(resolved.userOrg?.role || ctx.userRole || 'staff').slice(0, 30),
            ctx.userName || 'Staff',
            'Thả khách hàng vào Kho Số Chung (Databank)',
            reason,
            JSON.stringify({ previous_owner: lead.assigned_to }),
          ]
        );
        if (lead.stage_id) {
          await tenantRedis.zrem('sla_queue', `${lid}:${lead.stage_id}`, ctx.tenantId);
        }
        const pRow = await client.query(
          `SELECT *, pool_status AS status, release_reason AS reason, created_at AS released_at
           FROM crm_public_leads_pool WHERE tenant_id = $1 AND lead_id = $2 LIMIT 1`,
          [ctx.tenantId, lid]
        );
        results.push(pRow.rows[0]);
      }
      return results;
    });

    res.status(201).json({ success: true, data: released.length === 1 ? released[0] : released, items: released });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_NOT_ASSIGNED') {
      sendApiError(res, 403, 'FORBIDDEN_NOT_ASSIGNED', 'Bạn không có quyền thả lead này vào Kho Số Chung.');
      return;
    }
    sendApiError(res, 500, 'DATABANK_RELEASE_FAILED', err?.message || 'Không thể thả số vào Kho Số Chung.');
  }
}

async function handleDatabankClaim(req: Request, res: Response) {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const targetId = String(req.params.id || req.body?.id || req.body?.lead_id || '').trim();
    if (!targetId) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần cung cấp id hoặc lead_id để nhận số từ Kho Chung.');
      return;
    }

    const claimed = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query<{ id: string; lead_id: string; pool_status: string }>(
        `SELECT id, lead_id, pool_status
         FROM crm_public_leads_pool
         WHERE tenant_id = $1 AND (id = $2 OR lead_id = $2)
         FOR UPDATE`,
        [ctx.tenantId, targetId]
      );
      const poolRow = pRes.rows[0];
      if (!poolRow) throw new Error('DATABANK_ENTRY_NOT_FOUND');
      if (poolRow.pool_status !== 'available') throw new Error('DATABANK_ALREADY_CLAIMED');

      await client.query(
        `UPDATE crm_public_leads_pool
         SET pool_status = 'claimed', claimed_by = $3, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, poolRow.id, ctx.userId]
      );
      await client.query(
        `UPDATE leads
         SET assigned_to = $3, status = 'assigned', is_accepted = true, accepted_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, poolRow.lead_id, ctx.userId]
      );
      await client.query(
        `INSERT INTO lead_timeline_events (
           tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
         ) VALUES ($1, $2, 'databank_claim', 'system', $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          ctx.tenantId,
          poolRow.lead_id,
          ctx.userId,
          String(resolved.userOrg?.role || ctx.userRole || 'staff').slice(0, 30),
          ctx.userName || 'Sale',
          'Nhận số trực tiếp từ Kho Số Chung (Public Databank)',
          'Chủ động nhận chăm sóc từ Kho Số Chung',
          JSON.stringify({ pool_id: poolRow.id }),
        ]
      );
      const updatedRes = await client.query(
        `SELECT p.*, p.pool_status AS status, p.release_reason AS reason, p.created_at AS released_at,
                l.name, l.phone, l.email, l.assigned_to
         FROM crm_public_leads_pool p
         LEFT JOIN leads l ON l.tenant_id = p.tenant_id AND l.id = p.lead_id
         WHERE p.tenant_id = $1 AND p.id = $2`,
        [ctx.tenantId, poolRow.id]
      );
      return updatedRes.rows[0];
    });

    res.json({ success: true, data: claimed });
  } catch (err: any) {
    if (err?.message === 'DATABANK_ENTRY_NOT_FOUND') {
      sendApiError(res, 404, 'DATABANK_ENTRY_NOT_FOUND', 'Không tìm thấy bản ghi trong Kho Số Chung.');
      return;
    }
    if (err?.message === 'DATABANK_ALREADY_CLAIMED') {
      sendApiError(res, 409, 'DATABANK_ALREADY_CLAIMED', 'Số này đã có người nhận hoặc đang bị khóa.');
      return;
    }
    sendApiError(res, 500, 'DATABANK_CLAIM_FAILED', err?.message || 'Không thể nhận số từ Kho Chung.');
  }
}

async function handleDatabankStatusAction(
  req: Request,
  res: Response,
  mode: 'block' | 'unblock' | 'restore'
) {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const targetId = String(req.params.id || req.body?.id || req.body?.lead_id || '').trim();
    if (!targetId) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần cung cấp id hoặc lead_id.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query<{ id: string; lead_id: string; released_by: string | null }>(
        `SELECT id, lead_id, released_by
         FROM crm_public_leads_pool
         WHERE tenant_id = $1 AND (id = $2 OR lead_id = $2)
         FOR UPDATE`,
        [ctx.tenantId, targetId]
      );
      const row = pRes.rows[0];
      if (!row) throw new Error('DATABANK_ENTRY_NOT_FOUND');

      if (mode === 'block') {
        const blockReason = String(req.body?.reason || 'Chặn số rác / DNC trong Kho Số Chung').trim();
        await client.query(
          `UPDATE crm_public_leads_pool
           SET pool_status = 'blocked', release_reason = $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, row.id, blockReason]
        );
        await client.query(
          `UPDATE leads SET quality_status = 'disqualified', status = 'blacklisted', updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, row.lead_id]
        );
      } else if (mode === 'unblock') {
        await client.query(
          `UPDATE crm_public_leads_pool
           SET pool_status = 'available', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, row.id]
        );
        await client.query(
          `UPDATE leads SET quality_status = 'Pending', status = 'recalled', updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, row.lead_id]
        );
      } else {
        const targetOwner = req.body?.target_user_id ? String(req.body.target_user_id) : row.released_by || ctx.userId;
        await client.query(
          `UPDATE crm_public_leads_pool
           SET pool_status = 'restored', claimed_by = $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, row.id, targetOwner]
        );
        await client.query(
          `UPDATE leads
           SET status = 'assigned', assigned_to = $3, quality_status = 'Pending', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, row.lead_id, targetOwner]
        );
      }

      await client.query(
        `INSERT INTO lead_timeline_events (
           tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
         ) VALUES ($1, $2, $3, 'system', $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          ctx.tenantId,
          row.lead_id,
          `databank_${mode}`,
          ctx.userId,
          String(resolved.userOrg?.role || ctx.userRole || 'staff').slice(0, 30),
          ctx.userName || 'Staff',
          `Databank: ${mode.toUpperCase()}`,
          req.body?.reason ? String(req.body.reason) : null,
          JSON.stringify({ pool_id: row.id }),
        ]
      );
      const out = await client.query(
        `SELECT *, pool_status AS status, release_reason AS reason, created_at AS released_at
         FROM crm_public_leads_pool WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, row.id]
      );
      return out.rows[0];
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    if (err?.message === 'DATABANK_ENTRY_NOT_FOUND') {
      sendApiError(res, 404, 'DATABANK_ENTRY_NOT_FOUND', 'Không tìm thấy bản ghi trong Kho Số Chung.');
      return;
    }
    sendApiError(res, 500, 'DATABANK_ACTION_FAILED', err?.message || 'Không thể xử lý thao tác Kho Số.');
  }
}

leadsRouter.post('/databank/release', requirePermission('leads', 'edit'), handleDatabankRelease);
leadsRouter.post('/databank/:id/release', requirePermission('leads', 'edit'), handleDatabankRelease);
leadsRouter.post('/databank/claim', requirePermission('leads', 'view'), handleDatabankClaim);
leadsRouter.post('/databank/:id/claim', requirePermission('leads', 'view'), handleDatabankClaim);
leadsRouter.post('/databank/block', requirePermission('leads', 'edit'), (req, res) =>
  handleDatabankStatusAction(req, res, 'block')
);
leadsRouter.post('/databank/:id/block', requirePermission('leads', 'edit'), (req, res) =>
  handleDatabankStatusAction(req, res, 'block')
);
leadsRouter.post('/databank/unblock', requirePermission('leads', 'edit'), (req, res) =>
  handleDatabankStatusAction(req, res, 'unblock')
);
leadsRouter.post('/databank/:id/unblock', requirePermission('leads', 'edit'), (req, res) =>
  handleDatabankStatusAction(req, res, 'unblock')
);
leadsRouter.post('/databank/restore', requirePermission('leads', 'edit'), (req, res) =>
  handleDatabankStatusAction(req, res, 'restore')
);
leadsRouter.post('/databank/:id/restore', requirePermission('leads', 'edit'), (req, res) =>
  handleDatabankStatusAction(req, res, 'restore')
);
leadsRouter.post('/databank', requirePermission('leads', 'view'), async (req, res) => {
  const action = String(req.body?.action || '').trim().toLowerCase();
  const resolved = await getResolvedUserRbac(req);
  if (action === 'claim') {
    await handleDatabankClaim(req, res);
    return;
  }
  if (!checkEffectivePermission(resolved, 'leads', 'edit').allowed) {
    sendApiError(res, 403, 'FORBIDDEN_RBAC_PERMISSION', "Tài khoản không có quyền 'edit' trên phân hệ 'leads'.");
    return;
  }
  if (action === 'release') {
    await handleDatabankRelease(req, res);
  } else if (action === 'block' || action === 'unblock' || action === 'restore') {
    await handleDatabankStatusAction(req, res, action);
  } else {
    sendApiError(res, 422, 'INVALID_DATABANK_ACTION', 'action phải là release, claim, block, unblock hoặc restore.');
  }
});

leadsRouter.post('/quick-test', requirePermission('leads', 'create'), async (req, res) => {
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

// Real-Time Dashboard KPI Summary (Granular RBAC Scope + Cross-Dialect PG/MariaDB SQL)
leadsRouter.get('/stats/summary', requirePermission('leads', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const pipelineId = req.query.pipeline_id ? String(req.query.pipeline_id).trim() : null;

    const summary = await withTenantTransaction(ctx.tenantId, async (client) => {
      const scoped = await buildRbacLeadScopeInTx(client, ctx.tenantId, resolved, 1, 'view');
      const kpiParams = [...scoped.values];
      let kpiWhere = scoped.clause;
      if (pipelineId) {
        kpiParams.push(pipelineId);
        kpiWhere += ` AND leads.pipeline_id = $${kpiParams.length}`;
      }

      const kpiRes = await client.query(
        `SELECT
           COUNT(*) AS total_leads,
           COALESCE(SUM(CASE WHEN leads.status = 'assigned' THEN 1 ELSE 0 END), 0) AS assigned_leads,
           COALESCE(SUM(CASE WHEN leads.status = 'unassigned_pending' THEN 1 ELSE 0 END), 0) AS unassigned_leads,
           COALESCE(SUM(CASE WHEN leads.is_accepted = true THEN 1 ELSE 0 END), 0) AS accepted_leads,
           COALESCE(SUM(CASE WHEN leads.is_duplicate_reminder = true THEN 1 ELSE 0 END), 0) AS duplicate_reminders,
           COALESCE(SUM(CASE WHEN leads.sla_breached = true THEN 1 ELSE 0 END), 0) AS sla_breached_leads,
           COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN 1 ELSE 0 END), 0) AS won_leads
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
                COUNT(leads.id) AS count
         FROM tenant_pipeline_stages s
         LEFT JOIN leads ON leads.tenant_id = s.tenant_id AND leads.stage_id = s.id AND (${scoped.clause})
         WHERE ${stageWhere}
         GROUP BY s.id, s.pipeline_id, s.stage_name, s.color_hex, s.capi_event_mapping, s.stage_order
         ORDER BY s.stage_order ASC`,
        stageParams
      );

      const bySourceRes = await client.query(
        `SELECT leads.source, COUNT(*) AS count
         FROM leads
         WHERE ${kpiWhere}
         GROUP BY leads.source
         ORDER BY count DESC
         LIMIT 8`,
        kpiParams
      );

      const capiCountRes = await client.query<{ sent_ok: number }>(
        `SELECT COUNT(*) AS sent_ok
         FROM capi_logs
         WHERE tenant_id = $1 AND response_status = 200`,
        [ctx.tenantId]
      );

      const latencyRowsRes = await client.query<{ metadata: unknown }>(
        `SELECT metadata
         FROM lead_timeline_events
         WHERE tenant_id = $1
           AND event_type IN ('lead_distributed', 'duplicate_reminder')
         ORDER BY created_at DESC
         LIMIT 200`,
        [ctx.tenantId]
      );
      let latSum = 0;
      let latCount = 0;
      for (const rowMeta of latencyRowsRes.rows) {
        let metaObj = rowMeta.metadata as any;
        if (typeof metaObj === 'string') {
          try {
            metaObj = JSON.parse(metaObj);
          } catch {
            metaObj = null;
          }
        }
        const latVal = metaObj && typeof metaObj === 'object' ? Number(metaObj.latency_ms) : NaN;
        if (Number.isFinite(latVal) && latVal >= 0) {
          latSum += latVal;
          latCount++;
        }
      }
      const rawAvgMs = latCount > 0 ? latSum / latCount : null;
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

// 5.1 List Leads (Granular 7-Tier RBAC Scope + Kernel RLS + Configurable PII Masking)
leadsRouter.get('/', requirePermission('leads', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const leadsView = checkEffectivePermission(resolved, 'leads', 'view');
    const actorFlags = derivePiiActorFlagsFromRbac(resolved, ctx);
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
    const roundId = req.query.round_id ? String(req.query.round_id).trim() : null;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const scoped = await buildRbacLeadScopeInTx(client, ctx.tenantId, resolved, 1, 'view');
      const params = [...scoped.values];
      let where = `${scoped.clause} AND leads.is_deleted = false`;

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
      if (
        assignedFilter &&
        (resolved.userOrg?.is_tenant_owner || (leadsView.scope !== 'own' && leadsView.scope !== 'none'))
      ) {
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

      const countRes = await client.query<{ total: number }>(
        `SELECT COUNT(*) AS total FROM leads WHERE ${where}`,
        params
      );
      const canUnmaskPhone = actorFlags.canUnmaskPhone;

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
          canUnmaskPhone,
          actorFlags
        );
        return transformed;
      });

      const total = Number(countRes.rows[0]?.total || 0);
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

// Op 18: Export Lead Data CSV (Governed 100% by Granular RBAC `leads.export` & Data Scope)
leadsRouter.get('/export', requirePermission('leads', 'export'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.query.pipeline_id ? String(req.query.pipeline_id).trim() : null;

    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const rbacExport = await getResolvedUserRbac(req);
    const actorFlags = derivePiiActorFlagsFromRbac(rbacExport, ctx);
    const canUnmaskExport = actorFlags.canUnmaskPhone;

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
        const scoped = await buildRbacLeadScopeInTx(client, ctx.tenantId, rbacExport, 1, 'export', {
          tenantColumn: 'l.tenant_id',
          ownerColumn: 'l.assigned_to',
        });
        const params: unknown[] = [...scoped.values];
        let where = `${scoped.clause} AND l.is_deleted = false`;
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

// Create or Bulk Import Leads (Governed 100% by Granular RBAC `leads.create`)
leadsRouter.post('/', requirePermission('leads', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const tenantCfg = await getTenantSettingsCached(ctx.tenantId);
    const resolved = await getResolvedUserRbac(req);
    const leadsView = checkEffectivePermission(resolved, 'leads', 'view');
    const canAssignOther = Boolean(
      resolved.userOrg?.is_tenant_owner ||
        checkEffectivePermission(resolved, 'leads', 'assign').allowed ||
        (leadsView.scope !== 'own' && leadsView.scope !== 'none')
    );

    const resolveForcedAssignee = (rawItem: Record<string, unknown>): string | undefined => {
      const rawAssignee = rawItem.force_assigned_to || rawItem.assigned_to;
      const cleanAssignee = typeof rawAssignee === 'string' && rawAssignee.trim() ? rawAssignee.trim() : undefined;
      if (!canAssignOther) {
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
leadsRouter.patch('/:id', requirePermission('leads', 'edit'), async (req, res) => {
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

    const resolved = await getResolvedUserRbac(req);
    const actorFlags = derivePiiActorFlagsFromRbac(resolved, ctx);
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
      if (!(await canActorAccessLeadInTx(client, ctx.tenantId, resolved, lead.assigned_to, 'edit'))) {
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
leadsRouter.patch('/:id/stage', requirePermission('leads', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const leadId = req.params.id;
    const { stage_id, note, deal_value_vnd, deal_value } = req.body || {};

    if (!stage_id) {
      sendApiError(res, 422, 'MISSING_STAGE_ID', 'Vui lòng chọn bước Pipeline cần chuyển.');
      return;
    }

    const txState = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);

      const leadBaseRes = await client.query<{
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
      }>(
        `SELECT id, stage_id, assigned_to, name, phone, email,
                product_interest, budget_range, source, campaign, utm_source,
                meta_lead_id, fbclid, fbc, fbp, custom_fields
         FROM leads
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [ctx.tenantId, leadId]
      );
      const leadBase = leadBaseRes.rows[0];
      if (!leadBase) {
        throw new Error('LEAD_NOT_FOUND');
      }

      if (!(await canActorAccessLeadInTx(client, ctx.tenantId, resolved, leadBase.assigned_to, 'edit'))) {
        throw new Error('FORBIDDEN_NOT_ASSIGNED');
      }

      const oldStageRes = leadBase.stage_id
        ? await client.query<{ stage_key: string; stage_name: string }>(
            'SELECT stage_key, stage_name FROM tenant_pipeline_stages WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [ctx.tenantId, leadBase.stage_id]
          )
        : { rows: [] as Array<{ stage_key: string; stage_name: string }> };

      const lead = {
        ...leadBase,
        old_stage_key: oldStageRes.rows[0]?.stage_key || '',
        old_stage_name: oldStageRes.rows[0]?.stage_name || '',
      };

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
        const canBypassStageRoleGate = Boolean(
          resolved.userOrg?.is_tenant_owner || checkEffectivePermission(resolved, 'pipelines', 'manage_config').allowed
        );
        if ((hasRoleIdGate || hasRoleKeyGate) && !canBypassStageRoleGate) {
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
            const actorRoleStr = resolved.userOrg?.role || ctx.userRole;
            const passByKey = hasRoleKeyGate ? rule.allowed_roles.includes(actorRoleStr) : false;
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
leadsRouter.post('/:id/accept', requirePermission('leads', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const leadId = req.params.id;

    const resolved = await getResolvedUserRbac(req);
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
      if (!(await canActorAccessLeadInTx(client, ctx.tenantId, resolved, lead.assigned_to, 'edit'))) {
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

// Op 17: Reassign Lead (Governed 100% by Granular RBAC `leads.assign` & Data Scope)
leadsRouter.post('/:id/reassign', requirePermission('leads', 'assign'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const leadId = req.params.id;
    const { target_user_id, reason } = req.body || {};
    if (!target_user_id) {
      sendApiError(res, 422, 'MISSING_TARGET_USER', 'Vui lòng chọn nhân sự nhận bàn giao.');
      return;
    }

    const { data, slaMember, slaDeadlineMs } = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const assignPerm = checkEffectivePermission(resolved, 'leads', 'assign');
      if (!resolved.userOrg?.is_tenant_owner && assignPerm.scope === 'own') {
        const ownCheck = await client.query<{ assigned_to: string | null }>(
          'SELECT assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, leadId]
        );
        if (!ownCheck.rows[0] || ownCheck.rows[0].assigned_to !== ctx.userId) {
          throw new Error('FORBIDDEN_ROLE');
        }
      } else if (!resolved.userOrg?.is_tenant_owner && assignPerm.scope !== 'company') {
        const curCheck = await client.query<{ assigned_to: string | null }>(
          'SELECT assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, leadId]
        );
        if (!curCheck.rows[0]) throw new Error('LEAD_NOT_FOUND');
        if (!(await canActorAccessLeadInTx(client, ctx.tenantId, resolved, curCheck.rows[0].assigned_to, 'assign'))) {
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
leadsRouter.get('/:id/timeline', requirePermission('leads', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const actorFlags = derivePiiActorFlagsFromRbac(resolved, ctx);
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
      if (!(await canActorAccessLeadInTx(client, ctx.tenantId, resolved, leadCheck.rows[0].assigned_to, 'view'))) {
        throw new Error('FORBIDDEN_TIMELINE_ACCESS');
      }

      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const limit = Math.min(cfg.max_page_size, Math.max(1, Number.isFinite(rawReqLimit) ? rawReqLimit : 30));
      const maskActive = shouldMaskPiiForActor(ctx, cfg, leadCheck.rows[0], actorFlags.canUnmaskPhone, actorFlags);
      const hideInternal = shouldHideInternalNotesForActor(ctx, cfg, actorFlags);

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
leadsRouter.post('/:id/timeline/notes', requirePermission('leads', 'edit'), async (req, res) => {
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

    const resolved = await getResolvedUserRbac(req);
    const actorFlags = derivePiiActorFlagsFromRbac(resolved, ctx);
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const leadCheck = await client.query<{ assigned_to: string | null; is_accepted: boolean }>(
        'SELECT assigned_to, is_accepted FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!leadCheck.rows[0]) throw new Error('LEAD_NOT_FOUND');
      if (!(await canActorAccessLeadInTx(client, ctx.tenantId, resolved, leadCheck.rows[0].assigned_to, 'edit'))) {
        throw new Error('FORBIDDEN_TIMELINE_WRITE');
      }

      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const matchedNoteCfg = cfg.note_types.find(
        (nt) => nt.value.toUpperCase() === String(note_type || '').trim().toUpperCase()
      );
      if (matchedNoteCfg?.internal_only && shouldHideInternalNotesForActor(ctx, cfg, actorFlags)) {
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
      if (shouldMaskPiiForActor(ctx, cfg, leadCheck.rows[0], actorFlags.canUnmaskPhone, actorFlags)) {
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
leadsRouter.get('/tickets/list', requirePermission('tickets_data', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const actorFlags = derivePiiActorFlagsFromRbac(resolved, ctx);
    const ticketsPerm = checkEffectivePermission(resolved, 'tickets_data', 'view');
    const rawLimit = Number(req.query.limit || 0);
    const rawOffset = Math.max(0, Math.floor(Number(req.query.offset || 0) || 0));

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cfg = await getTenantSettingsCached(ctx.tenantId, client);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(cfg.max_page_size, Math.max(1, Math.floor(rawLimit)))
          : cfg.max_page_size;

      let scopeRes = { clause: 'dr.tenant_id = $1', values: [ctx.tenantId] as unknown[], nextIndex: 2 };
      if (!resolved.userOrg?.is_tenant_owner && ticketsPerm.scope !== 'company') {
        const useDirectOwn =
          ticketsPerm.scope === 'department' &&
          !resolved.userOrg?.department_id &&
          (resolved.userOrg?.role || '').toLowerCase() === 'manager';
        if (useDirectOwn) {
          const deptCnt = await client.query<{ cnt: number }>(
            'SELECT COUNT(*) AS cnt FROM tenant_departments WHERE tenant_id = $1',
            [ctx.tenantId]
          );
          if (Number(deptCnt.rows[0]?.cnt || 0) > 0 && resolved.userOrg) {
            scopeRes = await buildGranularScopeWhereClause(client, ctx.tenantId, resolved.userOrg, ticketsPerm.scope, {
              tenantColumn: 'dr.tenant_id',
              ownerColumn: 'dr.reporter_id',
            });
          }
        } else if (resolved.userOrg) {
          scopeRes = await buildGranularScopeWhereClause(client, ctx.tenantId, resolved.userOrg, ticketsPerm.scope, {
            tenantColumn: 'dr.tenant_id',
            ownerColumn: 'dr.reporter_id',
          });
        }
      }

      const params: unknown[] = [...scopeRes.values, limit, rawOffset];
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
         WHERE ${scopeRes.clause}
         ORDER BY dr.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      );
      return r.rows.map((row) => {
        const maskRow = shouldMaskPiiForActor(
          ctx,
          cfg,
          { is_accepted: row.is_accepted },
          actorFlags.canUnmaskPhone,
          actorFlags
        );
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

leadsRouter.post('/:id/tickets', requirePermission('tickets_data', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const resolved = await getResolvedUserRbac(req);
    const leadId = req.params.id;
    const { reason = 'Sai số / Thuê bao', description = '' } = req.body || {};

    const ticket = await withTenantTransaction(ctx.tenantId, async (client) => {
      const leadCheck = await client.query<{ assigned_to: string | null }>(
        'SELECT assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, leadId]
      );
      if (!leadCheck.rows[0]) throw new Error('LEAD_NOT_FOUND');
      if (!(await canActorAccessLeadInTx(client, ctx.tenantId, resolved, leadCheck.rows[0].assigned_to, 'view'))) {
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
leadsRouter.post('/tickets/:ticketId/resolve', requirePermission('tickets_data', 'approve'), async (req, res) => {
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
