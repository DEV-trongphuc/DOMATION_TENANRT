import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withSystemPrivilege, withTenantTransaction } from '../server/core/database/transaction.ts';
import { MariaDbPoolAdapter } from '../server/core/database/db-adapter.ts';
import { runDatabaseMigrations } from '../server/core/database/migrate.ts';
import { getUtcMonthKey, tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { getTenantMetaCached } from '../server/core/settings/tenant-cache.ts';
import { encryptTenantSecret } from '../server/core/crypto/vault.ts';
import {
  DEFAULT_BILLING_CATALOG,
  enforceTenantOperationalPolicy,
  isIdempotencyUniqueViolation,
  resolveTenantPlanLimits,
} from '../server/services/billing.service.ts';
import {
  dispatchStageCapiEventDetached,
  resolveEffectiveMetaCapiConfig,
  setCapiHttpTransportForTesting,
} from '../server/services/capi.service.ts';
import {
  runMetaCapiRetryWorker,
  setCapiRetryFetcherForTesting,
} from '../server/cron/subroutines/capi-retry.ts';
import { runSubscriptionExpiryManager } from '../server/cron/subroutines/billing-manager.ts';
import { ingestAndDistributeLead } from '../server/services/distribution.service.ts';
import {
  evaluateLeadGatekeeperWithGemini,
  setLeadAiScreenerFetcherForTesting,
} from '../server/services/ai-screener.service.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PG_SCHEMA_PATH = path.resolve(__dirname, '../docs/DATABASE_SCHEMA.sql');
const MARIADB_SCHEMA_PATH = path.resolve(__dirname, '../docs/DATABASE_SCHEMA_MARIADB.sql');

describe('Milestone M1: DB Schema, Billing Lifecycle, Gateway Adapter, AI Gatekeeper & CAPI Loop', () => {
  let harness: TestHarness;
  let platformToken = '';
  let tenantA = { id: '', slug: '', token: '', userId: '' };
  let prevSilentMode: string | undefined;

  before(async () => {
    prevSilentMode = process.env.OUTBOUND_SILENT_MODE;
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const adminLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: { email: 'ops-admin@autodata.vn', password: 'SuperAdminMasterPassword999!' },
    });
    assert.equal(adminLogin.status, 200);
    platformToken = adminLogin.json.data.access_token;

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Lifecycle Corp',
        tenant_slug: 'm1-lifecycle-corp',
        admin_name: 'M1 Owner',
        work_email: 'owner@m1-lifecycle.vn',
        phone: '0901999111',
        password: 'SecurePassword123!',
        industry: 'general',
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
  });

  after(async () => {
    setCapiHttpTransportForTesting(null);
    setCapiRetryFetcherForTesting(null);
    setLeadAiScreenerFetcherForTesting(null);
    if (prevSilentMode === undefined) {
      delete process.env.OUTBOUND_SILENT_MODE;
    } else {
      process.env.OUTBOUND_SILENT_MODE = prevSilentMode;
    }
    await harness.close();
  });

  it('M1.1a: SQL schemas have zero duplicate CREATE TABLE blocks for all 6 deduplicated tables', () => {
    const dedupTables = [
      'tenant_custom_fields',
      'tenant_entity_tabs',
      'tenant_invoices',
      'tenant_task_dependencies',
      'tenant_task_comments',
      'tenant_task_attachments',
    ];
    for (const [label, filePath] of [
      ['DATABASE_SCHEMA.sql', PG_SCHEMA_PATH],
      ['DATABASE_SCHEMA_MARIADB.sql', MARIADB_SCHEMA_PATH],
    ] as const) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const tbl of dedupTables) {
        const matches = content.match(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tbl}\\b`, 'gi')) || [];
        assert.equal(matches.length, 1, `${label} must define ${tbl} exactly once, found ${matches.length}`);
      }
      assert.ok(
        content.includes('idx_billing_tx_tenant_status_created'),
        `${label} must declare idx_billing_tx_tenant_status_created`
      );
      assert.ok(
        content.includes('idx_leads_tenant_created_at'),
        `${label} must declare idx_leads_tenant_created_at`
      );
    }
  });

  it('M1.1b: Lifecycle DDL, constraints, indexes, idempotent re-migration & setCachedTenantMeta name preservation', async () => {
    await runDatabaseMigrations({ seedSuperAdmin: false });

    await withSystemPrivilege(async (client) => {
      const colRes = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('tenants', 'tenant_billing_transactions', 'tenant_cron_runs', 'capi_logs')`
      );
      const colSet = new Set(colRes.rows.map((r) => `${r.table_name}.${r.column_name}`));
      for (const expected of [
        'tenants.grace_ends_at',
        'tenants.auto_renew',
        'tenants.cancel_at_period_end',
        'tenants.cancelled_at',
        'tenants.scheduled_plan_code',
        'tenants.scheduled_billing_cycle',
        'tenant_billing_transactions.idempotency_key',
        'tenant_billing_transactions.provider',
        'tenant_billing_transactions.external_tx_id',
        'tenant_billing_transactions.proration_credit_vnd',
        'tenant_cron_runs.run_key',
        'capi_logs.retry_count',
        'capi_logs.next_retry_at',
      ]) {
        assert.ok(colSet.has(expected), `Missing expected column ${expected}`);
      }

      const idxRes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
      );
      const idxSet = new Set(idxRes.rows.map((r) => r.indexname));
      for (const idx of [
        'idx_billing_tx_tenant_idempotency',
        'idx_billing_tx_provider_ext',
        'idx_billing_tx_reference_code',
        'idx_billing_tx_tenant_status_created',
        'idx_billing_tx_tenant_type_created',
        'idx_cron_runs_tenant_sub_run_key',
        'idx_capi_logs_lead_event_status',
        'idx_capi_logs_retry_next',
        'idx_leads_tenant_created_at',
        'idx_leads_tenant_ad_id',
        'idx_leads_tenant_adset_id',
        'idx_data_reports_tenant_lead_created',
        'idx_meta_ads_tenant_ad_stop',
      ]) {
        assert.ok(idxSet.has(idx), `Missing expected index ${idx}`);
      }

      // Verify tenant_cron_runs accepts NULL tenant_id + unique run_key
      await client.query(
        `INSERT INTO tenant_cron_runs (tenant_id, subroutine_key, run_key, status)
         VALUES (NULL, 'daily_report', 'global-2026-11-19', 'success')`
      );
    });

    // Verify setCachedTenantMeta preserves name & obfuscated_slug
    tenantRedis.setCachedTenantBySlug(tenantA.slug, {
      id: tenantA.id,
      slug: tenantA.slug,
      obfuscated_slug: 'obf_m1_test_slug',
      status: 'active',
    });
    tenantRedis.setCachedTenantMeta(tenantA.id, {
      slug: tenantA.slug,
      name: 'M1 Lifecycle Corp',
      status: 'active',
      rawSettings: {},
    });
    const warmMeta = await getTenantMetaCached(tenantA.id);
    assert.equal(warmMeta?.name, 'M1 Lifecycle Corp');
    const slugMeta = tenantRedis.getCachedTenantBySlug(tenantA.slug);
    assert.equal(slugMeta?.obfuscated_slug, 'obf_m1_test_slug');
  });

  it('M1.1c: MariaDbPoolAdapter WeakSet raw-connection tracking, sql_mode error release & translated GET_LOCK cleanup', async () => {
    // Subcase A: SET sql_mode runs once per raw connection across fresh wrapper objects
    const rawConnA = { id: 'raw-a' };
    const queriesA: Array<{ sql: string; params?: any[] }> = [];
    let releaseCountA = 0;
    const mockPoolA: any = {
      async getConnection() {
        return {
          connection: rawConnA,
          async query(sql: string, params?: any[]) {
            queriesA.push({ sql, params });
            return [[], []];
          },
          release() {
            releaseCountA += 1;
          },
        };
      },
      async end() {},
    };
    const adapterA = new MariaDbPoolAdapter({ pool: mockPoolA });
    const c1 = await adapterA.connect();
    await c1.query('SELECT 1');
    c1.release();
    const c2 = await adapterA.connect();
    await c2.query('SELECT 2');
    c2.release();
    const sqlModeCalls = queriesA.filter((q) => q.sql.includes('SET sql_mode')).length;
    const releaseLockCalls = queriesA.filter((q) => q.sql.includes('RELEASE_ALL_LOCKS')).length;
    assert.equal(sqlModeCalls, 1, 'SET sql_mode must run once per underlying raw connection');
    assert.equal(releaseLockCalls, 0, 'RELEASE_ALL_LOCKS must not run when no lock was acquired');
    assert.equal(releaseCountA, 2);

    // Subcase B: SET sql_mode error releases connection and does not cache
    const rawConnB = { id: 'raw-b' };
    let failSqlMode = true;
    let releaseCountB = 0;
    let sqlModeAttemptsB = 0;
    const mockPoolB: any = {
      async getConnection() {
        return {
          connection: rawConnB,
          async query(sql: string) {
            if (sql.includes('SET sql_mode')) {
              sqlModeAttemptsB += 1;
              if (failSqlMode) throw new Error('sql_mode error');
            }
            return [[], []];
          },
          release() {
            releaseCountB += 1;
          },
        };
      },
      async end() {},
    };
    const adapterB = new MariaDbPoolAdapter({ pool: mockPoolB });
    await assert.rejects(() => adapterB.connect(), /sql_mode error/);
    assert.equal(releaseCountB, 1, 'Connection must be released when SET sql_mode throws');
    failSqlMode = false;
    const cB = await adapterB.connect();
    cB.release();
    assert.equal(sqlModeAttemptsB, 2, 'Failed connection must not be cached in WeakSet');
    assert.equal(releaseCountB, 2);

    // Subcase C: pg_advisory_xact_lock & pg_try_advisory_lock trigger RELEASE_ALL_LOCKS() before conn.release()
    const rawConnC = { id: 'raw-c' };
    const eventsC: string[] = [];
    const seenLockQueries: Array<{ sql: string; params?: any[] }> = [];
    const mockPoolC: any = {
      async getConnection() {
        return {
          connection: rawConnC,
          async query(sql: string, params?: any[]) {
            eventsC.push(`query:${sql}`);
            if (sql.includes('GET_LOCK')) {
              seenLockQueries.push({ sql, params });
              return [[{ lock_acquired: 1 }], []];
            }
            return [[], []];
          },
          release() {
            eventsC.push('release');
          },
        };
      },
      async end() {},
    };
    const adapterC = new MariaDbPoolAdapter({ pool: mockPoolC });
    const cC1 = await adapterC.connect();
    await cC1.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))", ['t-1', '0901234567']);
    assert.ok(seenLockQueries[0].sql.includes('GET_LOCK(MD5(?'), 'Expected MD5 GET_LOCK translation');
    assert.deepEqual(seenLockQueries[0].params, ['t-1', '0901234567']);
    cC1.release();
    await new Promise((r) => setImmediate(r));
    const idxRelLock1 = eventsC.indexOf('query:SELECT RELEASE_ALL_LOCKS()');
    const idxRelease1 = eventsC.indexOf('release');
    assert.ok(idxRelLock1 >= 0 && idxRelease1 > idxRelLock1, 'RELEASE_ALL_LOCKS must execute before conn.release()');

    eventsC.length = 0;
    const cC2 = await adapterC.connect();
    await cC2.query("SELECT pg_try_advisory_lock(hashtext('cron_key'))");
    cC2.release();
    await new Promise((r) => setImmediate(r));
    const idxRelLock2 = eventsC.indexOf('query:SELECT RELEASE_ALL_LOCKS()');
    const idxRelease2 = eventsC.indexOf('release');
    assert.ok(idxRelLock2 >= 0 && idxRelease2 > idxRelLock2, 'pg_try_advisory_lock must trigger RELEASE_ALL_LOCKS()');
  });

  it('M1.2a: Reconciled Catalog pricing (1.5M/3.0M/6.0M/1.8M) & ALL 10 resolveTenantPlanLimits codes', async () => {
    const catRes = await apiRequest(harness.baseUrl, '/api/v1/billing/catalog');
    assert.equal(catRes.status, 200);
    const cat = catRes.json.data;
    assert.equal(cat.packages.autodata_crm.monthly_price_vnd, 1_500_000);
    assert.equal(cat.packages.marketing_standalone.monthly_price_vnd, 1_800_000);
    assert.equal(cat.packages.growth_combo.monthly_price_vnd, 3_000_000);
    assert.equal(cat.packages.domation_promax.monthly_price_vnd, 6_000_000);
    assert.equal(cat.plans[2].max_sales, 9999);
    assert.equal(cat.plans[2].max_managers, 9999);
    assert.equal(cat.plans[2].max_users, 9999);

    const expectedMaxUsers: Record<string, number> = {
      autodata_standard: 25,
      starter: 25,
      autodata_crm: 25,
      marketing_standalone: 25,
      autodata_growth: 100,
      growth: 100,
      growth_combo: 100,
      domation_crm_erp: 9999,
      enterprise: 9999,
      domation_promax: 9999,
    };
    for (const [code, maxUsers] of Object.entries(expectedMaxUsers)) {
      const limits = resolveTenantPlanLimits(
        { plan_code: code, plan_tier: code as any, package_code: code },
        DEFAULT_BILLING_CATALOG
      );
      assert.equal(limits.max_users, maxUsers, `Code ${code} must resolve max_users=${maxUsers}, got ${limits.max_users}`);
    }
  });

  it('M1.2b: Eliminates 0₫ switch-package bypass across billing, workspace & myerp routes', async () => {
    for (const url of [
      '/api/v1/billing/switch-package',
      '/api/v1/workspace/package',
      '/api/v1/myerp/package-entitlements/upgrade',
    ]) {
      const blocked = await apiRequest(harness.baseUrl, url, {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { package_code: 'growth_combo' },
      });
      assert.equal(blocked.status, 402, `${url} must reject 0₫ upgrade with 402`);
      assert.equal(blocked.json.error?.code, 'INSUFFICIENT_WALLET_BALANCE');
    }

    // Pending bank_transfer switch creates order (201) WITHOUT unlocking growth_combo yet
    const pendingSwitch = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'growth_combo', payment_method: 'bank_transfer' },
    });
    assert.equal(pendingSwitch.status, 201);
    assert.equal(pendingSwitch.json.data.requires_payment, true);
    assert.ok(pendingSwitch.json.data.gateway_session?.qr_url);

    const ovStillStarter = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(ovStillStarter.status, 200);
    assert.equal(ovStillStarter.json.data.package_code, 'autodata_crm');
    assert.ok(Array.isArray(ovStillStarter.json.data.supported_gateways));
    assert.equal(ovStillStarter.json.data.auto_renew, true);
  });

  it('M1.2c: Topup idempotency, high-entropy refCode, proration upgrade, downgrade check, annual renew, cancel & webhook HMAC', async () => {
    // 1. Topup idempotency + upper bound
    const overMax = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { amount_vnd: 900_000_000 },
    });
    assert.equal(overMax.status, 422);

    const idempKey = `topup-idemp-${Date.now()}`;
    const t1 = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'X-Idempotency-Key': idempKey },
      body: { amount_vnd: 10_000_000, provider: 'payos' },
    });
    assert.equal(t1.status, 201);
    const t2 = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'X-Idempotency-Key': idempKey },
      body: { amount_vnd: 10_000_000, provider: 'payos' },
    });
    assert.equal(t2.status, 200);
    assert.equal(t2.json.data.idempotent_replay, true);
    assert.equal(t2.json.data.transaction.id, t1.json.data.transaction.id);
    assert.equal(t2.json.data.transaction.reference_code, t1.json.data.transaction.reference_code);
    assert.ok(t1.json.data.transaction.reference_code.length >= 20);

    // 2. Webhook HMAC verification & idempotent settlement for manual_bank_transfer
    const prevWebhookSecret = process.env.BILLING_MANUAL_WEBHOOK_SECRET;
    process.env.BILLING_MANUAL_WEBHOOK_SECRET = 'test_manual_wh_secret_123456';
    try {
      const webhookPayload = JSON.stringify({
        external_tx_id: `ext_topup_${Date.now()}`,
        reference_code: t1.json.data.transaction.reference_code,
        amount_vnd: 10_000_000,
        status: 'succeeded',
      });
      const badWh = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/manual_bank_transfer', {
        method: 'POST',
        headers: { 'X-Webhook-Signature': '00000000000000000000000000000000' },
        body: JSON.parse(webhookPayload),
      });
      assert.equal(badWh.status, 401);

      const goodSig = crypto
        .createHmac('sha256', process.env.BILLING_MANUAL_WEBHOOK_SECRET)
        .update(webhookPayload)
        .digest('hex');
      const goodWh = await fetch(`${harness.baseUrl}/api/v1/billing/webhooks/manual_bank_transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': goodSig,
        },
        body: webhookPayload,
      });
      assert.equal(goodWh.status, 200);
      const whJson1: any = await goodWh.json();
      assert.equal(whJson1.data.idempotent_replay, false);
      assert.equal(whJson1.data.subscription.wallet_balance_vnd, 10_000_000);

      // Replay same webhook -> zero double-credit
      const replayWh = await fetch(`${harness.baseUrl}/api/v1/billing/webhooks/manual_bank_transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': goodSig,
        },
        body: webhookPayload,
      });
      assert.equal(replayWh.status, 200);
      const whJson2: any = await replayWh.json();
      assert.equal(whJson2.data.idempotent_replay, true);
    } finally {
      if (prevWebhookSecret === undefined) delete process.env.BILLING_MANUAL_WEBHOOK_SECRET;
      else process.env.BILLING_MANUAL_WEBHOOK_SECRET = prevWebhookSecret;
    }

    // 3. Subscribe to Standard monthly (1.5M) -> wallet = 8.5M
    const subStd = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subStd.status, 200);
    assert.equal(subStd.json.data.subscription.wallet_balance_vnd, 8_500_000);

    // 4. Mid-cycle upgrade to autodata_growth (3.0M) -> receives fair proration credit (>0, ~1.5M)
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        "UPDATE tenants SET subscription_expires_at = clock_timestamp() + INTERVAL '30 days' WHERE id = $1",
        [tenantA.id]
      );
    });
    const upgGrowth = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'growth_combo' },
    });
    assert.equal(upgGrowth.status, 200);
    assert.ok(upgGrowth.json.data.proration_credit_vnd > 1_000_000, 'Mid-cycle upgrade must grant proration credit');
    assert.ok(upgGrowth.json.data.amount_charged_vnd < 2_000_000, 'Charged amount must be net after proration');
    assert.equal(upgGrowth.json.data.package_code, 'growth_combo');

    // 5. Downgrade validation: create 6 rounds (exceeds Standard max_rounds=5) -> immediate downgrade returns 409, schedule_at_period_end succeeds!
    for (let i = 1; i <= 6; i++) {
      await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { name: `M1 Round ${i}` },
      });
    }
    const blockedDown = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'autodata_standard' },
    });
    assert.equal(blockedDown.status, 409);
    assert.equal(blockedDown.json.error?.code, 'DOWNGRADE_USAGE_EXCEEDED');

    const schedDown = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'autodata_standard', schedule_at_period_end: true },
    });
    assert.equal(schedDown.status, 200);
    assert.equal(schedDown.json.data.scheduled_downgrade, true);

    // 6. target_suite normalization ('domation_crm_erp' -> 'crm_erp_bundle')
    const upgReq = await apiRequest(harness.baseUrl, '/api/v1/billing/upgrade-request', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { target_suite: 'domation_crm_erp', billing_cycle: 'annual' },
    });
    assert.equal(upgReq.status, 201);
    assert.equal(upgReq.json.data.target_suite, 'crm_erp_bundle');

    // 7. Auto-renew toggle + Cancel at period end + Immediate Cancel + Grace/Suspended Reactivation
    const toggleOff = await apiRequest(harness.baseUrl, '/api/v1/billing/auto-renew', {
      method: 'PATCH',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { auto_renew: false },
    });
    assert.equal(toggleOff.status, 200);
    assert.equal(toggleOff.json.data.auto_renew, false);

    const cancelPeriodEnd = await apiRequest(harness.baseUrl, '/api/v1/billing/cancel', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { immediate: false, reason: 'Tạm nghỉ cuối kỳ' },
    });
    assert.equal(cancelPeriodEnd.status, 200);
    assert.equal(cancelPeriodEnd.json.data.subscription.cancel_at_period_end, true);
    assert.equal(cancelPeriodEnd.json.data.subscription.auto_renew, false);

    // Simulate expired subscription -> billing-manager moves cancel_at_period_end -> cancelled
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `UPDATE tenants
         SET trial_ends_at = clock_timestamp() - INTERVAL '2 days',
             subscription_expires_at = clock_timestamp() - INTERVAL '1 hour',
             wallet_balance_vnd = 50000000
         WHERE id = $1`,
        [tenantA.id]
      );
    });
    await runSubscriptionExpiryManager(tenantA.id);

    // Cancelled tenant is blocked on /api/v1/leads (403 TENANT_SUSPENDED) but ALLOWED on /api/v1/billing/renew to reactivate!
    const blockedLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(blockedLeads.status, 403);

    const reactivated = await apiRequest(harness.baseUrl, '/api/v1/billing/renew', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { plan_code: 'autodata_growth', billing_cycle: 'annual', payment_method: 'wallet' },
    });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.json.data.subscription.status, 'active');
    assert.equal(reactivated.json.data.subscription.billing_cycle, 'annual');
    assert.ok(reactivated.json.data.subscription.days_remaining >= 364);

    // Annual auto-renew in billing-manager extends 365 days
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `UPDATE tenants
         SET trial_ends_at = clock_timestamp() - INTERVAL '2 days',
             subscription_expires_at = clock_timestamp() - INTERVAL '1 hour',
             auto_renew = true,
             wallet_balance_vnd = 40000000
         WHERE id = $1`,
        [tenantA.id]
      );
    });
    await runSubscriptionExpiryManager(tenantA.id);
    const afterAutoAnnual = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(afterAutoAnnual.status, 200);
    assert.equal(afterAutoAnnual.json.data.status, 'active');
    assert.equal(afterAutoAnnual.json.data.billing_cycle, 'annual');
    assert.equal(afterAutoAnnual.json.data.billing_cycle, 'annual');
    assert.ok(afterAutoAnnual.json.data.subscription.days_remaining >= 364);

    // 8. Admin approval of pending bank-transfer upgrade unlocks package_code + enabled_modules & reactivates suspended -> active
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantA.id]);
    });
    const pendingAppRes = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { plan_code: 'domation_crm_erp', billing_cycle: 'monthly', payment_method: 'bank_transfer' },
    });
    assert.equal(pendingAppRes.status, 201);
    const pendingTxId = pendingAppRes.json.data.transaction.id;

    const adminApprove = await apiRequest(
      harness.baseUrl,
      `/api/v1/admin/billing/requests/${pendingTxId}/resolve`,
      {
        method: 'POST',
        token: platformToken,
        body: { decision: 'approve', resolution_note: 'Approved by M1 test' },
      }
    );
    assert.equal(adminApprove.status, 200);

    const afterAdminApprove = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(afterAdminApprove.status, 200);
    assert.equal(afterAdminApprove.json.data.status, 'active');
    assert.equal(afterAdminApprove.json.data.package_code, 'domation_promax');
    assert.ok(afterAdminApprove.json.data.enabled_modules.includes('hrm'));
  });

  it('M1.2d: Webhook guards (0/-100/NaN amount -> 422, terminal status -> 409, PayOS flat body HMAC)', async () => {
    const prevManualSecret = process.env.BILLING_MANUAL_WEBHOOK_SECRET;
    const prevPayosChecksum = process.env.PAYOS_CHECKSUM_KEY;
    process.env.BILLING_MANUAL_WEBHOOK_SECRET = 'm1_manual_guard_secret';
    process.env.PAYOS_CHECKSUM_KEY = 'm1_payos_checksum_key';
    try {
      // Create a 1,500,000 VND topup order
      const topupRes = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { amount_vnd: 1_500_000, provider: 'manual_bank_transfer' },
      });
      assert.equal(topupRes.status, 201);
      const refCode = topupRes.json.data.transaction.reference_code;
      const txId = topupRes.json.data.transaction.id;

      let walletBefore = 0;
      await withTenantTransaction(tenantA.id, async (client) => {
        const wRes = await client.query<{ wallet_balance_vnd: string }>(
          'SELECT wallet_balance_vnd FROM tenants WHERE id = $1',
          [tenantA.id]
        );
        walletBefore = Number(wRes.rows[0].wallet_balance_vnd || 0);
      });

      // Zero, negative, and non-numeric amounts must return 422 WEBHOOK_AMOUNT_MISMATCH
      for (const badAmount of [0, -100, 'not-a-number']) {
        const payload = JSON.stringify({
          external_tx_id: `ext_bad_${Date.now()}_${Math.random()}`,
          reference_code: refCode,
          amount_vnd: badAmount,
          status: 'succeeded',
        });
        const sig = crypto
          .createHmac('sha256', process.env.BILLING_MANUAL_WEBHOOK_SECRET!)
          .update(payload)
          .digest('hex');
        const wh = await fetch(`${harness.baseUrl}/api/v1/billing/webhooks/manual_bank_transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig },
          body: payload,
        });
        assert.equal(wh.status, 422, `Amount ${String(badAmount)} must fail with 422`);
        const whJson: any = await wh.json();
        assert.equal(whJson.error?.code, 'WEBHOOK_AMOUNT_MISMATCH');
      }

      // Terminal statuses ('rejected', 'cancelled') must return 409 BILLING_TX_TERMINAL_STATUS
      for (const termStatus of ['rejected', 'cancelled'] as const) {
        await withTenantTransaction(tenantA.id, async (client) => {
          await client.query(`UPDATE tenant_billing_transactions SET status = $2 WHERE id = $1`, [txId, termStatus]);
        });
        const payload = JSON.stringify({
          external_tx_id: `ext_term_${termStatus}_${Date.now()}`,
          reference_code: refCode,
          amount_vnd: 1_500_000,
          status: 'succeeded',
        });
        const sig = crypto
          .createHmac('sha256', process.env.BILLING_MANUAL_WEBHOOK_SECRET!)
          .update(payload)
          .digest('hex');
        const wh = await fetch(`${harness.baseUrl}/api/v1/billing/webhooks/manual_bank_transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig },
          body: payload,
        });
        assert.equal(wh.status, 409, `Terminal status ${termStatus} must return 409`);
        const whJson: any = await wh.json();
        assert.equal(whJson.error?.code, 'BILLING_TX_TERMINAL_STATUS');
      }

      await withTenantTransaction(tenantA.id, async (client) => {
        const wRes = await client.query<{ wallet_balance_vnd: string }>(
          'SELECT wallet_balance_vnd FROM tenants WHERE id = $1',
          [tenantA.id]
        );
        assert.equal(Number(wRes.rows[0].wallet_balance_vnd || 0), walletBefore);
      });

      // PayOS flat payload HMAC (excluding 'signature' key)
      const payosTopup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { amount_vnd: 1_500_000, provider: 'payos' },
      });
      assert.equal(payosTopup.status, 201);
      const payosRef = payosTopup.json.data.transaction.reference_code;
      const flatFields: Record<string, unknown> = {
        amount: 1_500_000,
        code: '00',
        description: payosRef,
        reference: `payos_flat_${Date.now()}`,
        success: true,
      };
      const canonical = Object.keys(flatFields)
        .sort()
        .map((k) => `${k}=${flatFields[k] ?? ''}`)
        .join('&');
      const payosSig = crypto
        .createHmac('sha256', process.env.PAYOS_CHECKSUM_KEY!)
        .update(canonical)
        .digest('hex');
      const payosRes = await apiRequest(harness.baseUrl, '/api/v1/billing/webhooks/payos', {
        method: 'POST',
        body: { ...flatFields, signature: payosSig },
      });
      assert.equal(payosRes.status, 200);
      assert.equal(payosRes.json.data.transaction.status, 'completed');
    } finally {
      if (prevManualSecret === undefined) delete process.env.BILLING_MANUAL_WEBHOOK_SECRET;
      else process.env.BILLING_MANUAL_WEBHOOK_SECRET = prevManualSecret;
      if (prevPayosChecksum === undefined) delete process.env.PAYOS_CHECKSUM_KEY;
      else process.env.PAYOS_CHECKSUM_KEY = prevPayosChecksum;
    }
  });

  it('M1.2e: Auth grace /refresh 200 + full lifecycle hydration across /bootstrap, /auth/me & /auth/login', async () => {
    const regGrace = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Grace Hydration Co',
        tenant_slug: 'm1-grace-hydration',
        admin_name: 'Grace Owner',
        work_email: 'owner@m1-grace.vn',
        phone: '0906111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regGrace.status, 201);
    const graceTenantId = regGrace.json.data.tenant.id;
    const graceSlug = regGrace.json.data.tenant.slug;
    const graceAccess = regGrace.json.data.access_token;
    const graceRefresh = regGrace.json.data.refresh_token;

    const graceEndsIso = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await withTenantTransaction(graceTenantId, async (client) => {
      await client.query(
        `UPDATE tenants
         SET status = 'grace',
             package_code = 'growth_combo',
             subscription_plan_code = 'autodata_growth',
             plan_tier = 'growth',
             auto_renew = false,
             cancel_at_period_end = true,
             grace_ends_at = $2::timestamptz,
             scheduled_plan_code = 'autodata_standard',
             scheduled_billing_cycle = 'monthly'
         WHERE id = $1`,
        [graceTenantId, graceEndsIso]
      );
    });
    tenantRedis.invalidateTenantCache(graceTenantId, graceSlug);

    const refreshRes = await apiRequest(harness.baseUrl, '/api/v1/auth/refresh', {
      method: 'POST',
      body: { refresh_token: graceRefresh },
    });
    assert.equal(refreshRes.status, 200, 'Grace tenant must be permitted to refresh session');
    assert.equal(refreshRes.json.data.tenant.subscription.status, 'grace');
    assert.equal(refreshRes.json.data.tenant.subscription.auto_renew, false);
    assert.equal(refreshRes.json.data.tenant.subscription.scheduled_plan_code, 'autodata_standard');

    const meRes = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: graceAccess,
      tenantSlug: graceSlug,
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.json.data.tenant.subscription.status, 'grace');
    assert.equal(meRes.json.data.tenant.subscription.auto_renew, false);
    assert.equal(meRes.json.data.tenant.subscription.cancel_at_period_end, true);
    assert.ok(meRes.json.data.tenant.subscription.grace_ends_at);
    assert.equal(meRes.json.data.tenant.subscription.scheduled_plan_code, 'autodata_standard');
    assert.equal(meRes.json.data.tenant.subscription.package_code, 'growth_combo');

    const bootRes = await apiRequest(harness.baseUrl, '/api/v1/workspace/bootstrap', {
      token: graceAccess,
      tenantSlug: graceSlug,
    });
    assert.equal(bootRes.status, 200);
    assert.equal(bootRes.json.data.tenant.subscription.status, 'grace');
    assert.equal(bootRes.json.data.tenant.subscription.auto_renew, false);
    assert.equal(bootRes.json.data.tenant.subscription.cancel_at_period_end, true);
    assert.ok(bootRes.json.data.tenant.subscription.grace_ends_at);
    assert.equal(bootRes.json.data.tenant.subscription.scheduled_plan_code, 'autodata_standard');
    assert.equal(bootRes.json.data.tenant.subscription.package_code, 'growth_combo');

    const loginRes = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'owner@m1-grace.vn',
        password: 'SecurePassword123!',
        tenant_slug: graceSlug,
      },
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.json.data.tenant.subscription.status, 'grace');
    assert.equal(loginRes.json.data.tenant.subscription.auto_renew, false);
    assert.equal(loginRes.json.data.tenant.subscription.scheduled_plan_code, 'autodata_standard');
  });

  it('M1.2f: Annual->Monthly excess proration credit, scheduled /renew after grace, vietqr/manual, idempotency replay, /api/autodata recovery & admin cache clear', async () => {
    const regEdge = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Billing Edge Co',
        tenant_slug: 'm1-billing-edge',
        admin_name: 'Edge Owner',
        work_email: 'owner@m1-edge.vn',
        phone: '0907111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regEdge.status, 201);
    const edgeTenantId = regEdge.json.data.tenant.id;
    const edgeSlug = regEdge.json.data.tenant.slug;
    const edgeToken = regEdge.json.data.access_token;

    // 1. Annual Standard (~360d remaining) -> Monthly Growth upgrade credits excess proration to wallet + ledger row
    await withTenantTransaction(edgeTenantId, async (client) => {
      await client.query(
        `UPDATE tenants
         SET status = 'active',
             package_code = 'autodata_crm',
             subscription_plan_code = 'autodata_standard',
             plan_tier = 'starter',
             billing_cycle = 'annual',
             wallet_balance_vnd = 0,
             trial_ends_at = clock_timestamp() - INTERVAL '10 days',
             subscription_expires_at = clock_timestamp() + INTERVAL '360 days'
         WHERE id = $1`,
        [edgeTenantId]
      );
    });
    tenantRedis.invalidateTenantCache(edgeTenantId, edgeSlug);

    const switchRes = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: edgeToken,
      tenantSlug: edgeSlug,
      body: { plan_code: 'autodata_growth', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(switchRes.status, 200);
    assert.ok(switchRes.json.data.excess_proration_credit_vnd > 10_000_000);
    assert.equal(
      switchRes.json.data.subscription.wallet_balance_vnd,
      switchRes.json.data.excess_proration_credit_vnd
    );
    assert.ok(switchRes.json.data.subscription.days_remaining <= 31);
    await withTenantTransaction(edgeTenantId, async (client) => {
      const credRes = await client.query<{ tx_type: string; amount_vnd: string }>(
        `SELECT tx_type, amount_vnd FROM tenant_billing_transactions
         WHERE tenant_id = $1 AND tx_type = 'proration_credit'`,
        [edgeTenantId]
      );
      assert.equal(credRes.rows.length, 1);
      assert.equal(Number(credRes.rows[0].amount_vnd), switchRes.json.data.excess_proration_credit_vnd);
    });

    // 2. Scheduled downgrade in grace -> /billing/renew (omitting plan_code) honors scheduled_plan_code
    await withTenantTransaction(edgeTenantId, async (client) => {
      await client.query(
        `UPDATE tenants
         SET status = 'grace',
             scheduled_plan_code = 'autodata_standard',
             scheduled_billing_cycle = 'monthly',
             subscription_expires_at = clock_timestamp() - INTERVAL '1 day',
             wallet_balance_vnd = 5_000_000
         WHERE id = $1`,
        [edgeTenantId]
      );
    });
    tenantRedis.invalidateTenantCache(edgeTenantId, edgeSlug);

    const renewSched = await apiRequest(harness.baseUrl, '/api/v1/billing/renew', {
      method: 'POST',
      token: edgeToken,
      tenantSlug: edgeSlug,
      body: { payment_method: 'wallet' },
    });
    assert.equal(renewSched.status, 200);
    assert.equal(renewSched.json.data.subscription.plan_code, 'autodata_standard');
    assert.equal(renewSched.json.data.subscription.scheduled_plan_code, null);
    assert.equal(renewSched.json.data.subscription.wallet_balance_vnd, 3_500_000);

    // 3. vietqr & manual payment_method create 201 pending orders without debiting wallet
    for (const pm of ['vietqr', 'manual']) {
      const pendRes = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
        method: 'POST',
        token: edgeToken,
        tenantSlug: edgeSlug,
        body: { plan_code: 'autodata_growth', billing_cycle: 'monthly', payment_method: pm },
      });
      assert.equal(pendRes.status, 201, `payment_method=${pm} must create pending order`);
      assert.equal(pendRes.json.data.requires_payment, true);
      assert.equal(pendRes.json.data.subscription.wallet_balance_vnd, 3_500_000);
    }

    // 4. Idempotency violation helper & concurrent X-Idempotency-Key replay (no 500)
    assert.equal(
      isIdempotencyUniqueViolation({ code: '23505', constraint: 'idx_billing_tx_tenant_idempotency' }),
      true
    );
    assert.equal(
      isIdempotencyUniqueViolation({ code: 'ER_DUP_ENTRY', errno: 1062, message: 'uk_billing_tx_tenant_idempotency' }),
      true
    );
    const raceKey = `race-topup-${Date.now()}`;
    const [r1, r2] = await Promise.all([
      apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
        method: 'POST',
        token: edgeToken,
        tenantSlug: edgeSlug,
        headers: { 'X-Idempotency-Key': raceKey },
        body: { amount_vnd: 2_000_000, provider: 'manual_bank_transfer' },
      }),
      apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
        method: 'POST',
        token: edgeToken,
        tenantSlug: edgeSlug,
        headers: { 'X-Idempotency-Key': raceKey },
        body: { amount_vnd: 2_000_000, provider: 'manual_bank_transfer' },
      }),
    ]);
    assert.ok([200, 201].includes(r1.status) && [200, 201].includes(r2.status));
    assert.equal(r1.json.data.transaction.id, r2.json.data.transaction.id);

    // 5. Suspended tenant calling /api/autodata?action=topup / renew / billing_overview succeeds (not 403 TENANT_SUSPENDED)
    await withTenantTransaction(edgeTenantId, async (client) => {
      await client.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [edgeTenantId]);
    });
    tenantRedis.invalidateTenantCache(edgeTenantId, edgeSlug);

    const autoTopup = await apiRequest(harness.baseUrl, '/api/autodata?action=topup', {
      method: 'POST',
      token: edgeToken,
      tenantSlug: edgeSlug,
      body: { amount_vnd: 1_500_000 },
    });
    assert.equal(autoTopup.status, 201);
    const autoOverview = await apiRequest(harness.baseUrl, '/api/autodata?action=billing_overview', {
      token: edgeToken,
      tenantSlug: edgeSlug,
    });
    assert.equal(autoOverview.status, 200);
    const autoRenew = await apiRequest(harness.baseUrl, '/api/autodata?action=renew', {
      method: 'POST',
      token: edgeToken,
      tenantSlug: edgeSlug,
      body: { payment_method: 'wallet' },
    });
    assert.equal(autoRenew.status, 200);

    // 6. Admin approval clears meta:tenant_status in tenantRedis
    await tenantRedis.set('meta:tenant_status', 'suspended', 60, edgeTenantId);
    assert.equal(await tenantRedis.get('meta:tenant_status', edgeTenantId), 'suspended');
    const adminApprove = await apiRequest(
      harness.baseUrl,
      `/api/v1/admin/billing/requests/${autoTopup.json.data.transaction.id}/resolve`,
      {
        method: 'POST',
        token: platformToken,
        body: { decision: 'approve', resolution_note: 'Approved edge topup' },
      }
    );
    assert.equal(adminApprove.status, 200);
    assert.equal(await tenantRedis.get('meta:tenant_status', edgeTenantId), null);
  });

  it('M1.3a: CAPI facebook_ads fallback live transport, live_http_enabled=false opt-out, capi-retry & unified firing', async () => {
    const regCapi = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 CAPI Co',
        tenant_slug: 'm1-capi-co',
        admin_name: 'CAPI Admin',
        work_email: 'admin@m1-capi.vn',
        phone: '0903111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regCapi.status, 201);
    const capiTenantId = regCapi.json.data.tenant.id;
    const capiSlug = regCapi.json.data.tenant.slug;
    const capiToken = regCapi.json.data.access_token;

    // Seed ONLY facebook_ads Vault (NO meta_capi row) with >30-char real token
    const fbEnc = encryptTenantSecret(capiTenantId, {
      pixel_id: '887766554433',
      access_token: 'EAA_live_facebook_ads_vault_token_1234567890',
    });
    let testLeadId = '';
    await withTenantTransaction(capiTenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
         VALUES ($1, 'facebook_ads', $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, status = 'active'`,
        [capiTenantId, fbEnc.configEncrypted, fbEnc.iv, fbEnc.authTag]
      );
      const lRes = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, status, name, phone, assigned_to, custom_fields)
         VALUES ($1, 'assigned', 'Lead CAPI Test', '0911222333', $2, '{}'::jsonb)
         RETURNING id`,
        [capiTenantId, regCapi.json.data.user.id]
      );
      testLeadId = lRes.rows[0].id;
    });
    tenantRedis.invalidateTenantIntegrations(capiTenantId, 'facebook_ads');

    const effectiveCfg = await resolveEffectiveMetaCapiConfig(capiTenantId);
    assert.equal(effectiveCfg.dataset_id, '887766554433');
    assert.equal(effectiveCfg.live_http_enabled, true);

    let liveCalls = 0;
    setCapiHttpTransportForTesting(async ({ datasetId, accessToken }) => {
      liveCalls += 1;
      assert.equal(datasetId, '887766554433');
      assert.equal(accessToken, 'EAA_live_facebook_ads_vault_token_1234567890');
      return { httpStatus: 200, body: { events_received: 1, fbtrace_id: 'fb_live_fallback_ok' } };
    });

    try {
      // Unified firing via legacy update_lead_quality with dual_capi_enabled=false
      const legacyUpd = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=update_lead_quality', {
        method: 'POST',
        token: capiToken,
        tenantSlug: capiSlug,
        body: { lead_id: testLeadId, quality_status: 'Qualified' },
      });
      assert.equal(legacyUpd.status, 200);
      assert.equal(legacyUpd.json.capi_dispatched?.event_name, 'Lead');
      assert.equal(liveCalls, 1);

      // Unified firing via PATCH /api/v1/leads/:id quality_status change
      const patchLead = await apiRequest(harness.baseUrl, `/api/v1/leads/${testLeadId}`, {
        method: 'PATCH',
        token: capiToken,
        tenantSlug: capiSlug,
        body: { quality_status: 'Closed' },
      });
      assert.equal(patchLead.status, 200);
      assert.equal(patchLead.json.capi_dispatched?.event_name, 'Purchase');
      assert.equal(liveCalls, 2);

      // Explicit live_http_enabled: false opt-out forces verified_sandbox (liveCalls must NOT increment)
      const optOutEnc = encryptTenantSecret(capiTenantId, {
        dataset_id: '887766554433',
        access_token: 'EAA_live_facebook_ads_vault_token_1234567890',
        live_http_enabled: false,
        secondary_dataset_id: '998877665544',
        secondary_access_token: 'EAA_secondary_token_1234567890123456',
      });
      await withTenantTransaction(capiTenantId, async (client) => {
        await client.query(
          `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
           VALUES ($1, 'meta_capi', $2, $3, $4, 'active')
           ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
             config_encrypted = EXCLUDED.config_encrypted, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, status = 'active'`,
          [capiTenantId, optOutEnc.configEncrypted, optOutEnc.iv, optOutEnc.authTag]
        );
      });
      tenantRedis.invalidateTenantIntegrations(capiTenantId, 'meta_capi');

      const sandboxRes = await dispatchStageCapiEventDetached({
        tenantId: capiTenantId,
        tenantSlug: capiSlug,
        eventName: 'Lead',
        lead: { leadId: testLeadId, name: 'Lead CAPI Test', phone: '0911222333' },
      });
      assert.equal(sandboxRes.status, 200);
      assert.equal(liveCalls, 2, 'live_http_enabled=false must stay in verified_sandbox');
    } finally {
      setCapiHttpTransportForTesting(null);
    }

    // capi-retry with facebook_ads fallback (delete meta_capi) + secondary_dataset_id matching
    await withTenantTransaction(capiTenantId, async (client) => {
      await client.query("DELETE FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'meta_capi'", [
        capiTenantId,
      ]);
      await client.query(
        `INSERT INTO capi_logs (tenant_id, lead_id, dataset_id, event_name, event_id, action_source, match_keys, sent_payload, response_status, sent_at)
         VALUES ($1, $2, '887766554433', 'CompleteRegistration', 'evt_retry_fb_fallback', 'system_generated', '{}'::jsonb, '{"data":[]}'::jsonb, 502, clock_timestamp() - INTERVAL '10 minutes')`,
        [capiTenantId, testLeadId]
      );
    });
    tenantRedis.invalidateTenantIntegrations(capiTenantId, 'meta_capi');

    let retriedUrls: string[] = [];
    setCapiRetryFetcherForTesting(async (url) => {
      retriedUrls.push(String(url));
      return { status: 200, json: async () => ({ events_received: 1, fbtrace_id: 'retry_fb_fallback_ok' }) } as any;
    });
    try {
      const retriedCount = await runMetaCapiRetryWorker(capiTenantId);
      assert.equal(retriedCount, 1);
      assert.ok(retriedUrls[0].includes('887766554433'));
    } finally {
      setCapiRetryFetcherForTesting(null);
    }
  });

  it('M1.3b: Gemini AI Gatekeeper (pass, hold, ai_lead_eval_enabled=false, timeout fallback)', async () => {
    const regAi = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 AI Gatekeeper Co',
        tenant_slug: 'm1-ai-gatekeeper',
        admin_name: 'AI Admin',
        work_email: 'admin@m1-ai.vn',
        phone: '0904111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regAi.status, 201);
    const aiTenantId = regAi.json.data.tenant.id;
    const aiSlug = regAi.json.data.tenant.slug;
    const aiToken = regAi.json.data.access_token;

    // Configure shared Gemini key + AI Gatekeeper mode='ai'
    const saveAi = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: aiToken,
      tenantSlug: aiSlug,
      body: {
        gemini_api_key: 'AIzaSyTestSharedKey1234567890',
        gemini_model: 'gemini-2.5-flash',
        ai_lead_eval_enabled: true,
        ai_screener_enabled: true,
        ai_screener_mode: 'ai',
        ai_screener_rules: 'Giữ lại lead test/spam',
      },
    });
    assert.equal(saveAi.status, 200);

    // 1. Gemini returns hold -> lead placed in held_leads
    setLeadAiScreenerFetcherForTesting(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ decision: 'hold', score: 15, reason: 'Số spam' }) }] } }],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12 },
      }),
    }) as any);

    const heldLead = await ingestAndDistributeLead(aiTenantId, {
      name: 'Spam Lead',
      phone: '0909111222',
      source: 'Facebook Ads',
    });
    assert.equal(heldLead.held, true);
    assert.equal(heldLead.dispatchReason, 'ai_gatekeeper_held');

    // 2. Gemini returns pass -> lead distributed with ai_screener_status='passed' & lead_score=91
    setLeadAiScreenerFetcherForTesting(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ decision: 'pass', score: 91, reason: 'Khách nét' }) }] } }],
        usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 18 },
      }),
    }) as any);

    const passedLead = await ingestAndDistributeLead(aiTenantId, {
      name: 'VIP Lead',
      phone: '0909333444',
      source: 'Facebook Ads',
    });
    assert.equal(Boolean(passedLead.held), false);
    await withTenantTransaction(aiTenantId, async (client) => {
      const r = await client.query<{ ai_screener_status: string; lead_score: number; ai_prompt_tokens: number }>(
        'SELECT ai_screener_status, lead_score, ai_prompt_tokens FROM leads WHERE tenant_id = $1 AND id = $2',
        [aiTenantId, passedLead.leadId]
      );
      assert.equal(r.rows[0].ai_screener_status, 'passed');
      assert.equal(r.rows[0].lead_score, 91);
      assert.equal(r.rows[0].ai_prompt_tokens, 55);
    });

    // 3. Gemini HTTP 500 -> deterministic fallback without throwing or stalling
    setLeadAiScreenerFetcherForTesting(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Upstream failure' }),
    }) as any);
    const fallbackLead = await ingestAndDistributeLead(aiTenantId, {
      name: 'Fallback Lead',
      phone: '0909555666',
      source: 'Facebook Ads',
    });
    assert.equal(Boolean(fallbackLead.held), false);
    await withTenantTransaction(aiTenantId, async (client) => {
      const r = await client.query<{ ai_screener_status: string }>(
        'SELECT ai_screener_status FROM leads WHERE tenant_id = $1 AND id = $2',
        [aiTenantId, fallbackLead.leadId]
      );
      assert.equal(r.rows[0].ai_screener_status, 'fallback_manual');
    });

    // 4. ai_lead_eval_enabled = false -> Gemini fetcher is NOT called at all
    let aiFetchCalls = 0;
    setLeadAiScreenerFetcherForTesting(async () => {
      aiFetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });
    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: aiToken,
      tenantSlug: aiSlug,
      body: {
        ai_lead_eval_enabled: false,
        ai_screener_enabled: true,
        ai_screener_mode: 'ai',
      },
    });
    const disabledEvalLead = await ingestAndDistributeLead(aiTenantId, {
      name: 'Eval Disabled Lead',
      phone: '0909777888',
      source: 'Facebook Ads',
    });
    assert.equal(Boolean(disabledEvalLead.held), false);
    assert.equal(aiFetchCalls, 0, 'Gemini fetcher must NOT be called when ai_lead_eval_enabled is false');
  });

  it('M1.3c: Gatekeeper preflight cache + invalidation, mode=ai manual_rules, saveSharedTenantAiConfig preservation & Promise.race timeout', async () => {
    const regGk = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Gatekeeper Cache Co',
        tenant_slug: 'm1-gk-cache',
        admin_name: 'GK Admin',
        work_email: 'admin@m1-gk.vn',
        phone: '0905111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regGk.status, 201);
    const gkTenantId = regGk.json.data.tenant.id;
    const gkSlug = regGk.json.data.tenant.slug;
    const gkToken = regGk.json.data.access_token;

    // 1. Fresh tenant: AI config setup creates ai_screener_configs row with is_enabled=true, mode='ai'
    const initAiCfg = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'PUT',
      token: gkToken,
      tenantSlug: gkSlug,
      body: { api_key: 'AIzaSyInitialSetupKey123456', ai_lead_eval_enabled: true },
    });
    assert.equal(initAiCfg.status, 200);
    await withTenantTransaction(gkTenantId, async (client) => {
      const r = await client.query<{ is_enabled: boolean; mode: string }>(
        'SELECT is_enabled, mode FROM ai_screener_configs WHERE tenant_id = $1',
        [gkTenantId]
      );
      assert.equal(r.rows[0]?.is_enabled, true);
      assert.equal(r.rows[0]?.mode, 'ai');
    });

    // Disable gatekeeper, ingest lead to warm negative/disabled cache, then test invalidations
    await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/config', {
      method: 'PUT',
      token: gkToken,
      tenantSlug: gkSlug,
      body: { mode: 'ai', is_enabled: false },
    });
    assert.equal(tenantRedis.getCachedGatekeeperPreflight(gkTenantId), null);
    await ingestAndDistributeLead(gkTenantId, { name: 'Warm Cache', phone: '0908111001', source: 'Web' });
    const warmed = tenantRedis.getCachedGatekeeperPreflight(gkTenantId);
    assert.ok(warmed && warmed.gk === null);

    // Seed fallback round + enable mode='ai' with manual_rules + fallback_enabled
    const fbRoundRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: gkToken,
      tenantSlug: gkSlug,
      body: { name: 'GK Fallback Round' },
    });
    assert.equal(fbRoundRes.status, 201);
    const fallbackRoundId = fbRoundRes.json.data.id;

    const putGk = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/config', {
      method: 'PUT',
      token: gkToken,
      tenantSlug: gkSlug,
      body: {
        mode: 'ai',
        is_enabled: true,
        manual_action: 'hold',
        manual_rules: [{ field: 'note', op: 'contains', val: 'MANUAL_BLOCK_TOKEN', reason: 'Blocked by manual rule' }],
        fallback_enabled: true,
        fallback_round_id: fallbackRoundId,
      },
    });
    assert.equal(putGk.status, 200);
    assert.equal(tenantRedis.getCachedGatekeeperPreflight(gkTenantId), null, 'PUT /gatekeeper/config must invalidate cache');

    let aiFetchCalls = 0;
    setLeadAiScreenerFetcherForTesting(async () => {
      aiFetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ decision: 'pass', score: 85, reason: 'OK' }) }] } }],
        }),
      } as any;
    });

    // mode='ai' + ai_lead_eval_enabled=true + matching manual_rule -> held WITHOUT calling Gemini
    const heldWithAiOn = await ingestAndDistributeLead(gkTenantId, {
      name: 'Blocked Manual Rule',
      phone: '0908111002',
      source: 'Web',
      note: 'Lead contains MANUAL_BLOCK_TOKEN here',
    });
    assert.equal(aiFetchCalls, 0);
    assert.equal(heldWithAiOn.held, true);
    assert.equal(heldWithAiOn.dispatchReason, 'ai_gatekeeper_held');

    // Toggle ai_lead_eval_enabled=false via /dom-meta/ai-config -> invalidates cache & preserves is_enabled=true
    await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'PUT',
      token: gkToken,
      tenantSlug: gkSlug,
      body: { ai_lead_eval_enabled: false },
    });
    assert.equal(tenantRedis.getCachedGatekeeperPreflight(gkTenantId), null, 'PUT /dom-meta/ai-config must invalidate cache');
    await withTenantTransaction(gkTenantId, async (client) => {
      const r = await client.query<{ is_enabled: boolean }>(
        'SELECT is_enabled FROM ai_screener_configs WHERE tenant_id = $1',
        [gkTenantId]
      );
      assert.equal(r.rows[0]?.is_enabled, true, 'is_enabled must be preserved when manual_rules/fallback_enabled exist');
    });

    // Lead matching manual_rules still held; clean lead routes to fallbackRoundId without calling Gemini
    const heldWithAiOff = await ingestAndDistributeLead(gkTenantId, {
      name: 'Blocked Manual Off',
      phone: '0908111003',
      source: 'Web',
      note: 'MANUAL_BLOCK_TOKEN',
    });
    assert.equal(aiFetchCalls, 0);
    assert.equal(heldWithAiOff.held, true);
    assert.equal(heldWithAiOff.dispatchReason, 'ai_gatekeeper_held');

    const cleanLead = await ingestAndDistributeLead(gkTenantId, {
      name: 'Clean Fallback Lead',
      phone: '0908111004',
      source: 'Web',
      note: 'Normal customer inquiry',
    });
    assert.equal(aiFetchCalls, 0);
    assert.equal(Boolean(cleanLead.held), false);
    assert.equal(cleanLead.roundId, fallbackRoundId);
    await withTenantTransaction(gkTenantId, async (client) => {
      const r = await client.query<{ ai_screener_status: string }>(
        'SELECT ai_screener_status FROM leads WHERE tenant_id = $1 AND id = $2',
        [gkTenantId, cleanLead.leadId]
      );
      assert.equal(r.rows[0]?.ai_screener_status, 'not_screened');
    });

    // Vault PUT /vault/ai_gemini_byok also invalidates gatekeeperPreflightCache
    assert.ok(tenantRedis.getCachedGatekeeperPreflight(gkTenantId));
    const vaultRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/ai_gemini_byok', {
      method: 'PUT',
      token: gkToken,
      tenantSlug: gkSlug,
      body: { api_key: 'AIzaSyRotatedVaultKey123456', model: 'gemini-2.5-flash' },
    });
    assert.equal(vaultRes.status, 200);
    assert.equal(tenantRedis.getCachedGatekeeperPreflight(gkTenantId), null, 'PUT /vault/ai_gemini_byok must invalidate cache');

    // Manual mode preservation when toggling ai_lead_eval_enabled=false
    await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/config', {
      method: 'PUT',
      token: gkToken,
      tenantSlug: gkSlug,
      body: { mode: 'manual', is_enabled: true, manual_rules: [], fallback_enabled: false },
    });
    await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'PUT',
      token: gkToken,
      tenantSlug: gkSlug,
      body: { ai_lead_eval_enabled: false },
    });
    await withTenantTransaction(gkTenantId, async (client) => {
      const r = await client.query<{ is_enabled: boolean; mode: string }>(
        'SELECT is_enabled, mode FROM ai_screener_configs WHERE tenant_id = $1',
        [gkTenantId]
      );
      assert.equal(r.rows[0]?.mode, 'manual');
      assert.equal(r.rows[0]?.is_enabled, true);
    });

    // Promise.race timeout with non-signal-aware fetcher
    setLeadAiScreenerFetcherForTesting(async () => new Promise(() => {}) as any);
    const t0 = Date.now();
    const timeoutRes = await evaluateLeadGatekeeperWithGemini({
      apiKey: 'AIzaTestTimeoutKey123456',
      lead: { name: 'Slow Fetcher' },
      timeoutMs: 250,
    });
    const elapsed = Date.now() - t0;
    assert.equal(timeoutRes.ok, false);
    if (!timeoutRes.ok) {
      assert.equal(timeoutRes.fallback, true);
      assert.match(timeoutRes.reason, /timed out/i);
    }
    assert.ok(elapsed < 1000, `Timeout took ${elapsed}ms, expected <1000ms`);
  });

  it('M1.4a: DistributionSnapshotCache & BlacklistCache deterministic invalidations on CRUD mutations', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Cache Inval Co',
        tenant_slug: 'm1-cache-inval',
        admin_name: 'Cache Admin',
        work_email: 'admin@m1-cache-inval.vn',
        phone: '0906111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const tId = reg.json.data.tenant.id;
    const tSlug = reg.json.data.tenant.slug;
    const tToken = reg.json.data.access_token;

    // 1. Warm DistributionSnapshotCache and BlacklistCache via ingestAndDistributeLead
    const warmLead = await ingestAndDistributeLead(tId, {
      name: 'Warm Lead',
      phone: '0906000001',
      source: 'Facebook Ads',
    });
    assert.equal(Boolean(warmLead.held), false);
    assert.ok(tenantRedis.getCachedDistributionSnapshot(tId), 'DistributionSnapshotCache must warm on first lead');
    assert.ok(tenantRedis.getCachedBlacklist(tId), 'BlacklistCache must warm on first lead');

    // 2. Blacklist POST & DELETE invalidate BlacklistCache immediately
    const blAdd = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/blacklist', {
      method: 'POST',
      token: tToken,
      tenantSlug: tSlug,
      body: { entry_type: 'phone', value: '84909888777', reason: 'Spam test' },
    });
    assert.equal(blAdd.status, 201);
    assert.equal(tenantRedis.getCachedBlacklist(tId), null, 'POST /gatekeeper/blacklist must invalidate BlacklistCache');

    const blockedLead = await ingestAndDistributeLead(tId, {
      name: 'Blocked Phone',
      phone: '0909888777',
      source: 'Web',
    });
    assert.equal(blockedLead.held, true);
    assert.equal(blockedLead.dispatchReason, 'blacklist_blocked');
    assert.ok(tenantRedis.getCachedBlacklist(tId));

    const blDel = await apiRequest(harness.baseUrl, `/api/v1/operations/gatekeeper/blacklist/${blAdd.json.data.id}`, {
      method: 'DELETE',
      token: tToken,
      tenantSlug: tSlug,
    });
    assert.equal(blDel.status, 200);
    assert.equal(tenantRedis.getCachedBlacklist(tId), null, 'DELETE /gatekeeper/blacklist/:id must invalidate BlacklistCache');

    const unblockedLead = await ingestAndDistributeLead(tId, {
      name: 'Unblocked Phone',
      phone: '0909888777',
      source: 'Web',
    });
    assert.equal(Boolean(unblockedLead.held), false);

    // 3. Pipelines/Rounds/RoutingRules/CustomFields/Stages mutations invalidate DistributionSnapshotCache
    const roundRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: tToken,
      tenantSlug: tSlug,
      body: { name: 'VIP Cache Round', consultant_ids: [reg.json.data.user.id] },
    });
    assert.equal(roundRes.status, 201);
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null, 'POST /rounds must invalidate DistributionSnapshotCache');
    const vipRoundId = roundRes.json.data.id;

    // Re-warm, then create routing rule -> immediately routes matching lead to vipRoundId
    await ingestAndDistributeLead(tId, { name: 'Rewarm 1', phone: '0906000002', source: 'Web' });
    assert.ok(tenantRedis.getCachedDistributionSnapshot(tId));

    const ruleRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/routing-rules', {
      method: 'POST',
      token: tToken,
      tenantSlug: tSlug,
      body: {
        round_id: vipRoundId,
        rule_name: 'VIP Source Rule',
        priority: 1,
        conditions_json: [{ field: 'source', op: 'equals', val: 'VIP_SOURCE' }],
      },
    });
    assert.equal(ruleRes.status, 201);
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null, 'POST /routing-rules must invalidate DistributionSnapshotCache');
    const ruleId = ruleRes.json.data.id;

    const routedVip = await ingestAndDistributeLead(tId, {
      name: 'VIP Customer',
      phone: '0906000003',
      source: 'VIP_SOURCE',
    });
    assert.equal(routedVip.roundId, vipRoundId);

    // PATCH & DELETE routing rule
    await apiRequest(harness.baseUrl, `/api/v1/pipelines/routing-rules/${ruleId}`, {
      method: 'PATCH',
      token: tToken,
      tenantSlug: tSlug,
      body: { rule_name: 'VIP Source Rule v2' },
    });
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null);
    await ingestAndDistributeLead(tId, { name: 'Rewarm 2', phone: '0906000004', source: 'Web' });

    await apiRequest(harness.baseUrl, `/api/v1/pipelines/routing-rules/${ruleId}`, {
      method: 'DELETE',
      token: tToken,
      tenantSlug: tSlug,
    });
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null);

    // Pipeline custom field POST + DELETE
    const pipesRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: tToken,
      tenantSlug: tSlug,
    });
    assert.equal(pipesRes.status, 200);
    const defaultPipe = pipesRes.json.data[0];
    assert.ok(defaultPipe?.id);

    await ingestAndDistributeLead(tId, { name: 'Rewarm 3', phone: '0906000005', source: 'Web' });
    const cfRes = await apiRequest(harness.baseUrl, `/api/v1/pipelines/${defaultPipe.id}/custom-fields`, {
      method: 'POST',
      token: tToken,
      tenantSlug: tSlug,
      body: { field_key: 'req_code', field_label: 'Required Code', field_type: 'text', is_required: true },
    });
    assert.equal(cfRes.status, 201);
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null);

    await assert.rejects(
      () => ingestAndDistributeLead(tId, { name: 'Missing CF', phone: '0906000006', source: 'Web' }),
      /CUSTOM_FIELD_REQUIRED/
    );

    await apiRequest(harness.baseUrl, `/api/v1/pipelines/${defaultPipe.id}/custom-fields/${cfRes.json.data.id}`, {
      method: 'DELETE',
      token: tToken,
      tenantSlug: tSlug,
    });
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null);

    const afterCfDel = await ingestAndDistributeLead(tId, { name: 'CF Deleted OK', phone: '0906000007', source: 'Web' });
    assert.ok(afterCfDel.leadId);

    // Stages reorder invalidates snapshot
    const reorderRes = await apiRequest(harness.baseUrl, `/api/v1/pipelines/${defaultPipe.id}/stages/reorder`, {
      method: 'PUT',
      token: tToken,
      tenantSlug: tSlug,
      body: { stages: defaultPipe.stages },
    });
    assert.equal(reorderRes.status, 200);
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null);

    // Legacy add_rule invalidates snapshot
    await ingestAndDistributeLead(tId, { name: 'Rewarm 4', phone: '0906000008', source: 'Web' });
    assert.ok(tenantRedis.getCachedDistributionSnapshot(tId));
    const legacyRule = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=add_rule', {
      method: 'POST',
      token: tToken,
      tenantSlug: tSlug,
      body: { round_id: vipRoundId, rule_name: 'Legacy Rule', conditions: [] },
    });
    assert.equal(legacyRule.status, 200);
    assert.equal(tenantRedis.getCachedDistributionSnapshot(tId), null);
  });

  it('M1.4b: monthlyLeadCountCache exact COUNT(*) near quota / quota<=200, PLAN_QUOTA_EXCEEDED without overshoot & no increment on held/duplicate-updated leads', async () => {
    const regQ = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Quota Cache Co',
        tenant_slug: 'm1-quota-cache',
        admin_name: 'Quota Admin',
        work_email: 'admin@m1-quota-cache.vn',
        phone: '0907111222',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regQ.status, 201);
    const qTenantId = regQ.json.data.tenant.id;
    const qSlug = regQ.json.data.tenant.slug;
    const qToken = regQ.json.data.access_token;
    const monthKey = getUtcMonthKey();

    try {
      // Case 1: quota <= 200 (minimum catalog quota = 100) -> exact DB COUNT(*), no overshoot, no increment on held/update_existing
      const baseCatRes = await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
        method: 'PATCH',
        token: platformToken,
        body: { reset_to_factory: true },
      });
      assert.equal(baseCatRes.status, 200);
      const basePlans = baseCatRes.json.data.catalog.plans;
      const patchQuota100 = await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
        method: 'PATCH',
        token: platformToken,
        body: {
          catalog: {
            plans: basePlans.map((p: any, idx: number) => (idx === 0 ? { ...p, monthly_lead_quota: 100 } : p)),
          },
        },
      });
      assert.equal(patchQuota100.status, 200);
      assert.equal(patchQuota100.json.data.catalog.plans[0].monthly_lead_quota, 100);

      // Seed 95 existing leads for this month so we exercise exact boundary at 100
      await withTenantTransaction(qTenantId, async (client) => {
        for (let i = 1; i <= 95; i++) {
          await client.query(
            `INSERT INTO leads (tenant_id, status, name, phone, custom_fields)
             VALUES ($1, 'unassigned_pending', $2, $3, '{}'::jsonb)`,
            [qTenantId, `Seed Lead ${i}`, `8490710${String(i).padStart(4, '0')}`]
          );
        }
      });
      tenantRedis.invalidateTenantMonthlyLeadCount(qTenantId);

      // Verify enforceTenantOperationalPolicy runs exact COUNT(*) when quota <= 200 even if cache is warm
      await withTenantTransaction(qTenantId, async (client) => {
        let cntQueries = 0;
        const spyClient = {
          ...client,
          query: async (sql: string, params?: any[]) => {
            if (/SELECT\s+COUNT\(\*\)::int\s+AS\s+cnt\s+FROM\s+leads/i.test(sql)) cntQueries += 1;
            return client.query(sql, params);
          },
        };
        await enforceTenantOperationalPolicy(spyClient as any, qTenantId, 'ingest_lead');
        await enforceTenantOperationalPolicy(spyClient as any, qTenantId, 'ingest_lead');
        assert.equal(cntQueries, 2, 'When quota <= 200, every ingest_lead check must run exact DB COUNT(*)');
      });

      // Add blacklist phone and enable duplicate_action='update_existing'
      await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/blacklist', {
        method: 'POST',
        token: qToken,
        tenantSlug: qSlug,
        body: { entry_type: 'phone', value: '84907000099', reason: 'Held quota check' },
      });
      await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
        method: 'POST',
        token: qToken,
        tenantSlug: qSlug,
        body: { duplicate_action: 'update_existing', duplicate_threshold_days: 90 },
      });

      // Held lead must NOT increment monthlyLeadCountCache
      const heldRes = await ingestAndDistributeLead(qTenantId, {
        name: 'Held Lead',
        phone: '0907000099',
        source: 'Web',
      });
      assert.equal(heldRes.held, true);
      assert.equal(tenantRedis.getCachedTenantMonthlyLeadCount(qTenantId, monthKey), 95);

      // Lead #96 inserted
      const l1 = await ingestAndDistributeLead(qTenantId, {
        name: 'Lead 96',
        phone: '0907000001',
        source: 'Web',
      });
      assert.equal(Boolean(l1.held), false);
      assert.equal(tenantRedis.getCachedTenantMonthlyLeadCount(qTenantId, monthKey), 96);

      // Duplicate update_existing must NOT increment monthlyLeadCountCache
      const l1Dup = await ingestAndDistributeLead(qTenantId, {
        name: 'Lead 96 Updated',
        phone: '0907000001',
        source: 'Web',
      });
      assert.equal(l1Dup.dispatchReason, 'duplicate_updated_existing');
      assert.equal(tenantRedis.getCachedTenantMonthlyLeadCount(qTenantId, monthKey), 96);

      // Insert leads #97..#100 (reaching exact quota = 100)
      for (const p of ['0907000002', '0907000003', '0907000004', '0907000005']) {
        await ingestAndDistributeLead(qTenantId, { name: `Lead ${p}`, phone: p, source: 'Web' });
      }
      assert.equal(tenantRedis.getCachedTenantMonthlyLeadCount(qTenantId, monthKey), 100);

      // Lead #101 must throw PLAN_QUOTA_EXCEEDED without overshoot
      await assert.rejects(
        () => ingestAndDistributeLead(qTenantId, { name: 'Lead Over', phone: '0907000006', source: 'Web' }),
        /PLAN_QUOTA_EXCEEDED/
      );

      // Case 2: quota = 1000 -> fastSkipCeiling = 1000 - max(200, 100) = 800
      await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
        method: 'PATCH',
        token: platformToken,
        body: {
          catalog: {
            plans: basePlans.map((p: any, idx: number) => (idx === 0 ? { ...p, monthly_lead_quota: 1000 } : p)),
          },
        },
      });
      assert.equal(
        tenantRedis.getCachedTenantMonthlyLeadCount(qTenantId, monthKey),
        null,
        'invalidateBillingCatalogCache must clear monthlyLeadCountCache'
      );

      await withTenantTransaction(qTenantId, async (client) => {
        let countQueries = 0;
        let tenantPolicyQueries = 0;
        const wrappedClient = {
          ...client,
          query: async (sql: string, params?: any[]) => {
            if (/SELECT\s+COUNT\(\*\)::int\s+AS\s+cnt\s+FROM\s+leads/i.test(sql)) {
              countQueries += 1;
            }
            if (/FROM\s+tenants\s+WHERE\s+id\s*=\s*\$1/i.test(sql)) {
              tenantPolicyQueries += 1;
            }
            return client.query(sql, params);
          },
        };

        // Cold call seeds cache with exact COUNT(*) = 100
        await enforceTenantOperationalPolicy(wrappedClient as any, qTenantId, 'ingest_lead');
        assert.equal(countQueries, 1);
        assert.equal(tenantPolicyQueries, 0, 'tenantBillingPolicyCache is already warm for qTenantId');

        // Below fastSkipCeiling (< 800): skips SELECT COUNT(*)
        tenantRedis.setCachedTenantMonthlyLeadCount(qTenantId, monthKey, 799);
        await enforceTenantOperationalPolicy(wrappedClient as any, qTenantId, 'ingest_lead');
        assert.equal(countQueries, 1, 'Must skip COUNT(*) when cachedCount < fastSkipCeiling (799 < 800)');

        // At or above fastSkipCeiling (>= 800): MUST execute exact DB COUNT(*)
        tenantRedis.setCachedTenantMonthlyLeadCount(qTenantId, monthKey, 800);
        await enforceTenantOperationalPolicy(wrappedClient as any, qTenantId, 'ingest_lead');
        assert.equal(countQueries, 2, 'Must execute exact COUNT(*) when cachedCount >= fastSkipCeiling (800 >= 800)');
      });
    } finally {
      await apiRequest(harness.baseUrl, '/api/v1/admin/billing-catalog', {
        method: 'PATCH',
        token: platformToken,
        body: { reset_to_factory: true },
      });
    }
  });
});
