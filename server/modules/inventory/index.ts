import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  sendApiError,
} from '../../core/security/rbac.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import {
  clampLimit,
  deductFifoInventoryInTx,
  ensureErpOpsSchema,
  parseJsonSafe,
  recordRevenueAttributionOnOrderPaidInTx,
} from '../erp-ops/schema.ts';

export const router = Router();

router.use(requireTenantAuth);
router.use(requireEntitlement('inventory_assets'));
router.use(async (_req, _res, next) => {
  try {
    await ensureErpOpsSchema();
    next();
  } catch (err) {
    next(err);
  }
});

function computeAssetDepreciation(row: Record<string, any>) {
  const cost = Math.max(0, Number(row.purchase_cost_vnd || 0));
  const salvage = Math.min(cost, Math.max(0, Number(row.salvage_value_vnd || 0)));
  const usefulMonths = Math.max(1, Number(row.useful_life_months || 36));
  const depreciableBase = Math.max(0, cost - salvage);
  const monthlyDep = Math.round(depreciableBase / usefulMonths);

  const purchaseMs = row.purchase_date ? new Date(row.purchase_date).getTime() : Date.now();
  const elapsedMonths = Math.max(
    0,
    Math.floor((Date.now() - purchaseMs) / (30.4375 * 86_400_000))
  );
  const cappedMonths = Math.min(usefulMonths, elapsedMonths);
  const accumulated =
    cappedMonths >= usefulMonths ? depreciableBase : Math.min(depreciableBase, cappedMonths * monthlyDep);
  const netBookValue = Math.max(salvage, cost - accumulated);
  const depPct = depreciableBase > 0 ? Math.min(100, Math.round((accumulated / depreciableBase) * 100)) : 0;

  return {
    ...row,
    purchase_cost_vnd: cost,
    salvage_value_vnd: salvage,
    useful_life_months: usefulMonths,
    monthly_depreciation_vnd: monthlyDep,
    elapsed_months: cappedMonths,
    remaining_months: Math.max(0, usefulMonths - cappedMonths),
    accumulated_depreciation_vnd: accumulated,
    net_book_value_vnd: netBookValue,
    depreciation_pct: depPct,
  };
}

