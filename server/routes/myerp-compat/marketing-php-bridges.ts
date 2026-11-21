import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { router as marketingRouter } from '../../modules/marketing/index.ts';
import { router as marketingPublicRouter } from '../../modules/marketing-public/index.ts';
import { audiencesRouter } from '../../modules/audiences/index.ts';
import { router as domAgentRouter } from '../../modules/dom-agent/index.ts';
import { router as approvalsRouter } from '../../modules/approvals/index.ts';
import {
  auditFlowWithDomAgent,
  executeFlowForLead,
  type FlowStepNodeDto,
} from '../../modules/marketing/flow-engine.service.ts';
import {
  deepMergeJsonObjects,
  evaluateAllDynamicAudiencesForTenant,
  evaluateDynamicAudience,
  importRowsIntoAudience,
  refreshAudienceCachedCount,
  splitAudienceIntoParts,
  upsertMasterContactInTx,
} from '../../modules/audiences/audiences.service.ts';
import { ensureMarketingSchema } from '../../modules/marketing/schema.ts';
import { dispatchZnsNotification } from '../../modules/marketing/dispatchers.ts';
import { sendMetaMessengerMessage } from '../../services/meta-messenger.service.ts';
import { refreshExpiringZaloTokens } from '../../services/zalo-mail.service.ts';
import { buildMetaAdsOverviewInTx } from '../../services/meta-ads.service.ts';
import { decryptTenantSecret, encryptTenantSecret } from '../../core/crypto/vault.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import {
  checkEffectivePermission,
  getResolvedUserRbac,
  sendApiError,
} from '../../core/security/rbac.ts';
import {
  sanitizeAvatarUrl,
  stripEphemeralAvatarsFromCustomFields,
} from '../../core/security/pii-masker.ts';
import {
  bstr,
  bridge,
  fail,
  getTenantContext,
  handler,
  isUuid,
  listPayload,
  ok,
  parseJson,
  qstr,
  readPaging,
  requireAnyPermission,
  requirePermission,
  resolvePiiActor,
  tx,
  type GranularAction,
} from './shared.ts';

function phpId(req: Request): string {
  const q = req.query?.id;
  const b = (req.body as Record<string, unknown> | undefined)?.id;
  return String(Array.isArray(q) ? q[0] : q ?? b ?? '').trim();
}

function reqRoute(req: Request): string {
  return String(req.query?.route ?? (req.body as Record<string, unknown> | undefined)?.route ?? '')
    .trim()
    .toLowerCase();
}

function reqAction(req: Request): string {
  return String(req.query?.action ?? (req.body as Record<string, unknown> | undefined)?.action ?? '')
    .trim()
    .toLowerCase();
}

function isSegmentPreviewReq(req: Request): boolean {
  if (String(req.method || '').toUpperCase() !== 'POST') return false;
  const action = reqAction(req);
  const route = reqRoute(req);
  return ['preview', 'estimate'].includes(action) || ['preview', 'estimate'].includes(route);
}

async function ensureCompatPermission(
  req: Request,
  res: Response,
  moduleKey: string,
  action: GranularAction
): Promise<boolean> {
  const resolved = await getResolvedUserRbac(req);
  const check = checkEffectivePermission(resolved, moduleKey, action);
  if (!check.entitled) {
    sendApiError(
      res,
      403,
      'MODULE_NOT_ENTITLED',
      `Phân hệ '${moduleKey}' chưa được mở khóa trong gói cước hiện tại.`
    );
    return false;
  }
  if (!check.allowed) {
    sendApiError(
      res,
      403,
      'FORBIDDEN_RBAC_PERMISSION',
      `Tài khoản không có quyền '${action}' trên phân hệ '${moduleKey}'.`
    );
    return false;
  }
  return true;
}

// ============================================================================
// 1. Public `.php` Compatibility Router (mounted BEFORE auth in myerpCompat & app.ts)
// ============================================================================
export const publicMarketingPhpCompatRouter = Router();

publicMarketingPhpCompatRouter.all(
  ['/automation/survey_public.php', '/survey_public.php', '/survey_public'],
  (req: Request, res: Response, next: NextFunction) => {
    const slug = String(req.query?.slug ?? (req.body as Record<string, unknown> | undefined)?.slug ?? phpId(req)).trim();
    if (!slug) {
      fail(res, 422, 'SURVEY_SLUG_REQUIRED', 'Thiếu tham số slug khảo sát.');
      return;
    }
    const action = reqAction(req);
    const method = String(req.method || 'GET').toUpperCase();
    const targetMethod = action === 'submit' || method === 'POST' ? 'POST' : 'GET';
    return bridge(marketingPublicRouter, `/surveys/${encodeURIComponent(slug)}`, { method: targetMethod })(
      req,
      res,
      next
    );
  }
);

publicMarketingPhpCompatRouter.all(
  ['/automation/voucher_claim.php', '/voucher_claim.php', '/voucher_claim'],
  (req: Request, res: Response, next: NextFunction) => {
    const key = String(
      req.query?.campaign_id ??
        req.query?.slug ??
        (req.body as Record<string, unknown> | undefined)?.campaign_id ??
        (req.body as Record<string, unknown> | undefined)?.slug ??
        phpId(req)
    ).trim();
    if (!key) {
      fail(res, 422, 'VOUCHER_CAMPAIGN_REQUIRED', 'Thiếu campaign_id hoặc slug chiến dịch Voucher.');
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    const targetPath = method === 'POST' ? `/vouchers/${encodeURIComponent(key)}/claim` : `/vouchers/${encodeURIComponent(key)}`;
    return bridge(marketingPublicRouter, targetPath)(req, res, next);
  }
);

publicMarketingPhpCompatRouter.all(
  ['/automation/track.php', '/track.php'],
  (req: Request, res: Response, next: NextFunction) => {
    const action = reqAction(req);
    const b = (req.body || {}) as Record<string, unknown>;
    if (action === 'chat' || b.message) {
      const slugOrSiteKey = String(req.query?.tenant_slug || req.query?.site_key || b.tenant_slug || b.site_key || 'default').trim();
      return bridge(marketingPublicRouter, `/social/inbound/${encodeURIComponent(slugOrSiteKey)}`, { method: 'POST' })(
        req,
        res,
        next
      );
    }
    return bridge(marketingPublicRouter, '/track', { method: 'POST' })(req, res, next);
  }
);

// ============================================================================
// 2. Authenticated Marketing `.php` & `?route=` / `?action=` Bridges + Real DB Handlers
// ============================================================================
export const marketingPhpBridgesRouter = Router();

// Ensure `mkt_*` tables exist whenever a compat `.php` handler runs directly against DB
marketingPhpBridgesRouter.use(async (_req, _res, next) => {
  try {
    await ensureMarketingSchema();
  } catch {
    // Non-fatal; per-module handlers also ensure schema
  }
  next();
});

// ---- A. Campaigns & Campaign Sub-Routes (`campaigns`, `campaigns.php`, `campaign_preview.php`, `campaign_audit.php`) ----
const handleCampaignCompat = handler('COMPAT_CAMPAIGNS', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const route = reqRoute(req);
  const id = String(
    phpId(req) || (req.body as Record<string, unknown> | undefined)?.campaign_id || req.query?.campaign_id || ''
  ).trim();

  if (method === 'POST') {
    if (route === 'pre_send_review') return void bridge(marketingRouter, '/campaigns/pre-send-review')(req, res, next);
    if (route === 'estimate_reach') return void bridge(marketingRouter, '/campaigns/estimate-reach')(req, res, next);
    if (route === 'send_test' || route === 'test_email') {
      const target = id && isUuid(id) ? `/campaigns/${encodeURIComponent(id)}/test-email` : '/campaigns/test-email';
      return void bridge(marketingRouter, target)(req, res, next);
    }
    if (route === 'delete_unsubscribed') {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'delete'))) return;
      if (id) {
        if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
        const deleted = await tx(async (client, ctx) => {
          const r = await client.query(
            "DELETE FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'unsubscribed'",
            [ctx.tenantId, id]
          );
          return Number(r.rowCount || 0);
        });
        return void ok(res, { deleted_count: deleted });
      }
    }
    if (route === 'send' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      return void bridge(marketingRouter, `/campaigns/${encodeURIComponent(id)}/send`)(req, res, next);
    }
    if (route === 'pause' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      return void bridge(marketingRouter, `/campaigns/${encodeURIComponent(id)}/pause`)(req, res, next);
    }
    if (route === 'resume' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      return void bridge(marketingRouter, `/campaigns/${encodeURIComponent(id)}/resume`)(req, res, next);
    }
    if (route === 'rename' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      const nextName = bstr(req.body, 'name', 'title');
      if (!nextName) return void fail(res, 422, 'CAMPAIGN_NAME_REQUIRED', 'Vui lòng nhập tên chiến dịch.');
      const updated = await tx(async (client, ctx) => {
        const r = await client.query(
          'UPDATE mkt_campaigns SET name = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 RETURNING *',
          [ctx.tenantId, id, nextName]
        );
        return r.rows[0] || null;
      });
      if (!updated) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      return void ok(res, updated);
    }
    if (route === 'clear_attachments' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      const found = await tx(async (client, ctx) => {
        const existing = await client.query<{ fallback_vars_json: unknown }>(
          'SELECT fallback_vars_json FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, id]
        );
        if (!existing.rows[0]) return false;
        const currentVars = parseJson<Record<string, unknown>>(existing.rows[0].fallback_vars_json, {});
        const nextVars: Record<string, unknown> = { ...currentVars };
        delete nextVars._attachments;
        await client.query(
          'UPDATE mkt_campaigns SET fallback_vars_json = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, id, JSON.stringify(nextVars)]
        );
        return true;
      });
      if (!found) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      return void ok(res, { cleared: true, id, attachments: [] });
    }
    if (route === 'trigger_refresh' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      const stats = await tx(async (client, ctx) => {
        const stRes = await client.query<{
          sent_cnt: number;
          open_cnt: number;
          click_cnt: number;
          bounce_cnt: number;
          unsub_cnt: number;
        }>(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('sent', 'delivered', 'opened', 'clicked') THEN 1 ELSE 0 END), 0)::int AS sent_cnt,
                  COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS open_cnt,
                  COALESCE(SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS click_cnt,
                  COALESCE(SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END), 0)::int AS bounce_cnt,
                  COALESCE(SUM(CASE WHEN status = 'unsubscribed' THEN 1 ELSE 0 END), 0)::int AS unsub_cnt
           FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2`,
          [ctx.tenantId, id]
        );
        const st = stRes.rows[0];
        await client.query(
          `UPDATE mkt_campaigns
           SET sent_count = $3, opened_count = $4, clicked_count = $5, bounced_count = $6, unsubscribed_count = $7,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            id,
            Number(st?.sent_cnt || 0),
            Number(st?.open_cnt || 0),
            Number(st?.click_cnt || 0),
            Number(st?.bounce_cnt || 0),
            Number(st?.unsub_cnt || 0),
          ]
        );
        return st;
      });
      return void ok(res, { refreshed: true, id, stats });
    }
    if (route === 'bulk_update_subscribers') {
      if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
      const rawIds = Array.isArray(req.body?.subscriber_ids)
        ? req.body.subscriber_ids
        : Array.isArray(req.body?.lead_ids)
          ? req.body.lead_ids
          : Array.isArray(req.body?.ids)
            ? req.body.ids
            : [];
      const leadIds = rawIds.map(String).filter((x: string) => isUuid(x));
      const nextConsent = bstr(req.body, 'email_consent', 'status') || 'subscribed';
      if (leadIds.length === 0) return void ok(res, { affected: 0 });
      const affected = await tx(async (client, ctx) => {
        const ph = leadIds.map((_: string, i: number) => `$${i + 3}`).join(', ');
        const r = await client.query(
          `UPDATE leads SET email_consent = $2, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id IN (${ph})`,
          [ctx.tenantId, nextConsent, ...leadIds]
        );
        return Number(r.rowCount || 0);
      });
      return void ok(res, { affected, status: nextConsent });
    }
    if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'create'))) return;
    return void bridge(marketingRouter, '/campaigns')(req, res, next);
  }

  if (method === 'GET') {
    if (route === 'audience_stats' && id) {
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      const data = await tx(async (client, ctx) => {
        const r = await client.query<{ status: string; cnt: number }>(
          `SELECT status, COUNT(*)::int AS cnt FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2 GROUP BY status`,
          [ctx.tenantId, id]
        );
        const byStatus: Record<string, number> = {};
        let total = 0;
        for (const row of r.rows) {
          byStatus[String(row.status)] = Number(row.cnt || 0);
          total += Number(row.cnt || 0);
        }
        return { campaign_id: id, total, by_status: byStatus };
      });
      return void ok(res, data);
    }
    if (route === 'unsubscribed_list' && id) {
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      const { page, limit, offset } = readPaging(req, 20, 200);
      const data = await tx(async (client, ctx) => {
        const actor = await resolvePiiActor(client, ctx);
        const [cntRes, listRes] = await Promise.all([
          client.query<{ cnt: number }>(
            `SELECT COUNT(*)::int AS cnt FROM mkt_send_claims
             WHERE tenant_id = $1 AND campaign_id = $2 AND status = 'unsubscribed'`,
            [ctx.tenantId, id]
          ),
          client.query(
            `SELECT sc.id, sc.lead_id, sc.channel, sc.claimed_at AS unsubscribed_at,
                    l.name, l.email, l.phone
             FROM mkt_send_claims sc
             INNER JOIN leads l ON l.tenant_id = sc.tenant_id AND l.id = sc.lead_id
             WHERE sc.tenant_id = $1 AND sc.campaign_id = $2 AND sc.status = 'unsubscribed'
             ORDER BY sc.claimed_at DESC
             LIMIT $3 OFFSET $4`,
            [ctx.tenantId, id, limit, offset]
          ),
        ]);
        const items = listRes.rows.map((r) => actor.mask(r));
        return listPayload(items, Number(cntRes.rows[0]?.cnt || 0), page, limit);
      });
      return void ok(res, data);
    }
    if (id) {
      if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
      return void bridge(marketingRouter, `/campaigns/${encodeURIComponent(id)}/detail`)(req, res, next);
    }
    return void bridge(marketingRouter, '/campaigns')(req, res, next);
  }

  if (method === 'DELETE') {
    if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'delete'))) return;
  } else if (method === 'PUT' || method === 'PATCH') {
    if (!(await ensureCompatPermission(req, res, 'mkt_campaigns', 'edit'))) return;
  }
  if (id && !isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch.');
  return void bridge(marketingRouter, id ? `/campaigns/${encodeURIComponent(id)}` : '/campaigns')(req, res, next);
});

marketingPhpBridgesRouter.all(
  ['/campaigns', '/automation/campaigns', '/automation/campaigns.php', '/campaigns.php'],
  requirePermission('mkt_campaigns', 'view'),
  handleCampaignCompat
);

marketingPhpBridgesRouter.all(
  ['/campaign_preview', '/automation/campaign_preview', '/automation/campaign_preview.php'],
  requirePermission('mkt_campaigns', 'view'),
  handler('COMPAT_CAMPAIGN_PREVIEW', async (req, res, next) => {
    const id = phpId(req) || qstr(req, 'campaign_id');
    if (id && isUuid(id)) {
      return void bridge(marketingRouter, `/campaigns/${encodeURIComponent(id)}/detail`)(req, res, next);
    }
    return void bridge(marketingRouter, '/campaigns/pre-send-review', { method: 'POST' })(req, res, next);
  })
);

marketingPhpBridgesRouter.all(
  ['/campaign_audit', '/automation/campaign_audit', '/automation/campaign_audit.php'],
  requirePermission('mkt_campaigns', 'view'),
  handler('COMPAT_CAMPAIGN_AUDIT', async (req, res, next) => {
    const id = qstr(req, 'campaign_id') || phpId(req);
    const target = id && isUuid(id) ? `/campaigns/${encodeURIComponent(id)}/pre-send-review` : '/campaigns/pre-send-review';
    return void bridge(marketingRouter, target, { method: 'POST' })(req, res, next);
  })
);

export function flattenFlowCompatDetail(payload: any): any {
  const d = payload?.data;
  if (!d || typeof d !== 'object') return payload;
  const flowObj = d.flow && typeof d.flow === 'object' ? d.flow : d;
  const rawSteps = flowObj.steps !== undefined ? flowObj.steps : flowObj.steps_json;
  const steps = Array.isArray(rawSteps) ? rawSteps : parseJson(rawSteps, []);
  const rawTrigCfg = flowObj.trigger_config;
  const trigger_config =
    rawTrigCfg && typeof rawTrigCfg === 'object' && !Array.isArray(rawTrigCfg)
      ? rawTrigCfg
      : parseJson(rawTrigCfg, {});
  const normalizedFlow = {
    ...flowObj,
    steps,
    steps_json: steps,
    trigger_config,
  };
  return {
    ...payload,
    data: {
      ...normalizedFlow,
      flow: normalizedFlow,
      ...(d.snapshots !== undefined ? { snapshots: d.snapshots } : {}),
      ...(d.enrollments !== undefined ? { enrollments: d.enrollments } : {}),
    },
  };
}

