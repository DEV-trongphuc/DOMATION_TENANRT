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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const rawPropertyId = String(req.query.property_id || req.query.id || '').trim();
    const propertyId = rawPropertyId || null;
    const pageUrl = String(req.query.page_url || req.query.url || '').trim();
    const rawDevice = String(req.query.device || '').trim().toLowerCase();
    const deviceFilter = rawDevice && rawDevice !== 'all' ? rawDevice : null;

    if (propertyId && !UUID_REGEX.test(propertyId)) {
      res.json({
        success: true,
        data: {
          click_points: [],
          scroll_reach_pct: { depth_25: 0, depth_50: 0, depth_75: 0, depth_100: 0 },
          tracked_pages: [],
          recent_events: [],
        },
      });
      return;
    }

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let joinSql = '';
      let whereSql = `e.tenant_id = $1 AND e.event_type IN ('click', 'outbound_click', 'scroll')`;

      if (deviceFilter) {
        params.push(deviceFilter);
        joinSql = `INNER JOIN mkt_web_sessions s ON s.tenant_id = e.tenant_id AND s.id = e.session_id`;
        whereSql += ` AND LOWER(COALESCE(s.device_type, 'desktop')) = $${params.length}`;
      }
      if (propertyId) {
        params.push(propertyId);
        whereSql += ` AND e.property_id = $${params.length}`;
      }
      if (pageUrl) {
        params.push(`%${pageUrl.toLowerCase()}%`);
        whereSql += ` AND LOWER(e.page_url) LIKE $${params.length}`;
      }

      const sql = `
        SELECT e.id, e.event_type, e.page_url, e.element_selector, e.x_pct, e.y_pct,
               e.scroll_depth_pct, e.metadata, e.created_at
        FROM mkt_web_events e
        ${joinSql}
        WHERE ${whereSql}
        ORDER BY e.created_at DESC
        LIMIT 500
      `;

      const pageParams: unknown[] = [ctx.tenantId];
      let pageJoinSql = '';
      let pageWhereSql = 'e.tenant_id = $1';
      if (propertyId) {
        pageParams.push(propertyId);
        pageWhereSql += ` AND e.property_id = $${pageParams.length}`;
      }
      if (deviceFilter) {
        pageParams.push(deviceFilter);
        pageJoinSql = `INNER JOIN mkt_web_sessions s ON s.tenant_id = e.tenant_id AND s.id = e.session_id`;
        pageWhereSql += ` AND LOWER(COALESCE(s.device_type, 'desktop')) = $${pageParams.length}`;
      }

      const [eventsRes, pagesRes] = await Promise.all([
        client.query(sql, params),
        client.query<{ page_url: string; cnt: number }>(
          `SELECT e.page_url, COUNT(*)::int AS cnt
           FROM mkt_web_events e
           ${pageJoinSql}
           WHERE ${pageWhereSql}
           GROUP BY e.page_url
           ORDER BY cnt DESC
           LIMIT 30`,
          pageParams
        ),
      ]);

      const clickPoints = eventsRes.rows
        .filter((e) => (e.event_type === 'click' || e.event_type === 'outbound_click') && e.x_pct !== null && e.y_pct !== null)
        .map((e) => {
          const meta = parseJsonCol<Record<string, unknown>>(e.metadata, {});
          return {
            id: String(e.id),
            x_pct: Number(e.x_pct),
            y_pct: Number(e.y_pct),
            element_selector: e.element_selector ? String(e.element_selector) : 'element',
            element_text: String(meta.element_text || meta.text || '').trim() || null,
            element_tag: meta.element_tag ? String(meta.element_tag) : null,
            href: meta.href ? String(meta.href) : null,
            data_cta: meta.data_cta ? String(meta.data_cta) : null,
            page_url: String(e.page_url),
          };
        });

      const ctaCounts = new Map<string, { element_text: string; element_selector: string; href: string | null; count: number }>();
      for (const cp of clickPoints) {
        const label = cp.element_text || cp.element_selector;
        const key = `${label}|${cp.element_selector}`;
        const prev = ctaCounts.get(key);
        if (prev) prev.count += 1;
        else ctaCounts.set(key, { element_text: label, element_selector: cp.element_selector, href: cp.href, count: 1 });
      }

      const scrollEvents = eventsRes.rows.filter(
        (e) => e.event_type === 'scroll' && e.scroll_depth_pct !== null
      );
      const buckets = { pct25: 0, pct50: 0, pct75: 0, pct90: 0, pct100: 0 };
      for (const s of scrollEvents) {
        const d = Number(s.scroll_depth_pct || 0);
        if (d >= 25) buckets.pct25++;
        if (d >= 50) buckets.pct50++;
        if (d >= 75) buckets.pct75++;
        if (d >= 90) buckets.pct90++;
        if (d >= 95) buckets.pct100++;
      }
      const denom = Math.max(1, scrollEvents.length);

      return {
        click_points: clickPoints,
        top_ctas: Array.from(ctaCounts.values()).sort((a, b) => b.count - a.count).slice(0, 15),
        scroll_reach_pct: {
          depth_25: scrollEvents.length ? Math.round((buckets.pct25 / denom) * 100) : 0,
          depth_50: scrollEvents.length ? Math.round((buckets.pct50 / denom) * 100) : 0,
          depth_75: scrollEvents.length ? Math.round((buckets.pct75 / denom) * 100) : 0,
          depth_90: scrollEvents.length ? Math.round((buckets.pct90 / denom) * 100) : 0,
          depth_100: scrollEvents.length ? Math.round((buckets.pct100 / denom) * 100) : 0,
        },
        tracked_pages: pagesRes.rows.map((p) => ({
          page_url: String(p.page_url),
          event_count: Number(p.cnt || 0),
        })),
        recent_events: eventsRes.rows.slice(0, 30).map((e) => {
          const meta = parseJsonCol<Record<string, unknown>>(e.metadata, {});
          return {
            ...e,
            element_text: meta.element_text || meta.text || null,
            href: meta.href || null,
            active_duration_seconds: Number(meta.active_duration_seconds || meta.duration_seconds || 0),
            metadata: meta,
          };
        }),
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

// VisitorsTab: Detailed Visitor Session Timeline + GeoIP + UTMs + Stitched Lead
webTrackingRouter.get('/visitors/:sessionId', requirePermission('mkt_web_tracking', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const sRes = await client.query(
        `SELECT s.*, p.name AS property_name, p.domain AS property_domain,
                l.name, l.phone, l.email, l.lead_score, l.status AS lead_status, l.lifecycle_stage
         FROM mkt_web_sessions s
         INNER JOIN mkt_web_properties p ON p.tenant_id = s.tenant_id AND p.id = s.property_id
         LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
         WHERE s.tenant_id = $1 AND s.id = $2
         LIMIT 1`,
        [ctx.tenantId, req.params.sessionId]
      );
      if (!sRes.rows[0]) return null;

      const evRes = await client.query(
        `SELECT id, lead_id, event_type, page_url, element_selector, x_pct, y_pct, scroll_depth_pct, metadata, created_at
         FROM mkt_web_events
         WHERE tenant_id = $1 AND session_id = $2
         ORDER BY created_at ASC
         LIMIT 250`,
        [ctx.tenantId, req.params.sessionId]
      );

      let maxScrollPct = 0;
      let ctaClicksCount = 0;
      let eventDurationSum = 0;
      const mappedEvents = evRes.rows.map((e) => {
        const meta = parseJsonCol<Record<string, unknown>>(e.metadata, {});
        const evDur = Number(meta.active_duration_seconds || meta.duration_seconds || 0);
        if (Number.isFinite(evDur) && evDur > 0) eventDurationSum += Math.min(1800, evDur);
        const sd = e.scroll_depth_pct !== null && e.scroll_depth_pct !== undefined
          ? Number(e.scroll_depth_pct)
          : Number(meta.max_scroll_pct || meta.percent || 0);
        if (Number.isFinite(sd) && sd > maxScrollPct) maxScrollPct = Math.min(100, Math.round(sd));
        if (e.event_type === 'click' || e.event_type === 'outbound_click') ctaClicksCount++;
        return {
          ...e,
          element_text: meta.element_text || meta.text || null,
          element_tag: meta.element_tag || null,
          href: meta.href || null,
          data_cta: meta.data_cta || null,
          active_duration_seconds: evDur,
          metadata: meta,
        };
      });

      const sessionMasked = maskContactPiiIfDisallowed(sRes.rows[0], canUnmask, cfg);
      const activeDurationSec = Math.max(Number(sRes.rows[0].duration_seconds || 0), eventDurationSum);

      return {
        session: {
          ...sessionMasked,
          active_duration_seconds: activeDurationSec,
          max_scroll_pct: maxScrollPct,
          cta_clicks_count: ctaClicksCount,
        },
        events: mappedEvents,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên truy cập Website.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'VISITOR_DETAIL_FAILED', err?.message || 'Không thể tải hành trình khách truy cập.');
  }
});