// ============================================================================
// 1. Inventory, FIFO Valuation & Fixed Assets Overview
// ============================================================================
router.get('/overview', requirePermission('inventory_assets', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [prodSum, batchSum, assetRows, whCount, supCount, openPosRes] = await Promise.all([
        client.query<{
          products_count: string | number;
          low_stock_count: string | number;
          total_units: string | number;
        }>(
          `SELECT COUNT(*)::int AS products_count,
                  COALESCE(SUM(CASE WHEN product_type = 'goods' AND cached_stock_qty <= min_stock_alert THEN 1 ELSE 0 END), 0) AS low_stock_count,
                  COALESCE(SUM(cached_stock_qty), 0) AS total_units
           FROM tenant_products
           WHERE tenant_id = $1 AND is_active = true`,
          [ctx.tenantId]
        ),
        client.query<{ active_batches: string | number; fifo_inventory_value_vnd: string | number }>(
          `SELECT COALESCE(SUM(CASE WHEN status = 'active' AND remaining_qty > 0 THEN 1 ELSE 0 END), 0) AS active_batches,
                  COALESCE(SUM(CASE WHEN status = 'active' AND remaining_qty > 0 THEN remaining_qty * unit_cost_vnd ELSE 0 END), 0) AS fifo_inventory_value_vnd
           FROM tenant_inventory_batches
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query('SELECT * FROM tenant_fixed_assets WHERE tenant_id = $1', [ctx.tenantId]),
        client.query<{ cnt: string | number }>(
          'SELECT COUNT(*)::int AS cnt FROM tenant_warehouses WHERE tenant_id = $1 AND is_active = true',
          [ctx.tenantId]
        ),
        client.query<{ cnt: string | number }>(
          'SELECT COUNT(*)::int AS cnt FROM tenant_suppliers WHERE tenant_id = $1 AND is_active = true',
          [ctx.tenantId]
        ),
        client.query(
          "SELECT * FROM tenant_pos_sessions WHERE tenant_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
          [ctx.tenantId]
        ),
      ]);

      const decoratedAssets = assetRows.rows.map(computeAssetDepreciation);
      const assetsOriginalCost = decoratedAssets.reduce((s, a) => s + a.purchase_cost_vnd, 0);
      const assetsNetBookValue = decoratedAssets.reduce((s, a) => s + a.net_book_value_vnd, 0);

      return {
        summary: {
          products_count: Number(prodSum.rows[0]?.products_count || 0),
          low_stock_count: Number(prodSum.rows[0]?.low_stock_count || 0),
          total_units: Number(prodSum.rows[0]?.total_units || 0),
          active_batches: Number(batchSum.rows[0]?.active_batches || 0),
          fifo_inventory_value_vnd: Number(batchSum.rows[0]?.fifo_inventory_value_vnd || 0),
          warehouses_count: Number(whCount.rows[0]?.cnt || 0),
          suppliers_count: Number(supCount.rows[0]?.cnt || 0),
          assets_count: decoratedAssets.length,
          assets_original_cost_vnd: assetsOriginalCost,
          assets_net_book_value_vnd: assetsNetBookValue,
        },
        active_pos_session: openPosRes.rows[0]
          ? {
              ...openPosRes.rows[0],
              opening_cash_vnd: Number(openPosRes.rows[0].opening_cash_vnd || 0),
              cash_sales_vnd: Number(openPosRes.rows[0].cash_sales_vnd || 0),
              bank_sales_vnd: Number(openPosRes.rows[0].bank_sales_vnd || 0),
              orders_count: Number(openPosRes.rows[0].orders_count || 0),
            }
          : null,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'INVENTORY_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan Kho FIFO & Tài sản.');
  }
});

// ============================================================================
// 2. Products (`ProductsPage`), Suppliers (`SuppliersPage` Dossier) & Warehouses
// ============================================================================
router.get('/products', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const limit = clampLimit(req.query.limit, 120, 300);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM tenant_products WHERE tenant_id = $1 AND is_active = true';
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;
      if (q) {
        sql += ` AND (LOWER(name) LIKE LOWER($${pIdx}) OR LOWER(sku) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(barcode, '')) LIKE LOWER($${pIdx}))`;
        params.push(`%${q}%`);
        pIdx++;
      }
      if (category && category !== 'all') {
        sql += ` AND category = $${pIdx}`;
        params.push(category);
        pIdx++;
      }
      sql += ` ORDER BY created_at DESC LIMIT ${limit}`;
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        sale_price_vnd: Number(row.sale_price_vnd || 0),
        default_cost_vnd: Number(row.default_cost_vnd || 0),
        tax_rate_pct: Number(row.tax_rate_pct || 0),
        cached_stock_qty: Number(row.cached_stock_qty || 0),
        min_stock_alert: Number(row.min_stock_alert || 0),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_PRODUCTS_FAILED', err?.message || 'Không thể tải danh mục Sản phẩm.');
  }
});

router.post('/products', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'PRODUCT_NAME_REQUIRED', 'Vui lòng nhập tên sản phẩm / SKU.');
      return;
    }

    const sku =
      String(body.sku || '').trim().toUpperCase() || `SKU-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_products (
           id, tenant_id, sku, barcode, name, category, unit, product_type,
           sale_price_vnd, default_cost_vnd, tax_rate_pct, min_stock_alert
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          ctx.tenantId,
          sku,
          body.barcode ? String(body.barcode).trim() : null,
          name,
          body.category ? String(body.category).trim() : 'general',
          body.unit ? String(body.unit).trim() : 'Cái',
          ['goods', 'service', 'bundle'].includes(String(body.product_type)) ? body.product_type : 'goods',
          Math.max(0, Math.round(Number(body.sale_price_vnd || 0))),
          Math.max(0, Math.round(Number(body.default_cost_vnd || 0))),
          Math.max(0, Number(body.tax_rate_pct || 0)),
          Math.max(0, Math.round(Number(body.min_stock_alert ?? 5))),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_products WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        sale_price_vnd: Number(r.rows[0].sale_price_vnd || 0),
        default_cost_vnd: Number(r.rows[0].default_cost_vnd || 0),
        tax_rate_pct: Number(r.rows[0].tax_rate_pct || 0),
        cached_stock_qty: Number(r.rows[0].cached_stock_qty || 0),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_PRODUCT_FAILED', err?.message || 'Không thể tạo sản phẩm mới.');
  }
});

router.patch('/products/:id', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const prodId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query('SELECT * FROM tenant_products WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        prodId,
      ]);
      if (!curRes.rows[0]) return null;
      const cur = curRes.rows[0];

      await client.query(
        `UPDATE tenant_products
         SET name = $3,
             barcode = $4,
             category = $5,
             unit = $6,
             sale_price_vnd = $7,
             default_cost_vnd = $8,
             tax_rate_pct = $9,
             min_stock_alert = $10,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          prodId,
          body.name !== undefined ? String(body.name).trim() : cur.name,
          body.barcode !== undefined ? (body.barcode ? String(body.barcode).trim() : null) : cur.barcode,
          body.category !== undefined ? String(body.category).trim() : cur.category,
          body.unit !== undefined ? String(body.unit).trim() : cur.unit,
          body.sale_price_vnd !== undefined ? Math.max(0, Math.round(Number(body.sale_price_vnd))) : Number(cur.sale_price_vnd || 0),
          body.default_cost_vnd !== undefined ? Math.max(0, Math.round(Number(body.default_cost_vnd))) : Number(cur.default_cost_vnd || 0),
          body.tax_rate_pct !== undefined ? Math.max(0, Number(body.tax_rate_pct)) : Number(cur.tax_rate_pct || 0),
          body.min_stock_alert !== undefined ? Math.max(0, Math.round(Number(body.min_stock_alert))) : Number(cur.min_stock_alert || 5),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_products WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        prodId,
      ]);
      return {
        ...r.rows[0],
        sale_price_vnd: Number(r.rows[0].sale_price_vnd || 0),
        default_cost_vnd: Number(r.rows[0].default_cost_vnd || 0),
        tax_rate_pct: Number(r.rows[0].tax_rate_pct || 0),
        cached_stock_qty: Number(r.rows[0].cached_stock_qty || 0),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'PRODUCT_NOT_FOUND', 'Không tìm thấy sản phẩm.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_PRODUCT_FAILED', err?.message || 'Không thể cập nhật sản phẩm.');
  }
});

router.get('/suppliers', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const tierFilter = typeof req.query.prestige_tier === 'string' ? req.query.prestige_tier.trim() : '';
    const coopFilter = typeof req.query.cooperation_status === 'string' ? req.query.cooperation_status.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT s.*,
               (SELECT COUNT(*)::int FROM tenant_purchase_orders po WHERE po.tenant_id = s.tenant_id AND po.supplier_id = s.id) AS po_count,
               (SELECT COALESCE(SUM(po.total_vnd), 0) FROM tenant_purchase_orders po WHERE po.tenant_id = s.tenant_id AND po.supplier_id = s.id AND po.status <> 'cancelled') AS total_po_vnd
        FROM tenant_suppliers s
        WHERE s.tenant_id = $1 AND s.is_active = true
      `;
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;
      if (tierFilter && tierFilter !== 'all') {
        sql += ` AND s.prestige_tier = $${pIdx}`;
        params.push(tierFilter);
        pIdx++;
      }
      if (coopFilter && coopFilter !== 'all') {
        sql += ` AND s.cooperation_status = $${pIdx}`;
        params.push(coopFilter);
        pIdx++;
      }
      if (q) {
        sql += ` AND (LOWER(s.name) LIKE LOWER($${pIdx}) OR LOWER(s.code) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(s.tax_code, '')) LIKE LOWER($${pIdx}))`;
        params.push(`%${q}%`);
        pIdx++;
      }
      sql += ' ORDER BY s.name ASC';
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        rating: Number(row.rating || 5),
        po_count: Number(row.po_count || 0),
        total_po_vnd: Number(row.total_po_vnd || 0),
        categories: parseJsonSafe(row.categories_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SUPPLIERS_FAILED', err?.message || 'Không thể tải danh sách Nhà cung cấp.');
  }
});

router.get('/suppliers/:id', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const supId = req.params.id;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const sRes = await client.query('SELECT * FROM tenant_suppliers WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        supId,
      ]);
      if (!sRes.rows[0]) return null;
      const [poRes, batchRes, invRes] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_purchase_orders WHERE tenant_id = $1 AND supplier_id = $2 ORDER BY created_at DESC LIMIT 50',
          [ctx.tenantId, supId]
        ),
        client.query(
          `SELECT b.*, p.name AS product_name, p.sku AS product_sku
           FROM tenant_inventory_batches b
           INNER JOIN tenant_products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
           WHERE b.tenant_id = $1 AND b.supplier_id = $2
           ORDER BY b.received_at DESC LIMIT 50`,
          [ctx.tenantId, supId]
        ),
        client.query(
          'SELECT * FROM tenant_invoices WHERE tenant_id = $1 AND supplier_id = $2 ORDER BY issue_date DESC LIMIT 50',
          [ctx.tenantId, supId]
        ),
      ]);

      return {
        ...sRes.rows[0],
        rating: Number(sRes.rows[0].rating || 5),
        categories: parseJsonSafe(sRes.rows[0].categories_json, []),
        purchase_orders: poRes.rows.map((p) => ({ ...p, total_vnd: Number(p.total_vnd || 0) })),
        batches: batchRes.rows.map((b) => ({
          ...b,
          initial_qty: Number(b.initial_qty || 0),
          remaining_qty: Number(b.remaining_qty || 0),
          unit_cost_vnd: Number(b.unit_cost_vnd || 0),
        })),
        invoices: invRes.rows.map((i) => ({ ...i, total_vnd: Number(i.total_vnd || 0) })),
      };
    });

    if (!data) {
      sendApiError(res, 404, 'SUPPLIER_NOT_FOUND', 'Không tìm thấy hồ sơ Nhà cung cấp.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_SUPPLIER_FAILED', err?.message || 'Không thể tải hồ sơ Nhà cung cấp.');
  }
});