// ---- B. Flows (`flows`, `flows.php` all 16 sub-routes) & `flow_ai_review.php` ----
const handleFlowsCompat = handler('COMPAT_FLOWS', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const route = reqRoute(req);
  const id = String(phpId(req) || qstr(req, 'flow_id') || (req.body as Record<string, unknown> | undefined)?.flow_id || '').trim();

  if (route === 'empty-trash') {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'delete'))) return;
    const deleted = await tx(async (client, ctx) => {
      const r = await client.query(
        "DELETE FROM mkt_flows WHERE tenant_id = $1 AND status = 'archived'",
        [ctx.tenantId]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { deleted_count: deleted });
  }

  if (route === 'bulk-delete') {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'delete'))) return;
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((x: string) => isUuid(x));
    if (ids.length === 0) return void ok(res, { deleted_count: 0 });
    const deleted = await tx(async (client, ctx) => {
      const ph = ids.map((_: string, i: number) => `$${i + 2}`).join(', ');
      const r = await client.query(`DELETE FROM mkt_flows WHERE tenant_id = $1 AND id IN (${ph})`, [ctx.tenantId, ...ids]);
      return Number(r.rowCount || 0);
    });
    return void ok(res, { deleted_count: deleted });
  }

  if (route === 'flow-snapshot-data') {
    const snapshotId = qstr(req, 'snapshot_id') || String((req.body as Record<string, unknown> | undefined)?.snapshot_id || '').trim();
    if (!isUuid(snapshotId)) return void fail(res, 404, 'SNAPSHOT_NOT_FOUND', 'Không tìm thấy phiên bản snapshot.');
    const snap = await tx(async (client, ctx) => {
      const r = await client.query('SELECT * FROM mkt_flow_snapshots WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        snapshotId,
      ]);
      const row = r.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        flow_id: row.flow_id,
        version: row.version,
        label: `v${row.version}`,
        flow_data: {
          trigger_type: row.trigger_type,
          trigger_config: parseJson(row.trigger_config, {}),
          steps: parseJson(row.steps_json, []),
        },
        created_at: row.created_at,
      };
    });
    if (!snap) return void fail(res, 404, 'SNAPSHOT_NOT_FOUND', 'Không tìm thấy phiên bản snapshot.');
    return void ok(res, snap);
  }

  if (route === 'flow-snapshots' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    if (method === 'POST') {
      if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'edit'))) return;
      const flowData = (req.body?.flow_data && typeof req.body.flow_data === 'object' ? req.body.flow_data : req.body || {}) as Record<string, unknown>;
      const created = await tx(async (client, ctx) => {
        const fRes = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          id,
        ]);
        const f = fRes.rows[0];
        if (!f) return null;
        const steps = Array.isArray(flowData.steps) ? flowData.steps : parseJson(f.steps_json, []);
        const trigCfg =
          flowData.trigger_config && typeof flowData.trigger_config === 'object'
            ? flowData.trigger_config
            : parseJson(f.trigger_config, {});
        const trigType = String(flowData.trigger_type || f.trigger_type || 'form_submitted');
        const nextVer = Number(f.version || 0) + 1;
        const audit = auditFlowWithDomAgent(trigType, steps as FlowStepNodeDto[]);
        const snapId = crypto.randomUUID();
        await client.query(
          `INSERT INTO mkt_flow_snapshots (
             id, tenant_id, flow_id, version, trigger_type, trigger_config, steps_json, review_score, published_by
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
          [snapId, ctx.tenantId, id, nextVer, trigType, JSON.stringify(trigCfg), JSON.stringify(steps), audit.score, ctx.userId]
        );
        await client.query('UPDATE mkt_flows SET version = $3 WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id, nextVer]);
        return { id: snapId, flow_id: id, version: nextVer, label: String(req.body?.label || `v${nextVer}`), review_score: audit.score };
      });
      if (!created) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
      return void ok(res, created, '', 201);
    }
    const snaps = await tx(async (client, ctx) => {
      const r = await client.query(
        'SELECT * FROM mkt_flow_snapshots WHERE tenant_id = $1 AND flow_id = $2 ORDER BY version DESC, created_at DESC LIMIT 50',
        [ctx.tenantId, id]
      );
      return r.rows.map((row) => ({
        ...row,
        label: `v${row.version}`,
        trigger_config: parseJson(row.trigger_config, {}),
        steps: parseJson(row.steps_json, []),
      }));
    });
    return void ok(res, snaps);
  }

  if (route === 'distribution' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const dist = await tx(async (client, ctx) => {
      const r = await client.query<{ current_step_id: string | null; cnt: number }>(
        `SELECT current_step_id, COUNT(*)::int AS cnt
         FROM mkt_flow_enrollments
         WHERE tenant_id = $1 AND flow_id = $2 AND status IN ('active', 'waiting', 'resumed')
         GROUP BY current_step_id`,
        [ctx.tenantId, id]
      );
      const map: Record<string, number> = {};
      for (const row of r.rows) {
        if (row.current_step_id) map[String(row.current_step_id)] = Number(row.cnt || 0);
      }
      return map;
    });
    return void ok(res, dist);
  }

  if (route === 'completed-users' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const data = await tx(async (client, ctx) => {
      const r = await client.query<{ current_step_id: string | null; execution_trace: unknown }>(
        `SELECT current_step_id, execution_trace FROM mkt_flow_enrollments
         WHERE tenant_id = $1 AND flow_id = $2 AND status = 'completed'`,
        [ctx.tenantId, id]
      );
      const byBranch: Record<string, number> = {};
      for (const row of r.rows) {
        const trace = parseJson<Array<Record<string, unknown>>>(row.execution_trace, []);
        const lastStep = trace.length > 0 ? String(trace[trace.length - 1]?.step_id || 'root') : String(row.current_step_id || 'root');
        byBranch[lastStep] = (byBranch[lastStep] || 0) + 1;
      }
      return { total: r.rows.length, byBranch };
    });
    return void ok(res, data);
  }

  if (route === 'active-count' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const count = await tx(async (client, ctx) => {
      const r = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM mkt_flow_enrollments
         WHERE tenant_id = $1 AND flow_id = $2 AND status IN ('active', 'waiting', 'resumed')`,
        [ctx.tenantId, id]
      );
      return Number(r.rows[0]?.cnt || 0);
    });
    return void ok(res, { count });
  }

  if (route === 'participants' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const { page, limit, offset } = readPaging(req, 20, 200);
    const stepIds = qstr(req, 'step_id')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const statusFilter = qstr(req, 'status');
    const search = qstr(req, 'search').toLowerCase();
    const data = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const params: unknown[] = [ctx.tenantId, id];
      let where = 'e.tenant_id = $1 AND e.flow_id = $2';
      if (stepIds.length > 0) {
        const ph = stepIds.map((s) => {
          params.push(s);
          return `$${params.length}`;
        });
        where += ` AND e.current_step_id IN (${ph.join(', ')})`;
      }
      if (statusFilter) {
        params.push(statusFilter);
        where += ` AND e.status = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (LOWER(COALESCE(l.name, '')) LIKE $${params.length} OR LOWER(COALESCE(l.email, '')) LIKE $${params.length} OR COALESCE(l.phone, '') LIKE $${params.length})`;
      }
      const [cntRes, rowsRes] = await Promise.all([
        client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM mkt_flow_enrollments e
           INNER JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
           WHERE ${where}`,
          params
        ),
        client.query(
          `SELECT e.id AS enrollment_id, e.flow_id, e.lead_id, e.current_step_id, e.status, e.next_run_at,
                  e.enrolled_at AS enrolled_at, e.completed_at,
                  l.name, l.email, l.phone, l.lead_score
           FROM mkt_flow_enrollments e
           INNER JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
           WHERE ${where}
           ORDER BY e.enrolled_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);
      const total = Number(cntRes.rows[0]?.cnt || 0);
      const rows = rowsRes.rows.map((r) => actor.mask(r));
      return {
        data: rows,
        items: rows,
        pagination: { page, limit, total, totalPages: limit > 0 ? Math.ceil(total / limit) : 1 },
      };
    });
    return void ok(res, data);
  }

  if (route === 'step-errors' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const { page, limit, offset } = readPaging(req, 20, 200);
    const data = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const r = await client.query(
        `SELECT e.id AS enrollment_id, e.lead_id, e.current_step_id, e.status, e.execution_trace, e.enrolled_at,
                l.name, l.email, l.phone
         FROM mkt_flow_enrollments e
         INNER JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
         WHERE e.tenant_id = $1 AND e.flow_id = $2 AND e.status = 'failed'
         ORDER BY e.enrolled_at DESC
         LIMIT $3 OFFSET $4`,
        [ctx.tenantId, id, limit, offset]
      );
      const rows = r.rows.map((row) => actor.mask(row));
      return { data: rows, items: rows, pagination: { page, limit, total: rows.length, totalPages: 1 } };
    });
    return void ok(res, data);
  }

  if (route === 'step-unsubscribes' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const { page, limit, offset } = readPaging(req, 20, 200);
    const data = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const r = await client.query(
        `SELECT e.id AS enrollment_id, e.lead_id, e.current_step_id, e.enrolled_at,
                l.name, l.email, l.phone, l.email_consent
         FROM mkt_flow_enrollments e
         INNER JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
         WHERE e.tenant_id = $1 AND e.flow_id = $2 AND l.email_consent = 'unsubscribed'
         ORDER BY e.enrolled_at DESC
         LIMIT $3 OFFSET $4`,
        [ctx.tenantId, id, limit, offset]
      );
      const rows = r.rows.map((row) => actor.mask(row));
      return { data: rows, items: rows, pagination: { page, limit, total: rows.length, totalPages: 1 } };
    });
    return void ok(res, data);
  }

  if (route === 'duplicate' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'create'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const cloned = await tx(async (client, ctx) => {
      const r = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [ctx.tenantId, id]);
      const src = r.rows[0];
      if (!src) return null;
      const newId = crypto.randomUUID();
      const newName = String(req.body?.name || `${src.name} (Bản sao)`).trim();
      await client.query(
        `INSERT INTO mkt_flows (
           id, tenant_id, name, description, status, trigger_type, trigger_config, steps_json, settings_json, version, created_by
         ) VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb, $7::jsonb, $8::jsonb, 1, $9)`,
        [
          newId,
          ctx.tenantId,
          newName,
          src.description || null,
          src.trigger_type,
          JSON.stringify(parseJson(src.trigger_config, {})),
          JSON.stringify(parseJson(src.steps_json, [])),
          JSON.stringify(parseJson(src.settings_json, {})),
          ctx.userId,
        ]
      );
      const fresh = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, newId]);
      return fresh.rows[0];
    });
    if (!cloned) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    return void ok(res, cloned, '', 201);
  }

  if (route === 'sync' && id) {
    if (method !== 'GET' && !(await ensureCompatPermission(req, res, 'mkt_flows', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const synced = await tx(async (client, ctx) => {
      const fRes = await client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      const f = fRes.rows[0];
      if (!f) return null;
      const cntRes = await client.query<{ enrolled: number; completed: number }>(
        `SELECT COUNT(*)::int AS enrolled,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed
         FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2`,
        [ctx.tenantId, id]
      );
      const enrolled = Number(cntRes.rows[0]?.enrolled || 0);
      const completed = Number(cntRes.rows[0]?.completed || 0);
      if (method !== 'GET') {
        await client.query(
          'UPDATE mkt_flows SET enrolled_count = $3, completed_count = $4, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, id, enrolled, completed]
        );
      }
      const steps = parseJson<FlowStepNodeDto[]>(f.steps_json, []);
      const trigger_config = parseJson<Record<string, unknown>>(f.trigger_config, {});
      const flowPayload = {
        ...f,
        id: String(f.id),
        flow_id: String(f.id),
        name: String(f.name || ''),
        steps,
        steps_json: steps,
        trigger_config,
        enrolled_count: enrolled,
        completed_count: completed,
      };
      return {
        ...flowPayload,
        flow: flowPayload,
      };
    });
    if (!synced) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    return void ok(res, synced);
  }

  if (route === 'migrate-users' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const action = String(req.body?.action || '').trim().toLowerCase();
    const targetStepId = req.body?.targetStepId ? String(req.body.targetStepId) : null;
    const affected = await tx(async (client, ctx) => {
      if (action === 'cancel') {
        const r = await client.query(
          `UPDATE mkt_flow_enrollments
           SET status = 'cancelled', next_run_at = NULL
           WHERE tenant_id = $1 AND flow_id = $2 AND status IN ('active', 'waiting', 'resumed')`,
          [ctx.tenantId, id]
        );
        return Number(r.rowCount || 0);
      }
      const r = await client.query(
        `UPDATE mkt_flow_enrollments
         SET current_step_id = COALESCE($3, current_step_id), status = 'waiting', next_run_at = clock_timestamp()
         WHERE tenant_id = $1 AND flow_id = $2 AND status IN ('active', 'waiting', 'resumed')`,
        [ctx.tenantId, id, targetStepId]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { migrated: affected, action: action || 'migrate' });
  }

  if (route === 'stats' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const stats = await tx(async (client, ctx) => {
      const [fRes, eRes] = await Promise.all([
        client.query('SELECT enrolled_count, completed_count, pushed_to_sale_count FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [ctx.tenantId, id]),
        client.query<{ active_cnt: number; failed_cnt: number }>(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('active', 'waiting', 'resumed') THEN 1 ELSE 0 END), 0)::int AS active_cnt,
                  COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_cnt
           FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2`,
          [ctx.tenantId, id]
        ),
      ]);
      const f = fRes.rows[0] || {};
      const e = eRes.rows[0] || { active_cnt: 0, failed_cnt: 0 };
      return {
        enrolled: Number(f.enrolled_count || 0),
        completed: Number(f.completed_count || 0),
        pushed_to_sale: Number(f.pushed_to_sale_count || 0),
        active: Number(e.active_cnt || 0),
        failed: Number(e.failed_cnt || 0),
      };
    });
    return void ok(res, stats);
  }

  if (route === 'resolve-step-error') {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'edit'))) return;
    const enrollmentId = String(req.body?.enrollment_id || phpId(req) || '').trim();
    if (!isUuid(enrollmentId)) return void ok(res, { resolved: false });
    const count = await tx(async (client, ctx) => {
      const r = await client.query(
        `UPDATE mkt_flow_enrollments SET status = 'completed', completed_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'failed'`,
        [ctx.tenantId, enrollmentId]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { resolved: count > 0, count });
  }

  if (route === 'clean-failed' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'delete'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const cleaned = await tx(async (client, ctx) => {
      const r = await client.query(
        "DELETE FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2 AND status = 'failed'",
        [ctx.tenantId, id]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { deleted_count: cleaned });
  }

  if (route === 'inactive-users' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const items = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const r = await client.query(
        `SELECT e.id AS enrollment_id, e.lead_id, e.status, e.enrolled_at, l.name, l.email, l.phone
         FROM mkt_flow_enrollments e
         INNER JOIN leads l ON l.tenant_id = e.tenant_id AND l.id = e.lead_id
         WHERE e.tenant_id = $1 AND e.flow_id = $2 AND e.status IN ('cancelled', 'failed')
         ORDER BY e.enrolled_at DESC LIMIT 100`,
        [ctx.tenantId, id]
      );
      return r.rows.map((row) => actor.mask(row));
    });
    return void ok(res, { data: items, items });
  }

  if (route === 'estimate-manual-add' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const audienceId = String(req.body?.audience_id || '').trim();
    const count = await tx(async (client, ctx) => {
      if (isUuid(audienceId)) {
        const r = await client.query<{ cnt: number }>(
          'SELECT COUNT(DISTINCT lead_id)::int AS cnt FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2',
          [ctx.tenantId, audienceId]
        );
        return Number(r.rows[0]?.cnt || 0);
      }
      return Array.isArray(req.body?.lead_ids) ? req.body.lead_ids.length : 0;
    });
    return void ok(res, { count });
  }

  if (route === 'manual-add-participant' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const rawIds: string[] = Array.isArray(req.body?.lead_ids)
      ? req.body.lead_ids.map(String)
      : req.body?.lead_id
        ? [String(req.body.lead_id)]
        : [];
    const ctx = getTenantContext();
    let enrolledCount = 0;
    for (const lid of rawIds.filter((x) => isUuid(x)).slice(0, 50)) {
      await executeFlowForLead(ctx.tenantId, id, lid, { actorId: ctx.userId }).catch(() => {});
      enrolledCount++;
    }
    return void ok(res, { enrolled_count: enrolledCount });
  }

  if (route === 'bulk-next-step' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const enrollmentIds: string[] = (Array.isArray(req.body?.enrollment_ids) ? req.body.enrollment_ids : [])
      .map(String)
      .filter((x: string) => isUuid(x));
    const targetStepId = String(req.body?.target_step_id || '').trim() || null;
    if (enrollmentIds.length === 0) return void ok(res, { updated: 0 });
    const updated = await tx(async (client, ctx) => {
      const ph = enrollmentIds.map((_, i) => `$${i + 4}`).join(', ');
      const r = await client.query(
        `UPDATE mkt_flow_enrollments
         SET current_step_id = COALESCE($3, current_step_id), status = 'waiting', next_run_at = clock_timestamp()
         WHERE tenant_id = $1 AND flow_id = $2 AND id IN (${ph})`,
        [ctx.tenantId, id, targetStepId, ...enrollmentIds]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { updated });
  }

  if (route === 'bulk-remove' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'delete'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const enrollmentIds: string[] = (Array.isArray(req.body?.enrollment_ids) ? req.body.enrollment_ids : [])
      .map(String)
      .filter((x: string) => isUuid(x));
    if (enrollmentIds.length === 0) return void ok(res, { removed: 0 });
    const removed = await tx(async (client, ctx) => {
      const ph = enrollmentIds.map((_, i) => `$${i + 3}`).join(', ');
      const r = await client.query(
        `DELETE FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2 AND id IN (${ph})`,
        [ctx.tenantId, id, ...enrollmentIds]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { removed });
  }

  if (route === 'test-step-action' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    return void bridge(marketingRouter, `/flows/${encodeURIComponent(id)}/simulate`, { method: 'POST' })(req, res, next);
  }

  if (route === 'history' || route === 'export-history') {
    if (id && !isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const items = await tx(async (client, ctx) => {
      const r = await client.query(
        `SELECT id, flow_id, lead_id, current_step_id, status, enrolled_at, completed_at
         FROM mkt_flow_enrollments
         WHERE tenant_id = $1 ${id ? 'AND flow_id = $2' : ''}
         ORDER BY enrolled_at DESC LIMIT 100`,
        id ? [ctx.tenantId, id] : [ctx.tenantId]
      );
      return r.rows;
    });
    return void ok(res, { items, data: items });
  }

  if (route === 'export-analytics' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    const rows = await tx(async (client, ctx) => {
      const r = await client.query(
        'SELECT status, COUNT(*)::int AS count FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2 GROUP BY status',
        [ctx.tenantId, id]
      );
      return r.rows;
    });
    return void ok(res, { flow_id: id, summary: rows });
  }

  if (method === 'DELETE') {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'delete'))) return;
  } else if (method === 'PUT' || method === 'PATCH') {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', 'edit'))) return;
  } else if (method === 'POST') {
    if (!(await ensureCompatPermission(req, res, 'mkt_flows', id ? 'edit' : 'create'))) return;
  }
  if (id) {
    if (!isUuid(id)) return void fail(res, 404, 'FLOW_NOT_FOUND', 'Không tìm thấy Automation Flow.');
    if (method === 'GET') {
      return void bridge(marketingRouter, `/flows/${encodeURIComponent(id)}`, {
        transform: flattenFlowCompatDetail,
      })(req, res, next);
    }
    return void bridge(marketingRouter, `/flows/${encodeURIComponent(id)}`)(req, res, next);
  }
  return void bridge(marketingRouter, '/flows')(req, res, next);
});

marketingPhpBridgesRouter.all(
  ['/flows', '/automation/flows', '/automation/flows.php', '/flows.php'],
  requirePermission('mkt_flows', 'view'),
  handleFlowsCompat
);

marketingPhpBridgesRouter.post(
  ['/automation/flow_ai_review.php', '/flow_ai_review.php', '/flow_ai_review'],
  requirePermission('mkt_flows', 'view'),
  handler('COMPAT_FLOW_AI_REVIEW', async (req, res) => {
    const flowObj = (req.body?.flow && typeof req.body.flow === 'object' ? req.body.flow : req.body || {}) as Record<string, unknown>;
    const triggerType = String(flowObj.trigger_type || flowObj.trigger || 'form_submitted');
    const steps = Array.isArray(flowObj.steps) ? (flowObj.steps as FlowStepNodeDto[]) : [];
    const audit = auditFlowWithDomAgent(triggerType, steps);
    const lines = [
      `### Đánh giá Automation Flow bởi DOM Agent (${audit.score}/100 — ${audit.grade})`,
      '',
      ...audit.findings.map((f) => `- **[${f.severity.toUpperCase()}]** ${f.message}`),
    ];
    ok(res, {
      review: lines.join('\n'),
      score: audit.score,
      grade: audit.grade,
      findings: audit.findings,
    });
  })
);

// ---- C. Lists, Segments, Subscribers, Audience Split & Bulk Ops ----
const handleListsCompat = handler('COMPAT_LISTS', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const route = reqRoute(req);
  const id = phpId(req);

  if (route === 'create_with_filter') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'create'))) return;
    const mappedBody = {
      ...(req.body || {}),
      name: bstr(req.body, 'name') || 'Danh sách mới từ Bộ lọc',
      audience_type: 'static_data',
      crm_filter: req.body?.criteria ?? req.body?.filter_branches ?? [],
    };
    return void bridge(audiencesRouter, '/', {
      method: 'POST',
      mapBody: () => mappedBody,
      transform: (payload: any) => {
        const d = payload?.data || payload;
        return {
          ...payload,
          data: {
            ...d,
            populated_count: Number(d?.cached_member_count || d?.populated_count || 0),
          },
        };
      },
    })(req, res, next);
  }

  if (route === 'cleanup') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'delete'))) return;
    const targetId = String(req.body?.targetId || id || '').trim();
    const mode = String(req.body?.mode || 'estimate').toLowerCase();
    const statuses: string[] = Array.isArray(req.body?.statuses) ? req.body.statuses.map(String) : ['unsubscribed', 'bounced', 'complained'];
    const days = Number(req.body?.days || 0);
    if (!isUuid(targetId)) return void ok(res, { count: 0, affected: 0 });
    const data = await tx(async (client, ctx) => {
      const conds: string[] = [];
      const params: unknown[] = [ctx.tenantId, targetId];
      if (statuses.length > 0) {
        const ph = statuses.map((s) => {
          params.push(s);
          return `$${params.length}`;
        });
        conds.push(`l.email_consent IN (${ph.join(', ')})`);
      }
      if (Number.isFinite(days) && days > 0) {
        const safeDays = Math.min(3650, Math.max(1, Math.floor(days)));
        conds.push(`COALESCE(l.last_engaged_at, l.updated_at, l.created_at) <= clock_timestamp() - INTERVAL '${safeDays} days'`);
      }
      const matchSql = conds.length > 0 ? `(${conds.join(' OR ')})` : '1 = 0';
      const leadIdsRes = await client.query<{ lead_id: string }>(
        `SELECT tam.lead_id
         FROM tenant_audience_members tam
         INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
         WHERE tam.tenant_id = $1 AND tam.audience_id = $2 AND ${matchSql}`,
        params
      );
      const matchedIds = leadIdsRes.rows.map((r) => r.lead_id);
      if (mode !== 'execute' || matchedIds.length === 0) {
        return { count: matchedIds.length, affected: 0 };
      }
      const delPh = matchedIds.map((_, i) => `$${i + 3}`).join(', ');
      const delRes = await client.query(
        `DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id IN (${delPh})`,
        [ctx.tenantId, targetId, ...matchedIds]
      );
      await refreshAudienceCachedCount(client, ctx.tenantId, targetId);
      return { count: matchedIds.length, affected: Number(delRes.rowCount || 0) };
    });
    return void ok(res, data);
  }

  if (route === 'merge') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'edit'))) return;
    const targetId = String(req.body?.target_id || req.body?.destination_id || '').trim();
    const sourceIds: string[] = (Array.isArray(req.body?.source_ids) ? req.body.source_ids : [])
      .map(String)
      .filter((x: string) => isUuid(x));
    if (!isUuid(targetId) || sourceIds.length === 0) {
      return void fail(res, 422, 'INVALID_MERGE_PAYLOAD', 'Thiếu danh sách đích hoặc danh sách nguồn.');
    }
    const merged = await tx(async (client, ctx) => {
      let moved = 0;
      for (const srcId of sourceIds) {
        const mRes = await client.query<{ lead_id: string }>(
          'SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2',
          [ctx.tenantId, srcId]
        );
        for (const m of mRes.rows) {
          const ins = await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'merge', '{}'::jsonb)
             ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, targetId, m.lead_id]
          );
          moved += Number(ins.rowCount || 0);
        }
      }
      const total = await refreshAudienceCachedCount(client, ctx.tenantId, targetId);
      return { merged_count: moved, total_members: total };
    });
    return void ok(res, merged);
  }

  if (route === 'stats' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy danh sách.');
    const stats = await tx(async (client, ctx) => {
      const r = await client.query<{ email_consent: string; cnt: number }>(
        `SELECT COALESCE(l.email_consent, 'subscribed') AS email_consent, COUNT(*)::int AS cnt
         FROM tenant_audience_members tam
         INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
         WHERE tam.tenant_id = $1 AND tam.audience_id = $2 AND l.is_deleted = false
         GROUP BY COALESCE(l.email_consent, 'subscribed')`,
        [ctx.tenantId, id]
      );
      const breakdown: Record<string, number> = {};
      let total = 0;
      for (const row of r.rows) {
        breakdown[String(row.email_consent)] = Number(row.cnt || 0);
        total += Number(row.cnt || 0);
      }
      return { id, total, by_consent: breakdown };
    });
    return void ok(res, stats);
  }

  if (method === 'DELETE') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'delete'))) return;
  } else if (method === 'PUT' || method === 'PATCH') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'edit'))) return;
  } else if (method === 'POST') {
    if (!(await ensureCompatPermission(req, res, 'audiences', id ? 'edit' : 'create'))) return;
  }
  if (id && !isUuid(id)) return void fail(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy danh sách.');

  return void bridge(audiencesRouter, id ? `/${encodeURIComponent(id)}` : '/', {
    method: method === 'PUT' && id ? 'PATCH' : undefined,
  })(req, res, next);
});

marketingPhpBridgesRouter.all(
  ['/lists', '/automation/lists', '/automation/lists.php', '/lists.php'],
  requirePermission('audiences', 'view'),
  handleListsCompat
);

