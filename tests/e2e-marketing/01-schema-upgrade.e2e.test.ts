import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness } from './_harness.ts';

let harness: MarketingE2eHarness;

describe('Feature 1: DB Schema, Entitlements & 1-Click Package Upgrade (E2E)', () => {
  before(async () => {
    harness = await startMarketingE2eHarness();
  });

  after(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.resetCaptures();
  });

  // =========================================================================
  // Tier 1 — Happy Path (6 tests)
  // =========================================================================
  describe('Tier 1: Happy Path', () => {
    it('F1-T1-01: registers marketing_standalone tenant & exposes MARKETING_STANDALONE_MODULES only', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      assert.equal(auth.status, 201);
      assert.ok(auth.tenantId);
      assert.ok(auth.accessToken);

      const entRes = await harness.apiJson('/api/v1/myerp/package-entitlements', { auth });
      const data = entRes.data;
      assert.equal(data.package_code, 'marketing_standalone');
      assert.equal(data.current_package, 'marketing_standalone');
      assert.equal(data.zero_migration_ready, true);

      const expectedModules = [
        'dashboard_marketing',
        'audiences',
        'mkt_templates',
        'mkt_forms',
        'mkt_surveys',
        'mkt_campaigns',
        'mkt_flows',
        'mkt_vouchers',
        'mkt_web_tracking',
        'mkt_social_bot',
        'mkt_ai_bot',
        'integrations_marketing',
        'dom_marketing_copilot',
      ];
      for (const mod of expectedModules) {
        assert.ok(data.enabled_modules.includes(mod), `Expected module "${mod}" to be enabled`);
      }

      for (const excluded of ['pipelines', 'rounds', 'hrm']) {
        assert.ok(!data.enabled_modules.includes(excluded), `Expected module "${excluded}" to be excluded`);
      }
    });

    it('F1-T1-02: funds wallet via topup + SuperAdmin approval & reflects balance in /billing/overview', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      assert.equal(auth.status, 201);

      const topupRes = await harness.apiRaw('/api/v1/billing/topup', {
        method: 'POST',
        auth,
        headers: { 'X-Idempotency-Key': `topup-f1-${auth.tenantSlug}` },
        body: { amount_vnd: 10_000_000, provider: 'manual_bank_transfer' },
      });
      assert.equal(topupRes.status, 201);
      const tx = topupRes.json?.data?.transaction;
      assert.equal(tx?.status, 'pending');
      assert.ok(tx?.id);

      const adminLogin = await harness.apiJson('/api/v1/admin/auth/login', {
        method: 'POST',
        body: {
          email: 'ops-admin@autodata.vn',
          password: 'SuperAdminMasterPassword999!',
        },
      });
      const superToken = adminLogin.data?.access_token;
      assert.ok(superToken);

      const resolveRes = await harness.apiRaw(`/api/v1/admin/billing/requests/${tx.id}/resolve`, {
        method: 'POST',
        token: superToken,
        body: { decision: 'approve', resolution_note: 'E2E F1-T1-02 topup approval' },
      });
      assert.equal(resolveRes.status, 200);
      assert.equal(resolveRes.json?.data?.status, 'approved');

      const overview = await harness.apiJson('/api/v1/billing/overview', { auth });
      assert.equal(overview.data?.wallet_balance_vnd, 10_000_000);
      assert.ok(Array.isArray(overview.data?.transactions) && overview.data.transactions.length >= 1);
    });

    it('F1-T1-03: 1-click upgrade marketing_standalone -> growth_combo preserves existing marketing data', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      assert.equal(auth.status, 201);

      const createdFlow = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Pre-Upgrade Nurture Flow',
          trigger_type: 'form_submitted',
          steps: [{ id: 's1', type: 'update_lead_score', label: 'Score +5', config: { delta: 5 } }],
        },
      });
      const flowId = createdFlow.data.id;

      const createdTpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Pre-Upgrade Welcome Template',
          subject: 'Welcome {{lead.name}}',
          blocks: [{ id: 'b1', type: 'text', content: 'Hello from standalone' }],
        },
      });
      const tplId = createdTpl.data.id;

      const createdContact = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Pre-Upgrade Lead',
          email: 'preupgrade@example.vn',
          phone: '0909555666',
        },
      });
      const contactId = createdContact.data.id;

      const upgradeData = await harness.upgradePackage(auth, 'growth_combo', {
        billingCycle: 'monthly',
        paymentMethod: 'wallet',
      });
      assert.equal(upgradeData.upgraded, true);
      assert.equal(upgradeData.zero_migration_preserved, true);
      assert.equal(upgradeData.previous_package, 'marketing_standalone');
      assert.equal(upgradeData.current_package, 'growth_combo');
      assert.ok(upgradeData.enabled_modules.includes('mkt_flows'));
      assert.ok(upgradeData.enabled_modules.includes('pipelines'));
      assert.ok(upgradeData.enabled_modules.includes('rounds'));
      assert.ok(upgradeData.enabled_modules.includes('revenue_attribution'));

      const flowsAfter = await harness.apiJson('/api/v1/marketing/flows', { auth });
      assert.ok(flowsAfter.data.items.some((f: any) => f.id === flowId && f.name === 'Pre-Upgrade Nurture Flow'));

      const tplsAfter = await harness.apiJson('/api/v1/marketing/templates', { auth });
      assert.ok(
        tplsAfter.data.items.some((t: any) => t.id === tplId && t.name === 'Pre-Upgrade Welcome Template')
      );

      const contactsAfter = await harness.apiJson('/api/v1/audiences/contacts', { auth });
      assert.ok(contactsAfter.data.items.some((c: any) => c.id === contactId && c.name === 'Pre-Upgrade Lead'));
    });

    it('F1-T1-04: upgrades growth_combo -> domation_promax via /billing/switch-package with proration & limits', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      await harness.upgradePackage(auth, 'growth_combo', {
        billingCycle: 'monthly',
        paymentMethod: 'wallet',
        topupAmountVnd: 50_000_000,
      });

      const switched = await harness.upgradePackage(auth, 'domation_promax', {
        endpoint: 'billing',
        billingCycle: 'monthly',
        paymentMethod: 'wallet',
      });

      assert.equal(switched.package_code, 'domation_promax');
      for (const mod of ['hrm', 'finance', 'projects', 'dom_agent']) {
        assert.ok(switched.enabled_modules.includes(mod), `Expected ${mod} in domation_promax`);
      }
      assert.equal(switched.subscription?.limits?.max_users, 9999);
      assert.equal(switched.subscription?.limits?.max_rounds, 999);
    });

    it('F1-T1-05: toggles education_addon & industry_key on same package and replays idempotently', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo' });
      const idemKey = `idem-edu-${auth.tenantSlug}`;

      const firstRes = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        headers: { 'X-Idempotency-Key': idemKey },
        body: {
          package_code: 'growth_combo',
          education_addon: true,
          industry_key: 'education',
        },
      });
      assert.equal(firstRes.status, 200);
      assert.ok(firstRes.json.data.enabled_modules.includes('education'));
      assert.equal(firstRes.json.data.terminology?.industry_key, 'education');

      const overviewBefore = await harness.apiJson('/api/v1/billing/overview', { auth });

      const replayRes = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        headers: { 'X-Idempotency-Key': idemKey },
        body: {
          package_code: 'growth_combo',
          education_addon: true,
          industry_key: 'education',
        },
      });
      assert.equal(replayRes.status, 200);
      assert.equal(replayRes.json.data.idempotent_replay, true);

      const overviewAfter = await harness.apiJson('/api/v1/billing/overview', { auth });
      assert.equal(overviewAfter.data.wallet_balance_vnd, overviewBefore.data.wallet_balance_vnd);
    });

    it('F1-T1-06: schedules period-end downgrade when active paid subscription exists', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      await harness.upgradePackage(auth, 'growth_combo', {
        billingCycle: 'monthly',
        paymentMethod: 'wallet',
      });

      const downgradeRes = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        body: {
          package_code: 'marketing_standalone',
          schedule_at_period_end: true,
        },
      });
      assert.equal(downgradeRes.status, 200);
      const data = downgradeRes.json.data;
      assert.equal(
        data.scheduled_downgrade === true || data.subscription?.scheduled_plan_code === 'marketing_standalone',
        true
      );
      if (data.effective_at) {
        assert.ok(!Number.isNaN(Date.parse(String(data.effective_at))));
      }
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (6 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F1-T2-01: blocks autodata_crm tenant from Marketing & Audiences endpoints with 403 MODULE_NOT_ENTITLED', async () => {
      const crmAuth = await harness.registerTenant({ packageCode: 'autodata_crm' });
      assert.equal(crmAuth.status, 201);

      for (const path of [
        '/api/v1/marketing/overview',
        '/api/v1/marketing/flows',
        '/api/v1/audiences/field-catalog',
      ]) {
        const res = await harness.apiRaw(path, { auth: crmAuth });
        assert.equal(res.status, 403, `Expected 403 for ${path}, got ${res.status}`);
        assert.equal(res.json?.error?.code, 'MODULE_NOT_ENTITLED');
      }
    });

    it('F1-T2-02: rejects wallet upgrade with 402 INSUFFICIENT_WALLET_BALANCE when balance is 0', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const compatRes = await harness.apiRaw('/api/v1/myerp/package-entitlements/upgrade', {
        method: 'POST',
        auth,
        body: { package_code: 'growth_combo', payment_method: 'wallet' },
      });
      assert.equal(compatRes.status, 402);
      assert.equal(compatRes.json?.error?.code, 'INSUFFICIENT_WALLET_BALANCE');

      const billingRes = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        body: { package_code: 'growth_combo', payment_method: 'wallet' },
      });
      assert.equal(billingRes.status, 402);
      assert.equal(billingRes.json?.error?.code, 'INSUFFICIENT_WALLET_BALANCE');
    });

    it('F1-T2-03: returns 409 IDEMPOTENCY_KEY_MISMATCH on conflicting payloads with same X-Idempotency-Key', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const topupKey = `conflict-topup-${auth.tenantSlug}`;

      const t1 = await harness.apiRaw('/api/v1/billing/topup', {
        method: 'POST',
        auth,
        headers: { 'X-Idempotency-Key': topupKey },
        body: { amount_vnd: 500_000 },
      });
      assert.equal(t1.status, 201);

      const t2 = await harness.apiRaw('/api/v1/billing/topup', {
        method: 'POST',
        auth,
        headers: { 'X-Idempotency-Key': topupKey },
        body: { amount_vnd: 1_000_000 },
      });
      assert.equal(t2.status, 409);
      assert.equal(t2.json?.error?.code, 'IDEMPOTENCY_KEY_MISMATCH');

      // Also verify conflicting switch-package payloads on the same idempotency key
      const switchKey = `conflict-switch-${auth.tenantSlug}`;
      const s1 = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        headers: { 'X-Idempotency-Key': switchKey },
        body: { package_code: 'growth_combo', payment_method: 'manual_bank_transfer' },
      });
      assert.equal(s1.status, 201);

      const s2 = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        headers: { 'X-Idempotency-Key': switchKey },
        body: { package_code: 'domation_promax', payment_method: 'manual_bank_transfer' },
      });
      assert.equal(s2.status, 409);
      assert.equal(s2.json?.error?.code, 'IDEMPOTENCY_KEY_MISMATCH');
    });

    it('F1-T2-04: rejects immediate downgrade with 409 DOWNGRADE_USAGE_EXCEEDED when distribution_rounds > 5', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      await harness.upgradePackage(auth, 'growth_combo', {
        billingCycle: 'monthly',
        paymentMethod: 'wallet',
      });

      // growth_combo allows 30 rounds; autodata_crm/marketing_standalone allow max 5
      for (let i = 1; i <= 6; i++) {
        const roundRes = await harness.apiRaw('/api/v1/pipelines/rounds', {
          method: 'POST',
          auth,
          body: { name: `Quota Round ${i}`, priority: i },
        });
        assert.ok(roundRes.ok, `Expected round ${i} creation to succeed, got ${roundRes.status}: ${roundRes.rawText}`);
      }

      const billingDowngrade = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        body: { package_code: 'autodata_crm', payment_method: 'wallet' },
      });
      assert.equal(billingDowngrade.status, 409);
      assert.equal(billingDowngrade.json?.error?.code, 'DOWNGRADE_USAGE_EXCEEDED');

      const compatDowngrade = await harness.apiRaw('/api/v1/myerp/package-entitlements/upgrade', {
        method: 'POST',
        auth,
        body: { package_code: 'autodata_crm', payment_method: 'wallet' },
      });
      assert.equal(compatDowngrade.status, 409);
      assert.equal(compatDowngrade.json?.error?.code, 'DOWNGRADE_USAGE_EXCEEDED');
    });

    it('F1-T2-05: rejects invalid package_code (400/422) and below-minimum topup amount (422)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const badCompatPkg = await harness.apiRaw('/api/v1/myerp/package-entitlements/upgrade', {
        method: 'POST',
        auth,
        body: { package_code: 'invalid_pkg_xyz' },
      });
      assert.equal(badCompatPkg.status, 400);
      assert.equal(badCompatPkg.json?.error?.code, 'INVALID_PACKAGE_CODE');

      const badBillingPkg = await harness.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        auth,
        body: { package_code: 'invalid_pkg_xyz' },
      });
      assert.equal(badBillingPkg.status, 422);
      assert.equal(badBillingPkg.json?.error?.code, 'INVALID_PACKAGE_CODE');

      const badTopup = await harness.apiRaw('/api/v1/billing/topup', {
        method: 'POST',
        auth,
        body: { amount_vnd: 99_999 },
      });
      assert.equal(badTopup.status, 422);
      assert.equal(badTopup.json?.error?.code, 'INVALID_TOPUP_AMOUNT');
    });

    it('F1-T2-06: blocks cross-tenant X-Tenant-Slug spoofing with 403 TENANT_CONTEXT_MISMATCH', async () => {
      const tenantA = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const tenantB = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const crossRes = await harness.apiRaw('/api/v1/billing/overview', {
        token: tenantA.accessToken,
        tenantSlug: tenantB.tenantSlug,
      });
      assert.equal(crossRes.status, 403);
      assert.equal(crossRes.json?.error?.code, 'TENANT_CONTEXT_MISMATCH');
    });
  });
});
