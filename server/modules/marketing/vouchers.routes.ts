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
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import { parseCsvTextToRows, upsertMasterContactInTx } from '../audiences/audiences.service.ts';
import {
  canUserUnmaskMarketingPii,
  generateShortCode,
  parseJsonCol,
  slugifyMarketingKey,
} from './utils.ts';

export const vouchersRouter = Router();

vouchersRouter.use(requireEntitlement('mkt_vouchers'));

function mapVoucherPoolRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name || ''),
    slug: String(row.slug || ''),
    description: row.description ? String(row.description) : '',
    code_prefix: String(row.code_prefix || 'DOM'),
    discount_type: String(row.discount_type || 'percentage') as 'percentage' | 'fixed_vnd' | 'gift',
    discount_value: Number(row.discount_value || 0),
    min_order_vnd: Number(row.min_order_vnd || 0),
    max_uses_per_code: Number(row.max_uses_per_code || 1),
    expires_at: row.expires_at || null,
    status: String(row.status || 'active'),
    total_codes: Number(row.total_codes || 0),
    claimed_codes: Number(row.claimed_codes || 0),
    redeemed_codes: Number(row.redeemed_codes || 0),
    qr_design: parseJsonCol<Record<string, unknown>>(row.qr_design_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapShortLinkRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    title: String(row.title || ''),
    short_code: String(row.short_code || ''),
    target_url: String(row.target_url || ''),
    custom_domain: row.custom_domain ? String(row.custom_domain) : '',
    utm_source: row.utm_source ? String(row.utm_source) : '',
    utm_medium: row.utm_medium ? String(row.utm_medium) : '',
    utm_campaign: row.utm_campaign ? String(row.utm_campaign) : '',
    qr_design: parseJsonCol<Record<string, unknown>>(row.qr_design_json, {}),
    click_count: Number(row.click_count || 0),
    unique_click_count: Number(row.unique_click_count || 0),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
  };
}

// LinkClicksTab: Geo / Device / UTM / Referrer Breakdown across Shortlinks
vouchersRouter.get('/clicks-analytics', requirePermission('mkt_vouchers', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const shortLinkId = req.query.short_link_id ? String(req.query.short_link_id).trim() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT c.*, sl.title AS short_link_title, sl.short_code
        FROM mkt_short_link_clicks c
        INNER JOIN mkt_short_links sl ON sl.tenant_id = c.tenant_id AND sl.id = c.short_link_id
        WHERE c.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (shortLinkId) {
        params.push(shortLinkId);
        sql += ` AND c.short_link_id = $2`;
      }
      sql += ` ORDER BY c.clicked_at DESC LIMIT 400`;

      const clicksRes = await client.query(sql, params);
      const byDevice: Record<string, number> = {};
      const byUtmSource: Record<string, number> = {};
      const byReferrer: Record<string, number> = {};
      const uniqueVisitors = new Set<string>();

      const recentClicks = clicksRes.rows.map((r) => {
        const dev = String(r.device_type || 'desktop');
        byDevice[dev] = (byDevice[dev] || 0) + 1;
        const utm = parseJsonCol<Record<string, unknown>>(r.utm_json, {});
        const src = String(utm.utm_source || 'direct');
        byUtmSource[src] = (byUtmSource[src] || 0) + 1;
        const ref = r.referrer ? String(r.referrer).replace(/^https?:\/\//i, '').split('/')[0] : 'Trực tiếp / QR';
        byReferrer[ref] = (byReferrer[ref] || 0) + 1;
        const visitorKey = utm.visitor_hash
          ? `vh:${String(utm.visitor_hash)}`
          : r.lead_id
            ? `lead:${String(r.lead_id)}`
            : r.client_ip
              ? `ip:${String(r.client_ip)}`
              : '';
        if (visitorKey) uniqueVisitors.add(visitorKey);
        return {
          ...r,
          utm,
        };
      });

      return {
        total_clicks: recentClicks.length,
        unique_visitors: Math.max(uniqueVisitors.size, recentClicks.length > 0 ? 1 : 0),
        by_device: Object.entries(byDevice).map(([device, count]) => ({ device, count })),
        by_utm_source: Object.entries(byUtmSource)
          .map(([source, count]) => ({ source, count }))
          .sort((a, b) => b.count - a.count),
        by_referrer: Object.entries(byReferrer)
          .map(([referrer, count]) => ({ referrer, count }))
          .sort((a, b) => b.count - a.count),
        recent_clicks: recentClicks.slice(0, 60),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'CLICKS_ANALYTICS_FAILED', err?.message || 'Không thể tải thống kê lượt nhấp Shortlink.');
  }
});