const handleSegmentsCompat = handler('COMPAT_SEGMENTS', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const route = reqRoute(req);
  const id = phpId(req);

  if (isSegmentPreviewReq(req)) {
    return void bridge(audiencesRouter, '/preview')(req, res, next);
  }
  if (route === 'sync') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'edit'))) return;
    const ctx = getTenantContext();
    await evaluateAllDynamicAudiencesForTenant(ctx.tenantId);
    return void ok(res, { synced: true });
  }
  if (route === 'exclude' || route === 'cleanup') {
    if (!(await ensureCompatPermission(req, res, 'audiences', route === 'cleanup' ? 'delete' : 'edit'))) return;
    const segmentId = String(req.body?.segment_id || id || '').trim();
    const subIds: string[] = (
      Array.isArray(req.body?.subscriber_ids) ? req.body.subscriber_ids : req.body?.lead_ids || []
    )
      .map(String)
      .filter((x: string) => isUuid(x));
    if (!isUuid(segmentId)) return void ok(res, { excluded_count: 0 });
    const excludedCount = await tx(async (client, ctx) => {
      let targetIds = subIds;
      if (route === 'cleanup' && targetIds.length === 0) {
        const r = await client.query<{ lead_id: string }>(
          `SELECT tam.lead_id FROM tenant_audience_members tam
           INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
           WHERE tam.tenant_id = $1 AND tam.audience_id = $2
             AND l.email_consent IN ('unsubscribed', 'bounced', 'complained')`,
          [ctx.tenantId, segmentId]
        );
        targetIds = r.rows.map((row) => row.lead_id);
      }
      let cnt = 0;
      for (const lid of targetIds) {
        await client.query(
          `INSERT INTO tenant_audience_exclusions (id, tenant_id, audience_id, lead_id, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [crypto.randomUUID(), ctx.tenantId, segmentId, lid, route === 'cleanup' ? 'segment_cleanup' : 'manual_exclude']
        );
        cnt++;
      }
      return cnt;
    });
    const ctx = getTenantContext();
    await evaluateDynamicAudience(ctx.tenantId, segmentId);
    return void ok(res, { excluded_count: excludedCount });
  }
  if (route === 'stats' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy phân khúc.');
    return void bridge(marketingPhpBridgesRouter, `/lists?id=${encodeURIComponent(id)}&route=stats`, { method: 'GET' })(
      req,
      res,
      next
    );
  }
  if (method === 'DELETE') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'delete'))) return;
  } else if (method === 'PUT' || method === 'PATCH') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'edit'))) return;
  } else if (method === 'POST') {
    if (!(await ensureCompatPermission(req, res, 'audiences', id ? 'edit' : 'create'))) return;
  }
  if (id && !isUuid(id)) return void fail(res, 404, 'AUDIENCE_NOT_FOUND', 'Không tìm thấy phân khúc.');
  return void bridge(audiencesRouter, id ? `/${encodeURIComponent(id)}` : '/', {
    method: method === 'PUT' && id ? 'PATCH' : undefined,
  })(req, res, next);
});

marketingPhpBridgesRouter.all(
  ['/segments', '/automation/segments', '/automation/segments.php', '/segments.php'],
  requirePermission('audiences', 'view'),
  handleSegmentsCompat
);

const handleSubscribersCompat = handler('COMPAT_SUBSCRIBERS', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const route = reqRoute(req);
  const id = String(req.params?.id || phpId(req) || '').trim();

  if (route === 'field_definitions') {
    return void bridge(audiencesRouter, '/field-catalog', {
      method: 'GET',
      transform: (payload: any) => {
        const d = payload?.data || {};
        const std = Array.isArray(d.standard_fields)
          ? d.standard_fields.map((f: any) => ({ key: f.key, label: f.label, type: f.type || 'text', is_custom: false }))
          : [];
        const custom = Array.isArray(d.custom_fields)
          ? d.custom_fields.map((f: any) => ({
              key: f.filter_key || `cf.${f.field_key}`,
              label: f.field_label || f.field_key,
              type: f.field_type || 'text',
              is_custom: true,
            }))
          : [];
        return { success: true, data: [...std, ...custom] };
      },
    })(req, res, next);
  }

  if (route === 'count_unique') {
    const listIds = qstr(req, 'listIds').split(',').map((s) => s.trim()).filter((s) => isUuid(s));
    const segIds = qstr(req, 'segmentIds').split(',').map((s) => s.trim()).filter((s) => isUuid(s));
    const allIds = Array.from(new Set([...listIds, ...segIds]));
    const count = await tx(async (client, ctx) => {
      if (allIds.length === 0) return 0;
      const ph = allIds.map((_, i) => `$${i + 2}`).join(', ');
      const r = await client.query<{ cnt: number }>(
        `SELECT COUNT(DISTINCT tam.lead_id)::int AS cnt
         FROM tenant_audience_members tam
         INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
         WHERE tam.tenant_id = $1 AND tam.audience_id IN (${ph}) AND l.is_deleted = false`,
        [ctx.tenantId, ...allIds]
      );
      return Number(r.rows[0]?.cnt || 0);
    });
    return void ok(res, { count });
  }

  if (route === 'bulk-add-tag' || route === 'bulk-add-to-list' || route === 'bulk-change-status') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'edit'))) return;
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : Array.isArray(req.body?.lead_ids) ? req.body.lead_ids : [];
    const leadIds = rawIds.map(String).filter((x: string) => isUuid(x));
    if (leadIds.length === 0) return void ok(res, { affected: 0 });
    const affected = await tx(async (client, ctx) => {
      if (route === 'bulk-add-tag') {
        const tagId = String(req.body?.tag_id || '').trim();
        if (!isUuid(tagId)) return 0;
        let cnt = 0;
        for (const lid of leadIds) {
          const ins = await client.query(
            `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, lid, tagId, ctx.userId]
          );
          cnt += Number(ins.rowCount || 0);
        }
        return cnt;
      }
      if (route === 'bulk-add-to-list') {
        const listId = String(req.body?.list_id || req.body?.audience_id || '').trim();
        if (!isUuid(listId)) return 0;
        let cnt = 0;
        for (const lid of leadIds) {
          const ins = await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'bulk', '{}'::jsonb) ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, listId, lid]
          );
          cnt += Number(ins.rowCount || 0);
        }
        await refreshAudienceCachedCount(client, ctx.tenantId, listId);
        return cnt;
      }
      const nextConsent = bstr(req.body, 'status', 'email_consent') || 'subscribed';
      const ph = leadIds.map((_: string, i: number) => `$${i + 3}`).join(', ');
      const r = await client.query(
        `UPDATE leads SET email_consent = $2, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id IN (${ph})`,
        [ctx.tenantId, nextConsent, ...leadIds]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { affected });
  }

  if (method === 'GET' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'SUBSCRIBER_NOT_FOUND', 'Không tìm thấy khách hàng.');
    const contact = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const [lRes, tRes, aRes] = await Promise.all([
        client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1', [ctx.tenantId, id]),
        client.query(
          `SELECT tt.id, tt.name, tt.slug, tt.color_hex FROM lead_tags lt
           INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
           WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
          [ctx.tenantId, id]
        ),
        client.query(
          `SELECT ta.id, ta.name, ta.audience_type FROM tenant_audience_members tam
           INNER JOIN tenant_audiences ta ON ta.tenant_id = tam.tenant_id AND ta.id = tam.audience_id
           WHERE tam.tenant_id = $1 AND tam.lead_id = $2`,
          [ctx.tenantId, id]
        ),
      ]);
      if (!lRes.rows[0]) return null;
      const leadRow = lRes.rows[0];
      return {
        ...actor.mask({
          ...leadRow,
          ...(leadRow.avatar !== undefined ? { avatar: sanitizeAvatarUrl(leadRow.avatar) } : {}),
          ...(leadRow.avatar_url !== undefined ? { avatar_url: sanitizeAvatarUrl(leadRow.avatar_url) } : {}),
          custom_fields: stripEphemeralAvatarsFromCustomFields(leadRow.custom_fields),
        }),
        tags: tRes.rows,
        audiences: aRes.rows,
      };
    });
    if (!contact) return void fail(res, 404, 'SUBSCRIBER_NOT_FOUND', 'Không tìm thấy khách hàng.');
    return void ok(res, contact);
  }

  if ((method === 'PUT' || method === 'PATCH') && id) {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'SUBSCRIBER_NOT_FOUND', 'Không tìm thấy khách hàng.');
    const b = (req.body || {}) as Record<string, unknown>;
    const updated = await tx(async (client, ctx) => {
      const exRes = await client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;
      const existingCf = parseJson<Record<string, unknown>>(ex.custom_fields, {});
      const incomingCf = b.custom_fields && typeof b.custom_fields === 'object' && !Array.isArray(b.custom_fields)
        ? (b.custom_fields as Record<string, unknown>)
        : {};
      const mergedCf = deepMergeJsonObjects(existingCf, incomingCf);

      await client.query(
        `UPDATE leads
         SET name = COALESCE($3, name),
             phone = COALESCE($4, phone),
             email = COALESCE($5, email),
             status = COALESCE($6, status),
             lifecycle_stage = COALESCE($7, lifecycle_stage),
             email_consent = COALESCE($8, email_consent),
             zns_consent = COALESCE($9, zns_consent),
             custom_fields = $10::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          id,
          b.name !== undefined ? String(b.name).trim() : null,
          b.phone !== undefined ? String(b.phone).trim() : null,
          b.email !== undefined ? String(b.email).trim().toLowerCase() : null,
          b.status !== undefined ? String(b.status).trim() : null,
          b.lifecycle_stage !== undefined ? String(b.lifecycle_stage).trim() : null,
          b.email_consent !== undefined ? String(b.email_consent).trim() : null,
          b.zns_consent !== undefined ? String(b.zns_consent).trim() : null,
          JSON.stringify(mergedCf),
        ]
      );
      if (Array.isArray(b.tag_ids)) {
        for (const tid of b.tag_ids.map(String).filter((x) => isUuid(x))) {
          await client.query(
            `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, id, tid, ctx.userId]
          );
        }
      }
      if (b.audience_id && isUuid(String(b.audience_id))) {
        await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'manual', '{}'::jsonb) ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, String(b.audience_id), id]
        );
        await refreshAudienceCachedCount(client, ctx.tenantId, String(b.audience_id));
      }
      const r = await client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return r.rows[0];
    });
    if (!updated) return void fail(res, 404, 'SUBSCRIBER_NOT_FOUND', 'Không tìm thấy khách hàng.');
    const ctx = getTenantContext();
    await emitDomainEvent('lead.updated', { tenantId: ctx.tenantId, leadId: id, actorId: ctx.userId });
    return void ok(res, updated);
  }

  if (method === 'DELETE' && id) {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'delete'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'SUBSCRIBER_NOT_FOUND', 'Không tìm thấy khách hàng.');
    const deleted = await tx(async (client, ctx) => {
      const r = await client.query(
        'UPDATE leads SET is_deleted = true, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 AND is_deleted = false',
        [ctx.tenantId, id]
      );
      return Number(r.rowCount || 0) > 0;
    });
    if (!deleted) return void fail(res, 404, 'SUBSCRIBER_NOT_FOUND', 'Không tìm thấy khách hàng.');
    return void ok(res, { deleted: true, id });
  }

  if (method === 'DELETE') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'delete'))) return;
  } else if (method === 'PUT' || method === 'PATCH') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'edit'))) return;
  } else if (method === 'POST') {
    if (!(await ensureCompatPermission(req, res, 'audiences', 'create'))) return;
  }

  return void bridge(audiencesRouter, '/contacts')(req, res, next);
});

marketingPhpBridgesRouter.all(
  ['/subscribers', '/subscribers/:id', '/automation/subscribers', '/automation/subscribers.php', '/subscribers.php'],
  requirePermission('audiences', 'view'),
  handleSubscribersCompat
);

marketingPhpBridgesRouter.post(
  ['/automation/audience_split.php', '/audience_split.php', '/audience_split'],
  requirePermission('audiences', 'edit'),
  handler('COMPAT_AUDIENCE_SPLIT', async (req, res) => {
    const sourceId = String(req.body?.source_id || '').trim();
    const quantity = Math.max(2, Math.min(10, Number(req.body?.quantity || 2)));
    const ratios: number[] = Array.isArray(req.body?.ratios)
      ? req.body.ratios.map(Number)
      : Array.from({ length: quantity }, () => Math.floor(100 / quantity));
    if (!isUuid(sourceId)) return void fail(res, 422, 'SOURCE_ID_REQUIRED', 'Thiếu source_id hợp lệ để chia tệp.');
    const ctx = getTenantContext();
    const namePrefix =
      Array.isArray(req.body?.names) && req.body.names.length > 0
        ? String(req.body.names[0])
        : typeof req.body?.name_prefix === 'string'
          ? req.body.name_prefix
          : undefined;
    const result = await splitAudienceIntoParts(ctx.tenantId, sourceId, {
      ratios,
      parts: ratios.length,
      name_prefix: namePrefix,
      actorId: ctx.userId,
    });
    ok(res, result, '', 201);
  })
);

marketingPhpBridgesRouter.post(
  ['/automation/subscriber_ai_summary', '/automation/subscriber_ai_summary.php', '/subscriber_ai_summary'],
  requirePermission('audiences', 'view'),
  handler('COMPAT_SUBSCRIBER_AI_SUMMARY', async (req, res) => {
    const subscriberId = String(req.body?.subscriber_id || req.body?.lead_id || phpId(req) || '').trim();
    if (!isUuid(subscriberId)) return void fail(res, 422, 'SUBSCRIBER_ID_REQUIRED', 'Thiếu subscriber_id hợp lệ.');
    const summary = await tx(async (client, ctx) => {
      const [lRes, tlRes, srvRes, msgRes] = await Promise.all([
        client.query('SELECT name, status, lifecycle_stage, lead_score, total_revenue_vnd, source FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          subscriberId,
        ]),
        client.query('SELECT event_type, title, created_at FROM lead_timeline_events WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC LIMIT 8', [
          ctx.tenantId,
          subscriberId,
        ]),
        client.query('SELECT quiz_score, nps_score, created_at FROM mkt_survey_responses WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC LIMIT 3', [
          ctx.tenantId,
          subscriberId,
        ]),
        client.query(
          `SELECT m.content, m.sender_type FROM mkt_social_messages m
           INNER JOIN mkt_social_conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
           WHERE m.tenant_id = $1 AND c.lead_id = $2 ORDER BY m.created_at DESC LIMIT 5`,
          [ctx.tenantId, subscriberId]
        ),
      ]);
      const l = lRes.rows[0];
      if (!l) return null;
      const lines = [
        `Hồ sơ **${l.name}** — Trạng thái: ${l.status} (${l.lifecycle_stage || 'lead'}), Điểm nóng: ${Number(l.lead_score || 0)}, Doanh thu: ${Number(l.total_revenue_vnd || 0).toLocaleString('vi-VN')}₫.`,
        `Nguồn: ${l.source || 'Direct'}. Hoạt động gần đây (${tlRes.rows.length}): ${tlRes.rows.map((e) => e.title || e.event_type).slice(0, 4).join('; ') || 'Chưa có'}.`,
      ];
      if (srvRes.rows.length > 0) {
        lines.push(`Khảo sát/Quiz: ${srvRes.rows.map((s) => `Score ${s.quiz_score ?? '-'} / NPS ${s.nps_score ?? '-'}`).join(', ')}.`);
      }
      if (msgRes.rows.length > 0) {
        lines.push(`Trao đổi gần nhất: "${String(msgRes.rows[0].content).slice(0, 120)}"`);
      }
      return lines.join('\n');
    });
    if (!summary) return void fail(res, 404, 'SUBSCRIBER_NOT_FOUND', 'Không tìm thấy khách hàng.');
    ok(res, { summary });
  })
);

marketingPhpBridgesRouter.post(
  ['/automation/bulk_operations', '/automation/bulk_operations.php', '/bulk_operations'],
  requirePermission('audiences', 'view'),
  handler('COMPAT_BULK_OPERATIONS', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const opType = String(b.type || b.action || '').trim().toLowerCase();
    const requiredAction: GranularAction =
      opType === 'import'
        ? 'create'
        : opType === 'delete' || opType === 'list_remove' || opType === 'tag_remove' || opType === 'remove_tag'
          ? 'delete'
          : 'edit';
    if (!(await ensureCompatPermission(req, res, 'audiences', requiredAction))) return;
    const rawIds = Array.isArray(b.ids) ? b.ids : Array.isArray(b.subscriber_ids) ? b.subscriber_ids : Array.isArray(b.lead_ids) ? b.lead_ids : [];
    const leadIds = rawIds.map(String).filter((x: string) => isUuid(x));

    if (opType === 'import' && Array.isArray(b.rows) && isUuid(String(b.audience_id || ''))) {
      const ctx = getTenantContext();
      const resImport = await importRowsIntoAudience(ctx.tenantId, String(b.audience_id), b.rows as Array<Record<string, any>>, {
        actorId: ctx.userId,
      });
      return void ok(res, { affected: resImport.imported_count, ...resImport });
    }
    if (leadIds.length === 0) return void ok(res, { affected: 0 });

    const affected = await tx(async (client, ctx) => {
      const ph = leadIds.map((_, i) => `$${i + 2}`).join(', ');
      if (opType === 'delete') {
        const r = await client.query(`UPDATE leads SET is_deleted = true, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id IN (${ph})`, [
          ctx.tenantId,
          ...leadIds,
        ]);
        return Number(r.rowCount || 0);
      }
      if (opType === 'list_remove' && isUuid(String(b.list_id || b.audience_id || ''))) {
        const audId = String(b.list_id || b.audience_id);
        const lph = leadIds.map((_, i) => `$${i + 3}`).join(', ');
        const r = await client.query(
          `DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id IN (${lph})`,
          [ctx.tenantId, audId, ...leadIds]
        );
        await refreshAudienceCachedCount(client, ctx.tenantId, audId);
        return Number(r.rowCount || 0);
      }
      if ((opType === 'add_to_list' || opType === 'list_add') && isUuid(String(b.list_id || b.audience_id || ''))) {
        const audId = String(b.list_id || b.audience_id);
        let cnt = 0;
        for (const lid of leadIds) {
          const ins = await client.query(
            `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
             VALUES ($1, $2, $3, $4, 'bulk', '{}'::jsonb) ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, audId, lid]
          );
          cnt += Number(ins.rowCount || 0);
        }
        await refreshAudienceCachedCount(client, ctx.tenantId, audId);
        return cnt;
      }
      if ((opType === 'tag_remove' || opType === 'remove_tag') && isUuid(String(b.tag_id || ''))) {
        const lph = leadIds.map((_, i) => `$${i + 3}`).join(', ');
        const r = await client.query(
          `DELETE FROM lead_tags WHERE tenant_id = $1 AND tag_id = $2 AND lead_id IN (${lph})`,
          [ctx.tenantId, String(b.tag_id), ...leadIds]
        );
        return Number(r.rowCount || 0);
      }
      if (opType === 'add_tag' && isUuid(String(b.tag_id || ''))) {
        let cnt = 0;
        for (const lid of leadIds) {
          const ins = await client.query(
            `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id, assigned_by)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
            [crypto.randomUUID(), ctx.tenantId, lid, String(b.tag_id), ctx.userId]
          );
          cnt += Number(ins.rowCount || 0);
        }
        return cnt;
      }
      if (opType === 'change_status') {
        const nextStatus = bstr(b, 'email_consent', 'status') || 'subscribed';
        const lph = leadIds.map((_, i) => `$${i + 3}`).join(', ');
        const r = await client.query(
          `UPDATE leads SET email_consent = $2, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id IN (${lph})`,
          [ctx.tenantId, nextStatus, ...leadIds]
        );
        return Number(r.rowCount || 0);
      }
      return 0;
    });

    ok(res, { affected, type: opType });
  })
);

// ---- D. Web Tracking & Blacklist ----
function resolveWebTrackingDateBounds(
  period: string,
  startDate: string,
  endDate: string
): { sinceIso: string | null; untilIso: string | null } {
  const cleanStart = String(startDate || '').trim();
  const cleanEnd = String(endDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStart) && /^\d{4}-\d{2}-\d{2}$/.test(cleanEnd)) {
    return {
      sinceIso: `${cleanStart}T00:00:00.000Z`,
      untilIso: `${cleanEnd}T23:59:59.999Z`,
    };
  }
  const p = String(period || '7d').trim().toLowerCase();
  if (p === 'all') return { sinceIso: null, untilIso: null };

  const now = new Date();
  const untilIso = now.toISOString();
  const since = new Date(now);
  if (p === 'today' || p === '1d') {
    since.setUTCHours(0, 0, 0, 0);
  } else if (p === 'yesterday') {
    since.setUTCDate(since.getUTCDate() - 1);
    since.setUTCHours(0, 0, 0, 0);
    const yEnd = new Date(since);
    yEnd.setUTCHours(23, 59, 59, 999);
    return { sinceIso: since.toISOString(), untilIso: yEnd.toISOString() };
  } else if (p === '30d') {
    since.setUTCDate(since.getUTCDate() - 30);
  } else if (p === '90d') {
    since.setUTCDate(since.getUTCDate() - 90);
  } else {
    since.setUTCDate(since.getUTCDate() - 7);
  }
  return { sinceIso: since.toISOString(), untilIso };
}

function deriveTrafficSource(
  utmSource: unknown,
  utmMedium: unknown,
  referrer: unknown
): { source: string; medium: string } {
  const src = String(utmSource || '').trim();
  const med = String(utmMedium || '').trim();
  if (src) {
    return { source: src, medium: med || 'utm' };
  }
  const ref = String(referrer || '').trim();
  if (ref) {
    try {
      const host = new URL(ref).hostname.replace(/^www\./i, '').toLowerCase();
      if (host) {
        if (host.includes('google.')) return { source: 'google', medium: 'organic' };
        if (host.includes('facebook.') || host.includes('fb.com') || host.includes('m.facebook.')) {
          return { source: 'facebook', medium: 'social' };
        }
        if (host.includes('zalo.')) return { source: 'zalo', medium: 'social' };
        return { source: host, medium: 'referral' };
      }
    } catch {
      return { source: ref.slice(0, 60), medium: 'referral' };
    }
  }
  return { source: 'direct', medium: 'none' };
}

async function resolveAiTrainingPropertiesWithStats(
  client: DbClient,
  tenantId: string
): Promise<{
  properties: Array<Record<string, unknown>>;
  resolveDocPropertyId: (docRow: Record<string, unknown>) => string;
  primaryPropertyId: string;
}> {
  const [propsRes, docsRes, convRes, tenantRes] = await Promise.all([
    client.query(
      `SELECT p.*, a.name AS target_audience_name
       FROM mkt_web_properties p
       LEFT JOIN tenant_audiences a ON a.tenant_id = p.tenant_id AND a.id = p.target_audience_id
       WHERE p.tenant_id = $1
       ORDER BY p.created_at DESC`,
      [tenantId]
    ),
    client.query(
      'SELECT id, metadata_json, status FROM mkt_ai_training_docs WHERE tenant_id = $1',
      [tenantId]
    ),
    client.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = 'web_chat'",
      [tenantId]
    ),
    client.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE id = $1 LIMIT 1', [tenantId]),
  ]);

  const rawProps = propsRes.rows;
  const normDomain = (d: unknown) =>
    String(d || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  const primaryProp =
    rawProps.find((p) => normDomain(p.domain) === 'ideas.edu.vn') ||
    rawProps.find((p) => String(p.name || '').trim().toLowerCase() === 'ideas.edu.vn') ||
    rawProps.find(
      (p) => normDomain(p.domain).includes('ideas.edu.vn') && !normDomain(p.domain).startsWith('ai.')
    ) ||
    rawProps.find((p) => normDomain(p.domain).includes('ideas.edu.vn')) ||
    rawProps.find((p) => p.is_active !== false) ||
    rawProps[0];
  const primaryPropertyId = primaryProp ? String(primaryProp.id) : '';

  const keyToPropId = new Map<string, string>();
  for (const p of rawProps) {
    const pid = String(p.id);
    keyToPropId.set(pid.toLowerCase(), pid);
    const siteKey = String(p.site_key || '').trim();
    if (siteKey) {
      keyToPropId.set(siteKey.toLowerCase(), pid);
      const stripped = siteKey.replace(/^wp_[^_]+_/, '').trim();
      if (stripped) keyToPropId.set(stripped.toLowerCase(), pid);
    }
    const domain = String(p.domain || '').trim().toLowerCase();
    if (domain) keyToPropId.set(domain, pid);
  }

  const resolveDocPropertyId = (docRow: Record<string, unknown>): string => {
    const meta = parseJson<Record<string, unknown>>(docRow.metadata_json, {});
    const rawKey = String(meta.property_id ?? meta.propertyId ?? docRow.property_id ?? '').trim().toLowerCase();
    if (rawKey && keyToPropId.has(rawKey)) {
      return keyToPropId.get(rawKey)!;
    }
    const metaDomain = String(meta.domain || '').trim().toLowerCase();
    if (metaDomain && keyToPropId.has(metaDomain)) {
      return keyToPropId.get(metaDomain)!;
    }
    return primaryPropertyId;
  };

  const docsCountMap = new Map<string, number>();
  for (const docRow of docsRes.rows) {
    const targetPid = resolveDocPropertyId(docRow);
    if (targetPid) {
      docsCountMap.set(targetPid, (docsCountMap.get(targetPid) || 0) + 1);
    }
  }

  const totalWebChat = Number(convRes.rows[0]?.cnt || 0);
  const tenantSettings = parseJson<Record<string, unknown>>(tenantRes.rows[0]?.settings, {});
  const savedPropStats =
    tenantSettings.ai_training_property_stats && typeof tenantSettings.ai_training_property_stats === 'object'
      ? (tenantSettings.ai_training_property_stats as Record<string, Record<string, unknown>>)
      : {};

  const queriesCountMap = new Map<string, number>();
  let configuredSum = 0;
  let hasSavedQueries = false;
  for (const p of rawProps) {
    const pid = String(p.id);
    const legacyId = String(p.site_key || '').replace(/^wp_[^_]+_/, '').trim();
    const statEntry =
      savedPropStats[pid] ||
      (legacyId ? savedPropStats[legacyId] : undefined) ||
      savedPropStats[String(p.domain || '').toLowerCase()];
    const qVal = statEntry ? Math.max(0, Number(statEntry.queries_count || 0)) : 0;
    if (statEntry && Number.isFinite(Number(statEntry.queries_count))) {
      hasSavedQueries = true;
    }
    queriesCountMap.set(pid, qVal);
    configuredSum += qVal;
  }

  if (!hasSavedQueries) {
    if (primaryPropertyId) queriesCountMap.set(primaryPropertyId, totalWebChat);
  } else if (totalWebChat > configuredSum && primaryPropertyId) {
    queriesCountMap.set(primaryPropertyId, (queriesCountMap.get(primaryPropertyId) || 0) + (totalWebChat - configuredSum));
  } else if (totalWebChat < configuredSum && configuredSum > 0) {
    const scale = totalWebChat / configuredSum;
    let allocated = 0;
    rawProps.forEach((p, idx) => {
      const pid = String(p.id);
      if (idx === rawProps.length - 1) {
        queriesCountMap.set(pid, Math.max(0, totalWebChat - allocated));
      } else {
        const scaled = Math.round((queriesCountMap.get(pid) || 0) * scale);
        queriesCountMap.set(pid, scaled);
        allocated += scaled;
      }
    });
  }

  const properties = rawProps.map((p) => {
    const pid = String(p.id);
    const docsCount = docsCountMap.get(pid) || 0;
    const queriesCount = queriesCountMap.get(pid) || 0;
    const aiEnabled = p.is_active !== false && p.is_active !== 0;
    return {
      ...p,
      ai_enabled: aiEnabled,
      is_enabled: aiEnabled,
      docs_count: docsCount,
      queries_count: queriesCount,
      stats: {
        docs_count: docsCount,
        queries_count: queriesCount,
      },
    };
  });

  return { properties, resolveDocPropertyId, primaryPropertyId };
}

const handleWebTrackingCompat = handler('COMPAT_WEB_TRACKING', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const action = reqAction(req);
  const id = phpId(req);

  if (method === 'POST' && (action === 'create' || !action)) {
    if (!(await ensureCompatPermission(req, res, 'mkt_web_tracking', 'create'))) return;
    return void bridge(marketingRouter, '/web-tracking/properties')(req, res, next);
  }
  if ((method === 'DELETE' || action === 'delete') && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_web_tracking', 'delete'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'PROPERTY_NOT_FOUND', 'Không tìm thấy Website.');
    return void bridge(marketingRouter, `/web-tracking/properties/${encodeURIComponent(id)}`, { method: 'DELETE' })(req, res, next);
  }
  if (action === 'list') {
    const properties = await tx(async (client, ctx) => {
      const out = await resolveAiTrainingPropertiesWithStats(client, ctx.tenantId);
      return out.properties;
    });
    return void ok(res, properties);
  }
  if (action === 'live_visitors') {
    const propertyId = String(id || qstr(req, 'property_id') || '').trim();
    if (propertyId && !isUuid(propertyId)) return void ok(res, []);
    const liveVisitors = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const params: unknown[] = [ctx.tenantId];
      let whereSql = `s.tenant_id = $1 AND s.last_seen_at >= (clock_timestamp() - INTERVAL '30 minutes')`;
      if (propertyId) {
        params.push(propertyId);
        whereSql += ` AND s.property_id = $${params.length}`;
      }
      const r = await client.query(
        `SELECT s.*, l.name AS lead_name, l.email AS lead_email, l.phone AS lead_phone
         FROM mkt_web_sessions s
         LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
         WHERE ${whereSql}
         ORDER BY s.last_seen_at DESC
         LIMIT 100`,
        params
      );
      return r.rows.map((row) => {
        const masked = actor.mask({ name: row.lead_name, email: row.lead_email, phone: row.lead_phone });
        const startedMs = row.started_at ? new Date(String(row.started_at)).getTime() : Date.now();
        const lastMs = row.last_seen_at ? new Date(String(row.last_seen_at)).getTime() : Date.now();
        const elapsed = Number(row.duration_seconds || 0) || Math.max(0, Math.round((lastMs - startedMs) / 1000));
        return {
          id: String(row.id),
          subscriber_id: row.lead_id ? String(row.lead_id) : undefined,
          first_name: masked.name || undefined,
          email: masked.email || undefined,
          phone: masked.phone || undefined,
          city: row.geo_city || undefined,
          country: row.geo_country || 'VN',
          device_type: String(row.device_type || 'desktop'),
          os: row.os || 'Unknown',
          browser: row.browser || 'Unknown',
          page_title: String(row.last_url || row.entry_url || ''),
          page_url: String(row.last_url || row.entry_url || ''),
          page_loaded_at: row.started_at,
          last_visit_at: row.last_seen_at,
          time_on_page: elapsed,
        };
      });
    });
    return void ok(res, liveVisitors);
  }
  if (action === 'heatmap') {
    if (!req.query.property_id && id) req.query.property_id = id;
    if (!req.query.page_url && req.query.url) req.query.page_url = req.query.url;
    return void bridge(marketingRouter, '/web-tracking/heatmap')(req, res, next);
  }
  if (action === 'blacklist') {
    const rows = await tx(async (client, ctx) => {
      const r = await client.query(
        "SELECT id, value AS ip, value AS ip_address, reason, created_at FROM blacklist_entries WHERE tenant_id = $1 AND entry_type = 'ip' ORDER BY created_at DESC",
        [ctx.tenantId]
      );
      return r.rows;
    });
    return void ok(res, rows);
  }
  if (action === 'block_ip') {
    if (!(await ensureCompatPermission(req, res, 'mkt_web_tracking', 'create'))) return;
    const ip = bstr(req.body, 'ip', 'ip_address', 'value') || qstr(req, 'ip') || qstr(req, 'ip_address');
    if (!ip) return void fail(res, 422, 'IP_REQUIRED', 'Vui lòng nhập địa chỉ IP cần chặn.');
    const reason = bstr(req.body, 'reason') || qstr(req, 'reason') || 'Manual Web Blacklist';
    const created = await tx(async (client, ctx) => {
      const entryId = crypto.randomUUID();
      const r = await client.query(
        `INSERT INTO blacklist_entries (id, tenant_id, entry_type, value, reason, created_by)
         VALUES ($1, $2, 'ip', $3, $4, $5)
         ON CONFLICT (tenant_id, entry_type, value) DO UPDATE SET reason = EXCLUDED.reason
         RETURNING id, value AS ip, value AS ip_address, reason, created_at`,
        [entryId, ctx.tenantId, ip, reason, ctx.userId]
      );
      tenantRedis.invalidateBlacklistCache(ctx.tenantId);
      return r.rows[0] || { id: entryId, ip, ip_address: ip, reason };
    });
    return void ok(res, created, '', 201);
  }
  if (action === 'unblock_ip') {
    if (!(await ensureCompatPermission(req, res, 'mkt_web_tracking', 'delete'))) return;
    const target = String(
      id || qstr(req, 'ip') || qstr(req, 'ip_address') || req.body?.ip || req.body?.ip_address || ''
    ).trim();
    if (!target) return void fail(res, 422, 'IP_OR_ID_REQUIRED', 'Thiếu IP hoặc ID cần gỡ khỏi danh sách chặn.');
    await tx(async (client, ctx) => {
      await client.query(
        "DELETE FROM blacklist_entries WHERE tenant_id = $1 AND entry_type = 'ip' AND (id::text = $2 OR value = $2)",
        [ctx.tenantId, target]
      );
      tenantRedis.invalidateBlacklistCache(ctx.tenantId);
    });
    return void ok(res, { deleted: true, unblocked: true, target });
  }
  if (action === 'stats') {
    const propertyId = String(id || qstr(req, 'property_id') || '').trim();
    const period = qstr(req, 'period') || '7d';
    const startDate = qstr(req, 'start_date');
    const endDate = qstr(req, 'end_date');
    const rawDevice = qstr(req, 'device').toLowerCase();
    const deviceFilter = rawDevice && rawDevice !== 'all' ? rawDevice : '';

    if (propertyId && !isUuid(propertyId)) {
      return void ok(res, {
        overview: { visitors: 0, newUsers: 0, sessions: 0, avgDuration: 0, pageViews: 0, bounceRate: 0, bounces: 0 },
        chart: [],
        deviceStats: [],
        osStats: [],
        locationStats: [],
        trafficSources: [],
        userAcquisition: [],
        topPages: [],
        topEvents: [],
      });
    }

    const { sinceIso, untilIso } = resolveWebTrackingDateBounds(period, startDate, endDate);

    const data = await tx(async (client, ctx) => {
      const sessParams: unknown[] = [ctx.tenantId];
      let sessWhere = 's.tenant_id = $1';
      if (propertyId) {
        sessParams.push(propertyId);
        sessWhere += ` AND s.property_id = $${sessParams.length}`;
      }
      if (deviceFilter) {
        sessParams.push(deviceFilter);
        sessWhere += ` AND LOWER(COALESCE(s.device_type, 'desktop')) = $${sessParams.length}`;
      }
      if (sinceIso) {
        sessParams.push(sinceIso);
        sessWhere += ` AND s.last_seen_at >= $${sessParams.length}::timestamptz`;
      }
      if (untilIso) {
        sessParams.push(untilIso);
        sessWhere += ` AND s.last_seen_at <= $${sessParams.length}::timestamptz`;
      }

      const evParams: unknown[] = [ctx.tenantId];
      let evJoin = '';
      let evWhere = 'e.tenant_id = $1';
      if (deviceFilter) {
        evParams.push(deviceFilter);
        evJoin = 'INNER JOIN mkt_web_sessions s ON s.tenant_id = e.tenant_id AND s.id = e.session_id';
        evWhere += ` AND LOWER(COALESCE(s.device_type, 'desktop')) = $${evParams.length}`;
      }
      if (propertyId) {
        evParams.push(propertyId);
        evWhere += ` AND e.property_id = $${evParams.length}`;
      }
      if (sinceIso) {
        evParams.push(sinceIso);
        evWhere += ` AND e.created_at >= $${evParams.length}::timestamptz`;
      }
      if (untilIso) {
        evParams.push(untilIso);
        evWhere += ` AND e.created_at <= $${evParams.length}::timestamptz`;
      }

      const [sessionsRes, eventsRes] = await Promise.all([
        client.query<{
          id: string;
          visitor_token: string;
          entry_url: string | null;
          referrer: string | null;
          utm_source: string | null;
          utm_medium: string | null;
          utm_campaign: string | null;
          device_type: string | null;
          os: string | null;
          geo_country: string | null;
          geo_city: string | null;
          pageviews_count: number;
          duration_seconds: number;
          started_at: string;
          last_seen_at: string;
        }>(
          `SELECT s.id, s.visitor_token, s.entry_url, s.referrer, s.utm_source, s.utm_medium, s.utm_campaign,
                  s.device_type, s.os, s.geo_country, s.geo_city, s.pageviews_count,
                  COALESCE(s.duration_seconds, 0)::int AS duration_seconds, s.started_at, s.last_seen_at
           FROM mkt_web_sessions s
           WHERE ${sessWhere}
           ORDER BY s.last_seen_at DESC
           LIMIT 5000`,
          sessParams
        ),
        client.query<{
          session_id: string;
          event_type: string;
          page_url: string;
          element_selector: string | null;
          scroll_depth_pct: number | null;
          metadata: unknown;
          created_at: string;
        }>(
          `SELECT e.session_id, e.event_type, e.page_url, e.element_selector, e.scroll_depth_pct, e.metadata, e.created_at
           FROM mkt_web_events e
           ${evJoin}
           WHERE ${evWhere}
           ORDER BY e.created_at DESC
           LIMIT 10000`,
          evParams
        ),
      ]);

      const sessions = sessionsRes.rows;
      const events = eventsRes.rows;

      const engagedSessionIds = new Set<string>();
      const eventPageViewsByDay = new Map<string, number>();
      const pageStatsMap = new Map<
        string,
        {
          url: string;
          title: string;
          count: number;
          scrollSum: number;
          scrollCnt: number;
          timeSum: number;
          timeCnt: number;
          entrySessions: Set<string>;
          bouncedEntries: number;
        }
      >();
      const topEventsMap = new Map<string, { type: string; target: string; count: number; url?: string }>();

      for (const ev of events) {
        const evType = String(ev.event_type || 'pageview');
        const meta = parseJson<Record<string, unknown>>(ev.metadata, {});
        if (['click', 'canvas_click', 'form', 'identify', 'pricing_intent'].includes(evType)) {
          engagedSessionIds.add(String(ev.session_id));
        }
        if (evType === 'scroll' && Number(ev.scroll_depth_pct || 0) >= 25) {
          engagedSessionIds.add(String(ev.session_id));
        }
        const dayKey = ev.created_at ? new Date(String(ev.created_at)).toISOString().slice(0, 10) : '';
        const url = String(ev.page_url || '');
        if (url) {
          let pStat = pageStatsMap.get(url);
          if (!pStat) {
            pStat = {
              url,
              title: String(meta.page_title || url),
              count: 0,
              scrollSum: 0,
              scrollCnt: 0,
              timeSum: 0,
              timeCnt: 0,
              entrySessions: new Set<string>(),
              bouncedEntries: 0,
            };
            pageStatsMap.set(url, pStat);
          } else if (meta.page_title && pStat.title === pStat.url) {
            pStat.title = String(meta.page_title);
          }

          if (evType === 'pageview' || evType === 'pricing_intent') {
            pStat.count += 1;
            if (dayKey) eventPageViewsByDay.set(dayKey, (eventPageViewsByDay.get(dayKey) || 0) + 1);
          }
          if (ev.scroll_depth_pct !== null && ev.scroll_depth_pct !== undefined) {
            const sd = Number(ev.scroll_depth_pct);
            if (Number.isFinite(sd) && sd > 0) {
              pStat.scrollSum += sd;
              pStat.scrollCnt += 1;
            }
          }
          const evDur = Number(meta.duration_seconds || 0);
          if (evDur > 0 && Number.isFinite(evDur)) {
            pStat.timeSum += Math.min(86400, evDur);
            pStat.timeCnt += 1;
          }
        }

        if (!['pageview', 'ping', 'page_exit'].includes(evType)) {
          const target =
            evType === 'scroll'
              ? `Scroll ${Number(ev.scroll_depth_pct || meta.percent || 0)}%`
              : String(meta.text || ev.element_selector || url || evType).slice(0, 120);
          const evKey = `${evType}|${target}|${url}`;
          const cur = topEventsMap.get(evKey);
          if (cur) cur.count += 1;
          else topEventsMap.set(evKey, { type: evType, target, count: 1, url });
        }
      }

      const uniqueVisitors = new Set<string>();
      const newVisitors = new Set<string>();
      const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;

      const chartMap = new Map<string, { date: string; sessions: number; pageViews: number }>();
      const deviceMap = new Map<string, number>();
      const osMap = new Map<string, number>();
      const locationMap = new Map<string, number>();
      const sourceMap = new Map<
        string,
        { source: string; medium: string; campaign: string | null; sessions: number; visitorsSet: Set<string> }
      >();
      const acqMap = new Map<string, { source: string; medium: string; visitorsSet: Set<string> }>();

      let totalPageViews = 0;
      let totalDurationSum = 0;
      let bounces = 0;

      for (const s of sessions) {
        const vTok = String(s.visitor_token || s.id);
        uniqueVisitors.add(vTok);
        const startedMs = s.started_at ? new Date(String(s.started_at)).getTime() : 0;
        const lastMs = s.last_seen_at ? new Date(String(s.last_seen_at)).getTime() : startedMs;
        const isNewUser = !sinceMs || startedMs >= sinceMs;
        if (isNewUser) newVisitors.add(vTok);

        const pv = Math.max(0, Number(s.pageviews_count || 0));
        totalPageViews += pv;

        const storedDur = Math.max(0, Number(s.duration_seconds || 0));
        const inferredDur = Math.min(86400, Math.max(0, Math.round((lastMs - startedMs) / 1000)));
        const effDuration = storedDur > 0 ? storedDur : inferredDur;
        totalDurationSum += effDuration;

        const isBounce = pv <= 1 && effDuration < 10 && !engagedSessionIds.has(String(s.id));
        if (isBounce) bounces += 1;

        if (s.entry_url && pageStatsMap.has(String(s.entry_url))) {
          const pStat = pageStatsMap.get(String(s.entry_url))!;
          pStat.entrySessions.add(String(s.id));
          if (isBounce) pStat.bouncedEntries += 1;
          if (effDuration > 0 && pStat.timeCnt === 0) {
            pStat.timeSum += effDuration;
            pStat.timeCnt += 1;
          }
        }

        const dayKey = s.last_seen_at ? new Date(String(s.last_seen_at)).toISOString().slice(0, 10) : '';
        if (dayKey) {
          const pt = chartMap.get(dayKey) || { date: dayKey, sessions: 0, pageViews: 0 };
          pt.sessions += 1;
          pt.pageViews += pv;
          chartMap.set(dayKey, pt);
        }

        const dev = String(s.device_type || 'desktop').toLowerCase() || 'desktop';
        deviceMap.set(dev, (deviceMap.get(dev) || 0) + 1);

        const osVal = String(s.os || 'Unknown').trim() || 'Unknown';
        osMap.set(osVal, (osMap.get(osVal) || 0) + 1);

        const locVal = String(s.geo_city || s.geo_country || 'VN').trim() || 'VN';
        locationMap.set(locVal, (locationMap.get(locVal) || 0) + 1);

        const { source, medium } = deriveTrafficSource(s.utm_source, s.utm_medium, s.referrer);
        const campaign = s.utm_campaign ? String(s.utm_campaign) : null;
        const srcKey = `${source.toLowerCase()}|${medium.toLowerCase()}|${campaign || ''}`;
        const srcEntry = sourceMap.get(srcKey) || {
          source,
          medium,
          campaign,
          sessions: 0,
          visitorsSet: new Set<string>(),
        };
        srcEntry.sessions += 1;
        srcEntry.visitorsSet.add(vTok);
        sourceMap.set(srcKey, srcEntry);

        if (isNewUser) {
          const acqKey = `${source.toLowerCase()}|${medium.toLowerCase()}`;
          const acqEntry = acqMap.get(acqKey) || { source, medium, visitorsSet: new Set<string>() };
          acqEntry.visitorsSet.add(vTok);
          acqMap.set(acqKey, acqEntry);
        }
      }

      // Merge event-only days into chart if any
      for (const [dayKey, evPv] of eventPageViewsByDay.entries()) {
        const existing = chartMap.get(dayKey);
        if (existing) {
          existing.pageViews = Math.max(existing.pageViews, evPv);
        } else {
          chartMap.set(dayKey, { date: dayKey, sessions: 0, pageViews: evPv });
        }
      }

      const sessionsCount = sessions.length;
      const eventPageViewsTotal = Array.from(eventPageViewsByDay.values()).reduce((a, b) => a + b, 0);
      const finalPageViews = Math.max(totalPageViews, eventPageViewsTotal);

      const chart = Array.from(chartMap.values()).sort((a, b) => a.date.localeCompare(b.date));
      const deviceStats = Array.from(deviceMap.entries())
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
      const osStats = Array.from(osMap.entries())
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
      const locationStats = Array.from(locationMap.entries())
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);
      const trafficSources = Array.from(sourceMap.values())
        .map((x) => ({
          source: x.source,
          medium: x.medium,
          campaign: x.campaign,
          sessions: x.sessions,
          visitors: x.visitorsSet.size,
        }))
        .sort((a, b) => b.sessions - a.sessions);
      const userAcquisition = Array.from(acqMap.values())
        .map((x) => ({
          source: x.source,
          medium: x.medium,
          newUsers: x.visitorsSet.size,
        }))
        .sort((a, b) => b.newUsers - a.newUsers);
      const topPages = Array.from(pageStatsMap.values())
        .filter((p) => p.count > 0 || p.scrollCnt > 0 || p.timeCnt > 0)
        .map((p) => ({
          url: p.url,
          title: p.title || p.url,
          count: Math.max(p.count, p.entrySessions.size, 1),
          avgTime: p.timeCnt > 0 ? Math.round(p.timeSum / p.timeCnt) : 0,
          avgScroll: p.scrollCnt > 0 ? Math.round(p.scrollSum / p.scrollCnt) : 0,
          bounceRate:
            p.entrySessions.size > 0 ? Number(((p.bouncedEntries / p.entrySessions.size) * 100).toFixed(1)) : 0,
          avgLoadTime: 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 30);
      const topEvents = Array.from(topEventsMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      return {
        overview: {
          visitors: uniqueVisitors.size,
          newUsers: newVisitors.size,
          sessions: sessionsCount,
          avgDuration: sessionsCount > 0 ? Math.round(totalDurationSum / sessionsCount) : 0,
          pageViews: finalPageViews,
          bounceRate: sessionsCount > 0 ? Number(((bounces / sessionsCount) * 100).toFixed(1)) : 0,
          bounces,
        },
        chart,
        deviceStats,
        osStats,
        locationStats,
        trafficSources,
        userAcquisition,
        topPages,
        topEvents,
      };
    });
    return void ok(res, data);
  }
  if (action === 'page_details') {
    const propertyId = String(id || qstr(req, 'property_id') || '').trim();
    const targetUrl = String(qstr(req, 'url') || qstr(req, 'page_url') || '').trim();
    const rawDevice = qstr(req, 'device').toLowerCase();
    const deviceFilter = rawDevice && rawDevice !== 'all' ? rawDevice : '';
    const { sinceIso, untilIso } = resolveWebTrackingDateBounds(
      qstr(req, 'period') || 'custom',
      qstr(req, 'start_date'),
      qstr(req, 'end_date')
    );

    const data = await tx(async (client, ctx) => {
      const params: unknown[] = [ctx.tenantId];
      let whereSql = 'e.tenant_id = $1';
      if (propertyId && isUuid(propertyId)) {
        params.push(propertyId);
        whereSql += ` AND e.property_id = $${params.length}`;
      }
      if (targetUrl) {
        params.push(`%${targetUrl.toLowerCase()}%`);
        whereSql += ` AND LOWER(e.page_url) LIKE $${params.length}`;
      }
      if (deviceFilter) {
        params.push(deviceFilter);
        whereSql += ` AND LOWER(COALESCE(s.device_type, 'desktop')) = $${params.length}`;
      }
      if (sinceIso) {
        params.push(sinceIso);
        whereSql += ` AND e.created_at >= $${params.length}::timestamptz`;
      }
      if (untilIso) {
        params.push(untilIso);
        whereSql += ` AND e.created_at <= $${params.length}::timestamptz`;
      }

      const evRes = await client.query<{
        session_id: string;
        event_type: string;
        page_url: string;
        element_selector: string | null;
        scroll_depth_pct: number | null;
        metadata: unknown;
        visitor_token: string | null;
        entry_url: string | null;
        utm_source: string | null;
        utm_medium: string | null;
        referrer: string | null;
        pageviews_count: number;
        duration_seconds: number;
      }>(
        `SELECT e.session_id, e.event_type, e.page_url, e.element_selector, e.scroll_depth_pct, e.metadata,
                s.visitor_token, s.entry_url, s.utm_source, s.utm_medium, s.referrer,
                s.pageviews_count, COALESCE(s.duration_seconds, 0)::int AS duration_seconds
         FROM mkt_web_events e
         INNER JOIN mkt_web_sessions s ON s.tenant_id = e.tenant_id AND s.id = e.session_id
         WHERE ${whereSql}
         ORDER BY e.created_at DESC
         LIMIT 1000`,
        params
      );

      const visitorsSet = new Set<string>();
      const entrancesSet = new Set<string>();
      const bouncesSet = new Set<string>();
      const eventAgg = new Map<string, { type: string; target: string; count: number }>();
      const srcAgg = new Map<string, { source: string; medium: string; sessionsSet: Set<string> }>();
      let totalViews = 0;
      let scrollSum = 0;
      let scrollCnt = 0;
      let durSum = 0;
      let durCnt = 0;

      for (const row of evRes.rows) {
        const vTok = String(row.visitor_token || row.session_id);
        visitorsSet.add(vTok);
        const meta = parseJson<Record<string, unknown>>(row.metadata, {});
        if (row.event_type === 'pageview' || row.event_type === 'pricing_intent') {
          totalViews += 1;
        }
        if (row.entry_url && row.page_url && row.entry_url === row.page_url) {
          entrancesSet.add(String(row.session_id));
          if (Number(row.pageviews_count || 0) <= 1 && Number(row.duration_seconds || 0) < 10) {
            bouncesSet.add(String(row.session_id));
          }
        }
        if (row.scroll_depth_pct !== null && Number(row.scroll_depth_pct) > 0) {
          scrollSum += Number(row.scroll_depth_pct);
          scrollCnt += 1;
        }
        const evDur = Number(meta.duration_seconds || 0);
        if (evDur > 0) {
          durSum += evDur;
          durCnt += 1;
        }
        if (!['pageview', 'ping', 'page_exit', 'scroll'].includes(String(row.event_type))) {
          const target = String(meta.text || row.element_selector || row.event_type);
          const k = `${row.event_type}|${target}`;
          const ex = eventAgg.get(k);
          if (ex) ex.count += 1;
          else eventAgg.set(k, { type: String(row.event_type), target, count: 1 });
        }
        const { source, medium } = deriveTrafficSource(row.utm_source, row.utm_medium, row.referrer);
        const sk = `${source.toLowerCase()}|${medium.toLowerCase()}`;
        const se = srcAgg.get(sk) || { source, medium, sessionsSet: new Set<string>() };
        se.sessionsSet.add(String(row.session_id));
        srcAgg.set(sk, se);
      }

      const entrances = entrancesSet.size;
      const bounces = bouncesSet.size;
      return {
        overview: {
          totalViews,
          uniqueVisitors: visitorsSet.size,
          avgTimeOnPage: durCnt > 0 ? Math.round(durSum / durCnt) : 0,
          avgScrollDepth: scrollCnt > 0 ? Math.round(scrollSum / scrollCnt) : 0,
          avgLoadTime: 0,
          entrances,
          bounces,
          bounceRate: entrances > 0 ? Number(((bounces / entrances) * 100).toFixed(1)) : 0,
        },
        events: Array.from(eventAgg.values())
          .sort((a, b) => b.count - a.count)
          .slice(0, 25),
        sources: Array.from(srcAgg.values())
          .map((s) => ({ source: s.source, medium: s.medium, sessions: s.sessionsSet.size }))
          .sort((a, b) => b.sessions - a.sessions),
      };
    });
    return void ok(res, data);
  }
  if (action === 'visitors' || action === 'visitor_journey') {
    const propertyId = String(id || qstr(req, 'property_id') || '').trim();
    const visitorId = qstr(req, 'visitor_id');

    if (visitorId) {
      const data = await tx(async (client, ctx) => {
        const sParams: unknown[] = [ctx.tenantId, visitorId];
        let sWhere = 's.tenant_id = $1 AND (s.id::text = $2 OR s.visitor_token = $2)';
        if (propertyId && isUuid(propertyId)) {
          sParams.push(propertyId);
          sWhere += ` AND s.property_id = $${sParams.length}`;
        }
        const sessRes = await client.query<{
          id: string;
          utm_source: string | null;
          utm_medium: string | null;
          referrer: string | null;
          duration_seconds: number;
          pageviews_count: number;
          started_at: string;
          last_seen_at: string;
        }>(
          `SELECT s.id, s.utm_source, s.utm_medium, s.referrer,
                  COALESCE(s.duration_seconds, 0)::int AS duration_seconds,
                  s.pageviews_count, s.started_at, s.last_seen_at
           FROM mkt_web_sessions s
           WHERE ${sWhere}
           ORDER BY s.last_seen_at DESC
           LIMIT 1`,
          sParams
        );
        const sess = sessRes.rows[0];
        if (!sess) {
          return {
            timeline: [],
            stats: { total_events: 0, page_views: 0, clicks: 0, canvas_clicks: 0, total_time: 0 },
          };
        }

        const eventsRes = await client.query(
          `SELECT e.* FROM mkt_web_events e
           WHERE e.tenant_id = $1 AND e.session_id = $2
           ORDER BY e.created_at DESC
           LIMIT 200`,
          [ctx.tenantId, sess.id]
        );

        const srcInfo = deriveTrafficSource(sess.utm_source, sess.utm_medium, sess.referrer);
        const sourceLabel = `${srcInfo.source} / ${srcInfo.medium}`;

        let pageViews = 0;
        let clicks = 0;
        let canvasClicks = 0;
        let durationFromEvents = 0;

        const timeline = eventsRes.rows.map((ev) => {
          const evType = String(ev.event_type || 'pageview');
          const meta = parseJson<Record<string, unknown>>(ev.metadata, {});
          if (evType === 'pageview' || evType === 'pricing_intent') pageViews += 1;
          else if (evType === 'click') clicks += 1;
          else if (evType === 'canvas_click') canvasClicks += 1;
          const evDur = Number(meta.duration_seconds || 0);
          if (evDur > 0 && Number.isFinite(evDur)) durationFromEvents += evDur;

          return {
            id: String(ev.id),
            type: evType,
            event_type: evType,
            url: String(ev.page_url || ''),
            page_url: String(ev.page_url || ''),
            page_title: String(meta.page_title || ev.page_url || ''),
            target:
              evType === 'scroll'
                ? String(ev.scroll_depth_pct ?? meta.percent ?? 0)
                : String(meta.text || ev.element_selector || ev.page_url || ''),
            target_text: String(meta.text || ev.element_selector || ''),
            element_selector: ev.element_selector ? String(ev.element_selector) : null,
            x_pct: ev.x_pct !== null && ev.x_pct !== undefined ? Number(ev.x_pct) : null,
            y_pct: ev.y_pct !== null && ev.y_pct !== undefined ? Number(ev.y_pct) : null,
            scroll_depth_pct:
              ev.scroll_depth_pct !== null && ev.scroll_depth_pct !== undefined ? Number(ev.scroll_depth_pct) : null,
            duration: evDur,
            source: sourceLabel,
            meta: {
              ...meta,
              ...(ev.scroll_depth_pct !== null && ev.scroll_depth_pct !== undefined
                ? { percent: Number(ev.scroll_depth_pct) }
                : {}),
              ...(ev.element_selector ? { element: String(ev.element_selector) } : {}),
            },
            time: ev.created_at,
            created_at: ev.created_at,
          };
        });

        const startedMs = sess.started_at ? new Date(String(sess.started_at)).getTime() : 0;
        const lastMs = sess.last_seen_at ? new Date(String(sess.last_seen_at)).getTime() : startedMs;
        const inferredDuration = Math.min(86400, Math.max(0, Math.round((lastMs - startedMs) / 1000)));
        const totalTime = Math.max(Number(sess.duration_seconds || 0), durationFromEvents, inferredDuration);

        return {
          timeline,
          stats: {
            total_events: timeline.length,
            page_views: Math.max(pageViews, Number(sess.pageviews_count || 0)),
            clicks,
            canvas_clicks: canvasClicks,
            total_time: totalTime,
          },
        };
      });
      return void ok(res, data);
    }

    if (propertyId && !isUuid(propertyId)) {
      return void ok(res, {
        visitors: [],
        live_count: 0,
        pagination: { page: 1, current_page: 1, limit: 20, total: 0, totalPages: 1, total_pages: 1, pages: 1 },
      });
    }

    const { page, limit, offset } = readPaging(req, 20, 200);
    const rawDevice = qstr(req, 'device').toLowerCase();
    const deviceFilter = rawDevice && rawDevice !== 'all' ? rawDevice : '';
    const q = qstr(req, 'q').trim().toLowerCase();
    const returningFilter = qstr(req, 'returning').trim().toLowerCase();

    const data = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const params: unknown[] = [ctx.tenantId];
      let whereSql = 's.tenant_id = $1';

      if (propertyId) {
        params.push(propertyId);
        whereSql += ` AND s.property_id = $${params.length}`;
      }
      if (deviceFilter) {
        params.push(deviceFilter);
        whereSql += ` AND LOWER(COALESCE(s.device_type, 'desktop')) = $${params.length}`;
      }
      if (returningFilter === 'returning') {
        whereSql += ` AND s.pageviews_count > 1`;
      } else if (returningFilter === 'identified') {
        whereSql += ` AND (s.lead_id IS NOT NULL OR l.email IS NOT NULL OR l.phone IS NOT NULL)`;
      }
      if (q) {
        params.push(`%${q}%`);
        const pIdx = `$${params.length}`;
        whereSql += ` AND (
          LOWER(COALESCE(l.name, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(l.email, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(l.phone, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(s.visitor_token, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(s.entry_url, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(s.last_url, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(s.geo_city, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(s.os, '')) LIKE ${pIdx}
          OR LOWER(COALESCE(s.browser, '')) LIKE ${pIdx}
        )`;
      }

      const liveParams: unknown[] = [ctx.tenantId];
      let liveWhere = `tenant_id = $1 AND last_seen_at >= (clock_timestamp() - INTERVAL '30 minutes')`;
      if (propertyId) {
        liveParams.push(propertyId);
        liveWhere += ` AND property_id = $${liveParams.length}`;
      }

      const [cntRes, rowsRes, liveRes, blRes] = await Promise.all([
        client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM mkt_web_sessions s
           LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
           WHERE ${whereSql}`,
          params
        ),
        client.query(
          `SELECT s.*,
                  l.name AS lead_name, l.email AS lead_email, l.phone AS lead_phone, l.lead_score,
                  (
                    SELECT e.metadata->>'client_ip'
                    FROM mkt_web_events e
                    WHERE e.tenant_id = s.tenant_id AND e.session_id = s.id AND e.metadata ? 'client_ip'
                    ORDER BY e.created_at DESC
                    LIMIT 1
                  ) AS client_ip
           FROM mkt_web_sessions s
           LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
           WHERE ${whereSql}
           ORDER BY s.last_seen_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        client.query<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM mkt_web_sessions WHERE ${liveWhere}`, liveParams),
        client.query<{ value: string }>(
          "SELECT value FROM blacklist_entries WHERE tenant_id = $1 AND entry_type = 'ip'",
          [ctx.tenantId]
        ),
      ]);

      const blockedSet = new Set(blRes.rows.map((b) => String(b.value || '').trim()).filter(Boolean));
      const visitors = rowsRes.rows.map((row) => {
        const masked = actor.mask({
          name: row.lead_name,
          email: row.lead_email,
          phone: row.lead_phone,
        });
        const ipAddr = row.client_ip ? String(row.client_ip).trim() : undefined;
        const pv = Math.max(1, Number(row.pageviews_count || 1));
        return {
          ...row,
          id: String(row.id),
          visitor_token: String(row.visitor_token || ''),
          subscriber_id: row.lead_id ? String(row.lead_id) : undefined,
          first_name: masked.name || undefined,
          email: masked.email || undefined,
          phone: masked.phone || undefined,
          phone_number: masked.phone || undefined,
          lead_score: row.lead_score !== null && row.lead_score !== undefined ? Number(row.lead_score) : undefined,
          first_visit_at: row.started_at,
          last_visit_at: row.last_seen_at,
          visit_count: pv,
          sessions: pv > 1 ? 2 : 1,
          device_type: String(row.device_type || 'desktop'),
          os: row.os || 'Unknown',
          browser: row.browser || 'Unknown',
          country: row.geo_country || 'VN',
          city: row.geo_city || undefined,
          ip_address: ipAddr,
          is_blocked: Boolean(ipAddr && blockedSet.has(ipAddr)),
        };
      });

      const total = Number(cntRes.rows[0]?.cnt || 0);
      const totalPages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
      return {
        visitors,
        live_count: Number(liveRes.rows[0]?.cnt || 0),
        pagination: {
          page,
          current_page: page,
          limit,
          total,
          totalPages,
          total_pages: totalPages,
          pages: totalPages,
        },
      };
    });
    return void ok(res, data);
  }
  if (action === 'retention') {
    const propertyId = String(id || qstr(req, 'property_id') || '').trim();
    const rawDevice = qstr(req, 'device').toLowerCase();
    const deviceFilter = rawDevice && rawDevice !== 'all' ? rawDevice : '';
    const data = await tx(async (client, ctx) => {
      const params: unknown[] = [ctx.tenantId];
      let whereSql = 'tenant_id = $1';
      if (propertyId && isUuid(propertyId)) {
        params.push(propertyId);
        whereSql += ` AND property_id = $${params.length}`;
      }
      if (deviceFilter) {
        params.push(deviceFilter);
        whereSql += ` AND LOWER(COALESCE(device_type, 'desktop')) = $${params.length}`;
      }
      const r = await client.query<{ total: number; returning_cnt: number }>(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(CASE WHEN pageviews_count > 1 THEN 1 ELSE 0 END), 0)::int AS returning_cnt
         FROM mkt_web_sessions WHERE ${whereSql}`,
        params
      );
      const total = Number(r.rows[0]?.total || 0);
      const returning = Number(r.rows[0]?.returning_cnt || 0);
      return { total_sessions: total, returning_sessions: returning, retention_pct: total > 0 ? Math.round((returning / total) * 100) : 0 };
    });
    return void ok(res, data);
  }

  return void bridge(marketingRouter, '/web-tracking')(req, res, next);
});

marketingPhpBridgesRouter.all(
  ['/web_tracking', '/automation/web_tracking', '/automation/web_tracking.php', '/web_tracking.php'],
  requirePermission('mkt_web_tracking', 'view'),
  handleWebTrackingCompat
);

marketingPhpBridgesRouter.all(
  ['/web_blacklist', '/automation/web_blacklist', '/automation/web_blacklist.php', '/web_blacklist.php'],
  requirePermission('mkt_web_tracking', 'view'),
  handler('COMPAT_WEB_BLACKLIST', async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const action = reqAction(req);
    if (method === 'GET' && action !== 'add' && action !== 'delete') {
      const items = await tx(async (client, ctx) => {
        const r = await client.query(
          "SELECT id, value AS ip, value AS ip_address, reason, created_at FROM blacklist_entries WHERE tenant_id = $1 AND entry_type = 'ip' ORDER BY created_at DESC",
          [ctx.tenantId]
        );
        return r.rows;
      });
      return void ok(res, { items });
    }
    if (method === 'DELETE' || action === 'delete') {
      if (!(await ensureCompatPermission(req, res, 'mkt_web_tracking', 'delete'))) return;
      const target = String(
        phpId(req) || qstr(req, 'ip') || qstr(req, 'ip_address') || req.body?.ip || req.body?.ip_address || ''
      ).trim();
      if (!target) return void fail(res, 422, 'IP_OR_ID_REQUIRED', 'Thiếu IP hoặc ID cần gỡ khỏi blacklist.');
      await tx(async (client, ctx) => {
        await client.query(
          "DELETE FROM blacklist_entries WHERE tenant_id = $1 AND entry_type = 'ip' AND (id::text = $2 OR value = $2)",
          [ctx.tenantId, target]
        );
        tenantRedis.invalidateBlacklistCache(ctx.tenantId);
      });
      return void ok(res, { deleted: true });
    }
    if (!(await ensureCompatPermission(req, res, 'mkt_web_tracking', 'create'))) return;
    const ip = bstr(req.body, 'ip', 'ip_address', 'value');
    if (!ip) return void fail(res, 422, 'IP_REQUIRED', 'Vui lòng nhập địa chỉ IP cần chặn.');
    const reason = bstr(req.body, 'reason') || 'Manual Web Blacklist';
    const created = await tx(async (client, ctx) => {
      const id = crypto.randomUUID();
      const r = await client.query(
        `INSERT INTO blacklist_entries (id, tenant_id, entry_type, value, reason, created_by)
         VALUES ($1, $2, 'ip', $3, $4, $5)
         ON CONFLICT (tenant_id, entry_type, value) DO UPDATE SET reason = EXCLUDED.reason
         RETURNING id, value AS ip, value AS ip_address, reason, created_at`,
        [id, ctx.tenantId, ip, reason, ctx.userId]
      );
      tenantRedis.invalidateBlacklistCache(ctx.tenantId);
      return r.rows[0] || { id, ip, ip_address: ip, reason };
    });
    ok(res, created, '', 201);
  })
);

// ---- E. Zalo OA, Zalo Audience, Meta Customers, Zalo Broadcast ----
marketingPhpBridgesRouter.all(
  ['/zalo_oa', '/automation/zalo_oa', '/automation/zalo_oa.php', '/zalo_oa.php'],
  requirePermission('mkt_social_bot', 'view'),
  handler('COMPAT_ZALO_OA', async (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    const route = reqRoute(req);
    const id = phpId(req);

    if (method === 'DELETE') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
      if (id && !isUuid(id)) return void fail(res, 404, 'ZALO_OA_NOT_FOUND', 'Không tìm thấy cấu hình Zalo OA.');
      await tx(async (client, ctx) => {
        if (id && isUuid(id)) {
          await client.query('DELETE FROM mkt_zalo_oa_configs WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
        } else {
          await client.query('DELETE FROM mkt_zalo_oa_configs WHERE tenant_id = $1', [ctx.tenantId]);
        }
        await client.query(
          "UPDATE tenant_integrations SET status = 'disconnected', updated_at = clock_timestamp() WHERE tenant_id = $1 AND integration_type IN ('zalo_oa', 'zalo_zns')",
          [ctx.tenantId]
        );
      });
      return void ok(res, { deleted: true });
    }

    if (route === 'generate-auth-url') {
      const info = await tx(async (client, ctx) => {
        const r = await client.query<{ app_id: string; oa_id: string }>(
          'SELECT app_id, oa_id FROM mkt_zalo_oa_configs WHERE tenant_id = $1 LIMIT 1',
          [ctx.tenantId]
        );
        const appId = String(req.body?.app_id || r.rows[0]?.app_id || process.env.ZALO_APP_ID || 'domation_zalo_app').trim();
        const redirectUri = encodeURIComponent(
          String(req.body?.redirect_uri || `${req.protocol}://${req.get('host')}/api/v1/integrations/zalo/callback`)
        );
        const state = `${ctx.tenantId}_${crypto.randomBytes(6).toString('hex')}`;
        return {
          auth_url: `https://oauth.zaloapp.com/v4/oa/permission?app_id=${encodeURIComponent(appId)}&redirect_uri=${redirectUri}&state=${encodeURIComponent(state)}`,
          app_id: appId,
          state,
        };
      });
      return void ok(res, info);
    }

    if (route === 'refresh-token') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
      const ctx = getTenantContext();
      const out = await refreshExpiringZaloTokens(ctx.tenantId);
      return void ok(res, out);
    }

    if (route === 'list') {
      const list = await tx(async (client, ctx) => {
        const r = await client.query(
          'SELECT * FROM mkt_zalo_oa_configs WHERE tenant_id = $1 ORDER BY created_at DESC',
          [ctx.tenantId]
        );
        if (r.rows.length > 0) {
          return r.rows.map((row) => {
            const settings = parseJson<Record<string, unknown>>(row.settings_json, {});
            return {
              ...row,
              id: String(row.id),
              oa_id: String(row.oa_id || ''),
              name: String(row.oa_name || 'Zalo Official Account'),
              oa_name: String(row.oa_name || 'Zalo Official Account'),
              avatar: settings.avatar_url ? String(settings.avatar_url) : settings.avatar ? String(settings.avatar) : '',
              settings,
            };
          });
        }
        const intRes = await client.query<{ status: string }>(
          `SELECT status FROM tenant_integrations
           WHERE tenant_id = $1 AND integration_type IN ('zalo_oa', 'zalo_zns') AND status = 'active'
           LIMIT 1`,
          [ctx.tenantId]
        );
        if (intRes.rows[0]) {
          return [
            {
              id: 'default-zalo-oa',
              oa_id: '',
              name: 'Zalo Official Account',
              oa_name: 'Zalo Official Account',
              status: 'connected',
              daily_quota: 1000,
              sent_today: 0,
              quality_rating: 'high',
              avatar: '',
            },
          ];
        }
        return [];
      });
      return void ok(res, list);
    }

    if (route === 'quota') {
      const qData = await tx(async (client, ctx) => {
        const r = await client.query('SELECT oa_id, daily_quota, sent_today, quality_rating FROM mkt_zalo_oa_configs WHERE tenant_id = $1 LIMIT 1', [
          ctx.tenantId,
        ]);
        return r.rows[0] || { daily_quota: 1000, sent_today: 0, quality_rating: 'high' };
      });
      return void ok(res, qData);
    }

    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
      return void bridge(marketingRouter, '/social-bot/zalo-oa', { method: 'PUT' })(req, res, next);
    }
    return void bridge(marketingRouter, '/social-bot/zalo-oa')(req, res, next);
  })
);

