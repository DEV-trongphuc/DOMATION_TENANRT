import crypto from 'node:crypto';
import { Router } from 'express';
import { router as marketingRouter } from '../../modules/marketing/index.ts';
import { audiencesRouter } from '../../modules/audiences/index.ts';
import { router as erpOpsRouter } from '../../modules/erp-ops/index.ts';
import { orgRbacRouter } from '../../modules/org-rbac/index.ts';
import { integrationsRouter } from '../integrations.routes.ts';
import {
  flattenFlowCompatDetail,
  marketingPhpBridgesRouter,
  updateCustomEventHandler,
} from './marketing-php-bridges.ts';
import { getTenantMetaCached, getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { normalizeTenantSettings } from '../../core/settings/tenant-settings.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { decryptTenantSecret, encryptTenantSecret } from '../../core/crypto/vault.ts';
import {
  SAAS_MODULES_CATALOG,
  SAAS_PACKAGES_CATALOG,
  VALID_PACKAGE_CODES,
  resolveTenantEntitlementSnapshot,
} from '../../core/security/entitlements.ts';
import {
  isIdempotencyUniqueViolation,
  switchTenantSaasPackageInTx,
} from '../../services/billing.service.ts';
import { buildDynamicConditionSchemaRegistryInTx } from '../../services/condition-schema.service.ts';
import {
  buildMetaAdsOverviewInTx,
  deleteMetaAdAccount,
  discoverMetaTokenAssets,
  getMetaAdsConfigSummary,
  getMetaCapiDashboardConfig,
  syncMetaAdsAccounts,
  toggleMetaAdAccountStatus,
  upsertMetaAdAccount,
} from '../../services/meta-ads.service.ts';
import { extractMetaPageConfigs } from '../../services/meta-messenger.service.ts';

function safeParseObj(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) return val as Record<string, unknown>;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
  }
  return {};
}
import {
  bridge,
  fail,
  handler,
  listPayload,
  ok,
  qstr,
  requireAnyPermission,
  requirePermission,
  resolvePiiActor,
  tx,
} from './shared.ts';
import type { Request, RequestHandler, Response, NextFunction } from 'express';

export const marketingCompatRouter = Router();

function phpId(req: Request): string {
  const q = req.query?.id;
  const b = (req.body as Record<string, unknown> | undefined)?.id;
  return String(Array.isArray(q) ? q[0] : q ?? b ?? '').trim();
}

function isSegmentPreviewReq(req: Request): boolean {
  if (String(req.method || '').toUpperCase() !== 'POST') return false;
  const action = qstr(req, 'action').toLowerCase();
  const route = qstr(req, 'route').toLowerCase();
  const bodyAction = String((req.body as Record<string, unknown> | undefined)?.action || '').trim().toLowerCase();
  return ['preview', 'estimate'].includes(action) || ['preview', 'estimate'].includes(route) || bodyAction === 'preview';
}

function forwardBridge(
  resolveTarget: (req: Request) => { router: Router; path: string; method?: string }
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const spec = resolveTarget(req);
    return bridge(spec.router, spec.path, spec.method ? { method: spec.method } : undefined)(req, res, next);
  };
}

function forwardMarketingResource(basePath: string, targetRouter: Router = marketingRouter, putAsPatch = false): void {
  const listPath = basePath.startsWith('/marketing/') ? basePath : `/marketing${basePath}`;
  const cleanBase = basePath.replace(/^\/marketing/, '') || '/';
  marketingCompatRouter.get(listPath, bridge(targetRouter, cleanBase));
  marketingCompatRouter.post(listPath, bridge(targetRouter, cleanBase));
  marketingCompatRouter.all(
    `${listPath}/:id`,
    forwardBridge((req) => {
      const m = String(req.method || 'GET').toUpperCase();
      const id = encodeURIComponent(String(req.params.id || ''));
      const prefix = cleanBase === '/' ? '' : cleanBase;
      return {
        router: targetRouter,
        path: `${prefix}/${id}`,
        method: putAsPatch && m === 'PUT' ? 'PATCH' : undefined,
      };
    })
  );
}

function normalizePackageUpgradeCode(raw: unknown): string {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  if (!key) return '';
  if (
    key === 'dom_erp' ||
    key === 'dom-erp' ||
    key === 'dom_erp_promax' ||
    key === 'promax' ||
    key === 'domation_crm_erp' ||
    key === 'enterprise' ||
    key === 'crm_erp_suite' ||
    key === 'crm_erp_bundle'
  ) {
    return 'domation_promax';
  }
  if (key === 'autodata' || key === 'data' || key === 'crm' || key === 'autodata_standard' || key === 'starter') {
    return 'autodata_crm';
  }
  if (key === 'growth' || key === 'autodata_growth') {
    return 'growth_combo';
  }
  if (key === 'marketing') {
    return 'marketing_standalone';
  }
  return key;
}

// ---- Full .php / ?route= / ?action= Marketing & AI Bridges ----
marketingCompatRouter.use(marketingPhpBridgesRouter);

