import { Router } from 'express';
import { router as marketingRouter } from '../../modules/marketing/index.ts';
import { audiencesRouter } from '../../modules/audiences/index.ts';
import { router as erpOpsRouter } from '../../modules/erp-ops/index.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  bridge,
  handler,
  listPayload,
  ok,
  qstr,
  requirePermission,
  tx,
} from './shared.ts';

export const marketingCompatRouter = Router();

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
marketingCompatRouter.get('/ses_quota:rest', bridge(marketingRouter, '/campaigns/ses-quota'));

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
marketingCompatRouter.post('/segments', bridge(audiencesRouter, '/'));
marketingCompatRouter.put('/segments/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`, { method: 'PATCH' }));
marketingCompatRouter.delete('/segments', bridge(audiencesRouter, (req) => `/${qstr(req, 'id') || ''}`));
marketingCompatRouter.delete('/segments/:id', bridge(audiencesRouter, (req) => `/${req.params.id}`));

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

marketingCompatRouter.get('/marketing/meta/overview', bridge(marketingRouter, '/overview'));
marketingCompatRouter.get('/meta_config', (_req, res) => ok(res, {}));
marketingCompatRouter.get('/meta_customers', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.post('/meta_customers', bridge(marketingRouter, '/social-bot/conversations'));

// ---- /automation/*.php legacy endpoints ----
marketingCompatRouter.all('/automation/campaigns.php', bridge(marketingRouter, '/campaigns'));
marketingCompatRouter.all('/automation/flows.php', bridge(marketingRouter, '/flows'));
marketingCompatRouter.all('/automation/forms.php', bridge(marketingRouter, '/forms'));
marketingCompatRouter.all('/automation/surveys.php', bridge(marketingRouter, '/surveys'));
marketingCompatRouter.all('/automation/templates.php', bridge(marketingRouter, '/templates'));
marketingCompatRouter.all('/automation/segments.php', bridge(audiencesRouter, '/'));
marketingCompatRouter.all('/automation/lists.php', bridge(audiencesRouter, '/'));
marketingCompatRouter.all('/automation/zalo_oa.php', bridge(marketingRouter, '/social-bot/zalo-oa'));
marketingCompatRouter.all('/automation/zalo_automation.php', bridge(marketingRouter, '/social-bot/scenarios'));
marketingCompatRouter.all('/automation/zalo_audience.php', bridge(marketingRouter, '/social-bot'));
marketingCompatRouter.all('/automation/web_tracking.php', bridge(marketingRouter, '/web-tracking'));
marketingCompatRouter.all('/automation/ai_training.php', bridge(marketingRouter, '/social-bot/training-docs'));
marketingCompatRouter.all('/automation/:slug', bridge(marketingRouter, '/overview'));

// ---- Config, Connections, Search, Upload, Export ----
marketingCompatRouter.get(
  '/tenant-config',
  handler('COMPAT_TENANT_CONFIG', async (_req, res) => {
    const data = await tx(async (client, ctx) => {
      const [settings, stages] = await Promise.all([
        getTenantSettingsCached(ctx.tenantId, client),
        client.query('SELECT * FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC', [ctx.tenantId]),
      ]);
      return { settings, pipeline_stages: stages.rows };
    });
    ok(res, data);
  })
);
marketingCompatRouter.get('/settings', bridge(marketingCompatRouter, '/tenant-config'));
marketingCompatRouter.post('/settings', (_req, res) => ok(res, { saved: true }));
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