marketingPhpBridgesRouter.all(
  ['/meta_customers', '/automation/meta_customers', '/automation/meta_customers.php', '/meta_customers.php'],
  requirePermission('mkt_social_bot', 'view'),
  handler('COMPAT_META_CUSTOMERS', async (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    const route = reqRoute(req);
    const id = phpId(req);
    if (route === 'user_details' && id) {
      if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy khách hàng Meta.');
      return void bridge(marketingRouter, `/social-bot/conversations/${encodeURIComponent(id)}`)(req, res, next);
    }
    if (route === 'update_user' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy khách hàng Meta.');
      await tx(async (client, ctx) => {
        await client.query(
          `UPDATE mkt_social_conversations
           SET customer_name = COALESCE($3, customer_name),
               extracted_phone = COALESCE($4, extracted_phone),
               extracted_email = COALESCE($5, extracted_email)
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            id,
            req.body?.name ? String(req.body.name) : null,
            req.body?.phone ? String(req.body.phone) : null,
            req.body?.email ? String(req.body.email) : null,
          ]
        );
      });
      return void ok(res, { updated: true, id });
    }
    if (method === 'POST') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'create'))) return;
      return void bridge(marketingRouter, '/social-bot/conversations')(req, res, next);
    }
    const data = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const r = await client.query(
        "SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = 'messenger' ORDER BY last_message_at DESC LIMIT 100",
        [ctx.tenantId]
      );
      const items = r.rows.map((row) => actor.mask({ ...row, phone: row.extracted_phone, email: row.extracted_email }));
      return { items, total: items.length };
    });
    ok(res, data);
  })
);

marketingPhpBridgesRouter.all(
  ['/zalo_audience', '/automation/zalo_audience', '/automation/zalo_audience.php', '/zalo_audience.php'],
  requirePermission('mkt_social_bot', 'view'),
  handler('COMPAT_ZALO_AUDIENCE', async (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    const route = reqRoute(req);
    const id = phpId(req);

    if (method === 'DELETE') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
      if (!id || !isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy khách hàng Zalo.');
      await tx(async (client, ctx) => {
        await client.query('DELETE FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      });
      return void ok(res, { deleted: true, id });
    }
    if (route === 'user_details' && id) {
      if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy khách hàng Zalo.');
      return void bridge(marketingRouter, `/social-bot/conversations/${encodeURIComponent(id)}`)(req, res, next);
    }
    if (route === 'update_user' && id) {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy khách hàng Zalo.');
      await tx(async (client, ctx) => {
        await client.query(
          `UPDATE mkt_social_conversations
           SET customer_name = COALESCE($3, customer_name),
               extracted_phone = COALESCE($4, extracted_phone),
               extracted_email = COALESCE($5, extracted_email)
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, id, req.body?.name || null, req.body?.phone || null, req.body?.email || null]
        );
      });
      return void ok(res, { updated: true, id });
    }
    if (route === 'send_zbs') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
      const phone = bstr(req.body, 'phone');
      if (!phone) return void fail(res, 422, 'PHONE_REQUIRED', 'Thiếu số điện thoại nhận tin Zalo ZBS/ZNS.');
      const resZns = await tx(async (client, ctx) =>
        dispatchZnsNotification({
          tenantId: ctx.tenantId,
          client,
          phone,
          templateId: req.body?.template_id ? String(req.body.template_id) : null,
          templateData: req.body?.template_data || {},
          message: bstr(req.body, 'message'),
        })
      );
      return void ok(res, resZns);
    }
    if (route === 'upload_image') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'create'))) return;
      const asset = await tx(async (client, ctx) => {
        const assetId = crypto.randomUUID();
        const url = bstr(req.body, 'url') || `https://cdn.domation.net/zalo/${assetId}.png`;
        await client.query(
          `INSERT INTO mkt_media_assets (id, tenant_id, folder_name, file_name, mime_type, url, created_by)
           VALUES ($1, $2, 'zalo', $3, 'image/png', $4, $5)`,
          [assetId, ctx.tenantId, bstr(req.body, 'file_name') || `${assetId}.png`, url, ctx.userId]
        );
        return { id: assetId, url };
      });
      return void ok(res, asset, '', 201);
    }
    if (route === 'lists') {
      const data = await tx(async (client, ctx) => {
        const actor = await resolvePiiActor(client, ctx);
        const r = await client.query(
          "SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = 'zalo_oa' ORDER BY last_message_at DESC LIMIT 100",
          [ctx.tenantId]
        );
        const items = r.rows.map((row) => actor.mask({ ...row, phone: row.extracted_phone, email: row.extracted_email }));
        return { items, total: items.length };
      });
      return void ok(res, data);
    }
    if (method === 'POST') {
      if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'create'))) return;
      return void bridge(marketingRouter, '/social-bot/conversations')(req, res, next);
    }
    return void bridge(marketingRouter, '/social-bot?channel=zalo_oa')(req, res, next);
  })
);

