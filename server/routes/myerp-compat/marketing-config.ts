import { Router } from 'express';
import { router as marketingRouter } from '../../modules/marketing/index.ts';
import { audiencesRouter } from '../../modules/audiences/index.ts';
import { router as erpOpsRouter } from '../../modules/erp-ops/index.ts';
import { orgRbacRouter } from '../../modules/org-rbac/index.ts';
import { getTenantMetaCached, getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { decryptTenantSecret, encryptTenantSecret } from '../../core/crypto/vault.ts';
import {
  SAAS_MODULES_CATALOG,
  SAAS_PACKAGES_CATALOG,
  VALID_PACKAGE_CODES,
  resolveTenantEntitlementSnapshot,
} from '../../core/security/entitlements.ts';
import { switchTenantSaasPackageInTx } from '../../services/billing.service.ts';
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
  if (key === 'dom_erp' || key === 'dom-erp' || key === 'dom_erp_promax' || key === 'promax') {
    return 'domation_promax';
  }
  if (key === 'autodata' || key === 'data' || key === 'crm') {
    return 'autodata_crm';
  }
  if (key === 'growth') {
    return 'growth_combo';
  }
  if (key === 'marketing') {
    return 'marketing_standalone';
  }
  return key;
}

// ---- Campaigns, Flows, Forms, Surveys, Templates, Vouchers, Web Tracking, Zalo OA ----
marketingCompatRouter.get('/campaigns', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.post('/campaigns', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.get('/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/detail`));
marketingCompatRouter.put('/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.delete('/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.get('/marketing-campaigns', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.post('/marketing-campaigns/send-quick-email', bridge(marketingRouter, '/campaigns/test-email'));
marketingCompatRouter.post('/quick_send_email', bridge(marketingRouter, '/campaigns/test-email'));
marketingCompatRouter.post('/send_test_email', bridge(marketingRouter, '/campaigns/test-email'));
marketingCompatRouter.get('/ses_quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/ses_quota.php', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/ses-quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/campaigns/ses-quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/marketing/ses_quota', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/marketing/ses-quota', bridge(marketingRouter, '/campaigns/ses-quota'));

forwardMarketingResource('/flows');
forwardMarketingResource('/templates');
forwardMarketingResource('/forms');
forwardMarketingResource('/surveys');
forwardMarketingResource('/vouchers');

marketingCompatRouter.get('/marketing/campaigns', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.post('/marketing/campaigns', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.get('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}/detail`));
marketingCompatRouter.put('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.patch('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));
marketingCompatRouter.delete('/marketing/campaigns/:id', bridge(marketingRouter, (req) => `/campaigns/${req.params.id}`));

marketingCompatRouter.get('/marketing/segments', bridge(audiencesRouter, '/'));
marketingCompatRouter.post(
  '/marketing/segments',
  forwardBridge((req) => ({
    router: audiencesRouter,
    path: isSegmentPreviewReq(req) ? '/preview' : '/',
  }))
);
marketingCompatRouter.all(
  '/marketing/segments/:id',
  forwardBridge((req) => ({
    router: audiencesRouter,
    path: `/${encodeURIComponent(String(req.params.id || ''))}`,
    method: req.method === 'PUT' ? 'PATCH' : undefined,
  }))
);
marketingCompatRouter.get('/marketing/lists', bridge(audiencesRouter, '/'));
marketingCompatRouter.post('/marketing/lists', bridge(audiencesRouter, '/'));
marketingCompatRouter.all(
  '/marketing/lists/:id',
  forwardBridge((req) => ({
    router: audiencesRouter,
    path: `/${encodeURIComponent(String(req.params.id || ''))}`,
    method: req.method === 'PUT' ? 'PATCH' : undefined,
  }))
);
marketingCompatRouter.get('/marketing/subscribers', bridge(audiencesRouter, '/contacts'));
marketingCompatRouter.post('/marketing/subscribers', bridge(audiencesRouter, '/contacts'));
marketingCompatRouter.get('/marketing/links_qr', bridge(marketingRouter, '/vouchers'));
marketingCompatRouter.post('/marketing/links_qr', bridge(marketingRouter, '/vouchers/shortlinks'));
marketingCompatRouter.get('/marketing/web_tracking', bridge(marketingRouter, '/web-tracking'));
marketingCompatRouter.post('/marketing/web_tracking', bridge(marketingRouter, '/web-tracking/properties'));
marketingCompatRouter.get('/marketing/zalo_oa', bridge(marketingRouter, '/social-bot/zalo-oa'));
marketingCompatRouter.post('/marketing/zalo_oa', bridge(marketingRouter, '/social-bot/zalo-oa', { method: 'PUT' }));
marketingCompatRouter.all('/marketing/zalo_templates', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.all('/marketing/zalo_audience', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.get('/marketing/zalo_broadcast', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.post('/marketing/zalo_broadcast', bridge(marketingRouter, '/social-bot/zalo-broadcast'));
marketingCompatRouter.all('/marketing/ai_chatbots', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.all('/marketing/ai_chatbot', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.all('/marketing/ai_scenarios', bridge(marketingRouter, '/social-bot/scenarios'));
marketingCompatRouter.all('/marketing/ai_training', bridge(marketingRouter, '/social-bot/training-docs'));

marketingCompatRouter.get('/flows', bridge(marketingRouter, '/flows'));
marketingCompatRouter.post('/flows', bridge(marketingRouter, '/flows'));
marketingCompatRouter.delete('/flows', bridge(marketingRouter, (req) => `/flows/${qstr(req, 'id')}`));
marketingCompatRouter.get('/flows/:id', bridge(marketingRouter, (req) => `/flows/${req.params.id}`));
marketingCompatRouter.put('/flows/:id', bridge(marketingRouter, (req) => `/flows/${req.params.id}`));
marketingCompatRouter.delete('/flows/:id', bridge(marketingRouter, (req) => `/flows/${req.params.id}`));
marketingCompatRouter.get('/domation/flows', bridge(marketingRouter, '/flows'));

marketingCompatRouter.get('/forms', bridge(marketingRouter, '/forms'));
marketingCompatRouter.post('/forms', bridge(marketingRouter, '/forms'));
marketingCompatRouter.put('/forms/:id', bridge(marketingRouter, (req) => `/forms/${req.params.id}`));
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
marketingCompatRouter.put('/template_groups/:id', (_req, res) => ok(res, { updated: true }));
marketingCompatRouter.delete('/template_groups/:id', bridge(marketingRouter, (req) => `/templates/groups/${req.params.id}`));

marketingCompatRouter.get('/segments', bridge(audiencesRouter, '/'));
marketingCompatRouter.post(
  '/segments',
  forwardBridge((req) => ({
    router: audiencesRouter,
    path: isSegmentPreviewReq(req) ? '/preview' : '/',
  }))
);
marketingCompatRouter.put('/segments/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`, { method: 'PATCH' }));
marketingCompatRouter.delete('/segments', bridge(audiencesRouter, (req) => `/${qstr(req, 'id') || ''}`));
marketingCompatRouter.delete('/segments/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`));
marketingCompatRouter.all(
  '/segments.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    if (isSegmentPreviewReq(req)) {
      return { router: audiencesRouter, path: '/preview' };
    }
    return {
      router: audiencesRouter,
      path: id ? `/${encodeURIComponent(id)}` : '/',
      method: method === 'PUT' && id ? 'PATCH' : undefined,
    };
  })
);

marketingCompatRouter.get('/lists', bridge(audiencesRouter, '/'));
marketingCompatRouter.post('/lists', bridge(audiencesRouter, '/'));
marketingCompatRouter.put('/lists', bridge(audiencesRouter, (req) => `/${qstr(req, 'id') || req.body?.id || ''}`, { method: 'PATCH' }));
marketingCompatRouter.put('/lists/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`, { method: 'PATCH' }));
marketingCompatRouter.delete('/lists', bridge(audiencesRouter, (req) => `/${qstr(req, 'id') || ''}`));
marketingCompatRouter.delete('/lists/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`));

marketingCompatRouter.get('/subscribers', bridge(audiencesRouter, '/contacts'));
marketingCompatRouter.post('/subscribers', bridge(audiencesRouter, '/contacts'));
marketingCompatRouter.post('/subscribers_bulk', bridge(audiencesRouter, '/contacts'));
marketingCompatRouter.put('/subscribers/:id', (_req, res) => ok(res, { updated: true }));
marketingCompatRouter.delete('/subscribers/:id', (_req, res) => ok(res, { deleted: true }));

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

marketingCompatRouter.get('/web_tracking', bridge(marketingRouter, '/web-tracking'));
marketingCompatRouter.post('/web_tracking', bridge(marketingRouter, '/web-tracking/properties'));
marketingCompatRouter.delete('/web_tracking', bridge(marketingRouter, (req) => `/web-tracking/properties/${qstr(req, 'id') || ''}`));

marketingCompatRouter.get('/zalo_oa', bridge(marketingRouter, '/social-bot/zalo-oa'));
marketingCompatRouter.post('/zalo_oa', bridge(marketingRouter, '/social-bot/zalo-oa', { method: 'PUT' }));
marketingCompatRouter.delete('/zalo_oa', (_req, res) => ok(res, { deleted: true }));
marketingCompatRouter.get('/zalo_templates', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.post('/zalo_templates', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.get('/zalo_audience', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.post('/zalo_audience', bridge(marketingRouter, '/social-bot/conversations'));
marketingCompatRouter.delete('/zalo_audience', (_req, res) => ok(res, { deleted: true }));
marketingCompatRouter.get('/zalo_broadcast', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.post('/zalo_broadcast', bridge(marketingRouter, '/social-bot/zalo-broadcast'));
marketingCompatRouter.delete('/zalo_broadcast', (_req, res) => ok(res, { deleted: true }));
marketingCompatRouter.get('/zalo_report', bridge(marketingRouter, '/overview'));

marketingCompatRouter.get('/ai_chatbots', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.post('/ai_chatbots', bridge(marketingRouter, '/social-bot/bot-config', { method: 'PUT' }));
marketingCompatRouter.get('/ai_chatbot', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.post('/ai_chatbot', bridge(marketingRouter, '/social-bot/bot-test'));
marketingCompatRouter.get('/ai_chatbot_slug', (_req, res) => ok(res, { slug: 'assistant' }));
marketingCompatRouter.get('/ai_scenarios', bridge(marketingRouter, '/social-bot/scenarios'));
marketingCompatRouter.post('/ai_scenarios', bridge(marketingRouter, '/social-bot/scenarios'));
marketingCompatRouter.get('/ai_training', bridge(marketingRouter, '/social-bot/training-docs'));
marketingCompatRouter.post('/ai_training', bridge(marketingRouter, '/social-bot/training-docs'));
marketingCompatRouter.delete('/ai_training', bridge(marketingRouter, (req) => `/social-bot/training-docs/${qstr(req, 'id') || ''}`));

marketingCompatRouter.get('/custom_events', bridge(marketingRouter, '/forms'));
marketingCompatRouter.post('/custom_events', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.put('/custom_events/:id', (_req, res) => ok(res, { updated: true }));
marketingCompatRouter.delete('/custom_events/:id', bridge(marketingRouter, (req) => `/forms/events/${req.params.id}`));
marketingCompatRouter.get('/purchase_events', bridge(marketingRouter, '/forms'));
marketingCompatRouter.post('/purchase_events', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.put('/purchase_events/:id', (_req, res) => ok(res, { updated: true }));
marketingCompatRouter.delete('/purchase_events/:id', bridge(marketingRouter, (req) => `/forms/events/${req.params.id}`));
marketingCompatRouter.get('/otp_profiles', bridge(marketingRouter, '/forms/otp/audit'));
marketingCompatRouter.post('/otp_profiles', (_req, res) => ok(res, { created: true }, '', 201));
marketingCompatRouter.put('/otp_profiles/:id', (_req, res) => ok(res, { updated: true }));
marketingCompatRouter.delete('/otp_profiles/:id', (_req, res) => ok(res, { deleted: true }));

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
                thumbnail_url, image_url, video_id, creative_body, creative_title, call_to_action,
                effective_status, spend, impressions, clicks, leads_count, date_start
         FROM meta_ads_insights
         WHERE tenant_id = $1 AND ad_id = $2
         ORDER BY date_start DESC NULLS LAST
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
      return { found: true, ...r.rows[0] };
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

marketingCompatRouter.get('/meta_customers', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.post('/meta_customers', bridge(marketingRouter, '/social-bot/conversations'));

// ---- /automation/*.php legacy endpoints ----
marketingCompatRouter.all('/automation/ses_quota.php', bridge(marketingRouter, '/campaigns/ses-quota'));
marketingCompatRouter.get('/automation/meta_config.php', bridge(marketingCompatRouter, '/meta_config'));
marketingCompatRouter.post('/automation/meta_config.php', bridge(marketingCompatRouter, '/meta_config'));
marketingCompatRouter.get('/automation/settings.php', bridge(marketingCompatRouter, '/settings'));
marketingCompatRouter.post('/automation/settings.php', bridge(marketingCompatRouter, '/settings'));
marketingCompatRouter.all('/automation/overview_stats.php', bridge(marketingRouter, '/overview'));
marketingCompatRouter.all(
  '/automation/campaigns.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    const route = String(req.query?.route ?? req.body?.route ?? '').trim().toLowerCase();
    if (method === 'POST') {
      if (route === 'pre_send_review') return { router: marketingRouter, path: '/campaigns/pre-send-review' };
      if (route === 'estimate_reach') return { router: marketingRouter, path: '/campaigns/estimate-reach' };
      if (route === 'test_email') return { router: marketingRouter, path: '/campaigns/test-email' };
      if (route === 'send' && id) return { router: marketingRouter, path: `/campaigns/${encodeURIComponent(id)}/send` };
      return { router: marketingRouter, path: '/campaigns' };
    }
    if (method === 'GET' && id) {
      return { router: marketingRouter, path: `/campaigns/${encodeURIComponent(id)}/detail` };
    }
    return {
      router: marketingRouter,
      path: id ? `/campaigns/${encodeURIComponent(id)}` : '/campaigns',
    };
  })
);
marketingCompatRouter.all(
  '/automation/flows.php',
  forwardBridge((req) => {
    const id = phpId(req);
    return { router: marketingRouter, path: id ? `/flows/${encodeURIComponent(id)}` : '/flows' };
  })
);
marketingCompatRouter.all(
  '/automation/forms.php',
  forwardBridge((req) => {
    const id = phpId(req);
    return { router: marketingRouter, path: id ? `/forms/${encodeURIComponent(id)}` : '/forms' };
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
  '/automation/segments.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    if (isSegmentPreviewReq(req)) {
      return { router: audiencesRouter, path: '/preview' };
    }
    return {
      router: audiencesRouter,
      path: id ? `/${encodeURIComponent(id)}` : '/',
      method: method === 'PUT' && id ? 'PATCH' : undefined,
    };
  })
);
marketingCompatRouter.all(
  '/automation/lists.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    return {
      router: audiencesRouter,
      path: id ? `/${encodeURIComponent(id)}` : '/',
      method: method === 'PUT' && id ? 'PATCH' : undefined,
    };
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
  '/automation/subscribers.php',
  forwardBridge(() => ({ router: audiencesRouter, path: '/contacts' }))
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
marketingCompatRouter.all('/automation/otp_profiles.php', bridge(marketingRouter, '/forms/otp/audit'));
marketingCompatRouter.all('/automation/custom_events.php', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.all('/automation/purchase_events.php', bridge(marketingRouter, '/forms/events'));
marketingCompatRouter.get('/automation/zalo_oa.php', bridge(marketingRouter, '/social-bot/zalo-oa'));
marketingCompatRouter.post('/automation/zalo_oa.php', bridge(marketingRouter, '/social-bot/zalo-oa', { method: 'PUT' }));
marketingCompatRouter.all('/automation/zalo_automation.php', bridge(marketingRouter, '/social-bot/scenarios'));
marketingCompatRouter.all('/automation/zalo_templates.php', bridge(marketingRouter, '/social-bot/zalo-templates'));
marketingCompatRouter.get('/automation/zalo_broadcast.php', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.post('/automation/zalo_broadcast.php', bridge(marketingRouter, '/social-bot/zalo-broadcast'));
marketingCompatRouter.all('/automation/zalo_audience.php', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.all('/automation/ai_scenarios.php', bridge(marketingRouter, '/social-bot/scenarios'));
marketingCompatRouter.all('/automation/ai_chatbots.php', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.all('/automation/ai_chatbot.php', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.all(
  '/automation/web_tracking.php',
  forwardBridge((req) => {
    const method = String(req.method || 'GET').toUpperCase();
    const id = phpId(req);
    if (method === 'POST') return { router: marketingRouter, path: '/web-tracking/properties' };
    if (method === 'DELETE' && id) return { router: marketingRouter, path: `/web-tracking/properties/${encodeURIComponent(id)}` };
    return { router: marketingRouter, path: '/web-tracking' };
  })
);
marketingCompatRouter.all('/automation/ai_training.php', bridge(marketingRouter, '/social-bot/training-docs'));
marketingCompatRouter.all('/automation/:slug', bridge(marketingRouter, '/overview'));

// ---- Config, Connections, Search, Upload, Export ----
marketingCompatRouter.get(
  '/tenant-config',
  handler('COMPAT_TENANT_CONFIG', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [meta, stages, teamsRes, wfRes] = await Promise.all([
        getTenantMetaCached(ctx.tenantId, client),
        client.query('SELECT * FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC', [ctx.tenantId]),
        client.query('SELECT id, name, leader_user_id FROM tenant_teams WHERE tenant_id = $1 ORDER BY name ASC', [ctx.tenantId]),
        client
          .query('SELECT id, code, name, category, category_label, default_watcher_ids, default_watcher_roles, is_active FROM tenant_approval_workflows WHERE tenant_id = $1 ORDER BY created_at ASC', [ctx.tenantId])
          .catch(() => ({ rows: [] as any[] })),
      ]);
      const raw = (meta?.rawSettings || {}) as Record<string, unknown>;
      const settings = meta?.settings || (await getTenantSettingsCached(ctx.tenantId, client));
      const mergedSettings = {
        ...raw,
        ...settings,
        brand_display_name: settings.brand_display_name || String(raw.company_name || meta?.name || ''),
        company_name: String(raw.company_name || settings.brand_display_name || meta?.name || ''),
      };
      return {
        tenant_id: ctx.tenantId,
        tenant_slug: ctx.tenantSlug,
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
    const saved = await tx(async (client, ctx) => {
      const r = await client.query<{ slug: string; settings: unknown }>(
        'SELECT slug, settings FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      const cur = safeParseObj(r.rows[0]?.settings);
      const next = { ...cur, ...incoming };
      await client.query('UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1', [
        ctx.tenantId,
        JSON.stringify(next),
      ]);
      if (r.rows[0]?.slug) {
        tenantRedis.invalidateTenantCache(ctx.tenantId, r.rows[0].slug);
      }
      return next;
    });
    ok(res, { saved: true, settings: saved });
  })
);
marketingCompatRouter.get(
  '/integrations',
  requirePermission('integrations_crm', 'view'),
  handler('COMPAT_INTEGRATIONS', async (_req, res) => {
    const rows = await tx(async (client, ctx) => {
      const r = await client.query(
        'SELECT id, name, type, source_key, is_active, created_at FROM connections WHERE tenant_id = $1 ORDER BY created_at DESC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    ok(res, rows);
  })
);
marketingCompatRouter.post('/integrations', (_req, res) => ok(res, { saved: true }));
marketingCompatRouter.put('/integrations', (_req, res) => ok(res, { saved: true }));
marketingCompatRouter.delete('/integrations', (_req, res) => ok(res, { deleted: true }));
marketingCompatRouter.get('/system_connections', bridge(marketingCompatRouter, '/integrations'));
marketingCompatRouter.get('/system_audit_logs', (_req, res) => ok(res, listPayload([], 0, 1, 50)));
marketingCompatRouter.get('/overview_stats', bridge(marketingRouter, '/overview'));

marketingCompatRouter.get('/search', bridge(erpOpsRouter, '/global-search'));
marketingCompatRouter.get('/search/global', bridge(erpOpsRouter, '/global-search'));
marketingCompatRouter.post('/import/process', (_req, res) => ok(res, { imported: 0 }));
marketingCompatRouter.get('/upload', (_req, res) => ok(res, listPayload([], 0, 1, 20)));
marketingCompatRouter.post('/upload', (_req, res) => ok(res, { url: '', uploaded: true }));
marketingCompatRouter.post('/delete_attachment', (_req, res) => ok(res, { deleted: true }));

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
    const result = await tx(async (client, ctx) => {
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

      await switchTenantSaasPackageInTx(client, ctx.tenantId, ctx.userId, {
        package_code: targetPkg as (typeof VALID_PACKAGE_CODES)[number],
        education_addon: b.education_addon !== undefined ? Boolean(b.education_addon) : undefined,
        industry_key: typeof b.industry_key === 'string' && b.industry_key.trim() ? b.industry_key.trim() : undefined,
        note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : '1-click package upgrade',
      });
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
        payload: {
          upgraded: true,
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
        },
      };
    });

    if (result.error === 'TENANT_NOT_FOUND') {
      fail(res, 404, 'TENANT_NOT_FOUND', 'Tenant not found');
      return;
    }
    if (result.error === 'INVALID_PACKAGE_CODE') {
      fail(res, 400, 'INVALID_PACKAGE_CODE', `Unsupported package_code: ${result.targetPkg}`);
      return;
    }
    ok(res, result.payload);
  })
);