// LiveTrafficModal: Real-Time Active Visitors, Page Velocity & Geo/Device Breakdown
webTrackingRouter.get('/live-traffic', requirePermission('mkt_web_tracking', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const [recentSessRes, topPagesRes] = await Promise.all([
        client.query(
          `SELECT s.*, p.domain AS property_domain, l.name, l.phone, l.email
           FROM mkt_web_sessions s
           INNER JOIN mkt_web_properties p ON p.tenant_id = s.tenant_id AND p.id = s.property_id
           LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
           WHERE s.tenant_id = $1
           ORDER BY s.last_seen_at DESC
           LIMIT 50`,
          [ctx.tenantId]
        ),
        client.query<{ page_url: string; cnt: number }>(
          `SELECT page_url, COUNT(*)::int AS cnt
           FROM mkt_web_events
           WHERE tenant_id = $1
           GROUP BY page_url
           ORDER BY cnt DESC
           LIMIT 10`,
          [ctx.tenantId]
        ),
      ]);

      const cutoff30m = Date.now() - 30 * 60_000;
      const activeSessions = recentSessRes.rows.filter(
        (s) => new Date(String(s.last_seen_at)).getTime() >= cutoff30m
      );
      const byCountry: Record<string, number> = {};
      const byDevice: Record<string, number> = {};

      for (const s of recentSessRes.rows) {
        const c = String(s.geo_country || 'VN');
        byCountry[c] = (byCountry[c] || 0) + 1;
        const d = String(s.device_type || 'desktop');
        byDevice[d] = (byDevice[d] || 0) + 1;
      }

      return {
        active_now_count: activeSessions.length,
        recent_total_count: recentSessRes.rows.length,
        active_visitors: activeSessions.map((r) => maskContactPiiIfDisallowed(r, canUnmask, cfg)),
        top_pages: topPagesRes.rows.map((p) => ({ page_url: String(p.page_url), views: Number(p.cnt || 0) })),
        by_country: Object.entries(byCountry).map(([country, count]) => ({ country, count })),
        by_device: Object.entries(byDevice).map(([device, count]) => ({ device, count })),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIVE_TRAFFIC_FAILED', err?.message || 'Không thể tải lưu lượng truy cập trực tiếp.');
  }
});