marketingPhpBridgesRouter.delete(
  '/zalo_broadcast',
  requirePermission('mkt_campaigns', 'delete'),
  handler('COMPAT_ZALO_BROADCAST_DELETE', async (req, res) => {
    const id = phpId(req);
    if (!isUuid(id)) return void fail(res, 404, 'CAMPAIGN_NOT_FOUND', 'Không tìm thấy chiến dịch Zalo.');
    await tx(async (client, ctx) => {
      await client.query("DELETE FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 AND channel = 'zns'", [ctx.tenantId, id]);
    });
    ok(res, { deleted: true, id });
  })
);

marketingPhpBridgesRouter.all(
  ['/automation/zalo_stats.php', '/zalo_stats.php', '/zalo_report'],
  requirePermission('mkt_social_bot', 'view'),
  handler('COMPAT_ZALO_STATS', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [oaRes, tplRes, convRes] = await Promise.all([
        client.query('SELECT daily_quota, sent_today, quality_rating FROM mkt_zalo_oa_configs WHERE tenant_id = $1 LIMIT 1', [ctx.tenantId]),
        client.query<{ sent: number; delivered: number }>(
          'SELECT COALESCE(SUM(sent_count), 0)::int AS sent, COALESCE(SUM(delivered_count), 0)::int AS delivered FROM mkt_zalo_templates WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
        client.query<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = 'zalo_oa'", [
          ctx.tenantId,
        ]),
      ]);
      return {
        oa: oaRes.rows[0] || { daily_quota: 1000, sent_today: 0, quality_rating: 'high' },
        sent_count: Number(tplRes.rows[0]?.sent || 0),
        delivered_count: Number(tplRes.rows[0]?.delivered || 0),
        conversations_count: Number(convRes.rows[0]?.cnt || 0),
      };
    });
    ok(res, data);
  })
);

