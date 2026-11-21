import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { setDatabasePool, MariaDbPoolAdapter } from '../server/core/database/db-adapter.ts';
import { translatePostgresSqlToMariaDb } from '../server/core/database/sql-translator.ts';
import { compileSegmentWhereSql } from '../server/modules/audiences/segment-compiler.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { encryptTenantSecret } from '../server/core/crypto/vault.ts';
import { verifyWebhookSignature } from '../server/services/payment-gateway.service.ts';
import { drainUnassignedLeads } from '../server/services/distribution.service.ts';
import {
  MAX_CAPI_RETRIES,
  runMetaCapiRetryWorker,
  setCapiRetryFetcherForTesting,
} from '../server/cron/subroutines/capi-retry.ts';
import {
  sendRawSmtpMail,
  sendTenantEmailNotification,
  setEmailWebhookFetcherForTesting,
} from '../server/services/zalo-mail.service.ts';
import {
  sendTelegramNotification,
  setTelegramTransportForTesting,
} from '../server/services/telegram.service.ts';

describe('Tier 5: White-Box Adversarial Regression & Hardening Suite', () => {
  let harness: TestHarness;
  let platformToken = '';
  let prevSilentMode: string | undefined;
  let prevTelegramSilent: string | undefined;
  let prevTelegramEnabled: string | undefined;

  before(async () => {
    prevSilentMode = process.env.OUTBOUND_SILENT_MODE;
    prevTelegramSilent = process.env.TELEGRAM_SILENT_MODE;
    prevTelegramEnabled = process.env.TELEGRAM_NOTIFY_ENABLED;
    process.env.OUTBOUND_SILENT_MODE = 'true';

    harness = await startTestServer();
    const adminLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: { email: 'ops-admin@autodata.vn', password: 'SuperAdminMasterPassword999!' },
    });
    assert.equal(adminLogin.status, 200);
    platformToken = adminLogin.json.data.access_token;
  });

  after(async () => {
    setCapiRetryFetcherForTesting(null);
    setEmailWebhookFetcherForTesting(null);
    setTelegramTransportForTesting(null);
    if (prevSilentMode === undefined) delete process.env.OUTBOUND_SILENT_MODE;
    else process.env.OUTBOUND_SILENT_MODE = prevSilentMode;
    if (prevTelegramSilent === undefined) delete process.env.TELEGRAM_SILENT_MODE;
    else process.env.TELEGRAM_SILENT_MODE = prevTelegramSilent;
    if (prevTelegramEnabled === undefined) delete process.env.TELEGRAM_NOTIFY_ENABLED;
    else process.env.TELEGRAM_NOTIFY_ENABLED = prevTelegramEnabled;
    await harness.close();
  });

  beforeEach(() => {
    setCapiRetryFetcherForTesting(null);
    setEmailWebhookFetcherForTesting(null);
    setTelegramTransportForTesting(null);
  });

  it('T5.1: Billing idempotency payload mismatch & cross-endpoint collision return 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'T5 Idem Co',
        tenant_slug: 't5-idem-co',
        admin_name: 'T5 Admin',
        work_email: 'admin@t5-idem.vn',
        phone: '0905100101',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const token = reg.json.data.access_token;
    const slug = reg.json.data.tenant.slug;

    const k1 = `t5-idem-k1-${Date.now()}`;
    const topup1 = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token,
      tenantSlug: slug,
      headers: { 'X-Idempotency-Key': k1 },
      body: { amount_vnd: 1_500_000 },
    });
    assert.equal(topup1.status, 201);

    // Exact replay succeeds with 200 idempotent_replay=true
    const topupReplay = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token,
      tenantSlug: slug,
      headers: { 'X-Idempotency-Key': k1 },
      body: { amount_vnd: 1_500_000 },
    });
    assert.equal(topupReplay.status, 200);
    assert.equal(topupReplay.json.data.idempotent_replay, true);
    assert.equal(topupReplay.json.data.transaction.id, topup1.json.data.transaction.id);

    // Same key with mismatched topup amount -> 409 IDEMPOTENCY_KEY_MISMATCH
    const topupMismatch = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token,
      tenantSlug: slug,
      headers: { 'X-Idempotency-Key': k1 },
      body: { amount_vnd: 9_000_000 },
    });
    assert.equal(topupMismatch.status, 409);
    assert.equal(topupMismatch.json.error?.code, 'IDEMPOTENCY_KEY_MISMATCH');

    // Reusing topup key on /subscribe -> 409 IDEMPOTENCY_KEY_MISMATCH
    const crossEndpoint = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token,
      tenantSlug: slug,
      headers: { 'X-Idempotency-Key': k1 },
      body: { plan_code: 'autodata_growth', billing_cycle: 'monthly', payment_method: 'bank_transfer' },
    });
    assert.equal(crossEndpoint.status, 409);
    assert.equal(crossEndpoint.json.error?.code, 'IDEMPOTENCY_KEY_MISMATCH');

    // Subscribe key scoped by plan_code & billing_cycle
    const k2 = `t5-idem-k2-${Date.now()}`;
    const sub1 = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token,
      tenantSlug: slug,
      headers: { 'X-Idempotency-Key': k2 },
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'bank_transfer' },
    });
    assert.equal(sub1.status, 201);

    const subReplay = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token,
      tenantSlug: slug,
      headers: { 'X-Idempotency-Key': k2 },
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'bank_transfer' },
    });
    assert.equal(subReplay.status, 200);
    assert.equal(subReplay.json.data.idempotent_replay, true);

    const subMismatch = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token,
      tenantSlug: slug,
      headers: { 'X-Idempotency-Key': k2 },
      body: { plan_code: 'autodata_growth', billing_cycle: 'monthly', payment_method: 'bank_transfer' },
    });
    assert.equal(subMismatch.status, 409);
    assert.equal(subMismatch.json.error?.code, 'IDEMPOTENCY_KEY_MISMATCH');
  });

  it('T5.2: Stripe multi-v1 rotation header & terminal failed webhook immutability (409 BILLING_TX_TERMINAL_STATUS)', async () => {
    const prevStripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const prevManualSecret = process.env.BILLING_MANUAL_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_t5_rotation_secret_123';
    process.env.BILLING_MANUAL_WEBHOOK_SECRET = 'manual_t5_terminal_secret_123';

    try {
      const ts = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
      const validV1 = crypto
        .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
        .update(`${ts}.${rawBody}`)
        .digest('hex');
      const staleV1 = 'a'.repeat(64);

      const validFirst = verifyWebhookSignature('stripe', {
        headers: { 'stripe-signature': `t=${ts},v1=${validV1},v1=${staleV1}` },
        rawBody,
        body: JSON.parse(rawBody),
      });
      assert.equal(validFirst.ok, true);

      const validSecond = verifyWebhookSignature('stripe', {
        headers: { 'stripe-signature': `t=${ts},v1=${staleV1},v1=${validV1}` },
        rawBody,
        body: JSON.parse(rawBody),
      });
      assert.equal(validSecond.ok, true);

      const invalidOnly = verifyWebhookSignature('stripe', {
        headers: { 'stripe-signature': `t=${ts},v1=${staleV1},v1=${'b'.repeat(64)}` },
        rawBody,
        body: JSON.parse(rawBody),
      });
      assert.equal(invalidOnly.ok, false);
      if (!invalidOnly.ok) {
        assert.equal(invalidOnly.code, 'INVALID_WEBHOOK_SIGNATURE');
      }

      // Terminal 'failed' immutability via underpaid webhook followed by valid-amount webhook
      const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
        method: 'POST',
        body: {
          company_name: 'T5 Failed Webhook Co',
          tenant_slug: 't5-failed-wh',
          admin_name: 'T5 WH Admin',
          work_email: 'admin@t5-failed-wh.vn',
          phone: '0905100102',
          password: 'SecurePassword123!',
          industry: 'general',
          seed_demo_leads: false,
        },
      });
      assert.equal(reg.status, 201);
      const token = reg.json.data.access_token;
      const slug = reg.json.data.tenant.slug;

      const topup = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
        method: 'POST',
        token,
        tenantSlug: slug,
        body: { amount_vnd: 1_500_000, provider: 'manual_bank_transfer' },
      });
      assert.equal(topup.status, 201);
      const refCode = topup.json.data.transaction.reference_code;

      const sendManualWh = async (payloadObj: Record<string, unknown>) => {
        const raw = JSON.stringify(payloadObj);
        const sig = crypto
          .createHmac('sha256', process.env.BILLING_MANUAL_WEBHOOK_SECRET!)
          .update(raw)
          .digest('hex');
        const resp = await fetch(`${harness.baseUrl}/api/v1/billing/webhooks/manual_bank_transfer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig },
          body: raw,
        });
        return { status: resp.status, json: (await resp.json()) as any };
      };

      const underpaid = await sendManualWh({
        external_tx_id: `ext_underpaid_${Date.now()}`,
        reference_code: refCode,
        amount_vnd: 500_000,
        status: 'succeeded',
      });
      assert.equal(underpaid.status, 422);
      assert.equal(underpaid.json.error?.code, 'WEBHOOK_AMOUNT_MISMATCH');

      // Retry with full valid amount & new external_tx_id -> MUST return 409 BILLING_TX_TERMINAL_STATUS
      const resettled = await sendManualWh({
        external_tx_id: `ext_retry_after_fail_${Date.now()}`,
        reference_code: refCode,
        amount_vnd: 1_500_000,
        status: 'succeeded',
      });
      assert.equal(resettled.status, 409);
      assert.equal(resettled.json.error?.code, 'BILLING_TX_TERMINAL_STATUS');

      const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', { token, tenantSlug: slug });
      assert.equal(ov.status, 200);
      assert.equal(ov.json.data.subscription.wallet_balance_vnd, 0);
    } finally {
      if (prevStripeSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = prevStripeSecret;
      if (prevManualSecret === undefined) delete process.env.BILLING_MANUAL_WEBHOOK_SECRET;
      else process.env.BILLING_MANUAL_WEBHOOK_SECRET = prevManualSecret;
    }
  });

  it('T5.3: Downgrade with explicit annual purchase never mutates billing_cycle=annual for 0₫ / months_added=0', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'T5 Downgrade Annual Co',
        tenant_slug: 't5-downgrade-annual',
        admin_name: 'T5 Down Admin',
        work_email: 'admin@t5-down-annual.vn',
        phone: '0905100103',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const tenantId = reg.json.data.tenant.id;
    const token = reg.json.data.access_token;
    const slug = reg.json.data.tenant.slug;

    // Activate paid autodata_growth monthly
    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 3_000_000, extend_months: 0 },
    });
    const subGrowth = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: { plan_code: 'autodata_growth', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subGrowth.status, 200);
    assert.equal(subGrowth.json.data.subscription.billing_cycle, 'monthly');

    // Attempt wallet downgrade to autodata_standard with explicit annual 12m (wallet=0 -> must return 402, NOT 200 0₫ annual)
    const walletDown = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: { plan_code: 'autodata_standard', billing_cycle: 'annual', months: 12, payment_method: 'wallet' },
    });
    assert.equal(walletDown.status, 402);
    assert.equal(walletDown.json.error?.code, 'INSUFFICIENT_WALLET_BALANCE');

    // Bank-transfer downgrade with explicit annual 12m creates pending order with amount_vnd > 0 & months_added = 12
    const bankDown = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: {
        plan_code: 'autodata_standard',
        billing_cycle: 'annual',
        months: 12,
        payment_method: 'bank_transfer',
      },
    });
    assert.equal(bankDown.status, 201);
    assert.equal(bankDown.json.data.requires_payment, true);
    assert.ok(bankDown.json.data.transaction.amount_vnd > 0);
    assert.equal(bankDown.json.data.transaction.months_added, 12);

    const ov = await apiRequest(harness.baseUrl, '/api/v1/billing/overview', { token, tenantSlug: slug });
    assert.equal(ov.json.data.subscription.plan_code, 'autodata_growth');
    assert.equal(ov.json.data.subscription.billing_cycle, 'monthly');
  });

  it('T5.4: MariaDB SQL translation eliminates unnest/ILIKE/clock_timestamp/::jsonb & runs drainUnassignedLeads cleanly', async () => {
    const sampleQueries = [
      `INSERT INTO lead_timeline_events (tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata)
       VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9::jsonb), ($1, $11, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      `SELECT c.id FROM capi_logs c
       WHERE c.response_status IN (429, 500, 502, 503, 504)
         AND c.sent_at >= clock_timestamp() - INTERVAL '24 hours'
         AND c.sent_at <= clock_timestamp() - INTERVAL '3 minutes'
         AND COALESCE(c.retry_count, 0) < 5
         AND COALESCE(c.action_source, '') <> 'system_cron_retry'`,
      `UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
      `SELECT id FROM leads WHERE tenant_id = $1 AND name ILIKE $2`,
      `SELECT DISTINCT i.tenant_id FROM tenant_integrations i INNER JOIN tenants t ON t.id = i.tenant_id WHERE i.token_expires_at <= clock_timestamp() + make_interval(hours => GREATEST(1, LEAST(48, COALESCE((t.settings->>'zalo_token_refresh_window_hours')::int, 4))))`,
      `SELECT ad_id FROM meta_ads_insights WHERE tenant_id = $1 AND ad_id = $2 ORDER BY date_start DESC NULLS LAST LIMIT 1`,
      `SELECT r.id FROM tenant_approval_requests r LEFT JOIN tenant_approval_step_logs sl ON sl.request_id = r.id WHERE r.tenant_id = $1 ORDER BY sl.due_at ASC NULLS LAST, r.created_at ASC LIMIT 15`,
    ];
    for (const q of sampleQueries) {
      const tr = translatePostgresSqlToMariaDb(q, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '{}', 'id1', 'id2']);
      assert.ok(!/\bunnest\s*\(/i.test(tr.sql), `Residual unnest() in: ${tr.sql}`);
      assert.ok(!/\bILIKE\b/i.test(tr.sql), `Residual ILIKE in: ${tr.sql}`);
      assert.ok(!/\bclock_timestamp\s*\(/i.test(tr.sql), `Residual clock_timestamp() in: ${tr.sql}`);
      assert.ok(!/::jsonb\b/i.test(tr.sql), `Residual ::jsonb in: ${tr.sql}`);
      assert.ok(!/\bmake_interval\s*\(/i.test(tr.sql), `Residual make_interval() in: ${tr.sql}`);
      assert.ok(!/\bNULLS\s+(?:FIRST|LAST)\b/i.test(tr.sql), `Residual NULLS FIRST/LAST in: ${tr.sql}`);
      assert.ok(!/JSON_EXTRACT\([^)]*\b(?:HOUR|DAY|MINUTE)\b/i.test(tr.sql), `Corrupted make_interval in: ${tr.sql}`);
    }

    // Verify nested make_interval produces valid balanced MariaDB INTERVAL ... HOUR
    const zaloTr = translatePostgresSqlToMariaDb(sampleQueries[4], []);
    assert.ok(
      zaloTr.sql.includes(
        "INTERVAL GREATEST(1, LEAST(48, COALESCE((JSON_UNQUOTE(JSON_EXTRACT(t.settings, '$.zalo_token_refresh_window_hours'))), 4))) HOUR"
      ),
      `Unexpected nested make_interval translation: ${zaloTr.sql}`
    );

    // Verify segment-compiler MariaDB date cast, MM-DD birthday matching & portable [.] decimal regex
    const segCreated = compileSegmentWhereSql('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [
      { field: 'created_at', op: 'equals', value: '2026-11-20' },
    ]);
    const segCreatedMaria = translatePostgresSqlToMariaDb(`SELECT l.id FROM leads l WHERE ${segCreated.whereClause}`, segCreated.params);
    assert.ok(
      /CAST\(l\.created_at AS DATE\)\s*=\s*CAST\(\? AS DATE\)/i.test(segCreatedMaria.sql),
      `Expected portable CAST(... AS DATE) for MariaDB parity, got: ${segCreatedMaria.sql}`
    );

    const segBday = compileSegmentWhereSql('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [
      { field: 'birthday', op: 'equals', value: '05-12' },
    ]);
    assert.ok(!segBday.whereClause.includes('1 = 0'), `MM-DD birthday rule must not compile to 1 = 0: ${segBday.whereClause}`);
    assert.ok(segBday.whereClause.includes('SUBSTRING(') && segBday.params.includes('05-12'));

    const segCfNum = compileSegmentWhereSql('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [
      { field: 'cf.budget_vnd', op: 'gte', value: 1000 },
    ]);
    assert.ok(segCfNum.whereClause.includes('([.][0-9]+)?$'), `Expected portable [.] regex in: ${segCfNum.whereClause}`);
    assert.ok(!segCfNum.whereClause.includes('(\\.[0-9]+)?$'), `Avoid backslash-dot in MariaDB regex: ${segCfNum.whereClause}`);

    // Execute drainUnassignedLeads end-to-end against a mock MariaDB pool adapter
    const executedSql: Array<{ sql: string; params?: any[] }> = [];
    const mockRawConn = { id: 't5-mariadb-conn' };
    const mockMariaPool: any = {
      async getConnection() {
        return {
          connection: mockRawConn,
          async query(sql: string, params?: any[]) {
            executedSql.push({ sql, params });
            if (/SELECT\s+l\.id/i.test(sql)) {
              return [
                [
                  { id: '11111111-1111-4111-8111-111111111111', stage_id: 'stage-1', sla_timeout_minutes: 0 },
                  { id: '22222222-2222-4222-8222-222222222222', stage_id: 'stage-1', sla_timeout_minutes: 0 },
                ],
                [],
              ];
            }
            return [[], []];
          },
          release() {},
        };
      },
      async end() {},
    };

    const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    tenantRedis.setCachedTenantMeta(tenantId, {
      slug: 't5-mariadb-drain',
      name: 'MariaDB Drain Test',
      status: 'active',
      rawSettings: { auto_drain_on_online: true, queue_drain_batch_limit: 20 },
    });

    const mariaAdapter = new MariaDbPoolAdapter({ pool: mockMariaPool });
    setDatabasePool({
      dialect: 'mariadb',
      isEmbedded: false,
      connect: () => mariaAdapter.connect(),
      close: () => mariaAdapter.close(),
    });
    try {
      const drained = await drainUnassignedLeads(tenantId, '33333333-3333-4333-8333-333333333333', 'Sale Maria');
      assert.equal(drained, 2);
      const timelineInsert = executedSql.find((q) => /INSERT INTO lead_timeline_events/i.test(q.sql));
      assert.ok(timelineInsert, 'Expected lead_timeline_events bulk insert on MariaDB');
      assert.ok(!/\bunnest\s*\(/i.test(timelineInsert.sql), `MariaDB SQL must not contain unnest(): ${timelineInsert.sql}`);
      assert.ok(/VALUES\s*\([^)]+\)\s*,\s*\([^)]+\)/i.test(timelineInsert.sql), 'Expected multi-row VALUES (...), (...)');
      assert.ok(!/::jsonb\b/i.test(timelineInsert.sql), 'MariaDB SQL must not contain ::jsonb');
    } finally {
      setDatabasePool(harness.pool);
      tenantRedis.invalidateTenantCache(tenantId, 't5-mariadb-drain');
    }
  });

  it('T5.5: legacy save_settings preserves dom-meta initial key activation & honors explicit ai_screener_enabled=0 on subsequent shared AI updates', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'T5 Settings AI Co',
        tenant_slug: 't5-settings-ai',
        admin_name: 'T5 AI Admin',
        work_email: 'admin@t5-settings-ai.vn',
        phone: '0905100105',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const token = reg.json.data.access_token;
    const slug = reg.json.data.tenant.slug;

    // 1. Initial fresh Gemini key provisioning (preserves dom-meta-report.test.ts auto-activation contract)
    const initialSave = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: {
        gemini_api_key: 'AIzaSyT5InitialProvisionKey123456',
        ai_lead_eval_enabled: '1',
        ai_ads_eval_enabled: '1',
        ai_screener_enabled: '0',
      },
    });
    assert.equal(initialSave.status, 200);

    const afterInit = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token,
      tenantSlug: slug,
    });
    assert.equal(afterInit.status, 200);
    assert.equal(afterInit.json.data.has_shared_gemini_key, '1');
    assert.equal(afterInit.json.data.ai_screener_enabled, '1');

    // 2. Subsequent save_settings with masked key (or without key) + shared AI toggles + explicit ai_screener_enabled: '0'
    //    MUST honor ai_screener_enabled === '0' and keep has_shared_gemini_key === '1'
    const toggleOffSave = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: {
        gemini_api_key: afterInit.json.data.gemini_api_key, // masked value from get_settings
        ai_lead_eval_enabled: '1',
        ai_ads_eval_enabled: '1',
        ai_screener_enabled: '0',
      },
    });
    assert.equal(toggleOffSave.status, 200);

    const afterToggleOff = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token,
      tenantSlug: slug,
    });
    assert.equal(afterToggleOff.status, 200);
    assert.equal(afterToggleOff.json.data.ai_screener_enabled, '0');
    assert.equal(afterToggleOff.json.data.has_shared_gemini_key, '1');
    assert.equal(afterToggleOff.json.data.ai_lead_eval_enabled, '1');

    // 3. Shared AI toggle update without gemini_api_key field + explicit ai_screener_enabled='0' also remains '0'
    const adsOffSave = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: {
        ai_lead_eval_enabled: '1',
        ai_ads_eval_enabled: '0',
        ai_screener_enabled: '0',
      },
    });
    assert.equal(adsOffSave.status, 200);

    const afterAdsOff = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token,
      tenantSlug: slug,
    });
    assert.equal(afterAdsOff.status, 200);
    assert.equal(afterAdsOff.json.data.ai_screener_enabled, '0');
    assert.equal(afterAdsOff.json.data.ai_ads_eval_enabled, '0');
    assert.equal(afterAdsOff.json.data.has_shared_gemini_key, '1');
  });

  it('T5.6: CAPI retry worker enforces MAX_CAPI_RETRIES cap & prevents exponential 2^n retry storms', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'T5 CAPI AntiStorm Co',
        tenant_slug: 't5-capi-antistorm',
        admin_name: 'T5 CAPI Admin',
        work_email: 'admin@t5-capi.vn',
        phone: '0905100106',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const tenantId = reg.json.data.tenant.id;
    const userId = reg.json.data.user.id;

    const enc = encryptTenantSecret(tenantId, {
      dataset_id: '998877665544',
      access_token: 'EAA_live_t5_capi_antistorm_token_1234567890',
      live_http_enabled: true,
    });

    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
         VALUES ($1, 'meta_capi', $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, status = 'active'`,
        [tenantId, enc.configEncrypted, enc.iv, enc.authTag]
      );
      const leadRes = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, status, name, phone, assigned_to, custom_fields)
         VALUES ($1, 'assigned', 'CAPI Storm Lead', '0905111222', $2, '{}'::jsonb)
         RETURNING id`,
        [tenantId, userId]
      );
      const leadId = leadRes.rows[0].id;
      await client.query(
        `INSERT INTO capi_logs (
           tenant_id, lead_id, dataset_id, event_name, event_id, action_source,
           match_keys, sent_payload, response_status, retry_count, next_retry_at, sent_at
         ) VALUES (
           $1, $2, '998877665544', 'Lead', 'evt_t5_storm_1', 'system_generated',
           '{}'::jsonb, '{"data":[]}'::jsonb, 503, 0, NULL, clock_timestamp() - INTERVAL '10 minutes'
         )`,
        [tenantId, leadId]
      );
    });
    tenantRedis.invalidateTenantIntegrations(tenantId, 'meta_capi');

    let totalFetchCalls = 0;
    const callsPerTick: number[] = [];
    setCapiRetryFetcherForTesting(async () => {
      totalFetchCalls += 1;
      return {
        status: 503,
        json: async () => ({ error: { message: 'Service Unavailable' } }),
      } as any;
    });

    for (let tick = 1; tick <= 8; tick++) {
      const beforeCalls = totalFetchCalls;
      await runMetaCapiRetryWorker(tenantId);
      callsPerTick.push(totalFetchCalls - beforeCalls);

      // Simulate time advancing past backoff while keeping original row inside 24h window
      await withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `UPDATE capi_logs
           SET sent_at = clock_timestamp() - INTERVAL '10 minutes',
               next_retry_at = CASE WHEN next_retry_at IS NOT NULL THEN clock_timestamp() - INTERVAL '1 minute' ELSE NULL END
           WHERE tenant_id = $1`,
          [tenantId]
        );
      });
    }

    assert.equal(totalFetchCalls, MAX_CAPI_RETRIES, `Expected <= ${MAX_CAPI_RETRIES} total retries across 8 ticks`);
    assert.deepEqual(callsPerTick, [1, 1, 1, 1, 1, 0, 0, 0]);

    await withTenantTransaction(tenantId, async (client) => {
      const cntRes = await client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM capi_logs WHERE tenant_id = $1',
        [tenantId]
      );
      assert.equal(Number(cntRes.rows[0].cnt), 1 + MAX_CAPI_RETRIES);
    });
  });

  it('T5.7: Email fromName CRLF sanitization (Resend/SES), malformed SMTP CC resilience & Telegram >4096 chunking', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'T5 Notif Security Co',
        tenant_slug: 't5-notif-sec',
        admin_name: 'T5 Notif Admin',
        work_email: 'admin@t5-notif-sec.vn',
        phone: '0905100107',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const tenantId = reg.json.data.tenant.id;
    const token = reg.json.data.access_token;
    const slug = reg.json.data.tenant.slug;

    // 1. Resend & AWS SES fromName CRLF sanitization
    process.env.OUTBOUND_SILENT_MODE = 'false';
    const prevEmailMode = process.env.EMAIL_SILENT_MODE;
    process.env.EMAIL_SILENT_MODE = 'false';

    try {
      await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
        method: 'POST',
        token,
        tenantSlug: slug,
        body: {
          email_provider: 'resend',
          resend_api_key: 're_t5_mock_key_123456',
          resend_from_email: 'noreply@domation.vn',
          ses_sender_name: 'Brand\r\nBcc: evil@x.com<evil>',
          ses_sender_email: 'ses@domation.vn',
          ses_username: 'AKIAT5MOCKACCESSKEY',
          ses_password: 't5MockSecretAccessKey123456',
          ses_region: 'ap-southeast-1',
        },
      });

      const capturedEmails: Array<{ url: string; body: any }> = [];
      setEmailWebhookFetcherForTesting(async (url, init) => {
        capturedEmails.push({
          url: String(url),
          body: JSON.parse(String(init?.body || '{}')),
        });
        return new Response(JSON.stringify({ id: 'mock_email_ok' }), { status: 200 });
      });

      const resendRes = await sendTenantEmailNotification({
        tenantId,
        to: 'to@domation.vn',
        subject: 'T5 Resend CRLF Check',
        text: 'Hello',
        overrideProvider: 'resend',
      });
      assert.equal(resendRes?.sent, true);
      assert.equal(capturedEmails.length, 1);
      assert.ok(!/[\r\n]/.test(capturedEmails[0].body.from), `Resend 'from' leaked CRLF: ${capturedEmails[0].body.from}`);
      assert.ok(!capturedEmails[0].body.from.includes('<evil>'));

      const sesRes = await sendTenantEmailNotification({
        tenantId,
        to: 'to@domation.vn',
        subject: 'T5 SES CRLF Check',
        text: 'Hello',
        overrideProvider: 'ses',
      });
      assert.equal(sesRes?.sent, true);
      assert.equal(capturedEmails.length, 2);
      assert.ok(
        !/[\r\n]/.test(capturedEmails[1].body.FromEmailAddress),
        `SES 'FromEmailAddress' leaked CRLF: ${capturedEmails[1].body.FromEmailAddress}`
      );
      assert.ok(!capturedEmails[1].body.FromEmailAddress.includes('<evil>'));

      // 2. Malformed CC resilience in sendRawSmtpMail (mock SMTP rejecting invalid recipient addresses with 550)
      const rcptRecipients: string[] = [];
      const mockSmtpServer = net.createServer((socket) => {
        socket.write('220 mock.smtp.local ESMTP\r\n');
        let buf = '';
        let inData = false;
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (inData) {
            if (buf.includes('\r\n.\r\n')) {
              inData = false;
              buf = '';
              socket.write('250 2.0.0 Ok\r\n');
            }
            return;
          }
          let idx = buf.indexOf('\r\n');
          while (idx !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (/^EHLO/i.test(line)) {
              socket.write('250-mock.smtp.local\r\n250 OK\r\n');
            } else if (/^MAIL FROM:/i.test(line)) {
              socket.write('250 2.1.0 Ok\r\n');
            } else if (/^RCPT TO:/i.test(line)) {
              const addr = line.replace(/^RCPT TO:\s*<?([^>]*)>?/i, '$1').trim();
              rcptRecipients.push(addr);
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
                socket.write('550 5.1.3 Invalid recipient address\r\n');
              } else {
                socket.write('250 2.1.5 Ok\r\n');
              }
            } else if (/^DATA$/i.test(line)) {
              inData = true;
              socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
              break;
            } else if (/^QUIT$/i.test(line)) {
              socket.write('221 Bye\r\n');
              socket.end();
            } else {
              socket.write('250 OK\r\n');
            }
            idx = buf.indexOf('\r\n');
          }
        });
      });

      const smtpPort: number = await new Promise((resolve) => {
        mockSmtpServer.listen(0, '127.0.0.1', () => {
          const addr = mockSmtpServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      try {
        const smtpRes = await sendRawSmtpMail({
          host: '127.0.0.1',
          port: smtpPort,
          fromEmail: 'sender@domation.vn',
          fromName: 'Sender',
          to: 'to@domation.vn',
          cc: 'valid@domation.vn, bad_non_email',
          subject: 'Malformed CC Resilience',
          text: 'Body text',
          html: '<p>Body text</p>',
        });
        assert.equal(smtpRes.accepted, true, `Expected SMTP delivery despite invalid CC, got error: ${smtpRes.error}`);
        assert.deepEqual(rcptRecipients, ['to@domation.vn', 'valid@domation.vn']);
      } finally {
        await new Promise<void>((resolve) => mockSmtpServer.close(() => resolve()));
      }

      // 3. Telegram >4096 char chunk splitting
      process.env.TELEGRAM_SILENT_MODE = 'false';
      process.env.TELEGRAM_NOTIFY_ENABLED = 'true';

      const tgChunks: string[] = [];
      setTelegramTransportForTesting(async (payload) => {
        tgChunks.push(payload.text);
        return { message_id: tgChunks.length, ok: true };
      });

      const longMsg = Array.from({ length: 100 }, (_, idx) => `Line ${idx + 1}: ${'X'.repeat(35)}`).join('\n');
      assert.ok(longMsg.length > 4096);
      const tgRes = await sendTelegramNotification(tenantId, longMsg, {
        chatId: '-1001234567890',
        silentOverride: false,
      });
      assert.equal(tgRes.success, true);
      assert.ok(tgChunks.length >= 2, `Expected >=2 Telegram chunks for ${longMsg.length} chars`);
      for (const ch of tgChunks) {
        assert.ok(ch.length <= 4096, `Telegram chunk exceeded 4096 chars: ${ch.length}`);
      }
    } finally {
      process.env.OUTBOUND_SILENT_MODE = 'true';
      if (prevEmailMode === undefined) delete process.env.EMAIL_SILENT_MODE;
      else process.env.EMAIL_SILENT_MODE = prevEmailMode;
    }
  });
});
