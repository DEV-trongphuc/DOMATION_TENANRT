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
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import { emitDomainEvent } from '../../core/events/event-bus.ts';
import {
  clampLimit,
  deductFifoInventoryInTx,
  ensureErpOpsSchema,
  parseJsonSafe,
  recordRevenueAttributionOnOrderPaidInTx,
  resolveActorContext,
  resolvePrimaryBranchLegalInfo,
} from '../erp-ops/schema.ts';

export const router = Router();

router.use(requireTenantAuth);
router.use(requireEntitlement('erp_finance_inventory'));
router.use(async (_req, _res, next) => {
  try {
    await ensureErpOpsSchema();
    next();
  } catch (err) {
    next(err);
  }
});

interface OrderLineItem {
  product_id?: string | null;
  sku?: string;
  name: string;
  qty: number;
  unit_price_vnd: number;
  tax_pct?: number;
}

function computeLineTotals(rawItems: unknown, rawDiscount = 0) {
  const items = Array.isArray(rawItems) ? (rawItems as OrderLineItem[]) : [];
  let subtotal = 0;
  let taxTotal = 0;
  const normalized = items.map((item) => {
    const qty = Math.max(1, Math.round(Number(item.qty || 1)));
    const unitPrice = Math.max(0, Math.round(Number(item.unit_price_vnd || 0)));
    const taxPct = Math.max(0, Number(item.tax_pct || 0));
    const lineSub = qty * unitPrice;
    const lineTax = Math.round((lineSub * taxPct) / 100);
    subtotal += lineSub;
    taxTotal += lineTax;
    return {
      product_id: item.product_id || null,
      sku: item.sku || '',
      name: String(item.name || 'Sản phẩm / Dịch vụ'),
      qty,
      unit_price_vnd: unitPrice,
      tax_pct: taxPct,
      line_total_vnd: lineSub + lineTax,
    };
  });
  const discount = Math.max(0, Math.round(Number(rawDiscount || 0)));
  const total = Math.max(0, subtotal - discount + taxTotal);
  return { items: normalized, subtotal, discount, taxTotal, total };
}

function buildVietQrImageUrl(params: {
  bankBin: string;
  accountNo: string;
  accountHolder: string;
  amountVnd: number;
  transferNote: string;
}): string {
  const bin = params.bankBin || '970436';
  const acc = params.accountNo || '0000000000';
  const q = new URLSearchParams({
    amount: String(Math.max(0, Math.round(params.amountVnd))),
    addInfo: params.transferNote.slice(0, 60),
    accountName: params.accountHolder,
  });
  return `https://img.vietqr.io/image/${encodeURIComponent(bin)}-${encodeURIComponent(acc)}-compact2.png?${q.toString()}`;
}

