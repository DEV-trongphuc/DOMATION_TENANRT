import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  startE2eServer,
  apiRequest,
  registerTenant,
  triggerMasterCronHttp,
  signWebhookHmac,
  type E2eServerHarness,
} from './helpers/e2e-harness.ts';
import { installMockFetch, type MockFetchController } from './helpers/mock-fetch.ts';
import { startMockWebhookSink, type MockWebhookSink } from './helpers/mock-webhook-sink.ts';
import {
  seedTenantWorkspace,
  configureRoundConsultants,
  createInboundWebhook,
  createOutboundWebhook,
  saveVaultIntegration,
} from './helpers/fixtures.ts';
import { withTenantTransaction, withSystemPrivilege, withUnscopedRlsCheck } from '../../server/core/database/transaction.ts';
import { tenantRedis } from '../../server/core/cache/tenant-redis.ts';

function sha256Hex(v: string): string {
  return crypto.createHash('sha256').update(v, 'utf8').digest('hex');
}

describe('F2 & F9: Closed-Loop Meta->CRM->CAPI, AI Gatekeeper, DB Schema & Performance', () => {
  let harness: E2eServerHarness;
  let mockFetch: MockFetchController;
  let sink: MockWebhookSink;

  before(async () => {
    mockFetch = installMockFetch();
    sink = await startMockWebhookSink(200);
    harness = await startE2eServer();
  });

  after(async () => {
    await harness.close();
    await sink.close();
    mockFetch.restore();
  });

  beforeEach(() => {
    mockFetch.clearRequests();
    mockFetch.resetFailureModes();
    sink.clearDeliveries();
    sink.setStatus(200);
  });

  // =========================================================================
  // TIER 1: HAPPY PATH & LOCKED CONTRACT COVERAGE (>= 10 tests)
  // =========================================================================

  test('Tier 1.1: Inbound Meta webhook distributes in <5s via Fair-Share weighted round-robin (2:1 ratio)', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 Weighted RR Co',
      slug: 'f2-weighted-rr',
      salesCount: 2,
    });
    const sale1 = ws.users[0];
    const sale2 = ws.users[1];

    await configureRoundConsultants(harness.baseUrl, ws.adminToken, ws.tenantSlug, ws.defaultRoundId, [
      { user_id: sale1.id, receive_ratio: 2, data_per_turn: 1, is_active: true },
      { user_id: sale2.id, receive_ratio: 1, data_per_turn: 1, is_active: true },
    ]);

    const wh = await createInboundWebhook(harness.baseUrl, ws.adminToken, ws.tenantSlug);
    const counts = new Map<string, number>([
      [sale1.id, 0],
      [sale2.id, 0],
    ]);

    for (let i = 1; i <= 6; i++) {
      const payload = {
        name: `Meta Lead ${i}`,
        phone: `091234500${i}`,
        email: `metalead${i}@example.com`,
        source: 'Facebook Lead Ads',
        meta_lead_id: `fb_leadgen_${i}`,
      };
      const rawBody = JSON.stringify(payload);
      const t0 = Date.now();
      const res = await apiRequest(harness.baseUrl, wh.urlPath, {
        method: 'POST',
        headers: {
          'X-Webhook-Signature': signWebhookHmac(rawBody, wh.signing_secret),
        },
        body: rawBody,
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.status, 202, `Webhook ${i} failed: ${res.rawText}`);
      assert.ok(elapsed < 5000, `Distribution latency must be <5000ms, got ${elapsed}ms`);
      assert.ok(res.json.lead_id);
      counts.set(res.json.assigned_to, (counts.get(res.json.assigned_to) || 0) + 1);
    }

    assert.equal(counts.get(sale1.id), 4, 'Weight 2 sale must receive 4 out of 6 leads');
    assert.equal(counts.get(sale2.id), 2, 'Weight 1 sale must receive 2 out of 6 leads');
  });

  test('Tier 1.2: PATCH /api/v1/leads/:id/stage dispatches NFC SHA-256 Meta CAPI payload & records capi_logs', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 Capi Stage Co',
      slug: 'f2-capi-stage',
      salesCount: 1,
    });

    await saveVaultIntegration(harness.baseUrl, ws.adminToken, ws.tenantSlug, 'meta_capi', {
      dataset_id: '778899001122',
      access_token: 'EAA_LIVE_MOCK_CAPI_TOKEN_12345678901234567890',
      live_http_enabled: true,
      api_version: 'v21.0',
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        name: 'Nguyễn Hoàng Nam',
        phone: '0912345678',
        email: 'Nam.Nguyen@Example.COM',
        fbclid: 'IwAR_mock_fbclid_001',
      },
    });
    assert.equal(leadRes.status, 201);
    const leadId = leadRes.json.data.lead_id;

    const wonStage = ws.stages.find((s) => s.is_won_stage) || ws.stages[ws.stages.length - 1];
    assert.ok(wonStage, 'Won stage must exist');

    mockFetch.clearRequests();
    const stageRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        stage_id: wonStage.id,
        deal_value_vnd: 25_000_000,
        note: 'Khách đã thanh toán hợp đồng',
      },
    });
    assert.equal(stageRes.status, 200);
    assert.equal(stageRes.json.data.capi_dispatched?.status, 200);

    const capiReqs = mockFetch.getRequests('graph.facebook.com').filter((r) => r.pathname.endsWith('/events'));
    assert.equal(capiReqs.length, 1, 'Meta CAPI /events endpoint must be called once');
    const eventObj = capiReqs[0].jsonBody?.data?.[0];
    assert.ok(eventObj, 'CAPI data[0] event must be present');
    assert.equal(eventObj.custom_data?.currency, 'VND');
    assert.equal(eventObj.custom_data?.value, 25_000_000);
    // Verify NFC SHA-256 hashes
    assert.equal(eventObj.user_data?.ph?.[0], sha256Hex('84912345678'));
    assert.equal(eventObj.user_data?.em?.[0], sha256Hex('nam.nguyen@example.com'));
    assert.equal(eventObj.user_data?.ln?.[0], sha256Hex('nguyễn'.normalize('NFC')));
    assert.equal(eventObj.user_data?.fn?.[0], sha256Hex('hoàng nam'.normalize('NFC')));
  });

  test('Tier 1.3: facebook_ads vault fallback for Meta CAPI with live_http_enabled + capi-retry', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 FbAds Fallback Co',
      slug: 'f2-fbads-fallback',
      salesCount: 1,
    });

    // Save ONLY facebook_ads (no meta_capi vault row) with live_http_enabled: true
    await saveVaultIntegration(harness.baseUrl, ws.adminToken, ws.tenantSlug, 'facebook_ads', {
      live_http_enabled: true,
      primary_account_id: 'acc_1',
      accounts: [
        {
          id: 'acc_1',
          ad_account_id: 'act_555666777',
          pixel_id: '445566778899',
          access_token: 'EAA_FBADS_SHARED_CAPI_TOKEN_1234567890123456',
          is_active: true,
        },
      ],
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'FB Fallback Lead', phone: '0913000111' },
    });
    assert.equal(leadRes.status, 201);
    const leadId = leadRes.json.data.lead_id;
    const wonStage = ws.stages.find((s) => s.is_won_stage) || ws.stages[ws.stages.length - 1];

    // Inject 503 on first CAPI attempt so capi_logs gets 503
    mockFetch.setFailureMode({ metaCapiStatus: 503 });
    const stageRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { stage_id: wonStage.id, deal_value_vnd: 5_000_000 },
    });
    assert.equal(stageRes.status, 200);
    assert.equal(stageRes.json.data.capi_dispatched?.status, 503);

    // Backdate sent_at > 3 minutes so capi-retry picks it up
    await withTenantTransaction(ws.tenantId, async (client) => {
      await client.query(
        `UPDATE capi_logs SET sent_at = clock_timestamp() - INTERVAL '5 minutes' WHERE tenant_id = $1 AND lead_id = $2`,
        [ws.tenantId, leadId]
      );
    });

    mockFetch.clearRequests();
    mockFetch.setFailureMode({ metaCapiStatus: null });
    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['capi'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    const retryReqs = mockFetch.getRequests('graph.facebook.com').filter((r) => r.pathname.includes('/445566778899/events'));
    assert.equal(retryReqs.length, 1, 'capi-retry must fall back to facebook_ads pixel_id & token and retry CAPI');
  });

  test('Tier 1.4: Gemini AI Gatekeeper (mode: "ai") wired via shared ai_gemini_byok (ai_lead_eval_enabled)', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 Gemini Gatekeeper',
      slug: 'f2-gemini-gk',
      salesCount: 1,
    });

    const aiCfgRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'PUT',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        api_key: 'AIzaSyMockGeminiGatekeeperKey123456789',
        model: 'gemini-2.5-flash',
        ai_lead_eval_enabled: true,
        ai_ads_eval_enabled: true,
      },
    });
    assert.equal(aiCfgRes.status, 200);

    const saveRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        ai_screener_enabled: '1',
        ai_screener_mode: 'ai',
        ai_screener_rules: 'Evaluate lead quality for aesthetic clinic consultation',
        ai_screener_manual_action: 'hold',
      },
    });
    assert.equal(saveRes.status, 200);

    mockFetch.clearRequests();
    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        name: 'AI Evaluated Lead',
        phone: '0914555666',
        note: 'Quan tâm niềng răng trong suốt tại TP.HCM',
      },
    });
    assert.equal(leadRes.status, 201);

    const geminiReqs = mockFetch.getRequests('generativelanguage.googleapis.com');
    assert.ok(geminiReqs.length >= 1, 'AI Gatekeeper in ai mode with ai_lead_eval_enabled=true must invoke Gemini API');
  });

  test('Tier 1.5: docs/DATABASE_SCHEMA.sql has no duplicate CREATE TABLE IF NOT EXISTS tenant_custom_fields or tenant_entity_tabs', () => {
    const schemaPath = path.resolve(process.cwd(), 'docs', 'DATABASE_SCHEMA.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const customFieldsMatches = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+tenant_custom_fields\b/gi) || [];
    const entityTabsMatches = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+tenant_entity_tabs\b/gi) || [];

    assert.equal(
      customFieldsMatches.length,
      1,
      `Expected exactly 1 CREATE TABLE IF NOT EXISTS tenant_custom_fields in docs/DATABASE_SCHEMA.sql, found ${customFieldsMatches.length}`
    );
    assert.equal(
      entityTabsMatches.length,
      1,
      `Expected exactly 1 CREATE TABLE IF NOT EXISTS tenant_entity_tabs in docs/DATABASE_SCHEMA.sql, found ${entityTabsMatches.length}`
    );
  });

  test('Tier 1.6: Required billing, daily-report, and lead performance indexes exist in PostgreSQL pg_indexes', async () => {
    const requiredIndexes = [
      'idx_leads_tenant_quality_created',
      'idx_leads_tenant_assigned_active_created',
      'idx_leads_tenant_active_unarchived_created',
      'idx_leads_sla_master_sweep',
      'idx_leads_drainer_unassigned',
      'idx_webhook_dlq_retry_sweep',
      'idx_capi_retry_sweep',
      'idx_tenants_subscription_expiry',
      'idx_audit_logs_actor_created',
      'idx_comp_logs_consultant',
      'idx_billing_tx_tenant_status_created',
    ];

    await withSystemPrivilege(async (client) => {
      const res = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
      );
      const existing = new Set(res.rows.map((r) => r.indexname));
      for (const idx of requiredIndexes) {
        assert.ok(existing.has(idx), `Missing performance index: ${idx}`);
      }
    });
  });

  test('Tier 1.7: tenantRedis.setCachedTenantMeta preserves tenant name property', () => {
    const tid = crypto.randomUUID();
    tenantRedis.setCachedTenantMeta(tid, {
      slug: 'cached-name-slug',
      name: 'DOMATION Dental Luxury',
      status: 'active',
      rawSettings: {},
    });
    const got = tenantRedis.getCachedTenantMeta(tid);
    assert.ok(got);
    assert.equal(got.name, 'DOMATION Dental Luxury', 'setCachedTenantMeta must preserve meta.name');
    tenantRedis.invalidateTenantCache(tid, 'cached-name-slug');
  });

  test('Tier 1.8: Cross-tenant RLS isolation prevents reading/mutating other tenant leads & billing transactions', async () => {
    const wsA = await seedTenantWorkspace(harness.baseUrl, { companyName: 'RLS Tenant A', slug: 'rls-a', salesCount: 1 });
    const wsB = await seedTenantWorkspace(harness.baseUrl, { companyName: 'RLS Tenant B', slug: 'rls-b', salesCount: 1 });

    const leadA = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: wsA.adminToken,
      tenantSlug: wsA.tenantSlug,
      body: { name: 'Secret Lead A', phone: '0915000111' },
    });
    assert.equal(leadA.status, 201);
    const leadAId = leadA.json.data.lead_id;

    // Unscoped check returns 0 rows
    await withUnscopedRlsCheck(async (client) => {
      const r1 = await client.query('SELECT id FROM leads');
      const r2 = await client.query('SELECT id FROM tenant_billing_transactions');
      assert.equal(r1.rows.length, 0);
      assert.equal(r2.rows.length, 0);
    });

    // Tenant B cannot fetch Tenant A lead via HTTP or DB
    const crossHttp = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadAId}`, {
      token: wsB.adminToken,
      tenantSlug: wsB.tenantSlug,
    });
    assert.ok(crossHttp.status === 404 || crossHttp.status === 403);

    await withTenantTransaction(wsB.tenantId, async (client) => {
      const r = await client.query('SELECT id FROM leads WHERE id = $1', [leadAId]);
      assert.equal(r.rows.length, 0);
    });
  });

  test('Tier 1.9: Outbound webhook delivers signed lead.stage_changed event to mock-webhook-sink', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 Outbound Sink Co',
      slug: 'f2-outbound-sink',
      salesCount: 1,
    });

    const outWh = await createOutboundWebhook(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      url: sink.url,
      subscribed_events: ['lead.stage_changed'],
      max_retries: 2,
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Sink Lead', phone: '0916111222' },
    });
    assert.equal(leadRes.status, 201);
    const leadId = leadRes.json.data.lead_id;
    const wonStage = ws.stages.find((s) => s.is_won_stage) || ws.stages[ws.stages.length - 1];

    sink.clearDeliveries();
    const stageRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { stage_id: wonStage.id, deal_value_vnd: 10_000_000 },
    });
    assert.equal(stageRes.status, 200);

    const deliveries = await sink.waitForDeliveries(1, 3000);
    assert.equal(deliveries.length, 1, 'Mock webhook sink must receive 1 lead.stage_changed delivery');
    assert.equal(deliveries[0].headers['x-autodata-event'], 'lead.stage_changed');
    assert.equal(deliveries[0].json?.lead_id, leadId);
    const expectedSig = crypto.createHmac('sha256', outWh.signing_secret).update(deliveries[0].rawBody).digest('hex');
    assert.equal(deliveries[0].headers['x-autodata-signature-256'], expectedSig);
  });

  test('Tier 1.10: GET /api/v1/integrations/dom-meta/crm-attribution returns attributed CRM funnel summary', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 Attribution Co',
      slug: 'f2-attribution',
      salesCount: 1,
    });

    await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        name: 'Attributed Lead',
        phone: '0916333444',
        campaign: 'Summer_Implant_2026',
        utm_source: 'facebook',
      },
    });

    const attrRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/crm-attribution?entity_type=all', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(attrRes.status, 200);
    assert.equal(attrRes.json.success, true);
    const attrData = attrRes.json.data;
    assert.ok(attrData, 'crm-attribution must return structured attribution data');
    assert.ok((attrData.summary?.attributed_leads ?? 0) >= 1, 'summary.attributed_leads must be >= 1');
    assert.ok(
      (attrData.by_campaign_name?.['summer_implant_2026']?.total_leads ?? 0) >= 1,
      "by_campaign_name['summer_implant_2026'].total_leads must be >= 1"
    );
    assert.ok(
      Array.isArray(attrData.entity_leads?.items) &&
        attrData.entity_leads.items.some((x: any) => x.campaign_name === 'Summer_Implant_2026'),
      "entity_leads.items must include campaign_name === 'Summer_Implant_2026'"
    );
  });

  test('Tier 1.11: GET /api/v1/health confirms service availability and rls_kernel_enforced=true', async () => {
    const health = await apiRequest(harness.baseUrl, '/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.success, true);
    assert.equal(health.json.data.rls_kernel_enforced, true);
  });

  test('Tier 1.12: CAPI stage transitions honor Skip (0 HTTP calls) and DisqualifiedLead (negative feedback event)', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 Capi Skip Disq Co',
      slug: 'f2-capi-skip-disq',
      salesCount: 1,
      industry: 'real_estate',
    });

    await saveVaultIntegration(harness.baseUrl, ws.adminToken, ws.tenantSlug, 'meta_capi', {
      dataset_id: '334455667788',
      access_token: 'EAA_MOCK_CAPI_SKIP_DISQ_TOKEN_12345678901234',
      live_http_enabled: true,
      api_version: 'v21.0',
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        name: 'Phạm Quốc Bảo',
        phone: '0916888999',
        email: 'quocbao@example.com',
        fbclid: 'IwAR_mock_skip_disq_001',
      },
    });
    assert.equal(leadRes.status, 201);
    const leadId = leadRes.json.data.lead_id;

    const skipStage = ws.stages.find((s) => s.capi_event_mapping === 'Skip' || s.stage_key === 'contacted_qualified');
    const disqStage = ws.stages.find((s) => s.capi_event_mapping === 'DisqualifiedLead' || s.stage_key === 'disqualified');
    assert.ok(skipStage, 'real_estate preset must include a Skip stage');
    assert.ok(disqStage, 'real_estate preset must include a DisqualifiedLead stage');

    // 1. Move to Skip stage -> 0 /events calls and capi_dispatched === null
    mockFetch.clearRequests();
    const skipRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { stage_id: skipStage.id, note: 'Đã gọi trao đổi sơ bộ' },
    });
    assert.equal(skipRes.status, 200);
    assert.equal(skipRes.json.data.capi_dispatched, null, 'Skip stage must not dispatch CAPI');
    assert.equal(
      mockFetch.getRequests('graph.facebook.com').filter((r) => r.pathname.endsWith('/events')).length,
      0,
      'Skip stage must make 0 Meta CAPI /events requests'
    );

    // 2. Move to DisqualifiedLead stage -> 1 /events call with event_name === DisqualifiedLead
    mockFetch.clearRequests();
    const disqRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { stage_id: disqStage.id, note: 'Sai số / không có nhu cầu' },
    });
    assert.equal(disqRes.status, 200);
    assert.equal(disqRes.json.data.capi_dispatched?.event_name, 'DisqualifiedLead');
    assert.equal(disqRes.json.data.capi_dispatched?.status, 200);

    const disqReqs = mockFetch.getRequests('graph.facebook.com').filter((r) => r.pathname.endsWith('/events'));
    assert.equal(disqReqs.length, 1, 'DisqualifiedLead stage must send 1 Meta CAPI /events request');
    assert.equal(disqReqs[0].jsonBody?.data?.[0]?.event_name, 'DisqualifiedLead');
  });

  // =========================================================================
  // TIER 2: BOUNDARY, ERROR, CONCURRENCY & EDGE CASES (>= 10 tests)
  // =========================================================================

  test('Tier 2.1: Invalid X-Webhook-Signature HMAC is rejected with 401 INVALID_WEBHOOK_SIGNATURE', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 Bad HMAC', slug: 'f2-bad-hmac', salesCount: 1 });
    const wh = await createInboundWebhook(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      field_mappings: { _enforce_hmac: true },
    });

    const res = await apiRequest(harness.baseUrl, wh.urlPath, {
      method: 'POST',
      headers: { 'X-Webhook-Signature': `sha256=${'0'.repeat(64)}` },
      body: { name: 'Bad Sig', phone: '0917000111' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error?.code, 'INVALID_WEBHOOK_SIGNATURE');
  });

  test('Tier 2.2: Duplicate X-Idempotency-Key and canonical payload hash deduped within 24h', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 Dedup Wh', slug: 'f2-dedup-wh', salesCount: 1 });
    const wh = await createInboundWebhook(harness.baseUrl, ws.adminToken, ws.tenantSlug);

    const p1 = { name: 'Idem Lead', phone: '0917222333', submitted_at: '2026-11-19T10:00:00Z' };
    const r1 = await apiRequest(harness.baseUrl, wh.urlPath, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': 'wh-idem-100' },
      body: p1,
    });
    assert.equal(r1.status, 202);

    // Same X-Idempotency-Key even with different phone -> DUPLICATE_SKIPPED
    const r2 = await apiRequest(harness.baseUrl, wh.urlPath, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': 'wh-idem-100' },
      body: { name: 'Other', phone: '0917999888' },
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.status, 'DUPLICATE_SKIPPED');

    // Different X-Idempotency-Key, identical canonical payload (only volatile submitted_at differs) -> DUPLICATE_SKIPPED
    const r3 = await apiRequest(harness.baseUrl, wh.urlPath, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': 'wh-idem-200' },
      body: { name: 'Idem Lead', phone: '0917222333', submitted_at: '2026-11-19T10:05:00Z' },
    });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.status, 'DUPLICATE_SKIPPED');
  });

  test('Tier 2.3: Malformed or missing phone on inbound webhook fails cleanly with 422 (no 500 crash)', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 Bad Phone', slug: 'f2-bad-phone', salesCount: 1 });
    const wh = await createInboundWebhook(harness.baseUrl, ws.adminToken, ws.tenantSlug);

    const bad = await apiRequest(harness.baseUrl, wh.urlPath, {
      method: 'POST',
      body: { name: 'No Phone Lead', phone: 'abc' },
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error?.code, 'WEBHOOK_INGEST_ERROR');
  });

  test('Tier 2.4: Blacklist & AI hold -> held_leads -> approve_held_lead distributes cleanly', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 Held Flow', slug: 'f2-held-flow', salesCount: 1 });
    await configureRoundConsultants(harness.baseUrl, ws.adminToken, ws.tenantSlug, ws.defaultRoundId, [
      { user_id: ws.users[0].id, receive_ratio: 1, data_per_turn: 1, is_active: true },
    ]);

    // Enable manual AI Gatekeeper rule to hold leads with note containing 'spam_check'
    const gkCfgRes = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/config', {
      method: 'PUT',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        is_enabled: true,
        mode: 'manual',
        manual_action: 'hold',
        manual_rules: [{ field: 'note', operator: 'contains', value: 'spam_check', reason: 'Manual review needed' }],
      },
    });
    assert.equal(gkCfgRes.status, 200);

    // Seed blacklist phone
    await withTenantTransaction(ws.tenantId, async (client) => {
      await client.query(
        `INSERT INTO blacklist_entries (tenant_id, entry_type, value, reason) VALUES ($1, 'phone', '84918000111', 'Known spammer')`,
        [ws.tenantId]
      );
    });

    const blLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Blacklisted Lead', phone: '0918000111' },
    });
    assert.equal(blLead.status, 201);
    assert.equal(blLead.json.data.held, true);
    assert.equal(blLead.json.data.dispatch_reason, 'blacklist_blocked');

    const heldLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Manual Hold Lead', phone: '0918000222', note: 'Need spam_check review' },
    });
    assert.equal(heldLead.status, 201);
    assert.equal(heldLead.json.data.held, true);

    const listHeld = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_held_leads&status=pending_approval', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(listHeld.status, 200);
    assert.ok(listHeld.json.data.some((h: any) => h.id === heldLead.json.data.lead_id));

    const approveHeld = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=approve_held_lead', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { id: heldLead.json.data.lead_id },
    });
    assert.equal(approveHeld.status, 200);
    assert.equal(approveHeld.json.data.assignedTo, ws.users[0].id);
  });

  test('Tier 2.5: 90d/180d duplicate lead reminder policy assigns back to original owner with is_duplicate_reminder=true', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 Dup Policy', slug: 'f2-dup-policy', salesCount: 2 });

    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        duplicate_threshold_days: 90,
        duplicate_action: 'notify_existing_owner',
      },
    });

    const first = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Dup Customer', phone: '0918555777' },
    });
    assert.equal(first.status, 201);
    const firstOwner = first.json.data.assigned_to;

    const second = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Dup Customer Again', phone: '0918555777' },
    });
    assert.equal(second.status, 201);
    assert.equal(second.json.data.is_duplicate_reminder, true);
    assert.equal(second.json.data.assigned_to, firstOwner);
  });

  test('Tier 2.6: CAPI HTTP 503 failure -> capi-retry cron subroutine retries and succeeds (200)', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 Capi Retry', slug: 'f2-capi-retry', salesCount: 1 });
    await saveVaultIntegration(harness.baseUrl, ws.adminToken, ws.tenantSlug, 'meta_capi', {
      dataset_id: '112233445566',
      access_token: 'EAA_MOCK_CAPI_RETRY_TOKEN_123456789012345678',
      live_http_enabled: true,
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Retry Lead', phone: '0919000111' },
    });
    const leadId = leadRes.json.data.lead_id;
    const wonStage = ws.stages.find((s) => s.is_won_stage) || ws.stages[ws.stages.length - 1];

    mockFetch.setFailureMode({ metaCapiStatus: 503 });
    const stageRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { stage_id: wonStage.id, deal_value_vnd: 8_000_000 },
    });
    assert.equal(stageRes.json.data.capi_dispatched?.status, 503);

    await withTenantTransaction(ws.tenantId, async (client) => {
      await client.query(
        `UPDATE capi_logs SET sent_at = clock_timestamp() - INTERVAL '5 minutes' WHERE tenant_id = $1 AND lead_id = $2`,
        [ws.tenantId, leadId]
      );
    });

    mockFetch.clearRequests();
    mockFetch.setFailureMode({ metaCapiStatus: null });
    const cron = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['capi'], tenantId: ws.tenantId });
    assert.equal(cron.status, 200);
    assert.ok(cron.json.data.stats.capiRetriedCount >= 1);
  });

  test('Tier 2.7: legacy-crm.ts update_lead_quality dispatches CAPI parity event when dual_capi_enabled=true', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 Legacy Capi', slug: 'f2-legacy-capi', salesCount: 1 });
    await saveVaultIntegration(harness.baseUrl, ws.adminToken, ws.tenantSlug, 'meta_capi', {
      dataset_id: '223344556677',
      access_token: 'EAA_MOCK_LEGACY_CAPI_TOKEN_1234567890123456',
      live_http_enabled: true,
    });
    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { dual_capi_enabled: true },
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Legacy Quality Lead', phone: '0919111222' },
    });
    const leadId = leadRes.json.data.lead_id;

    mockFetch.clearRequests();
    const upd = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=update_lead_quality', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { lead_id: leadId, quality_status: 'Closed', quality_note: 'Closed deal' },
    });
    assert.equal(upd.status, 200);

    // Give detached CAPI promise a tick to finish
    await new Promise((r) => setTimeout(r, 100));
    const capiReqs = mockFetch.getRequests('graph.facebook.com').filter((r) => r.pathname.endsWith('/events'));
    assert.equal(capiReqs.length, 1);
    assert.equal(capiReqs[0].jsonBody?.data?.[0]?.event_name, 'Purchase');
  });

  test('Tier 2.8: Outbound webhook 503 -> DLQ persisted -> POST /api/v1/webhooks/dlq/:id/replay succeeds on 200', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 DLQ Replay', slug: 'f2-dlq-replay', salesCount: 1 });
    await createOutboundWebhook(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      url: sink.url,
      subscribed_events: ['lead.stage_changed'],
      max_retries: 1,
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'DLQ Lead', phone: '0919333444' },
    });
    const leadId = leadRes.json.data.lead_id;
    const wonStage = ws.stages.find((s) => s.is_won_stage) || ws.stages[ws.stages.length - 1];

    sink.setStatus(503);
    await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { stage_id: wonStage.id },
    });

    await sink.waitForDeliveries(1, 3000);
    await new Promise((r) => setTimeout(r, 150));

    const ovRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/overview', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(ovRes.status, 200);
    const dlqItems = ovRes.json.data.dlq || [];
    assert.ok(dlqItems.length >= 1, 'Failed outbound webhook must be recorded in DLQ');

    sink.clearDeliveries();
    sink.setStatus(200);
    const replayRes = await apiRequest(harness.baseUrl, `/api/v1/webhooks/dlq/${dlqItems[0].id}/replay`, {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.json.data.replayed, true);
    assert.equal(sink.getDeliveries().length, 1);
  });

  test('Tier 2.9: ai_lead_eval_enabled = false bypasses Gemini external API call even when screener enabled', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 AI Bypass', slug: 'f2-ai-bypass', salesCount: 1 });

    await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'PUT',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        api_key: 'AIzaSyMockGeminiBypassKey1234567890',
        ai_lead_eval_enabled: false,
        ai_ads_eval_enabled: true,
      },
    });
    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        ai_screener_enabled: '1',
        ai_screener_mode: 'ai',
        ai_screener_rules: 'Evaluate leads',
      },
    });

    mockFetch.clearRequests();
    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'No Gemini Lead', phone: '0919555666' },
    });
    assert.equal(leadRes.status, 201);
    assert.equal(
      mockFetch.getRequests('generativelanguage.googleapis.com').length,
      0,
      'Gemini API MUST NOT be invoked when ai_lead_eval_enabled=false'
    );
  });

  test('Tier 2.10: tenant_billing_transactions idempotency_key & reference_code uniqueness constraints enforced in DB', async () => {
    const t = await registerTenant(harness.baseUrl, { company_name: 'F9 Unique Tx Co', tenant_slug: 'f9-unique-tx' });
    assert.equal(t.status, 201);

    const refCode = `UNIQ-REF-${Date.now()}`;
    const idemKey = `uniq-idem-${Date.now()}`;

    await withTenantTransaction(t.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_billing_transactions (tenant_id, tx_type, amount_vnd, reference_code, idempotency_key)
         VALUES ($1, 'topup', 1500000, $2, $3)`,
        [t.tenantId, refCode, idemKey]
      );
    });

    await assert.rejects(
      () =>
        withTenantTransaction(t.tenantId, async (client) => {
          await client.query(
            `INSERT INTO tenant_billing_transactions (tenant_id, tx_type, amount_vnd, reference_code, idempotency_key)
             VALUES ($1, 'topup', 1500000, $2, $3)`,
            [t.tenantId, `${refCode}-2`, idemKey]
          );
        }),
      /duplicate key|unique constraint/i,
      'Duplicate (tenant_id, idempotency_key) must be rejected by DB unique index/constraint'
    );

    await assert.rejects(
      () =>
        withTenantTransaction(t.tenantId, async (client) => {
          await client.query(
            `INSERT INTO tenant_billing_transactions (tenant_id, tx_type, amount_vnd, reference_code)
             VALUES ($1, 'topup', 1500000, $2)`,
            [t.tenantId, refCode]
          );
        }),
      /duplicate key|unique constraint/i,
      'Duplicate reference_code must be rejected by DB unique constraint'
    );
  });

  test('Tier 2.11: AI Gatekeeper Gemini hold verdict quarantines suspicious lead into held_leads', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, { companyName: 'F2 AI Hold', slug: 'f2-ai-hold', salesCount: 1 });

    await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'PUT',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        api_key: 'AIzaSyMockGeminiHoldKey1234567890',
        ai_lead_eval_enabled: true,
      },
    });
    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        ai_screener_enabled: '1',
        ai_screener_mode: 'ai',
        ai_screener_manual_action: 'hold',
        ai_screener_rules: 'Hold test/spam leads',
      },
    });

    mockFetch.setFailureMode({
      geminiCustomText: JSON.stringify({
        qualified: false,
        hold: true,
        reject: false,
        score: 15,
        decision: 'hold',
        reason: 'Lead chứa dấu hiệu test spam',
      }),
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Test Spam Lead', phone: '0919777888', note: 'test 123' },
    });
    assert.equal(leadRes.status, 201);
    assert.equal(leadRes.json.data.held, true);
    assert.equal(leadRes.json.data.dispatch_reason, 'ai_gatekeeper_held');
  });

  test('Tier 2.12: SLA auto-recall reassigns overdue lead AND approved dispute ticket grants 1:1 compensation refund', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F2 SLA & Ticket Refund Co',
      slug: 'f2-sla-ticket-refund',
      salesCount: 2,
    });
    const sale1 = ws.users[0];
    const sale2 = ws.users[1];

    await configureRoundConsultants(harness.baseUrl, ws.adminToken, ws.tenantSlug, ws.defaultRoundId, [
      { user_id: sale1.id, receive_ratio: 1, data_per_turn: 1, is_active: true },
      { user_id: sale2.id, receive_ratio: 1, data_per_turn: 1, is_active: true },
    ]);

    const cfgRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        sla_auto_recall_enabled: true,
        default_sla_minutes: 1,
        use_default_sla_fallback: true,
        enable_compensation_credits: true,
        compensation_credits_per_ticket: 1,
      },
    });
    assert.equal(cfgRes.status, 200);

    const wh = await createInboundWebhook(harness.baseUrl, ws.adminToken, ws.tenantSlug);

    // 1. Ingest Lead 1 -> assigned to firstSale
    const raw1 = JSON.stringify({ name: 'SLA Overdue Lead', phone: '0919888111', source: 'Facebook Lead Ads' });
    const wh1 = await apiRequest(harness.baseUrl, wh.urlPath, {
      method: 'POST',
      headers: { 'X-Webhook-Signature': signWebhookHmac(raw1, wh.signing_secret) },
      body: raw1,
    });
    assert.equal(wh1.status, 202);
    const lead1Id = wh1.json.lead_id;
    const firstAssignee = wh1.json.assigned_to;
    assert.ok(firstAssignee === sale1.id || firstAssignee === sale2.id);
    const peerSale = firstAssignee === sale1.id ? sale2 : sale1;

    // 2. Backdate created_at > stage SLA (20 mins ago, unaccepted) and trigger sla-sweeper
    await withTenantTransaction(ws.tenantId, async (client) => {
      await client.query(
        `UPDATE leads SET created_at = clock_timestamp() - INTERVAL '20 minutes', is_accepted = false WHERE tenant_id = $1 AND id = $2`,
        [ws.tenantId, lead1Id]
      );
    });

    const slaCron = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['sla'], tenantId: ws.tenantId });
    assert.equal(slaCron.status, 200);
    assert.ok((slaCron.json.data?.stats?.slaBreachedCount ?? 0) >= 1, 'sla-sweeper must process overdue lead');

    const leadsAfterSla = await apiRequest(harness.baseUrl, '/api/v1/leads?limit=20', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(leadsAfterSla.status, 200);
    const recalledLead = (leadsAfterSla.json.data?.items || []).find((l: any) => l.id === lead1Id);
    assert.ok(recalledLead, 'Recalled lead must remain queryable');
    assert.equal(recalledLead.sla_breached, true, 'sla_breached must be true after auto-recall');
    assert.equal(recalledLead.assigned_sale?.id, peerSale.id, 'SLA auto-recall must reassign lead to peer sale');

    const timelineRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${lead1Id}/timeline`, {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(timelineRes.status, 200);
    assert.ok(
      (timelineRes.json.data || []).some((ev: any) => ev.event_type === 'auto_recall'),
      'Lead timeline must record auto_recall event'
    );

    // 3. Peer sale raises dispute ticket -> Admin approves -> 1:1 compensation credit granted
    const ticketRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${lead1Id}/tickets`, {
      method: 'POST',
      token: peerSale.token,
      tenantSlug: ws.tenantSlug,
      body: { reason: 'Sai số / Thuê bao', description: 'Khách không nghe máy / sai số' },
    });
    assert.equal(ticketRes.status, 201, `Ticket creation failed: ${ticketRes.rawText}`);
    const ticketId = ticketRes.json.data.id;

    const resolveRes = await apiRequest(harness.baseUrl, `/api/v1/leads/tickets/${ticketId}/resolve`, {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { decision: 'approved', resolution_note: 'Duyệt hoàn 1 lượt chia số' },
    });
    assert.equal(resolveRes.status, 200, `Ticket resolve failed: ${resolveRes.rawText}`);
    assert.equal(resolveRes.json.data.compensation_granted, true);
    assert.equal(resolveRes.json.data.compensation_credits, 1);

    const roundsBefore = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds/list', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    const peerBefore = (roundsBefore.json.data?.rounds?.[0]?.consultants || []).find((c: any) => c.user_id === peerSale.id);
    assert.equal(Number(peerBefore?.compensation_count || 0), 1, 'Approved ticket must grant compensation_count = 1');

    // 4. Next inbound lead must prioritize peerSale (1:1 compensation) and consume compensation_count back to 0
    const raw2 = JSON.stringify({ name: 'Compensation Lead 2', phone: '0919888222', source: 'Facebook Lead Ads' });
    const wh2 = await apiRequest(harness.baseUrl, wh.urlPath, {
      method: 'POST',
      headers: { 'X-Webhook-Signature': signWebhookHmac(raw2, wh.signing_secret) },
      body: raw2,
    });
    assert.equal(wh2.status, 202);
    assert.equal(wh2.json.assigned_to, peerSale.id, '1:1 compensation priority must route next lead to compensated sale');
    assert.equal(wh2.json.dispatch_reason, 'compensation_credit');

    const roundsAfter = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds/list', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    const peerAfter = (roundsAfter.json.data?.rounds?.[0]?.consultants || []).find((c: any) => c.user_id === peerSale.id);
    assert.equal(Number(peerAfter?.compensation_count || 0), 0, 'compensation_count must decrement back to 0 after refund lead');
  });
});
