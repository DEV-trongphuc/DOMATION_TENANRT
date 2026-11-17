import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';

describe('Phase 8: 3-Month Free Trial, No-Hardcode Billing Catalog (900k/mo & -15%/yr), Wallet Topup, Step Renewal & CRM/ERP Upgrade', () => {
  let harness: TestHarness;
  let platformToken = '';
  let tenantA: { id: string; slug: string; adminToken: string; saleToken: string } = {
    id: '',
    slug: 'flora-clinic',
    adminToken: '',
    saleToken: '',
  };
  let tenantB: { id: string; slug: string; adminToken: string } = {
    id: '',
    slug: 'ideas-edu',
    adminToken: '',
  };

  before(async () => {
    harness = await startTestServer();

    const loginSa = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(loginSa.status, 200);
    platformToken = loginSa.json.data.access_token;
  });

  after(async () => {
    await harness.close();
  });

  it('1. Public Billing Catalog exposes default 1-month (30-day) trial, 1.500.000đ/month & -15% annual (15.300.000đ/yr)', async () => {
    const res = await apiRequest(harness.baseUrl, '/api/v1/billing/catalog');
    assert.equal(res.status, 200);
    const catalog = res.json.data;

    assert.equal(catalog.trial_duration_months, 1);
    assert.equal(catalog.trial_duration_days, 30);
    assert.equal(catalog.base_monthly_price_vnd, 1_500_000);
    assert.equal(catalog.annual_discount_pct, 15);
    assert.equal(catalog.crm_upgrade_url, 'https://domation.net/crm');
    assert.equal(catalog.erp_upgrade_url, 'https://domation.net/erp');

    const std = catalog.plans.find((p: any) => p.code === 'autodata_standard');
    assert.ok(std, 'autodata_standard plan must exist');
    assert.equal(std.monthly_price_vnd, 1_500_000);
    assert.equal(std.annual_discount_pct, 15);
    assert.equal(std.annual_total_vnd, 15_300_000);
    assert.equal(std.annual_monthly_equivalent_vnd, 1_275_000);
    assert.equal(std.annual_saved_vnd, 2_700_000);

    const topup12m = catalog.topup_packages.find((p: any) => p.id === 'topup_12m');
    assert.ok(topup12m, 'topup_12m package must exist');
    assert.equal(topup12m.amount_vnd, 15_300_000);
  });

  it('2. New Tenant registration (including universal industry="general") provisions 30-day Free Trial & clean wallet', async () => {
    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Nha Khoa Flora Universal',
        tenant_slug: tenantA.slug,
        admin_name: 'Dr Flora Admin',
        work_email: 'admin@flora.vn',
        phone: '0909111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA.id = regA.json.data.tenant.id;
    tenantA.adminToken = regA.json.data.access_token;

    const sub = regA.json.data.tenant.subscription;
    assert.ok(sub, 'Registration response must include subscription snapshot');
    assert.equal(sub.plan_code, 'trial_1m');
    assert.equal(sub.billing_cycle, 'trial');
    assert.equal(sub.is_in_trial, true);
    assert.equal(sub.is_expired, false);
    assert.equal(sub.wallet_balance_vnd, 0);
    assert.ok(sub.days_remaining >= 29 && sub.days_remaining <= 31, `Expected ~30 trial days, got ${sub.days_remaining}`);

    // Create a non-admin sale user for RBAC boundary checks
    const saleRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: {
        full_name: 'Sale Flora 01',
        email: 'sale1@flora.vn',
        phone: '0909111333',
        password: 'SalePassword123!',
        role: 'sale',
      },
    });
    assert.equal(saleRes.status, 201);

    const saleLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        tenant_slug: tenantA.slug,
        email: 'sale1@flora.vn',
        password: 'SalePassword123!',
      },
    });
    assert.equal(saleLogin.status, 200);
    tenantA.saleToken = saleLogin.json.data.access_token;

    // Register Tenant B for RLS cross-tenant isolation proof
    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'IDEAS Institute',
        tenant_slug: tenantB.slug,
        admin_name: 'IDEAS Director',
        work_email: 'admin@ideas.edu.vn',
        phone: '0909444555',
        password: 'SecurePassword123!',
        industry: 'education',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB.id = regB.json.data.tenant.id;
    tenantB.adminToken = regB.json.data.access_token;
  });

  it('3. Enforces RBAC & input validation boundaries on Topup & Subscribe endpoints', async () => {
    // Non-admin sale user cannot create topup
    const forbiddenTopup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantA.saleToken,
      tenantSlug: tenantA.slug,
      body: { package_id: 'topup_1m' },
    });
    assert.equal(forbiddenTopup.status, 403);

    // Amount below min_topup_vnd (100,000) rejected
    const tinyTopup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: { amount_vnd: 50_000 },
    });
    assert.equal(tinyTopup.status, 422);
    assert.equal(tinyTopup.json.error?.code, 'INVALID_TOPUP_AMOUNT');

    // Non-existent topup package rejected
    const badPkg = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: { package_id: 'ghost_pkg' },
    });
    assert.equal(badPkg.status, 422);
    assert.equal(badPkg.json.error?.code, 'INVALID_TOPUP_PACKAGE');

    // Non-existent plan code rejected
    const badPlan = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: { plan_code: 'non_existent_plan', billing_cycle: 'monthly' },
    });
    assert.equal(badPlan.status, 422);
    assert.equal(badPlan.json.error?.code, 'INVALID_PLAN_CODE');

    // Insufficient wallet balance returns 402
    const noFunds = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(noFunds.status, 402);
    assert.equal(noFunds.json.error?.code, 'INSUFFICIENT_WALLET_BALANCE');
  });

  it('4. Wallet Topup -> Super Admin Approval -> Atomic Wallet Credit & Annual (-15%) Subscription Stacking', async () => {
    // Create 1-year Topup package order (9,180,000 VND)
    const createTopup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: { package_id: 'topup_12m', note: 'Nạp gói năm tiết kiệm 15%' },
    });
    assert.equal(createTopup.status, 201);
    const txId = createTopup.json.data.transaction.id;
    assert.equal(createTopup.json.data.transaction.amount_vnd, 15_300_000);
    assert.equal(createTopup.json.data.transaction.status, 'pending');

    // Super Admin sees pending request
    const listPending = await apiRequest(harness.baseUrl, '/api/v1/admin/billing/requests?status=pending', {
      token: platformToken,
    });
    assert.equal(listPending.status, 200);
    assert.ok(listPending.json.data.some((r: any) => r.id === txId));

    // Super Admin approves Topup
    const approveRes = await apiRequest(harness.baseUrl, `/api/v1/admin/billing/requests/${txId}/resolve`, {
      method: 'POST',
      token: platformToken,
      body: { decision: 'approve', resolution_note: 'Đã nhận CK Techcombank 9.18M' },
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.json.data.status, 'approved');

    // Re-approving same transaction must fail with 409 (no double credit!)
    const doubleApprove = await apiRequest(harness.baseUrl, `/api/v1/admin/billing/requests/${txId}/resolve`, {
      method: 'POST',
      token: platformToken,
      body: { decision: 'approve' },
    });
    assert.equal(doubleApprove.status, 409);
    assert.equal(doubleApprove.json.error?.code, 'BILLING_TX_ALREADY_PROCESSED');

    // Verify Tenant A wallet has exact 9,180,000 VND
    const overviewAfterTopup = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(overviewAfterTopup.status, 200);
    assert.equal(overviewAfterTopup.json.data.subscription.wallet_balance_vnd, 15_300_000);

    // Tenant A subscribes to autodata_standard (annual = 9,180,000 VND) using wallet!
    const subAnnual = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: {
        plan_code: 'autodata_standard',
        billing_cycle: 'annual',
        payment_method: 'wallet',
      },
    });
    assert.equal(subAnnual.status, 200);
    const updatedSub = subAnnual.json.data.subscription;
    assert.equal(updatedSub.wallet_balance_vnd, 0);
    assert.equal(updatedSub.plan_code, 'autodata_standard');
    assert.equal(updatedSub.billing_cycle, 'annual');
    assert.equal(updatedSub.is_in_trial, false);
    // Remaining 30 trial days + 365 annual days = ~395 days preserved!
    assert.ok(
      updatedSub.days_remaining >= 393 && updatedSub.days_remaining <= 396,
      `Expected ~395 stacked days (30 trial + 365 annual), got ${updatedSub.days_remaining}`
    );
  });

  it('5. Topup Bonus (+5% on 6-month package) & Direct Super Admin Grant work accurately', async () => {
    const topup6m = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantB.adminToken,
      tenantSlug: tenantB.slug,
      body: { package_id: 'topup_6m' },
    });
    assert.equal(topup6m.status, 201);
    const tx6mId = topup6m.json.data.transaction.id;
    assert.equal(topup6m.json.data.transaction.amount_vnd, 9_000_000);

    const app6m = await apiRequest(harness.baseUrl, `/api/v1/admin/billing/requests/${tx6mId}/resolve`, {
      method: 'POST',
      token: platformToken,
      body: { decision: 'approve' },
    });
    assert.equal(app6m.status, 200);

    // 9,000,000 + 450,000 (+5% bonus) = 9,450,000 VND
    const ovB = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantB.adminToken,
      tenantSlug: tenantB.slug,
    });
    assert.equal(ovB.status, 200);
    assert.equal(ovB.json.data.subscription.wallet_balance_vnd, 9_450_000);

    // Direct Super Admin Grant (+1,500,000 topup & +1 month extension)
    const grantRes = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantB.id}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: {
        topup_amount_vnd: 1_500_000,
        extend_months: 1,
        plan_code: 'autodata_standard',
        note: 'Tặng thêm 1 tháng & 1.5M đối tác chiến lược IDEAS',
      },
    });
    assert.equal(grantRes.status, 200);
    assert.equal(grantRes.json.data.subscription.wallet_balance_vnd, 10_950_000);
    assert.ok(grantRes.json.data.subscription.days_remaining >= 59);

    // Super Admin tenant list returns enriched subscription & wallet_balance_vnd without mutex deadlock
    const adminTenants = await apiRequest(harness.baseUrl, '/api/v1/admin/tenants', {
      token: platformToken,
    });
    assert.equal(adminTenants.status, 200);
    const ideasRow = adminTenants.json.data.items.find((item: any) => item.slug === tenantB.slug);
    assert.ok(ideasRow, 'IDEAS tenant must appear in /api/v1/admin/tenants');
    assert.equal(ideasRow.wallet_balance_vnd, 10_950_000);
    assert.ok(ideasRow.subscription);
  });

  it('6. Seamless Ecosystem Upgrade Request to DOMATION CRM 360° / Enterprise ERP 5.0', async () => {
    const upgReq = await apiRequest(harness.baseUrl, '/api/v1/billing/upgrade-crm-erp', {
      method: 'POST',
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
      body: {
        target_suite: 'crm_erp_bundle',
        billing_cycle: 'annual',
        contact_phone: '0909111222',
        keep_existing_data: true,
        note: 'Nâng cấp đồng bộ CRM 360 + ERP 5.0 cho toàn chuỗi phòng khám',
      },
    });
    assert.equal(upgReq.status, 201);
    const upgTxId = upgReq.json.data.transaction.id;
    assert.equal(upgReq.json.data.transaction.tx_type, 'crm_erp_upgrade');

    const ovPending = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(ovPending.json.data.subscription.crm_erp_upgrade_status, 'requested_crm_erp_bundle');

    // Super Admin approves CRM/ERP ecosystem upgrade
    const appUpg = await apiRequest(harness.baseUrl, `/api/v1/admin/billing/requests/${upgTxId}/resolve`, {
      method: 'POST',
      token: platformToken,
      body: { decision: 'approve', resolution_note: 'Đã kích hoạt phân hệ CRM 360 + ERP 5.0' },
    });
    assert.equal(appUpg.status, 200);

    const ovActive = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantA.adminToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(ovActive.json.data.subscription.plan_tier, 'enterprise');
    assert.equal(ovActive.json.data.subscription.crm_erp_upgrade_status, 'active_crm_erp_bundle');
  });

  it('7. No-Hardcode Proof: Super Admin dynamically modifies Trial & Pricing Catalog and resets cleanly', async () => {
    const patchCat = await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
      method: 'PATCH',
      token: platformToken,
      body: {
        catalog: {
          trial_duration_months: 2,
          trial_duration_days: 60,
          base_monthly_price_vnd: 1_000_000,
          annual_discount_pct: 20,
        },
      },
    });
    assert.equal(patchCat.status, 200);
    assert.equal(patchCat.json.data.catalog.trial_duration_days, 60);
    assert.equal(patchCat.json.data.catalog.base_monthly_price_vnd, 1_000_000);
    assert.equal(patchCat.json.data.catalog.annual_discount_pct, 20);
    // 1,000,000 * 12 * 0.80 = 9,600,000
    assert.equal(patchCat.json.data.catalog.plans[0].annual_total_vnd, 9_600_000);

    // New tenant registered while custom catalog is active inherits 60-day trial
    const regCustom = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'RichLand Real Estate',
        tenant_slug: 'richland-vn',
        admin_name: 'RichLand CEO',
        work_email: 'ceo@richland.vn',
        phone: '0909777888',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regCustom.status, 201);
    const customDays = regCustom.json.data.tenant.subscription.days_remaining;
    assert.ok(customDays >= 59 && customDays <= 61, `Expected ~60 custom trial days, got ${customDays}`);

    // Reset back to factory defaults (1 month = 30 days, 900k/month, -15% annual)
    const resetCat = await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
      method: 'PATCH',
      token: platformToken,
      body: { reset_to_factory: true },
    });
    assert.equal(resetCat.status, 200);
    assert.equal(resetCat.json.data.catalog.trial_duration_months, 1);
    assert.equal(resetCat.json.data.catalog.trial_duration_days, 30);
    assert.equal(resetCat.json.data.catalog.base_monthly_price_vnd, 1_500_000);
    assert.equal(resetCat.json.data.catalog.annual_discount_pct, 15);
    assert.equal(resetCat.json.data.catalog.plans[0].annual_total_vnd, 15_300_000);
  });

  it('8. PostgreSQL Kernel RLS Zero-Leakage Proof on tenant_billing_transactions', async () => {
    // Lemma 1: Unscoped query returns 0 rows
    await withUnscopedRlsCheck(async (client) => {
      const res = await client.query('SELECT * FROM tenant_billing_transactions');
      assert.equal(res.rows.length, 0, 'tenant_billing_transactions must return 0 rows without app.current_tenant_id');
    });

    // Lemma 2: Tenant B cannot read, update, or delete Tenant A billing transactions even by exact UUID
    const tenantATxId = await withTenantTransaction(tenantA.id, async (client) => {
      const r = await client.query<{ id: string }>('SELECT id FROM tenant_billing_transactions LIMIT 1');
      assert.ok(r.rows[0]?.id, 'Tenant A should have billing transactions');
      return r.rows[0].id;
    });

    await withTenantTransaction(tenantB.id, async (client) => {
      const crossRead = await client.query('SELECT * FROM tenant_billing_transactions WHERE id = $1', [tenantATxId]);
      assert.equal(crossRead.rows.length, 0, 'Cross-tenant SELECT on billing tx must return 0 rows');

      const crossUpdate = await client.query(
        "UPDATE tenant_billing_transactions SET note = 'TAMPERED' WHERE id = $1 RETURNING id",
        [tenantATxId]
      );
      assert.equal(crossUpdate.rows.length, 0, 'Cross-tenant UPDATE on billing tx must affect 0 rows');

      const crossDelete = await client.query('DELETE FROM tenant_billing_transactions WHERE id = $1 RETURNING id', [
        tenantATxId,
      ]);
      assert.equal(crossDelete.rows.length, 0, 'Cross-tenant DELETE on billing tx must affect 0 rows');
    });
  });

  it('9. Boundary Proofs: Expiring-Soon Warning (<=14d), Post-3-Month Trial Expiry State, and Rejected Request Safety', async () => {
    // Rejected topup request must NOT credit wallet balance
    const beforeRej = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantB.adminToken,
      tenantSlug: tenantB.slug,
    });
    const balanceBefore = beforeRej.json.data.subscription.wallet_balance_vnd;

    const rejTopup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantB.adminToken,
      tenantSlug: tenantB.slug,
      body: { package_id: 'topup_1m', note: 'Giao dịch sai nội dung CK' },
    });
    assert.equal(rejTopup.status, 201);

    const resolveRej = await apiRequest(
      harness.baseUrl,
      `/api/v1/admin/billing/requests/${rejTopup.json.data.transaction.id}/resolve`,
      {
        method: 'POST',
        token: platformToken,
        body: { decision: 'reject', resolution_note: 'Chưa nhận được giao dịch' },
      }
    );
    assert.equal(resolveRej.status, 200);
    assert.equal(resolveRej.json.data.status, 'rejected');

    const afterRej = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantB.adminToken,
      tenantSlug: tenantB.slug,
    });
    assert.equal(afterRej.json.data.subscription.wallet_balance_vnd, balanceBefore);

    // Simulate Tenant C entering 5-day expiring-soon window, then post-3-month expired state
    const regC = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Boundary Trial Co',
        tenant_slug: 'boundary-trial',
        admin_name: 'Boundary Admin',
        work_email: 'admin@boundary.vn',
        phone: '0909888999',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regC.status, 201);
    const cId = regC.json.data.tenant.id;
    const cToken = regC.json.data.access_token;

    // Move trial_ends_at to +5 days -> is_expiring_soon === true, is_expired === false
    await withTenantTransaction(cId, async (client) => {
      await client.query(
        "UPDATE tenants SET trial_ends_at = clock_timestamp() + INTERVAL '5 days', subscription_expires_at = NULL WHERE id = $1",
        [cId]
      );
    });
    const ovSoon = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: cToken,
      tenantSlug: 'boundary-trial',
    });
    assert.equal(ovSoon.json.data.subscription.is_in_trial, true);
    assert.equal(ovSoon.json.data.subscription.is_expiring_soon, true);
    assert.equal(ovSoon.json.data.subscription.is_expired, false);
    assert.equal(ovSoon.json.data.subscription.recommended_next_action, 'renew_step_plan');

    // Move trial_ends_at to -2 days -> post-3-month expired state!
    await withTenantTransaction(cId, async (client) => {
      await client.query(
        "UPDATE tenants SET trial_ends_at = clock_timestamp() - INTERVAL '2 days', subscription_expires_at = NULL WHERE id = $1",
        [cId]
      );
    });
    const ovExpired = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: cToken,
      tenantSlug: 'boundary-trial',
    });
    assert.equal(ovExpired.json.data.subscription.is_expired, true);
    assert.equal(ovExpired.json.data.subscription.days_remaining, 0);
    assert.equal(ovExpired.json.data.subscription.recommended_next_action, 'renew_step_plan');
  });

  it('10. Adversarial Concurrency Proof: 25 simultaneous Wallet Subscribe requests never double-spend or go negative', async () => {
    const regRace = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Wallet Race Corp',
        tenant_slug: 'wallet-race-corp',
        admin_name: 'Race Admin',
        work_email: 'admin@walletrace.vn',
        phone: '0909321654',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regRace.status, 201);
    const raceId = regRace.json.data.tenant.id;
    const raceToken = regRace.json.data.access_token;

    // Grant exact 1,500,000 VND (enough for ONLY 1 monthly subscription)
    const grantExact = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${raceId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: {
        topup_amount_vnd: 1_500_000,
        extend_months: 0,
        note: 'Exact 1-month balance for concurrency race test',
      },
    });
    assert.equal(grantExact.status, 200);
    assert.equal(grantExact.json.data.subscription.wallet_balance_vnd, 1_500_000);

    // Fire 25 concurrent wallet subscriptions simultaneously
    const raceResponses = await Promise.all(
      Array.from({ length: 25 }, () =>
        apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
          method: 'POST',
          token: raceToken,
          tenantSlug: 'wallet-race-corp',
          body: {
            plan_code: 'autodata_standard',
            billing_cycle: 'monthly',
            payment_method: 'wallet',
          },
        })
      )
    );

    const succeeded = raceResponses.filter((r) => r.status === 200);
    const insufficient = raceResponses.filter(
      (r) => r.status === 402 && r.json.error?.code === 'INSUFFICIENT_WALLET_BALANCE'
    );
    assert.equal(succeeded.length, 1, `Expected exactly 1 wallet charge to succeed, got ${succeeded.length}`);
    assert.equal(insufficient.length, 24, `Expected 24 requests to fail with 402, got ${insufficient.length}`);

    const afterRace = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: raceToken,
      tenantSlug: 'wallet-race-corp',
    });
    assert.equal(afterRace.status, 200);
    assert.equal(afterRace.json.data.subscription.wallet_balance_vnd, 0, 'Wallet balance must be exact 0 VND');
  });

  it('11. Enforces Post-3-Month Expiry Policies (step_renewal_or_upgrade vs strict_lock) & Active Plan Quotas', async () => {
    const regPol = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Policy Quota Co',
        tenant_slug: 'policy-quota-co',
        admin_name: 'Policy Admin',
        work_email: 'admin@policyquota.vn',
        phone: '0909765432',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regPol.status, 201);
    const polId = regPol.json.data.tenant.id;
    const polToken = regPol.json.data.access_token;

    // Expire Tenant's 3-month free trial
    await withTenantTransaction(polId, async (client) => {
      await client.query(
        "UPDATE tenants SET trial_ends_at = clock_timestamp() - INTERVAL '3 days', subscription_expires_at = NULL WHERE id = $1",
        [polId]
      );
    });

    // Expired tenant cannot expand staff or rounds until renewed (402 SUBSCRIPTION_EXPIRED)
    const blockedUser = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: polToken,
      tenantSlug: 'policy-quota-co',
      body: { full_name: 'Blocked Sale', email: 'blocked@policyquota.vn', role: 'sale' },
    });
    assert.equal(blockedUser.status, 402);
    assert.equal(blockedUser.json.error?.code, 'SUBSCRIPTION_EXPIRED');

    const blockedRound = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: polToken,
      tenantSlug: 'policy-quota-co',
      body: { name: 'Blocked Round' },
    });
    assert.equal(blockedRound.status, 402);
    assert.equal(blockedRound.json.error?.code, 'SUBSCRIPTION_EXPIRED');

    // Default post_trial_policy ('step_renewal_or_upgrade') preserves inbound leads without dropping paid ads
    const graceLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: polToken,
      tenantSlug: 'policy-quota-co',
      body: { name: 'Grace Lead', phone: '0918222333' },
    });
    assert.equal(graceLead.status, 201);

    // Switch post_trial_policy to 'strict_lock' -> lead ingestion immediately returns 402 SUBSCRIPTION_EXPIRED
    try {
      const strictPatch = await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
        method: 'PATCH',
        token: platformToken,
        body: { catalog: { post_trial_policy: 'strict_lock' } },
      });
      assert.equal(strictPatch.status, 200);
      assert.equal(strictPatch.json.data.catalog.post_trial_policy, 'strict_lock');

      const strictBlockedLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: polToken,
        tenantSlug: 'policy-quota-co',
        body: { name: 'Strict Blocked Lead', phone: '0918222444' },
      });
      assert.equal(strictBlockedLead.status, 402);
      assert.equal(strictBlockedLead.json.error?.code, 'SUBSCRIPTION_EXPIRED');

      // Renew tenant via Super Admin grant (+1 month) and test max_rounds quota enforcement
      await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${polId}/billing-grant`, {
        method: 'POST',
        token: platformToken,
        body: { extend_months: 1, plan_code: 'autodata_standard' },
      });

      // Lower starter plan max_rounds to 1 (tenant already has 1 default round) -> 2nd round must return 402 PLAN_QUOTA_EXCEEDED
      const currentCat = strictPatch.json.data.catalog;
      const customPlans = currentCat.plans.map((p: any, idx: number) =>
        idx === 0 ? { ...p, max_rounds: 1 } : p
      );
      await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
        method: 'PATCH',
        token: platformToken,
        body: { catalog: { plans: customPlans } },
      });

      const quotaRound = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
        method: 'POST',
        token: polToken,
        tenantSlug: 'policy-quota-co',
        body: { name: 'Over Quota Round' },
      });
      assert.equal(quotaRound.status, 402);
      assert.equal(quotaRound.json.error?.code, 'PLAN_QUOTA_EXCEEDED');
    } finally {
      await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
        method: 'PATCH',
        token: platformToken,
        body: { reset_to_factory: true },
      });
    }
  });
});