// ============================================================================
// 1. P&L Cashflow Dashboard + Dynamic Legal Entity & VietQR Preview
// ============================================================================
router.get('/dashboard', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id.trim() : null;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [legalEntity, txSum, soSum, depSum, dealSum, leadsRes, branchesRes] = await Promise.all([
        resolvePrimaryBranchLegalInfo(client, ctx.tenantId, branchId),
        client.query<{
          total_income_vnd: string | number;
          total_expense_vnd: string | number;
          tx_count: string | number;
        }>(
          `SELECT COALESCE(SUM(CASE WHEN tx_type = 'income' AND status = 'completed' THEN amount_vnd ELSE 0 END), 0) AS total_income_vnd,
                  COALESCE(SUM(CASE WHEN tx_type = 'expense' AND status = 'completed' THEN amount_vnd ELSE 0 END), 0) AS total_expense_vnd,
                  COUNT(*)::int AS tx_count
           FROM tenant_finance_transactions
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{
          orders_count: string | number;
          paid_orders_count: string | number;
          total_so_vnd: string | number;
          total_paid_vnd: string | number;
          total_cogs_vnd: string | number;
        }>(
          `SELECT COUNT(*)::int AS orders_count,
                  COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END), 0) AS paid_orders_count,
                  COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_vnd ELSE 0 END), 0) AS total_so_vnd,
                  COALESCE(SUM(paid_vnd), 0) AS total_paid_vnd,
                  COALESCE(SUM(cogs_vnd), 0) AS total_cogs_vnd
           FROM tenant_sales_orders
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ deposits_held_vnd: string | number; deposits_count: string | number }>(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('received', 'applied') THEN amount_vnd ELSE 0 END), 0) AS deposits_held_vnd,
                  COUNT(*)::int AS deposits_count
           FROM tenant_deposits
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{
          open_pipeline_vnd: string | number;
          won_deals_vnd: string | number;
          deals_count: string | number;
        }>(
          `SELECT COALESCE(SUM(CASE WHEN stage NOT IN ('won', 'lost') THEN amount_vnd ELSE 0 END), 0) AS open_pipeline_vnd,
                  COALESCE(SUM(CASE WHEN stage = 'won' THEN amount_vnd ELSE 0 END), 0) AS won_deals_vnd,
                  COUNT(*)::int AS deals_count
           FROM tenant_deals
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, name, phone, email, total_revenue_vnd
           FROM leads
           WHERE tenant_id = $1 AND is_deleted = false
           ORDER BY updated_at DESC
           LIMIT 100`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, code, name, legal_entity_name, tax_code, address, is_headquarters
           FROM tenant_branches
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY is_headquarters DESC, name ASC`,
          [ctx.tenantId]
        ),
      ]);

      const totalIncome = Number(txSum.rows[0]?.total_income_vnd || 0);
      const totalExpense = Number(txSum.rows[0]?.total_expense_vnd || 0);
      const totalCogs = Number(soSum.rows[0]?.total_cogs_vnd || 0);
      const grossProfit = totalIncome - totalCogs;
      const netCashflow = totalIncome - totalExpense;

      return {
        summary: {
          total_income_vnd: totalIncome,
          total_expense_vnd: totalExpense,
          net_cashflow_vnd: netCashflow,
          total_cogs_vnd: totalCogs,
          gross_profit_vnd: grossProfit,
          orders_count: Number(soSum.rows[0]?.orders_count || 0),
          paid_orders_count: Number(soSum.rows[0]?.paid_orders_count || 0),
          total_so_vnd: Number(soSum.rows[0]?.total_so_vnd || 0),
          total_paid_vnd: Number(soSum.rows[0]?.total_paid_vnd || 0),
          deposits_held_vnd: Number(depSum.rows[0]?.deposits_held_vnd || 0),
          deposits_count: Number(depSum.rows[0]?.deposits_count || 0),
          open_pipeline_vnd: Number(dealSum.rows[0]?.open_pipeline_vnd || 0),
          won_deals_vnd: Number(dealSum.rows[0]?.won_deals_vnd || 0),
          deals_count: Number(dealSum.rows[0]?.deals_count || 0),
          tx_count: Number(txSum.rows[0]?.tx_count || 0),
        },
        legal_entity: legalEntity,
        branches: branchesRes.rows,
        leads: leadsRes.rows.map((l) => ({
          ...l,
          total_revenue_vnd: Number(l.total_revenue_vnd || 0),
        })),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'FINANCE_DASHBOARD_FAILED', err?.message || 'Không thể tải báo cáo Tài chính P&L.');
  }
});

router.get('/vietqr-preview', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const amountVnd = Math.max(0, Math.round(Number(req.query.amount_vnd || 0)));
    const refCode = String(req.query.reference_code || 'THANHTOAN').trim();
    const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id.trim() : null;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const legal = await resolvePrimaryBranchLegalInfo(client, ctx.tenantId, branchId);
      const transferNote = `${refCode} ${legal.branch_code || ''}`.trim();
      return {
        legal_entity: legal,
        amount_vnd: amountVnd,
        transfer_note: transferNote,
        qr_image_url: buildVietQrImageUrl({
          bankBin: legal.bank_bin,
          accountNo: legal.bank_account_no,
          accountHolder: legal.bank_account_holder,
          amountVnd,
          transferNote,
        }),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'VIETQR_PREVIEW_FAILED', err?.message || 'Không thể tạo mã VietQR thanh toán.');
  }
});

// ============================================================================
// 2. B2B Companies (`tenant_b2b_companies`) & Multi-Deals (`tenant_deals`)
// ============================================================================
router.get('/companies', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = clampLimit(req.query.limit, 60, 200);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT c.*,
               (SELECT COUNT(*)::int FROM tenant_deals d WHERE d.tenant_id = c.tenant_id AND d.company_id = c.id) AS deals_count,
               (SELECT COALESCE(SUM(so.paid_vnd), 0) FROM tenant_sales_orders so WHERE so.tenant_id = c.tenant_id AND so.company_id = c.id) AS total_revenue_vnd
        FROM tenant_b2b_companies c
        WHERE c.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (q) {
        sql += ' AND (LOWER(c.name) LIKE LOWER($2) OR LOWER(COALESCE(c.tax_code, \'\')) LIKE LOWER($2))';
        params.push(`%${q}%`);
      }
      sql += ` ORDER BY c.created_at DESC LIMIT ${limit}`;
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        deals_count: Number(row.deals_count || 0),
        total_revenue_vnd: Number(row.total_revenue_vnd || 0),
        contacts: parseJsonSafe(row.contacts_json, []),
      }));
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_B2B_COMPANIES_FAILED', err?.message || 'Không thể tải danh sách khách hàng doanh nghiệp B2B.');
  }
});

router.post('/companies', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'COMPANY_NAME_REQUIRED', 'Vui lòng nhập tên doanh nghiệp B2B.');
      return;
    }

    const code =
      String(body.code || '').trim().toUpperCase() || `B2B-${Date.now().toString(36).toUpperCase().slice(-5)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_b2b_companies (
           id, tenant_id, code, name, tax_code, industry, company_size, website,
           billing_address, phone, email, representative_name, owner_user_id,
           primary_lead_id, contacts_json, tier, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          body.tax_code ? String(body.tax_code).trim() : null,
          body.industry ? String(body.industry).trim() : null,
          body.company_size ? String(body.company_size).trim() : null,
          body.website ? String(body.website).trim() : null,
          body.billing_address ? String(body.billing_address).trim() : null,
          body.phone ? String(body.phone).trim() : null,
          body.email ? String(body.email).trim() : null,
          body.representative_name ? String(body.representative_name).trim() : null,
          body.owner_user_id || ctx.userId,
          body.primary_lead_id || null,
          JSON.stringify(Array.isArray(body.contacts) ? body.contacts : []),
          ['standard', 'silver', 'gold', 'enterprise'].includes(String(body.tier)) ? body.tier : 'standard',
          body.notes ? String(body.notes) : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_b2b_companies WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        contacts: parseJsonSafe(r.rows[0].contacts_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_B2B_COMPANY_FAILED', err?.message || 'Không thể tạo hồ sơ doanh nghiệp B2B.');
  }
});

router.get('/deals', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const companyId = typeof req.query.company_id === 'string' ? req.query.company_id.trim() : '';
    const leadId = typeof req.query.lead_id === 'string' ? req.query.lead_id.trim() : '';
    const limit = clampLimit(req.query.limit, 80, 200);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      let sql = `
        SELECT d.*,
               c.name AS company_name,
               c.tax_code AS company_tax_code,
               l.name AS lead_name,
               l.phone AS lead_phone
        FROM tenant_deals d
        LEFT JOIN tenant_b2b_companies c ON c.tenant_id = d.tenant_id AND c.id = d.company_id
        LEFT JOIN leads l ON l.tenant_id = d.tenant_id AND l.id = d.lead_id
        WHERE d.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;
      if (companyId) {
        sql += ` AND d.company_id = $${pIdx}`;
        params.push(companyId);
        pIdx++;
      }
      if (leadId) {
        sql += ` AND d.lead_id = $${pIdx}`;
        params.push(leadId);
        pIdx++;
      }
      sql += ` ORDER BY d.created_at DESC LIMIT ${limit}`;

      const r = await client.query(sql, params);
      return r.rows.map((row) => {
        const masked = maskContactPiiIfDisallowed({ phone: row.lead_phone }, canUnmaskLeads, tenantSettings);
        return {
          ...row,
          amount_vnd: Number(row.amount_vnd || 0),
          probability: Number(row.probability || 0),
          lead_phone: masked.phone,
        };
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_DEALS_FAILED', err?.message || 'Không thể tải danh sách Cơ hội B2B (Multi-Deals).');
  }
});

router.post('/deals', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) {
      sendApiError(res, 422, 'DEAL_TITLE_REQUIRED', 'Vui lòng nhập tên cơ hội bán hàng (Deal).');
      return;
    }

    const dealCode =
      String(body.deal_code || '').trim().toUpperCase() || `DEAL-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const stage = ['qualification', 'discovery', 'proposal', 'negotiation', 'won', 'lost'].includes(String(body.stage))
      ? String(body.stage)
      : 'qualification';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_deals (
           id, tenant_id, deal_code, title, company_id, lead_id, owner_user_id,
           stage, amount_vnd, probability, expected_close_date, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          ctx.tenantId,
          dealCode,
          title,
          body.company_id || null,
          body.lead_id || null,
          body.owner_user_id || ctx.userId,
          stage,
          Math.max(0, Math.round(Number(body.amount_vnd || 0))),
          Math.min(100, Math.max(0, Math.round(Number(body.probability ?? 30)))),
          body.expected_close_date || null,
          body.notes ? String(body.notes) : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        amount_vnd: Number(r.rows[0].amount_vnd || 0),
        probability: Number(r.rows[0].probability || 0),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_DEAL_FAILED', err?.message || 'Không thể tạo Deal mới.');
  }
});