// List Voucher Pools + Shortlinks
vouchersRouter.get('/', requirePermission('mkt_vouchers', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [poolsRes, linksRes] = await Promise.all([
        client.query('SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 ORDER BY created_at DESC', [
          ctx.tenantId,
        ]),
        client.query('SELECT * FROM mkt_short_links WHERE tenant_id = $1 ORDER BY created_at DESC', [
          ctx.tenantId,
        ]),
      ]);

      return {
        items: poolsRes.rows.map(mapVoucherPoolRow),
        shortlinks: linksRes.rows.map(mapShortLinkRow),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_VOUCHERS_FAILED', err?.message || 'Không thể tải danh sách Voucher & Shortlink.');
  }
});

// Create Voucher Pool + Optional Auto-Generate Batch of Prefix Codes
vouchersRouter.post('/', requirePermission('mkt_vouchers', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const name = String(req.body?.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VOUCHER_NAME_REQUIRED', 'Vui lòng nhập tên Chiến dịch Voucher.');
      return;
    }

    const slug = `${slugifyMarketingKey(name, 'voucher')}-${crypto.randomBytes(2).toString('hex')}`;
    const rawPrefix = String(req.body?.code_prefix || 'DOM')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (req.body?.code_prefix !== undefined && rawPrefix.length < 2) {
      sendApiError(res, 422, 'INVALID_CODE_PREFIX', 'Tiền tố mã Voucher cần tối thiểu 2 ký tự chữ/số (A-Z, 0-9).');
      return;
    }
    const codePrefix = rawPrefix.slice(0, 14) || 'DOM';
    const discountType =
      req.body?.discount_type === 'fixed_vnd'
        ? 'fixed_vnd'
        : req.body?.discount_type === 'gift'
          ? 'gift'
          : 'percentage';
    const discountValue = Math.max(0, Math.round(Number(req.body?.discount_value ?? 10)));
    if (discountType === 'percentage' && discountValue > 100) {
      sendApiError(res, 422, 'INVALID_DISCOUNT_PERCENTAGE', 'Mức giảm phần trăm (%) không được vượt quá 100%.');
      return;
    }
    const minOrderVnd = Math.max(0, Math.round(Number(req.body?.min_order_vnd ?? 0)));
    const maxUsesPerCode = Math.min(10000, Math.max(1, Math.round(Number(req.body?.max_uses_per_code ?? 1))));
    const initialBatchCount = Math.min(500, Math.max(0, Math.round(Number(req.body?.auto_generate_count ?? 10))));
    let expiresAt: string | null = null;
    if (req.body?.expires_at) {
      const parsedExp = new Date(String(req.body.expires_at));
      if (Number.isNaN(parsedExp.getTime())) {
        sendApiError(res, 422, 'INVALID_EXPIRY_DATE', 'Ngày hết hạn Voucher không hợp lệ.');
        return;
      }
      expiresAt = parsedExp.toISOString();
    }
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const qrDesign =
      req.body?.qr_design && typeof req.body.qr_design === 'object'
        ? req.body.qr_design
        : { fgColor: '#1E40FF', bgColor: '#FFFFFF', cornerRadius: 12, logoUrl: '/imgs/autodata/ICON.png' };

    const poolId = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_voucher_campaigns (
           id, tenant_id, name, slug, description, code_prefix, discount_type,
           discount_value, min_order_vnd, max_uses_per_code, expires_at, status, total_codes, qr_design_json, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, 'active', 0, $12::jsonb, $13
         )`,
        [
          poolId,
          ctx.tenantId,
          name,
          slug,
          description,
          codePrefix,
          discountType,
          discountValue,
          minOrderVnd,
          maxUsesPerCode,
          expiresAt,
          JSON.stringify(qrDesign),
          ctx.userId,
        ]
      );

      let generated = 0;
      for (let i = 0; i < initialBatchCount; i++) {
        const code = `${codePrefix}-${generateShortCode(6).toUpperCase()}`;
        await client.query(
          `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status)
           VALUES ($1, $2, $3, $4, 'available')
           ON CONFLICT (tenant_id, code) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, poolId, code]
        );
        generated++;
      }

      if (generated > 0) {
        const cntRes = await client.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM mkt_voucher_codes WHERE tenant_id = $1 AND voucher_campaign_id = $2',
          [ctx.tenantId, poolId]
        );
        await client.query(
          'UPDATE mkt_voucher_campaigns SET total_codes = $3 WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, poolId, Number(cntRes.rows[0]?.cnt || 0)]
        );
      }

      const r = await client.query('SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        poolId,
      ]);
      return mapVoucherPoolRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_VOUCHER_POOL_FAILED', err?.message || 'Không thể khởi tạo Chiến dịch Voucher.');
  }
});

