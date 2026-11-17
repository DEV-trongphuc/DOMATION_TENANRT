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

export interface CommercialLineItemInput {
  product_id?: string | null;
  sku?: string;
  name: string;
  description?: string;
  unit?: string;
  qty?: number;
  quantity?: number;
  unit_price_vnd?: number;
  price?: number;
  discount_pct?: number;
  tax_pct?: number;
}

export interface NormalizedCommercialLineItem {
  product_id: string | null;
  sku: string;
  name: string;
  description: string;
  unit: string;
  qty: number;
  unit_price_vnd: number;
  discount_pct: number;
  tax_pct: number;
  line_subtotal_vnd: number;
  line_discount_vnd: number;
  line_tax_vnd: number;
  line_total_vnd: number;
}

function computeLineTotals(
  rawItems: unknown,
  rawOrderDiscountVnd = 0,
  rawShippingFeeVnd = 0,
  defaultTaxPct = 0
) {
  const items = Array.isArray(rawItems) ? (rawItems as CommercialLineItemInput[]) : [];
  let subtotal = 0;
  let lineDiscountSum = 0;
  let taxTotal = 0;

  const normalized: NormalizedCommercialLineItem[] = items.map((item) => {
    const qty = Math.max(0.01, Number(item.qty ?? item.quantity ?? 1));
    const unitPrice = Math.max(0, Math.round(Number(item.unit_price_vnd ?? item.price ?? 0)));
    const discountPct = Math.min(100, Math.max(0, Number(item.discount_pct ?? 0)));
    const taxPct = Math.min(100, Math.max(0, Number(item.tax_pct ?? defaultTaxPct ?? 0)));

    const lineSub = Math.round(qty * unitPrice);
    const lineDisc = Math.round((lineSub * discountPct) / 100);
    const taxableBase = Math.max(0, lineSub - lineDisc);
    const lineTax = Math.round((taxableBase * taxPct) / 100);
    const lineTotal = taxableBase + lineTax;

    subtotal += lineSub;
    lineDiscountSum += lineDisc;
    taxTotal += lineTax;

    return {
      product_id: item.product_id ? String(item.product_id) : null,
      sku: String(item.sku || '').trim(),
      name: String(item.name || 'Sản phẩm / Dịch vụ').trim(),
      description: String(item.description || '').trim(),
      unit: String(item.unit || 'Cái').trim() || 'Cái',
      qty,
      unit_price_vnd: unitPrice,
      discount_pct: discountPct,
      tax_pct: taxPct,
      line_subtotal_vnd: lineSub,
      line_discount_vnd: lineDisc,
      line_tax_vnd: lineTax,
      line_total_vnd: lineTotal,
    };
  });

  const extraOrderDiscount = Math.max(0, Math.round(Number(rawOrderDiscountVnd || 0)));
  const totalDiscount = lineDiscountSum + extraOrderDiscount;
  const shippingFee = Math.max(0, Math.round(Number(rawShippingFeeVnd || 0)));
  const total = Math.max(0, subtotal - totalDiscount + taxTotal + shippingFee);

  return {
    items: normalized,
    subtotal,
    discount: totalDiscount,
    taxTotal,
    shippingFee,
    total,
  };
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

function toMonthKey(rawDate: unknown): string {
  if (!rawDate) return new Date().toISOString().slice(0, 7);
  const d = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 7);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ============================================================================
// 1. P&L Cashflow Forecast Dashboard + Dynamic Legal Entity & VietQR Preview
// ============================================================================
router.get('/dashboard', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const branchId = typeof req.query.branch_id === 'string' ? req.query.branch_id.trim() : null;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [
        legalEntity,
        txRowsRes,
        soSum,
        depSum,
        dealSum,
        expSum,
        invSum,
        poSum,
        leadsRes,
        branchesRes,
        staffRes,
      ] = await Promise.all([
        resolvePrimaryBranchLegalInfo(client, ctx.tenantId, branchId),
        client.query<{
          tx_type: string;
          category: string;
          amount_vnd: string | number;
          status: string;
          tx_date: string | Date;
        }>(
          `SELECT tx_type, category, amount_vnd, status, tx_date
           FROM tenant_finance_transactions
           WHERE tenant_id = $1
           ORDER BY tx_date DESC
           LIMIT 500`,
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
        client.query<{
          pending_expenses_vnd: string | number;
          approved_expenses_vnd: string | number;
          expenses_count: string | number;
        }>(
          `SELECT COALESCE(SUM(CASE WHEN approval_status = 'pending_approval' THEN total_amount_vnd ELSE 0 END), 0) AS pending_expenses_vnd,
                  COALESCE(SUM(CASE WHEN approval_status IN ('approved', 'paid') THEN total_amount_vnd ELSE 0 END), 0) AS approved_expenses_vnd,
                  COUNT(*)::int AS expenses_count
           FROM tenant_expenses
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{
          invoices_count: string | number;
          unpaid_invoices_vnd: string | number;
        }>(
          `SELECT COUNT(*)::int AS invoices_count,
                  COALESCE(SUM(CASE WHEN status NOT IN ('paid', 'cancelled') THEN (total_vnd - paid_vnd) ELSE 0 END), 0) AS unpaid_invoices_vnd
           FROM tenant_invoices
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ unpaid_po_vnd: string | number }>(
          `SELECT COALESCE(SUM(CASE WHEN status NOT IN ('cancelled') AND payment_status <> 'paid' THEN (total_vnd - paid_vnd) ELSE 0 END), 0) AS unpaid_po_vnd
           FROM tenant_purchase_orders
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
        client.query(
          `SELECT id, full_name, email, role
           FROM users
           WHERE tenant_id = $1 AND is_system_bot = false
           ORDER BY full_name ASC`,
          [ctx.tenantId]
        ),
      ]);

      let totalIncome = 0;
      let totalExpense = 0;
      const monthBuckets = new Map<string, { income_vnd: number; expense_vnd: number }>();
      const expenseByCat = new Map<string, { category: string; amount_vnd: number; count: number }>();

      const now = new Date();
      for (let i = 5; i >= 0; i--) {
        const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
        monthBuckets.set(key, { income_vnd: 0, expense_vnd: 0 });
      }

      for (const tx of txRowsRes.rows) {
        if (tx.status !== 'completed') continue;
        const amt = Number(tx.amount_vnd || 0);
        const mKey = toMonthKey(tx.tx_date);
        const bucket = monthBuckets.get(mKey) || { income_vnd: 0, expense_vnd: 0 };
        if (tx.tx_type === 'income') {
          totalIncome += amt;
          bucket.income_vnd += amt;
        } else if (tx.tx_type === 'expense') {
          totalExpense += amt;
          bucket.expense_vnd += amt;
          const catKey = String(tx.category || 'operating_expense');
          const curCat = expenseByCat.get(catKey) || { category: catKey, amount_vnd: 0, count: 0 };
          curCat.amount_vnd += amt;
          curCat.count += 1;
          expenseByCat.set(catKey, curCat);
        }
        monthBuckets.set(mKey, bucket);
      }

      const totalCogs = Number(soSum.rows[0]?.total_cogs_vnd || 0);
      const grossProfit = totalIncome - totalCogs;
      const netCashflow = totalIncome - totalExpense;
      const openPipeline = Number(dealSum.rows[0]?.open_pipeline_vnd || 0);
      const pendingExpenses = Number(expSum.rows[0]?.pending_expenses_vnd || 0);

      const monthlyCashflow = Array.from(monthBuckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, vals], idx, arr) => {
          const net = vals.income_vnd - vals.expense_vnd;
          const isCurrent = idx === arr.length - 1;
          const forecastNet = isCurrent
            ? net + Math.round(openPipeline * 0.35) - pendingExpenses
            : net;
          return {
            month,
            income_vnd: vals.income_vnd,
            expense_vnd: vals.expense_vnd,
            net_cashflow_vnd: net,
            forecast_net_vnd: forecastNet,
          };
        });

      const totalSoVnd = Number(soSum.rows[0]?.total_so_vnd || 0);
      const totalPaidVnd = Number(soSum.rows[0]?.total_paid_vnd || 0);

      return {
        summary: {
          total_income_vnd: totalIncome,
          total_expense_vnd: totalExpense,
          net_cashflow_vnd: netCashflow,
          total_cogs_vnd: totalCogs,
          gross_profit_vnd: grossProfit,
          orders_count: Number(soSum.rows[0]?.orders_count || 0),
          paid_orders_count: Number(soSum.rows[0]?.paid_orders_count || 0),
          total_so_vnd: totalSoVnd,
          total_paid_vnd: totalPaidVnd,
          deposits_held_vnd: Number(depSum.rows[0]?.deposits_held_vnd || 0),
          deposits_count: Number(depSum.rows[0]?.deposits_count || 0),
          open_pipeline_vnd: openPipeline,
          won_deals_vnd: Number(dealSum.rows[0]?.won_deals_vnd || 0),
          deals_count: Number(dealSum.rows[0]?.deals_count || 0),
          tx_count: txRowsRes.rows.length,
          expenses_count: Number(expSum.rows[0]?.expenses_count || 0),
          pending_expenses_vnd: pendingExpenses,
          approved_expenses_vnd: Number(expSum.rows[0]?.approved_expenses_vnd || 0),
          invoices_count: Number(invSum.rows[0]?.invoices_count || 0),
          receivables_vnd:
            Math.max(0, totalSoVnd - totalPaidVnd) + Number(invSum.rows[0]?.unpaid_invoices_vnd || 0),
          payables_vnd: pendingExpenses + Number(poSum.rows[0]?.unpaid_po_vnd || 0),
        },
        monthly_cashflow: monthlyCashflow,
        expense_breakdown: Array.from(expenseByCat.values()).sort((a, b) => b.amount_vnd - a.amount_vnd),
        legal_entity: legalEntity,
        branches: branchesRes.rows,
        staff: staffRes.rows,
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
    const overrideBin = typeof req.query.bank_bin === 'string' ? req.query.bank_bin.trim() : '';
    const overrideAcc = typeof req.query.bank_account_no === 'string' ? req.query.bank_account_no.trim() : '';
    const overrideHolder = typeof req.query.bank_account_holder === 'string' ? req.query.bank_account_holder.trim() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const legal = await resolvePrimaryBranchLegalInfo(client, ctx.tenantId, branchId);
      const transferNote = `${refCode} ${legal.branch_code || ''}`.trim();
      return {
        legal_entity: legal,
        amount_vnd: amountVnd,
        transfer_note: transferNote,
        qr_image_url: buildVietQrImageUrl({
          bankBin: overrideBin || legal.bank_bin,
          accountNo: overrideAcc || legal.bank_account_no,
          accountHolder: overrideHolder || legal.bank_account_holder,
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
        sql += " AND (LOWER(c.name) LIKE LOWER($2) OR LOWER(COALESCE(c.tax_code, '')) LIKE LOWER($2))";
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
// 3. Quotes (`tenant_quotes` + `tenant_quote_items`) -> 1-Click Convert to SO
// ============================================================================
router.get('/quotes', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT q.*,
               c.name AS company_name,
               c.tax_code AS company_tax_code,
               l.name AS lead_name,
               d.title AS deal_title
        FROM tenant_quotes q
        LEFT JOIN tenant_b2b_companies c ON c.tenant_id = q.tenant_id AND c.id = q.company_id
        LEFT JOIN leads l ON l.tenant_id = q.tenant_id AND l.id = q.lead_id
        LEFT JOIN tenant_deals d ON d.tenant_id = q.tenant_id AND d.id = q.deal_id
        WHERE q.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;
      if (statusFilter && statusFilter !== 'all') {
        sql += ` AND q.status = $${pIdx}`;
        params.push(statusFilter);
        pIdx++;
      }
      if (q) {
        sql += ` AND (LOWER(q.quote_code) LIKE LOWER($${pIdx}) OR LOWER(q.title) LIKE LOWER($${pIdx}))`;
        params.push(`%${q}%`);
        pIdx++;
      }
      sql += ' ORDER BY q.created_at DESC LIMIT 120';

      const [r, lineRows] = await Promise.all([
        client.query(sql, params),
        client.query(
          'SELECT * FROM tenant_quote_items WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC',
          [ctx.tenantId]
        ),
      ]);

      const linesByQuote = new Map<string, any[]>();
      for (const lr of lineRows.rows) {
        const list = linesByQuote.get(lr.quote_id) || [];
        list.push({
          ...lr,
          qty: Number(lr.qty || 1),
          unit_price_vnd: Number(lr.unit_price_vnd || 0),
          discount_pct: Number(lr.discount_pct || 0),
          tax_pct: Number(lr.tax_pct || 0),
          line_subtotal_vnd: Number(lr.line_subtotal_vnd || 0),
          line_discount_vnd: Number(lr.line_discount_vnd || 0),
          line_tax_vnd: Number(lr.line_tax_vnd || 0),
          line_total_vnd: Number(lr.line_total_vnd || 0),
        });
        linesByQuote.set(lr.quote_id, list);
      }

      return r.rows.map((row) => {
        const dbItems = linesByQuote.get(row.id);
        const fallbackItems = parseJsonSafe(row.items_json, []);
        return {
          ...row,
          subtotal_vnd: Number(row.subtotal_vnd || 0),
          discount_vnd: Number(row.discount_vnd || 0),
          tax_vnd: Number(row.tax_vnd || 0),
          shipping_fee_vnd: Number(row.shipping_fee_vnd || 0),
          total_vnd: Number(row.total_vnd || 0),
          items: dbItems && dbItems.length > 0 ? dbItems : fallbackItems,
        };
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_QUOTES_FAILED', err?.message || 'Không thể tải danh sách Báo giá.');
  }
});

router.get('/quotes/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const quoteId = req.params.id;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const qRes = await client.query(
        `SELECT q.*, c.name AS company_name, c.tax_code AS company_tax_code, c.billing_address AS company_address,
                l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
         FROM tenant_quotes q
         LEFT JOIN tenant_b2b_companies c ON c.tenant_id = q.tenant_id AND c.id = q.company_id
         LEFT JOIN leads l ON l.tenant_id = q.tenant_id AND l.id = q.lead_id
         WHERE q.tenant_id = $1 AND q.id = $2 LIMIT 1`,
        [ctx.tenantId, quoteId]
      );
      if (!qRes.rows[0]) return null;
      const row = qRes.rows[0];
      const [itemsRes, legalEntity] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_quote_items WHERE tenant_id = $1 AND quote_id = $2 ORDER BY sort_order ASC',
          [ctx.tenantId, quoteId]
        ),
        resolvePrimaryBranchLegalInfo(client, ctx.tenantId, row.branch_id),
      ]);
      const dbItems = itemsRes.rows.map((lr) => ({
        ...lr,
        qty: Number(lr.qty || 1),
        unit_price_vnd: Number(lr.unit_price_vnd || 0),
        discount_pct: Number(lr.discount_pct || 0),
        tax_pct: Number(lr.tax_pct || 0),
        line_total_vnd: Number(lr.line_total_vnd || 0),
      }));
      return {
        ...row,
        subtotal_vnd: Number(row.subtotal_vnd || 0),
        discount_vnd: Number(row.discount_vnd || 0),
        tax_vnd: Number(row.tax_vnd || 0),
        shipping_fee_vnd: Number(row.shipping_fee_vnd || 0),
        total_vnd: Number(row.total_vnd || 0),
        items: dbItems.length > 0 ? dbItems : parseJsonSafe(row.items_json, []),
        legal_entity: legalEntity,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'QUOTE_NOT_FOUND', 'Không tìm thấy Báo giá.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_QUOTE_FAILED', err?.message || 'Không thể tải chi tiết Báo giá.');
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

    const computed = computeLineTotals(
      body.items,
      body.discount_vnd,
      body.shipping_fee_vnd,
      body.tax_pct
    );
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
           status, items_json, subtotal_vnd, discount_vnd, tax_vnd, shipping_fee_vnd, total_vnd,
           valid_until, terms_text, notes, customer_name, customer_email, customer_phone, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          id,
          ctx.tenantId,
          quoteCode,
          title,
          body.company_id || null,
          body.lead_id || null,
          body.deal_id || null,
          body.branch_id || null,
          ['draft', 'sent', 'accepted', 'converted', 'rejected', 'expired'].includes(String(body.status))
            ? body.status
            : 'sent',
          JSON.stringify(computed.items),
          subtotalVnd,
          computed.discount,
          computed.taxTotal,
          computed.shippingFee,
          totalVnd,
          body.valid_until || null,
          body.terms_text ? String(body.terms_text) : null,
          body.notes ? String(body.notes) : null,
          body.customer_name ? String(body.customer_name) : null,
          body.customer_email ? String(body.customer_email) : null,
          body.customer_phone ? String(body.customer_phone) : null,
          ctx.userId,
        ]
      );

      for (let idx = 0; idx < computed.items.length; idx++) {
        const li = computed.items[idx];
        await client.query(
          `INSERT INTO tenant_quote_items (
             id, tenant_id, quote_id, product_id, sku, name, description, unit,
             qty, unit_price_vnd, discount_pct, tax_pct,
             line_subtotal_vnd, line_discount_vnd, line_tax_vnd, line_total_vnd, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            id,
            li.product_id,
            li.sku,
            li.name,
            li.description || null,
            li.unit,
            li.qty,
            li.unit_price_vnd,
            li.discount_pct,
            li.tax_pct,
            li.line_subtotal_vnd,
            li.line_discount_vnd,
            li.line_tax_vnd,
            li.line_total_vnd,
            idx,
          ]
        );
      }

      const r = await client.query('SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return {
        ...r.rows[0],
        subtotal_vnd: Number(r.rows[0].subtotal_vnd || 0),
        discount_vnd: Number(r.rows[0].discount_vnd || 0),
        tax_vnd: Number(r.rows[0].tax_vnd || 0),
        shipping_fee_vnd: Number(r.rows[0].shipping_fee_vnd || 0),
        total_vnd: Number(r.rows[0].total_vnd || 0),
        items: computed.items,
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_QUOTE_FAILED', err?.message || 'Không thể khởi tạo Báo giá.');
  }
});

router.patch('/quotes/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const quoteId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query('SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        quoteId,
      ]);
      if (!curRes.rows[0]) return null;
      const cur = curRes.rows[0];

      const hasNewItems = Array.isArray(body.items);
      const computed = hasNewItems
        ? computeLineTotals(
            body.items,
            body.discount_vnd ?? cur.discount_vnd,
            body.shipping_fee_vnd ?? cur.shipping_fee_vnd,
            body.tax_pct
          )
        : null;

      await client.query(
        `UPDATE tenant_quotes
         SET title = $3,
             status = $4,
             valid_until = $5,
             terms_text = $6,
             notes = $7,
             items_json = $8::jsonb,
             subtotal_vnd = $9,
             discount_vnd = $10,
             tax_vnd = $11,
             shipping_fee_vnd = $12,
             total_vnd = $13,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          quoteId,
          body.title !== undefined ? String(body.title).trim() : cur.title,
          body.status || cur.status,
          body.valid_until !== undefined ? body.valid_until || null : cur.valid_until,
          body.terms_text !== undefined ? body.terms_text : cur.terms_text,
          body.notes !== undefined ? body.notes : cur.notes,
          computed ? JSON.stringify(computed.items) : JSON.stringify(parseJsonSafe(cur.items_json, [])),
          computed ? computed.subtotal : Number(cur.subtotal_vnd || 0),
          computed ? computed.discount : Number(cur.discount_vnd || 0),
          computed ? computed.taxTotal : Number(cur.tax_vnd || 0),
          computed ? computed.shippingFee : Number(cur.shipping_fee_vnd || 0),
          computed ? computed.total : Number(cur.total_vnd || 0),
        ]
      );

      if (computed) {
        await client.query('DELETE FROM tenant_quote_items WHERE tenant_id = $1 AND quote_id = $2', [
          ctx.tenantId,
          quoteId,
        ]);
        for (let idx = 0; idx < computed.items.length; idx++) {
          const li = computed.items[idx];
          await client.query(
            `INSERT INTO tenant_quote_items (
               id, tenant_id, quote_id, product_id, sku, name, description, unit,
               qty, unit_price_vnd, discount_pct, tax_pct,
               line_subtotal_vnd, line_discount_vnd, line_tax_vnd, line_total_vnd, sort_order
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              quoteId,
              li.product_id,
              li.sku,
              li.name,
              li.description || null,
              li.unit,
              li.qty,
              li.unit_price_vnd,
              li.discount_pct,
              li.tax_pct,
              li.line_subtotal_vnd,
              li.line_discount_vnd,
              li.line_tax_vnd,
              li.line_total_vnd,
              idx,
            ]
          );
        }
      }

      const r = await client.query('SELECT * FROM tenant_quotes WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        quoteId,
      ]);
      return {
        ...r.rows[0],
        subtotal_vnd: Number(r.rows[0].subtotal_vnd || 0),
        total_vnd: Number(r.rows[0].total_vnd || 0),
        items: computed ? computed.items : parseJsonSafe(r.rows[0].items_json, []),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'QUOTE_NOT_FOUND', 'Không tìm thấy Báo giá.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_QUOTE_FAILED', err?.message || 'Không thể cập nhật Báo giá.');
  }
});