router.patch('/deals/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const dealId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query('SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        dealId,
      ]);
      if (!curRes.rows[0]) return null;
      const cur = curRes.rows[0];
      const nextStage = body.stage || cur.stage;
      const nextProb =
        nextStage === 'won'
          ? 100
          : nextStage === 'lost'
            ? 0
            : body.probability !== undefined
              ? Math.min(100, Math.max(0, Math.round(Number(body.probability))))
              : Number(cur.probability || 30);

      await client.query(
        `UPDATE tenant_deals
         SET title = $3,
             stage = $4,
             amount_vnd = $5,
             probability = $6,
             expected_close_date = $7,
             notes = $8,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          dealId,
          body.title !== undefined ? String(body.title).trim() : cur.title,
          nextStage,
          body.amount_vnd !== undefined ? Math.max(0, Math.round(Number(body.amount_vnd))) : Number(cur.amount_vnd || 0),
          nextProb,
          body.expected_close_date !== undefined ? body.expected_close_date || null : cur.expected_close_date,
          body.notes !== undefined ? body.notes : cur.notes,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_deals WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        dealId,
      ]);
      return {
        ...r.rows[0],
        amount_vnd: Number(r.rows[0].amount_vnd || 0),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'DEAL_NOT_FOUND', 'Không tìm thấy Deal.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_DEAL_FAILED', err?.message || 'Không thể cập nhật Deal.');
  }
});

// ============================================================================
// 3. Quotes (`tenant_quotes`) -> 1-Click Convert to Sales Order (`tenant_sales_orders`)
// ============================================================================
router.get('/quotes', requirePermission('finance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT q.*,
                c.name AS company_name,
                l.name AS lead_name,
                d.title AS deal_title
         FROM tenant_quotes q
         LEFT JOIN tenant_b2b_companies c ON c.tenant_id = q.tenant_id AND c.id = q.company_id
         LEFT JOIN leads l ON l.tenant_id = q.tenant_id AND l.id = q.lead_id
         LEFT JOIN tenant_deals d ON d.tenant_id = q.tenant_id AND d.id = q.deal_id
         WHERE q.tenant_id = $1
         ORDER BY q.created_at DESC
         LIMIT 100`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        subtotal_vnd: Number(row.subtotal_vnd || 0),
        discount_vnd: Number(row.discount_vnd || 0),
        tax_vnd: Number(row.tax_vnd || 0),
        total_vnd: Number(row.total_vnd || 0),
        items: parseJsonSafe(row.items_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_QUOTES_FAILED', err?.message || 'Không thể tải danh sách Báo giá.');
  }
});

