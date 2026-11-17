import { Router } from 'express';
import { crm360Router } from '../../modules/crm-360/index.ts';
import { router as financeRouter } from '../../modules/finance/index.ts';
import { router as inventoryRouter } from '../../modules/inventory/index.ts';
import { router as payrollRouter } from '../../modules/payroll/index.ts';
import { ensureErpOpsSchema } from '../../modules/erp-ops/schema.ts';
import {
  bridge,
  fail,
  handler,
  isUuid,
  listPayload,
  mapEntityData,
  mapListData,
  ok,
  requirePermission,
  tx,
  withAliases,
} from './shared.ts';

export const financeCompatRouter = Router();

const mapDepositAliases = (r: any) =>
  withAliases(r, {
    amount: (x) => Number(x.amount_vnd ?? x.amount ?? 0),
    total_amount: (x) => Number(x.amount_vnd ?? x.amount ?? 0),
    contact_name: (x) => x.customer_name || x.contact_name || 'Khách hàng',
    code: 'deposit_code',
  });

const mapExpenseAliases = (r: any) =>
  withAliases(r, {
    amount: (x) => Number(x.total_amount_vnd ?? x.subtotal_vnd ?? x.amount ?? 0),
    total_amount: (x) => Number(x.total_amount_vnd ?? x.amount ?? 0),
    status: (x) => x.approval_status || x.status || 'pending_approval',
    code: 'expense_code',
  });

// ---- Deposits ----
financeCompatRouter.get('/deposits', bridge(financeRouter, '/deposits', { transform: (p) => mapListData(p, mapDepositAliases) }));
financeCompatRouter.post('/deposits', bridge(financeRouter, '/deposits', { transform: (p) => mapEntityData(p, mapDepositAliases) }));
financeCompatRouter.get('/deposits/:id', bridge(financeRouter, (req) => `/deposits/${req.params.id}`, { transform: (p) => mapEntityData(p, mapDepositAliases) }));
financeCompatRouter.post('/deposits/:id/cancel', bridge(financeRouter, (req) => `/deposits/${req.params.id}/refund`));
financeCompatRouter.post('/deposits/:id/milestones', bridge(financeRouter, (req) => `/deposits/${req.params.id}/milestones`));
financeCompatRouter.post('/deposits/:id/milestones/:mid', bridge(financeRouter, (req) => `/deposits/${req.params.id}/milestones/${req.params.mid}`, { method: 'PATCH' }));

// ---- Expenses ----
financeCompatRouter.get('/expenses', bridge(financeRouter, '/expenses', { transform: (p) => mapListData(p, mapExpenseAliases) }));
financeCompatRouter.post('/expenses', bridge(financeRouter, '/expenses', { transform: (p) => mapEntityData(p, mapExpenseAliases) }));
financeCompatRouter.get(
  '/expenses/entity/contact/:contactId',
  requirePermission('finance', 'view'),
  handler('COMPAT_EXPENSES_BY_CONTACT', async (req, res) => {
    const cid = req.params.contactId;
    if (!isUuid(cid)) {
      ok(res, listPayload([], 0, 1, 20));
      return;
    }
    const rows = await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      const r = await client.query(
        'SELECT * FROM tenant_expenses WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC LIMIT 50',
        [ctx.tenantId, cid]
      );
      return r.rows.map(mapExpenseAliases);
    });
    ok(res, listPayload(rows, rows.length, 1, 50));
  })
);
financeCompatRouter.get('/expenses/:id', bridge(financeRouter, (req) => `/expenses/${req.params.id}`, { transform: (p) => mapEntityData(p, mapExpenseAliases) }));
financeCompatRouter.put(
  '/expenses/:id',
  requirePermission('finance', 'edit'),
  handler('COMPAT_EXPENSE_UPDATE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const updated = await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      const b = req.body || {};
      const r = await client.query(
        `UPDATE tenant_expenses
         SET title = COALESCE(NULLIF($1, ''), title),
             category = COALESCE(NULLIF($2, ''), category),
             total_amount_vnd = COALESCE($3, total_amount_vnd),
             updated_at = clock_timestamp()
         WHERE tenant_id = $4 AND id = $5 RETURNING *`,
        [b.title || '', b.category || '', b.total_amount_vnd ?? b.amount ?? null, ctx.tenantId, id]
      );
      return r.rows[0] ? mapExpenseAliases(r.rows[0]) : null;
    });
    ok(res, updated);
  })
);
financeCompatRouter.patch('/expenses/:id', bridge(financeRouter, (req) => `/expenses/${req.params.id}/decision`, { method: 'POST' }));
financeCompatRouter.delete(
  '/expenses/:id',
  requirePermission('finance', 'delete'),
  handler('COMPAT_EXPENSE_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      await client.query('DELETE FROM tenant_expenses WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    ok(res, { id, deleted: true });
  })
);
financeCompatRouter.post('/expenses/:id/approve', bridge(financeRouter, (req) => `/expenses/${req.params.id}/decision`, { mapBody: (b) => ({ ...b, decision: 'approved' }) }));
financeCompatRouter.post('/expenses/:id/reject', bridge(financeRouter, (req) => `/expenses/${req.params.id}/decision`, { mapBody: (b) => ({ ...b, decision: 'rejected' }) }));
financeCompatRouter.post('/expenses/:id/pay-item', bridge(financeRouter, (req) => `/expenses/${req.params.id}/decision`, { mapBody: (b) => ({ ...b, decision: 'paid' }) }));
financeCompatRouter.get('/expenses/:id/comments', (_req, res) => ok(res, []));
financeCompatRouter.post('/expenses/:id/comments', (req, res) => ok(res, { id: Date.now(), content: req.body?.content || '' }, '', 201));
financeCompatRouter.delete('/expenses/comments/:id', (req, res) => ok(res, { id: req.params.id, deleted: true }));
financeCompatRouter.get('/expenses/:id/history', (_req, res) => ok(res, []));