router.delete('/quotes/:id', requirePermission('finance', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const quoteId = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM tenant_quotes WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        quoteId,
      ]);
      return r.rowCount > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'QUOTE_NOT_FOUND', 'Không tìm thấy Báo giá.');
      return;
    }
    res.json({ success: true, data: { id: quoteId, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_QUOTE_FAILED', err?.message || 'Không thể xóa Báo giá.');
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

      let customerName = String(req.body?.customer_name || quote.customer_name || '').trim();
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

      const quoteLineRows = await client.query(
        'SELECT * FROM tenant_quote_items WHERE tenant_id = $1 AND quote_id = $2 ORDER BY sort_order ASC',
        [ctx.tenantId, quoteId]
      );
      const parsedItems =
        quoteLineRows.rows.length > 0 ? quoteLineRows.rows : parseJsonSafe<any[]>(quote.items_json, []);

      const orderId = crypto.randomUUID();
      const orderCode = `SO-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      await client.query(
        `INSERT INTO tenant_sales_orders (
           id, tenant_id, order_code, quote_id, company_id, lead_id, deal_id, branch_id,
           warehouse_id, sales_rep_id, customer_name, status, payment_status, fulfillment_status,
           items_json, subtotal_vnd, discount_vnd, tax_vnd, shipping_fee_vnd, total_vnd, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'confirmed', 'unpaid', 'pending', $12::jsonb, $13, $14, $15, $16, $17, $18)`,
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
          JSON.stringify(parsedItems),
          Number(quote.subtotal_vnd || 0),
          Number(quote.discount_vnd || 0),
          Number(quote.tax_vnd || 0),
          Number(quote.shipping_fee_vnd || 0),
          Number(quote.total_vnd || 0),
          `Chuyển đổi từ Báo giá ${quote.quote_code}`,
        ]
      );

      for (let idx = 0; idx < parsedItems.length; idx++) {
        const li = parsedItems[idx];
        await client.query(
          `INSERT INTO tenant_sales_order_items (
             id, tenant_id, sales_order_id, product_id, sku, name, description, unit,
             qty, fulfilled_qty, unit_price_vnd, discount_pct, tax_pct,
             line_subtotal_vnd, line_discount_vnd, line_tax_vnd, line_total_vnd, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            orderId,
            li.product_id || null,
            String(li.sku || ''),
            String(li.name || 'Sản phẩm'),
            li.description ? String(li.description) : null,
            String(li.unit || 'Cái'),
            Number(li.qty || 1),
            Number(li.unit_price_vnd || 0),
            Number(li.discount_pct || 0),
            Number(li.tax_pct || 0),
            Number(li.line_subtotal_vnd || Number(li.qty || 1) * Number(li.unit_price_vnd || 0)),
            Number(li.line_discount_vnd || 0),
            Number(li.line_tax_vnd || 0),
            Number(li.line_total_vnd || Number(li.qty || 1) * Number(li.unit_price_vnd || 0)),
            idx,
          ]
        );
      }

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
          items: parsedItems,
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
// 4. Sales Orders (`tenant_sales_orders` + `tenant_sales_order_items`)
// ============================================================================
router.get('/sales-orders', requirePermission('finance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [r, lineRows] = await Promise.all([
        client.query(
          `SELECT so.*,
                  c.name AS company_name,
                  l.name AS lead_name
           FROM tenant_sales_orders so
           LEFT JOIN tenant_b2b_companies c ON c.tenant_id = so.tenant_id AND c.id = so.company_id
           LEFT JOIN leads l ON l.tenant_id = so.tenant_id AND l.id = so.lead_id
           WHERE so.tenant_id = $1
           ORDER BY so.created_at DESC
           LIMIT 120`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT * FROM tenant_sales_order_items WHERE tenant_id = $1 ORDER BY sort_order ASC',
          [ctx.tenantId]
        ),
      ]);

      const linesBySo = new Map<string, any[]>();
      for (const lr of lineRows.rows) {
        const list = linesBySo.get(lr.sales_order_id) || [];
        list.push({
          ...lr,
          qty: Number(lr.qty || 1),
          fulfilled_qty: Number(lr.fulfilled_qty || 0),
          unit_price_vnd: Number(lr.unit_price_vnd || 0),
          discount_pct: Number(lr.discount_pct || 0),
          tax_pct: Number(lr.tax_pct || 0),
          line_total_vnd: Number(lr.line_total_vnd || 0),
        });
        linesBySo.set(lr.sales_order_id, list);
      }

      return r.rows.map((row) => {
        const dbItems = linesBySo.get(row.id);
        return {
          ...row,
          subtotal_vnd: Number(row.subtotal_vnd || 0),
          discount_vnd: Number(row.discount_vnd || 0),
          tax_vnd: Number(row.tax_vnd || 0),
          shipping_fee_vnd: Number(row.shipping_fee_vnd || 0),
          total_vnd: Number(row.total_vnd || 0),
          paid_vnd: Number(row.paid_vnd || 0),
          attributed_revenue_vnd: Number(row.attributed_revenue_vnd || 0),
          cogs_vnd: Number(row.cogs_vnd || 0),
          items: dbItems && dbItems.length > 0 ? dbItems : parseJsonSafe(row.items_json, []),
        };
      });
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
    const computed = computeLineTotals(
      body.items,
      body.discount_vnd,
      body.shipping_fee_vnd,
      body.tax_pct
    );
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
           fulfillment_status, items_json, subtotal_vnd, discount_vnd, tax_vnd, shipping_fee_vnd,
           total_vnd, voucher_code, payment_method, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', 'unpaid', 'pending', $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19)`,
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
          computed.shippingFee,
          totalVnd,
          body.voucher_code ? String(body.voucher_code).trim() : null,
          body.payment_method || 'bank_transfer',
          body.notes ? String(body.notes) : null,
        ]
      );

      for (let idx = 0; idx < computed.items.length; idx++) {
        const li = computed.items[idx];
        await client.query(
          `INSERT INTO tenant_sales_order_items (
             id, tenant_id, sales_order_id, product_id, sku, name, description, unit,
             qty, fulfilled_qty, unit_price_vnd, discount_pct, tax_pct,
             line_subtotal_vnd, line_discount_vnd, line_tax_vnd, line_total_vnd, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            id,
            li.product_id,
            li.sku,
            li.name,
            li.description || null,
            li.unit,
            li.qty,
            li.unit_price_vnd,
            li.discount_pct,
            li.tax_pct,
            li.line_subtotal_vnd,
            li.line_discount_vnd,
            li.line_tax_vnd,
            li.line_total_vnd,
            idx,
          ]
        );
      }

      const r = await client.query('SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        total_vnd: Number(r.rows[0].total_vnd || 0),
        paid_vnd: Number(r.rows[0].paid_vnd || 0),
        items: computed.items,
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
            await client.query(
              `UPDATE tenant_sales_order_items
               SET fulfilled_qty = qty
               WHERE tenant_id = $1 AND sales_order_id = $2 AND product_id = $3`,
              [ctx.tenantId, so.id, prod.id]
            );
          }
        }
      }

      const nextCogs = Number(so.cogs_vnd || 0) + addedCogs;
      const nextPaymentStatus = nextPaid >= totalVnd ? 'paid' : nextPaid > 0 ? 'partial' : 'unpaid';
      await client.query(
        `UPDATE tenant_sales_orders
         SET status = $7,
             payment_status = $8,
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
          nextPaymentStatus === 'paid' ? 'completed' : so.status,
          nextPaymentStatus,
        ]
      );

      if (revenueDelta > 0) {
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

      if (body.issue_invoice === true) {
        const invCheck = await client.query<{ id: string }>(
          'SELECT id FROM tenant_invoices WHERE tenant_id = $1 AND sales_order_id = $2 LIMIT 1',
          [ctx.tenantId, so.id]
        );
        if (!invCheck.rows[0]) {
          const invId = crypto.randomUUID();
          const invCode = `INV-${so.order_code}`;
          await client.query(
            `INSERT INTO tenant_invoices (
               id, tenant_id, invoice_code, invoice_type, sales_order_id, company_id, lead_id, branch_id,
               customer_name, status, issue_date, items_json, subtotal_vnd, discount_vnd, tax_vnd,
               shipping_fee_vnd, total_vnd, paid_vnd, payment_method, created_by
             ) VALUES ($1, $2, $3, 'sales', $4, $5, $6, $7, $8, $9, CURRENT_DATE, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18)`,
            [
              invId,
              ctx.tenantId,
              invCode,
              so.id,
              so.company_id || null,
              so.lead_id || null,
              so.branch_id || null,
              so.customer_name,
              nextPaymentStatus === 'paid' ? 'paid' : 'partial',
              JSON.stringify(parseJsonSafe(so.items_json, [])),
              Number(so.subtotal_vnd || 0),
              Number(so.discount_vnd || 0),
              Number(so.tax_vnd || 0),
              Number(so.shipping_fee_vnd || 0),
              totalVnd,
              nextPaid,
              body.payment_method || 'bank_transfer',
              ctx.userId,
            ]
          );
        }
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
// 5. Invoices (`tenant_invoices` & `tenant_invoice_items` — Printable / VAT)
// ============================================================================
router.get('/invoices', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const invoiceType = typeof req.query.invoice_type === 'string' ? req.query.invoice_type.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM tenant_invoices WHERE tenant_id = $1';
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;
      if (statusFilter && statusFilter !== 'all') {
        sql += ` AND status = $${pIdx}`;
        params.push(statusFilter);
        pIdx++;
      }
      if (invoiceType && invoiceType !== 'all') {
        sql += ` AND invoice_type = $${pIdx}`;
        params.push(invoiceType);
        pIdx++;
      }
      if (q) {
        sql += ` AND (LOWER(invoice_code) LIKE LOWER($${pIdx}) OR LOWER(customer_name) LIKE LOWER($${pIdx}))`;
        params.push(`%${q}%`);
        pIdx++;
      }
      sql += ' ORDER BY issue_date DESC, created_at DESC LIMIT 150';

      const [r, lineRows] = await Promise.all([
        client.query(sql, params),
        client.query('SELECT * FROM tenant_invoice_items WHERE tenant_id = $1 ORDER BY sort_order ASC', [
          ctx.tenantId,
        ]),
      ]);

      const linesByInv = new Map<string, any[]>();
      for (const lr of lineRows.rows) {
        const list = linesByInv.get(lr.invoice_id) || [];
        list.push({
          ...lr,
          qty: Number(lr.qty || 1),
          unit_price_vnd: Number(lr.unit_price_vnd || 0),
          discount_pct: Number(lr.discount_pct || 0),
          tax_pct: Number(lr.tax_pct || 0),
          line_total_vnd: Number(lr.line_total_vnd || 0),
        });
        linesByInv.set(lr.invoice_id, list);
      }

      let totalInvoiced = 0;
      let paidAmt = 0;
      let pendingAmt = 0;
      let overdueAmt = 0;
      const todayMs = Date.now();

      const items = r.rows.map((row) => {
        const tot = Number(row.total_vnd || 0);
        const paid = Number(row.paid_vnd || 0);
        const remain = Math.max(0, tot - paid);
        if (row.status !== 'cancelled') {
          totalInvoiced += tot;
          paidAmt += paid;
          pendingAmt += remain;
          if (remain > 0 && row.due_date && new Date(row.due_date).getTime() < todayMs) {
            overdueAmt += remain;
          }
        }
        const dbItems = linesByInv.get(row.id);
        return {
          ...row,
          subtotal_vnd: Number(row.subtotal_vnd || 0),
          discount_vnd: Number(row.discount_vnd || 0),
          tax_vnd: Number(row.tax_vnd || 0),
          shipping_fee_vnd: Number(row.shipping_fee_vnd || 0),
          total_vnd: tot,
          paid_vnd: paid,
          items: dbItems && dbItems.length > 0 ? dbItems : parseJsonSafe(row.items_json, []),
        };
      });

      return {
        items,
        summary: {
          total_invoiced_vnd: totalInvoiced,
          paid_vnd: paidAmt,
          pending_vnd: pendingAmt,
          overdue_vnd: overdueAmt,
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_INVOICES_FAILED', err?.message || 'Không thể tải danh sách Hóa đơn.');
  }
});

router.get('/invoices/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const invId = req.params.id;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_invoices WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        invId,
      ]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      const [linesRes, legalEntity] = await Promise.all([
        client.query('SELECT * FROM tenant_invoice_items WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY sort_order ASC', [
          ctx.tenantId,
          invId,
        ]),
        resolvePrimaryBranchLegalInfo(client, ctx.tenantId, row.branch_id),
      ]);
      const remain = Math.max(0, Number(row.total_vnd || 0) - Number(row.paid_vnd || 0));
      return {
        ...row,
        subtotal_vnd: Number(row.subtotal_vnd || 0),
        discount_vnd: Number(row.discount_vnd || 0),
        tax_vnd: Number(row.tax_vnd || 0),
        shipping_fee_vnd: Number(row.shipping_fee_vnd || 0),
        total_vnd: Number(row.total_vnd || 0),
        paid_vnd: Number(row.paid_vnd || 0),
        items: linesRes.rows.length > 0 ? linesRes.rows : parseJsonSafe(row.items_json, []),
        legal_entity: legalEntity,
        vietqr_url: buildVietQrImageUrl({
          bankBin: legalEntity.bank_bin,
          accountNo: legalEntity.bank_account_no,
          accountHolder: legalEntity.bank_account_holder,
          amountVnd: remain > 0 ? remain : Number(row.total_vnd || 0),
          transferNote: row.invoice_code,
        }),
      };
    });

    if (!data) {
      sendApiError(res, 404, 'INVOICE_NOT_FOUND', 'Không tìm thấy Hóa đơn.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_INVOICE_FAILED', err?.message || 'Không thể tải chi tiết Hóa đơn.');
  }
});