// List Codes & 360° Lead Redemption Log for a Pool
vouchersRouter.get('/:id/codes', requirePermission('mkt_vouchers', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const poolRes = await client.query(
        'SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      if (!poolRes.rows[0]) return null;

      const canUnmask = await canUserUnmaskMarketingPii(client, ctx.tenantId, ctx.userId);
      const codesRes = await client.query(
        `SELECT vc.*, l.name, l.phone, l.email
         FROM mkt_voucher_codes vc
         LEFT JOIN leads l ON l.tenant_id = vc.tenant_id AND l.id = vc.lead_id
         WHERE vc.tenant_id = $1 AND vc.voucher_campaign_id = $2
         ORDER BY vc.created_at DESC
         LIMIT 300`,
        [ctx.tenantId, req.params.id]
      );

      return {
        pool: mapVoucherPoolRow(poolRes.rows[0]),
        codes: codesRes.rows.map((r) => maskContactPiiIfDisallowed(r, canUnmask, cfg)),
      };
    });

    if (!data) {
      sendApiError(res, 404, 'VOUCHER_POOL_NOT_FOUND', 'Không tìm thấy Chiến dịch Voucher.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_VOUCHER_CODES_FAILED', err?.message || 'Không thể tải danh sách mã Voucher.');
  }
});