router.post('/quotes', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) {
      sendApiError(res, 422, 'QUOTE_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề Báo giá.');
      return;
    }

    const computed = computeLineTotals(body.items, body.discount_vnd);
    const totalVnd =
      computed.items.length > 0 ? computed.total : Math.max(0, Math.round(Number(body.total_vnd || 0)));
    const subtotalVnd = computed.items.length > 0 ? computed.subtotal : totalVnd;
    const quoteCode =
      String(body.quote_code || '').trim().toUpperCase() || `BG-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_quotes (
           id, tenant_id, quote_code, title, company_id, lead_id, deal_id, branch_id,
           status, items_json, subtotal_vnd, discount_vnd, tax_vnd, total_vnd,
           valid_until, terms_text, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id,
          ctx.tenantId,
          quoteCode,
          title,
          body.company_id || null,
          body.lead_id || null,
          body.deal_id || null,
          body.branch_id || null,
          body.status || 'sent',
          JSON.stringify(computed.items),
          subtotalVnd,
          computed.discount,
          computed.taxTotal,
          totalVnd,
          body.valid_until || null,
          body.terms_text ? String(body.terms_text) : null,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return {
        ...r.rows[0],
        subtotal_vnd: Number(r.rows[0].subtotal_vnd || 0),
        total_vnd: Number(r.rows[0].total_vnd || 0),
        items: parseJsonSafe(r.rows[0].items_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_QUOTE_FAILED', err?.message || 'Không thể khởi tạo Báo giá.');
  }
});

router.post('/quotes/:id/convert-to-order', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const quoteId = req.params.id;

    const converted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const qRes = await client.query('SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        quoteId,
      ]);
      const quote = qRes.rows[0];
      if (!quote) return null;

      if (quote.converted_order_id) {
        const existingSo = await client.query(
          'SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, quote.converted_order_id]
        );
        if (existingSo.rows[0]) {
          return { quote_id: quoteId, sales_order: existingSo.rows[0], already_converted: true };
        }
      }

      let customerName = String(req.body?.customer_name || '').trim();
      if (!customerName && quote.company_id) {
        const cRes = await client.query<{ name: string }>(
          'SELECT name FROM tenant_b2b_companies WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, quote.company_id]
        );
        customerName = cRes.rows[0]?.name || '';
      }
      if (!customerName && quote.lead_id) {
        const lRes = await client.query<{ name: string }>(
          'SELECT name FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, quote.lead_id]
        );
        customerName = lRes.rows[0]?.name || '';
      }
      if (!customerName) customerName = quote.title;

      const orderId = crypto.randomUUID();
      const orderCode = `SO-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      await client.query(
        `INSERT INTO tenant_sales_orders (
           id, tenant_id, order_code, quote_id, company_id, lead_id, deal_id, branch_id,
           warehouse_id, sales_rep_id, customer_name, status, payment_status, fulfillment_status,
           items_json, subtotal_vnd, discount_vnd, tax_vnd, total_vnd, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'confirmed', 'unpaid', 'pending', $12::jsonb, $13, $14, $15, $16, $17)`,
        [
          orderId,
          ctx.tenantId,
          orderCode,
          quote.id,
          quote.company_id || null,
          quote.lead_id || null,
          quote.deal_id || null,
          quote.branch_id || null,
          req.body?.warehouse_id || null,
          ctx.userId,
          customerName,
          JSON.stringify(parseJsonSafe(quote.items_json, [])),
          Number(quote.subtotal_vnd || 0),
          Number(quote.discount_vnd || 0),
          Number(quote.tax_vnd || 0),
          Number(quote.total_vnd || 0),
          `Chuyển đổi từ Báo giá ${quote.quote_code}`,
        ]
      );

      await client.query(
        `UPDATE tenant_quotes
         SET status = 'converted',
             converted_order_id = $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, quoteId, orderId]
      );

      const soRes = await client.query('SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        orderId,
      ]);
      return {
        quote_id: quoteId,
        sales_order: {
          ...soRes.rows[0],
          total_vnd: Number(soRes.rows[0].total_vnd || 0),
          items: parseJsonSafe(soRes.rows[0].items_json, []),
        },
        already_converted: false,
      };
    });

    if (!converted) {
      sendApiError(res, 404, 'QUOTE_NOT_FOUND', 'Không tìm thấy Báo giá cần chuyển đổi.');
      return;
    }
    res.status(201).json({ success: true, data: converted });
  } catch (err: any) {
    sendApiError(res, 500, 'CONVERT_QUOTE_FAILED', err?.message || 'Không thể chuyển Báo giá thành Đơn bán (SO).');
  }
});

// ============================================================================
// 4. Sales Orders (`tenant_sales_orders`) + FIFO Fulfillment + Revenue Attribution + Event Bus
// ============================================================================
router.get('/sales-orders', requirePermission('finance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT so.*,
                c.name AS company_name,
                l.name AS lead_name
         FROM tenant_sales_orders so
         LEFT JOIN tenant_b2b_companies c ON c.tenant_id = so.tenant_id AND c.id = so.company_id
         LEFT JOIN leads l ON l.tenant_id = so.tenant_id AND l.id = so.lead_id
         WHERE so.tenant_id = $1
         ORDER BY so.created_at DESC
         LIMIT 100`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        subtotal_vnd: Number(row.subtotal_vnd || 0),
        total_vnd: Number(row.total_vnd || 0),
        paid_vnd: Number(row.paid_vnd || 0),
        attributed_revenue_vnd: Number(row.attributed_revenue_vnd || 0),
        cogs_vnd: Number(row.cogs_vnd || 0),
        items: parseJsonSafe(row.items_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SALES_ORDERS_FAILED', err?.message || 'Không thể tải danh sách Đơn bán hàng (SO).');
  }
});