router.post('/suppliers', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'SUPPLIER_NAME_REQUIRED', 'Vui lòng nhập tên nhà cung cấp.');
      return;
    }

    const code =
      String(body.code || '').trim().toUpperCase() || `SUP-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_suppliers (
           id, tenant_id, code, name, tax_code, contact_name, phone, email, address,
           payment_terms, rating, prestige_tier, cooperation_status, website,
           bank_name, bank_account_no, bank_account_holder, categories_json, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          body.tax_code ? String(body.tax_code).trim() : null,
          body.contact_name ? String(body.contact_name).trim() : null,
          body.phone ? String(body.phone).trim() : null,
          body.email ? String(body.email).trim() : null,
          body.address ? String(body.address).trim() : null,
          body.payment_terms ? String(body.payment_terms).trim() : 'Net 30',
          Math.min(5, Math.max(1, Math.round(Number(body.rating ?? 5)))),
          ['A', 'B', 'C'].includes(String(body.prestige_tier)) ? body.prestige_tier : 'A',
          ['active', 'negotiating', 'suspended'].includes(String(body.cooperation_status))
            ? body.cooperation_status
            : 'active',
          body.website ? String(body.website).trim() : null,
          body.bank_name ? String(body.bank_name).trim() : null,
          body.bank_account_no ? String(body.bank_account_no).trim() : null,
          body.bank_account_holder ? String(body.bank_account_holder).trim() : null,
          JSON.stringify(Array.isArray(body.categories) ? body.categories : []),
          body.notes ? String(body.notes) : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_suppliers WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SUPPLIER_FAILED', err?.message || 'Không thể tạo Nhà cung cấp.');
  }
});

router.patch('/suppliers/:id', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const supId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query('SELECT * FROM tenant_suppliers WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        supId,
      ]);
      if (!curRes.rows[0]) return null;
      const cur = curRes.rows[0];

      await client.query(
        `UPDATE tenant_suppliers
         SET name = $3,
             tax_code = $4,
             contact_name = $5,
             phone = $6,
             email = $7,
             address = $8,
             payment_terms = $9,
             prestige_tier = $10,
             cooperation_status = $11,
             bank_name = $12,
             bank_account_no = $13,
             bank_account_holder = $14,
             notes = $15,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          supId,
          body.name !== undefined ? String(body.name).trim() : cur.name,
          body.tax_code !== undefined ? body.tax_code : cur.tax_code,
          body.contact_name !== undefined ? body.contact_name : cur.contact_name,
          body.phone !== undefined ? body.phone : cur.phone,
          body.email !== undefined ? body.email : cur.email,
          body.address !== undefined ? body.address : cur.address,
          body.payment_terms !== undefined ? body.payment_terms : cur.payment_terms,
          body.prestige_tier || cur.prestige_tier || 'A',
          body.cooperation_status || cur.cooperation_status || 'active',
          body.bank_name !== undefined ? body.bank_name : cur.bank_name,
          body.bank_account_no !== undefined ? body.bank_account_no : cur.bank_account_no,
          body.bank_account_holder !== undefined ? body.bank_account_holder : cur.bank_account_holder,
          body.notes !== undefined ? body.notes : cur.notes,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_suppliers WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        supId,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'SUPPLIER_NOT_FOUND', 'Không tìm thấy Nhà cung cấp.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_SUPPLIER_FAILED', err?.message || 'Không thể cập nhật Nhà cung cấp.');
  }
});

router.get('/warehouses', requirePermission('inventory_assets', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query(
        'SELECT * FROM tenant_warehouses WHERE tenant_id = $1 AND is_active = true ORDER BY is_default DESC, name ASC',
        [ctx.tenantId]
      );
      if (existing.rows.length > 0) return existing.rows;

      const whId = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_warehouses (id, tenant_id, code, name, is_default, is_active)
         VALUES ($1, $2, 'WH-MAIN', 'Kho Trung Tâm Mặc Định', true, true)`,
        [whId, ctx.tenantId]
      );
      const r = await client.query('SELECT * FROM tenant_warehouses WHERE tenant_id = $1', [ctx.tenantId]);
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_WAREHOUSES_FAILED', err?.message || 'Không thể tải danh sách Kho hàng.');
  }
});

router.post('/warehouses', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'WAREHOUSE_NAME_REQUIRED', 'Vui lòng nhập tên kho.');
      return;
    }

    const code =
      String(body.code || '').trim().toUpperCase() || `WH-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_warehouses (id, tenant_id, code, name, branch_id, address, manager_user_id, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          body.branch_id || null,
          body.address ? String(body.address) : null,
          body.manager_user_id || ctx.userId,
          Boolean(body.is_default),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_warehouses WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_WAREHOUSE_FAILED', err?.message || 'Không thể tạo Kho hàng mới.');
  }
});

// ============================================================================
// 3. FIFO Inventory Batches, Multi-Warehouse Stock Adjust/Transfer & Movements
// ============================================================================
router.get('/batches', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const productId = typeof req.query.product_id === 'string' ? req.query.product_id.trim() : '';
    const warehouseId = typeof req.query.warehouse_id === 'string' ? req.query.warehouse_id.trim() : '';
    const limit = clampLimit(req.query.limit, 120, 300);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT b.*,
               p.name AS product_name,
               p.sku AS product_sku,
               p.unit AS product_unit,
               w.name AS warehouse_name,
               s.name AS supplier_name
        FROM tenant_inventory_batches b
        INNER JOIN tenant_products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
        LEFT JOIN tenant_warehouses w ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
        LEFT JOIN tenant_suppliers s ON s.tenant_id = b.tenant_id AND s.id = b.supplier_id
        WHERE b.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;
      if (productId) {
        sql += ` AND b.product_id = $${pIdx}`;
        params.push(productId);
        pIdx++;
      }
      if (warehouseId && warehouseId !== 'all') {
        sql += ` AND b.warehouse_id = $${pIdx}`;
        params.push(warehouseId);
        pIdx++;
      }
      sql += ` ORDER BY b.received_at ASC, b.created_at ASC LIMIT ${limit}`;
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        initial_qty: Number(row.initial_qty || 0),
        remaining_qty: Number(row.remaining_qty || 0),
        unit_cost_vnd: Number(row.unit_cost_vnd || 0),
      }));
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_BATCHES_FAILED', err?.message || 'Không thể tải danh sách Lô hàng FIFO.');
  }
});

router.post('/batches', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const productId = String(body.product_id || '').trim();
    const initialQty = Math.round(Number(body.initial_qty ?? body.quantity ?? 0));
    const unitCostVnd = Math.max(0, Math.round(Number(body.unit_cost_vnd ?? 0)));

    if (!productId || initialQty <= 0) {
      sendApiError(res, 422, 'BATCH_FIELDS_REQUIRED', 'Vui lòng chọn Sản phẩm và nhập số lượng nhập kho > 0.');
      return;
    }

    const batchCode =
      String(body.batch_code || '').trim().toUpperCase() ||
      `LOT-${Date.now().toString(36).toUpperCase().slice(-5)}-${crypto.randomUUID().slice(0, 3).toUpperCase()}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const prodCheck = await client.query('SELECT id FROM tenant_products WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        productId,
      ]);
      if (!prodCheck.rows[0]) return null;

      const id = crypto.randomUUID();
      const receivedAt = body.received_at || new Date().toISOString();

      await client.query(
        `INSERT INTO tenant_inventory_batches (
           id, tenant_id, product_id, warehouse_id, supplier_id, batch_code,
           initial_qty, remaining_qty, unit_cost_vnd, received_at, expiry_date, status, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12)`,
        [
          id,
          ctx.tenantId,
          productId,
          body.warehouse_id || null,
          body.supplier_id || null,
          batchCode,
          initialQty,
          initialQty,
          unitCostVnd,
          receivedAt,
          body.expiry_date || null,
          body.notes ? String(body.notes) : null,
        ]
      );

      await client.query(
        `INSERT INTO tenant_stock_movements (
           id, tenant_id, product_id, batch_id, warehouse_id, movement_type,
           qty_delta, unit_cost_vnd, total_cost_vnd, reference_type, reference_id, note, created_by
         ) VALUES ($1, $2, $3, $4, $5, 'IN_BATCH', $6, $7, $8, 'manual_batch', $9, $10, $11)`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          productId,
          id,
          body.warehouse_id || null,
          initialQty,
          unitCostVnd,
          initialQty * unitCostVnd,
          id,
          `Nhập lô hàng FIFO ${batchCode}`,
          ctx.userId,
        ]
      );

      await client.query(
        `UPDATE tenant_products
         SET cached_stock_qty = cached_stock_qty + $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, productId, initialQty]
      );

      const r = await client.query('SELECT * FROM tenant_inventory_batches WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        initial_qty: Number(r.rows[0].initial_qty || 0),
        remaining_qty: Number(r.rows[0].remaining_qty || 0),
        unit_cost_vnd: Number(r.rows[0].unit_cost_vnd || 0),
      };
    });

    if (!created) {
      sendApiError(res, 404, 'PRODUCT_NOT_FOUND', 'Không tìm thấy sản phẩm.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_BATCH_FAILED', err?.message || 'Không thể nhập lô hàng FIFO mới.');
  }
});