// PageDetailsModal: Per-URL Views, Scroll Depth, Top Clicked Selectors & UTM Sources
webTrackingRouter.get('/page-details', requirePermission('mkt_web_tracking', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const targetUrl = String(req.query.page_url || '').trim();

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM mkt_web_events WHERE tenant_id = $1';
      const params: unknown[] = [ctx.tenantId];
      if (targetUrl) {
        params.push(`%${targetUrl.toLowerCase()}%`);
        sql += ' AND LOWER(page_url) LIKE $2';
      }
      sql += ' ORDER BY created_at DESC LIMIT 400';

      const evRes = await client.query(sql, params);
      const uniqueSess = new Set<string>();
      const uniqueLeads = new Set<string>();
      const selectorCounts: Record<string, number> = {};
      const ctaMap = new Map<string, { element_text: string; element_selector: string; href: string | null; count: number }>();
      const scrollBuckets = { d25: 0, d50: 0, d75: 0, d90: 0, d100: 0 };
      let pageviews = 0;
      let clicks = 0;
      let outboundClicks = 0;
      let formFocusCount = 0;
      let scrollSum = 0;
      let scrollCnt = 0;
      let activeDurSum = 0;
      let activeDurCnt = 0;

      for (const e of evRes.rows) {
        const meta = parseJsonCol<Record<string, unknown>>(e.metadata, {});
        if (e.session_id) uniqueSess.add(String(e.session_id));
        if (e.lead_id) uniqueLeads.add(String(e.lead_id));
        if (e.event_type === 'pageview' || e.event_type === 'pricing_intent') pageviews++;
        if (e.event_type === 'outbound_click') outboundClicks++;
        if (e.event_type === 'form_focus') formFocusCount++;
        if (e.event_type === 'click' || e.event_type === 'outbound_click') {
          clicks++;
          const sel = String(e.element_selector || 'ELEMENT');
          const elText = String(meta.element_text || meta.text || '').trim();
          const href = meta.href ? String(meta.href) : null;
          selectorCounts[elText || sel] = (selectorCounts[elText || sel] || 0) + 1;
          const ctaKey = `${elText || sel}|${sel}`;
          const prev = ctaMap.get(ctaKey);
          if (prev) prev.count += 1;
          else ctaMap.set(ctaKey, { element_text: elText || sel, element_selector: sel, href, count: 1 });
        }
        if (e.scroll_depth_pct !== null && e.scroll_depth_pct !== undefined) {
          const sd = Number(e.scroll_depth_pct);
          scrollSum += sd;
          scrollCnt++;
          if (sd >= 25) scrollBuckets.d25++;
          if (sd >= 50) scrollBuckets.d50++;
          if (sd >= 75) scrollBuckets.d75++;
          if (sd >= 90) scrollBuckets.d90++;
          if (sd >= 95) scrollBuckets.d100++;
        }
        const evDur = Number(meta.active_duration_seconds || meta.duration_seconds || 0);
        if (Number.isFinite(evDur) && evDur > 0) {
          activeDurSum += Math.min(1800, evDur);
          activeDurCnt++;
        }
      }

      const scrollDenom = Math.max(1, scrollCnt);
      return {
        page_url: targetUrl || 'Tất cả trang',
        pageviews,
        clicks,
        outbound_clicks: outboundClicks,
        form_focus_count: formFocusCount,
        unique_sessions: uniqueSess.size,
        identified_leads: uniqueLeads.size,
        avg_scroll_depth_pct: scrollCnt > 0 ? Math.round(scrollSum / scrollCnt) : 0,
        avg_active_duration_seconds: activeDurCnt > 0 ? Math.round(activeDurSum / activeDurCnt) : 0,
        scroll_distribution: {
          depth_25: scrollCnt > 0 ? Math.round((scrollBuckets.d25 / scrollDenom) * 100) : 0,
          depth_50: scrollCnt > 0 ? Math.round((scrollBuckets.d50 / scrollDenom) * 100) : 0,
          depth_75: scrollCnt > 0 ? Math.round((scrollBuckets.d75 / scrollDenom) * 100) : 0,
          depth_90: scrollCnt > 0 ? Math.round((scrollBuckets.d90 / scrollDenom) * 100) : 0,
          depth_100: scrollCnt > 0 ? Math.round((scrollBuckets.d100 / scrollDenom) * 100) : 0,
        },
        top_ctas: Array.from(ctaMap.values())
          .sort((a, b) => b.count - a.count)
          .slice(0, 15),
        top_elements: Object.entries(selectorCounts)
          .map(([selector, count]) => ({ selector, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 12),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PAGE_DETAILS_FAILED', err?.message || 'Không thể tải phân tích chi tiết trang.');
  }
});

// Coordinate DOM Heatmaps (`mkt_web_heatmaps`) CRUD
webTrackingRouter.get('/heatmaps', requirePermission('mkt_web_tracking', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT h.*, p.name AS property_name, p.domain AS property_domain
         FROM mkt_web_heatmaps h
         LEFT JOIN mkt_web_properties p ON p.tenant_id = h.tenant_id AND p.id = h.property_id
         WHERE h.tenant_id = $1
         ORDER BY h.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        metadata: parseJsonCol(row.metadata_json, {}),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_HEATMAPS_FAILED', err?.message || 'Không thể tải danh sách bản đồ nhiệt.');
  }
});

webTrackingRouter.post('/heatmaps', requirePermission('mkt_web_tracking', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    const propertyId = String(req.body?.property_id || '').trim();
    if (!name || !propertyId) {
      sendApiError(res, 422, 'HEATMAP_FIELDS_REQUIRED', 'Vui lòng nhập tên Heatmap và chọn Website theo dõi.');
      return;
    }

    const pagePattern = String(req.body?.page_url_pattern || '/').trim();
    const deviceFilter = ['all', 'desktop', 'mobile'].includes(String(req.body?.device_filter || ''))
      ? String(req.body.device_filter)
      : 'all';
    const viewportWidth = Math.max(320, Math.round(Number(req.body?.viewport_width || (deviceFilter === 'mobile' ? 390 : 1440))));
    const viewportHeight = Math.max(480, Math.round(Number(req.body?.viewport_height || 900)));
    const snapshotHtml = req.body?.snapshot_html ? String(req.body.snapshot_html) : null;
    const id = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const clickParams: unknown[] = [ctx.tenantId, propertyId, `%${pagePattern.toLowerCase()}%`];
      let deviceJoinSql = '';
      if (deviceFilter !== 'all') {
        clickParams.push(deviceFilter);
        deviceJoinSql = `INNER JOIN mkt_web_sessions ws ON ws.tenant_id = e.tenant_id AND ws.id = e.session_id AND ws.device_type = $${clickParams.length}`;
      }
      const cntRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM mkt_web_events e
         ${deviceJoinSql}
         WHERE e.tenant_id = $1 AND e.property_id = $2 AND e.event_type = 'click' AND LOWER(e.page_url) LIKE $3`,
        clickParams
      );
      const clickCnt = Number(cntRes.rows[0]?.cnt || 0);

      const scrollRes = await client.query<{ avg_scroll: number }>(
        `SELECT COALESCE(ROUND(AVG(e.scroll_depth_pct)), 0)::int AS avg_scroll
         FROM mkt_web_events e
         ${deviceJoinSql}
         WHERE e.tenant_id = $1 AND e.property_id = $2 AND e.scroll_depth_pct IS NOT NULL AND LOWER(e.page_url) LIKE $3`,
        clickParams
      );
      const scrollAvgPct = Math.min(100, Math.max(0, Number(scrollRes.rows[0]?.avg_scroll || 0)));

      await client.query(
        `INSERT INTO mkt_web_heatmaps (
           id, tenant_id, property_id, name, page_url_pattern, device_filter,
           snapshot_html, viewport_width, viewport_height, click_count, scroll_avg_pct, is_active, metadata_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12::jsonb)`,
        [
          id,
          ctx.tenantId,
          propertyId,
          name,
          pagePattern,
          deviceFilter,
          snapshotHtml,
          viewportWidth,
          viewportHeight,
          clickCnt,
          scrollAvgPct,
          JSON.stringify(req.body?.metadata || {}),
        ]
      );
      const r = await client.query('SELECT * FROM mkt_web_heatmaps WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_HEATMAP_FAILED', err?.message || 'Không thể tạo cấu hình Heatmap.');
  }
});

webTrackingRouter.delete('/heatmaps/:id', requirePermission('mkt_web_tracking', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_web_heatmaps WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_HEATMAP_FAILED', err?.message || 'Không thể xóa Heatmap.');
  }
});

// ConversationsTab: Web Live-Chat Console with Visitor Browsed Page Trail
webTrackingRouter.get('/conversations', requirePermission('mkt_web_tracking', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const convRes = await client.query(
        `SELECT c.*, l.name AS lead_name, l.lead_score
         FROM mkt_social_conversations c
         LEFT JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
         WHERE c.tenant_id = $1 AND c.channel = 'web_chat'
         ORDER BY c.last_message_at DESC
         LIMIT 60`,
        [ctx.tenantId]
      );

      const items = [];
      for (const c of convRes.rows) {
        const [msgsRes, trailRes] = await Promise.all([
          client.query(
            `SELECT * FROM mkt_social_messages
             WHERE tenant_id = $1 AND conversation_id = $2
             ORDER BY created_at ASC
             LIMIT 100`,
            [ctx.tenantId, c.id]
          ),
          c.lead_id
            ? client.query(
                `SELECT page_url, event_type, created_at
                 FROM mkt_web_events
                 WHERE tenant_id = $1 AND lead_id = $2
                 ORDER BY created_at DESC
                 LIMIT 15`,
                [ctx.tenantId, c.lead_id]
              )
            : Promise.resolve({ rows: [] }),
        ]);

        const masked = maskContactPiiIfDisallowed(
          { ...c, phone: c.extracted_phone, email: c.extracted_email },
          canUnmask,
          cfg
        );

        items.push({
          ...c,
          extracted_phone: masked.phone,
          extracted_email: masked.email,
          messages: msgsRes.rows,
          page_trail: trailRes.rows,
        });
      }

      return { items };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'WEB_CHAT_CONVERSATIONS_FAILED', err?.message || 'Không thể tải hộp thư Live Chat Website.');
  }
});

webTrackingRouter.post('/conversations/:id/messages', requirePermission('mkt_web_tracking', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const content = String(req.body?.content || '').trim();
    if (!content) {
      sendApiError(res, 422, 'MESSAGE_REQUIRED', 'Vui lòng nhập nội dung phản hồi Live Chat.');
      return;
    }

    const msg = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cRes = await client.query(
        "SELECT id FROM mkt_social_conversations WHERE tenant_id = $1 AND id = $2 AND channel = 'web_chat' LIMIT 1",
        [ctx.tenantId, req.params.id]
      );
      if (!cRes.rows[0]) return null;

      const msgId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, sender_name, content, extracted_entities)
         VALUES ($1, $2, $3, 'agent', $4, $5, '{}'::jsonb)`,
        [msgId, ctx.tenantId, req.params.id, ctx.userName || 'Chuyên viên LiveChat', content]
      );
      await client.query(
        `UPDATE mkt_social_conversations
         SET last_message_preview = $3, unread_count = 0, last_message_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, req.params.id, content.slice(0, 200)]
      );
      const r = await client.query('SELECT * FROM mkt_social_messages WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        msgId,
      ]);
      return r.rows[0];
    });

    if (!msg) {
      sendApiError(res, 404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy phiên Live Chat.');
      return;
    }
    res.status(201).json({ success: true, data: msg });
  } catch (err: any) {
    sendApiError(res, 500, 'SEND_WEB_CHAT_FAILED', err?.message || 'Không thể gửi tin nhắn Live Chat.');
  }
});