router.post('/sales-orders', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const computed = computeLineTotals(body.items, body.discount_vnd);
    const totalVnd =
      computed.items.length > 0 ? computed.total : Math.max(0, Math.round(Number(body.total_vnd || 0)));
    const subtotalVnd = computed.items.length > 0 ? computed.subtotal : totalVnd;
    const customerName = String(body.customer_name || 'Khách hàng').trim();
    const orderCode =
      String(body.order_code || '').trim().toUpperCase() || `SO-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_sales_orders (
           id, tenant_id, order_code, company_id, lead_id, deal_id, branch_id,
           warehouse_id, sales_rep_id, customer_name, status, payment_status,
           fulfillment_status, items_json, subtotal_vnd, discount_vnd, tax_vnd, total_vnd, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', 'unpaid', 'pending', $11::jsonb, $12, $13, $14, $15, $16)`,
        [
          id,
          ctx.tenantId,
          orderCode,
          body.company_id || null,
          body.lead_id || null,
          body.deal_id || null,
          body.branch_id || null,
          body.warehouse_id || null,
          body.sales_rep_id || ctx.userId,
          customerName,
          JSON.stringify(computed.items),
          subtotalVnd,
          computed.discount,
          computed.taxTotal,
          totalVnd,
          body.notes ? String(body.notes) : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        total_vnd: Number(r.rows[0].total_vnd || 0),
        paid_vnd: Number(r.rows[0].paid_vnd || 0),
        items: parseJsonSafe(r.rows[0].items_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SALES_ORDER_FAILED', err?.message || 'Không thể tạo Đơn bán hàng (SO).');
  }
});