router.post('/fifo-deduct', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const productId = String(body.product_id || '').trim();
    const quantity = Math.round(Number(body.quantity || 0));

    if (!productId || quantity <= 0) {
      sendApiError(res, 422, 'INVALID_DEDUCT_INPUT', 'Vui lòng chọn sản phẩm và số lượng xuất > 0.');
      return;
    }

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) =>
      deductFifoInventoryInTx(client, {
        tenantId: ctx.tenantId,
        productId,
        warehouseId: body.warehouse_id || null,
        quantity,
        referenceType: 'manual_out',
        referenceId: body.reference_id || null,
        actorId: ctx.userId,
        reason: body.reason ? String(body.reason) : 'Xuất kho thủ công theo chuẩn FIFO',
      })
    );

    res.json({ success: true, data: outcome });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INSUFFICIENT_FIFO_STOCK')) {
      sendApiError(res, 422, 'INSUFFICIENT_FIFO_STOCK', msg);
      return;
    }
    sendApiError(res, 500, 'FIFO_DEDUCT_FAILED', msg || 'Không thể xuất kho FIFO.');
  }
});

router.post('/stock-adjust', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const productId = String(body.product_id || '').trim();
    const actionType = String(body.action_type || 'ADJUST').toUpperCase(); // 'ADJUST' | 'TRANSFER'
    const qty = Math.round(Number(body.qty ?? body.quantity ?? 0));

    if (!productId || qty === 0) {
      sendApiError(res, 422, 'INVALID_STOCK_ADJUST', 'Vui lòng chọn sản phẩm và số lượng điều chỉnh khác 0.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (actionType === 'TRANSFER') {
        const fromWh = body.from_warehouse_id || null;
        const toWh = body.to_warehouse_id || null;
        if (!toWh) throw new Error('TARGET_WAREHOUSE_REQUIRED');
        const transferQty = Math.abs(qty);
        const deducted = await deductFifoInventoryInTx(client, {
          tenantId: ctx.tenantId,
          productId,
          warehouseId: fromWh,
          quantity: transferQty,
          referenceType: 'manual_out',
          actorId: ctx.userId,
          reason: body.note || 'Điều chuyển kho nội bộ (Xuất)',
        });
        const avgCost = Math.round(deducted.total_cogs_vnd / transferQty);
        const newBatchId = crypto.randomUUID();
        const newBatchCode = `TRF-${Date.now().toString(36).toUpperCase().slice(-5)}`;
        await client.query(
          `INSERT INTO tenant_inventory_batches (
             id, tenant_id, product_id, warehouse_id, batch_code,
             initial_qty, remaining_qty, unit_cost_vnd, status, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
          [
            newBatchId,
            ctx.tenantId,
            productId,
            toWh,
            newBatchCode,
            transferQty,
            transferQty,
            avgCost,
            body.note || 'Điều chuyển kho nội bộ (Nhập)',
          ]
        );
        await client.query(
          `INSERT INTO tenant_stock_movements (
             id, tenant_id, product_id, batch_id, warehouse_id, movement_type,
             qty_delta, unit_cost_vnd, total_cost_vnd, reference_type, note, created_by
           ) VALUES ($1, $2, $3, $4, $5, 'IN_BATCH', $6, $7, $8, 'transfer_in', $9, $10)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            productId,
            newBatchId,
            toWh,
            transferQty,
            avgCost,
            transferQty * avgCost,
            body.note || `Nhận điều chuyển lô ${newBatchCode}`,
            ctx.userId,
          ]
        );
        await client.query(
          `UPDATE tenant_products
           SET cached_stock_qty = cached_stock_qty + $3, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, productId, transferQty]
        );
        return { action_type: 'TRANSFER', transferred_qty: transferQty, new_batch_code: newBatchCode };
      }

      if (qty < 0) {
        return deductFifoInventoryInTx(client, {
          tenantId: ctx.tenantId,
          productId,
          warehouseId: body.warehouse_id || null,
          quantity: Math.abs(qty),
          referenceType: 'manual_out',
          actorId: ctx.userId,
          reason: body.note || 'Kiểm kê điều chỉnh giảm kho',
        });
      }

      const unitCost = Math.max(0, Math.round(Number(body.unit_cost_vnd || 0)));
      const batchId = crypto.randomUUID();
      const batchCode = `ADJ-${Date.now().toString(36).toUpperCase().slice(-5)}`;
      await client.query(
        `INSERT INTO tenant_inventory_batches (
           id, tenant_id, product_id, warehouse_id, batch_code,
           initial_qty, remaining_qty, unit_cost_vnd, status, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
        [
          batchId,
          ctx.tenantId,
          productId,
          body.warehouse_id || null,
          batchCode,
          qty,
          qty,
          unitCost,
          body.note || 'Kiểm kê điều chỉnh tăng kho',
        ]
      );
      await client.query(
        `INSERT INTO tenant_stock_movements (
           id, tenant_id, product_id, batch_id, warehouse_id, movement_type,
           qty_delta, unit_cost_vnd, total_cost_vnd, reference_type, note, created_by
         ) VALUES ($1, $2, $3, $4, $5, 'ADJUST', $6, $7, $8, 'stocktake', $9, $10)`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          productId,
          batchId,
          body.warehouse_id || null,
          qty,
          unitCost,
          qty * unitCost,
          body.note || `Kiểm kê tăng kho ${batchCode}`,
          ctx.userId,
        ]
      );
      await client.query(
        `UPDATE tenant_products
         SET cached_stock_qty = cached_stock_qty + $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, productId, qty]
      );
      return { action_type: 'ADJUST_IN', added_qty: qty, batch_code: batchCode };
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INSUFFICIENT_FIFO_STOCK')) {
      sendApiError(res, 422, 'INSUFFICIENT_FIFO_STOCK', msg);
      return;
    }
    sendApiError(res, 500, 'STOCK_ADJUST_FAILED', msg || 'Không thể điều chỉnh kiểm kê kho.');
  }
});

router.get('/movements', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const warehouseId = typeof req.query.warehouse_id === 'string' ? req.query.warehouse_id.trim() : '';
    const limit = clampLimit(req.query.limit, 100, 250);
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT m.*,
               p.name AS product_name,
               p.sku AS product_sku,
               b.batch_code,
               w.name AS warehouse_name
        FROM tenant_stock_movements m
        INNER JOIN tenant_products p ON p.tenant_id = m.tenant_id AND p.id = m.product_id
        LEFT JOIN tenant_inventory_batches b ON b.tenant_id = m.tenant_id AND b.id = m.batch_id
        LEFT JOIN tenant_warehouses w ON w.tenant_id = m.tenant_id AND w.id = m.warehouse_id
        WHERE m.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (warehouseId && warehouseId !== 'all') {
        sql += ' AND m.warehouse_id = $2';
        params.push(warehouseId);
      }
      sql += ` ORDER BY m.created_at DESC LIMIT ${limit}`;
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        qty_delta: Number(row.qty_delta || 0),
        unit_cost_vnd: Number(row.unit_cost_vnd || 0),
        total_cost_vnd: Number(row.total_cost_vnd || 0),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_MOVEMENTS_FAILED', err?.message || 'Không thể tải lịch sử xuất nhập kho.');
  }
});

// ============================================================================
// 4. POS Shift Register (`tenant_pos_sessions` & `tenant_pos_orders`) + Voucher + Split Pay
// ============================================================================
router.get('/pos/sessions', requirePermission('inventory_assets', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_pos_sessions WHERE tenant_id = $1 ORDER BY opened_at DESC LIMIT 30',
        [ctx.tenantId]
      );
      const items = r.rows.map((s) => ({
        ...s,
        opening_cash_vnd: Number(s.opening_cash_vnd || 0),
        cash_sales_vnd: Number(s.cash_sales_vnd || 0),
        bank_sales_vnd: Number(s.bank_sales_vnd || 0),
        card_sales_vnd: Number(s.card_sales_vnd || 0),
        expected_closing_cash_vnd: Number(s.expected_closing_cash_vnd || 0),
        actual_closing_cash_vnd: Number(s.actual_closing_cash_vnd || 0),
        variance_vnd: Number(s.variance_vnd || 0),
        orders_count: Number(s.orders_count || 0),
      }));
      return {
        active_session: items.find((s) => s.status === 'open') || null,
        items,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_POS_SESSIONS_FAILED', err?.message || 'Không thể tải danh sách ca thu ngân POS.');
  }
});

router.post('/pos/sessions/open', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const openingCash = Math.max(0, Math.round(Number(body.opening_cash_vnd || 0)));

    const session = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existingOpen = await client.query(
        "SELECT * FROM tenant_pos_sessions WHERE tenant_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
        [ctx.tenantId]
      );
      if (existingOpen.rows[0]) {
        return { ...existingOpen.rows[0], already_open: true };
      }

      const id = crypto.randomUUID();
      const sessionCode = `SHIFT-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      await client.query(
        `INSERT INTO tenant_pos_sessions (
           id, tenant_id, session_code, branch_id, warehouse_id, cashier_user_id, cashier_name,
           status, opening_cash_vnd, expected_closing_cash_vnd
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9)`,
        [
          id,
          ctx.tenantId,
          sessionCode,
          body.branch_id || null,
          body.warehouse_id || null,
          ctx.userId,
          ctx.userName || 'Thu ngân POS',
          openingCash,
          openingCash,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_pos_sessions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        opening_cash_vnd: Number(r.rows[0].opening_cash_vnd || 0),
        already_open: false,
      };
    });

    res.status(201).json({ success: true, data: session });
  } catch (err: any) {
    sendApiError(res, 500, 'OPEN_POS_SESSION_FAILED', err?.message || 'Không thể mở ca thu ngân POS.');
  }
});

