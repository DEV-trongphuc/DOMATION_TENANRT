import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { handleAutodataBridgeHttp } from '../../DOMATION_LANDINGPAGE/lib/autodataBridge.ts';

describe('Adversarial Review Fixes — End-to-End Regressions', () => {
  let harness: TestHarness;
  let proxyServer: http.Server;
  let proxyBaseUrl: string;
  let tenantSlug: string;
  let adminToken: string;
  let saleToken: string;
  let saleUserId: string;
  let roundId: string;

  before(async () => {
    harness = await startTestServer();
    proxyServer = http.createServer((req, res) => {
      void handleAutodataBridgeHttp(req, res, harness.baseUrl);
    });
    await new Promise<void>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = proxyServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    proxyBaseUrl = `http://127.0.0.1:${port}`;

    const slug = `revfix-${Date.now()}`;
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        work_email: `admin_${Date.now()}@revfix.vn`,
        phone: '0905888111',
        password: 'Password@123',
        admin_name: 'Review Admin',
        company_name: 'Review Fix Corp',
        tenant_slug: slug,
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    tenantSlug = reg.json.data.tenant.slug;
    adminToken = reg.json.data.access_token;

    const saleEmail = `sale_${Date.now()}@revfix.vn`;
    const saleCreate = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        full_name: 'Review Sale 01',
        email: saleEmail,
        phone: '0905888222',
        password: 'Password@123',
        role: 'sale',
      },
    });
    assert.equal(saleCreate.status, 201);
    saleUserId = saleCreate.json.data.id;

    const saleLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: saleEmail, password: 'Password@123' },
    });
    assert.equal(saleLogin.status, 200);
    saleToken = saleLogin.json.data.access_token;

    const roundsRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds/list', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(roundsRes.status, 200);
    roundId = roundsRes.json.data.rounds[0].id;
  });

  after(async () => {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    if (harness) await harness.close();
  });

  test('1. Rolled-back soft-deleted leads are excluded from /leads/export and duplicate rejection', async () => {
    const imp = await apiRequest(harness.baseUrl, '/api/v1/operations/leads/batch-import', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        file_name: 'rollback-test.csv',
        rows: [{ name: 'Deleted Lead Test', phone: '0909111222', source: 'CSV' }],
        is_silent: true,
        skip_duplicates: true,
      },
    });
    assert.equal(imp.status, 201);
    assert.equal(imp.json.data.imported_count, 1);

    const auditRes = await apiRequest(harness.baseUrl, '/api/v1/operations/admin-audit', {
      token: adminToken,
      tenantSlug,
    });
    const batchLog = auditRes.json.data.items.find((x: any) => x.entity_type === 'lead_import_batch');
    assert.ok(batchLog);

    const rb = await apiRequest(harness.baseUrl, `/api/v1/operations/admin-audit/${batchLog.id}/rollback`, {
      method: 'POST',
      token: adminToken,
      tenantSlug,
    });
    assert.equal(rb.status, 200);

    // Export CSV must NOT include the soft-deleted lead
    const exp = await fetch(`${harness.baseUrl}/api/v1/leads/export`, {
      headers: { Authorization: `Bearer ${adminToken}`, 'X-Tenant-Slug': tenantSlug },
    });
    assert.equal(exp.status, 200);
    const csvText = await exp.text();
    assert.equal(csvText.includes('Deleted Lead Test'), false);

    // Ingesting same phone must NOT be marked as duplicate of deleted lead
    const createNew = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Fresh Lead After Rollback', phone: '0909111222', source: 'Webhook' },
    });
    assert.equal(createNew.status, 201);
    assert.equal(createNew.json.data.is_duplicate_reminder, false);
  });

  test('2. Blacklist keyword & Gatekeeper manual_action=reject block spam leads cleanly', async () => {
    const bl = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/blacklist', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { entry_type: 'keyword', value: 'spamkeyword', reason: 'Keyword spam' },
    });
    assert.equal(bl.status, 201);

    const blocked = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Mr SpamKeyword', phone: '0909333888', source: 'Webhook' },
    });
    assert.equal(blocked.status, 201);
    assert.equal(blocked.json.data.held, true);
    assert.equal(blocked.json.data.dispatch_reason, 'blacklist_blocked');

    const gkSave = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/config', {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: {
        is_enabled: true,
        mode: 'manual',
        manual_action: 'reject',
        manual_rules: [{ field: 'name', op: 'contains', val: 'bot_auto', reason: 'Bot name rejected' }],
      },
    });
    assert.equal(gkSave.status, 200);

    const rejected = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Test bot_auto Lead', phone: '0909444999', source: 'Webhook' },
    });
    assert.equal(rejected.status, 201);
    assert.equal(rejected.json.data.held, true);
    assert.equal(rejected.json.data.dispatch_reason, 'ai_gatekeeper_rejected');

    const rejList = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/held-leads?status=rejected', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(rejList.status, 200);
    assert.ok(rejList.json.data.items.some((x: any) => x.name === 'Test bot_auto Lead'));
  });

  test('3. Ticket approval & user compensation write active_compensation_logs', async () => {
    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Ticket Audit Lead', phone: '0909555666', force_assigned_to: saleUserId },
    });
    assert.equal(leadRes.status, 201);
    const leadId = leadRes.json.data.lead_id;

    const tk = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/tickets`, {
      method: 'POST',
      token: saleToken,
      tenantSlug,
      body: { reason: 'Sai số', description: 'Không liên lạc được' },
    });
    assert.equal(tk.status, 201);

    const resTk = await apiRequest(harness.baseUrl, `/api/v1/leads/tickets/${tk.json.data.id}/resolve`, {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { decision: 'approved', resolution_note: 'Duyệt bù 1 lượt' },
    });
    assert.equal(resTk.status, 200);

    const fair = await apiRequest(harness.baseUrl, `/api/v1/analytics/fair-share?round_id=${roundId}`, {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(fair.status, 200);
    assert.ok(fair.json.data.compensation_logs.some((l: any) => l.source_type === 'ticket' && l.amount === 1));
  });

  test('4. Tenant settings PATCH records admin_audit_logs and rolls back cleanly', async () => {
    const upd = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { default_sla_minutes: 42 } },
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.json.data.settings.default_sla_minutes, 42);

    const audit = await apiRequest(harness.baseUrl, '/api/v1/operations/admin-audit', {
      token: adminToken,
      tenantSlug,
    });
    const stLog = audit.json.data.items.find((x: any) => x.entity_type === 'tenant_settings');
    assert.ok(stLog);

    const rb = await apiRequest(harness.baseUrl, `/api/v1/operations/admin-audit/${stLog.id}/rollback`, {
      method: 'POST',
      token: adminToken,
      tenantSlug,
    });
    assert.equal(rb.status, 200);

    const me = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(me.json.data.tenant.settings.default_sla_minutes, 15);
  });

  test('5. Dashboard custom date range works for Sale role without SQL bind errors', async () => {
    const dash = await apiRequest(
      harness.baseUrl,
      '/api/v1/analytics/dashboard?date_preset=custom&start_date=2026-01-01&end_date=2026-12-31&chart_mode=heatmap',
      { token: saleToken, tenantSlug }
    );
    assert.equal(dash.status, 200);
    assert.ok(dash.json.data.kpis);
    assert.ok(Array.isArray(dash.json.data.by_consultant));
  });

  test('6. Round consultant is_active toggle & Sale zalo_chat_id availability persist', async () => {
    const putRc = await apiRequest(harness.baseUrl, `/api/v1/pipelines/rounds/${roundId}/consultants`, {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: { consultants: [{ user_id: saleUserId, receive_ratio: 2, data_per_turn: 1, is_active: false }] },
    });
    assert.equal(putRc.status, 200);
    const updatedRc = putRc.json.data.find((x: any) => x.user_id === saleUserId);
    assert.ok(updatedRc);
    assert.equal(updatedRc.is_active, false);

    const avail = await apiRequest(harness.baseUrl, '/api/v1/users/me/availability', {
      method: 'PATCH',
      token: saleToken,
      tenantSlug,
      body: { is_available: true, vacation_mode: false, zalo_chat_id: 'zalo_custom_9988' },
    });
    assert.equal(avail.status, 200);

    const me = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: saleToken,
      tenantSlug,
    });
    assert.equal(me.json.data.user.zalo_chat_id, 'zalo_custom_9988');
  });

  test('7. Proxy bridge handles telegram-config, telegram-test & zalo-updates in silent mode', async () => {
    const tgCfg = await fetch(`${proxyBaseUrl}/api/autodata?action=telegram-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'X-Tenant-Slug': tenantSlug,
      },
      body: JSON.stringify({
        bot_token: '123456789:ABCDEF_SILENT_TEST_TOKEN',
        chat_id: '-10011223344',
        silent_mode: true,
        enabled: true,
      }),
    });
    assert.equal(tgCfg.status, 200);
    const tgCfgJson = (await tgCfg.json()) as any;
    assert.equal(tgCfgJson.data.telegram_config.chat_id, '-10011223344');

    const tgTest = await fetch(`${proxyBaseUrl}/api/autodata?action=telegram-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'X-Tenant-Slug': tenantSlug,
      },
      body: JSON.stringify({ test_type: 'webhook_command', command_text: '/chatid', chat_id: '-10011223344' }),
    });
    assert.equal(tgTest.status, 200);
    const tgTestJson = (await tgTest.json()) as any;
    assert.equal(tgTestJson.data.silent, true);

    const zaloUpd = await fetch(`${proxyBaseUrl}/api/autodata?action=zalo-updates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        'X-Tenant-Slug': tenantSlug,
      },
      body: JSON.stringify({ bot_token: 'demo_zalobot_token' }),
    });
    assert.equal(zaloUpd.status, 200);
    const zaloUpdJson = (await zaloUpd.json()) as any;
    assert.ok(zaloUpdJson.data.chat_id);
  });
});