router.post('/sales-orders/:id/pay-complete', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const orderId = req.params.id;
    const body = req.body || {};

    const txOutcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const soRes = await client.query(
        'SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, orderId]
      );
      const so = soRes.rows[0];
      if (!so) return null;

      const totalVnd = Number(so.total_vnd || 0);
      const prevAttributed = Number(so.attributed_revenue_vnd || 0);
      const nextPaid =
        body.paid_amount_vnd !== undefined
          ? Math.max(Number(so.paid_vnd || 0), Math.round(Number(body.paid_amount_vnd)))
          : totalVnd;
      const revenueDelta = Math.max(0, nextPaid - prevAttributed);

      // Optional FIFO stock deduction for physical goods items if not yet fulfilled
      let addedCogs = 0;
      const fifoAllocations: unknown[] = [];
      let nextFulfillmentStatus = so.fulfillment_status;

      if (body.fulfill_inventory !== false && so.fulfillment_status !== 'fulfilled') {
        const lineItems = parseJsonSafe<Array<{ product_id?: string | null; qty?: number }>>(so.items_json, []);
        for (const item of lineItems) {
          if (!item.product_id) continue;
          const prodCheck = await client.query<{ id: string; product_type: string; cached_stock_qty: number }>(
            'SELECT id, product_type, cached_stock_qty FROM tenant_products WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [ctx.tenantId, item.product_id]
          );
          const prod = prodCheck.rows[0];
          if (!prod || prod.product_type !== 'goods') continue;
          const reqQty = Math.max(1, Math.round(Number(item.qty || 1)));
          if (body.fulfill_inventory === true || Number(prod.cached_stock_qty || 0) >= reqQty) {
            const fifo = await deductFifoInventoryInTx(client, {
              tenantId: ctx.tenantId,
              productId: prod.id,
              warehouseId: body.warehouse_id || so.warehouse_id || null,
              quantity: reqQty,
              referenceType: 'sales_order',
              referenceId: so.id,
              actorId: ctx.userId,
              reason: `Xuất kho đơn hàng ${so.order_code}`,
            });
            addedCogs += fifo.total_cogs_vnd;
            fifoAllocations.push(fifo);
            nextFulfillmentStatus = 'fulfilled';
          }
        }
      }

      const nextCogs = Number(so.cogs_vnd || 0) + addedCogs;
      await client.query(
        `UPDATE tenant_sales_orders
         SET status = 'completed',
             payment_status = 'paid',
             fulfillment_status = $3,
             paid_vnd = $4,
             attributed_revenue_vnd = $5,
             cogs_vnd = $6,
             completed_at = COALESCE(completed_at, clock_timestamp()),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          orderId,
          nextFulfillmentStatus,
          nextPaid,
          prevAttributed + revenueDelta,
          nextCogs,
        ]
      );

      if (revenueDelta > 0) {
        // Record Income Cashflow Ledger entry
        const txCode = `PT-${Date.now().toString(36).toUpperCase().slice(-6)}`;
        await client.query(
          `INSERT INTO tenant_finance_transactions (
             id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
             counterparty_name, branch_id, lead_id, company_id, sales_order_id, description, created_by
           ) VALUES ($1, $2, $3, 'income', 'sales_order', $4, $5, 'completed', $6, $7, $8, $9, $10, $11, $12)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            txCode,
            revenueDelta,
            body.payment_method || 'bank_transfer',
            so.customer_name,
            so.branch_id || null,
            so.lead_id || null,
            so.company_id || null,
            so.id,
            `Thu tiền hoàn tất đơn bán ${so.order_code}`,
            ctx.userId,
          ]
        );

        await recordRevenueAttributionOnOrderPaidInTx(client, {
          tenantId: ctx.tenantId,
          orderId: so.id,
          orderCode: so.order_code,
          leadId: so.lead_id,
          dealId: so.deal_id,
          amountDeltaVnd: revenueDelta,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          actorName: ctx.userName,
          sourceLabel: 'Đơn bán hàng SO',
        });
      }

      const updatedSo = await client.query(
        'SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, orderId]
      );
      return {
        order: {
          ...updatedSo.rows[0],
          total_vnd: Number(updatedSo.rows[0].total_vnd || 0),
          paid_vnd: Number(updatedSo.rows[0].paid_vnd || 0),
          attributed_revenue_vnd: Number(updatedSo.rows[0].attributed_revenue_vnd || 0),
          cogs_vnd: Number(updatedSo.rows[0].cogs_vnd || 0),
          items: parseJsonSafe(updatedSo.rows[0].items_json, []),
        },
        revenue_delta_vnd: revenueDelta,
        fifo_allocations: fifoAllocations,
      };
    });

    if (!txOutcome) {
      sendApiError(res, 404, 'SALES_ORDER_NOT_FOUND', 'Không tìm thấy Đơn bán hàng (SO).');
      return;
    }

    if (txOutcome.revenue_delta_vnd > 0) {
      if (txOutcome.order.lead_id) {
        await emitDomainEvent('deal.won', {
          tenantId: ctx.tenantId,
          leadId: txOutcome.order.lead_id,
          dealId: txOutcome.order.deal_id || null,
          amountVnd: txOutcome.revenue_delta_vnd,
          sourceEntity: 'sales_order',
          actorId: ctx.userId,
        });
      }
      await emitDomainEvent('order.completed' as any, {
        tenantId: ctx.tenantId,
        orderId: txOutcome.order.id,
        orderCode: txOutcome.order.order_code,
        leadId: txOutcome.order.lead_id || null,
        dealId: txOutcome.order.deal_id || null,
        salesRepId: txOutcome.order.sales_rep_id || ctx.userId,
        amountVnd: txOutcome.revenue_delta_vnd,
        totalVnd: txOutcome.order.total_vnd,
        cogsVnd: txOutcome.order.cogs_vnd,
        actorId: ctx.userId,
      } as any);
    }

    res.json({ success: true, data: txOutcome });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INSUFFICIENT_FIFO_STOCK')) {
      sendApiError(res, 422, 'INSUFFICIENT_FIFO_STOCK', msg);
      return;
    }
    sendApiError(res, 500, 'COMPLETE_SALES_ORDER_FAILED', msg || 'Không thể hoàn tất thanh toán Đơn bán hàng.');
  }
});