router.post('/pos/sessions/:id/close', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const sessionId = req.params.id;
    const body = req.body || {};

    const closed = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_pos_sessions WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, sessionId]
      );
      if (!r.rows[0]) return null;
      const s = r.rows[0];
      const expected = Number(s.opening_cash_vnd || 0) + Number(s.cash_sales_vnd || 0);
      const actual =
        body.actual_closing_cash_vnd !== undefined
          ? Math.max(0, Math.round(Number(body.actual_closing_cash_vnd)))
          : expected;
      const variance = actual - expected;

      await client.query(
        `UPDATE tenant_pos_sessions
         SET status = 'closed',
             expected_closing_cash_vnd = $3,
             actual_closing_cash_vnd = $4,
             variance_vnd = $5,
             closing_note = $6,
             closed_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, sessionId, expected, actual, variance, body.closing_note ? String(body.closing_note) : null]
      );

      const fresh = await client.query('SELECT * FROM tenant_pos_sessions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        sessionId,
      ]);
      return {
        ...fresh.rows[0],
        opening_cash_vnd: Number(fresh.rows[0].opening_cash_vnd || 0),
        cash_sales_vnd: Number(fresh.rows[0].cash_sales_vnd || 0),
        bank_sales_vnd: Number(fresh.rows[0].bank_sales_vnd || 0),
        expected_closing_cash_vnd: expected,
        actual_closing_cash_vnd: actual,
        variance_vnd: variance,
      };
    });

    if (!closed) {
      sendApiError(res, 404, 'POS_SESSION_NOT_FOUND', 'Không tìm thấy ca thu ngân POS.');
      return;
    }
    res.json({ success: true, data: closed });
  } catch (err: any) {
    sendApiError(res, 500, 'CLOSE_POS_SESSION_FAILED', err?.message || 'Không thể chốt ca thu ngân POS.');
  }
});

router.post('/pos/validate-voucher', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const code = String(req.body?.voucher_code || '').trim().toUpperCase();
    const subtotalVnd = Math.max(0, Math.round(Number(req.body?.subtotal_vnd || 0)));
    if (!code) {
      sendApiError(res, 422, 'VOUCHER_CODE_REQUIRED', 'Vui lòng nhập mã ưu đãi Voucher.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const vRes = await client.query<{
        id: string;
        code: string;
        status: string;
        discount_type: string;
        discount_value: string | number;
        min_order_vnd: string | number;
      }>(
        `SELECT vc.id, vc.code, vc.status, camp.discount_type, camp.discount_value, camp.min_order_vnd
         FROM mkt_voucher_codes vc
         INNER JOIN mkt_voucher_campaigns camp ON camp.tenant_id = vc.tenant_id AND camp.id = vc.voucher_campaign_id
         WHERE vc.tenant_id = $1 AND UPPER(vc.code) = $2
         LIMIT 1`,
        [ctx.tenantId, code]
      );
      if (vRes.rows[0]) {
        const v = vRes.rows[0];
        if (v.status === 'redeemed') {
          return { valid: false, reason: 'Mã Voucher này đã được sử dụng.' };
        }
        if (subtotalVnd < Number(v.min_order_vnd || 0)) {
          return {
            valid: false,
            reason: `Đơn hàng tối thiểu ${Number(v.min_order_vnd || 0).toLocaleString('vi-VN')}₫ để áp dụng mã này.`,
          };
        }
        const val = Number(v.discount_value || 0);
        const discountVnd =
          v.discount_type === 'percentage' || v.discount_type === 'percent'
            ? Math.round((subtotalVnd * Math.min(100, val)) / 100)
            : Math.round(val);
        return {
          valid: true,
          voucher_code: v.code,
          discount_vnd: Math.min(subtotalVnd, discountVnd),
          source: 'marketing_voucher',
        };
      }

      if (code === 'VIP10' || code.startsWith('PROMO10')) {
        return {
          valid: true,
          voucher_code: code,
          discount_vnd: Math.round(subtotalVnd * 0.1),
          source: 'pos_promo_rule',
        };
      }
      return { valid: false, reason: 'Mã ưu đãi không tồn tại hoặc đã hết hạn.' };
    });

    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'VALIDATE_VOUCHER_FAILED', err?.message || 'Không thể kiểm tra mã Voucher.');
  }
});

router.get('/pos/orders', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM tenant_pos_orders WHERE tenant_id = $1';
      const params: unknown[] = [ctx.tenantId];
      if (sessionId) {
        sql += ' AND session_id = $2';
        params.push(sessionId);
      }
      sql += ' ORDER BY created_at DESC LIMIT 80';
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        subtotal_vnd: Number(row.subtotal_vnd || 0),
        discount_vnd: Number(row.discount_vnd || 0),
        voucher_discount_vnd: Number(row.voucher_discount_vnd || 0),
        shipping_fee_vnd: Number(row.shipping_fee_vnd || 0),
        total_vnd: Number(row.total_vnd || 0),
        cash_paid_vnd: Number(row.cash_paid_vnd || 0),
        bank_paid_vnd: Number(row.bank_paid_vnd || 0),
        cogs_vnd: Number(row.cogs_vnd || 0),
        items: parseJsonSafe(row.items_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_POS_ORDERS_FAILED', err?.message || 'Không thể tải danh sách hóa đơn POS.');
  }
});

// Fast POS Counter Checkout -> Atomic FIFO Deduction + Paid Sales Order + POS Receipt + Shift Register + Attribution
router.post('/pos/checkout', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
      sendApiError(res, 422, 'POS_CART_EMPTY', 'Giỏ hàng POS đang trống.');
      return;
    }

    const checkoutResult = await withTenantTransaction(ctx.tenantId, async (client) => {
      const orderId = crypto.randomUUID();
      const posOrderId = crypto.randomUUID();
      const orderCode = `POS-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      let subtotalVnd = 0;
      let totalTaxVnd = 0;
      let totalCogsVnd = 0;
      const lineItems: unknown[] = [];
      const fifoResults: unknown[] = [];

      for (const cartItem of rawItems) {
        const prodId = String(cartItem.product_id || '').trim();
        const barcodeOrSku = String(cartItem.barcode || cartItem.sku || '').trim();
        const qty = Math.max(1, Math.round(Number(cartItem.qty ?? cartItem.quantity ?? 1)));

        const prodRes = prodId
          ? await client.query<{
              id: string;
              sku: string;
              name: string;
              product_type: string;
              sale_price_vnd: string | number;
              tax_rate_pct: string | number;
            }>(
              'SELECT id, sku, name, product_type, sale_price_vnd, tax_rate_pct FROM tenant_products WHERE tenant_id = $1 AND id = $2 LIMIT 1',
              [ctx.tenantId, prodId]
            )
          : await client.query<{
              id: string;
              sku: string;
              name: string;
              product_type: string;
              sale_price_vnd: string | number;
              tax_rate_pct: string | number;
            }>(
              'SELECT id, sku, name, product_type, sale_price_vnd, tax_rate_pct FROM tenant_products WHERE tenant_id = $1 AND (sku = $2 OR barcode = $2) LIMIT 1',
              [ctx.tenantId, barcodeOrSku]
            );

        const prod = prodRes.rows[0];
        if (!prod) {
          throw new Error(`PRODUCT_NOT_FOUND:${prodId || barcodeOrSku}`);
        }

        const unitPrice =
          cartItem.unit_price_vnd !== undefined
            ? Math.max(0, Math.round(Number(cartItem.unit_price_vnd)))
            : Math.max(0, Math.round(Number(prod.sale_price_vnd || 0)));
        const taxPct = Number(prod.tax_rate_pct || 0);
        const lineSub = qty * unitPrice;
        const lineTax = Math.round((lineSub * taxPct) / 100);
        subtotalVnd += lineSub;
        totalTaxVnd += lineTax;

        if (prod.product_type === 'goods') {
          const fifo = await deductFifoInventoryInTx(client, {
            tenantId: ctx.tenantId,
            productId: prod.id,
            warehouseId: body.warehouse_id || null,
            quantity: qty,
            referenceType: 'pos',
            referenceId: orderId,
            actorId: ctx.userId,
            reason: `Bán lẻ tại quầy POS ${orderCode}`,
          });
          totalCogsVnd += fifo.total_cogs_vnd;
          fifoResults.push(fifo);
        }

        lineItems.push({
          product_id: prod.id,
          sku: prod.sku,
          name: prod.name,
          qty,
          unit_price_vnd: unitPrice,
          tax_pct: taxPct,
          line_total_vnd: lineSub + lineTax,
        });
      }

      const manualDiscountVnd = Math.max(0, Math.round(Number(body.discount_vnd || 0)));
      let voucherDiscountVnd = Math.max(0, Math.round(Number(body.voucher_discount_vnd || 0)));
      const voucherCode = body.voucher_code ? String(body.voucher_code).trim().toUpperCase() : null;

      if (voucherCode) {
        const vRes = await client.query<{
          id: string;
          voucher_campaign_id: string;
          status: string;
          discount_type: string;
          discount_value: string | number;
        }>(
          `SELECT vc.id, vc.voucher_campaign_id, vc.status, camp.discount_type, camp.discount_value
           FROM mkt_voucher_codes vc
           INNER JOIN mkt_voucher_campaigns camp ON camp.tenant_id = vc.tenant_id AND camp.id = vc.voucher_campaign_id
           WHERE vc.tenant_id = $1 AND UPPER(vc.code) = $2 LIMIT 1`,
          [ctx.tenantId, voucherCode]
        );
        if (vRes.rows[0] && vRes.rows[0].status !== 'redeemed') {
          const val = Number(vRes.rows[0].discount_value || 0);
          if (voucherDiscountVnd === 0) {
            voucherDiscountVnd =
              vRes.rows[0].discount_type === 'percentage' || vRes.rows[0].discount_type === 'percent'
                ? Math.round((subtotalVnd * Math.min(100, val)) / 100)
                : Math.round(val);
          }
          await client.query(
            "UPDATE mkt_voucher_codes SET status = 'redeemed', redeemed_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2",
            [ctx.tenantId, vRes.rows[0].id]
          );
          await client.query(
            'UPDATE mkt_voucher_campaigns SET redeemed_codes = redeemed_codes + 1, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, vRes.rows[0].voucher_campaign_id]
          );
        } else if (voucherDiscountVnd === 0 && (voucherCode === 'VIP10' || voucherCode.startsWith('PROMO10'))) {
          voucherDiscountVnd = Math.round(subtotalVnd * 0.1);
        }
      }

      const shippingFeeVnd = Math.max(0, Math.round(Number(body.shipping_fee_vnd || 0)));
      const totalDiscountVnd = manualDiscountVnd + voucherDiscountVnd;
      const totalVnd = Math.max(0, subtotalVnd - totalDiscountVnd + totalTaxVnd + shippingFeeVnd);
      const customerName = String(body.customer_name || 'Khách mua lẻ tại quầy POS').trim();
      const paymentMethod = String(body.payment_method || 'cash');

      let cashPaidVnd = 0;
      let bankPaidVnd = 0;
      if (paymentMethod === 'split') {
        cashPaidVnd = Math.max(0, Math.round(Number(body.cash_paid_vnd || 0)));
        bankPaidVnd = Math.max(0, totalVnd - cashPaidVnd);
      } else if (paymentMethod === 'bank_transfer' || paymentMethod === 'vietqr') {
        bankPaidVnd = totalVnd;
      } else {
        cashPaidVnd = totalVnd;
      }

      const openSessionRes = body.session_id
        ? await client.query(
            "SELECT id FROM tenant_pos_sessions WHERE tenant_id = $1 AND id = $2 AND status = 'open' LIMIT 1",
            [ctx.tenantId, body.session_id]
          )
        : await client.query(
            "SELECT id FROM tenant_pos_sessions WHERE tenant_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
            [ctx.tenantId]
          );
      const activeSessionId = openSessionRes.rows[0]?.id || null;

      await client.query(
        `INSERT INTO tenant_sales_orders (
           id, tenant_id, order_code, lead_id, branch_id, warehouse_id, sales_rep_id,
           customer_name, status, payment_status, fulfillment_status,
           items_json, subtotal_vnd, discount_vnd, tax_vnd, shipping_fee_vnd, total_vnd,
           paid_vnd, attributed_revenue_vnd, cogs_vnd, voucher_code, payment_method, completed_at, notes
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, 'completed', 'paid', 'fulfilled',
           $9::jsonb, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19, clock_timestamp(), $20
         )`,
        [
          orderId,
          ctx.tenantId,
          orderCode,
          body.lead_id || null,
          body.branch_id || null,
          body.warehouse_id || null,
          ctx.userId,
          customerName,
          JSON.stringify(lineItems),
          subtotalVnd,
          totalDiscountVnd,
          totalTaxVnd,
          shippingFeeVnd,
          totalVnd,
          totalVnd,
          totalVnd,
          totalCogsVnd,
          voucherCode,
          paymentMethod,
          body.notes ? String(body.notes) : 'Thanh toán nhanh tại quầy POS',
        ]
      );

      await client.query(
        `INSERT INTO tenant_pos_orders (
           id, tenant_id, pos_order_code, session_id, sales_order_id, lead_id, branch_id, warehouse_id,
           cashier_user_id, customer_name, customer_phone, items_json, subtotal_vnd, discount_vnd,
           voucher_code, voucher_discount_vnd, shipping_fee_vnd, tax_vnd, total_vnd,
           cash_paid_vnd, bank_paid_vnd, payment_method, cogs_vnd, status, notes
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12::jsonb, $13, $14,
           $15, $16, $17, $18, $19,
           $20, $21, $22, $23, 'completed', $24
         )`,
        [
          posOrderId,
          ctx.tenantId,
          orderCode,
          activeSessionId,
          orderId,
          body.lead_id || null,
          body.branch_id || null,
          body.warehouse_id || null,
          ctx.userId,
          customerName,
          body.customer_phone ? String(body.customer_phone) : null,
          JSON.stringify(lineItems),
          subtotalVnd,
          manualDiscountVnd,
          voucherCode,
          voucherDiscountVnd,
          shippingFeeVnd,
          totalTaxVnd,
          totalVnd,
          cashPaidVnd,
          bankPaidVnd,
          paymentMethod,
          totalCogsVnd,
          body.notes ? String(body.notes) : null,
        ]
      );

      if (activeSessionId) {
        await client.query(
          `UPDATE tenant_pos_sessions
           SET cash_sales_vnd = cash_sales_vnd + $3,
               bank_sales_vnd = bank_sales_vnd + $4,
               expected_closing_cash_vnd = opening_cash_vnd + cash_sales_vnd + $3,
               orders_count = orders_count + 1,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, activeSessionId, cashPaidVnd, bankPaidVnd]
        );
      }

      if (totalVnd > 0) {
        await client.query(
          `INSERT INTO tenant_finance_transactions (
             id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
             counterparty_name, branch_id, lead_id, sales_order_id, description, created_by
           ) VALUES ($1, $2, $3, 'income', 'pos_retail', $4, $5, 'completed', $6, $7, $8, $9, $10, $11)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            `PT-${orderCode}`,
            totalVnd,
            paymentMethod === 'split' ? 'bank_transfer' : paymentMethod,
            customerName,
            body.branch_id || null,
            body.lead_id || null,
            orderId,
            `Thu tiền bán hàng tại quầy ${orderCode}`,
            ctx.userId,
          ]
        );

        await recordRevenueAttributionOnOrderPaidInTx(client, {
          tenantId: ctx.tenantId,
          orderId,
          orderCode,
          leadId: body.lead_id || null,
          amountDeltaVnd: totalVnd,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          actorName: ctx.userName,
          sourceLabel: 'Hóa đơn POS',
        });
      }

      return {
        order_id: orderId,
        pos_order_id: posOrderId,
        session_id: activeSessionId,
        order_code: orderCode,
        lead_id: body.lead_id || null,
        subtotal_vnd: subtotalVnd,
        voucher_discount_vnd: voucherDiscountVnd,
        shipping_fee_vnd: shippingFeeVnd,
        total_vnd: totalVnd,
        cash_paid_vnd: cashPaidVnd,
        bank_paid_vnd: bankPaidVnd,
        cogs_vnd: totalCogsVnd,
        gross_margin_vnd: totalVnd - totalCogsVnd,
        items: lineItems,
        fifo_allocations: fifoResults,
      };
    });

    if (checkoutResult.total_vnd > 0) {
      if (checkoutResult.lead_id) {
        await emitDomainEvent('deal.won', {
          tenantId: ctx.tenantId,
          leadId: checkoutResult.lead_id,
          amountVnd: checkoutResult.total_vnd,
          sourceEntity: 'sales_order',
          actorId: ctx.userId,
        });
      }
      await emitDomainEvent('order.completed' as any, {
        tenantId: ctx.tenantId,
        orderId: checkoutResult.order_id,
        orderCode: checkoutResult.order_code,
        leadId: checkoutResult.lead_id,
        salesRepId: ctx.userId,
        amountVnd: checkoutResult.total_vnd,
        totalVnd: checkoutResult.total_vnd,
        cogsVnd: checkoutResult.cogs_vnd,
        actorId: ctx.userId,
      } as any);
    }

    res.status(201).json({ success: true, data: checkoutResult });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INSUFFICIENT_FIFO_STOCK')) {
      sendApiError(res, 422, 'INSUFFICIENT_FIFO_STOCK', msg);
      return;
    }
    if (msg.startsWith('PRODUCT_NOT_FOUND:')) {
      sendApiError(res, 404, 'PRODUCT_NOT_FOUND', 'Sản phẩm trong giỏ POS không tồn tại.');
      return;
    }
    sendApiError(res, 500, 'POS_CHECKOUT_FAILED', msg || 'Không thể thanh toán đơn POS.');
  }
});

