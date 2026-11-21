import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  startE2eServer,
  apiRequest,
  loginSuperAdmin,
  registerTenant,
  triggerMasterCronHttp,
  signPayosWebhook,
  type E2eServerHarness,
} from './helpers/e2e-harness.ts';
import { installMockFetch, type MockFetchController } from './helpers/mock-fetch.ts';
import { seedTenantWorkspace } from './helpers/fixtures.ts';
import { withTenantTransaction } from '../../server/core/database/transaction.ts';
import { tenantRedis } from '../../server/core/cache/tenant-redis.ts';

describe('F7: Synced Plans, Topup & Subscription Lifecycle Base', () => {
  let harness: E2eServerHarness;
  let mockFetch: MockFetchController;
  let platformToken = '';

  before(async () => {
    mockFetch = installMockFetch();
    harness = await startE2eServer();
    const sa = await loginSuperAdmin(harness.baseUrl);
    assert.equal(sa.status, 200);
    platformToken = sa.token;
  });

  after(async () => {
    await harness.close();
    mockFetch.restore();
  });

  beforeEach(() => {
    mockFetch.clearRequests();
    mockFetch.resetFailureModes();
  });

  // =========================================================================
  // TIER 1: HAPPY PATH & LOCKED CONTRACT COVERAGE (>= 7 tests)
  // =========================================================================

  test('Tier 1.1: GET /api/v1/billing/catalog exposes 1.5M/3M/6M plans, -15% annual, 4 topup packages, and marketing_standalone', async () => {
    const res = await apiRequest(harness.baseUrl, '/api/v1/billing/catalog');
    assert.equal(res.status, 200);
    const catalog = res.json.data;

    assert.equal(catalog.base_monthly_price_vnd, 1_500_000);
    assert.equal(catalog.annual_discount_pct, 15);

    const std = catalog.plans.find((p: any) => p.code === 'autodata_standard');
    const growth = catalog.plans.find((p: any) => p.code === 'autodata_growth');
    const ent = catalog.plans.find((p: any) => p.code === 'domation_crm_erp');
    assert.ok(std && growth && ent, 'All 3 core plans must exist');
    assert.equal(std.monthly_price_vnd, 1_500_000);
    assert.equal(std.annual_total_vnd, 15_300_000);
    assert.equal(growth.monthly_price_vnd, 3_000_000);
    assert.equal(growth.annual_total_vnd, 30_600_000);
    assert.equal(ent.monthly_price_vnd, 6_000_000);
    assert.equal(ent.annual_total_vnd, 61_200_000);

    assert.equal(catalog.topup_packages.length, 4, 'Catalog must expose 4 topup packages');
    assert.ok(catalog.topup_packages.some((p: any) => p.id === 'topup_1m' && p.amount_vnd === 1_500_000));
    assert.ok(catalog.topup_packages.some((p: any) => p.id === 'topup_3m' && p.amount_vnd === 4_500_000));
    assert.ok(catalog.topup_packages.some((p: any) => p.id === 'topup_6m' && p.amount_vnd === 9_000_000 && p.bonus_vnd === 450_000));
    assert.ok(catalog.topup_packages.some((p: any) => p.id === 'topup_12m' && p.amount_vnd === 15_300_000));

    assert.ok(catalog.packages?.marketing_standalone, 'marketing_standalone package must be present in catalog');
  });

  test('Tier 1.2: GET /api/v1/billing/overview returns lifecycle fields, wallet=0, bank info, and supported_gateways', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Overview Co',
      tenant_slug: 'f7-overview-co',
    });
    assert.equal(t.status, 201);

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.status, 200);
    const data = ov.json.data;
    assert.equal(data.subscription.wallet_balance_vnd, 0);
    assert.equal(data.subscription.is_in_trial, true);
    assert.ok(data.catalog?.payment_bank_info?.bank_name || data.payment_bank_info?.bank_name);
    // Contract 2 locked fields for subscription lifecycle & gateway base:
    assert.ok(
      ['active', 'trial', 'grace', 'suspended', 'cancelled'].includes(data.subscription.status),
      `Expected valid subscription.status, got ${data.subscription.status}`
    );
    assert.equal(typeof data.subscription.auto_renew, 'boolean', 'overview subscription must expose auto_renew boolean');
    assert.equal(typeof data.subscription.cancel_at_period_end, 'boolean', 'overview subscription must expose cancel_at_period_end boolean');
    assert.ok(Array.isArray(data.supported_gateways), 'overview must expose supported_gateways array');
  });

  test('Tier 1.3: POST /api/v1/billing/topup + admin approve + topup_6m (+450,000₫ bonus) + gateway_session base', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Topup Bonus Co',
      tenant_slug: 'f7-topup-bonus',
    });
    assert.equal(t.status, 201);

    const topupRes = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: {
        package_id: 'topup_6m',
        provider: 'manual_bank_transfer',
        idempotency_key: 'idem-topup-6m-t13',
      },
    });
    assert.equal(topupRes.status, 201);
    assert.equal(topupRes.json.data.transaction.amount_vnd, 9_000_000);
    assert.ok(topupRes.json.data.transaction.reference_code);
    assert.ok(topupRes.json.data.payment_bank_info?.account_number);
    assert.ok(topupRes.json.data.gateway_session, 'Topup must return payment gateway_session placeholder');

    const txId = topupRes.json.data.transaction.id;
    const approveRes = await apiRequest(harness.baseUrl, `/api/v1/admin/billing/requests/${txId}/resolve`, {
      method: 'POST',
      token: platformToken,
      body: { decision: 'approve', resolution_note: 'Verified 9M bank transfer' },
    });
    assert.equal(approveRes.status, 200);

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.status, 200);
    assert.equal(ov.json.data.subscription.wallet_balance_vnd, 9_450_000);
  });

  test('Tier 1.4: POST /api/v1/billing/subscribe monthly wallet activation deducts 1.5M and stacks 30d', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Sub Monthly Co',
      tenant_slug: 'f7-sub-monthly',
    });
    assert.equal(t.status, 201);

    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${t.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 2_000_000, extend_months: 0 },
    });

    const subRes = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: {
        plan_code: 'autodata_standard',
        billing_cycle: 'monthly',
        payment_method: 'wallet',
      },
    });
    assert.equal(subRes.status, 200);
    const sub = subRes.json.data.subscription;
    assert.equal(sub.plan_code, 'autodata_standard');
    assert.equal(sub.billing_cycle, 'monthly');
    assert.equal(sub.wallet_balance_vnd, 500_000);
    assert.ok(sub.days_remaining >= 59 && sub.days_remaining <= 61);
  });

  test('Tier 1.5: POST /api/v1/billing/subscribe annual (-15%) wallet activation deducts 30.6M for growth and stacks 365d', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Sub Annual Co',
      tenant_slug: 'f7-sub-annual',
    });
    assert.equal(t.status, 201);

    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${t.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 31_000_000, extend_months: 0 },
    });

    const subRes = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: {
        plan_code: 'autodata_growth',
        billing_cycle: 'annual',
        payment_method: 'wallet',
      },
    });
    assert.equal(subRes.status, 200);
    const sub = subRes.json.data.subscription;
    assert.equal(sub.plan_code, 'autodata_growth');
    assert.equal(sub.plan_tier, 'growth');
    assert.equal(sub.billing_cycle, 'annual');
    assert.equal(sub.wallet_balance_vnd, 400_000);
    assert.ok(sub.days_remaining >= 393 && sub.days_remaining <= 396);
  });

  test('Tier 1.6: POST /api/v1/billing/upgrade-request accepts crm/erp/crm_erp_bundle and normalizes domation_crm_erp -> crm_erp_bundle', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Upgrade Req Co',
      tenant_slug: 'f7-upgrade-req',
    });
    assert.equal(t.status, 201);

    const req1 = await apiRequest(harness.baseUrl, '/api/v1/billing/upgrade-request', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: {
        target_suite: 'domation_crm_erp',
        billing_cycle: 'annual',
        contact_phone: '0909555666',
        keep_existing_data: true,
      },
    });
    assert.equal(req1.status, 201);
    assert.equal(req1.json.data.target_suite, 'crm_erp_bundle');
    assert.equal(req1.json.data.transaction.metadata?.target_suite, 'crm_erp_bundle');

    const req2 = await apiRequest(harness.baseUrl, '/api/v1/billing/upgrade-request', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: {
        target_suite: 'erp',
        billing_cycle: 'monthly',
      },
    });
    assert.equal(req2.status, 201);
    assert.equal(req2.json.data.target_suite, 'erp');
  });

  test('Tier 1.7: POST /billing/cancel, POST /billing/renew, and PATCH /billing/auto-renew manage lifecycle cleanly', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Lifecycle Co',
      tenant_slug: 'f7-lifecycle-co',
    });
    assert.equal(t.status, 201);

    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${t.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 5_000_000, extend_months: 0 },
    });

    await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'wallet' },
    });

    const toggleOff = await apiRequest(harness.baseUrl, '/api/v1/billing/auto-renew', {
      method: 'PATCH',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { auto_renew: false },
    });
    assert.equal(toggleOff.status, 200);
    assert.equal(toggleOff.json.data.subscription.auto_renew, false);

    const cancelEnd = await apiRequest(harness.baseUrl, '/api/v1/billing/cancel', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { immediate: false, reason: 'Tạm dừng cuối kỳ' },
    });
    assert.equal(cancelEnd.status, 200);
    assert.equal(cancelEnd.json.data.subscription.cancel_at_period_end, true);
    assert.equal(cancelEnd.json.data.subscription.auto_renew, false);

    const renewRes = await apiRequest(harness.baseUrl, '/api/v1/billing/renew', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(renewRes.status, 200);
    assert.equal(renewRes.json.data.subscription.cancel_at_period_end, false);
    assert.equal(renewRes.json.data.subscription.status, 'active');

    const cancelImm = await apiRequest(harness.baseUrl, '/api/v1/billing/cancel', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { immediate: true, reason: 'Hủy ngay lập tức' },
    });
    assert.equal(cancelImm.status, 200);
    assert.equal(cancelImm.json.data.subscription.status, 'cancelled');
  });

  test('Tier 1.8: POST /api/v1/billing/webhooks/:provider verifies PayOS HMAC signature and credits pending topup', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Webhook Gateway Co',
      tenant_slug: 'f7-webhook-gw',
    });
    assert.equal(t.status, 201);

    const topup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { package_id: 'topup_1m', provider: 'payos' },
    });
    assert.equal(topup.status, 201);
    const refCode = topup.json.data.transaction.reference_code;

    const checksumKey = process.env.PAYOS_CHECKSUM_KEY!;
    assert.ok(checksumKey, 'PAYOS_CHECKSUM_KEY must be configured in E2E harness');
    const dataObj = {
      orderCode: Date.now(),
      amount: 1_500_000,
      description: refCode,
      reference: `payos_tx_${Date.now()}`,
      code: '00',
    };
    const signature = signPayosWebhook(dataObj, checksumKey);
    const payload = {
      code: '00',
      success: true,
      data: dataObj,
      signature,
    };

    const whRes = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/payos', {
      method: 'POST',
      body: payload,
    });
    assert.equal(whRes.status, 200, `Expected 200 from PayOS webhook, got ${whRes.status}: ${whRes.rawText}`);

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.json.data.subscription.wallet_balance_vnd, 1_500_000);
  });

  // =========================================================================
  // TIER 2: BOUNDARY, NEGATIVE, CONCURRENCY & CONTRACT GUARDS (>= 7 tests)
  // =========================================================================

  test('Tier 2.1: 0₫ /api/v1/billing/switch-package bypass to paid packages MUST be rejected or require payment', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Bypass Guard 1',
      tenant_slug: 'f7-bypass-1',
    });
    assert.equal(t.status, 201);

    for (const pkg of ['growth_combo', 'domation_promax', 'marketing_standalone']) {
      const sw = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
        method: 'POST',
        token: t.adminToken,
        tenantSlug: t.tenantSlug,
        body: { package_code: pkg },
      });
      assert.ok(
        sw.status === 402 || sw.status === 400 || sw.status === 409,
        `Switching to paid package '${pkg}' with 0₫ wallet MUST NOT unlock for free (got HTTP ${sw.status}: ${sw.rawText})`
      );
    }

    // Verify package_code remained unchanged (not upgraded to domation_promax for 0₫)
    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.json.data.package_code, 'autodata_crm');
  });

  test('Tier 2.2: 0₫ /api/v1/workspace/switch-package bypass to paid packages MUST be rejected or require payment', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Bypass Guard 2',
      tenant_slug: 'f7-bypass-2',
    });
    assert.equal(t.status, 201);

    const swPost = await apiRequest(harness.baseUrl, '/api/v1/workspace/switch-package', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { package_code: 'domation_promax' },
    });
    assert.ok(
      swPost.status === 402 || swPost.status === 400 || swPost.status === 409,
      `POST /workspace/switch-package must block 0₫ upgrade to domation_promax (got ${swPost.status})`
    );

    const swPatch = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'PATCH',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { package_code: 'growth_combo' },
    });
    assert.ok(
      swPatch.status === 402 || swPatch.status === 400 || swPatch.status === 409,
      `PATCH /workspace/package must block 0₫ upgrade to growth_combo (got ${swPatch.status})`
    );

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.status, 200);
    assert.equal(
      ov.json.data.package_code,
      'autodata_crm',
      'package_code must remain autodata_crm after rejected 0₫ switch attempts'
    );
  });

  test('Tier 2.3: Opaque-box HTTP billing overview & round limits map ALL package aliases without falling back to 25 users', async () => {
    const tA = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Alias Limits A',
      tenant_slug: 'f7-alias-limits-a',
    });
    assert.equal(tA.status, 201);

    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tA.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 50_000_000, extend_months: 0 },
    });

    // 1. Subscribe via 'growth_combo' alias -> 100 users, 85 sales, 30 rounds, 100k leads + 6th round allowed
    const subGrowthCombo = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tA.adminToken,
      tenantSlug: tA.tenantSlug,
      body: { package_code: 'growth_combo', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subGrowthCombo.status, 200, `growth_combo subscribe failed: ${subGrowthCombo.rawText}`);

    const ovGrowthCombo = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tA.adminToken,
      tenantSlug: tA.tenantSlug,
    });
    assert.equal(ovGrowthCombo.status, 200);
    assert.equal(ovGrowthCombo.json.data.limits.max_users, 100);
    assert.equal(ovGrowthCombo.json.data.limits.max_sales, 85);
    assert.equal(ovGrowthCombo.json.data.limits.max_rounds, 30);
    assert.equal(ovGrowthCombo.json.data.limits.monthly_lead_quota, 100_000);

    // Verify 6th distribution round succeeds on growth_combo (proving max_rounds > 5 is enforced operationally)
    for (let r = 2; r <= 6; r++) {
      const roundRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
        method: 'POST',
        token: tA.adminToken,
        tenantSlug: tA.tenantSlug,
        body: { name: `Alias Round ${r}` },
      });
      assert.equal(roundRes.status, 201, `Creating round ${r} on growth_combo failed: ${roundRes.rawText}`);
    }

    // 2. Tenant B checks domation_promax -> autodata_crm -> marketing_standalone (with 1 default round so downgrade is allowed)
    const tB = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Alias Limits B',
      tenant_slug: 'f7-alias-limits-b',
    });
    assert.equal(tB.status, 201);

    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tB.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 50_000_000, extend_months: 0 },
    });

    const subPromax = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tB.adminToken,
      tenantSlug: tB.tenantSlug,
      body: { package_code: 'domation_promax', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subPromax.status, 200, `domation_promax subscribe failed: ${subPromax.rawText}`);
    const ovPromax = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tB.adminToken,
      tenantSlug: tB.tenantSlug,
    });
    assert.ok(ovPromax.json.data.limits.max_users >= 9999);
    assert.ok(ovPromax.json.data.limits.max_rounds >= 999);
    assert.ok(ovPromax.json.data.limits.monthly_lead_quota >= 1_000_000);

    const subCrm = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tB.adminToken,
      tenantSlug: tB.tenantSlug,
      body: { package_code: 'autodata_crm', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subCrm.status, 200, `autodata_crm subscribe failed: ${subCrm.rawText}`);
    const ovCrm = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tB.adminToken,
      tenantSlug: tB.tenantSlug,
    });
    assert.equal(ovCrm.json.data.limits.max_users, 25);
    assert.equal(ovCrm.json.data.limits.max_sales, 20);
    assert.equal(ovCrm.json.data.limits.max_rounds, 5);
    assert.equal(ovCrm.json.data.limits.monthly_lead_quota, 15_000);

    const subMkt = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tB.adminToken,
      tenantSlug: tB.tenantSlug,
      body: { package_code: 'marketing_standalone', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subMkt.status, 200, `marketing_standalone subscribe failed: ${subMkt.rawText}`);
    const ovMkt = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tB.adminToken,
      tenantSlug: tB.tenantSlug,
    });
    assert.equal(ovMkt.json.data.limits.max_users, 25);
    assert.equal(ovMkt.json.data.limits.monthly_lead_quota, 50_000);
    assert.ok(
      Array.isArray(ovMkt.json.data.enabled_modules) && ovMkt.json.data.enabled_modules.includes('audiences'),
      'marketing_standalone must enable audiences module'
    );

    // 3. Tenant C spot-checks legacy aliases 'growth' & 'enterprise'
    const tC = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Alias Limits C',
      tenant_slug: 'f7-alias-limits-c',
    });
    assert.equal(tC.status, 201);
    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tC.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 50_000_000, extend_months: 0 },
    });

    const subGrowth = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tC.adminToken,
      tenantSlug: tC.tenantSlug,
      body: { plan_code: 'growth', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subGrowth.status, 200, `growth subscribe failed: ${subGrowth.rawText}`);
    assert.equal(subGrowth.json.data.subscription.limits.max_users, 100);

    const subEnt = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tC.adminToken,
      tenantSlug: tC.tenantSlug,
      body: { plan_code: 'enterprise', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subEnt.status, 200, `enterprise subscribe failed: ${subEnt.rawText}`);
    assert.ok(subEnt.json.data.subscription.limits.max_users >= 9999);
  });

  test('Tier 2.4: Downgrade is blocked when active users exceed target plan max_users', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F7 Downgrade Guard Co',
      slug: 'f7-downgrade-guard',
      salesCount: 0,
    });

    // Upgrade tenant to growth (100 users) and seed 26 users (> 25 starter limit)
    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${ws.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 10_000_000, extend_months: 1, plan_code: 'autodata_growth' },
    });

    for (let i = 1; i <= 26; i++) {
      const uRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
        method: 'POST',
        token: ws.adminToken,
        tenantSlug: ws.tenantSlug,
        body: {
          full_name: `Growth Sale ${i}`,
          email: `gsale${i}@f7-downgrade-guard.vn`,
          phone: `0907000${String(i).padStart(3, '0')}`,
          password: 'StaffPassword123!',
          role: 'sale',
        },
      });
      assert.equal(uRes.status, 201, `User ${i} should be allowed on growth plan (100 max_users)`);
    }

    // Attempt downgrade to autodata_standard (max_users = 25) -> MUST be blocked with 409/422/400
    const downRes = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        plan_code: 'autodata_standard',
        billing_cycle: 'monthly',
        payment_method: 'wallet',
      },
    });
    assert.ok(
      downRes.status === 409 || downRes.status === 422 || downRes.status === 400,
      `Downgrade with 27 active users > 25 limit must be blocked, got HTTP ${downRes.status}: ${downRes.rawText}`
    );
  });

  test('Tier 2.5: Duplicate X-Idempotency-Key / idempotency_key on POST /api/v1/billing/topup returns deduplicated tx', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Topup Idem Co',
      tenant_slug: 'f7-topup-idem',
    });
    assert.equal(t.status, 201);

    const idemKey = `topup-idem-${Date.now()}`;
    const first = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      headers: { 'X-Idempotency-Key': idemKey },
      body: { package_id: 'topup_1m' },
    });
    assert.equal(first.status, 201);

    const second = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      headers: { 'X-Idempotency-Key': idemKey },
      body: { package_id: 'topup_1m' },
    });
    assert.ok(second.status === 200 || second.status === 201);
    assert.equal(
      second.json.data.transaction.id,
      first.json.data.transaction.id,
      'Duplicate idempotency key must return the exact same transaction ID'
    );

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.json.data.transactions.length, 1, 'Only 1 topup transaction row may exist');
  });

  test('Tier 2.6: Duplicate billing webhook (provider, external_tx_id) is deduplicated with zero double-credit', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Webhook Dedup Co',
      tenant_slug: 'f7-webhook-dedup',
    });
    assert.equal(t.status, 201);

    const topup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { package_id: 'topup_1m', provider: 'sepay' },
    });
    assert.equal(topup.status, 201);
    const refCode = topup.json.data.transaction.reference_code;

    const sepaySecret = process.env.SEPAY_WEBHOOK_SECRET!;
    assert.ok(sepaySecret, 'SEPAY_WEBHOOK_SECRET must be configured in E2E harness');
    const sepayExtId = `sepay_dup_${Date.now()}`;
    const sepayPayload = {
      id: sepayExtId,
      code: refCode,
      transferAmount: 1_500_000,
      transferType: 'in',
    };

    const first = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/sepay', {
      method: 'POST',
      headers: { Authorization: `Apikey ${sepaySecret}` },
      body: sepayPayload,
    });
    assert.equal(first.status, 200, `First SePay webhook failed: ${first.status}: ${first.rawText}`);

    const second = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/sepay', {
      method: 'POST',
      headers: { Authorization: `Apikey ${sepaySecret}` },
      body: sepayPayload,
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.data.idempotent_replay, true);

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.json.data.subscription.wallet_balance_vnd, 1_500_000, 'Duplicate webhook must never double-credit');
  });

  test('Tier 2.7: Insufficient wallet returns 402 AND 25 concurrent wallet subscribe requests let only 1 succeed', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Concurrency Co',
      tenant_slug: 'f7-concurrency',
    });
    assert.equal(t.status, 201);

    const insufficient = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(insufficient.status, 402);

    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${t.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 1_500_000, extend_months: 0 },
    });

    const race = await Promise.all(
      Array.from({ length: 25 }, () =>
        apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
          method: 'POST',
          token: t.adminToken,
          tenantSlug: t.tenantSlug,
          body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'wallet' },
        })
      )
    );
    assert.equal(race.filter((r) => r.status === 200).length, 1);
    assert.equal(race.filter((r) => r.status === 402).length, 24);

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.json.data.subscription.wallet_balance_vnd, 0);
  });

  test('Tier 2.8: Expiry cron transitions expired -> grace -> suspended and wallet subscribe reactivates to active', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Grace Suspend Co',
      tenant_slug: 'f7-grace-suspend',
    });
    assert.equal(t.status, 201);

    // Move trial expiry 1 day in the past -> should enter grace window first
    await withTenantTransaction(t.tenantId, async (client) => {
      await client.query(
        `UPDATE tenants
         SET trial_ends_at = clock_timestamp() - INTERVAL '1 day',
             subscription_expires_at = NULL
         WHERE id = $1`,
        [t.tenantId]
      );
    });
    tenantRedis.invalidateTenantCache(t.tenantId, t.tenantSlug);

    const cron1 = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['billing'], tenantId: t.tenantId });
    assert.equal(cron1.status, 200);

    const ovGrace = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ovGrace.json.data.subscription.status, 'grace', 'Recently expired tenant with 0 wallet must enter grace period before suspension');

    // Move grace_ends_at past now -> cron transitions grace -> suspended
    await withTenantTransaction(t.tenantId, async (client) => {
      await client.query(
        `UPDATE tenants
         SET trial_ends_at = clock_timestamp() - INTERVAL '10 days',
             grace_ends_at = clock_timestamp() - INTERVAL '1 day'
         WHERE id = $1`,
        [t.tenantId]
      );
    });
    tenantRedis.invalidateTenantCache(t.tenantId, t.tenantSlug);

    const cron2 = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['billing'], tenantId: t.tenantId });
    assert.equal(cron2.status, 200);

    const ovSusp = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ovSusp.json.data.subscription.status, 'suspended');

    // Grant wallet and subscribe -> reactivates cleanly to active
    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${t.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 1_500_000, extend_months: 0 },
    });
    const reactivate = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(reactivate.status, 200);
    assert.equal(reactivate.json.data.subscription.status, 'active');
  });

  test('Tier 2.9: Annual (365d) vs monthly (30d) cron auto-renewal honors billing_cycle AND invalid webhook HMAC is rejected', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F7 Annual Cron Co',
      tenant_slug: 'f7-annual-cron',
    });
    assert.equal(t.status, 201);

    // Provider-accurate invalid HMAC/token rejections & unconfigured gateway check
    const badManual = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/manual_bank_transfer', {
      method: 'POST',
      headers: {
        'X-Webhook-Signature': `sha256=${'0'.repeat(64)}`,
      },
      body: { external_tx_id: 'bad_manual_tx', reference_code: 'INVALID', amount_vnd: 1_500_000, status: 'paid' },
    });
    assert.equal(badManual.status, 401, `Invalid manual_bank_transfer HMAC must return 401, got ${badManual.status}`);

    const badPayos = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/payos', {
      method: 'POST',
      headers: {
        'x-payos-signature': '0'.repeat(64),
      },
      body: { code: '00', success: true, data: { orderCode: 12345, amount: 1_500_000, description: 'INVALID' } },
    });
    assert.equal(badPayos.status, 401, `Invalid PayOS signature must return 401, got ${badPayos.status}`);

    const badSepay = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/sepay', {
      method: 'POST',
      headers: {
        Authorization: 'Apikey wrong_secret',
      },
      body: { id: 'bad_sepay_tx', code: 'INVALID', transferAmount: 1_500_000, transferType: 'in' },
    });
    assert.equal(badSepay.status, 401, `Invalid SePay token must return 401, got ${badSepay.status}`);

    const unconfiguredVnpay = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/vnpay', {
      method: 'POST',
      body: { vnp_TxnRef: 'INVALID', vnp_Amount: '150000000', vnp_ResponseCode: '00' },
    });
    assert.equal(
      unconfiguredVnpay.status,
      503,
      `Unconfigured VNPay gateway must return 503 GATEWAY_NOT_CONFIGURED, got ${unconfiguredVnpay.status}`
    );
    assert.equal(unconfiguredVnpay.json.error?.code, 'GATEWAY_NOT_CONFIGURED');

    // Set tenant to annual cycle with sufficient wallet (15.3M) and expired subscription
    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${t.tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 15_300_000, extend_months: 0, plan_code: 'autodata_standard' },
    });
    await withTenantTransaction(t.tenantId, async (client) => {
      await client.query(
        `UPDATE tenants
         SET billing_cycle = 'annual',
             subscription_plan_code = 'autodata_standard',
             trial_ends_at = clock_timestamp() - INTERVAL '2 days',
             subscription_expires_at = clock_timestamp() - INTERVAL '1 hour',
             status = 'active'
         WHERE id = $1`,
        [t.tenantId]
      );
    });
    tenantRedis.invalidateTenantCache(t.tenantId, t.tenantSlug);

    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['billing'], tenantId: t.tenantId });
    assert.equal(cronRes.status, 200);

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(ov.json.data.subscription.billing_cycle, 'annual');
    assert.equal(ov.json.data.subscription.wallet_balance_vnd, 0, 'Annual renewal must deduct 15.3M');
    assert.ok(
      ov.json.data.subscription.days_remaining >= 364 && ov.json.data.subscription.days_remaining <= 366,
      `Annual cron auto-renew must extend by 365 days, got ${ov.json.data.subscription.days_remaining}`
    );
  });
});