// ============================================================================
// 5. Deposits (`tenant_deposits`), Purchase Orders (`tenant_purchase_orders`) & Ledger (`tenant_finance_transactions`)
// ============================================================================
router.get('/deposits', requirePermission('finance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_deposits
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({ ...row, amount_vnd: Number(row.amount_vnd || 0) }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_DEPOSITS_FAILED', err?.message || 'Không thể tải danh sách Đặt cọc.');
  }
});

router.post('/deposits', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const amountVnd = Math.round(Number(body.amount_vnd || 0));
    if (amountVnd <= 0) {
      sendApiError(res, 422, 'DEPOSIT_AMOUNT_INVALID', 'Số tiền đặt cọc phải lớn hơn 0.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      const depCode = `COC-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const status = body.status || 'received';
      const customerName = String(body.customer_name || 'Khách đặt cọc').trim();

      await client.query(
        `INSERT INTO tenant_deposits (
           id, tenant_id, deposit_code, lead_id, company_id, deal_id, sales_order_id,
           customer_name, amount_vnd, payment_method, status, reference_no, notes, received_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          ctx.tenantId,
          depCode,
          body.lead_id || null,
          body.company_id || null,
          body.deal_id || null,
          body.sales_order_id || null,
          customerName,
          amountVnd,
          body.payment_method || 'bank_transfer',
          status,
          body.reference_no ? String(body.reference_no) : null,
          body.notes ? String(body.notes) : null,
          ctx.userId,
        ]
      );

      if (status === 'received') {
        await client.query(
          `INSERT INTO tenant_finance_transactions (
             id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
             counterparty_name, lead_id, company_id, sales_order_id, deposit_id, description, created_by
           ) VALUES ($1, $2, $3, 'income', 'customer_deposit', $4, $5, 'completed', $6, $7, $8, $9, $10, $11, $12)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            `PT-${depCode}`,
            amountVnd,
            body.payment_method || 'bank_transfer',
            customerName,
            body.lead_id || null,
            body.company_id || null,
            body.sales_order_id || null,
            id,
            `Thu tiền đặt cọc ${depCode}`,
            ctx.userId,
          ]
        );
      }

      const r = await client.query('SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return { ...r.rows[0], amount_vnd: Number(r.rows[0].amount_vnd || 0) };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_DEPOSIT_FAILED', err?.message || 'Không thể ghi nhận phiếu Đặt cọc.');
  }
});

router.get('/purchase-orders', requirePermission('finance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_purchase_orders
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        total_vnd: Number(row.total_vnd || 0),
        items: parseJsonSafe(row.items_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_PO_FAILED', err?.message || 'Không thể tải danh sách Đơn mua hàng (PO).');
  }
});

