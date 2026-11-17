import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireEntitlement,
  requireTenantAuth,
  sendApiError,
} from '../../core/security/rbac.ts';
import { ensureMarketingSchema } from './schema.ts';
import { registerFlowEventListeners } from './flow-engine.service.ts';
import { templatesRouter } from './templates.routes.ts';
import { formsRouter } from './forms.routes.ts';
import { surveysRouter } from './surveys.routes.ts';
import { campaignsRouter } from './campaigns.routes.ts';
import { flowsRouter } from './flows.routes.ts';
import { vouchersRouter } from './vouchers.routes.ts';
import { webTrackingRouter } from './web-tracking.routes.ts';
import { socialBotRouter } from './social-bot.routes.ts';

export const router = Router();

// Top-level Self-Initializing Multi-Tenant Schema & Event-Bus Registration
router.use(async (_req, res, next) => {
  try {
    await ensureMarketingSchema();
    registerFlowEventListeners();
    next();
  } catch (err: any) {
    sendApiError(res, 500, 'MARKETING_SCHEMA_INIT_FAILED', err?.message || 'Không thể khởi tạo schema Marketing.');
  }
});

// Strict Multi-Tenant Authentication + Package Entitlement Gate (`autodata_crm` -> 403 MODULE_NOT_ENTITLED)
router.use(requireTenantAuth);
router.use(requireEntitlement('dashboard_marketing'));

// Cross-module Marketing Overview KPIs
router.get('/overview', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tplCnt, formCnt, srvCnt, campStats, flowStats, voucherStats, webStats, socialStats] = await Promise.all([
        client.query<{ cnt: number }>(
          "SELECT COUNT(*)::int AS cnt FROM mkt_email_templates WHERE tenant_id = $1 AND status != 'archived'",
          [ctx.tenantId]
        ),
        client.query<{ cnt: number; subs: number }>(
          `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(submission_count), 0)::int AS subs
           FROM mkt_forms WHERE tenant_id = $1 AND status != 'archived'`,
          [ctx.tenantId]
        ),
        client.query<{ cnt: number; resps: number }>(
          `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(response_count), 0)::int AS resps
           FROM mkt_surveys WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ cnt: number; sent: number; opened: number; clicked: number; rev: number }>(
          `SELECT COUNT(*)::int AS cnt,
                  COALESCE(SUM(sent_count), 0)::int AS sent,
                  COALESCE(SUM(opened_count), 0)::int AS opened,
                  COALESCE(SUM(clicked_count), 0)::int AS clicked,
                  COALESCE(SUM(attributed_revenue_vnd), 0)::bigint AS rev
           FROM mkt_campaigns WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ active_cnt: number; enrolled: number; pushed: number }>(
          `SELECT COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0)::int AS active_cnt,
                  COALESCE(SUM(enrolled_count), 0)::int AS enrolled,
                  COALESCE(SUM(pushed_to_sale_count), 0)::int AS pushed
           FROM mkt_flows WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ total: number; redeemed: number }>(
          `SELECT COALESCE(SUM(total_codes), 0)::int AS total,
                  COALESCE(SUM(redeemed_codes), 0)::int AS redeemed
           FROM mkt_voucher_campaigns WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ sessions: number; pricing: number }>(
          `SELECT COUNT(*)::int AS sessions,
                  COALESCE(SUM(CASE WHEN pricing_intent_detected = true THEN 1 ELSE 0 END), 0)::int AS pricing
           FROM mkt_web_sessions WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ convs: number }>(
          'SELECT COUNT(*)::int AS convs FROM mkt_social_conversations WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
      ]);

      return {
        templates_count: Number(tplCnt.rows[0]?.cnt || 0),
        forms_count: Number(formCnt.rows[0]?.cnt || 0),
        form_submissions: Number(formCnt.rows[0]?.subs || 0),
        surveys_count: Number(srvCnt.rows[0]?.cnt || 0),
        survey_responses: Number(srvCnt.rows[0]?.resps || 0),
        campaigns_count: Number(campStats.rows[0]?.cnt || 0),
        emails_sent: Number(campStats.rows[0]?.sent || 0),
        emails_opened: Number(campStats.rows[0]?.opened || 0),
        emails_clicked: Number(campStats.rows[0]?.clicked || 0),
        attributed_revenue_vnd: Number(campStats.rows[0]?.rev || 0),
        active_flows: Number(flowStats.rows[0]?.active_cnt || 0),
        flow_enrollments: Number(flowStats.rows[0]?.enrolled || 0),
        flow_pushed_to_sale: Number(flowStats.rows[0]?.pushed || 0),
        vouchers_issued: Number(voucherStats.rows[0]?.total || 0),
        vouchers_redeemed: Number(voucherStats.rows[0]?.redeemed || 0),
        web_sessions: Number(webStats.rows[0]?.sessions || 0),
        pricing_intent_alerts: Number(webStats.rows[0]?.pricing || 0),
        social_conversations: Number(socialStats.rows[0]?.convs || 0),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'MARKETING_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan Marketing.');
  }
});

router.use('/templates', templatesRouter);
router.use('/forms', formsRouter);
router.use('/surveys', surveysRouter);
router.use('/campaigns', campaignsRouter);
router.use('/flows', flowsRouter);
router.use('/vouchers', vouchersRouter);
router.use('/web-tracking', webTrackingRouter);
router.use('/social-bot', socialBotRouter);

export default router;
