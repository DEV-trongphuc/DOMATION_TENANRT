import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { ERP_OPS_TABLES } from '../server/modules/erp-ops/schema.ts';

describe('Stage 4B Full-Clone: Commercial Finance, Supply Chain, Projects/Gantt, Cloud/OCR & Education Add-on', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string; userId: string };
  let tenantB: { id: string; slug: string; token: string; userId: string };
  let alphaLeadId = '';
  let alphaProductId = '';
  let alphaSupplierId = '';
  let alphaProjectId = '';
  let alphaDepositId = '';
  let alphaExpenseId = '';
  let alphaInvoiceId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Sapphire Commercial Group',
        tenant_slug: 'sapphire-fc',
        admin_name: 'Sapphire CFO',
        work_email: 'cfo@sapphire-fc.vn',
        phone: '0909112233',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
      userId: regA.json.data.user.id,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Emerald Rival Corp',
        tenant_slug: 'emerald-fc',
        admin_name: 'Emerald CEO',
        work_email: 'ceo@emerald-fc.vn',
        phone: '0909445566',
        password: 'SecurePassword123!',
        industry: 'manufacturing',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
      userId: regB.json.data.user.id,
    };

    // Unlock Package 4 (`domation_promax`) with `education_addon: false` default on Tenant A
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 10000000 WHERE id = $1', [tenantA.id]);
    });
    await withTenantTransaction(tenantB.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 10000000 WHERE id = $1', [tenantB.id]);
    });
    const swA = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(swA.status, 200);

    const swB = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { package_code: 'domation_promax', education_addon: true },
    });
    assert.equal(swB.status, 200);

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Phạm Hoàng Minh',
        phone: '0912345678',
        email: 'minh.pham@partner.vn',
      },
    });
    assert.equal(leadRes.status, 201);
    alphaLeadId = leadRes.json.data.id;
  });

  after(async () => {
    await harness.close();
  });

  it('1. Multi-Row SKU Line-Item Quote -> SO -> 3-Way Match PO Receiving -> FIFO Fulfillment & Auto-Invoice', async () => {
    // Create Product with Barcode & 8% VAT + Supplier with Tier A
    const prodRes = await apiRequest(harness.baseUrl, '/api/v1/inventory/products', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        sku: 'ROUTER-AX6000',
        barcode: '8936000112233',
        name: 'Thiết bị định tuyến Wi-Fi 6 Doanh nghiệp',
        sale_price_vnd: 4_000_000,
        default_cost_vnd: 2_500_000,
        tax_rate_pct: 8,
      },
    });
    assert.equal(prodRes.status, 201);
    alphaProductId = prodRes.json.data.id;

    const supRes = await apiRequest(harness.baseUrl, '/api/v1/inventory/suppliers', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'CÔNG TY CỔ PHẦN PHÂN PHỐI VIỄN THÔNG ĐẠI VIỆT',
        tax_code: '0315556677',
        prestige_tier: 'A',
        cooperation_status: 'active',
        bank_name: 'Vietcombank',
        bank_account_no: '0071009988776',
      },
    });
    assert.equal(supRes.status, 201);
    alphaSupplierId = supRes.json.data.id;

    // Purchase Order for 20 units -> Receive 18 units via 3-Way Match (flags discrepancy & creates FIFO batch of 18!)
    const poRes = await apiRequest(harness.baseUrl, '/api/v1/finance/purchase-orders', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        supplier_id: alphaSupplierId,
        supplier_name: 'CÔNG TY CỔ PHẦN PHÂN PHỐI VIỄN THÔNG ĐẠI VIỆT',
        shipping_fee_vnd: 200_000,
        items: [
          {
            product_id: alphaProductId,
            sku: 'ROUTER-AX6000',
            name: 'Thiết bị định tuyến Wi-Fi 6 Doanh nghiệp',
            qty: 20,
            unit_price_vnd: 2_500_000,
            discount_pct: 0,
            tax_pct: 8,
          },
        ],
      },
    });
    assert.equal(poRes.status, 201);
    // 20 * 2.5M = 50M + 8% VAT (4M) + 200k ship = 54,200,000
    assert.equal(poRes.json.data.total_vnd, 54_200_000);

    const recvRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/finance/purchase-orders/${poRes.json.data.id}/receive`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          supplier_invoice_no: 'VAT-DV-0089',
          received_lines: [
            {
              product_id: alphaProductId,
              received_qty: 18,
              invoiced_qty: 18,
              actual_unit_cost_vnd: 2_500_000,
            },
          ],
        },
      }
    );
    assert.equal(recvRes.status, 200);
    assert.equal(recvRes.json.data.three_way_match.status, 'discrepancy');
    assert.equal(recvRes.json.data.created_batches[0].qty, 18);

    // Multi-row Quote with 10% line discount + 8% VAT + 150k shipping
    const quoteRes = await apiRequest(harness.baseUrl, '/api/v1/finance/quotes', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Báo giá Hạ tầng Mạng Chi nhánh',
        lead_id: alphaLeadId,
        shipping_fee_vnd: 150_000,
        items: [
          {
            product_id: alphaProductId,
            sku: 'ROUTER-AX6000',
            name: 'Thiết bị định tuyến Wi-Fi 6 Doanh nghiệp',
            qty: 5,
            unit_price_vnd: 4_000_000,
            discount_pct: 10,
            tax_pct: 8,
          },
        ],
      },
    });
    assert.equal(quoteRes.status, 201);
    // sub = 20,000,000, disc = 2,000,000, base = 18,000,000, tax 8% = 1,440,000, ship = 150,000 => 19,590,000
    assert.equal(quoteRes.json.data.total_vnd, 19_590_000);

    const quoteDetail = await apiRequest(harness.baseUrl, `/api/v1/finance/quotes/${quoteRes.json.data.id}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(quoteDetail.status, 200);
    assert.equal(quoteDetail.json.data.items.length, 1);
    assert.ok(quoteDetail.json.data.legal_entity.legal_entity_name);

    // Convert Quote -> SO -> Pay & Complete with Auto-Invoice
    const convSo = await apiRequest(
      harness.baseUrl,
      `/api/v1/finance/quotes/${quoteRes.json.data.id}/convert-to-order`,
      { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug, body: {} }
    );
    assert.equal(convSo.status, 201);
    const soId = convSo.json.data.sales_order.id;

    const paySo = await apiRequest(harness.baseUrl, `/api/v1/finance/sales-orders/${soId}/pay-complete`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { payment_method: 'bank_transfer', issue_invoice: true },
    });
    assert.equal(paySo.status, 200);
    assert.equal(paySo.json.data.order.cogs_vnd, 12_500_000, '5 units @ 2.5M FIFO cost = 12.5M COGS');

    const invList = await apiRequest(harness.baseUrl, '/api/v1/finance/invoices', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(invList.status, 200);
    assert.equal(invList.json.data.items.length, 1);
    alphaInvoiceId = invList.json.data.items[0].id;
    assert.equal(invList.json.data.items[0].status, 'paid');
  });

  it('2. Multi-Tranche Deposits, UNC Confirmation, Commission Participants & Accountant Refund', async () => {
    const depRes = await apiRequest(harness.baseUrl, '/api/v1/finance/deposits', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        lead_id: alphaLeadId,
        customer_name: 'Phạm Hoàng Minh',
        unit_code: 'SH-A09',
        status: 'pending',
        contract_value_vnd: 200_000_000,
        expected_commission_vnd: 10_000_000,
        milestones: [
          { name: 'Đợt 1 — Giữ chỗ', amount_vnd: 20_000_000, expected_pay_date: '2026-11-20', status: 'submitted', unc_url: 'https://cdn.example.com/unc1.jpg' },
          { name: 'Đợt 2 — Ký HĐMB', amount_vnd: 30_000_000, expected_pay_date: '2026-12-05', status: 'pending' },
        ],
        commission_shares: [
          { user_id: tenantA.userId, user_name: 'Sapphire CFO', share_pct: 100, amount_vnd: 10_000_000 },
        ],
      },
    });
    assert.equal(depRes.status, 201);
    alphaDepositId = depRes.json.data.id;
    assert.equal(depRes.json.data.amount_vnd, 50_000_000);
    assert.equal(depRes.json.data.milestones.length, 2);

    const firstMilestoneId = depRes.json.data.milestones[0].id;
    const confirmMs = await apiRequest(
      harness.baseUrl,
      `/api/v1/finance/deposits/${alphaDepositId}/milestones/${firstMilestoneId}`,
      {
        method: 'PATCH',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { action: 'confirm' },
      }
    );
    assert.equal(confirmMs.status, 200);
    assert.equal(confirmMs.json.data.status, 'confirmed');

    const refundDep = await apiRequest(
      harness.baseUrl,
      `/api/v1/finance/deposits/${alphaDepositId}/refund`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { refund_amount_vnd: 20_000_000, refund_reason: 'Thanh lý thỏa thuận giữ chỗ' },
      }
    );
    assert.equal(refundDep.status, 200);
    assert.equal(refundDep.json.data.status, 'refunded');
    assert.equal(refundDep.json.data.refunded_amount_vnd, 20_000_000);
  });

  it('3. Multi-Item VAT Expense Voucher, Vendor Payout VietQR, N-Step Decision & Cashflow Forecast', async () => {
    const expRes = await apiRequest(harness.baseUrl, '/api/v1/finance/expenses', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Chi phí thuê Cloud Server & Quảng cáo tháng 11',
        category: 'marketing',
        vendor_name: 'CÔNG TY HẠ TẦNG CLOUD VIỆT',
        vendor_tax_code: '0108889990',
        has_vat_invoice: true,
        vat_invoice_no: '1C26TAA-00991',
        bank_name: 'Techcombank',
        bank_bin: '970407',
        bank_account_no: '190366778899',
        bank_account_holder: 'CONG TY HA TANG CLOUD VIET',
        line_items: [
          { content: 'Cụm máy chủ Kubernetes', qty: 1, unit_price_vnd: 8_000_000, vat_pct: 10 },
          { content: 'Ngân sách Ads chiến dịch Q4', qty: 1, unit_price_vnd: 12_000_000, vat_pct: 8 },
        ],
      },
    });
    assert.equal(expRes.status, 201);
    alphaExpenseId = expRes.json.data.id;
    // 8M + 800k VAT + 12M + 960k VAT = 21,760,000
    assert.equal(expRes.json.data.total_amount_vnd, 21_760_000);
    assert.equal(expRes.json.data.vat_amount_vnd, 1_760_000);

    const expDetail = await apiRequest(harness.baseUrl, `/api/v1/finance/expenses/${alphaExpenseId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(expDetail.status, 200);
    assert.match(String(expDetail.json.data.payout_vietqr_url), /vietqr\.io/);

    const approveRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/finance/expenses/${alphaExpenseId}/decision`,
      { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug, body: { action: 'approve' } }
    );
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.json.data.approval_status, 'approved');

    const payRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/finance/expenses/${alphaExpenseId}/decision`,
      { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug, body: { action: 'pay' } }
    );
    assert.equal(payRes.status, 200);
    assert.equal(payRes.json.data.approval_status, 'paid');

    const dashRes = await apiRequest(harness.baseUrl, '/api/v1/finance/dashboard', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(dashRes.status, 200);
    assert.equal(dashRes.json.data.monthly_cashflow.length, 6);
    assert.ok(dashRes.json.data.expense_breakdown.length >= 1);
  });

  it('4. POS Shift Register, Barcode Lookup, Voucher Redemption, Split Payment & Sheet Sync', async () => {
    const openShift = await apiRequest(harness.baseUrl, '/api/v1/inventory/pos/sessions/open', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { opening_cash_vnd: 2_000_000 },
    });
    assert.equal(openShift.status, 201);
    const sessionId = openShift.json.data.id;

    const valVoucher = await apiRequest(harness.baseUrl, '/api/v1/inventory/pos/validate-voucher', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { voucher_code: 'VIP10', subtotal_vnd: 8_000_000 },
    });
    assert.equal(valVoucher.status, 200);
    assert.equal(valVoucher.json.data.valid, true);
    assert.equal(valVoucher.json.data.discount_vnd, 800_000);

    // POS Checkout 2 units by Barcode + VIP10 (-800k) + 8% VAT (640k) => 7,840,000; split 1,500,000 cash + 6,340,000 bank
    const posSale = await apiRequest(harness.baseUrl, '/api/v1/inventory/pos/checkout', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        session_id: sessionId,
        lead_id: alphaLeadId,
        voucher_code: 'VIP10',
        payment_method: 'split',
        cash_paid_vnd: 1_500_000,
        items: [{ barcode: '8936000112233', qty: 2 }],
      },
    });
    assert.equal(posSale.status, 201);
    assert.equal(posSale.json.data.total_vnd, 7_840_000);
    assert.equal(posSale.json.data.cash_paid_vnd, 1_500_000);
    assert.equal(posSale.json.data.bank_paid_vnd, 6_340_000);

    const closeShift = await apiRequest(
      harness.baseUrl,
      `/api/v1/inventory/pos/sessions/${sessionId}/close`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { actual_closing_cash_vnd: 3_500_000 },
      }
    );
    assert.equal(closeShift.status, 200);
    assert.equal(closeShift.json.data.expected_closing_cash_vnd, 3_500_000);
    assert.equal(closeShift.json.data.variance_vnd, 0);

    // Supplier Dossier & Google Sheets Sync
    const supDossier = await apiRequest(harness.baseUrl, `/api/v1/inventory/suppliers/${alphaSupplierId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(supDossier.status, 200);
    assert.equal(supDossier.json.data.purchase_orders.length, 1);

    const syncSheet = await apiRequest(harness.baseUrl, '/api/v1/inventory/sync-sheets', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { spreadsheet_id: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit', sheet_name: 'TonKhoQ4' },
    });
    assert.equal(syncSheet.status, 201);

    const runSync = await apiRequest(
      harness.baseUrl,
      `/api/v1/inventory/sync-sheets/${syncSheet.json.data.id}/run`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { rows: [{ sku: 'CAM-SYNC-99', product_name: 'Camera PTZ Đồng bộ Sheet', price: 3_200_000, import_price: 1_900_000, qty: 10 }] },
      }
    );
    assert.equal(runSync.status, 200);
    assert.equal(runSync.json.data.upserted_count, 1);
  });

  it('5. Projects Roster ACL, Whiteboard Snapshots Restore, Gantt Dependencies, Cloud Categories & CCCD/Contract OCR', async () => {
    const projRes = await apiRequest(harness.baseUrl, '/api/v1/projects', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Triển khai Chuỗi Siêu Thị Sapphire',
        whiteboard_elements: [{ id: 'w1', type: 'sticky', text: 'Bản vẽ v1', x: 50, y: 60, color: '#DBEAFE' }],
      },
    });
    assert.equal(projRes.status, 201);
    alphaProjectId = projRes.json.data.id;

    // Project Roster ACL
    const rosterRes = await apiRequest(harness.baseUrl, `/api/v1/projects/${alphaProjectId}/roster`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        user_id: tenantA.userId,
        user_name: 'Sapphire CFO',
        role_in_project: 'manager',
        allocation_pct: 80,
      },
    });
    assert.equal(rosterRes.status, 201);

    // Save Whiteboard Snapshot v1 -> overwrite board -> restore v1!
    const snapRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/projects/${alphaProjectId}/whiteboard/snapshots`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { snapshot_name: 'Bản chốt Kiến trúc v1' },
      }
    );
    assert.equal(snapRes.status, 201);
    const snapId = snapRes.json.data.id;

    await apiRequest(harness.baseUrl, `/api/v1/projects/${alphaProjectId}/whiteboard`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { elements: [] },
    });

    const restoreRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/projects/${alphaProjectId}/whiteboard/snapshots/${snapId}/restore`,
      { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug, body: {} }
    );
    assert.equal(restoreRes.status, 200);

    // Task Dependencies + Comments + Attachments
    const t1 = await apiRequest(harness.baseUrl, '/api/v1/projects/tasks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { project_id: alphaProjectId, title: 'Khảo sát mặt bằng', start_date: '2026-11-01T08:00:00Z', due_date: '2026-11-05T17:00:00Z' },
    });
    const t2 = await apiRequest(harness.baseUrl, '/api/v1/projects/tasks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { project_id: alphaProjectId, title: 'Lắp đặt quầy kệ', start_date: '2026-11-06T08:00:00Z', due_date: '2026-11-10T17:00:00Z' },
    });
    assert.equal(t1.status, 201);
    assert.equal(t2.status, 201);

    const depLink = await apiRequest(
      harness.baseUrl,
      `/api/v1/projects/tasks/${t2.json.data.id}/dependencies`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          dependencies: [{ predecessor_task_id: t1.json.data.id, dependency_type: 'FS', lag_days: 1 }],
        },
      }
    );
    assert.equal(depLink.status, 200);

    const commRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/projects/tasks/${t2.json.data.id}/comments`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { content: 'Đã chuẩn bị vật tư lắp đặt @Sapphire CFO' },
      }
    );
    assert.equal(commRes.status, 201);

    // Cloud File Category ACL + Batch Export + CCCD OCR + AI Contract Parser
    const catRes = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/drive/categories', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { category_key: 'legal_contracts', label: 'Hợp đồng Pháp chế', visibility: 'company' },
    });
    assert.equal(catRes.status, 201);

    const idOcr = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/ocr/extract-id-card', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        raw_text: `CĂN CƯỚC CÔNG DÂN\nSố: 079092008877\nHọ và tên: PHẠM HOÀNG MINH\nNgày sinh: 15/08/1992\nGiới tính: Nam\nQuốc tịch: Việt Nam\nNơi thường trú: 12 Lê Lợi, Quận 1, TP. Hồ Chí Minh`,
      },
    });
    assert.equal(idOcr.status, 201);
    assert.equal(idOcr.json.data.extracted_id_number, '079092008877');

    const contractParse = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/ocr/parse-contract', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        raw_text: `HỢP ĐỒNG CUNG CẤP DỊCH VỤ\nBÊN B: CÔNG TY CỔ PHẦN ĐẦU TƯ NAM HẢI\nMã số thuế: 0314445556\nTổng giá trị hợp đồng: 180.000.000 VNĐ\nĐợt 1: 90.000.000 VNĐ\nĐợt 2: 90.000.000 VNĐ\nNgày hiệu lực: 01/11/2026 - 01/11/2027`,
      },
    });
    assert.equal(contractParse.status, 201);
    assert.equal(contractParse.json.data.contract_value_vnd, 180_000_000);

    const bundleExp = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/drive/export-bundle', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { include_contacts: true },
    });
    assert.equal(bundleExp.status, 200);
  });

  it('6. Education Add-on Default-Off Gate -> Unlock -> ECTS 6.0 Batch Gradebook, Postpone Study OCR & Announcements', async () => {
    // Must still be strictly blocked on Tenant A while `education_addon` is false!
    const blocked = await apiRequest(harness.baseUrl, '/api/v1/education/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(blocked.status, 403);

    // Unlock Education Add-on on Tenant A
    const unlock = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax', education_addon: true },
    });
    assert.equal(unlock.status, 200);

    const crs = await apiRequest(harness.baseUrl, '/api/v1/education/courses', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        code: 'EXEC-FIN-01',
        name: 'Quản Trị Tài Chính Chiến Lược',
        grading_scale: 'ects_6',
        credits: 4,
        subjects_json: [
          { code: 'FIN101', name: 'Phân tích Báo cáo Tài chính', credits: 2 },
          { code: 'FIN102', name: 'Quản trị Dòng tiền & Vốn lưu động', credits: 2 },
        ],
      },
    });
    assert.equal(crs.status, 201);

    const cls = await apiRequest(harness.baseUrl, '/api/v1/education/classes', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        course_id: crs.json.data.id,
        code: 'CLS-EXEC-01',
        name: 'Lớp Giám đốc Tài chính K12',
        room_name: 'Hội trường Sapphire',
      },
    });
    assert.equal(cls.status, 201);

    const enr = await apiRequest(harness.baseUrl, '/api/v1/education/enrollments', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        class_id: cls.json.data.id,
        lead_id: alphaLeadId,
        tuition_paid_vnd: 25_000_000,
      },
    });
    assert.equal(enr.status, 201);
    const enrollmentId = enr.json.data.id;

    // Batch Gradebook Import with ECTS 6.0 converter
    const batchGrades = await apiRequest(
      harness.baseUrl,
      `/api/v1/education/classes/${cls.json.data.id}/gradebook-batch`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          subject_key: 'FIN101',
          grading_scale: 'ects_6',
          rows: [
            {
              enrollment_id: enrollmentId,
              attendance_score: 9.0,
              assignment_score: 8.5,
              midterm_score: 8.8,
              final_score: 9.2,
              feedback: 'Đạt chuẩn xuất sắc ECTS',
            },
          ],
        },
      }
    );
    assert.equal(batchGrades.status, 200);

    // Postpone / Reserve Study OCR Workflow
    const postponeReq = await apiRequest(
      harness.baseUrl,
      `/api/v1/education/enrollments/${enrollmentId}/postpone`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          postpone_reason: 'Công tác nước ngoài 3 tháng',
          postpone_until: '2027-02-28',
          raw_document_text: 'ĐƠN XIN BẢO LƯU KẾT QUẢ HỌC TẬP - Học viên: Phạm Hoàng Minh - Đến ngày: 28/02/2027',
        },
      }
    );
    assert.ok(postponeReq.status === 200 || postponeReq.status === 201);

    const approvePostpone = await apiRequest(
      harness.baseUrl,
      `/api/v1/education/enrollments/${enrollmentId}/postpone-decision`,
      {
        method: 'PATCH',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { decision: 'approved', note: 'Đồng ý bảo lưu học phần' },
      }
    );
    assert.equal(approvePostpone.status, 200);
    assert.equal(approvePostpone.json.data.status, 'deferred');

    // Batch Subject Announcement & Student Academic Workspace
    const annRes = await apiRequest(harness.baseUrl, '/api/v1/education/announcements', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        announcement_type: 'subject_announcement',
        class_id: cls.json.data.id,
        subject_key: 'FIN101',
        title: 'Thông báo lịch học học phần FIN101',
        content_html: '<p>Lịch khai giảng học phần Quản trị Tài chính Chiến lược.</p>',
        channels: ['email'],
      },
    });
    assert.equal(annRes.status, 201);

    const wsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/education/students/${enrollmentId}/workspace`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(wsRes.status, 200);
  });

  it('7. FORCE ROW LEVEL SECURITY Zero-Leakage across ALL 51 Stage 4B ERP Ops Tables', async () => {
    assert.ok(ERP_OPS_TABLES.length >= 51, 'ERP_OPS_TABLES must register all 51 Stage 4B multi-tenant tables');

    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of ERP_OPS_TABLES) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped query on ${tbl} must return 0 rows under FORCE RLS`);
      }
    });

    await withTenantTransaction(tenantB.id, async (client) => {
      const leakInv = await client.query('SELECT * FROM tenant_invoices WHERE id = $1', [alphaInvoiceId]);
      assert.equal(leakInv.rows.length, 0);
      const leakDep = await client.query('SELECT * FROM tenant_deposits WHERE id = $1', [alphaDepositId]);
      assert.equal(leakDep.rows.length, 0);
      const leakExp = await client.query('SELECT * FROM tenant_expenses WHERE id = $1', [alphaExpenseId]);
      assert.equal(leakExp.rows.length, 0);
      const leakSnap = await client.query(
        'SELECT * FROM tenant_task_whiteboard_snapshots WHERE project_id = $1',
        [alphaProjectId]
      );
      assert.equal(leakSnap.rows.length, 0);
    });
  });
});