// Auto-Generate Additional Codes
vouchersRouter.post('/:id/generate', requirePermission('mkt_vouchers', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const count = Math.min(500, Math.max(1, Math.round(Number(req.body?.count || 20))));

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query(
        'SELECT id, code_prefix FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const pool = pRes.rows[0];
      if (!pool) return null;

      const overridePrefix = req.body?.prefix
        ? String(req.body.prefix).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14)
        : '';
      const prefix = overridePrefix || String(pool.code_prefix || 'DOM').toUpperCase();
      const createdCodes: string[] = [];
      for (let i = 0; i < count; i++) {
        const code = `${prefix}-${generateShortCode(6).toUpperCase()}`;
        const ins = await client.query(
          `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status)
           VALUES ($1, $2, $3, $4, 'available')
           ON CONFLICT (tenant_id, code) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, pool.id, code]
        );
        if ((ins.rowCount || 0) > 0) {
          createdCodes.push(code);
        }
      }

      const cntRes = await client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM mkt_voucher_codes WHERE tenant_id = $1 AND voucher_campaign_id = $2',
        [ctx.tenantId, pool.id]
      );
      const total = Number(cntRes.rows[0]?.cnt || 0);
      await client.query(
        'UPDATE mkt_voucher_campaigns SET total_codes = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, pool.id, total]
      );

      return { generated_count: createdCodes.length, total_codes: total, sample_codes: createdCodes.slice(0, 10) };
    });

    if (!out) {
      sendApiError(res, 404, 'VOUCHER_POOL_NOT_FOUND', 'Không tìm thấy Chiến dịch Voucher.');
      return;
    }
    res.status(201).json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'GENERATE_CODES_FAILED', err?.message || 'Không thể sinh thêm mã Voucher.');
  }
});

// Import External Voucher Codes via CSV
vouchersRouter.post('/:id/import-csv', requirePermission('mkt_vouchers', 'import'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const csvText = String(req.body?.csv_text || '').trim();
    const parsed = parseCsvTextToRows(csvText);
    const rawList: string[] = Array.isArray(req.body?.codes)
      ? req.body.codes.map((x: unknown) => String(x || '').trim().toUpperCase()).filter(Boolean)
      : parsed
          .map((row) => String(row.code || row.Code || row['Mã ưu đãi'] || Object.values(row)[0] || '').trim().toUpperCase())
          .filter(Boolean);

    if (rawList.length === 0) {
      sendApiError(res, 422, 'CSV_CODES_EMPTY', 'Không tìm thấy mã ưu đãi hợp lệ trong nội dung CSV.');
      return;
    }

    const out = await withTenantTransaction(ctx.tenantId, async (client) => {
      const pRes = await client.query(
        'SELECT id FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      if (!pRes.rows[0]) return null;

      for (const code of rawList.slice(0, 1000)) {
        await client.query(
          `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status)
           VALUES ($1, $2, $3, $4, 'available')
           ON CONFLICT (tenant_id, code) DO NOTHING`,
          [crypto.randomUUID(), ctx.tenantId, req.params.id, code]
        );
      }

      const cntRes = await client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM mkt_voucher_codes WHERE tenant_id = $1 AND voucher_campaign_id = $2',
        [ctx.tenantId, req.params.id]
      );
      const total = Number(cntRes.rows[0]?.cnt || 0);
      await client.query(
        'UPDATE mkt_voucher_campaigns SET total_codes = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, req.params.id, total]
      );

      return { imported_submitted: rawList.length, total_codes: total };
    });

    if (!out) {
      sendApiError(res, 404, 'VOUCHER_POOL_NOT_FOUND', 'Không tìm thấy Chiến dịch Voucher.');
      return;
    }
    res.json({ success: true, data: out });
  } catch (err: any) {
    sendApiError(res, 500, 'IMPORT_VOUCHER_CSV_FAILED', err?.message || 'Không thể nhập CSV mã Voucher.');
  }
});

// POS / Counter Quick Redeem + 360° Lead Timeline Log
vouchersRouter.post('/redeem', requirePermission('mkt_vouchers', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const code = String(req.body?.code || '').trim().toUpperCase();
    const rawOrderVnd = req.body?.order_vnd;
    let orderVnd = 0;
    if (rawOrderVnd !== undefined && rawOrderVnd !== null && String(rawOrderVnd).trim() !== '') {
      const parsedOrder = Number(rawOrderVnd);
      if (!Number.isFinite(parsedOrder) || parsedOrder < 0) {
        sendApiError(res, 422, 'INVALID_ORDER_AMOUNT', 'Giá trị đơn hàng không hợp lệ.');
        return;
      }
      orderVnd = Math.round(parsedOrder);
    }
    const note = req.body?.note ? String(req.body.note).trim() : 'Gạch mã trực tiếp tại quầy POS';

    if (!code) {
      sendApiError(res, 422, 'VOUCHER_CODE_REQUIRED', 'Vui lòng nhập mã Voucher cần đối soát / gạch mã.');
      return;
    }

    const txOut = await withTenantTransaction(ctx.tenantId, async (client) => {
      const codeRes = await client.query(
        `SELECT vc.*, p.name AS pool_name, p.discount_type, p.discount_value, p.min_order_vnd, p.expires_at, p.status AS pool_status
         FROM mkt_voucher_codes vc
         INNER JOIN mkt_voucher_campaigns p ON p.tenant_id = vc.tenant_id AND p.id = vc.voucher_campaign_id
         WHERE vc.tenant_id = $1 AND UPPER(vc.code) = $2
         LIMIT 1`,
        [ctx.tenantId, code]
      );
      const vc = codeRes.rows[0];
      if (!vc) {
        return { errorCode: 'CODE_NOT_FOUND', errorMessage: 'Mã Voucher không tồn tại trong hệ thống của doanh nghiệp.' };
      }
      if (String(vc.pool_status || '') !== 'active') {
        return { errorCode: 'POOL_INACTIVE', errorMessage: 'Chiến dịch Voucher này đã tạm dừng hoặc kết thúc.' };
      }
      if (vc.status === 'redeemed') {
        return { errorCode: 'CODE_ALREADY_REDEEMED', errorMessage: 'Mã Voucher này đã được sử dụng trước đó.' };
      }
      if (vc.expires_at && new Date(String(vc.expires_at)).getTime() < Date.now()) {
        return { errorCode: 'CODE_EXPIRED', errorMessage: 'Mã Voucher đã hết hạn hiệu lực.' };
      }
      if (Number(vc.min_order_vnd || 0) > 0 && orderVnd < Number(vc.min_order_vnd || 0)) {
        return {
          errorCode: 'MIN_ORDER_NOT_MET',
          errorMessage: `Đơn hàng tối thiểu để áp dụng mã này là ${Number(vc.min_order_vnd).toLocaleString('vi-VN')}₫.`,
        };
      }

      let resolvedLeadId: string | null = vc.lead_id ? String(vc.lead_id) : null;
      if (!resolvedLeadId && (req.body?.phone || req.body?.email)) {
        const upserted = await upsertMasterContactInTx(
          client,
          ctx.tenantId,
          {
            name: req.body?.customer_name || req.body?.name,
            phone: req.body?.phone,
            email: req.body?.email,
          },
          {
            defaultStatus: 'marketing_nurture',
            defaultSource: `POS Voucher: ${vc.pool_name}`,
            dialCode: cfg.default_dial_code,
          }
        );
        resolvedLeadId = upserted.leadId;
      }

      const updRes = await client.query(
        `UPDATE mkt_voucher_codes
         SET status = 'redeemed',
             lead_id = COALESCE($3, lead_id),
             claimed_at = COALESCE(claimed_at, clock_timestamp()),
             redeemed_at = clock_timestamp(),
             redeemed_order_vnd = $4,
             redeemed_by_note = $5
         WHERE tenant_id = $1 AND id = $2 AND status != 'redeemed'`,
        [ctx.tenantId, vc.id, resolvedLeadId, orderVnd, note]
      );
      if ((updRes.rowCount || 0) === 0) {
        return { errorCode: 'CODE_ALREADY_REDEEMED', errorMessage: 'Mã Voucher này đã được sử dụng trước đó.' };
      }

      await client.query(
        `UPDATE mkt_voucher_campaigns
         SET redeemed_codes = redeemed_codes + 1,
             claimed_codes = claimed_codes + $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, vc.voucher_campaign_id, String(vc.status) === 'available' ? 1 : 0]
      );

      if (resolvedLeadId) {
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'voucher_redeemed', 'communication', $4, 'tenant_admin', $5, $6, $7, $8::jsonb)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            resolvedLeadId,
            ctx.userId,
            ctx.userName || 'POS Counter',
            `Sử dụng mã ưu đãi ${code} (${vc.pool_name})`,
            note,
            JSON.stringify({ code, voucher_campaign_id: vc.voucher_campaign_id, order_vnd: orderVnd }),
          ]
        );
      }

      const discountValNum = Number(vc.discount_value || 0);
      const discountAmountVnd =
        vc.discount_type === 'percentage'
          ? Math.round((orderVnd * Math.min(100, Math.max(0, discountValNum))) / 100)
          : vc.discount_type === 'fixed_vnd'
            ? Math.min(orderVnd > 0 ? orderVnd : discountValNum, discountValNum)
            : 0;
      const finalOrderVnd = Math.max(0, orderVnd - discountAmountVnd);

      return {
        errorCode: null,
        code,
        pool_name: vc.pool_name,
        discount_type: vc.discount_type,
        discount_value: discountValNum,
        discount_amount_vnd: discountAmountVnd,
        final_order_vnd: finalOrderVnd,
        lead_id: resolvedLeadId,
        order_vnd: orderVnd,
        redeemed_at: new Date().toISOString(),
      };
    });

    if (txOut.errorCode) {
      sendApiError(res, 400, txOut.errorCode, txOut.errorMessage || 'Không thể gạch mã Voucher.');
      return;
    }

    if (txOut.lead_id) {
      await emitDomainEvent('marketing.engaged', {
        tenantId: ctx.tenantId,
        leadId: txOut.lead_id,
        engagementType: 'voucher_redeemed',
        channel: 'voucher',
        scoreDelta: 15,
        metadata: { code: txOut.code, orderVnd },
      });
    }

    res.json({ success: true, data: txOut });
  } catch (err: any) {
    sendApiError(res, 500, 'REDEEM_VOUCHER_FAILED', err?.message || 'Không thể gạch mã Voucher.');
  }
});