// ============================================================================
// 5. Inventory Sheet Sync (`InventorySyncModal` -> `tenant_inventory_sync_sheets`)
// ============================================================================
router.get('/sync-sheets', requirePermission('inventory_assets', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_inventory_sync_sheets WHERE tenant_id = $1 ORDER BY created_at DESC',
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        is_active: Boolean(row.is_active),
        sync_interval_minutes: Number(row.sync_interval_minutes || 15),
        mappings: parseJsonSafe(row.mappings_json, []),
        history: parseJsonSafe(row.history_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SYNC_SHEETS_FAILED', err?.message || 'Không thể tải cấu hình đồng bộ Google Sheets.');
  }
});

router.post('/sync-sheets', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const rawSpreadsheet = String(body.spreadsheet_id || '').trim();
    if (!rawSpreadsheet) {
      sendApiError(res, 422, 'SPREADSHEET_ID_REQUIRED', 'Vui lòng nhập URL hoặc ID Google Sheets.');
      return;
    }
    const urlMatch = rawSpreadsheet.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const spreadsheetId = urlMatch?.[1] || rawSpreadsheet;
    const sheetName = String(body.sheet_name || 'Sheet1').trim();
    const webhookToken = `wh_inv_${crypto.randomBytes(8).toString('hex')}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      const defaultMappings = Array.isArray(body.mappings)
        ? body.mappings
        : [
            { sheet_column: 'A', system_field: 'sku', custom_label: 'Mã SKU / Căn' },
            { sheet_column: 'B', system_field: 'product_name', custom_label: 'Tên sản phẩm' },
            { sheet_column: 'C', system_field: 'price', custom_label: 'Giá bán' },
            { sheet_column: 'D', system_field: 'qty', custom_label: 'Số lượng tồn' },
          ];
      await client.query(
        `INSERT INTO tenant_inventory_sync_sheets (
           id, tenant_id, sheet_name, spreadsheet_id, webhook_token, warehouse_id,
           sync_interval_minutes, is_active, mappings_json, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, $9)`,
        [
          id,
          ctx.tenantId,
          sheetName,
          spreadsheetId,
          webhookToken,
          body.warehouse_id || null,
          Math.max(5, Math.round(Number(body.sync_interval_minutes || 15))),
          JSON.stringify(defaultMappings),
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_inventory_sync_sheets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        is_active: Boolean(r.rows[0].is_active),
        mappings: defaultMappings,
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SYNC_SHEET_FAILED', err?.message || 'Không thể lưu kết nối Google Sheets.');
  }
});

router.patch('/sync-sheets/:id', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const sheetId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_inventory_sync_sheets WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, sheetId]
      );
      if (!curRes.rows[0]) return null;
      const cur = curRes.rows[0];

      await client.query(
        `UPDATE tenant_inventory_sync_sheets
         SET sheet_name = $3,
             sync_interval_minutes = $4,
             is_active = $5,
             mappings_json = $6::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          sheetId,
          body.sheet_name !== undefined ? String(body.sheet_name).trim() : cur.sheet_name,
          body.sync_interval_minutes !== undefined
            ? Math.max(5, Math.round(Number(body.sync_interval_minutes)))
            : Number(cur.sync_interval_minutes || 15),
          body.is_active !== undefined ? Boolean(body.is_active) : Boolean(cur.is_active),
          JSON.stringify(Array.isArray(body.mappings) ? body.mappings : parseJsonSafe(cur.mappings_json, [])),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_inventory_sync_sheets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        sheetId,
      ]);
      return {
        ...r.rows[0],
        is_active: Boolean(r.rows[0].is_active),
        mappings: parseJsonSafe(r.rows[0].mappings_json, []),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'SYNC_SHEET_NOT_FOUND', 'Không tìm thấy cấu hình đồng bộ.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_SYNC_SHEET_FAILED', err?.message || 'Không thể cập nhật cấu hình đồng bộ.');
  }
});