// ---- F. AI Chatbot, Scenarios, Training, Reports, Org Chatbot ----
marketingPhpBridgesRouter.get(
  '/ai_chatbot_slug',
  requirePermission('mkt_social_bot', 'view'),
  handler('COMPAT_AI_CHATBOT_SLUG', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [tRes, bRes] = await Promise.all([
        client.query<{ slug: string }>('SELECT slug FROM tenants WHERE id = $1 LIMIT 1', [ctx.tenantId]),
        client.query<{ bot_name: string }>('SELECT bot_name FROM mkt_ai_bot_configs WHERE tenant_id = $1 LIMIT 1', [ctx.tenantId]),
      ]);
      return {
        slug: tRes.rows[0]?.slug || ctx.tenantSlug || 'assistant',
        bot_name: bRes.rows[0]?.bot_name || 'DOM Agent CSKH',
      };
    });
    ok(res, data);
  })
);

const handleAiChatbotCompat = handler('COMPAT_AI_CHATBOT', async (req, res, next) => {
  const action = reqAction(req);
  const id = String(phpId(req) || qstr(req, 'conversation_id') || (req.body as Record<string, unknown> | undefined)?.conversation_id || '').trim();

  if (action === 'list_categories' || action === 'list') {
    return void bridge(marketingRouter, '/social-bot?channel=web_chat', { method: 'GET' })(req, res, next);
  }
  if (action === 'get_available_pages') {
    const pages = await tx(async (client, ctx) => {
      const r = await client.query('SELECT id, name, domain, site_key, is_active FROM mkt_web_properties WHERE tenant_id = $1 ORDER BY created_at DESC', [
        ctx.tenantId,
      ]);
      return r.rows;
    });
    return void ok(res, pages);
  }
  if (action === 'list_conversations') {
    const channel = qstr(req, 'channel');
    const items = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const params: unknown[] = [ctx.tenantId];
      let sql = 'SELECT * FROM mkt_social_conversations WHERE tenant_id = $1';
      if (channel && ['messenger', 'zalo_oa', 'web_chat'].includes(channel)) {
        params.push(channel);
        sql += ` AND channel = $${params.length}`;
      }
      sql += ' ORDER BY last_message_at DESC LIMIT 100';
      const r = await client.query(sql, params);
      return r.rows.map((row) => actor.mask({ ...row, phone: row.extracted_phone, email: row.extracted_email }));
    });
    return void ok(res, { items, conversations: items });
  }
  if ((action === 'get_conversation' || action === 'get_messages') && id) {
    if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
    return void bridge(marketingRouter, `/social-bot/conversations/${encodeURIComponent(id)}`, { method: 'GET' })(req, res, next);
  }
  if (action === 'send_human_reply' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
    const content = bstr(req.body, 'content', 'message');
    if (!content) return void fail(res, 422, 'CONTENT_REQUIRED', 'Vui lòng nhập nội dung phản hồi.');
    const msg = await tx(async (client, ctx) => {
      const convRes = await client.query('SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      const conv = convRes.rows[0];
      if (!conv) return null;
      if (conv.channel === 'messenger' && conv.external_thread_id) {
        await sendMetaMessengerMessage({
          tenantId: ctx.tenantId,
          client,
          recipientPsid: String(conv.external_thread_id),
          text: content,
        });
      }
      const msgId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
         VALUES ($1, $2, $3, 'agent', $4, $5, '{}'::jsonb)`,
        [msgId, ctx.tenantId, id, ctx.userName || 'Chuyên viên CSKH', content]
      );
      await client.query(
        'UPDATE mkt_social_conversations SET last_message_preview = $3, unread_count = 0, last_message_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id, content.slice(0, 200)]
      );
      return { id: msgId, conversation_id: id, content, sender_type: 'agent' };
    });
    if (!msg) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
    return void ok(res, msg, '', 201);
  }
  if (action === 'update_status' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
    return void bridge(marketingRouter, `/social-bot/conversations/${encodeURIComponent(id)}`, { method: 'PATCH' })(req, res, next);
  }
  if (action === 'update_visitor_info' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
    await tx(async (client, ctx) => {
      await client.query(
        `UPDATE mkt_social_conversations
         SET customer_name = COALESCE($3, customer_name),
             extracted_phone = COALESCE($4, extracted_phone),
             extracted_email = COALESCE($5, extracted_email)
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id, req.body?.name || null, req.body?.phone || null, req.body?.email || null]
      );
    });
    return void ok(res, { updated: true, id });
  }
  if (action === 'delete_conversation' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy hội thoại.');
    await tx(async (client, ctx) => {
      await client.query('DELETE FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    return void ok(res, { deleted: true, id });
  }
  if (action === 'export_conversations') {
    const items = await tx(async (client, ctx) => {
      const r = await client.query('SELECT * FROM mkt_social_conversations WHERE tenant_id = $1 ORDER BY last_message_at DESC LIMIT 200', [
        ctx.tenantId,
      ]);
      return r.rows;
    });
    return void ok(res, { items });
  }
  if (action === 'delete_analysis') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
    return void ok(res, { deleted: true });
  }
  if (action === 'analyze_segment' || action === 'get_last_analysis' || action === 'export_word') {
    const stats = await tx(async (client, ctx) => {
      const r = await client.query<{ total: number }>(
        'SELECT COUNT(*)::int AS total FROM mkt_social_conversations WHERE tenant_id = $1',
        [ctx.tenantId]
      );
      return { total_conversations: Number(r.rows[0]?.total || 0), summary: 'Phân tích hội thoại đa kênh hoàn tất.' };
    });
    return void ok(res, stats);
  }

  if (String(req.method || 'GET').toUpperCase() === 'POST') {
    return void bridge(marketingRouter, '/social-bot/bot-test')(req, res, next);
  }
  return void bridge(marketingRouter, '/social-bot')(req, res, next);
});

marketingPhpBridgesRouter.all(
  ['/ai_chatbot', '/automation/ai_chatbot', '/automation/ai_chatbot.php', '/ai_chatbot.php'],
  requirePermission('mkt_social_bot', 'view'),
  handleAiChatbotCompat
);