router.post('/purchase-orders', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const supplierName = String(body.supplier_name || '').trim();
    if (!supplierName) {
      sendApiError(res, 422, 'SUPPLIER_NAME_REQUIRED', 'Vui lòng nhập tên Nhà cung cấp cho Đơn mua PO.');
      return;
    }

    const computed = computeLineTotals(body.items, 0);
    const totalVnd =
      computed.items.length > 0 ? computed.total : Math.max(0, Math.round(Number(body.total_vnd || 0)));
    const poCode =
      String(body.po_code || '').trim().toUpperCase() || `PO-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_purchase_orders (
           id, tenant_id, po_code, supplier_id, warehouse_id, supplier_name,
           status, items_json, total_vnd, expected_date, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
        [
          id,
          ctx.tenantId,
          poCode,
          body.supplier_id || null,
          body.warehouse_id || null,
          supplierName,
          body.status || 'ordered',
          JSON.stringify(computed.items),
          totalVnd,
          body.expected_date || null,
          body.notes ? String(body.notes) : null,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_purchase_orders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        total_vnd: Number(r.rows[0].total_vnd || 0),
        items: parseJsonSafe(r.rows[0].items_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_PO_FAILED', err?.message || 'Không thể tạo Đơn mua hàng (PO).');
  }
});

router.post('/purchase-orders/:id/receive', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const poId = req.params.id;

    const received = await withTenantTransaction(ctx.tenantId, async (client) => {
      const poRes = await client.query(
        'SELECT * FROM tenant_purchase_orders WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, poId]
      );
      const po = poRes.rows[0];
      if (!po) return null;
      if (po.status === 'received') {
        return { po, created_batches: [], already_received: true };
      }

      const items = parseJsonSafe<Array<{ product_id?: string | null; qty?: number; unit_price_vnd?: number }>>(
        po.items_json,
        []
      );
      const createdBatches: unknown[] = [];

      for (const item of items) {
        if (!item.product_id) continue;
        const qty = Math.max(1, Math.round(Number(item.qty || 1)));
        const unitCost = Math.max(0, Math.round(Number(item.unit_price_vnd || 0)));
        const batchId = crypto.randomUUID();
        const batchCode = `LOT-${po.po_code}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

        await client.query(
          `INSERT INTO tenant_inventory_batches (
             id, tenant_id, product_id, warehouse_id, supplier_id, purchase_order_id,
             batch_code, initial_qty, remaining_qty, unit_cost_vnd, status, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, 'active', $10)`,
          [
            batchId,
            ctx.tenantId,
            item.product_id,
            po.warehouse_id || null,
            po.supplier_id || null,
            po.id,
            batchCode,
            qty,
            unitCost,
            `Nhập kho từ PO ${po.po_code}`,
          ]
        );

        await client.query(
          `INSERT INTO tenant_stock_movements (
             id, tenant_id, product_id, batch_id, warehouse_id, movement_type,
             qty_delta, unit_cost_vnd, total_cost_vnd, reference_type, reference_id, note, created_by
           ) VALUES ($1, $2, $3, $4, $5, 'IN_BATCH', $6, $7, $8, 'purchase_order', $9, $10, $11)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            item.product_id,
            batchId,
            po.warehouse_id || null,
            qty,
            unitCost,
            qty * unitCost,
            po.id,
            `Nhập lô FIFO ${batchCode} từ ${po.po_code}`,
            ctx.userId,
          ]
        );

        await client.query(
          `UPDATE tenant_products
           SET cached_stock_qty = cached_stock_qty + $3,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, item.product_id, qty]
        );
        createdBatches.push({ batch_id: batchId, batch_code: batchCode, product_id: item.product_id, qty, unit_cost_vnd: unitCost });
      }

      await client.query(
        `UPDATE tenant_purchase_orders
         SET status = 'received',
             received_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, poId]
      );

      // Record Expense transaction
      if (Number(po.total_vnd || 0) > 0) {
        await client.query(
          `INSERT INTO tenant_finance_transactions (
             id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
             counterparty_name, purchase_order_id, description, created_by
           ) VALUES ($1, $2, $3, 'expense', 'inventory_procurement', $4, 'bank_transfer', 'completed', $5, $6, $7, $8)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            `PC-${po.po_code}`,
            Number(po.total_vnd || 0),
            po.supplier_name,
            po.id,
            `Chi thanh toán nhập hàng PO ${po.po_code}`,
            ctx.userId,
          ]
        );
      }

      const updatedPo = await client.query('SELECT * FROM tenant_purchase_orders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        poId,
      ]);
      return { po: updatedPo.rows[0], created_batches: createdBatches, already_received: false };
    });

    if (!received) {
      sendApiError(res, 404, 'PO_NOT_FOUND', 'Không tìm thấy Đơn mua hàng (PO).');
      return;
    }
    res.json({ success: true, data: received });
  } catch (err: any) {
    sendApiError(res, 500, 'RECEIVE_PO_FAILED', err?.message || 'Không thể nhập kho từ Đơn mua hàng PO.');
  }
});

router.get('/transactions', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const txType = typeof req.query.tx_type === 'string' ? req.query.tx_type.trim() : '';
    const limit = clampLimit(req.query.limit, 100, 300);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM tenant_finance_transactions WHERE tenant_id = $1';
      const params: unknown[] = [ctx.tenantId];
      if (txType === 'income' || txType === 'expense') {
        sql += ' AND tx_type = $2';
        params.push(txType);
      }
      sql += ` ORDER BY tx_date DESC, created_at DESC LIMIT ${limit}`;
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({ ...row, amount_vnd: Number(row.amount_vnd || 0) }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TRANSACTIONS_FAILED', err?.message || 'Không thể tải Sổ quỹ Thu - Chi.');
  }
});

router.post('/transactions', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const txType = body.tx_type === 'expense' ? 'expense' : 'income';
    const amountVnd = Math.round(Number(body.amount_vnd || 0));
    if (amountVnd <= 0) {
      sendApiError(res, 422, 'TX_AMOUNT_INVALID', 'Số tiền giao dịch phải lớn hơn 0.');
      return;
    }

    const txCode =
      String(body.tx_code || '').trim().toUpperCase() ||
      `${txType === 'income' ? 'PT' : 'PC'}-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_finance_transactions (
           id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
           counterparty_name, counterparty_tax_code, branch_id, lead_id, company_id,
           tx_date, description, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::date, CURRENT_DATE), $15, $16)`,
        [
          id,
          ctx.tenantId,
          txCode,
          txType,
          body.category || (txType === 'income' ? 'sales_revenue' : 'operating_expense'),
          amountVnd,
          body.payment_method || 'bank_transfer',
          body.status || 'completed',
          body.counterparty_name ? String(body.counterparty_name) : null,
          body.counterparty_tax_code ? String(body.counterparty_tax_code) : null,
          body.branch_id || null,
          body.lead_id || null,
          body.company_id || null,
          body.tx_date || null,
          body.description ? String(body.description) : null,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_finance_transactions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return { ...r.rows[0], amount_vnd: Number(r.rows[0].amount_vnd || 0) };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TRANSACTION_FAILED', err?.message || 'Không thể ghi nhận bút toán Thu/Chi.');
  }
});

export default router;