router.post('/invoices', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sourceSo: any = null;
      if (body.sales_order_id) {
        const soR = await client.query('SELECT * FROM tenant_sales_orders WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          body.sales_order_id,
        ]);
        sourceSo = soR.rows[0] || null;
      }

      const rawItems = Array.isArray(body.items)
        ? body.items
        : sourceSo
          ? parseJsonSafe(sourceSo.items_json, [])
          : [];
      const computed = computeLineTotals(
        rawItems,
        body.discount_vnd ?? sourceSo?.discount_vnd ?? 0,
        body.shipping_fee_vnd ?? sourceSo?.shipping_fee_vnd ?? 0,
        body.tax_pct ?? 0
      );

      const customerName = String(
        body.customer_name || sourceSo?.customer_name || 'Khách hàng'
      ).trim();
      const totalVnd =
        computed.items.length > 0
          ? computed.total
          : Math.max(0, Math.round(Number(body.total_vnd ?? sourceSo?.total_vnd ?? 0)));
      const subtotalVnd = computed.items.length > 0 ? computed.subtotal : totalVnd;
      const paidVnd = Math.max(0, Math.round(Number(body.paid_vnd ?? sourceSo?.paid_vnd ?? 0)));
      const status =
        body.status || (paidVnd >= totalVnd && totalVnd > 0 ? 'paid' : paidVnd > 0 ? 'partial' : 'issued');

      const id = crypto.randomUUID();
      const invoiceCode =
        String(body.invoice_code || '').trim().toUpperCase() ||
        `INV-${Date.now().toString(36).toUpperCase().slice(-6)}`;

      await client.query(
        `INSERT INTO tenant_invoices (
           id, tenant_id, invoice_code, invoice_type, sales_order_id, purchase_order_id, quote_id,
           company_id, lead_id, supplier_id, branch_id, customer_name, customer_tax_code,
           customer_address, customer_email, status, issue_date, due_date, items_json,
           subtotal_vnd, discount_vnd, tax_vnd, shipping_fee_vnd, total_vnd, paid_vnd,
           payment_method, vat_invoice_no, vat_serial, notes, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13,
           $14, $15, $16, COALESCE($17::date, CURRENT_DATE), $18, $19::jsonb,
           $20, $21, $22, $23, $24, $25,
           $26, $27, $28, $29, $30
         )`,
        [
          id,
          ctx.tenantId,
          invoiceCode,
          body.invoice_type === 'purchase' ? 'purchase' : 'sales',
          body.sales_order_id || null,
          body.purchase_order_id || null,
          body.quote_id || null,
          body.company_id || sourceSo?.company_id || null,
          body.lead_id || sourceSo?.lead_id || null,
          body.supplier_id || null,
          body.branch_id || sourceSo?.branch_id || null,
          customerName,
          body.customer_tax_code ? String(body.customer_tax_code) : null,
          body.customer_address ? String(body.customer_address) : null,
          body.customer_email ? String(body.customer_email) : null,
          status,
          body.issue_date || null,
          body.due_date || null,
          JSON.stringify(computed.items),
          subtotalVnd,
          computed.discount,
          computed.taxTotal,
          computed.shippingFee,
          totalVnd,
          paidVnd,
          body.payment_method || 'bank_transfer',
          body.vat_invoice_no ? String(body.vat_invoice_no) : null,
          body.vat_serial ? String(body.vat_serial) : null,
          body.notes ? String(body.notes) : null,
          ctx.userId,
        ]
      );

      for (let idx = 0; idx < computed.items.length; idx++) {
        const li = computed.items[idx];
        await client.query(
          `INSERT INTO tenant_invoice_items (
             id, tenant_id, invoice_id, product_id, sku, name, description, unit,
             qty, unit_price_vnd, discount_pct, tax_pct, line_total_vnd, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            id,
            li.product_id,
            li.sku,
            li.name,
            li.description || null,
            li.unit,
            li.qty,
            li.unit_price_vnd,
            li.discount_pct,
            li.tax_pct,
            li.line_total_vnd,
            idx,
          ]
        );
      }

      const r = await client.query('SELECT * FROM tenant_invoices WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        total_vnd: Number(r.rows[0].total_vnd || 0),
        paid_vnd: Number(r.rows[0].paid_vnd || 0),
        items: computed.items,
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_INVOICE_FAILED', err?.message || 'Không thể phát hành Hóa đơn.');
  }
});

router.post('/invoices/:id/record-payment', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const invId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_invoices WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        invId,
      ]);
      if (!r.rows[0]) return null;
      const inv = r.rows[0];

      const totalVnd = Number(inv.total_vnd || 0);
      const prevPaid = Number(inv.paid_vnd || 0);
      const payAdd =
        body.amount_vnd !== undefined
          ? Math.max(0, Math.round(Number(body.amount_vnd)))
          : Math.max(0, totalVnd - prevPaid);
      const nextPaid = Math.min(totalVnd, prevPaid + payAdd);
      const delta = Math.max(0, nextPaid - prevPaid);
      const nextStatus = nextPaid >= totalVnd ? 'paid' : nextPaid > 0 ? 'partial' : inv.status;

      await client.query(
        `UPDATE tenant_invoices
         SET paid_vnd = $3,
             status = $4,
             payment_method = $5,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, invId, nextPaid, nextStatus, body.payment_method || inv.payment_method || 'bank_transfer']
      );

      if (delta > 0) {
        const txType = inv.invoice_type === 'purchase' ? 'expense' : 'income';
        await client.query(
          `INSERT INTO tenant_finance_transactions (
             id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
             counterparty_name, counterparty_tax_code, branch_id, lead_id, company_id,
             sales_order_id, purchase_order_id, description, created_by
           ) VALUES ($1, $2, $3, $4, 'invoice_settlement', $5, $6, 'completed', $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            `${txType === 'income' ? 'PT' : 'PC'}-${inv.invoice_code}-${Date.now().toString(36).slice(-3).toUpperCase()}`,
            txType,
            delta,
            body.payment_method || 'bank_transfer',
            inv.customer_name,
            inv.customer_tax_code || null,
            inv.branch_id || null,
            inv.lead_id || null,
            inv.company_id || null,
            inv.sales_order_id || null,
            inv.purchase_order_id || null,
            `Thanh toán hóa đơn ${inv.invoice_code}`,
            ctx.userId,
          ]
        );
      }

      const fresh = await client.query('SELECT * FROM tenant_invoices WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        invId,
      ]);
      return {
        ...fresh.rows[0],
        total_vnd: Number(fresh.rows[0].total_vnd || 0),
        paid_vnd: Number(fresh.rows[0].paid_vnd || 0),
        payment_delta_vnd: delta,
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'INVOICE_NOT_FOUND', 'Không tìm thấy Hóa đơn.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'RECORD_INVOICE_PAYMENT_FAILED', err?.message || 'Không thể ghi nhận thanh toán Hóa đơn.');
  }
});

// ============================================================================
// 6. Deposits (`tenant_deposits` + Multi-Tranche `tenant_deposit_milestones`)
// ============================================================================
router.get('/deposits', requirePermission('finance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [depRes, msRes] = await Promise.all([
        client.query(
          `SELECT d.*,
                  c.name AS company_name,
                  l.name AS lead_name,
                  p.name AS project_name
           FROM tenant_deposits d
           LEFT JOIN tenant_b2b_companies c ON c.tenant_id = d.tenant_id AND c.id = d.company_id
           LEFT JOIN leads l ON l.tenant_id = d.tenant_id AND l.id = d.lead_id
           LEFT JOIN tenant_projects p ON p.tenant_id = d.tenant_id AND p.id = d.project_id
           WHERE d.tenant_id = $1
           ORDER BY d.created_at DESC
           LIMIT 120`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT * FROM tenant_deposit_milestones WHERE tenant_id = $1 ORDER BY tranche_no ASC, created_at ASC',
          [ctx.tenantId]
        ),
      ]);

      const msByDep = new Map<string, any[]>();
      for (const m of msRes.rows) {
        const list = msByDep.get(m.deposit_id) || [];
        list.push({
          ...m,
          tranche_no: Number(m.tranche_no || 1),
          amount_vnd: Number(m.amount_vnd || 0),
        });
        msByDep.set(m.deposit_id, list);
      }

      return depRes.rows.map((row) => {
        const milestones = msByDep.get(row.id) || [];
        const confirmedSum = milestones
          .filter((m) => m.status === 'confirmed')
          .reduce((s, m) => s + m.amount_vnd, 0);
        return {
          ...row,
          amount_vnd: Number(row.amount_vnd || 0),
          contract_value_vnd: Number(row.contract_value_vnd || row.amount_vnd || 0),
          expected_commission_vnd: Number(row.expected_commission_vnd || 0),
          refunded_amount_vnd: Number(row.refunded_amount_vnd || 0),
          milestones,
          confirmed_milestones_vnd: confirmedSum,
          attachments: parseJsonSafe(row.attachments_json, []),
          commission_shares: parseJsonSafe(row.commission_shares_json, []),
          watchers: parseJsonSafe(row.watchers_json, []),
          history: parseJsonSafe(row.history_json, []),
        };
      });
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_DEPOSITS_FAILED', err?.message || 'Không thể tải danh sách Đặt cọc.');
  }
});

router.get('/deposits/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const depId = req.params.id;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT d.*, p.name AS project_name, c.name AS company_name, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
         FROM tenant_deposits d
         LEFT JOIN tenant_projects p ON p.tenant_id = d.tenant_id AND p.id = d.project_id
         LEFT JOIN tenant_b2b_companies c ON c.tenant_id = d.tenant_id AND c.id = d.company_id
         LEFT JOIN leads l ON l.tenant_id = d.tenant_id AND l.id = d.lead_id
         WHERE d.tenant_id = $1 AND d.id = $2 LIMIT 1`,
        [ctx.tenantId, depId]
      );
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      const [msRes, legal] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_deposit_milestones WHERE tenant_id = $1 AND deposit_id = $2 ORDER BY tranche_no ASC',
          [ctx.tenantId, depId]
        ),
        resolvePrimaryBranchLegalInfo(client, ctx.tenantId, null),
      ]);
      const milestones = msRes.rows.map((m) => ({
        ...m,
        tranche_no: Number(m.tranche_no || 1),
        amount_vnd: Number(m.amount_vnd || 0),
      }));
      return {
        ...row,
        amount_vnd: Number(row.amount_vnd || 0),
        contract_value_vnd: Number(row.contract_value_vnd || row.amount_vnd || 0),
        expected_commission_vnd: Number(row.expected_commission_vnd || 0),
        refunded_amount_vnd: Number(row.refunded_amount_vnd || 0),
        milestones,
        attachments: parseJsonSafe(row.attachments_json, []),
        commission_shares: parseJsonSafe(row.commission_shares_json, []),
        watchers: parseJsonSafe(row.watchers_json, []),
        history: parseJsonSafe(row.history_json, []),
        legal_entity: legal,
        vietqr_url: buildVietQrImageUrl({
          bankBin: legal.bank_bin,
          accountNo: legal.bank_account_no,
          accountHolder: legal.bank_account_holder,
          amountVnd: Number(row.amount_vnd || 0),
          transferNote: row.deposit_code,
        }),
      };
    });

    if (!data) {
      sendApiError(res, 404, 'DEPOSIT_NOT_FOUND', 'Không tìm thấy phiếu Đặt cọc.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_DEPOSIT_FAILED', err?.message || 'Không thể tải chi tiết Đặt cọc.');
  }
});