const handleAiScenariosCompat = handler('COMPAT_AI_SCENARIOS', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const action = reqAction(req);
  const id = phpId(req);

  if (action === 'list' || (!action && method === 'GET')) {
    return void bridge(marketingRouter, '/social-bot/scenarios', { method: 'GET' })(req, res, next);
  }
  if (action === 'create') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'create'))) return;
    return void bridge(marketingRouter, '/social-bot/scenarios', { method: 'POST' })(req, res, next);
  }
  if (action === 'update' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
    return void bridge(marketingRouter, `/social-bot/scenarios/${encodeURIComponent(id)}`, { method: 'PUT' })(req, res, next);
  }
  if (action === 'delete' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
    return void bridge(marketingRouter, `/social-bot/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' })(req, res, next);
  }
  if (action === 'toggle' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
    const updated = await tx(async (client, ctx) => {
      const r = await client.query(
        `UPDATE mkt_automation_scenarios
         SET is_active = NOT is_active, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [ctx.tenantId, id]
      );
      return r.rows[0] || null;
    });
    if (!updated) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
    return void ok(res, updated);
  }
  if (action === 'toggle_global') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    const isActive = Boolean(req.body?.is_active ?? true);
    await tx(async (client, ctx) => {
      await client.query('UPDATE mkt_ai_bot_configs SET is_active = $2, updated_at = clock_timestamp() WHERE tenant_id = $1', [
        ctx.tenantId,
        isActive,
      ]);
    });
    return void ok(res, { is_active: isActive });
  }
  if (action === 'clone' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'create'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
    const cloned = await tx(async (client, ctx) => {
      const r = await client.query('SELECT * FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      const src = r.rows[0];
      if (!src) return null;
      const newId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_automation_scenarios (
           id, tenant_id, name, channel, trigger_type, keywords_json, nodes_json, edges_json, settings_json, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, false, $10)`,
        [
          newId,
          ctx.tenantId,
          `${src.name} (Bản sao)`,
          src.channel,
          src.trigger_type,
          JSON.stringify(parseJson(src.keywords_json, [])),
          JSON.stringify(parseJson(src.nodes_json, [])),
          JSON.stringify(parseJson(src.edges_json, [])),
          JSON.stringify(parseJson(src.settings_json, {})),
          ctx.userId,
        ]
      );
      const fresh = await client.query('SELECT * FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, newId]);
      return fresh.rows[0];
    });
    if (!cloned) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
    return void ok(res, cloned, '', 201);
  }
  if (action === 'reorder') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    return void ok(res, { reordered: true });
  }

  if (method === 'DELETE') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
  } else if (method === 'PUT' || method === 'PATCH') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
  } else if (method === 'POST') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', id ? 'edit' : 'create'))) return;
  }
  if (id && !isUuid(id)) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');

  return void bridge(marketingRouter, id ? `/social-bot/scenarios/${encodeURIComponent(id)}` : '/social-bot/scenarios')(
    req,
    res,
    next
  );
});

marketingPhpBridgesRouter.all(
  ['/ai_scenarios', '/automation/ai_scenarios', '/automation/ai_scenarios.php', '/ai_scenarios.php'],
  requirePermission('mkt_social_bot', 'view'),
  handleAiScenariosCompat
);

const handleAiTrainingCompat = handler('COMPAT_AI_TRAINING', async (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const action = reqAction(req);
  const id = phpId(req);

  if (action === 'get_upload_limit') {
    return void res.json({
      success: true,
      upload_max_filesize: '25MB',
      data: {
        max_mb: 25,
        max_docs: 500,
        upload_max_filesize: '25MB',
        allowed_types: ['faq', 'pdf', 'url', 'policy', 'product'],
      },
    });
  }
  if (action === 'list_properties') {
    const properties = await tx(async (client, ctx) => {
      const out = await resolveAiTrainingPropertiesWithStats(client, ctx.tenantId);
      return out.properties;
    });
    return void ok(res, properties);
  }
  if (action === 'list_docs' || (!action && method === 'GET')) {
    const filterProp = qstr(req, 'property_id');
    const searchQ = qstr(req, 'search').toLowerCase();
    const payload = await tx(async (client, ctx) => {
      const [{ resolveDocPropertyId }, docsRes] = await Promise.all([
        resolveAiTrainingPropertiesWithStats(client, ctx.tenantId),
        client.query(
          'SELECT * FROM mkt_ai_training_docs WHERE tenant_id = $1 ORDER BY updated_at DESC',
          [ctx.tenantId]
        ),
      ]);

      const normalizedPropFilter = filterProp && filterProp !== 'all' ? filterProp.toLowerCase() : '';
      const mapped = docsRes.rows
        .map((row) => {
          const meta = parseJson<Record<string, unknown>>(row.metadata_json, {});
          const rawPropId = String(meta.property_id ?? meta.propertyId ?? row.property_id ?? '').trim();
          const resolvedPid = resolveDocPropertyId(row);
          const tagsStr = Array.isArray(meta.tags)
            ? meta.tags.map(String).join(', ')
            : typeof meta.tags === 'string'
              ? meta.tags
              : '';
          const rawStatus = String(row.status || 'trained').toLowerCase();
          return {
            ...row,
            name: String(row.title || ''),
            content: String(row.content_text || ''),
            source_type: String(row.doc_type || 'manual'),
            property_id: resolvedPid || rawPropId,
            legacy_property_id: rawPropId || null,
            status: rawStatus === 'indexed' ? 'trained' : rawStatus || 'trained',
            is_active: rawStatus !== 'inactive' && rawStatus !== 'disabled',
            priority: Number(meta.priority ?? 0),
            tags: tagsStr,
            metadata: meta,
          };
        })
        .filter((doc) => {
          if (normalizedPropFilter) {
            const pMatch =
              String(doc.property_id || '').toLowerCase() === normalizedPropFilter ||
              String(doc.legacy_property_id || '').toLowerCase() === normalizedPropFilter;
            if (!pMatch) return false;
          }
          if (searchQ) {
            const hay = `${doc.name} ${doc.content} ${doc.source_type} ${doc.tags}`.toLowerCase();
            if (!hay.includes(searchQ)) return false;
          }
          return true;
        });

      return { items: mapped, total: mapped.length };
    });
    return void ok(res, payload);
  }
  if (action === 'get_doc' && id) {
    if (!isUuid(id)) return void fail(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu.');
    const doc = await tx(async (client, ctx) => {
      const r = await client.query('SELECT * FROM mkt_ai_training_docs WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0] || null;
    });
    if (!doc) return void fail(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu.');
    return void ok(res, doc);
  }
  if (action === 'add_manual' || action === 'upload_training_file') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'create'))) return;
    return void bridge(marketingRouter, '/social-bot/training-docs', {
      method: 'POST',
      mapBody: (b) => {
        const baseMeta = b?.metadata && typeof b.metadata === 'object' ? (b.metadata as Record<string, unknown>) : {};
        return {
          title: b?.title || b?.name || b?.file_name || 'Tài liệu huấn luyện AI',
          content_text: b?.content_text || b?.content || b?.text || 'Nội dung tài liệu',
          doc_type: b?.doc_type || b?.source_type || 'faq',
          source_url: b?.source_url || null,
          metadata: {
            ...baseMeta,
            ...(b?.property_id ? { property_id: String(b.property_id) } : {}),
            ...(b?.tags !== undefined ? { tags: b.tags } : {}),
          },
        };
      },
    })(req, res, next);
  }
  if (action === 'update_doc' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu.');
    return void bridge(marketingRouter, `/social-bot/training-docs/${encodeURIComponent(id)}`, { method: 'PUT' })(req, res, next);
  }
  if (action === 'delete_doc' && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu.');
    return void bridge(marketingRouter, `/social-bot/training-docs/${encodeURIComponent(id)}`, { method: 'DELETE' })(req, res, next);
  }
  if (action === 'delete_batch' || action === 'bulk_delete') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
    const ids: string[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((x: string) => isUuid(x));
    if (ids.length === 0) return void ok(res, { deleted_count: 0 });
    const deleted = await tx(async (client, ctx) => {
      const ph = ids.map((_, i) => `$${i + 2}`).join(', ');
      const r = await client.query(`DELETE FROM mkt_ai_training_docs WHERE tenant_id = $1 AND id IN (${ph})`, [
        ctx.tenantId,
        ...ids,
      ]);
      return Number(r.rowCount || 0);
    });
    return void ok(res, { deleted_count: deleted });
  }
  if (action === 'toggle_batch' || action === 'train_docs') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    const ids: string[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((x: string) => isUuid(x));
    const nextStatus = action === 'train_docs' ? 'trained' : String(req.body?.status || 'trained');
    const updated = await tx(async (client, ctx) => {
      if (ids.length === 0) {
        const r = await client.query(
          'UPDATE mkt_ai_training_docs SET status = $2, updated_at = clock_timestamp() WHERE tenant_id = $1',
          [ctx.tenantId, nextStatus]
        );
        return Number(r.rowCount || 0);
      }
      const ph = ids.map((_, i) => `$${i + 3}`).join(', ');
      const r = await client.query(
        `UPDATE mkt_ai_training_docs SET status = $2, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id IN (${ph})`,
        [ctx.tenantId, nextStatus, ...ids]
      );
      return Number(r.rowCount || 0);
    });
    return void ok(res, { updated_count: updated, status: nextStatus });
  }
  if ((action === 'update_tags' || action === 'update_priority') && id) {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    if (!isUuid(id)) return void fail(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu.');
    const found = await tx(async (client, ctx) => {
      const r = await client.query('SELECT metadata_json FROM mkt_ai_training_docs WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      if (!r.rows[0]) return false;
      const meta = parseJson<Record<string, unknown>>(r.rows[0]?.metadata_json, {});
      const nextMeta = {
        ...meta,
        ...(req.body?.tags ? { tags: req.body.tags } : {}),
        ...(req.body?.priority !== undefined ? { priority: req.body.priority } : {}),
      };
      await client.query(
        'UPDATE mkt_ai_training_docs SET metadata_json = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id, JSON.stringify(nextMeta)]
      );
      return true;
    });
    if (!found) return void fail(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu.');
    return void ok(res, { updated: true, id });
  }
  if (action === 'create_folder') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'create'))) return;
    return void ok(res, { id: crypto.randomUUID(), name: bstr(req.body, 'name') || 'Thư mục mới' }, '', 201);
  }
  if (action === 'get_settings') {
    return void bridge(marketingRouter, '/social-bot', {
      method: 'GET',
      transform: (payload: any) => ({ success: true, data: payload?.data?.bot_config || {} }),
    })(req, res, next);
  }
  if (action === 'update_settings') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    return void bridge(marketingRouter, '/social-bot/bot-config', { method: 'PUT' })(req, res, next);
  }
  if (action === 'list_all_chatbots') {
    const rows = await tx(async (client, ctx) => {
      const r = await client.query('SELECT id, bot_name, is_active FROM mkt_ai_bot_configs WHERE tenant_id = $1', [ctx.tenantId]);
      return r.rows;
    });
    return void ok(res, rows);
  }
  if (action === 'get_pdf_progress') {
    return void ok(res, { progress: 100, status: 'completed' });
  }
  if (action === 'auto_learn_synonyms' || action === 'toggle_workspace') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
    return void ok(res, { ok: true });
  }

  if (method === 'DELETE') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
  } else if (method === 'PUT' || method === 'PATCH') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'edit'))) return;
  } else if (method === 'POST') {
    if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', id ? 'edit' : 'create'))) return;
  }
  if (id && !isUuid(id)) return void fail(res, 404, 'DOC_NOT_FOUND', 'Không tìm thấy tài liệu.');

  return void bridge(marketingRouter, id ? `/social-bot/training-docs/${encodeURIComponent(id)}` : '/social-bot/training-docs')(
    req,
    res,
    next
  );
});

marketingPhpBridgesRouter.all(
  ['/ai_training', '/automation/ai_training', '/automation/ai_training.php', '/ai_training.php'],
  requirePermission('mkt_social_bot', 'view'),
  handleAiTrainingCompat
);

marketingPhpBridgesRouter.all(
  ['/automation/ai_report.php', '/ai_report.php', '/ai_report'],
  requirePermission('mkt_social_bot', 'view'),
  handler('COMPAT_AI_REPORT', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [convRes, msgRes, docRes] = await Promise.all([
        client.query<{ total: number; routed: number }>(
          `SELECT COUNT(*)::int AS total,
                  COALESCE(SUM(CASE WHEN lead_id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS routed
           FROM mkt_social_conversations WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ sender_type: string; cnt: number }>(
          'SELECT sender_type, COUNT(*)::int AS cnt FROM mkt_social_messages WHERE tenant_id = $1 GROUP BY sender_type',
          [ctx.tenantId]
        ),
        client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM mkt_ai_training_docs WHERE tenant_id = $1', [ctx.tenantId]),
      ]);
      const msgBySender: Record<string, number> = {};
      for (const m of msgRes.rows) msgBySender[String(m.sender_type)] = Number(m.cnt || 0);
      return {
        stats: {
          total_conversations: Number(convRes.rows[0]?.total || 0),
          captured_leads: Number(convRes.rows[0]?.routed || 0),
          bot_messages: msgBySender.bot || 0,
          customer_messages: msgBySender.customer || 0,
          training_docs: Number(docRes.rows[0]?.cnt || 0),
        },
        chart: [],
        summary: `Bot đã xử lý ${msgBySender.bot || 0} tin nhắn trên ${Number(convRes.rows[0]?.total || 0)} hội thoại.`,
      };
    });
    ok(res, data);
  })
);

marketingPhpBridgesRouter.all(
  ['/automation/ai_org_chatbot', '/automation/ai_org_chatbot.php', '/ai_org_chatbot'],
  (req, res, next) => bridge(domAgentRouter, '/threads')(req, res, next)
);

marketingPhpBridgesRouter.all(
  ['/automation/ai_org_auth', '/automation/ai_org_auth.php', '/ai_org_auth'],
  handler('COMPAT_AI_ORG_AUTH', async (_req, res) => {
    const info = await tx(async (client, ctx) => {
      const r = await client.query('SELECT id, full_name, email, role FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        ctx.userId,
      ]);
      return r.rows[0] || { id: ctx.userId, full_name: ctx.userName, email: ctx.userEmail, role: ctx.userRole };
    });
    ok(res, info);
  })
);

marketingPhpBridgesRouter.all(
  ['/automation/ai_org_users.php', '/ai_org_users.php'],
  requirePermission('settings', 'view'),
  handler('COMPAT_AI_ORG_USERS', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      const r = await client.query(
        `SELECT u.id, u.full_name, u.email, u.role, COALESCE(p.status, 'active') AS status
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         WHERE u.tenant_id = $1 AND u.is_system_bot = false
         ORDER BY u.full_name ASC
         LIMIT 200`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    ok(res, { items });
  })
);

// ---- G. SocialBot Automation Scenarios (`meta_automation.php` & `zalo_automation.php`), Meta Report, Email Editor & Utility PHP Bridges ----
function mapScenarioCompatRow(row: Record<string, unknown>, channel: 'messenger' | 'zalo_oa') {
  const keywords = parseJson<string[]>(row.keywords_json, []);
  const nodes = parseJson<Array<Record<string, unknown>>>(row.nodes_json, []);
  const edges = parseJson<Array<Record<string, unknown>>>(row.edges_json, []);
  const settings = parseJson<Record<string, unknown>>(row.settings_json, {});
  const firstNode = nodes[0] as Record<string, unknown> | undefined;
  const firstNodeCfg =
    firstNode && typeof firstNode.config === 'object' && firstNode.config
      ? (firstNode.config as Record<string, unknown>)
      : {};
  const content = String(settings.content ?? firstNodeCfg.message ?? firstNodeCfg.text ?? firstNodeCfg.content ?? '');
  const triggerText =
    typeof settings.trigger_text === 'string' && settings.trigger_text.trim()
      ? settings.trigger_text
      : keywords.join(', ');
  const isActive = Boolean(row.is_active);
  const configId =
    channel === 'messenger'
      ? String(settings.meta_config_id || '')
      : String(settings.oa_config_id || '');

  return {
    id: String(row.id),
    name: String(row.name || ''),
    title: String(row.name || ''),
    channel: String(row.channel || channel),
    type: String(row.trigger_type || 'keyword'),
    trigger_type: String(row.trigger_type || 'keyword'),
    trigger_text: triggerText,
    keywords,
    match_type: String(settings.match_type || 'contains'),
    content,
    message_type: String(settings.message_type || firstNodeCfg.message_type || 'text'),
    image_url: String(settings.image_url || firstNodeCfg.image_url || ''),
    attachment_id: String(settings.attachment_id || firstNodeCfg.attachment_id || ''),
    buttons: Array.isArray(settings.buttons)
      ? settings.buttons
      : Array.isArray(firstNodeCfg.buttons)
        ? firstNodeCfg.buttons
        : [],
    status: isActive ? 'active' : 'inactive',
    is_active: isActive,
    ai_chatbot_id: String(settings.ai_chatbot_id || ''),
    ai_bot_name: String(settings.ai_bot_name || ''),
    schedule_type: String(settings.schedule_type || 'full'),
    start_time: String(settings.start_time || '00:00:00'),
    end_time: String(settings.end_time || '23:59:59'),
    active_days: String(settings.active_days || '1,2,3,4,5,6,0'),
    priority_override: Number(settings.priority_override || 0),
    holiday_start_at: String(settings.holiday_start_at || ''),
    holiday_end_at: String(settings.holiday_end_at || ''),
    meta_config_id: channel === 'messenger' ? configId : String(settings.meta_config_id || ''),
    oa_config_id: channel === 'zalo_oa' ? configId : String(settings.oa_config_id || ''),
    nodes,
    edges,
    settings,
    matched_count: Number(row.matched_count || 0),
    converted_count: Number(row.converted_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createChannelAutomationCompatHandler(channel: 'messenger' | 'zalo_oa') {
  const configField = channel === 'messenger' ? 'meta_config_id' : 'oa_config_id';
  return handler(
    channel === 'messenger' ? 'COMPAT_META_AUTOMATION' : 'COMPAT_ZALO_AUTOMATION',
    async (req, res) => {
      const method = String(req.method || 'GET').toUpperCase();
      const route = reqRoute(req);
      const id = phpId(req);

      if (route === 'delete' || method === 'DELETE') {
        if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', 'delete'))) return;
        if (!id || !isUuid(id)) {
          return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản tự động.');
        }
        await tx(async (client, ctx) => {
          await client.query(
            'DELETE FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2 AND channel = $3',
            [ctx.tenantId, id, channel]
          );
        });
        return void ok(res, { deleted: true, id });
      }

      if (route === 'check_conflicts') {
        const cfgId = qstr(req, configField) || String((req.body as Record<string, unknown> | undefined)?.[configField] || '').trim();
        const scenType = (qstr(req, 'type') || bstr(req.body, 'type', 'trigger_type') || 'keyword').toLowerCase();
        const triggerText = qstr(req, 'trigger_text') || bstr(req.body, 'trigger_text');
        const excludeId = id && isUuid(id) ? id : '';

        const conflicts = await tx(async (client, ctx) => {
          const params: unknown[] = [ctx.tenantId, channel];
          let sql = `SELECT id, name, trigger_type, keywords_json, settings_json
                     FROM mkt_automation_scenarios
                     WHERE tenant_id = $1 AND channel = $2 AND is_active = true`;
          if (excludeId) {
            params.push(excludeId);
            sql += ` AND id != $${params.length}`;
          }
          const r = await client.query(sql, params);
          const found: string[] = [];
          const incomingKws = triggerText
            .split(',')
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean);

          for (const row of r.rows) {
            const st = parseJson<Record<string, unknown>>(row.settings_json, {});
            const rowCfgId = String(st[configField] || '').trim();
            if (cfgId && rowCfgId && rowCfgId !== cfgId) continue;

            const rowType = String(row.trigger_type || '').toLowerCase();
            if (['welcome', 'first_message', 'ai_reply'].includes(scenType) && rowType === scenType) {
              found.push(`Đã tồn tại kịch bản "${row.name}" cùng loại kích hoạt đang hoạt động.`);
              break;
            }
            if (scenType === 'keyword' && rowType === 'keyword' && incomingKws.length > 0) {
              const existingKws = parseJson<string[]>(row.keywords_json, []).map((k) => String(k || '').trim().toLowerCase());
              const dup = incomingKws.find((k) => existingKws.includes(k));
              if (dup) {
                found.push(`Từ khóa "${dup}" bị trùng với kịch bản "${row.name}".`);
                break;
              }
            }
          }
          return found;
        });

        res.json({ success: true, conflicts, data: { conflicts } });
        return;
      }

      if (route === 'stats' && id) {
        if (!isUuid(id)) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
        const stats = await tx(async (client, ctx) => {
          const r = await client.query(
            'SELECT id, name, matched_count, converted_count, created_at, updated_at FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2 AND channel = $3 LIMIT 1',
            [ctx.tenantId, id, channel]
          );
          const row = r.rows[0];
          if (!row) return null;
          return {
            id: String(row.id),
            title: String(row.name || ''),
            matched_count: Number(row.matched_count || 0),
            converted_count: Number(row.converted_count || 0),
            total_sent: Number(row.matched_count || 0),
            total_clicks: Number(row.converted_count || 0),
            chart: [],
            updated_at: row.updated_at,
          };
        });
        if (!stats) return void fail(res, 404, 'SCENARIO_NOT_FOUND', 'Không tìm thấy kịch bản.');
        return void ok(res, stats);
      }

      if (route === 'save' || method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const isUpdate = Boolean(id && isUuid(id));
        if (!(await ensureCompatPermission(req, res, 'mkt_social_bot', isUpdate ? 'edit' : 'create'))) return;

        const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
        const title = bstr(b, 'title', 'name');
        if (!title) {
          return void fail(res, 422, 'SCENARIO_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề kịch bản.');
        }

        const triggerType = bstr(b, 'type', 'trigger_type') || 'keyword';
        const rawTriggerText = String(b.trigger_text ?? '').trim();
        const keywords: string[] = Array.isArray(b.keywords)
          ? b.keywords.map((x) => String(x || '').trim()).filter(Boolean)
          : rawTriggerText
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean);
        const content = String(b.content ?? b.reply_text ?? '').trim();
        const messageType = String(b.message_type || 'text').trim();
        const imageUrl = String(b.image_url || '').trim();
        const attachmentId = String(b.attachment_id || '').trim();
        const buttons = Array.isArray(b.buttons) ? b.buttons : [];
        const isActive =
          b.status !== undefined
            ? String(b.status).trim().toLowerCase() !== 'inactive'
            : b.is_active !== undefined
              ? Boolean(b.is_active)
              : true;

        const nodes =
          Array.isArray(b.nodes) && b.nodes.length > 0
            ? b.nodes
            : [
                {
                  id: 'reply_1',
                  type: triggerType === 'ai_reply' ? 'ai_reply' : 'message',
                  config: {
                    message: content,
                    message_type: messageType,
                    image_url: imageUrl,
                    attachment_id: attachmentId,
                    buttons,
                  },
                },
              ];
        const edges = Array.isArray(b.edges) ? b.edges : [];
        const baseSettings =
          b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings)
            ? (b.settings as Record<string, unknown>)
            : {};
        const settings: Record<string, unknown> = {
          ...baseSettings,
          meta_config_id: String(b.meta_config_id ?? baseSettings.meta_config_id ?? '').trim(),
          oa_config_id: String(b.oa_config_id ?? baseSettings.oa_config_id ?? '').trim(),
          trigger_text: rawTriggerText || keywords.join(', '),
          match_type: String(b.match_type || baseSettings.match_type || 'contains'),
          content,
          message_type: messageType,
          image_url: imageUrl,
          attachment_id: attachmentId,
          buttons,
          ai_chatbot_id: String(b.ai_chatbot_id ?? baseSettings.ai_chatbot_id ?? '').trim(),
          ai_bot_name: String(b.ai_bot_name ?? baseSettings.ai_bot_name ?? '').trim(),
          schedule_type: String(b.schedule_type || baseSettings.schedule_type || 'full'),
          start_time: String(b.start_time || baseSettings.start_time || '00:00:00'),
          end_time: String(b.end_time || baseSettings.end_time || '23:59:59'),
          active_days: String(b.active_days || baseSettings.active_days || '1,2,3,4,5,6,0'),
          priority_override: Number(b.priority_override ?? baseSettings.priority_override ?? 0),
          holiday_start_at: String(b.holiday_start_at ?? baseSettings.holiday_start_at ?? ''),
          holiday_end_at: String(b.holiday_end_at ?? baseSettings.holiday_end_at ?? ''),
        };

        const saved = await tx(async (client, ctx) => {
          if (isUpdate) {
            const upd = await client.query(
              `UPDATE mkt_automation_scenarios
               SET name = $3,
                   trigger_type = $4,
                   keywords_json = $5::jsonb,
                   nodes_json = $6::jsonb,
                   edges_json = $7::jsonb,
                   settings_json = $8::jsonb,
                   is_active = $9,
                   updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2 AND channel = $10
               RETURNING *`,
              [
                ctx.tenantId,
                id,
                title,
                triggerType,
                JSON.stringify(keywords),
                JSON.stringify(nodes),
                JSON.stringify(edges),
                JSON.stringify(settings),
                isActive,
                channel,
              ]
            );
            if (upd.rows[0]) return { created: false, row: mapScenarioCompatRow(upd.rows[0], channel) };
          }

          const newId = isUpdate ? id : crypto.randomUUID();
          await client.query(
            `INSERT INTO mkt_automation_scenarios (
               id, tenant_id, name, channel, trigger_type, keywords_json, nodes_json, edges_json, settings_json, is_active, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)`,
            [
              newId,
              ctx.tenantId,
              title,
              channel,
              triggerType,
              JSON.stringify(keywords),
              JSON.stringify(nodes),
              JSON.stringify(edges),
              JSON.stringify(settings),
              isActive,
              ctx.userId,
            ]
          );
          const fresh = await client.query(
            'SELECT * FROM mkt_automation_scenarios WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [ctx.tenantId, newId]
          );
          return { created: true, row: mapScenarioCompatRow(fresh.rows[0], channel) };
        });

        return void ok(res, saved.row, '', saved.created ? 201 : 200);
      }

      // Default / route === 'list': List scenarios filtered by channel (+ optional meta_config_id / oa_config_id)
      const configFilter = qstr(req, configField);
      const list = await tx(async (client, ctx) => {
        const params: unknown[] = [ctx.tenantId, channel];
        let whereSql = 'tenant_id = $1 AND channel = $2';
        if (configFilter) {
          params.push(configFilter);
          whereSql += ` AND (COALESCE(settings_json->>'${configField}', '') = '' OR settings_json->>'${configField}' = $${params.length})`;
        }
        const r = await client.query(
          `SELECT * FROM mkt_automation_scenarios
           WHERE ${whereSql}
           ORDER BY updated_at DESC
           LIMIT 200`,
          params
        );
        return r.rows.map((row) => mapScenarioCompatRow(row, channel));
      });
      return void ok(res, list);
    }
  );
}

marketingPhpBridgesRouter.all(
  ['/automation/meta_automation.php', '/meta_automation.php', '/meta_automation'],
  requirePermission('mkt_social_bot', 'view'),
  createChannelAutomationCompatHandler('messenger')
);

marketingPhpBridgesRouter.all(
  ['/automation/zalo_automation.php', '/zalo_automation.php', '/zalo_automation'],
  requirePermission('mkt_social_bot', 'view'),
  createChannelAutomationCompatHandler('zalo_oa')
);

marketingPhpBridgesRouter.all(
  ['/automation/meta_report.php', '/meta_report.php'],
  requireAnyPermission([
    ['ads_capi', 'view'],
    ['dashboard_marketing', 'view'],
    ['reports_bi', 'view'],
  ]),
  handler('COMPAT_META_PHP', async (req, res) => {
    const data = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      return buildMetaAdsOverviewInTx(
        client,
        ctx.tenantId,
        {
          ad_account_id: qstr(req, 'ad_account_id') || undefined,
          date_range: qstr(req, 'date_range') || undefined,
        },
        (row) => actor.mask(row)
      );
    });
    ok(res, data);
  })
);