// Update Voucher Pool (`VoucherCampaignModal` & `QRDesignerModal`)
vouchersRouter.put('/:id', requirePermission('mkt_vouchers', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query(
        'SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const ex = exRes.rows[0];
      if (!ex) return null;

      const name = req.body?.name !== undefined ? String(req.body.name).trim() : String(ex.name);
      const description =
        req.body?.description !== undefined ? String(req.body.description).trim() : ex.description;
      const discountType =
        req.body?.discount_type && ['percentage', 'fixed_vnd', 'gift'].includes(String(req.body.discount_type))
          ? String(req.body.discount_type)
          : String(ex.discount_type);
      const discountValue =
        req.body?.discount_value !== undefined
          ? Math.max(0, Math.round(Number(req.body.discount_value)))
          : Number(ex.discount_value || 0);
      const minOrderVnd =
        req.body?.min_order_vnd !== undefined
          ? Math.max(0, Math.round(Number(req.body.min_order_vnd)))
          : Number(ex.min_order_vnd || 0);
      const maxUsesPerCode =
        req.body?.max_uses_per_code !== undefined
          ? Math.max(1, Math.round(Number(req.body.max_uses_per_code)))
          : Number(ex.max_uses_per_code || 1);
      const expiresAt =
        req.body?.expires_at !== undefined
          ? req.body.expires_at
            ? String(req.body.expires_at)
            : null
          : ex.expires_at;
      const status = req.body?.status !== undefined ? String(req.body.status) : String(ex.status);
      const qrDesign =
        req.body?.qr_design && typeof req.body.qr_design === 'object'
          ? req.body.qr_design
          : parseJsonCol(ex.qr_design_json, {});

      await client.query(
        `UPDATE mkt_voucher_campaigns
         SET name = $3,
             description = $4,
             discount_type = $5,
             discount_value = $6,
             min_order_vnd = $7,
             max_uses_per_code = $8,
             expires_at = $9,
             status = $10,
             qr_design_json = $11::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          name,
          description,
          discountType,
          discountValue,
          minOrderVnd,
          maxUsesPerCode,
          expiresAt,
          status,
          JSON.stringify(qrDesign),
        ]
      );

      const r = await client.query('SELECT * FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return mapVoucherPoolRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'VOUCHER_POOL_NOT_FOUND', 'Không tìm thấy Chiến dịch Voucher.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_VOUCHER_POOL_FAILED', err?.message || 'Không thể cập nhật Chiến dịch Voucher.');
  }
});

vouchersRouter.delete('/:id', requirePermission('mkt_vouchers', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_VOUCHER_POOL_FAILED', err?.message || 'Không thể xóa Chiến dịch Voucher.');
  }
});

// ============================================================================
// Shortlink Tracker & Branded QR Designer (`/api/v1/marketing/vouchers/shortlinks`)
// ============================================================================
vouchersRouter.post('/shortlinks', requirePermission('mkt_vouchers', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const title = String(req.body?.title || '').trim();
    const targetUrl = String(req.body?.target_url || '').trim();
    if (!title || !/^https?:\/\//i.test(targetUrl)) {
      sendApiError(res, 422, 'INVALID_SHORTLINK', 'Vui lòng nhập tiêu đề và URL đích hợp lệ (bắt đầu bằng http/https).');
      return;
    }

    const customCode = String(req.body?.short_code || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 40);
    const shortCode = customCode || generateShortCode(7);
    const customDomain = req.body?.custom_domain ? String(req.body.custom_domain).trim() : null;
    const utmSource = req.body?.utm_source ? String(req.body.utm_source).trim() : null;
    const utmMedium = req.body?.utm_medium ? String(req.body.utm_medium).trim() : null;
    const utmCampaign = req.body?.utm_campaign ? String(req.body.utm_campaign).trim() : null;
    const qrDesign =
      req.body?.qr_design && typeof req.body.qr_design === 'object'
        ? req.body.qr_design
        : {
            fgColor: '#1E40FF',
            bgColor: '#FFFFFF',
            cornerRadius: 12,
            logoUrl: '/imgs/autodata/ICON.png',
          };

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO mkt_short_links (
           id, tenant_id, title, short_code, target_url, custom_domain,
           utm_source, utm_medium, utm_campaign, qr_design_json, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
          id,
          ctx.tenantId,
          title,
          shortCode,
          targetUrl,
          customDomain,
          utmSource,
          utmMedium,
          utmCampaign,
          JSON.stringify(qrDesign),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_short_links WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return mapShortLinkRow(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SHORTLINK_FAILED', err?.message || 'Không thể tạo Shortlink & Mã QR.');
  }
});

vouchersRouter.put('/shortlinks/:id', requirePermission('mkt_vouchers', 'edit'), async (req, res) => {
  try {
    if (req.body?.target_url !== undefined && !/^https?:\/\//i.test(String(req.body.target_url || '').trim())) {
      sendApiError(res, 422, 'INVALID_SHORTLINK', 'Vui lòng nhập tiêu đề và URL đích hợp lệ (bắt đầu bằng http/https).');
      return;
    }
    if (req.body?.title !== undefined && !String(req.body.title || '').trim()) {
      sendApiError(res, 422, 'INVALID_SHORTLINK', 'Vui lòng nhập tiêu đề và URL đích hợp lệ (bắt đầu bằng http/https).');
      return;
    }
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const exRes = await client.query('SELECT * FROM mkt_short_links WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const ex = exRes.rows[0];
      if (!ex) return null;

      const title = req.body?.title !== undefined ? String(req.body.title).trim() : String(ex.title);
      const targetUrl = req.body?.target_url !== undefined ? String(req.body.target_url).trim() : String(ex.target_url);
      const customDomain =
        req.body?.custom_domain !== undefined
          ? req.body.custom_domain
            ? String(req.body.custom_domain).trim()
            : null
          : ex.custom_domain;
      const utmSource =
        req.body?.utm_source !== undefined
          ? req.body.utm_source
            ? String(req.body.utm_source).trim()
            : null
          : ex.utm_source;
      const utmMedium =
        req.body?.utm_medium !== undefined
          ? req.body.utm_medium
            ? String(req.body.utm_medium).trim()
            : null
          : ex.utm_medium;
      const utmCampaign =
        req.body?.utm_campaign !== undefined
          ? req.body.utm_campaign
            ? String(req.body.utm_campaign).trim()
            : null
          : ex.utm_campaign;
      const isActive = req.body?.is_active !== undefined ? Boolean(req.body.is_active) : Boolean(ex.is_active);
      const qrDesign =
        req.body?.qr_design && typeof req.body.qr_design === 'object'
          ? req.body.qr_design
          : parseJsonCol(ex.qr_design_json, {});

      await client.query(
        `UPDATE mkt_short_links
         SET title = $3,
             target_url = $4,
             qr_design_json = $5::jsonb,
             custom_domain = $6,
             utm_source = $7,
             utm_medium = $8,
             utm_campaign = $9,
             is_active = $10,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          req.params.id,
          title,
          targetUrl,
          JSON.stringify(qrDesign),
          customDomain,
          utmSource,
          utmMedium,
          utmCampaign,
          isActive,
        ]
      );
      const r = await client.query('SELECT * FROM mkt_short_links WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      return mapShortLinkRow(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'SHORTLINK_NOT_FOUND', 'Không tìm thấy Shortlink.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_SHORTLINK_FAILED', err?.message || 'Không thể cập nhật Shortlink.');
  }
});

vouchersRouter.delete('/shortlinks/:id', requirePermission('mkt_vouchers', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM mkt_short_links WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_SHORTLINK_FAILED', err?.message || 'Không thể xóa Shortlink.');
  }
});