router.post('/deposits', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const rawMilestones = Array.isArray(body.milestones) ? body.milestones : [];
    const milestonesSum = rawMilestones.reduce((s: number, m: any) => s + Math.max(0, Math.round(Number(m.amount_vnd ?? m.amount ?? 0))), 0);
    const amountVnd = Math.round(Number(body.amount_vnd || milestonesSum || 0));
    if (amountVnd <= 0) {
      sendApiError(res, 422, 'DEPOSIT_AMOUNT_INVALID', 'Số tiền đặt cọc phải lớn hơn 0.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      const depCode = `COC-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const status = body.status || 'received';
      const customerName = String(body.customer_name || 'Khách đặt cọc').trim();
      const contractValue = Math.max(amountVnd, Math.round(Number(body.contract_value_vnd || amountVnd)));
      const expectedComm = Math.max(0, Math.round(Number(body.expected_commission_vnd || 0)));
      const initHistory = [
        {
          id: crypto.randomUUID(),
          action: 'created',
          actor_name: ctx.userName || 'Nhân viên',
          note: `Tạo phiếu đặt cọc ${depCode} (${amountVnd.toLocaleString('vi-VN')}₫)`,
          created_at: new Date().toISOString(),
        },
      ];

      await client.query(
        `INSERT INTO tenant_deposits (
           id, tenant_id, deposit_code, lead_id, company_id, deal_id, sales_order_id, project_id,
           unit_code, customer_name, amount_vnd, contract_value_vnd, expected_commission_vnd,
           currency, exchange_rate, payment_method, status, reference_no, unc_attachment_url,
           attachments_json, commission_shares_json, watchers_json, history_json, notes, received_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19,
           $20::jsonb, $21::jsonb, $22::jsonb, $23::jsonb, $24, $25
         )`,
        [
          id,
          ctx.tenantId,
          depCode,
          body.lead_id || null,
          body.company_id || null,
          body.deal_id || null,
          body.sales_order_id || null,
          body.project_id || null,
          body.unit_code ? String(body.unit_code).trim() : null,
          customerName,
          amountVnd,
          contractValue,
          expectedComm,
          body.currency ? String(body.currency).toUpperCase() : 'VND',
          Math.max(1, Number(body.exchange_rate || 1)),
          body.payment_method || 'bank_transfer',
          status,
          body.reference_no ? String(body.reference_no) : null,
          body.unc_attachment_url ? String(body.unc_attachment_url) : null,
          JSON.stringify(Array.isArray(body.attachments) ? body.attachments : []),
          JSON.stringify(Array.isArray(body.commission_shares) ? body.commission_shares : []),
          JSON.stringify(Array.isArray(body.watchers) ? body.watchers : []),
          JSON.stringify(initHistory),
          body.notes ? String(body.notes) : null,
          ctx.userId,
        ]
      );

      const effectiveMilestones =
        rawMilestones.length > 0
          ? rawMilestones
          : [
              {
                name: 'Đợt 1 — Thanh toán đặt cọc',
                amount_vnd: amountVnd,
                expected_pay_date: new Date().toISOString().slice(0, 10),
                status: status === 'received' ? 'confirmed' : 'pending',
                unc_url: body.unc_attachment_url || null,
              },
            ];

      const insertedMilestones: any[] = [];
      for (let i = 0; i < effectiveMilestones.length; i++) {
        const m = effectiveMilestones[i];
        const mId = crypto.randomUUID();
        const mAmt = Math.max(0, Math.round(Number(m.amount_vnd ?? m.amount ?? 0)));
        const mStatus = m.status || (i === 0 && status === 'received' ? 'confirmed' : 'pending');
        await client.query(
          `INSERT INTO tenant_deposit_milestones (
             id, tenant_id, deposit_id, tranche_no, name, amount_vnd, expected_pay_date,
             paid_at, status, payment_method, unc_url, reference_no, note
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            mId,
            ctx.tenantId,
            id,
            i + 1,
            String(m.name || `Đợt ${i + 1}`).trim(),
            mAmt,
            m.expected_pay_date || null,
            mStatus === 'confirmed' ? new Date().toISOString() : null,
            mStatus,
            m.payment_method || body.payment_method || 'bank_transfer',
            m.unc_url || null,
            m.reference_no || null,
            m.note || null,
          ]
        );
        insertedMilestones.push({ id: mId, tranche_no: i + 1, name: String(m.name || `Đợt ${i + 1}`), amount_vnd: mAmt, status: mStatus });
      }

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
      return {
        ...r.rows[0],
        amount_vnd: Number(r.rows[0].amount_vnd || 0),
        contract_value_vnd: Number(r.rows[0].contract_value_vnd || 0),
        expected_commission_vnd: Number(r.rows[0].expected_commission_vnd || 0),
        milestones: insertedMilestones,
        commission_shares: parseJsonSafe(r.rows[0].commission_shares_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_DEPOSIT_FAILED', err?.message || 'Không thể ghi nhận phiếu Đặt cọc.');
  }
});

router.patch('/deposits/:id', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const depId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        depId,
      ]);
      if (!r.rows[0]) return null;
      const cur = r.rows[0];
      const history = parseJsonSafe<any[]>(cur.history_json, []);
      if (body.comment_text) {
        history.push({
          id: crypto.randomUUID(),
          action: 'comment',
          actor_name: ctx.userName || 'Thành viên',
          note: String(body.comment_text).trim(),
          created_at: new Date().toISOString(),
        });
      }

      await client.query(
        `UPDATE tenant_deposits
         SET unit_code = $3,
             contract_value_vnd = $4,
             expected_commission_vnd = $5,
             unc_attachment_url = $6,
             commission_shares_json = $7::jsonb,
             watchers_json = $8::jsonb,
             history_json = $9::jsonb,
             notes = $10,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          depId,
          body.unit_code !== undefined ? body.unit_code : cur.unit_code,
          body.contract_value_vnd !== undefined ? Math.round(Number(body.contract_value_vnd)) : Number(cur.contract_value_vnd || 0),
          body.expected_commission_vnd !== undefined ? Math.round(Number(body.expected_commission_vnd)) : Number(cur.expected_commission_vnd || 0),
          body.unc_attachment_url !== undefined ? body.unc_attachment_url : cur.unc_attachment_url,
          JSON.stringify(Array.isArray(body.commission_shares) ? body.commission_shares : parseJsonSafe(cur.commission_shares_json, [])),
          JSON.stringify(Array.isArray(body.watchers) ? body.watchers : parseJsonSafe(cur.watchers_json, [])),
          JSON.stringify(history),
          body.notes !== undefined ? body.notes : cur.notes,
        ]
      );

      const fresh = await client.query('SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        depId,
      ]);
      return {
        ...fresh.rows[0],
        amount_vnd: Number(fresh.rows[0].amount_vnd || 0),
        commission_shares: parseJsonSafe(fresh.rows[0].commission_shares_json, []),
        watchers: parseJsonSafe(fresh.rows[0].watchers_json, []),
        history: parseJsonSafe(fresh.rows[0].history_json, []),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'DEPOSIT_NOT_FOUND', 'Không tìm thấy phiếu Đặt cọc.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_DEPOSIT_FAILED', err?.message || 'Không thể cập nhật phiếu Đặt cọc.');
  }
});