// ---- Campaigns, Flows, Forms, Surveys, Templates, Vouchers, Web Tracking, Zalo OA ----
marketingCompatRouter.post('/campaigns/estimate-reach', bridge(marketingRouter, '/campaigns/estimate-reach'));
marketingCompatRouter.post('/campaigns/:id/pause', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/pause`));
marketingCompatRouter.post('/campaigns/:id/resume', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/resume`));
marketingCompatRouter.get('/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/detail`));
marketingCompatRouter.put('/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.delete('/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.post('/marketing-campaigns/send-quick-email', bridge(marketingRouter, '/campaigns/test-email'));
marketingCompatRouter.post('/quick_send_email', bridge(marketingRouter, '/campaigns/test-email'));
marketingCompatRouter.post('/send_test_email', bridge(marketingRouter, '/campaigns/test-email'));
marketingCompatRouter.get('/ses_quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/ses_quota.php', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/ses-quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/campaigns/ses-quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/marketing/ses_quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/marketing/ses-quota', bridge(marketingRouter, '/campaigns/ses-quota'));

marketingCompatRouter.get(
  '/marketing/flows/:id',
  bridge(marketingRouter, (req) => `/flows/${encodeURIComponent(String(req.params.id || ''))}`, {
    transform: flattenFlowCompatDetail,
  })
);
forwardMarketingResource('/flows');
forwardMarketingResource('/templates');
forwardMarketingResource('/forms');
forwardMarketingResource('/surveys');
forwardMarketingResource('/vouchers');

marketingCompatRouter.post('/marketing/campaigns/estimate-reach', bridge(marketingRouter, '/campaigns/estimate-reach'));
marketingCompatRouter.post('/marketing/campaigns/:id/pause', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/pause`));
marketingCompatRouter.post('/marketing/campaigns/:id/resume', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/resume`));
marketingCompatRouter.get('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/detail`));
marketingCompatRouter.put('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.patch('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.delete('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));

marketingCompatRouter.all(
  '/marketing/segments/:id',
  forwardBridge((req) => ({
    router: audiencesRouter,
    path: `/${encodeURIComponent(String(req.params.id || ''))}`,
    method: req.method === 'PUT' ? 'PATCH' : undefined,
  }))
);
marketingCompatRouter.all(
  '/marketing/lists/:id',
  forwardBridge((req) => ({
    router: audiencesRouter,
    path: `/${encodeURIComponent(String(req.params.id || ''))}`,
    method: req.method === 'PUT' ? 'PATCH' : undefined,
  }))
);
marketingCompatRouter.get('/marketing/links_qr', bridge(marketingRouter, '/vouchers'));
marketingCompatRouter.post('/marketing/links_qr', bridge(marketingRouter, '/vouchers/shortlinks'));
marketingCompatRouter.all('/marketing/zalo_templates', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.post('/marketing/zalo_broadcast', bridge(marketingRouter, '/social-bot/zalo-broadcast'));

marketingCompatRouter.get(
  '/flows/:id',
  bridge(marketingRouter, (req) => `/flows/${encodeURIComponent(String(req.params.id || ''))}`, {
    transform: flattenFlowCompatDetail,
  })
);
marketingCompatRouter.put('/flows/:id', bridge(marketingRouter, (req) => `/flows/${req.params.id}`));
marketingCompatRouter.delete('/flows/:id', bridge(marketingRouter, (req) => `/flows/${req.params.id}`));
marketingCompatRouter.get('/domation/flows', bridge(marketingRouter, '/flows'));

marketingCompatRouter.get('/forms', bridge(marketingRouter, '/forms'));
marketingCompatRouter.post(
  '/forms',
  forwardBridge((req) => {
    const id = phpId(req);
    if (id) return { router: marketingRouter, path: `/forms/${encodeURIComponent(id)}`, method: 'PUT' };
    return { router: marketingRouter, path: '/forms' };
  })
);
marketingCompatRouter.put(
  '/forms',
  forwardBridge((req) => {
    const id = phpId(req);
    return { router: marketingRouter, path: id ? `/forms/${encodeURIComponent(id)}` : '/forms', method: 'PUT' };
  })
);
marketingCompatRouter.delete(
  '/forms',
  forwardBridge((req) => {
    const id = phpId(req);
    return { router: marketingRouter, path: id ? `/forms/${encodeURIComponent(id)}` : '/forms', method: 'DELETE' };
  })
);
marketingCompatRouter.put('/forms/:id', bridge(marketingRouter, (req) => `/forms/${req.params.id}`));
marketingCompatRouter.post('/forms/:id', bridge(marketingRouter, (req) => `/forms/${req.params.id}`, { method: 'PUT' }));
marketingCompatRouter.delete('/forms/:id', bridge(marketingRouter, (req) => `/forms/${req.params.id}`));

marketingCompatRouter.get('/surveys', bridge(marketingRouter, '/surveys'));
marketingCompatRouter.post('/surveys', bridge(marketingRouter, '/surveys'));
marketingCompatRouter.get('/surveys/:id', bridge(marketingRouter, (req) => `/surveys/${req.params.id}/analytics`));
marketingCompatRouter.put('/surveys/:id', bridge(marketingRouter, (req) => `/surveys/${req.params.id}`));
marketingCompatRouter.post('/surveys/:id', bridge(marketingRouter, (req) => `/surveys/${req.params.id}`, { method: 'PUT' }));
marketingCompatRouter.delete('/surveys/:id', bridge(marketingRouter, (req) => `/surveys/${req.params.id}`));

marketingCompatRouter.get('/templates', bridge(marketingRouter, '/templates'));
marketingCompatRouter.post('/templates', bridge(marketingRouter, '/templates'));
marketingCompatRouter.get('/templates/:id', bridge(marketingRouter, (req) => `/templates/${req.params.id}`));
marketingCompatRouter.put('/templates', bridge(marketingRouter, (req) => `/templates/${qstr(req, 'id') || req.body?.id || ''}`));
marketingCompatRouter.put('/templates/:id', bridge(marketingRouter, (req) => `/templates/${req.params.id}`));
marketingCompatRouter.delete('/templates', bridge(marketingRouter, (req) => `/templates/${qstr(req, 'id') || req.body?.id || ''}`));
marketingCompatRouter.delete('/templates/:id', bridge(marketingRouter, (req) => `/templates/${req.params.id}`));
marketingCompatRouter.get('/template_groups', bridge(marketingRouter, '/templates'));
marketingCompatRouter.post('/template_groups', bridge(marketingRouter, '/templates/groups'));
marketingCompatRouter.delete('/template_groups/:id', bridge(marketingRouter, (req) => `/templates/groups/${req.params.id}`));

marketingCompatRouter.put('/segments/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`, { method: 'PATCH' }));
marketingCompatRouter.delete('/segments/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`));

marketingCompatRouter.put('/lists/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`, { method: 'PATCH' }));
marketingCompatRouter.delete('/lists/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`));

marketingCompatRouter.get('/voucher_campaigns', bridge(marketingRouter, '/vouchers'));
marketingCompatRouter.post('/voucher_campaigns', bridge(marketingRouter, '/vouchers'));
marketingCompatRouter.delete('/voucher_campaigns/:id', bridge(marketingRouter, (req) => `/vouchers/${req.params.id}`));
marketingCompatRouter.get('/domation/voucher_campaigns', bridge(marketingRouter, '/vouchers'));
marketingCompatRouter.get('/voucher_codes', bridge(marketingRouter, (req) => `/vouchers/${qstr(req, 'campaign_id') || 'all'}/codes`));
marketingCompatRouter.post('/voucher_codes', bridge(marketingRouter, (req) => `/vouchers/${req.body?.campaign_id || 'all'}/generate`));
marketingCompatRouter.post('/redeem_voucher', bridge(marketingRouter, '/vouchers/redeem'));

marketingCompatRouter.get('/links_qr', bridge(marketingRouter, '/vouchers'));
marketingCompatRouter.post('/links_qr', bridge(marketingRouter, '/vouchers/shortlinks'));
marketingCompatRouter.put('/links_qr', bridge(marketingRouter, (req) => `/vouchers/shortlinks/${qstr(req, 'id') || req.body?.id || ''}`));
marketingCompatRouter.delete('/links_qr', bridge(marketingRouter, (req) => `/vouchers/shortlinks/${qstr(req, 'id') || ''}`));

marketingCompatRouter.get('/zalo_templates', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.post('/zalo_templates', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.post('/zalo_broadcast', bridge(marketingRouter, '/social-bot/zalo-broadcast'));
marketingCompatRouter.get('/zalo_report', bridge(marketingRouter, '/overview'));

marketingCompatRouter.get('/custom_events', bridge(marketingRouter, '/forms'));
marketingCompatRouter.post('/custom_events', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.delete('/custom_events/:id', bridge(marketingRouter, (req) => `/forms/events/${req.params.id}`));
marketingCompatRouter.get('/purchase_events', bridge(marketingRouter, '/forms'));
marketingCompatRouter.post('/purchase_events', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.delete('/purchase_events/:id', bridge(marketingRouter, (req) => `/forms/events/${req.params.id}`));

const metaOverviewHandler = handler('COMPAT_META_ADS_OVERVIEW', async (req, res) => {
  const data = await tx(async (client, ctx) => {
    const actor = await resolvePiiActor(client, ctx);
    return buildMetaAdsOverviewInTx(
      client,
      ctx.tenantId,
      {
        ad_account_id: qstr(req, 'ad_account_id') || qstr(req, 'account_id') || undefined,
        date_range: qstr(req, 'date_range') || qstr(req, 'preset') || undefined,
        from_date: qstr(req, 'from_date') || qstr(req, 'since') || undefined,
        to_date: qstr(req, 'to_date') || qstr(req, 'until') || undefined,
        campaign_id: qstr(req, 'campaign_id') || undefined,
        owner_id: qstr(req, 'owner_id') || undefined,
      },
      (row) => actor.mask(row)
    );
  });
  ok(res, data);
});

const metaViewPerm = requireAnyPermission([
  ['ads_capi', 'view'],
  ['dashboard_crm', 'view'],
  ['dashboard_marketing', 'view'],
  ['reports_bi', 'view'],
]);
const metaConfigPerm = requireAnyPermission([
  ['ads_capi', 'manage_config'],
  ['settings', 'manage_config'],
]);

marketingCompatRouter.get('/marketing/meta/overview', metaViewPerm, metaOverviewHandler);
marketingCompatRouter.get('/meta/overview', metaViewPerm, metaOverviewHandler);

marketingCompatRouter.get(
  '/marketing/meta/ad-preview',
  metaViewPerm,
  handler('COMPAT_META_AD_PREVIEW', async (req, res) => {
    const adId = qstr(req, 'ad_id').trim();
    if (!adId) {
      fail(res, 400, 'MISSING_AD_ID', 'ad_id is required');
      return;
    }
    const preview = await tx(async (client, ctx) => {
      const r = await client.query<Record<string, unknown>>(
        `SELECT ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name, ad_account_id,
                thumbnail_url, image_url, story_id, creative_body, creative_title, optimization_goal,
                spend, impressions, clicks, meta_leads, date_start
         FROM meta_ads_insights
         WHERE tenant_id = $1 AND ad_id = $2
         ORDER BY CASE WHEN date_start IS NULL THEN 1 ELSE 0 END, date_start DESC
         LIMIT 1`,
        [ctx.tenantId, adId]
      );
      if (!r.rows[0]) {
        return {
          ad_id: adId,
          found: false,
          ad_name: '',
          creative_body: '',
          creative_title: '',
          thumbnail_url: null,
          image_url: null,
        };
      }
      const row = r.rows[0];
      return {
        found: true,
        ...row,
        leads_count: Number(row.meta_leads || 0),
        video_id: null,
        call_to_action: null,
        effective_status: 'ACTIVE',
      };
    });
    ok(res, preview);
  })
);

marketingCompatRouter.get(
  '/meta_config',
  handler('COMPAT_META_CONFIG_GET', async (_req, res) => {
    const data = await tx(async (client, ctx) => getMetaAdsConfigSummary(client, ctx.tenantId));
    ok(res, data);
  })
);

marketingCompatRouter.post(
  '/meta_config',
  metaConfigPerm,
  handler('COMPAT_META_CONFIG_SAVE', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const saved = await tx(async (client, ctx) => {
      const batch = Array.isArray(b.ad_accounts)
        ? b.ad_accounts
        : Array.isArray(b.accounts)
          ? b.accounts
          : null;
      if (batch) {
        let lastSummary = await getMetaAdsConfigSummary(client, ctx.tenantId);
        for (const item of batch) {
          if (!item || typeof item !== 'object') continue;
          const acc = item as Record<string, unknown>;
          const rawId = String(acc.ad_account_id ?? acc.account_id ?? '').trim();
          if (!rawId) continue;
          const resUpsert = await upsertMetaAdAccount(client, ctx.tenantId, {
            id: acc.id !== undefined ? String(acc.id) : undefined,
            name: acc.name !== undefined ? String(acc.name) : acc.account_name !== undefined ? String(acc.account_name) : undefined,
            ad_account_id: rawId,
            access_token: acc.access_token !== undefined ? String(acc.access_token) : undefined,
            pixel_id: acc.pixel_id !== undefined ? String(acc.pixel_id) : undefined,
            is_active: acc.is_active !== undefined ? Boolean(acc.is_active) : true,
          });
          if (!resUpsert.success) return resUpsert;
          if (resUpsert.summary) lastSummary = resUpsert.summary;
        }
        return { success: true, summary: lastSummary };
      }

      const rawAccountId = String(b.ad_account_id ?? b.account_id ?? '').trim();
      if (!rawAccountId) {
        const cur = await getMetaAdsConfigSummary(client, ctx.tenantId);
        return { success: true, summary: cur };
      }
      return upsertMetaAdAccount(client, ctx.tenantId, {
        id: b.id !== undefined ? String(b.id) : undefined,
        name: b.account_name !== undefined ? String(b.account_name) : b.name !== undefined ? String(b.name) : undefined,
        ad_account_id: rawAccountId,
        access_token: b.access_token !== undefined ? String(b.access_token) : undefined,
        pixel_id: b.pixel_id !== undefined ? String(b.pixel_id) : undefined,
        is_active: b.is_active !== undefined ? Boolean(b.is_active) : true,
      });
    });
    if (saved && saved.success === false) {
      fail(res, 400, 'META_CONFIG_ERROR', ('message' in saved && saved.message) ? saved.message : 'Invalid Meta configuration');
      return;
    }
    ok(res, saved?.summary ?? saved);
  })
);

marketingCompatRouter.get(
  '/meta/accounts',
  requireAnyPermission([
    ['ads_capi', 'view'],
    ['settings', 'view'],
    ['dashboard_marketing', 'view'],
    ['dashboard_crm', 'view'],
  ]),
  handler('COMPAT_META_ACCOUNTS_LIST', async (_req, res) => {
    const summary = await tx(async (client, ctx) => getMetaAdsConfigSummary(client, ctx.tenantId));
    ok(res, { ...summary, items: summary.accounts });
  })
);

marketingCompatRouter.post(
  '/meta/accounts',
  metaConfigPerm,
  handler('COMPAT_META_ACCOUNT_CREATE', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const result = await tx(async (client, ctx) =>
      upsertMetaAdAccount(client, ctx.tenantId, {
        id: b.id !== undefined ? String(b.id) : undefined,
        name: b.name !== undefined ? String(b.name) : b.account_name !== undefined ? String(b.account_name) : undefined,
        ad_account_id: String(b.ad_account_id ?? b.account_id ?? ''),
        access_token: b.access_token !== undefined ? String(b.access_token) : undefined,
        pixel_id: b.pixel_id !== undefined ? String(b.pixel_id) : undefined,
        is_active: b.is_active !== undefined ? Boolean(b.is_active) : true,
        requireNew: Boolean(b.requireNew),
      })
    );
    if (!result.success) {
      fail(res, 400, 'META_ACCOUNT_ERROR', result.message || 'Failed to save Meta ad account');
      return;
    }
    ok(res, result);
  })
);

const updateMetaAccountHandler = handler('COMPAT_META_ACCOUNT_UPDATE', async (req, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const paramId = String(req.params.id || '').trim();
  const result = await tx(async (client, ctx) =>
    upsertMetaAdAccount(client, ctx.tenantId, {
      id: paramId,
      name: b.name !== undefined ? String(b.name) : b.account_name !== undefined ? String(b.account_name) : undefined,
      ad_account_id: String(b.ad_account_id ?? b.account_id ?? paramId),
      access_token: b.access_token !== undefined ? String(b.access_token) : undefined,
      pixel_id: b.pixel_id !== undefined ? String(b.pixel_id) : undefined,
      is_active: b.is_active !== undefined ? Boolean(b.is_active) : undefined,
    })
  );
  if (!result.success) {
    fail(res, 400, 'META_ACCOUNT_UPDATE_ERROR', result.message || 'Failed to update Meta ad account');
    return;
  }
  ok(res, result);
});
marketingCompatRouter.put('/meta/accounts/:id', metaConfigPerm, updateMetaAccountHandler);
marketingCompatRouter.patch('/meta/accounts/:id', metaConfigPerm, updateMetaAccountHandler);

marketingCompatRouter.delete(
  '/meta/accounts/:id',
  metaConfigPerm,
  handler('COMPAT_META_ACCOUNT_DELETE', async (req, res) => {
    const paramId = String(req.params.id || '').trim();
    const purgeInsights = qstr(req, 'purge_insights') === 'true' || Boolean(req.body?.purge_insights);
    const result = await tx(async (client, ctx) =>
      deleteMetaAdAccount(client, ctx.tenantId, paramId, purgeInsights)
    );
    if (!result.success) {
      fail(res, 404, 'META_ACCOUNT_NOT_FOUND', result.message || 'Meta ad account not found');
      return;
    }
    ok(res, result);
  })
);

const toggleMetaAccountHandler = handler('COMPAT_META_ACCOUNT_TOGGLE', async (req, res) => {
  const paramId = String(req.params.id || '').trim();
  const b = (req.body || {}) as Record<string, unknown>;
  const result = await tx(async (client, ctx) => {
    let nextActive: boolean;
    if (b.is_active !== undefined) {
      nextActive = Boolean(b.is_active);
    } else {
      const summary = await getMetaAdsConfigSummary(client, ctx.tenantId);
      const found = summary.accounts.find(
        (a) => a.id === paramId || a.ad_account_id === paramId || `act_${a.ad_account_id}` === paramId
      );
      nextActive = found ? !found.is_active : true;
    }
    return toggleMetaAdAccountStatus(client, ctx.tenantId, paramId, nextActive);
  });
  if (!result.success) {
    fail(res, 404, 'META_ACCOUNT_NOT_FOUND', result.message || 'Meta ad account not found');
    return;
  }
  ok(res, result);
});
marketingCompatRouter.post('/meta/accounts/:id/toggle', metaConfigPerm, toggleMetaAccountHandler);
marketingCompatRouter.patch('/meta/accounts/:id/toggle', metaConfigPerm, toggleMetaAccountHandler);

marketingCompatRouter.post(
  '/meta/discover',
  metaConfigPerm,
  handler('COMPAT_META_DISCOVER', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const result = await tx(async (client, ctx) =>
      discoverMetaTokenAssets(client, ctx.tenantId, {
        access_token: b.access_token !== undefined ? String(b.access_token) : undefined,
        account_id: b.account_id !== undefined ? String(b.account_id) : undefined,
        ad_account_id: b.ad_account_id !== undefined ? String(b.ad_account_id) : undefined,
      })
    );
    ok(res, result);
  })
);

marketingCompatRouter.post(
  '/meta/sync',
  requireAnyPermission([
    ['ads_capi', 'manage_config'],
    ['ads_capi', 'create'],
    ['settings', 'manage_config'],
  ]),
  handler('COMPAT_META_SYNC', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const accountRef = String(b.ad_account_id ?? b.account_id ?? b.id ?? '').trim() || undefined;
    const result = await tx(async (client, ctx) => syncMetaAdsAccounts(client, ctx.tenantId, { accountRef }));
    ok(res, result);
  })
);

marketingCompatRouter.get(
  '/meta/capi-config',
  requireAnyPermission([
    ['ads_capi', 'view'],
    ['settings', 'view'],
  ]),
  handler('COMPAT_META_CAPI_GET', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const meta = await getTenantMetaCached(ctx.tenantId, client);
      return getMetaCapiDashboardConfig(client, ctx.tenantId, Boolean(meta?.rawSettings?.capi_enabled));
    });
    ok(res, data);
  })
);

marketingCompatRouter.post(
  '/meta/capi-config',
  metaConfigPerm,
  handler('COMPAT_META_CAPI_SAVE', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const saved = await tx(async (client, ctx) => {
      const existingRes = await client.query<{
        id: string;
        config_encrypted: string;
        iv: string;
        auth_tag: string;
        status: string;
      }>(
        `SELECT id, config_encrypted, iv, auth_tag, status
         FROM tenant_integrations
         WHERE tenant_id = $1 AND integration_type = 'meta_capi'
         LIMIT 1`,
        [ctx.tenantId]
      );
      let existingConfig: Record<string, unknown> = {};
      if (existingRes.rows[0]?.config_encrypted) {
        try {
          existingConfig = decryptTenantSecret<Record<string, unknown>>(
            ctx.tenantId,
            existingRes.rows[0].config_encrypted,
            existingRes.rows[0].iv,
            existingRes.rows[0].auth_tag
          );
        } catch {
          existingConfig = {};
        }
      }

      const rawToken = String(b.access_token ?? b.capi_access_token ?? '').trim();
      const resolvedToken =
        rawToken === '__KEEP_EXISTING__'
          ? String(existingConfig.access_token || '')
          : rawToken || String(existingConfig.access_token || '');
      const pixelId =
        b.pixel_id !== undefined ? String(b.pixel_id).trim() : String(existingConfig.pixel_id || '');
      const testEventCode =
        b.test_event_code !== undefined
          ? String(b.test_event_code).trim()
          : String(existingConfig.test_event_code || '');
      const nextEnabled =
        b.enabled !== undefined
          ? Boolean(b.enabled)
          : b.capi_enabled !== undefined
            ? Boolean(b.capi_enabled)
            : b.is_active !== undefined
              ? Boolean(b.is_active)
              : existingRes.rows[0]
                ? existingRes.rows[0].status === 'active'
                : Boolean(pixelId && resolvedToken);

      const nextPayload = {
        ...existingConfig,
        pixel_id: pixelId,
        access_token: resolvedToken,
        test_event_code: testEventCode,
      };
      const encrypted = encryptTenantSecret(ctx.tenantId, nextPayload);
      const nextStatus = nextEnabled ? 'active' : 'inactive';

      await client.query(
        `INSERT INTO tenant_integrations (
           tenant_id, integration_type, config_encrypted, iv, auth_tag, status, updated_at
         ) VALUES ($1, 'meta_capi', $2, $3, $4, $5, clock_timestamp())
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           status = EXCLUDED.status,
           updated_at = clock_timestamp()`,
        [ctx.tenantId, encrypted.configEncrypted, encrypted.iv, encrypted.authTag, nextStatus]
      );

      const tenantRow = await client.query<{ slug: string; settings: unknown }>(
        'SELECT slug, settings FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      const curSettings = safeParseObj(tenantRow.rows[0]?.settings);
      const nextSettings = { ...curSettings, capi_enabled: nextEnabled };
      await client.query(
        'UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
        [ctx.tenantId, JSON.stringify(nextSettings)]
      );
      tenantRedis.invalidateTenantIntegrations(ctx.tenantId);
      if (tenantRow.rows[0]?.slug) tenantRedis.invalidateTenantCache(ctx.tenantId, tenantRow.rows[0].slug);

      return getMetaCapiDashboardConfig(client, ctx.tenantId, nextEnabled);
    });
    ok(res, saved);
  })
);

// ---- /capi/* full parity bridge onto integrationsRouter (Wave A + CapiPage settings/logs/test/adsets) ----
marketingCompatRouter.use(
  '/capi',
  bridge(integrationsRouter, (r) => (r.path === '/' ? '/capi' : `/capi${r.path}`))
);

// ---- /automation/*.php legacy endpoints ----
interface StoredMetaFanpageConfig {
  id: string;
  page_id: string;
  page_name: string;
  page_access_token: string;
  avatar_url?: string;
  app_id?: string;
  app_secret?: string;
  verify_token: string;
  status: 'active' | 'inactive';
  mode: 'live' | 'dev';
  token_expires_at?: number;
}

function maskMetaPageSecret(val?: string | null): string {
  const s = String(val || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function isMaskedMetaSecret(val: unknown): boolean {
  if (typeof val !== 'string') return true;
  const trimmed = val.trim();
  return trimmed === '' || trimmed === '__KEEP_EXISTING__' || trimmed.includes('••••') || trimmed.includes('***');
}

function normalizeStoredMetaFanpages(decrypted: Record<string, unknown>): StoredMetaFanpageConfig[] {
  const rawList = Array.isArray(decrypted.pages) ? decrypted.pages : [];
  const extracted = extractMetaPageConfigs(decrypted);
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of rawList) {
    if (r && typeof r === 'object') {
      const obj = r as Record<string, unknown>;
      const pid = String(obj.page_id || obj.id || '').trim();
      if (pid) byId.set(pid, obj);
    }
  }
  return extracted.map((p) => {
    const raw = byId.get(p.page_id) || {};
    return {
      id: p.page_id,
      page_id: p.page_id,
      page_name: String(p.page_name || raw.page_name || `Page ${p.page_id}`).trim(),
      page_access_token: String(p.page_access_token || '').trim(),
      avatar_url: raw.avatar_url ? String(raw.avatar_url) : '',
      app_id: String(p.app_id || raw.app_id || '').trim(),
      app_secret: String(p.app_secret || '').trim(),
      verify_token: String(p.verify_token || raw.verify_token || '').trim(),
      status: String(p.status || raw.status || 'active') === 'inactive' ? 'inactive' : 'active',
      mode: String(p.mode || raw.mode || 'live') === 'dev' ? 'dev' : 'live',
      token_expires_at: raw.token_expires_at ? Number(raw.token_expires_at) || 0 : 0,
    };
  });
}

function presentMetaFanpage(p: StoredMetaFanpageConfig) {
  return {
    id: p.page_id,
    page_id: p.page_id,
    page_name: p.page_name,
    page_access_token: maskMetaPageSecret(p.page_access_token),
    has_page_access_token: Boolean(p.page_access_token),
    avatar_url: p.avatar_url || '',
    app_id: p.app_id || '',
    has_app_secret: Boolean(p.app_secret),
    verify_token: p.verify_token || '',
    status: p.status,
    mode: p.mode,
    token_expires_at: p.token_expires_at || 0,
  };
}

async function readDecryptedMetaMessengerVault(
  client: Parameters<Parameters<typeof tx>[0]>[0],
  tenantId: string
): Promise<Record<string, unknown>> {
  const row = await client.query<{
    config_encrypted: string;
    iv: string;
    auth_tag: string;
  }>(
    `SELECT config_encrypted, iv, auth_tag
     FROM tenant_integrations
     WHERE tenant_id = $1 AND integration_type = 'meta_messenger'
     LIMIT 1`,
    [tenantId]
  );
  if (!row.rows[0]?.config_encrypted) return {};
  try {
    return decryptTenantSecret<Record<string, unknown>>(
      tenantId,
      row.rows[0].config_encrypted,
      row.rows[0].iv,
      row.rows[0].auth_tag
    );
  } catch {
    return {};
  }
}

async function writeEncryptedMetaMessengerVault(
  client: Parameters<Parameters<typeof tx>[0]>[0],
  tenantId: string,
  pages: StoredMetaFanpageConfig[]
): Promise<void> {
  const first = pages[0];
  const payload = {
    pages,
    page_id: first?.page_id || '',
    page_name: first?.page_name || '',
    page_access_token: first?.page_access_token || '',
    app_id: first?.app_id || '',
    app_secret: first?.app_secret || '',
    verify_token: first?.verify_token || '',
  };
  const encrypted = encryptTenantSecret(tenantId, payload);
  const nextStatus = pages.length > 0 ? 'active' : 'disconnected';
  await client.query(
    `INSERT INTO tenant_integrations (
       tenant_id, integration_type, config_encrypted, iv, auth_tag, status, last_synced_at
     ) VALUES ($1, 'meta_messenger', $2, $3, $4, $5, clock_timestamp())
     ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
       config_encrypted = EXCLUDED.config_encrypted,
       iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag,
       status = EXCLUDED.status,
       last_synced_at = clock_timestamp()`,
    [tenantId, encrypted.configEncrypted, encrypted.iv, encrypted.authTag, nextStatus]
  );
  tenantRedis.invalidateTenantIntegrations(tenantId, 'meta_messenger');
}

const metaFanpageViewPerm = requireAnyPermission([
  ['mkt_social_bot', 'view'],
  ['ads_capi', 'view'],
  ['dashboard_marketing', 'view'],
  ['settings', 'view'],
]);

const metaFanpageEditPerm = requireAnyPermission([
  ['mkt_social_bot', 'edit'],
  ['mkt_social_bot', 'create'],
  ['ads_capi', 'manage_config'],
  ['settings', 'manage_config'],
]);

const handleMetaFanpageConfigCompat = handler('COMPAT_META_FANPAGE_CONFIG', async (req, res) => {
  const method = String(req.method || 'GET').toUpperCase();
  const route = String(req.query?.route ?? (req.body as Record<string, unknown> | undefined)?.route ?? '')
    .trim()
    .toLowerCase();
  const targetId = String(req.params?.id || phpId(req) || (req.body as Record<string, unknown> | undefined)?.page_id || '').trim();

  if (method === 'GET' && !route) {
    const pages = await tx(async (client, ctx) => {
      const decrypted = await readDecryptedMetaMessengerVault(client, ctx.tenantId);
      return normalizeStoredMetaFanpages(decrypted).map(presentMetaFanpage);
    });
    return void ok(res, pages);
  }

  if (method === 'POST' && route === 'get-pages') {
    const b = (req.body || {}) as Record<string, unknown>;
    const rawUserToken = String(b.user_access_token || b.access_token || '').trim();
    const appId = String(b.app_id || '').trim();
    const appSecret = String(b.app_secret || '').trim();
    if (!rawUserToken) {
      fail(res, 422, 'USER_ACCESS_TOKEN_REQUIRED', 'Vui lòng nhập Facebook User Access Token.');
      return;
    }

    let effectiveToken = rawUserToken;
    let tokenExpiresAt = 0;

    try {
      if (appId && appSecret) {
        const exUrl =
          `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token` +
          `&client_id=${encodeURIComponent(appId)}` +
          `&client_secret=${encodeURIComponent(appSecret)}` +
          `&fb_exchange_token=${encodeURIComponent(rawUserToken)}`;
        const exResp = await fetch(exUrl, { signal: AbortSignal.timeout(8000) });
        const exJson = (await exResp.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
        if (exResp.ok && exJson?.access_token) {
          effectiveToken = exJson.access_token;
          if (exJson.expires_in) {
            tokenExpiresAt = Math.floor(Date.now() / 1000) + Number(exJson.expires_in);
          }
        }
      }

      const graphResp = await fetch(
        'https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,picture{url}&limit=100',
        {
          headers: { Authorization: `Bearer ${effectiveToken}` },
          signal: AbortSignal.timeout(10000),
        }
      );
      const graphJson = (await graphResp.json().catch(() => null)) as {
        data?: Array<{ id?: string; name?: string; access_token?: string; picture?: { data?: { url?: string } } }>;
        error?: { message?: string };
      } | null;

      if (!graphResp.ok || graphJson?.error) {
        fail(
          res,
          400,
          'META_GRAPH_ERROR',
          graphJson?.error?.message || `Không thể truy vấn danh sách Fanpage từ Meta (HTTP ${graphResp.status}).`
        );
        return;
      }

      const pages = (Array.isArray(graphJson?.data) ? graphJson.data : [])
        .filter((p) => p && p.id)
        .map((p) => ({
          page_id: String(p.id),
          page_name: String(p.name || `Page ${p.id}`),
          page_access_token: String(p.access_token || ''),
          avatar_url: p.picture?.data?.url ? String(p.picture.data.url) : '',
          token_expires_at: tokenExpiresAt,
        }));

      ok(res, pages);
    } catch (err: any) {
      fail(res, 502, 'META_GRAPH_NETWORK_ERROR', err?.message || 'Không thể kết nối đến Meta Graph API.');
    }
    return;
  }

  if (method === 'POST' && route === 'debug-token') {
    const b = (req.body || {}) as Record<string, unknown>;
    const lookupId = String(b.id || b.page_id || '').trim();
    const rawPassedToken = String(b.access_token || b.page_access_token || '').trim();

    const vaultInfo = await tx(async (client, ctx) => {
      const decrypted = await readDecryptedMetaMessengerVault(client, ctx.tenantId);
      const pages = normalizeStoredMetaFanpages(decrypted);
      const matched = lookupId ? pages.find((p) => p.page_id === lookupId || p.id === lookupId) : pages[0];
      return {
        token: !isMaskedMetaSecret(rawPassedToken) ? rawPassedToken : matched?.page_access_token || '',
        appId: matched?.app_id || String(decrypted.app_id || ''),
        appSecret: matched?.app_secret || String(decrypted.app_secret || ''),
        pageName: matched?.page_name || '',
      };
    });

    if (!vaultInfo.token) {
      fail(res, 422, 'PAGE_ACCESS_TOKEN_MISSING', 'Không tìm thấy Page Access Token hợp lệ để kiểm tra.');
      return;
    }

    try {
      const permResp = await fetch('https://graph.facebook.com/v21.0/me/permissions', {
        headers: { Authorization: `Bearer ${vaultInfo.token}` },
        signal: AbortSignal.timeout(8000),
      });
      const permJson = (await permResp.json().catch(() => null)) as {
        data?: Array<{ permission: string; status: string }>;
        error?: { message?: string };
      } | null;

      let debugInfo: Record<string, unknown> = {
        application: vaultInfo.pageName || 'DOMATION Meta App',
        version: 'v21.0',
        is_valid: permResp.ok && !permJson?.error,
        scopes: Array.isArray(permJson?.data)
          ? permJson.data.filter((p) => p.status === 'granted').map((p) => p.permission)
          : [],
      };

      if (vaultInfo.appId && vaultInfo.appSecret) {
        const dbgUrl =
          `https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(vaultInfo.token)}` +
          `&access_token=${encodeURIComponent(`${vaultInfo.appId}|${vaultInfo.appSecret}`)}`;
        const dbgResp = await fetch(dbgUrl, { signal: AbortSignal.timeout(8000) });
        const dbgJson = (await dbgResp.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
        if (dbgResp.ok && dbgJson?.data) {
          debugInfo = {
            ...debugInfo,
            ...dbgJson.data,
            version: 'v21.0',
          };
        }
      }

      ok(res, {
        debug: debugInfo,
        permissions: Array.isArray(permJson?.data) ? permJson.data : [],
      });
    } catch (err: any) {
      fail(res, 502, 'META_DEBUG_TOKEN_FAILED', err?.message || 'Không thể kiểm tra quyền hạn Token với Meta.');
    }
    return;
  }

  if (method === 'DELETE' || route === 'delete') {
    if (!targetId) {
      fail(res, 422, 'PAGE_ID_REQUIRED', 'Thiếu ID Fanpage cần gỡ kết nối.');
      return;
    }
    const remainingCount = await tx(async (client, ctx) => {
      const decrypted = await readDecryptedMetaMessengerVault(client, ctx.tenantId);
      const prevPages = normalizeStoredMetaFanpages(decrypted);
      const nextPages = prevPages.filter((p) => p.page_id !== targetId && p.id !== targetId);
      await writeEncryptedMetaMessengerVault(client, ctx.tenantId, nextPages);
      return nextPages.length;
    });
    ok(res, { deleted: true, id: targetId, remaining: remainingCount });
    return;
  }

  // POST (?route=save or default) / PUT / PATCH -> Upsert Fanpage(s) into `meta_messenger` vault
  const b = (req.body || {}) as Record<string, unknown>;
  const rawIncoming = Array.isArray(b.pages) ? (b.pages as Array<Record<string, unknown>>) : [b];
  const validIncoming = rawIncoming.filter((item) => item && String(item.page_id || item.id || '').trim());
  if (validIncoming.length === 0) {
    fail(res, 422, 'PAGE_ID_REQUIRED', 'Vui lòng nhập Page ID để lưu cấu hình Fanpage.');
    return;
  }

  const savedResult = await tx(async (client, ctx) => {
    const decrypted = await readDecryptedMetaMessengerVault(client, ctx.tenantId);
    const pages = normalizeStoredMetaFanpages(decrypted);
    let lastSaved: StoredMetaFanpageConfig | null = null;

    for (const item of validIncoming) {
      const pageId = String(item.page_id || item.id || '').trim();
      const idx = pages.findIndex((p) => p.page_id === pageId);
      const prev = idx >= 0 ? pages[idx] : undefined;

      const rawTokenInput = item.page_access_token ?? item.access_token;
      const nextToken = isMaskedMetaSecret(rawTokenInput)
        ? prev?.page_access_token || ''
        : String(rawTokenInput || '').trim();
      const nextSecret = isMaskedMetaSecret(item.app_secret)
        ? prev?.app_secret || ''
        : String(item.app_secret || '').trim();
      const rawVerify = String(item.verify_token || '').trim();
      const nextVerify =
        rawVerify && !isMaskedMetaSecret(rawVerify)
          ? rawVerify
          : prev?.verify_token || `dom_meta_${crypto.randomBytes(8).toString('hex')}`;

      const record: StoredMetaFanpageConfig = {
        id: pageId,
        page_id: pageId,
        page_name: String(item.page_name || prev?.page_name || `Fanpage ${pageId}`).trim(),
        page_access_token: nextToken,
        avatar_url: item.avatar_url !== undefined ? String(item.avatar_url || '').trim() : prev?.avatar_url || '',
        app_id: item.app_id !== undefined ? String(item.app_id || '').trim() : prev?.app_id || '',
        app_secret: nextSecret,
        verify_token: nextVerify,
        status: String(item.status || prev?.status || 'active') === 'inactive' ? 'inactive' : 'active',
        mode: String(item.mode || prev?.mode || 'live') === 'dev' ? 'dev' : 'live',
        token_expires_at:
          item.token_expires_at !== undefined
            ? Number(item.token_expires_at) || 0
            : prev?.token_expires_at || 0,
      };

      if (idx >= 0) pages[idx] = record;
      else pages.push(record);
      lastSaved = record;
    }

    await writeEncryptedMetaMessengerVault(client, ctx.tenantId, pages);
    return {
      saved: lastSaved ? presentMetaFanpage(lastSaved) : null,
      pages: pages.map(presentMetaFanpage),
    };
  });

  ok(res, Array.isArray(b.pages) ? savedResult.pages : savedResult.saved, '', 201);
});

marketingCompatRouter.all('/automation/ses_quota.php', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/automation/meta_config.php', metaFanpageViewPerm, handleMetaFanpageConfigCompat);
marketingCompatRouter.post('/automation/meta_config.php', metaFanpageEditPerm, handleMetaFanpageConfigCompat);
marketingCompatRouter.put('/automation/meta_config.php', metaFanpageEditPerm, handleMetaFanpageConfigCompat);
marketingCompatRouter.patch('/automation/meta_config.php', metaFanpageEditPerm, handleMetaFanpageConfigCompat);
marketingCompatRouter.delete('/automation/meta_config.php', metaFanpageEditPerm, handleMetaFanpageConfigCompat);
marketingCompatRouter.delete('/automation/meta_config.php/:id', metaFanpageEditPerm, handleMetaFanpageConfigCompat);
marketingCompatRouter.get('/automation/settings.php', bridge(marketingCompatRouter, '/settings'));
marketingCompatRouter.post('/automation/settings.php', bridge(marketingCompatRouter, '/settings'));
marketingCompatRouter.all('/automation/overview_stats.php', bridge(marketingRouter, '/overview'));
marketingCompatRouter.all(
  '/automation/forms.php',
  forwardBridge((req) => {
    const id = phpId(req);
    const m = String(req.method || 'GET').toUpperCase();
    return {
      router: marketingRouter,
      path: id ? `/forms/${encodeURIComponent(id)}` : '/forms',
      ...(id && (m === 'POST' || m === 'PUT' || m === 'PATCH') ? { method: 'PUT' } : {}),
    };
  })
);
marketingCompatRouter.all(
  '/automation/surveys.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    if (method === 'GET' && id) {
      return { router: marketingRouter, path: `/surveys/${encodeURIComponent(id)}/analytics` };
    }
    return { router: marketingRouter, path: id ? `/surveys/${encodeURIComponent(id)}` : '/surveys' };
  })
);
marketingCompatRouter.all(
  '/automation/templates.php',
  forwardBridge((req) => {
    const id = phpId(req);
    return { router: marketingRouter, path: id ? `/templates/${encodeURIComponent(id)}` : '/templates' };
  })
);
marketingCompatRouter.all(
  '/automation/template_groups.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    if (method === 'GET') return { router: marketingRouter, path: '/templates' };
    if (method === 'POST') return { router: marketingRouter, path: '/templates/groups' };
    return { router: marketingRouter, path: id ? `/templates/groups/${encodeURIComponent(id)}` : '/templates/groups' };
  })
);
marketingCompatRouter.all(
  '/automation/tags.php',
  forwardBridge((req) => {
    const id = phpId(req);
    return { router: orgRbacRouter, path: id ? `/tags/${encodeURIComponent(id)}` : '/tags' };
  })
);
marketingCompatRouter.all(
  '/automation/voucher_campaigns.php',
  forwardBridge((req) => {
    const id = phpId(req);
    return { router: marketingRouter, path: id ? `/vouchers/${encodeURIComponent(id)}` : '/vouchers' };
  })
);
marketingCompatRouter.all(
  '/automation/voucher_codes.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const cid = String(req.query?.campaign_id ?? req.body?.campaign_id ?? phpId(req)).trim();
    if (!cid) return { router: marketingRouter, path: '/vouchers' };
    return {
      router: marketingRouter,
      path: method === 'POST' ? `/vouchers/${encodeURIComponent(cid)}/generate` : `/vouchers/${encodeURIComponent(cid)}/codes`,
    };
  })
);
marketingCompatRouter.all(
  '/automation/links_qr.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    if (method === 'GET') return { router: marketingRouter, path: '/vouchers' };
    if (method === 'POST') return { router: marketingRouter, path: '/vouchers/shortlinks' };
    return { router: marketingRouter, path: id ? `/vouchers/shortlinks/${encodeURIComponent(id)}` : '/vouchers/shortlinks' };
  })
);
marketingCompatRouter.put(
  ['/automation/custom_events.php', '/automation/purchase_events.php'],
  requirePermission('mkt_forms', 'edit'),
  updateCustomEventHandler
);
marketingCompatRouter.all('/automation/custom_events.php', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.all('/automation/purchase_events.php', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.all('/automation/zalo_templates.php', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.post('/automation/zalo_broadcast.php', bridge(marketingRouter, '/social-bot/zalo-broadcast'));
marketingCompatRouter.all('/automation/:slug', bridge(marketingRouter, '/overview'));

// ---- Config, Connections, Search, Upload, Export ----
marketingCompatRouter.get(
  '/tenant-config',
  handler('COMPAT_TENANT_CONFIG', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [meta, tenantRowRes, stages, teamsRes, wfRes] = await Promise.all([
        getTenantMetaCached(ctx.tenantId, client),
        client
          .query(
            `SELECT package_code, plan_tier, subscription_plan_code, crm_erp_upgrade_status,
                    industry, industry_key, enabled_modules, entitlements, settings
             FROM tenants WHERE id = $1 LIMIT 1`,
            [ctx.tenantId]
          )
          .catch(() => ({ rows: [] as any[] })),
        client.query('SELECT * FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC', [ctx.tenantId]),
        client.query('SELECT id, name, leader_user_id FROM tenant_teams WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client
          .query('SELECT id, code, name, category, category_label, default_watcher_ids, default_watcher_roles, is_active FROM tenant_approval_workflows WHERE tenant_id = $1 ORDER BY created_at ASC', [ctx.tenantId])
          .catch(() => ({ rows: [] as any[] })),
      ]);
      const raw = (meta?.rawSettings || {}) as Record<string, unknown>;
      const settings = meta?.settings || (await getTenantSettingsCached(ctx.tenantId, client));
      const tenantRow = tenantRowRes.rows[0] || {};
      const entitlementSnap = resolveTenantEntitlementSnapshot({
        ...tenantRow,
        settings: tenantRow.settings || raw,
      });
      const mergedSettings = {
        ...raw,
        ...settings,
        brand_display_name: settings.brand_display_name || String(raw.company_name || meta?.name || ''),
        company_name: String(raw.company_name || settings.brand_display_name || meta?.name || ''),
      };
      return {
        tenant_id: ctx.tenantId,
        tenant_slug: ctx.tenantSlug,
        package_code: entitlementSnap.package_code,
        plan_tier: String(tenantRow.plan_tier || entitlementSnap.package_code),
        enabled_modules: entitlementSnap.enabled_modules,
        entitlements: entitlementSnap.entitlements,
        industry_key: entitlementSnap.industry_key,
        terminology: entitlementSnap.terminology,
        organization: {
          name: mergedSettings.company_name,
          short_name: String(raw.company_short_name || settings.brand_display_name || meta?.name || 'DOM ERP'),
          logo_url: settings.brand_logo_url,
          primary_color: settings.brand_primary_color,
          address: String(raw.company_address || ''),
          tax_id: String(raw.company_tax_id || ''),
          support_hotline: String(raw.company_phone || ''),
          support_email: settings.support_email,
        },
        settings: mergedSettings,
        pipeline_stages: stages.rows,
        teams: teamsRes.rows,
        approval_workflows: wfRes.rows,
        approval_categories: Array.isArray(raw.approval_categories) ? raw.approval_categories : [],
      };
    });
    ok(res, data);
  })
);
marketingCompatRouter.get(
  '/settings',
  handler('COMPAT_SETTINGS_GET', async (_req, res) => {
    const flat = await tx(async (client, ctx) => {
      const [meta, stages] = await Promise.all([
        getTenantMetaCached(ctx.tenantId, client),
        client.query('SELECT stage_key, stage_name, stage_order, color_hex FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC', [ctx.tenantId]),
      ]);
      const raw = (meta?.rawSettings || {}) as Record<string, unknown>;
      const settings = meta?.settings || (await getTenantSettingsCached(ctx.tenantId, client));
      return {
        ...settings,
        ...raw,
        company_name: String(raw.company_name ?? settings.brand_display_name ?? meta?.name ?? ''),
        company_address: String(raw.company_address ?? ''),
        company_phone: String(raw.company_phone ?? ''),
        company_tax_id: String(raw.company_tax_id ?? ''),
        company_logo_url: String(raw.company_logo_url ?? settings.brand_logo_url ?? ''),
        pipeline_stages: stages.rows,
      };
    });
    ok(res, flat);
  })
);
marketingCompatRouter.post(
  '/settings',
  requirePermission('settings', 'manage_config'),
  handler('COMPAT_SETTINGS_SAVE', async (req, res) => {
    const incoming = req.body && typeof req.body === 'object' ? { ...(req.body as Record<string, unknown>) } : {};
    delete incoming.tenant_id;
    delete incoming.id;
    if (incoming.ses_password === '••••••••') {
      delete incoming.ses_password;
    }
    if (incoming.resend_api_key === '••••••••') {
      delete incoming.resend_api_key;
    }
    const saved = await tx(async (client, ctx) => {
      const r = await client.query<{ slug: string; settings: unknown }>(
        'SELECT slug, settings FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      const cur = safeParseObj(r.rows[0]?.settings);
      const mergedRaw = { ...cur, ...incoming };
      const normalized = normalizeTenantSettings(mergedRaw);
      const next = { ...mergedRaw, ...normalized };
      await client.query('UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1', [
        ctx.tenantId,
        JSON.stringify(next),
      ]);
      tenantRedis.invalidateTenantCache(ctx.tenantId, r.rows[0]?.slug || ctx.tenantSlug);
      return next;
    });
    ok(res, { saved: true, settings: saved });
  })
);
marketingCompatRouter.get('/overview_stats', bridge(marketingRouter, '/overview'));

marketingCompatRouter.get('/search', bridge(erpOpsRouter, '/global-search'));
marketingCompatRouter.get('/search/global', bridge(erpOpsRouter, '/global-search'));

// ---- Unified Dynamic DB Schema Registry ----
marketingCompatRouter.get(
  '/schema/condition-fields',
  requireAnyPermission([
    ['leads', 'view'],
    ['audiences', 'view'],
    ['mkt_flows', 'view'],
    ['routing_rules', 'view'],
    ['mkt_forms', 'view'],
  ]),
  handler('COMPAT_SCHEMA_CONDITION_FIELDS', async (_req, res) => {
    const data = await tx(async (client, ctx) => buildDynamicConditionSchemaRegistryInTx(client, ctx.tenantId));
    ok(res, data);
  })
);

// ---- 1-Click SaaS Package Entitlements & Upgrade (/data CRM -> DOM ERP) ----
marketingCompatRouter.get(
  '/package-entitlements',
  handler('COMPAT_PACKAGE_ENTITLEMENTS_GET', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const r = await client.query<{
        id: string;
        slug: string;
        name: string;
        package_code: string | null;
        plan_tier: string | null;
        subscription_plan_code: string | null;
        crm_erp_upgrade_status: string | null;
        industry: string | null;
        industry_key: string | null;
        enabled_modules: unknown;
        entitlements: unknown;
        settings: unknown;
      }>(
        `SELECT id, slug, name, package_code, plan_tier, subscription_plan_code,
                crm_erp_upgrade_status, industry, industry_key, enabled_modules, entitlements, settings
         FROM tenants WHERE id = $1 LIMIT 1`,
        [ctx.tenantId]
      );
      const row = r.rows[0];
      if (!row) return null;
      const snapshot = resolveTenantEntitlementSnapshot(row);
      return {
        tenant_id: ctx.tenantId,
        tenant_slug: row.slug,
        tenant_name: row.name,
        current_package: snapshot.package_code,
        package_code: snapshot.package_code,
        package_info: SAAS_PACKAGES_CATALOG[snapshot.package_code] || null,
        education_addon: snapshot.entitlements.education_addon,
        enable_ideas_mascot: snapshot.entitlements.enable_ideas_mascot,
        enabled_modules: snapshot.enabled_modules,
        entitlements: snapshot.entitlements,
        entitlement_snapshot: snapshot,
        industry_key: snapshot.industry_key,
        terminology: snapshot.terminology,
        packages: Object.values(SAAS_PACKAGES_CATALOG),
        modules_catalog: SAAS_MODULES_CATALOG,
        zero_migration_ready: true,
      };
    });
    if (!data) {
      fail(res, 404, 'TENANT_NOT_FOUND', 'Tenant not found');
      return;
    }
    ok(res, data);
  })
);

marketingCompatRouter.post(
  '/package-entitlements/upgrade',
  requireAnyPermission([
    ['billing', 'manage_config'],
    ['settings', 'manage_config'],
  ]),
  handler('COMPAT_PACKAGE_ENTITLEMENTS_UPGRADE', async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const requestedPkg = normalizePackageUpgradeCode(b.package_code ?? b.target_package ?? b.package);
    const idempotencyKey =
      String(req.header?.('X-Idempotency-Key') || req.header?.('Idempotency-Key') || b.idempotency_key || '')
        .trim()
        .slice(0, 120) || null;
    const runUpgrade = () =>
      tx(async (client, ctx) => {
        const r = await client.query<{
          id: string;
          slug: string;
          name: string;
          package_code: string | null;
          plan_tier: string | null;
          subscription_plan_code: string | null;
          crm_erp_upgrade_status: string | null;
          industry: string | null;
          industry_key: string | null;
          enabled_modules: unknown;
          entitlements: unknown;
          settings: unknown;
        }>(
          `SELECT id, slug, name, package_code, plan_tier, subscription_plan_code,
                  crm_erp_upgrade_status, industry, industry_key, enabled_modules, entitlements, settings
           FROM tenants WHERE id = $1 LIMIT 1`,
          [ctx.tenantId]
        );
        const row = r.rows[0];
        if (!row) return { error: 'TENANT_NOT_FOUND' as const };
        const curSnapshot = resolveTenantEntitlementSnapshot(row);
        const targetPkg = requestedPkg || curSnapshot.package_code;
        if (!(VALID_PACKAGE_CODES as readonly string[]).includes(targetPkg)) {
          return { error: 'INVALID_PACKAGE_CODE' as const, targetPkg };
        }

        const switched = await switchTenantSaasPackageInTx(client, ctx.tenantId, ctx.userId, {
          package_code: targetPkg as (typeof VALID_PACKAGE_CODES)[number],
          billing_cycle: b.billing_cycle,
          months: b.months,
          payment_method: b.payment_method,
          provider: b.provider,
          schedule_at_period_end: Boolean(b.schedule_at_period_end),
          idempotency_key: idempotencyKey,
          education_addon: b.education_addon !== undefined ? Boolean(b.education_addon) : undefined,
          industry_key: typeof b.industry_key === 'string' && b.industry_key.trim() ? b.industry_key.trim() : undefined,
          note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : '1-click package upgrade',
        });

        if (switched.requires_payment) {
          return {
            error: null,
            requiresPayment: true,
            idempotentReplay: Boolean(switched.idempotent_replay),
            payload: {
              upgraded: false,
              requires_payment: true,
              idempotent_replay: Boolean(switched.idempotent_replay),
              previous_package: curSnapshot.package_code,
              target_package: targetPkg,
              transaction: switched.transaction,
              payment_bank_info: switched.payment_bank_info,
              gateway_session: switched.gateway_session,
              subscription: switched.subscription,
            },
          };
        }

        if (row.slug) tenantRedis.invalidateTenantCache(ctx.tenantId, row.slug);

        const updatedRes = await client.query<{
          id: string;
          slug: string;
          name: string;
          package_code: string | null;
          plan_tier: string | null;
          subscription_plan_code: string | null;
          crm_erp_upgrade_status: string | null;
          industry: string | null;
          industry_key: string | null;
          enabled_modules: unknown;
          entitlements: unknown;
          settings: unknown;
        }>(
          `SELECT id, slug, name, package_code, plan_tier, subscription_plan_code,
                  crm_erp_upgrade_status, industry, industry_key, enabled_modules, entitlements, settings
           FROM tenants WHERE id = $1 LIMIT 1`,
          [ctx.tenantId]
        );
        const updatedRow = updatedRes.rows[0] || row;
        const nextSnapshot = resolveTenantEntitlementSnapshot(updatedRow);
        return {
          error: null,
          requiresPayment: false,
          idempotentReplay: Boolean(switched.idempotent_replay),
          payload: {
            upgraded: true,
            idempotent_replay: Boolean(switched.idempotent_replay),
            zero_migration_preserved: true,
            previous_package: curSnapshot.package_code,
            tenant_id: ctx.tenantId,
            tenant_slug: updatedRow.slug,
            tenant_name: updatedRow.name,
            current_package: nextSnapshot.package_code,
            package_code: nextSnapshot.package_code,
            package_info: SAAS_PACKAGES_CATALOG[nextSnapshot.package_code] || null,
            education_addon: nextSnapshot.entitlements.education_addon,
            enable_ideas_mascot: nextSnapshot.entitlements.enable_ideas_mascot,
            enabled_modules: nextSnapshot.enabled_modules,
            entitlements: nextSnapshot.entitlements,
            entitlement_snapshot: nextSnapshot,
            industry_key: nextSnapshot.industry_key,
            terminology: nextSnapshot.terminology,
            subscription: switched.subscription,
          },
        };
      });

    try {
      let result: Awaited<ReturnType<typeof runUpgrade>>;
      try {
        result = await runUpgrade();
      } catch (txErr: any) {
        if (idempotencyKey && isIdempotencyUniqueViolation(txErr)) {
          const replayed = await runUpgrade();
          if (replayed.error || !replayed.idempotentReplay) throw txErr;
          result = replayed;
        } else {
          throw txErr;
        }
      }

      if (result.error === 'TENANT_NOT_FOUND') {
        fail(res, 404, 'TENANT_NOT_FOUND', 'Tenant not found');
        return;
      }
      if (result.error === 'INVALID_PACKAGE_CODE') {
        fail(res, 400, 'INVALID_PACKAGE_CODE', `Unsupported package_code: ${result.targetPkg}`);
        return;
      }
      if (result.requiresPayment) {
        res.status(result.idempotentReplay ? 200 : 201).json({ success: true, data: result.payload });
        return;
      }
      ok(res, result.payload);
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (msg.startsWith('INSUFFICIENT_WALLET_BALANCE')) {
        fail(res, 402, 'INSUFFICIENT_WALLET_BALANCE', msg);
        return;
      }
      if (msg.startsWith('DOWNGRADE_USAGE_EXCEEDED')) {
        fail(res, 409, 'DOWNGRADE_USAGE_EXCEEDED', msg);
        return;
      }
      if (msg.startsWith('IDEMPOTENCY_KEY_MISMATCH')) {
        fail(res, 409, 'IDEMPOTENCY_KEY_MISMATCH', msg);
        return;
      }
      if (msg.startsWith('INVALID_PACKAGE_CODE') || msg.startsWith('INVALID_PLAN_CODE')) {
        fail(res, 400, msg.split(':')[0], msg);
        return;
      }
      throw err;
    }
  })
);