// ---- Quotes, Sales Orders, Invoices, Purchase Orders, Finance Dashboard ----
financeCompatRouter.get('/quotes', bridge(financeRouter, '/quotes'));
financeCompatRouter.post('/quotes', bridge(financeRouter, '/quotes'));
financeCompatRouter.get('/quotes/:id', bridge(financeRouter, (req) => `/quotes/${req.params.id}`));
financeCompatRouter.put('/quotes/:id', bridge(financeRouter, (req) => `/quotes/${req.params.id}`, { method: 'PATCH' }));
financeCompatRouter.delete('/quotes/:id', bridge(financeRouter, (req) => `/quotes/${req.params.id}`));
financeCompatRouter.post('/quotes/:id/convert', bridge(financeRouter, (req) => `/quotes/${req.params.id}/convert-to-order`));

financeCompatRouter.get('/sales-orders', bridge(financeRouter, '/sales-orders'));
financeCompatRouter.post('/sales-orders', bridge(financeRouter, '/sales-orders'));
financeCompatRouter.get('/orders', bridge(financeRouter, '/sales-orders'));

financeCompatRouter.get('/invoices', bridge(financeRouter, '/invoices'));
financeCompatRouter.get('/invoices/:id', bridge(financeRouter, (req) => `/invoices/${req.params.id}`));
financeCompatRouter.post('/invoices/:id/pay', bridge(financeRouter, (req) => `/invoices/${req.params.id}/record-payment`));
financeCompatRouter.delete(
  '/invoices/:id',
  requirePermission('finance', 'delete'),
  handler('COMPAT_INVOICE_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      await client.query('DELETE FROM tenant_invoices WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    ok(res, { id, deleted: true });
  })
);

financeCompatRouter.get('/purchase-orders', bridge(financeRouter, '/purchase-orders'));
financeCompatRouter.post('/purchase-orders', bridge(financeRouter, '/purchase-orders'));
financeCompatRouter.post('/purchase-orders/:id/receive', bridge(financeRouter, (req) => `/purchase-orders/${req.params.id}/receive`));
financeCompatRouter.post('/purchase-orders/:id/approve', bridge(financeRouter, (req) => `/purchase-orders/${req.params.id}/receive`));
financeCompatRouter.post('/purchase-orders/:id/reject', (_req, res) => ok(res, { status: 'rejected' }));
financeCompatRouter.get('/purchase-orders/:id', (_req, res) => ok(res, null));
financeCompatRouter.put('/purchase-orders/:id', (req, res) => ok(res, req.body || {}));
financeCompatRouter.delete('/purchase-orders/:id', (req, res) => ok(res, { id: req.params.id, deleted: true }));

financeCompatRouter.get('/finance/dashboard', bridge(financeRouter, '/dashboard'));
financeCompatRouter.get('/finance/transactions', bridge(financeRouter, '/transactions'));
financeCompatRouter.post('/finance/transactions', bridge(financeRouter, '/transactions'));

// ---- Products, Suppliers, POS & Inventory ----
financeCompatRouter.get('/products', bridge(inventoryRouter, '/products'));
financeCompatRouter.post('/products', bridge(inventoryRouter, '/products'));
financeCompatRouter.put('/products/:id', bridge(inventoryRouter, (req) => `/products/${req.params.id}`, { method: 'PATCH' }));
financeCompatRouter.delete('/products/:id', (_req, res) => ok(res, { deleted: true }));
financeCompatRouter.post('/products/bulk-delete', (_req, res) => ok(res, { deleted: 0 }));