router.post('/deposits/:id/milestones', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const depId = req.params.id;
    const body = req.body || {};

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const depCheck = await client.query('SELECT id FROM tenant_deposits WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        depId,
      ]);
      if (!depCheck.rows[0]) return null;
      const cntRes = await client.query<{ cnt: string | number }>(
        'SELECT COUNT(*)::int AS cnt FROM tenant_deposit_milestones WHERE tenant_id = $1 AND deposit_id = $2',
        [ctx.tenantId, depId]
      );
      const nextNo = Number(cntRes.rows[0]?.cnt || 0) + 1;
      const mId = crypto.randomUUID();
      const amountVnd = Math.max(0, Math.round(Number(body.amount_vnd ?? body.amount ?? 0)));

      await client.query(
        `INSERT INTO tenant_deposit_milestones (
           id, tenant_id, deposit_id, tranche_no, name, amount_vnd, expected_pay_date, status, unc_url, note
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)`,
        [
          mId,
          ctx.tenantId,
          depId,
          nextNo,
          String(body.name || `Đợt ${nextNo}`).trim(),
          amountVnd,
          body.expected_pay_date || null,
          body.unc_url || null,
          body.note || null,
        ]
      );

      const r = await client.query('SELECT * FROM tenant_deposit_milestones WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        mId,
      ]);
      return { ...r.rows[0], amount_vnd: Number(r.rows[0].amount_vnd || 0) };
    });

    if (!created) {
      sendApiError(res, 404, 'DEPOSIT_NOT_FOUND', 'Không tìm thấy phiếu Đặt cọc.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'ADD_MILESTONE_FAILED', err?.message || 'Không thể thêm đợt thanh toán.');
  }
});