marketingPhpBridgesRouter.all(
  ['/automation/email_sections.php', '/automation/timer.php', '/automation/video_thumb.php', '/automation/img_ratio.php', '/automation/list_images.php', '/automation/list_images'],
  requirePermission('mkt_templates', 'view'),
  handler('COMPAT_EMAIL_EDITOR_ASSETS', async (_req, res) => {
    const assets = await tx(async (client, ctx) => {
      const r = await client.query('SELECT * FROM mkt_media_assets WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100', [
        ctx.tenantId,
      ]);
      return r.rows;
    });
    ok(res, { items: assets, images: assets });
  })
);

marketingPhpBridgesRouter.all(
  ['/automation/approvals.php', '/automation/approvals'],
  (req, res, next) => bridge(approvalsRouter, '/')(req, res, next)
);

marketingPhpBridgesRouter.all(
  ['/automation/segment_ai_analysis.php', '/automation/segment_ai_analysis', '/automation/ai_email_generator.php', '/automation/ai_email_generator'],
  requirePermission('mkt_templates', 'view'),
  handler('COMPAT_AI_HELPERS', async (req, res, next) => {
    if (req.path.includes('ai_email_generator')) {
      return void bridge(marketingRouter, '/templates/ai-generate', { method: 'POST' })(req, res, next);
    }
    ok(res, { summary: 'Phân tích phân khúc AI sẵn sàng.', recommendations: [] });
  })
);

marketingPhpBridgesRouter.all(
  ['/automation/voucher_import_mapping.php', '/automation/check_file_matches.php', '/automation/worker_priority.php', '/automation/meta_upload.php'],
  requirePermission('dashboard_marketing', 'view'),
  handler('COMPAT_UTILITY_PHP', async (_req, res) => {
    ok(res, { ok: true, items: [] });
  })
);

// ---- H. Real DB Implementations for Previously Broken / No-Op Stubs ----
marketingPhpBridgesRouter.put(
  '/template_groups/:id',
  requirePermission('mkt_templates', 'edit'),
  handler('COMPAT_TEMPLATE_GROUP_UPDATE', async (req, res) => {
    if (!isUuid(req.params.id)) return void fail(res, 404, 'GROUP_NOT_FOUND', 'Không tìm thấy nhóm mẫu Email.');
    const updated = await tx(async (client, ctx) => {
      const r = await client.query(
        `UPDATE mkt_template_groups
         SET name = COALESCE($3, name),
             description = COALESCE($4, description),
             color_hex = COALESCE($5, color_hex),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          req.body?.name ? String(req.body.name).trim() : null,
          req.body?.description !== undefined ? String(req.body.description) : null,
          req.body?.color_hex ? String(req.body.color_hex).trim() : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) return void fail(res, 404, 'GROUP_NOT_FOUND', 'Không tìm thấy nhóm mẫu Email.');
    ok(res, updated);
  })
);

export const updateCustomEventHandler = handler('COMPAT_CUSTOM_EVENT_UPDATE', async (req, res) => {
  const route = reqRoute(req);
  const id = String(req.params.id || phpId(req) || '').trim();
  if (!isUuid(id)) return void fail(res, 404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện.');
  const updated = await tx(async (client, ctx) => {
    if (route === 'toggle_status') {
      const r = await client.query(
        `UPDATE mkt_custom_events SET is_active = NOT is_active, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [ctx.tenantId, id]
      );
      return r.rows[0] || null;
    }
    const r = await client.query(
      `UPDATE mkt_custom_events
       SET event_name = COALESCE($3, event_name),
           description = COALESCE($4, description),
           schema_json = COALESCE($5::jsonb, schema_json),
           is_active = COALESCE($6, is_active),
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [
        ctx.tenantId,
        id,
        req.body?.event_name ? String(req.body.event_name).trim() : null,
        req.body?.description !== undefined ? String(req.body.description) : null,
        req.body?.schema_json ? JSON.stringify(req.body.schema_json) : null,
        req.body?.is_active !== undefined ? Boolean(req.body.is_active) : null,
      ]
    );
    return r.rows[0] || null;
  });
  if (!updated) return void fail(res, 404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện.');
  ok(res, updated);
});

marketingPhpBridgesRouter.put('/custom_events/:id', requirePermission('mkt_forms', 'edit'), updateCustomEventHandler);
marketingPhpBridgesRouter.put('/purchase_events/:id', requirePermission('mkt_forms', 'edit'), updateCustomEventHandler);

marketingPhpBridgesRouter.all(
  ['/automation/custom_events.php', '/automation/purchase_events.php', '/custom_events.php', '/purchase_events.php'],
  requirePermission('mkt_forms', 'view'),
  handler('COMPAT_CUSTOM_EVENTS_PHP', async (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    const route = reqRoute(req);
    const id = phpId(req);

    if (method === 'PUT' || method === 'PATCH' || (method === 'POST' && (route === 'toggle_status' || route === 'update'))) {
      if (!(await ensureCompatPermission(req, res, 'mkt_forms', 'edit'))) return;
      return void updateCustomEventHandler(req, res, next);
    }
    if (method === 'DELETE') {
      if (!(await ensureCompatPermission(req, res, 'mkt_forms', 'delete'))) return;
      if (!isUuid(id)) return void fail(res, 404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện.');
      return void bridge(marketingRouter, `/forms/events/${encodeURIComponent(id)}`, { method: 'DELETE' })(req, res, next);
    }
    if (method === 'POST') {
      if (!(await ensureCompatPermission(req, res, 'mkt_forms', 'create'))) return;
      return void bridge(marketingRouter, '/forms/events', { method: 'POST' })(req, res, next);
    }
    if (id) {
      if (!isUuid(id)) return void fail(res, 404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện.');
      return void bridge(marketingRouter, `/forms/events/${encodeURIComponent(id)}`, { method: 'GET' })(req, res, next);
    }
    return void bridge(marketingRouter, '/forms', { method: 'GET' })(req, res, next);
  })
);

// OTP Profiles (`mkt_custom_events` with `event_category = 'otp'`)
function mapOtpProfileRow(r: Record<string, unknown>) {
  const schema = parseJson<Record<string, unknown>>(r.schema_json, {});
  return {
    ...r,
    name: String(r.event_name || ''),
    token_length: Number(schema.token_length ?? 6),
    ttl_seconds: Number(schema.ttl_seconds ?? 300),
    channel: String(schema.channel || 'email'),
    schema_json: schema,
  };
}

marketingPhpBridgesRouter.get(
  ['/otp_profiles', '/automation/otp_profiles', '/automation/otp_profiles.php', '/otp_profiles.php'],
  requirePermission('mkt_forms', 'view'),
  handler('COMPAT_OTP_PROFILES_LIST', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [profilesRes, otpStatsRes] = await Promise.all([
        client.query(
          "SELECT * FROM mkt_custom_events WHERE tenant_id = $1 AND event_category = 'otp' ORDER BY created_at DESC",
          [ctx.tenantId]
        ),
        client.query<{ total: number; verified: number }>(
          `SELECT COUNT(*)::int AS total,
                  COALESCE(SUM(CASE WHEN verified = true THEN 1 ELSE 0 END), 0)::int AS verified
           FROM mkt_otp_verifications WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
      ]);
      const items = profilesRes.rows.map(mapOtpProfileRow);
      return {
        items,
        profiles: items,
        otp_stats: otpStatsRes.rows[0] || { total: 0, verified: 0 },
      };
    });
    ok(res, data);
  })
);

marketingPhpBridgesRouter.post(
  ['/otp_profiles', '/automation/otp_profiles', '/automation/otp_profiles.php', '/otp_profiles.php'],
  requirePermission('mkt_forms', 'create'),
  handler('COMPAT_OTP_PROFILES_CREATE', async (req, res) => {
    const name = bstr(req.body, 'event_name', 'name') || 'OTP Profile';
    const key = bstr(req.body, 'event_key', 'key') || `otp_${crypto.randomBytes(4).toString('hex')}`;
    const baseSchema =
      req.body?.schema_json && typeof req.body.schema_json === 'object'
        ? req.body.schema_json
        : req.body?.config && typeof req.body.config === 'object'
          ? req.body.config
          : {};
    const schemaPayload = {
      ...baseSchema,
      channel: req.body?.channel || baseSchema.channel || 'email',
      ...(req.body?.token_length !== undefined ? { token_length: Number(req.body.token_length) } : {}),
      ...(req.body?.ttl_seconds !== undefined ? { ttl_seconds: Number(req.body.ttl_seconds) } : {}),
    };
    const created = await tx(async (client, ctx) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_custom_events (
           id, tenant_id, event_key, event_name, event_category, description, schema_json, is_active, created_by
         ) VALUES ($1, $2, $3, $4, 'otp', $5, $6::jsonb, true, $7)`,
        [
          id,
          ctx.tenantId,
          key,
          name,
          bstr(req.body, 'description') || null,
          JSON.stringify(schemaPayload),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_custom_events WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return r.rows[0] ? mapOtpProfileRow(r.rows[0]) : null;
    });
    ok(res, created, '', 201);
  })
);

marketingPhpBridgesRouter.put(
  ['/otp_profiles/:id', '/automation/otp_profiles/:id', '/automation/otp_profiles.php', '/otp_profiles.php'],
  requirePermission('mkt_forms', 'edit'),
  handler('COMPAT_OTP_PROFILES_UPDATE', async (req, res) => {
    const targetId = String(req.params.id || phpId(req) || '').trim();
    if (!isUuid(targetId)) return void fail(res, 404, 'OTP_PROFILE_NOT_FOUND', 'Không tìm thấy cấu hình OTP.');
    const updated = await tx(async (client, ctx) => {
      const r = await client.query(
        `UPDATE mkt_custom_events
         SET event_name = COALESCE($3, event_name),
             description = COALESCE($4, description),
             schema_json = COALESCE($5::jsonb, schema_json),
             is_active = COALESCE($6, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND event_category = 'otp'
         RETURNING *`,
        [
          ctx.tenantId,
          targetId,
          req.body?.event_name || req.body?.name || null,
          req.body?.description !== undefined ? String(req.body.description) : null,
          req.body?.schema_json || req.body?.config ? JSON.stringify(req.body.schema_json || req.body.config) : null,
          req.body?.is_active !== undefined ? Boolean(req.body.is_active) : null,
        ]
      );
      return r.rows[0] ? mapOtpProfileRow(r.rows[0]) : null;
    });
    if (!updated) return void fail(res, 404, 'OTP_PROFILE_NOT_FOUND', 'Không tìm thấy cấu hình OTP.');
    ok(res, updated);
  })
);

marketingPhpBridgesRouter.delete(
  ['/otp_profiles/:id', '/automation/otp_profiles/:id', '/automation/otp_profiles.php', '/otp_profiles.php'],
  requirePermission('mkt_forms', 'delete'),
  handler('COMPAT_OTP_PROFILES_DELETE', async (req, res) => {
    const targetId = String(req.params.id || phpId(req) || '').trim();
    if (!isUuid(targetId)) return void fail(res, 404, 'OTP_PROFILE_NOT_FOUND', 'Không tìm thấy cấu hình OTP.');
    await tx(async (client, ctx) => {
      await client.query("DELETE FROM mkt_custom_events WHERE tenant_id = $1 AND id = $2 AND event_category = 'otp'", [
        ctx.tenantId,
        targetId,
      ]);
    });
    ok(res, { deleted: true });
  })
);

// Integrations CRUD (`tenant_integrations` + `tenant_webhooks` — replacing broken `FROM connections` query!)
const handleIntegrationsList = handler('COMPAT_INTEGRATIONS_LIST', async (_req, res) => {
  const rows = await tx(async (client, ctx) => {
    const [intRes, whRes] = await Promise.all([
      client.query(
        'SELECT id, integration_type, status, token_expires_at, last_synced_at, created_at FROM tenant_integrations WHERE tenant_id = $1 ORDER BY created_at DESC',
        [ctx.tenantId]
      ),
      client.query(
        'SELECT id, name, webhook_type, url, is_active, created_at FROM tenant_webhooks WHERE tenant_id = $1 ORDER BY created_at DESC',
        [ctx.tenantId]
      ),
    ]);
    return [
      ...intRes.rows.map((r) => ({
        id: r.id,
        name: r.integration_type,
        type: r.integration_type,
        source_key: r.integration_type,
        status: r.status,
        is_active: r.status === 'active',
        created_at: r.created_at,
      })),
      ...whRes.rows.map((w) => ({
        id: w.id,
        name: w.name,
        type: `webhook_${w.webhook_type}`,
        source_key: w.url || w.webhook_type,
        status: w.is_active ? 'active' : 'inactive',
        is_active: Boolean(w.is_active),
        created_at: w.created_at,
      })),
    ];
  });
  ok(res, rows);
});

const handleIntegrationsSave = handler('COMPAT_INTEGRATIONS_SAVE', async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const route = reqRoute(req);
  if (route === 'fetch_headers' || route === 'preview_misa') {
    return void ok(res, { headers: ['name', 'phone', 'email'], preview: [] });
  }
  if (route === 'sync_now' || route === 'test_misa') {
    return void ok(res, { synced: true, count: 0 });
  }
  const integrationType = String(b.integration_type || b.type || 'google_sheets').trim();
  const payload = b.config && typeof b.config === 'object' ? (b.config as Record<string, unknown>) : b;

  const saved = await tx(async (client, ctx) => {
    const existing = await client.query<{ config_encrypted: string; iv: string; auth_tag: string }>(
      'SELECT config_encrypted, iv, auth_tag FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = $2 LIMIT 1',
      [ctx.tenantId, integrationType]
    );
    let prev: Record<string, unknown> = {};
    if (existing.rows[0]) {
      try {
        prev = decryptTenantSecret<Record<string, unknown>>(
          ctx.tenantId,
          existing.rows[0].config_encrypted,
          existing.rows[0].iv,
          existing.rows[0].auth_tag
        );
      } catch {}
    }
    const encrypted = encryptTenantSecret(ctx.tenantId, { ...prev, ...payload });
    await client.query(
      `INSERT INTO tenant_integrations (
         tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', clock_timestamp())
       ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
         config_encrypted = EXCLUDED.config_encrypted,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         status = 'active',
         last_synced_at = clock_timestamp()`,
      [ctx.tenantId, integrationType, encrypted.configEncrypted, encrypted.iv, encrypted.authTag]
    );
    tenantRedis.invalidateTenantIntegrations(ctx.tenantId, integrationType);
    return { integration_type: integrationType, status: 'active', saved: true };
  });
  ok(res, saved);
});

marketingPhpBridgesRouter.get(['/integrations', '/system_connections'], requirePermission('integrations_crm', 'view'), handleIntegrationsList);
marketingPhpBridgesRouter.post('/integrations', requirePermission('integrations_crm', 'manage_config'), handleIntegrationsSave);
marketingPhpBridgesRouter.put('/integrations', requirePermission('integrations_crm', 'manage_config'), handleIntegrationsSave);
marketingPhpBridgesRouter.delete(
  '/integrations',
  requirePermission('integrations_crm', 'manage_config'),
  handler('COMPAT_INTEGRATIONS_DELETE', async (req, res) => {
    const idOrType = phpId(req) || qstr(req, 'integration_type');
    if (!idOrType) return void fail(res, 422, 'ID_REQUIRED', 'Thiếu ID hoặc loại tích hợp.');
    await tx(async (client, ctx) => {
      await client.query(
        'DELETE FROM tenant_integrations WHERE tenant_id = $1 AND (id::text = $2 OR integration_type = $2)',
        [ctx.tenantId, idOrType]
      );
      await client.query('DELETE FROM tenant_webhooks WHERE tenant_id = $1 AND id::text = $2', [ctx.tenantId, idOrType]);
      tenantRedis.invalidateTenantIntegrations(ctx.tenantId);
    });
    ok(res, { deleted: true });
  })
);

// System Audit Logs (`admin_audit_logs`)
marketingPhpBridgesRouter.get(
  '/system_audit_logs',
  requirePermission('settings', 'view'),
  handler('COMPAT_SYSTEM_AUDIT_LOGS', async (req, res) => {
    const { page, limit, offset } = readPaging(req, 50, 200);
    const data = await tx(async (client, ctx) => {
      const [cntRes, rowsRes] = await Promise.all([
        client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM admin_audit_logs WHERE tenant_id = $1', [ctx.tenantId]),
        client.query(
          'SELECT * FROM admin_audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
          [ctx.tenantId, limit, offset]
        ),
      ]);
      return listPayload(rowsRes.rows, Number(cntRes.rows[0]?.cnt || 0), page, limit);
    });
    ok(res, data);
  })
);

// Media Assets Upload & Library (`mkt_media_assets`)
marketingPhpBridgesRouter.get(
  '/upload',
  requirePermission('mkt_templates', 'view'),
  handler('COMPAT_UPLOAD_LIBRARY', async (req, res) => {
    const route = reqRoute(req);
    if (route === 'delete') {
      if (!(await ensureCompatPermission(req, res, 'mkt_templates', 'delete'))) return;
      const fileRef = qstr(req, 'file') || phpId(req);
      await tx(async (client, ctx) => {
        await client.query(
          'DELETE FROM mkt_media_assets WHERE tenant_id = $1 AND (id::text = $2 OR file_name = $2 OR url = $2)',
          [ctx.tenantId, fileRef]
        );
      });
      return void ok(res, { deleted: true });
    }
    const { page, limit, offset } = readPaging(req, 20, 200);
    const data = await tx(async (client, ctx) => {
      const [cntRes, rowsRes] = await Promise.all([
        client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM mkt_media_assets WHERE tenant_id = $1', [ctx.tenantId]),
        client.query('SELECT * FROM mkt_media_assets WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [
          ctx.tenantId,
          limit,
          offset,
        ]),
      ]);
      return listPayload(rowsRes.rows, Number(cntRes.rows[0]?.cnt || 0), page, limit);
    });
    ok(res, data);
  })
);

marketingPhpBridgesRouter.post(
  '/upload',
  requirePermission('mkt_templates', 'view'),
  handler('COMPAT_UPLOAD_CREATE', async (req, res) => {
    const route = reqRoute(req);
    if (route === 'bulk_delete') {
      if (!(await ensureCompatPermission(req, res, 'mkt_templates', 'delete'))) return;
      const ids: string[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((x: string) => isUuid(x));
      if (ids.length === 0) return void ok(res, { deleted_count: 0 });
      const deleted = await tx(async (client, ctx) => {
        const ph = ids.map((_, i) => `$${i + 2}`).join(', ');
        const r = await client.query(`DELETE FROM mkt_media_assets WHERE tenant_id = $1 AND id IN (${ph})`, [
          ctx.tenantId,
          ...ids,
        ]);
        return Number(r.rowCount || 0);
      });
      return void ok(res, { deleted_count: deleted });
    }
    if (!(await ensureCompatPermission(req, res, 'mkt_templates', 'create'))) return;

    const fileName = bstr(req.body, 'file_name', 'name') || `asset_${crypto.randomBytes(4).toString('hex')}.png`;
    const folderName = bstr(req.body, 'folder_name', 'folder') || 'Chung';
    const mimeType = bstr(req.body, 'mime_type', 'type') || 'image/png';
    const rawUrl = bstr(req.body, 'url', 'data_url', 'content') || `https://cdn.domation.net/uploads/${fileName}`;

    const created = await tx(async (client, ctx) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_media_assets (
           id, tenant_id, folder_name, file_name, mime_type, url, size_bytes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.tenantId, folderName, fileName, mimeType, rawUrl, Number(req.body?.size_bytes || rawUrl.length), ctx.userId]
      );
      return { id, uniqueName: id, name: fileName, url: rawUrl, thumbUrl: rawUrl, uploaded: true };
    });
    ok(res, created, '', 201);
  })
);

marketingPhpBridgesRouter.post(
  '/delete_attachment',
  requirePermission('mkt_templates', 'delete'),
  handler('COMPAT_DELETE_ATTACHMENT', async (req, res) => {
    const fileRef = bstr(req.body, 'id', 'file', 'url', 'file_name') || phpId(req);
    if (!fileRef) return void ok(res, { deleted: false });
    const count = await tx(async (client, ctx) => {
      const r = await client.query(
        'DELETE FROM mkt_media_assets WHERE tenant_id = $1 AND (id::text = $2 OR file_name = $2 OR url = $2)',
        [ctx.tenantId, fileRef]
      );
      return Number(r.rowCount || 0);
    });
    ok(res, { deleted: count > 0 });
  })
);

// Bulk Import Process (`importRowsIntoAudience` / `upsertMasterContactInTx`)
marketingPhpBridgesRouter.post(
  '/import/process',
  requirePermission('audiences', 'create'),
  handler('COMPAT_IMPORT_PROCESS', async (req, res) => {
    const rows: Array<Record<string, any>> = Array.isArray(req.body?.rows)
      ? req.body.rows
      : Array.isArray(req.body?.contacts)
        ? req.body.contacts
        : [];
    const audienceId = String(req.body?.audience_id || req.body?.list_id || '').trim();
    if (rows.length === 0) return void ok(res, { imported: 0, created_count: 0, updated_count: 0 });

    if (isUuid(audienceId)) {
      const ctx = getTenantContext();
      const out = await importRowsIntoAudience(ctx.tenantId, audienceId, rows, { actorId: ctx.userId });
      return void ok(res, { imported: out.imported_count, ...out });
    }

    const reqCtx = getTenantContext();
    const cfg = await getTenantSettingsCached(reqCtx.tenantId);
    const out = await tx(async (client, ctx) => {
      let created = 0;
      let updated = 0;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        try {
          const resUpsert = await upsertMasterContactInTx(client, ctx.tenantId, row, {
            defaultStatus: 'marketing_nurture',
            defaultSource: 'Bulk Import',
            dialCode: cfg.default_dial_code,
          });
          if (resUpsert.created) created++;
          else updated++;
        } catch {}
      }
      return { imported: created + updated, created_count: created, updated_count: updated };
    });
    ok(res, out);
  })
);