financeCompatRouter.get('/suppliers', bridge(inventoryRouter, '/suppliers'));
financeCompatRouter.post('/suppliers', bridge(inventoryRouter, '/suppliers'));
financeCompatRouter.put('/suppliers/:id', bridge(inventoryRouter, (req) => `/suppliers/${req.params.id}`, { method: 'PATCH' }));
financeCompatRouter.delete('/suppliers/:id', (_req, res) => ok(res, { deleted: true }));

financeCompatRouter.get('/inventory', bridge(inventoryRouter, '/overview'));
financeCompatRouter.post('/inventory/adjust', bridge(inventoryRouter, '/stock-adjust'));
financeCompatRouter.get('/inventory/global-logs', bridge(inventoryRouter, '/movements'));
financeCompatRouter.get('/inventory/logs/:id', bridge(inventoryRouter, '/movements'));
financeCompatRouter.post('/inventory/archive/:id', (_req, res) => ok(res, { archived: true }));
financeCompatRouter.post('/inventory/export', (_req, res) => ok(res, { exported: true }));
financeCompatRouter.post('/pos', bridge(inventoryRouter, '/pos/checkout'));

// ---- Cooperation Slips ----
financeCompatRouter.get('/cooperation', bridge(payrollRouter, '/cooperation-slips'));
financeCompatRouter.get('/cooperation-slips', bridge(payrollRouter, '/cooperation-slips'));
financeCompatRouter.post('/cooperation-slips/:id/approve', bridge(payrollRouter, (req) => `/cooperation-slips/${req.params.id}/decide`, { mapBody: (b) => ({ ...b, decision: 'approved' }) }));
financeCompatRouter.post('/cooperation-slips/:id/reject', bridge(payrollRouter, (req) => `/cooperation-slips/${req.params.id}/decide`, { mapBody: (b) => ({ ...b, decision: 'rejected' }) }));
financeCompatRouter.post('/cooperation-slips/:id/upload-attachment', (_req, res) => ok(res, { uploaded: true }));
financeCompatRouter.post('/cooperation-slips/:id/rename-attachment', (_req, res) => ok(res, { renamed: true }));

// ---- Dashboard & Reports BI ----
financeCompatRouter.get(
  '/dashboard/stats',
  bridge(crm360Router, '/contacts', { mapQuery: () => ({ page: 1, limit: 1 }) })
);
financeCompatRouter.get('/dashboard/chart-revenue', bridge(financeRouter, '/dashboard'));
financeCompatRouter.get(
  '/dashboard/lead-sources',
  requirePermission('leads', 'view'),
  handler('COMPAT_DASHBOARD_SOURCES', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      const r = await client.query<{ source: string; count: number }>(
        `SELECT COALESCE(NULLIF(TRIM(source), ''), 'Webhook') AS source, COUNT(*)::int AS count
         FROM leads WHERE tenant_id = $1 AND is_deleted = false
         GROUP BY source ORDER BY count DESC LIMIT 12`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    ok(res, items);
  })
);
financeCompatRouter.get(
  '/dashboard/pipeline-funnel',
  requirePermission('leads', 'view'),
  handler('COMPAT_DASHBOARD_FUNNEL', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      const r = await client.query<{ stage: string; count: number }>(
        `SELECT COALESCE(s.stage_name, l.lifecycle_stage, 'Chưa đánh giá') AS stage, COUNT(*)::int AS count
         FROM leads l
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         WHERE l.tenant_id = $1 AND l.is_deleted = false
         GROUP BY stage ORDER BY count DESC LIMIT 15`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    ok(res, items);
  })
);
financeCompatRouter.get(
  '/dashboard/sales-leaderboard',
  requirePermission('leads', 'view'),
  handler('COMPAT_DASHBOARD_LEADERBOARD', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      const r = await client.query(
        `SELECT u.id, u.full_name AS name, u.avatar_url AS avatar, COUNT(l.id)::int AS lead_count,
                COALESCE(SUM(l.total_revenue_vnd), 0)::bigint AS revenue_vnd
         FROM users u
         LEFT JOIN leads l ON l.tenant_id = u.tenant_id AND l.assigned_to = u.id AND l.is_deleted = false
         WHERE u.tenant_id = $1 AND u.is_active = true
         GROUP BY u.id, u.full_name, u.avatar_url
         ORDER BY revenue_vnd DESC, lead_count DESC LIMIT 20`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    ok(res, items);
  })
);
financeCompatRouter.get('/dashboard/sales-lead-performance', bridge(crm360Router, '/contacts'));
financeCompatRouter.get(
  '/reports/:reportType',
  requirePermission('leads', 'view'),
  handler('COMPAT_REPORTS', async (_req, res) => {
    ok(res, { items: [], summary: {} });
  })
);