router.post('/sync-sheets/:id/run', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const sheetId = req.params.id;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const sRes = await client.query(
        'SELECT * FROM tenant_inventory_sync_sheets WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, sheetId]
      );
      if (!sRes.rows[0]) return null;
      const sheet = sRes.rows[0];

      let upsertedCount = 0;
      for (const row of rows) {
        const sku = String(row.sku || '').trim().toUpperCase();
        const name = String(row.product_name || row.name || '').trim();
        if (!sku || !name) continue;
        const salePrice = Math.max(0, Math.round(Number(row.price ?? row.sale_price_vnd ?? 0)));
        const costPrice = Math.max(0, Math.round(Number(row.import_price ?? row.default_cost_vnd ?? 0)));
        const qty = Math.max(0, Math.round(Number(row.qty ?? 0)));

        const existProd = await client.query<{ id: string; cached_stock_qty: number }>(
          'SELECT id, cached_stock_qty FROM tenant_products WHERE tenant_id = $1 AND sku = $2 LIMIT 1',
          [ctx.tenantId, sku]
        );
        let prodId = existProd.rows[0]?.id;
        if (prodId) {
          await client.query(
            `UPDATE tenant_products
             SET name = $3, sale_price_vnd = $4, default_cost_vnd = $5, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, prodId, name, salePrice, costPrice]
          );
        } else {
          prodId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_products (
               id, tenant_id, sku, name, category, unit, product_type, sale_price_vnd, default_cost_vnd, cached_stock_qty
             ) VALUES ($1, $2, $3, $4, $5, $6, 'goods', $7, $8, 0)`,
            [prodId, ctx.tenantId, sku, name, String(row.category || 'general'), String(row.unit || 'Cái'), salePrice, costPrice]
          );
        }

        const currentQty = Number(existProd.rows[0]?.cached_stock_qty || 0);
        if (qty > currentQty) {
          const addDelta = qty - currentQty;
          const bId = crypto.randomUUID();
          const bCode = `SYNC-${sku}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
          await client.query(
            `INSERT INTO tenant_inventory_batches (
               id, tenant_id, product_id, warehouse_id, batch_code, initial_qty, remaining_qty, unit_cost_vnd, status, notes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 'Đồng bộ tự động từ Sheet')`,
            [bId, ctx.tenantId, prodId, sheet.warehouse_id || null, bCode, addDelta, addDelta, costPrice]
          );
          await client.query(
            'UPDATE tenant_products SET cached_stock_qty = cached_stock_qty + $3 WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, prodId, addDelta]
          );
        }
        upsertedCount++;
      }

      const history = parseJsonSafe<any[]>(sheet.history_json, []);
      history.unshift({
        id: crypto.randomUUID(),
        synced_at: new Date().toISOString(),
        upserted_count: upsertedCount,
        status: 'ok',
      });

      await client.query(
        `UPDATE tenant_inventory_sync_sheets
         SET sync_status = 'idle',
             last_sync_at = clock_timestamp(),
             last_error = NULL,
             history_json = $3::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, sheetId, JSON.stringify(history.slice(0, 20))]
      );

      return { sheet_id: sheetId, upserted_count: upsertedCount, synced_at: new Date().toISOString() };
    });

    if (!outcome) {
      sendApiError(res, 404, 'SYNC_SHEET_NOT_FOUND', 'Không tìm thấy kết nối Sheet.');
      return;
    }
    res.json({ success: true, data: outcome });
  } catch (err: any) {
    sendApiError(res, 500, 'RUN_SYNC_SHEET_FAILED', err?.message || 'Không thể chạy đồng bộ tồn kho.');
  }
});

