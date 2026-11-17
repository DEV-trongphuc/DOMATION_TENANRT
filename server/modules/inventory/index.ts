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
      const [prodSum, batchSum, assetRows, whCount, supCount] = await Promise.all([
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
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'INVENTORY_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan Kho FIFO & Tài sản.');
  }
});

// ============================================================================
// 2. Products, Suppliers & Warehouses
// ============================================================================
router.get('/products', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = clampLimit(req.query.limit, 100, 300);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM tenant_products WHERE tenant_id = $1 AND is_active = true';
      const params: unknown[] = [ctx.tenantId];
      if (q) {
        sql += ' AND (LOWER(name) LIKE LOWER($2) OR LOWER(sku) LIKE LOWER($2))';
        params.push(`%${q}%`);
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
        cached_stock_qty: Number(r.rows[0].cached_stock_qty || 0),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_PRODUCT_FAILED', err?.message || 'Không thể tạo sản phẩm mới.');
  }
});

router.get('/suppliers', requirePermission('inventory_assets', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_suppliers WHERE tenant_id = $1 AND is_active = true ORDER BY name ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SUPPLIERS_FAILED', err?.message || 'Không thể tải danh sách Nhà cung cấp.');
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
           id, tenant_id, code, name, tax_code, contact_name, phone, email, address, payment_terms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
// 3. FIFO Inventory Batches (`tenant_inventory_batches`), Movements & POS Counter Checkout
// ============================================================================
router.get('/batches', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const productId = typeof req.query.product_id === 'string' ? req.query.product_id.trim() : '';
    const limit = clampLimit(req.query.limit, 100, 300);

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
      if (productId) {
        sql += ' AND b.product_id = $2';
        params.push(productId);
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
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, 'active', $11)`,
        [
          id,
          ctx.tenantId,
          productId,
          body.warehouse_id || null,
          body.supplier_id || null,
          batchCode,
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

router.get('/movements', requirePermission('inventory_assets', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const limit = clampLimit(req.query.limit, 80, 250);
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT m.*,
                p.name AS product_name,
                p.sku AS product_sku,
                b.batch_code
         FROM tenant_stock_movements m
         INNER JOIN tenant_products p ON p.tenant_id = m.tenant_id AND p.id = m.product_id
         LEFT JOIN tenant_inventory_batches b ON b.tenant_id = m.tenant_id AND b.id = m.batch_id
         WHERE m.tenant_id = $1
         ORDER BY m.created_at DESC
         LIMIT ${limit}`,
        [ctx.tenantId]
      );
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

// Fast POS Counter Checkout -> Atomic FIFO Deduction + Paid Sales Order + Cashflow Income + Lead Attribution
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
      const orderCode = `POS-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      let subtotalVnd = 0;
      let totalTaxVnd = 0;
      let totalCogsVnd = 0;
      const lineItems: unknown[] = [];
      const fifoResults: unknown[] = [];

      for (const cartItem of rawItems) {
        const prodId = String(cartItem.product_id || '').trim();
        const qty = Math.max(1, Math.round(Number(cartItem.qty ?? cartItem.quantity ?? 1)));
        const prodRes = await client.query<{
          id: string;
          sku: string;
          name: string;
          product_type: string;
          sale_price_vnd: string | number;
          tax_rate_pct: string | number;
        }>(
          'SELECT id, sku, name, product_type, sale_price_vnd, tax_rate_pct FROM tenant_products WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, prodId]
        );
        const prod = prodRes.rows[0];
        if (!prod) {
          throw new Error(`PRODUCT_NOT_FOUND:${prodId}`);
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

      const discountVnd = Math.max(0, Math.round(Number(body.discount_vnd || 0)));
      const totalVnd = Math.max(0, subtotalVnd - discountVnd + totalTaxVnd);
      const customerName = String(body.customer_name || 'Khách mua lẻ tại quầy POS').trim();

      await client.query(
        `INSERT INTO tenant_sales_orders (
           id, tenant_id, order_code, lead_id, branch_id, warehouse_id, sales_rep_id,
           customer_name, status, payment_status, fulfillment_status,
           items_json, subtotal_vnd, discount_vnd, tax_vnd, total_vnd,
           paid_vnd, attributed_revenue_vnd, cogs_vnd, completed_at, notes
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, 'completed', 'paid', 'fulfilled',
           $9::jsonb, $10, $11, $12, $13,
           $13, $13, $14, clock_timestamp(), $15
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
          discountVnd,
          totalTaxVnd,
          totalVnd,
          totalCogsVnd,
          body.notes ? String(body.notes) : 'Thanh toán nhanh tại quầy POS',
        ]
      );

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
            body.payment_method || 'cash',
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
        order_code: orderCode,
        lead_id: body.lead_id || null,
        total_vnd: totalVnd,
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
// 4. Company Fixed Assets (`tenant_fixed_assets`) Register & Depreciation
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
    sendApiError(res, 500, 'CREATE_ASSET_FAILED', err?.message || 'Không thể đăng ký Tài sản cố định.');
  }
});

router.patch('/assets/:id', requirePermission('inventory_assets', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const assetId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query('SELECT * FROM tenant_fixed_assets WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        assetId,
      ]);
      if (!cur.rows[0]) return null;
      const row = cur.rows[0];

      await client.query(
        `UPDATE tenant_fixed_assets
         SET status = $3,
             assigned_user_id = $4,
             department_id = $5,
             notes = $6,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          assetId,
          body.status || row.status,
          body.assigned_user_id !== undefined ? body.assigned_user_id || null : row.assigned_user_id,
          body.department_id !== undefined ? body.department_id || null : row.department_id,
          body.notes !== undefined ? body.notes : row.notes,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_fixed_assets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        assetId,
      ]);
      return computeAssetDepreciation(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'ASSET_NOT_FOUND', 'Không tìm thấy Tài sản cố định.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ASSET_FAILED', err?.message || 'Không thể cập nhật Tài sản cố định.');
  }
});

export default router;
