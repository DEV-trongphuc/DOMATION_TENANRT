import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  requireEntitlement,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import {
  canUserUnmaskMarketingPii,
  generatePublicToken,
  parseJsonCol,
} from './utils.ts';

export const webTrackingRouter = Router();

webTrackingRouter.use(requireEntitlement('mkt_web_tracking'));

// List Tracked Web Properties + Live Sessions KPI + Pricing Intent Alerts
webTrackingRouter.get('/', requirePermission('mkt_web_tracking', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [propsRes, audRes, kpiRes] = await Promise.all([
        client.query(
          `SELECT p.*, a.name AS target_audience_name
           FROM mkt_web_properties p
           LEFT JOIN tenant_audiences a ON a.tenant_id = p.tenant_id AND a.id = p.target_audience_id
           WHERE p.tenant_id = $1
           ORDER BY p.created_at DESC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, audience_type
           FROM tenant_audiences
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY name ASC`,
          [ctx.tenantId]
        ),
        client.query<{
          total_sessions: number;
          stitched_sessions: number;
          pricing_intents: number;
          total_events: number;
        }>(
          `SELECT COUNT(*)::int AS total_sessions,
                  COALESCE(SUM(CASE WHEN lead_id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS stitched_sessions,
                  COALESCE(SUM(CASE WHEN pricing_intent_detected = true THEN 1 ELSE 0 END), 0)::int AS pricing_intents,
                  COALESCE(SUM(pageviews_count), 0)::int AS total_events
           FROM mkt_web_sessions
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
      ]);

      return {
        properties: propsRes.rows,
        audiences: audRes.rows,
        summary: {
          total_sessions: Number(kpiRes.rows[0]?.total_sessions || 0),
          identified_leads: Number(kpiRes.rows[0]?.stitched_sessions || 0),
          pricing_intent_alerts: Number(kpiRes.rows[0]?.pricing_intents || 0),
          total_pageviews: Number(kpiRes.rows[0]?.total_events || 0),
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_WEB_TRACKING_FAILED', err?.message || 'Không thể tải cấu hình Web Tracking.');
  }
});

// Create Web Property
webTrackingRouter.post('/properties', requirePermission('mkt_web_tracking', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    const domain = String(req.body?.domain || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    if (!name || !domain) {
      sendApiError(res, 422, 'PROPERTY_NAME_DOMAIN_REQUIRED', 'Vui lòng nhập tên Website và tên miền theo dõi.');
      return;
    }

    const pricingPattern = String(req.body?.pricing_url_pattern || '/pricing,/bang-gia,/bao-gia').trim();
    const targetAudienceId = req.body?.target_audience_id ? String(req.body.target_audience_id) : null;
    const autoAlertPricing = Boolean(req.body?.auto_alert_pricing ?? true);

    const id = crypto.randomUUID();
    const siteKey = generatePublicToken('dom_site');

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_web_properties (
           id, tenant_id, name, domain, site_key, pricing_url_pattern,
           target_audience_id, auto_alert_pricing, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
        [
          id,
          ctx.tenantId,
          name,
          domain,
          siteKey,
          pricingPattern,
          targetAudienceId,
          autoAlertPricing,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_web_properties WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_WEB_PROPERTY_FAILED', err?.message || 'Không thể thêm Website theo dõi.');
  }
});

// Live Sessions Table (with Visitor-to-Lead Identity Stitching & Server PII Masking)
webTrackingRouter.get('/sessions', requirePermission('mkt_web_tracking', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const propertyId = req.query.property_id ? String(req.query.property_id) : null;
    const onlyPricingIntent = req.query.pricing_intent === 'true';

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      let sql = `
        SELECT s.*, p.name AS property_name, p.domain AS property_domain,
               l.name, l.phone, l.email, l.lead_score, l.status AS lead_status
        FROM mkt_web_sessions s
        INNER JOIN mkt_web_properties p ON p.tenant_id = s.tenant_id AND p.id = s.property_id
        LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
        WHERE s.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (propertyId) {
        params.push(propertyId);
        sql += ` AND s.property_id = $${params.length}`;
      }
      if (onlyPricingIntent) {
        sql += ` AND s.pricing_intent_detected = true`;
      }
      sql += ` ORDER BY s.last_seen_at DESC LIMIT 150`;

      const r = await client.query(sql, params);
      return r.rows.map((row) => maskContactPiiIfDisallowed(row, canUnmask, cfg));
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_WEB_SESSIONS_FAILED', err?.message || 'Không thể tải danh sách phiên truy cập.');
  }
});

// Visual Click & Scroll Heatmap Data
webTrackingRouter.get('/heatmap', requirePermission('mkt_web_tracking', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const propertyId = req.query.property_id ? String(req.query.property_id) : null;
    const pageUrl = req.query.page_url ? String(req.query.page_url).trim() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT id, event_type, page_url, element_selector, x_pct, y_pct, scroll_depth_pct, metadata, created_at
        FROM mkt_web_events
        WHERE tenant_id = $1 AND event_type IN ('click', 'scroll')
      `;
      const params: unknown[] = [ctx.tenantId];
      if (propertyId) {
        params.push(propertyId);
        sql += ` AND property_id = $${params.length}`;
      }
      if (pageUrl) {
        params.push(`%${pageUrl}%`);
        sql += ` AND page_url ILIKE $${params.length}`;
      }
      sql += ` ORDER BY created_at DESC LIMIT 500`;

      const [eventsRes, pagesRes] = await Promise.all([
        client.query(sql, params),
        client.query<{ page_url: string; cnt: number }>(
          `SELECT page_url, COUNT(*)::int AS cnt
           FROM mkt_web_events
           WHERE tenant_id = $1
           GROUP BY page_url
           ORDER BY cnt DESC
           LIMIT 30`,
          [ctx.tenantId]
        ),
      ]);

      const clickPoints = eventsRes.rows
        .filter((e) => e.event_type === 'click' && e.x_pct !== null && e.y_pct !== null)
        .map((e) => ({
          id: String(e.id),
          x_pct: Number(e.x_pct),
          y_pct: Number(e.y_pct),
          element_selector: e.element_selector ? String(e.element_selector) : 'element',
          page_url: String(e.page_url),
        }));

      const scrollEvents = eventsRes.rows.filter(
        (e) => e.event_type === 'scroll' && e.scroll_depth_pct !== null
      );
      const buckets = { pct25: 0, pct50: 0, pct75: 0, pct100: 0 };
      for (const s of scrollEvents) {
        const d = Number(s.scroll_depth_pct || 0);
        if (d >= 25) buckets.pct25++;
        if (d >= 50) buckets.pct50++;
        if (d >= 75) buckets.pct75++;
        if (d >= 95) buckets.pct100++;
      }
      const denom = Math.max(1, scrollEvents.length);

      return {
        click_points: clickPoints,
        scroll_reach_pct: {
          depth_25: scrollEvents.length ? Math.round((buckets.pct25 / denom) * 100) : 0,
          depth_50: scrollEvents.length ? Math.round((buckets.pct50 / denom) * 100) : 0,
          depth_75: scrollEvents.length ? Math.round((buckets.pct75 / denom) * 100) : 0,
          depth_100: scrollEvents.length ? Math.round((buckets.pct100 / denom) * 100) : 0,
        },
        tracked_pages: pagesRes.rows.map((p) => ({
          page_url: String(p.page_url),
          event_count: Number(p.cnt || 0),
        })),
        recent_events: eventsRes.rows.slice(0, 30).map((e) => ({
          ...e,
          metadata: parseJsonCol(e.metadata, {}),
        })),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'HEATMAP_QUERY_FAILED', err?.message || 'Không thể tải dữ liệu Heatmap.');
  }
});

webTrackingRouter.delete('/properties/:id', requirePermission('mkt_web_tracking', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_web_properties WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_WEB_PROPERTY_FAILED', err?.message || 'Không thể xóa Website theo dõi.');
  }
});