router.patch('/deposits/:id/milestones/:milestoneId', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { id: depId, milestoneId } = req.params;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [depRes, msRes] = await Promise.all([
        client.query('SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND id = $2 LIMIT 1', [ctx.tenantId, depId]),
        client.query(
          'SELECT * FROM tenant_deposit_milestones WHERE tenant_id = $1 AND deposit_id = $2 AND id = $3 LIMIT 1',
          [ctx.tenantId, depId, milestoneId]
        ),
      ]);
      if (!depRes.rows[0] || !msRes.rows[0]) return null;
      const dep = depRes.rows[0];
      const ms = msRes.rows[0];

      const action = String(body.action || '').trim(); // 'submit_unc' | 'confirm' | 'reject'
      let nextStatus = body.status || ms.status;
      if (action === 'submit_unc') nextStatus = 'submitted';
      if (action === 'confirm') nextStatus = 'confirmed';
      if (action === 'reject') nextStatus = 'rejected';

      const wasConfirmedBefore = ms.status === 'confirmed';
      const nowIso = new Date().toISOString();

      await client.query(
        `UPDATE tenant_deposit_milestones
         SET status = $4,
             unc_url = $5,
             reference_no = $6,
             note = $7,
             paid_at = $8,
             confirmed_by = $9,
             confirmed_by_name = $10,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND deposit_id = $2 AND id = $3`,
        [
          ctx.tenantId,
          depId,
          milestoneId,
          nextStatus,
          body.unc_url !== undefined ? body.unc_url : ms.unc_url,
          body.reference_no !== undefined ? body.reference_no : ms.reference_no,
          body.note !== undefined ? body.note : ms.note,
          nextStatus === 'confirmed' ? ms.paid_at || nowIso : ms.paid_at,
          nextStatus === 'confirmed' ? ctx.userId : ms.confirmed_by,
          nextStatus === 'confirmed' ? ctx.userName || 'Kế toán' : ms.confirmed_by_name,
        ]
      );

      if (nextStatus === 'confirmed' && !wasConfirmedBefore && Number(ms.amount_vnd || 0) > 0) {
        const amt = Number(ms.amount_vnd || 0);
        await client.query(
          `INSERT INTO tenant_finance_transactions (
             id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
             counterparty_name, lead_id, company_id, sales_order_id, deposit_id, description, created_by
           ) VALUES ($1, $2, $3, 'income', 'deposit_milestone', $4, $5, 'completed', $6, $7, $8, $9, $10, $11, $12)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            `PT-${dep.deposit_code}-D${ms.tranche_no}-${Date.now().toString(36).slice(-3).toUpperCase()}`,
            amt,
            ms.payment_method || 'bank_transfer',
            dep.customer_name,
            dep.lead_id || null,
            dep.company_id || null,
            dep.sales_order_id || null,
            dep.id,
            `Kế toán xác nhận UNC ${ms.name} (${dep.deposit_code})`,
            ctx.userId,
          ]
        );

        const history = parseJsonSafe<any[]>(dep.history_json, []);
        history.push({
          id: crypto.randomUUID(),
          action: 'milestone_confirmed',
          actor_name: ctx.userName || 'Kế toán',
          note: `Xác nhận thu tiền ${ms.name}: ${amt.toLocaleString('vi-VN')}₫`,
          created_at: nowIso,
        });

        await client.query(
          `UPDATE tenant_deposits
           SET status = 'received',
               confirmed_by = $3,
               confirmed_at = clock_timestamp(),
               history_json = $4::jsonb,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, depId, ctx.userId, JSON.stringify(history)]
        );
      }

      const fresh = await client.query(
        'SELECT * FROM tenant_deposit_milestones WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, milestoneId]
      );
      return { ...fresh.rows[0], amount_vnd: Number(fresh.rows[0].amount_vnd || 0) };
    });

    if (!updated) {
      sendApiError(res, 404, 'MILESTONE_NOT_FOUND', 'Không tìm thấy đợt thanh toán.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_MILESTONE_FAILED', err?.message || 'Không thể cập nhật đợt thanh toán.');
  }
});