router.delete('/sync-sheets/:id', requirePermission('inventory_assets', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const sheetId = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM tenant_inventory_sync_sheets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        sheetId,
      ]);
      return r.rowCount > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'SYNC_SHEET_NOT_FOUND', 'Không tìm thấy kết nối Sheet.');
      return;
    }
    res.json({ success: true, data: { id: sheetId, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_SYNC_SHEET_FAILED', err?.message || 'Không thể xóa kết nối Sheet.');
  }
});

// ============================================================================
// 6. Company Fixed Assets (`tenant_fixed_assets`) Register & Depreciation
// ============================================================================
router.get('/assets', requirePermission('inventory_assets', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT fa.*,
                u.full_name AS assigned_user_name,
                d.name AS department_name,
                b.name AS branch_name
         FROM tenant_fixed_assets fa
         LEFT JOIN users u ON u.tenant_id = fa.tenant_id AND u.id = fa.assigned_user_id
         LEFT JOIN tenant_departments d ON d.tenant_id = fa.tenant_id AND d.id = fa.department_id
         LEFT JOIN tenant_branches b ON b.tenant_id = fa.tenant_id AND b.id = fa.branch_id
         WHERE fa.tenant_id = $1
         ORDER BY fa.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows.map(computeAssetDepreciation);
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ASSETS_FAILED', err?.message || 'Không thể tải Sổ Tài sản cố định.');
  }
});

router.post('/assets', requirePermission('inventory_assets', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'ASSET_NAME_REQUIRED', 'Vui lòng nhập tên Tài sản cố định.');
      return;
    }

    const assetCode =
      String(body.asset_code || '').trim().toUpperCase() || `TS-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_fixed_assets (
           id, tenant_id, asset_code, name, category, serial_number,
           branch_id, department_id, assigned_user_id, purchase_date,
           purchase_cost_vnd, salvage_value_vnd, useful_life_months, status, notes
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, COALESCE($10::date, CURRENT_DATE),
           $11, $12, $13, $14, $15
         )`,
        [
          id,
          ctx.tenantId,
          assetCode,
          name,
          body.category ? String(body.category).trim() : 'IT Equipment',
          body.serial_number ? String(body.serial_number).trim() : null,
          body.branch_id || null,
          body.department_id || null,
          body.assigned_user_id || null,
          body.purchase_date || null,
          Math.max(0, Math.round(Number(body.purchase_cost_vnd || 0))),
          Math.max(0, Math.round(Number(body.salvage_value_vnd || 0))),
          Math.max(1, Math.round(Number(body.useful_life_months || 36))),
          ['available', 'in_use', 'maintenance', 'retired', 'disposed'].includes(String(body.status))
            ? body.status
            : 'in_use',
          body.notes ? String(body.notes) : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_fixed_assets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return computeAssetDepreciation(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_ASSET_FAILED', err?.message || 'Không thể ghi tăng Tài sản cố định.');
  }
});

export default router;