router.post('/deposits/:id/refund', requirePermission('finance', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const depId = req.params.id;
    const body = req.body || {};

    const refunded = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        depId,
      ]);
      if (!r.rows[0]) return null;
      const dep = r.rows[0];
      const refundAmount = Math.max(
        1,
        Math.round(Number(body.refund_amount_vnd ?? dep.amount_vnd ?? 0))
      );
      const reason = String(body.refund_reason || 'Hoàn tiền đặt cọc theo thỏa thuận').trim();

      const history = parseJsonSafe<any[]>(dep.history_json, []);
      history.push({
        id: crypto.randomUUID(),
        action: 'refunded',
        actor_name: ctx.userName || 'Kế toán',
        note: `Hoàn cọc ${refundAmount.toLocaleString('vi-VN')}₫ — Lý do: ${reason}`,
        created_at: new Date().toISOString(),
      });

      await client.query(
        `UPDATE tenant_deposits
         SET status = 'refunded',
             refunded_amount_vnd = $3,
             refund_reason = $4,
             history_json = $5::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, depId, refundAmount, reason, JSON.stringify(history)]
      );

      await client.query(
        `INSERT INTO tenant_finance_transactions (
           id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
           counterparty_name, lead_id, company_id, deposit_id, description, created_by
         ) VALUES ($1, $2, $3, 'expense', 'deposit_refund', $4, $5, 'completed', $6, $7, $8, $9, $10, $11)`,
        [
          crypto.randomUUID(),
          ctx.tenantId,
          `PC-HOAN-${dep.deposit_code}`,
          refundAmount,
          body.payment_method || 'bank_transfer',
          dep.customer_name,
          dep.lead_id || null,
          dep.company_id || null,
          dep.id,
          `Chi hoàn tiền đặt cọc ${dep.deposit_code}: ${reason}`,
          ctx.userId,
        ]
      );

      const fresh = await client.query('SELECT * FROM tenant_deposits WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        depId,
      ]);
      return {
        ...fresh.rows[0],
        amount_vnd: Number(fresh.rows[0].amount_vnd || 0),
        refunded_amount_vnd: Number(fresh.rows[0].refunded_amount_vnd || 0),
        history,
      };
    });

    if (!refunded) {
      sendApiError(res, 404, 'DEPOSIT_NOT_FOUND', 'Không tìm thấy phiếu Đặt cọc.');
      return;
    }
    res.json({ success: true, data: refunded });
  } catch (err: any) {
    sendApiError(res, 500, 'REFUND_DEPOSIT_FAILED', err?.message || 'Không thể hoàn tiền Đặt cọc.');
  }
});

// ============================================================================
// 7. Expenses (`tenant_expenses` — Multi-Item VAT Ledger, N-Step Approval, Refund)
// ============================================================================
router.get('/expenses', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = typeof req.query.approval_status === 'string' ? req.query.approval_status.trim() : '';
    const categoryFilter = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    const vatFilter = typeof req.query.has_vat === 'string' ? req.query.has_vat.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = 'SELECT * FROM tenant_expenses WHERE tenant_id = $1';
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;

      if (statusFilter && statusFilter !== 'all') {
        sql += ` AND approval_status = $${pIdx}`;
        params.push(statusFilter);
        pIdx++;
      }
      if (categoryFilter && categoryFilter !== 'all') {
        sql += ` AND category = $${pIdx}`;
        params.push(categoryFilter);
        pIdx++;
      }
      if (vatFilter === 'true' || vatFilter === 'false') {
        sql += ` AND has_vat_invoice = $${pIdx}`;
        params.push(vatFilter === 'true');
        pIdx++;
      }
      if (q) {
        sql += ` AND (LOWER(expense_code) LIKE LOWER($${pIdx}) OR LOWER(title) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(vendor_name, '')) LIKE LOWER($${pIdx}))`;
        params.push(`%${q}%`);
        pIdx++;
      }
      sql += ' ORDER BY expense_date DESC, created_at DESC LIMIT 150';

      const r = await client.query(sql, params);
      let totalExpenses = 0;
      let pendingApproval = 0;
      let approvedUnpaid = 0;
      let paidSum = 0;
      let vatSum = 0;
      let refundedSum = 0;

      const items = r.rows.map((row) => {
        const tot = Number(row.total_amount_vnd || 0);
        const vat = Number(row.vat_amount_vnd || 0);
        const refAmt = Number(row.refund_amount_vnd || 0);
        if (row.approval_status !== 'cancelled' && row.approval_status !== 'rejected') {
          totalExpenses += tot;
          vatSum += vat;
        }
        if (row.approval_status === 'pending_approval') pendingApproval += tot;
        if (row.approval_status === 'approved') approvedUnpaid += tot;
        if (row.approval_status === 'paid') paidSum += tot;
        if (row.refund_status === 'refunded') refundedSum += refAmt;

        return {
          ...row,
          has_vat_invoice: Boolean(row.has_vat_invoice),
          is_vat_inclusive: Boolean(row.is_vat_inclusive),
          subtotal_vnd: Number(row.subtotal_vnd || 0),
          vat_amount_vnd: vat,
          total_amount_vnd: tot,
          refund_amount_vnd: refAmt,
          line_items: parseJsonSafe(row.line_items_json, []),
          attachments: parseJsonSafe(row.attachments_json, []),
          watchers: parseJsonSafe(row.watchers_json, []),
          history: parseJsonSafe(row.history_json, []),
        };
      });

      return {
        items,
        summary: {
          total_expenses_vnd: totalExpenses,
          pending_approval_vnd: pendingApproval,
          approved_unpaid_vnd: approvedUnpaid,
          paid_vnd: paidSum,
          vat_total_vnd: vatSum,
          refunded_vnd: refundedSum,
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_EXPENSES_FAILED', err?.message || 'Không thể tải danh sách Phiếu chi phí.');
  }
});

router.get('/expenses/:id', requirePermission('finance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const expId = req.params.id;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_expenses WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        expId,
      ]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      const payoutQr =
        row.bank_account_no && Number(row.total_amount_vnd || 0) > 0
          ? buildVietQrImageUrl({
              bankBin: String(row.bank_bin || '970436'),
              accountNo: String(row.bank_account_no),
              accountHolder: String(row.bank_account_holder || row.vendor_name || 'THU HUONG'),
              amountVnd: Number(row.total_amount_vnd || 0),
              transferNote: `${row.expense_code} ${row.title}`.slice(0, 55),
            })
          : null;

      return {
        ...row,
        has_vat_invoice: Boolean(row.has_vat_invoice),
        is_vat_inclusive: Boolean(row.is_vat_inclusive),
        subtotal_vnd: Number(row.subtotal_vnd || 0),
        vat_amount_vnd: Number(row.vat_amount_vnd || 0),
        total_amount_vnd: Number(row.total_amount_vnd || 0),
        refund_amount_vnd: Number(row.refund_amount_vnd || 0),
        line_items: parseJsonSafe(row.line_items_json, []),
        attachments: parseJsonSafe(row.attachments_json, []),
        watchers: parseJsonSafe(row.watchers_json, []),
        history: parseJsonSafe(row.history_json, []),
        payout_vietqr_url: payoutQr,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'EXPENSE_NOT_FOUND', 'Không tìm thấy Phiếu chi phí.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_EXPENSE_FAILED', err?.message || 'Không thể tải chi tiết Phiếu chi phí.');
  }
});

router.post('/expenses', requirePermission('finance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) {
      sendApiError(res, 422, 'EXPENSE_TITLE_REQUIRED', 'Vui lòng nhập nội dung đề nghị chi phí.');
      return;
    }

    const rawLines = Array.isArray(body.line_items) ? body.line_items : [];
    let subtotalVnd = 0;
    let vatAmountVnd = 0;
    const normalizedLines = rawLines.map((li: any) => {
      const qty = Math.max(1, Number(li.qty ?? li.quantity ?? 1));
      const unitPrice = Math.max(0, Math.round(Number(li.unit_price_vnd ?? li.price ?? 0)));
      const vatPct = body.has_vat_invoice ? Math.max(0, Number(li.vat_pct ?? li.vat ?? 0)) : 0;
      const sub = Math.round(qty * unitPrice);
      const vat = Math.round((sub * vatPct) / 100);
      subtotalVnd += sub;
      vatAmountVnd += vat;
      return {
        id: li.id || crypto.randomUUID(),
        content: String(li.content || li.name || 'Hạng mục chi phí').trim(),
        qty,
        unit_price_vnd: unitPrice,
        vat_pct: vatPct,
        line_total_vnd: sub + vat,
      };
    });

    if (normalizedLines.length === 0) {
      subtotalVnd = Math.max(0, Math.round(Number(body.subtotal_vnd ?? body.amount_vnd ?? 0)));
      vatAmountVnd = body.has_vat_invoice ? Math.max(0, Math.round(Number(body.vat_amount_vnd ?? 0))) : 0;
    }
    const totalAmountVnd = subtotalVnd + vatAmountVnd;
    if (totalAmountVnd <= 0) {
      sendApiError(res, 422, 'EXPENSE_AMOUNT_INVALID', 'Tổng số tiền đề nghị chi phải lớn hơn 0.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      const expCode =
        String(body.expense_code || '').trim().toUpperCase() ||
        `EXP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const initStatus = body.approval_status || 'pending_approval';
      const history = [
        {
          id: crypto.randomUUID(),
          action: 'submitted',
          actor_name: ctx.userName || 'Người đề xuất',
          note: `Khởi tạo đề nghị thanh toán ${expCode} (${totalAmountVnd.toLocaleString('vi-VN')}₫)`,
          created_at: new Date().toISOString(),
        },
      ];

      await client.query(
        `INSERT INTO tenant_expenses (
           id, tenant_id, expense_code, title, category, branch_id, department_id, project_id, supplier_id,
           vendor_name, vendor_tax_code, requester_user_id, requester_name, approver_user_id,
           approval_status, has_vat_invoice, is_vat_inclusive, vat_invoice_no, currency,
           subtotal_vnd, vat_amount_vnd, total_amount_vnd, payment_method,
           bank_name, bank_bin, bank_account_no, bank_account_holder,
           expense_date, due_date, line_items_json, attachments_json, watchers_json, history_json, notes
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19,
           $20, $21, $22, $23,
           $24, $25, $26, $27,
           COALESCE($28::date, CURRENT_DATE), $29, $30::jsonb, $31::jsonb, $32::jsonb, $33::jsonb, $34
         )`,
        [
          id,
          ctx.tenantId,
          expCode,
          title,
          body.category || 'operating_expense',
          body.branch_id || null,
          body.department_id || null,
          body.project_id || null,
          body.supplier_id || null,
          body.vendor_name ? String(body.vendor_name).trim() : null,
          body.vendor_tax_code ? String(body.vendor_tax_code).trim() : null,
          ctx.userId,
          ctx.userName || 'Nhân sự',
          body.approver_user_id || null,
          initStatus,
          Boolean(body.has_vat_invoice),
          body.is_vat_inclusive !== false,
          body.vat_invoice_no ? String(body.vat_invoice_no).trim() : null,
          body.currency || 'VND',
          subtotalVnd,
          vatAmountVnd,
          totalAmountVnd,
          body.payment_method || 'bank_transfer',
          body.bank_name ? String(body.bank_name) : null,
          body.bank_bin ? String(body.bank_bin) : null,
          body.bank_account_no ? String(body.bank_account_no) : null,
          body.bank_account_holder ? String(body.bank_account_holder) : null,
          body.expense_date || null,
          body.due_date || null,
          JSON.stringify(normalizedLines),
          JSON.stringify(Array.isArray(body.attachments) ? body.attachments : []),
          JSON.stringify(Array.isArray(body.watchers) ? body.watchers : []),
          JSON.stringify(history),
          body.notes ? String(body.notes) : null,
        ]
      );

      const r = await client.query('SELECT * FROM tenant_expenses WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        has_vat_invoice: Boolean(r.rows[0].has_vat_invoice),
        subtotal_vnd: Number(r.rows[0].subtotal_vnd || 0),
        vat_amount_vnd: Number(r.rows[0].vat_amount_vnd || 0),
        total_amount_vnd: Number(r.rows[0].total_amount_vnd || 0),
        line_items: normalizedLines,
        history,
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_EXPENSE_FAILED', err?.message || 'Không thể tạo đề nghị chi phí.');
  }
});

router.post('/expenses/:id/decision', requirePermission('finance', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const expId = req.params.id;
    const body = req.body || {};
    const action = String(body.action || '').trim(); // 'approve' | 'reject' | 'pay' | 'refund' | 'comment'

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_expenses WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        expId,
      ]);
      if (!r.rows[0]) return null;
      const exp = r.rows[0];
      const history = parseJsonSafe<any[]>(exp.history_json, []);
      const nowIso = new Date().toISOString();

      let nextApprovalStatus = exp.approval_status;
      let nextRefundStatus = exp.refund_status;
      let nextRefundAmt = Number(exp.refund_amount_vnd || 0);
      let nextRefundUrl = exp.refund_attachment_url;
      let nextPaidAt = exp.paid_at;
      let nextRefundedAt = exp.refunded_at;

      if (action === 'approve') {
        nextApprovalStatus = 'approved';
        history.push({
          id: crypto.randomUUID(),
          action: 'approved',
          actor_name: ctx.userName || 'Người duyệt',
          note: String(body.note || 'Đã phê duyệt đề nghị chi phí'),
          created_at: nowIso,
        });
      } else if (action === 'reject') {
        nextApprovalStatus = 'rejected';
        history.push({
          id: crypto.randomUUID(),
          action: 'rejected',
          actor_name: ctx.userName || 'Người duyệt',
          note: String(body.note || 'Từ chối đề nghị chi phí'),
          created_at: nowIso,
        });
      } else if (action === 'pay') {
        const wasPaid = exp.approval_status === 'paid';
        nextApprovalStatus = 'paid';
        nextPaidAt = nowIso;
        history.push({
          id: crypto.randomUUID(),
          action: 'paid',
          actor_name: ctx.userName || 'Kế toán thanh toán',
          note: String(body.note || `Đã giải ngân / thanh toán ${Number(exp.total_amount_vnd || 0).toLocaleString('vi-VN')}₫`),
          created_at: nowIso,
        });

        if (!wasPaid && Number(exp.total_amount_vnd || 0) > 0) {
          await client.query(
            `INSERT INTO tenant_finance_transactions (
               id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
               counterparty_name, counterparty_tax_code, branch_id, description, created_by
             ) VALUES ($1, $2, $3, 'expense', $4, $5, $6, 'completed', $7, $8, $9, $10, $11)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              `PC-${exp.expense_code}`,
              exp.category || 'operating_expense',
              Number(exp.total_amount_vnd || 0),
              exp.payment_method || 'bank_transfer',
              exp.vendor_name || exp.requester_name,
              exp.vendor_tax_code || null,
              exp.branch_id || null,
              `Chi thanh toán phiếu ${exp.expense_code}: ${exp.title}`,
              ctx.userId,
            ]
          );
        }
      } else if (action === 'refund') {
        nextRefundStatus = 'refunded';
        nextApprovalStatus = 'refunded';
        nextRefundAmt = Math.max(1, Math.round(Number(body.refund_amount_vnd ?? exp.total_amount_vnd ?? 0)));
        nextRefundUrl = body.refund_attachment_url || exp.refund_attachment_url;
        nextRefundedAt = nowIso;
        history.push({
          id: crypto.randomUUID(),
          action: 'refunded',
          actor_name: ctx.userName || 'Kế toán',
          note: String(body.note || `Hoàn ứng / thu hồi chi phí ${nextRefundAmt.toLocaleString('vi-VN')}₫`),
          created_at: nowIso,
        });

        await client.query(
          `INSERT INTO tenant_finance_transactions (
             id, tenant_id, tx_code, tx_type, category, amount_vnd, payment_method, status,
             counterparty_name, branch_id, description, created_by
           ) VALUES ($1, $2, $3, 'income', 'expense_refund', $4, 'bank_transfer', 'completed', $5, $6, $7, $8)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            `PT-HOAN-${exp.expense_code}`,
            nextRefundAmt,
            exp.vendor_name || exp.requester_name,
            exp.branch_id || null,
            `Thu hoàn ứng phiếu chi ${exp.expense_code}`,
            ctx.userId,
          ]
        );
      } else if (action === 'comment' && body.note) {
        history.push({
          id: crypto.randomUUID(),
          action: 'comment',
          actor_name: ctx.userName || 'Thành viên',
          note: String(body.note).trim(),
          created_at: nowIso,
        });
      }

      await client.query(
        `UPDATE tenant_expenses
         SET approval_status = $3,
             refund_status = $4,
             refund_amount_vnd = $5,
             refund_attachment_url = $6,
             paid_at = $7,
             refunded_at = $8,
             history_json = $9::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          expId,
          nextApprovalStatus,
          nextRefundStatus,
          nextRefundAmt,
          nextRefundUrl,
          nextPaidAt,
          nextRefundedAt,
          JSON.stringify(history),
        ]
      );

      const fresh = await client.query('SELECT * FROM tenant_expenses WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        expId,
      ]);
      return {
        ...fresh.rows[0],
        has_vat_invoice: Boolean(fresh.rows[0].has_vat_invoice),
        total_amount_vnd: Number(fresh.rows[0].total_amount_vnd || 0),
        vat_amount_vnd: Number(fresh.rows[0].vat_amount_vnd || 0),
        refund_amount_vnd: Number(fresh.rows[0].refund_amount_vnd || 0),
        line_items: parseJsonSafe(fresh.rows[0].line_items_json, []),
        history,
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'EXPENSE_NOT_FOUND', 'Không tìm thấy Phiếu chi phí.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'EXPENSE_DECISION_FAILED', err?.message || 'Không thể xử lý trạng thái Phiếu chi phí.');
  }
});

// ============================================================================
// 8. Purchase Orders (`tenant_purchase_orders` + 3-Way Match FIFO Receiving)
// ============================================================================
router.get('/purchase-orders', requirePermission('finance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [r, lineRows] = await Promise.all([
        client.query(
          `SELECT * FROM tenant_purchase_orders
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 120`,
          [ctx.tenantId]
        ),
        client.query('SELECT * FROM tenant_purchase_order_items WHERE tenant_id = $1 ORDER BY sort_order ASC', [
          ctx.tenantId,
        ]),
      ]);

      const linesByPo = new Map<string, any[]>();
      for (const lr of lineRows.rows) {
        const list = linesByPo.get(lr.purchase_order_id) || [];
        list.push({
          ...lr,
          ordered_qty: Number(lr.ordered_qty || 1),
          received_qty: Number(lr.received_qty || 0),
          invoiced_qty: Number(lr.invoiced_qty || 0),
          unit_price_vnd: Number(lr.unit_price_vnd || 0),
          line_total_vnd: Number(lr.line_total_vnd || 0),
        });
        linesByPo.set(lr.purchase_order_id, list);
      }

      return r.rows.map((row) => {
        const dbItems = linesByPo.get(row.id);
        return {
          ...row,
          subtotal_vnd: Number(row.subtotal_vnd || row.total_vnd || 0),
          tax_vnd: Number(row.tax_vnd || 0),
          shipping_fee_vnd: Number(row.shipping_fee_vnd || 0),
          total_vnd: Number(row.total_vnd || 0),
          paid_vnd: Number(row.paid_vnd || 0),
          three_way_match: parseJsonSafe(row.three_way_match_json, {}),
          items: dbItems && dbItems.length > 0 ? dbItems : parseJsonSafe(row.items_json, []),
        };
      });
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

    const computed = computeLineTotals(body.items, body.discount_vnd, body.shipping_fee_vnd, body.tax_pct);
    const totalVnd =
      computed.items.length > 0 ? computed.total : Math.max(0, Math.round(Number(body.total_vnd || 0)));
    const poCode =
      String(body.po_code || '').trim().toUpperCase() || `PO-${Date.now().toString(36).toUpperCase().slice(-6)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_purchase_orders (
           id, tenant_id, po_code, supplier_id, warehouse_id, supplier_name,
           status, items_json, subtotal_vnd, discount_vnd, tax_vnd, shipping_fee_vnd,
           total_vnd, expected_date, notes, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id,
          ctx.tenantId,
          poCode,
          body.supplier_id || null,
          body.warehouse_id || null,
          supplierName,
          body.status || 'ordered',
          JSON.stringify(computed.items),
          computed.subtotal || totalVnd,
          computed.discount,
          computed.taxTotal,
          computed.shippingFee,
          totalVnd,
          body.expected_date || null,
          body.notes ? String(body.notes) : null,
          ctx.userId,
        ]
      );

      for (let idx = 0; idx < computed.items.length; idx++) {
        const li = computed.items[idx];
        await client.query(
          `INSERT INTO tenant_purchase_order_items (
             id, tenant_id, purchase_order_id, product_id, sku, name, unit,
             ordered_qty, received_qty, invoiced_qty, unit_price_vnd, discount_pct, tax_pct, line_total_vnd, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, $9, $10, $11, $12, $13)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            id,
            li.product_id,
            li.sku,
            li.name,
            li.unit,
            li.qty,
            li.unit_price_vnd,
            li.discount_pct,
            li.tax_pct,
            li.line_total_vnd,
            idx,
          ]
        );
      }

      const r = await client.query('SELECT * FROM tenant_purchase_orders WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        total_vnd: Number(r.rows[0].total_vnd || 0),
        items: computed.items,
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
    const body = req.body || {};

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

      const items = parseJsonSafe<
        Array<{ product_id?: string | null; name?: string; qty?: number; ordered_qty?: number; unit_price_vnd?: number }>
      >(po.items_json, []);

      const overrideLines = Array.isArray(body.received_lines) ? body.received_lines : [];
      const overrideMap = new Map<string, any>();
      for (const ov of overrideLines) {
        if (ov.product_id) overrideMap.set(String(ov.product_id), ov);
      }

      const createdBatches: unknown[] = [];
      let hasDiscrepancy = false;
      const matchDetails: any[] = [];
      const targetWarehouseId = body.warehouse_id || po.warehouse_id || null;

      for (const item of items) {
        if (!item.product_id) continue;
        const orderedQty = Math.max(1, Math.round(Number(item.ordered_qty ?? item.qty ?? 1)));
        const ov = overrideMap.get(String(item.product_id));
        const receivedQty =
          ov?.received_qty !== undefined ? Math.max(0, Math.round(Number(ov.received_qty))) : orderedQty;
        const invoicedQty =
          ov?.invoiced_qty !== undefined ? Math.max(0, Math.round(Number(ov.invoiced_qty))) : receivedQty;
        const poUnitCost = Math.max(0, Math.round(Number(item.unit_price_vnd || 0)));
        const actualUnitCost =
          ov?.actual_unit_cost_vnd !== undefined
            ? Math.max(0, Math.round(Number(ov.actual_unit_cost_vnd)))
            : poUnitCost;

        const lineMatched =
          receivedQty === orderedQty && invoicedQty === orderedQty && actualUnitCost === poUnitCost;
        if (!lineMatched) hasDiscrepancy = true;

        matchDetails.push({
          product_id: item.product_id,
          ordered_qty: orderedQty,
          received_qty: receivedQty,
          invoiced_qty: invoicedQty,
          po_unit_cost_vnd: poUnitCost,
          actual_unit_cost_vnd: actualUnitCost,
          status: lineMatched ? 'matched' : 'discrepancy',
        });

        await client.query(
          `UPDATE tenant_purchase_order_items
           SET received_qty = $4,
               invoiced_qty = $5,
               match_note = $6
           WHERE tenant_id = $1 AND purchase_order_id = $2 AND product_id = $3`,
          [
            ctx.tenantId,
            po.id,
            item.product_id,
            receivedQty,
            invoicedQty,
            lineMatched ? '3-Way Match OK' : `Chênh lệch: Đặt ${orderedQty} / Thực nhận ${receivedQty} / HĐ ${invoicedQty}`,
          ]
        );

        if (receivedQty <= 0) continue;

        const batchId = crypto.randomUUID();
        const batchCode = `LOT-${po.po_code}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;

        await client.query(
          `INSERT INTO tenant_inventory_batches (
             id, tenant_id, product_id, warehouse_id, supplier_id, purchase_order_id,
             batch_code, initial_qty, remaining_qty, unit_cost_vnd, status, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11)`,
          [
            batchId,
            ctx.tenantId,
            item.product_id,
            targetWarehouseId,
            po.supplier_id || null,
            po.id,
            batchCode,
            receivedQty,
            receivedQty,
            actualUnitCost,
            `Nhập kho 3-Way Match từ PO ${po.po_code}`,
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
            targetWarehouseId,
            receivedQty,
            actualUnitCost,
            receivedQty * actualUnitCost,
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
          [ctx.tenantId, item.product_id, receivedQty]
        );

        createdBatches.push({
          batch_id: batchId,
          batch_code: batchCode,
          product_id: item.product_id,
          qty: receivedQty,
          unit_cost_vnd: actualUnitCost,
        });
      }

      const matchStatus = hasDiscrepancy ? 'discrepancy' : 'matched';
      const matchReport = {
        status: matchStatus,
        supplier_invoice_no: body.supplier_invoice_no || null,
        verified_by: ctx.userName || ctx.userId,
        verified_at: new Date().toISOString(),
        lines: matchDetails,
      };

      await client.query(
        `UPDATE tenant_purchase_orders
         SET status = 'received',
             payment_status = 'paid',
             paid_vnd = total_vnd,
             three_way_match_status = $3,
             three_way_match_json = $4::jsonb,
             received_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, poId, matchStatus, JSON.stringify(matchReport)]
      );

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
      return {
        po: {
          ...updatedPo.rows[0],
          total_vnd: Number(updatedPo.rows[0].total_vnd || 0),
          three_way_match: matchReport,
        },
        created_batches: createdBatches,
        three_way_match: matchReport,
        already_received: false,
      };
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

// ============================================================================
// 9. Cashflow Ledger (`tenant_finance_transactions`)
// ============================================================================
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
