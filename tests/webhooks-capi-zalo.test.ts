import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { encryptTenantSecret, decryptTenantSecret } from '../server/core/crypto/vault.ts';
import {
  signWebhookPayload,
  setOutboundWebhookTransportForTesting,
  dispatchOutboundWebhookEvent,
} from '../server/services/webhook.service.ts';
import { buildCapiUserData, sha256Hex } from '../server/services/capi.service.ts';
import { refreshExpiringZaloTokens } from '../server/services/zalo-mail.service.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';

describe('Phase 3: Webhooks (HMAC + 24h Idempotency + DLQ), Meta CAPI v21.0 & Zalo Bot Engine', () => {
  let harness: TestHarness;
  let adminToken = '';
  let tenantId = '';
  let tenantSlug = 'sungroup-demo';
  let inboundToken = '';
  let inboundSecret = '';
  let inboundWebhookId = '';

  before(async () => {
    harness = await startTestServer();

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Sun Property Demo',
        tenant_slug: tenantSlug,
        admin_name: 'Admin Sun',
        work_email: 'admin@sungroup-demo.vn',
        phone: '0901234567',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
        zalo_config: {
          bot_token: 'zalo_bot_initial_tok_123',
          group_chat_id: '-4829104829',
          oa_secret: 'oa_sec_999',
        },
        capi_config: {
          dataset_id: '123456789012345',
          access_token: 'sandbox_meta_system_token',
          test_event_code: 'TEST99112',
          dual_send: false,
        },
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;

    const overview = await apiRequest(harness.baseUrl, '/api/v1/integrations/overview', {
      token: adminToken,
    });
    assert.equal(overview.status, 200);
    const wh = overview.json.data.webhooks[0];
    inboundWebhookId = wh.id;
    inboundToken = wh.token;
    inboundSecret = wh.signing_secret;

    // Enable strict HMAC enforcement on the inbound webhook
    await apiRequest(harness.baseUrl, `/api/v1/integrations/webhooks/${inboundWebhookId}`, {
      method: 'PATCH',
      token: adminToken,
      body: {
        field_mappings: {
          ...wh.field_mappings,
          _enforce_hmac: true,
        },
      },
    });
  });

  after(async () => {
    setOutboundWebhookTransportForTesting(null);
    await harness.close();
  });

  it('Inbound Webhook enforces HMAC-SHA256 and 24-Hour Dual-Mode Idempotency (Header + Canonical Hash)', async () => {
    const rawPayloadObj = {
      ho_ten: 'Phạm Quốc Tuấn',
      so_dien_thoai: '0909123456',
      email: 'tuan.pham@yahoo.com',
      du_an: 'EcoLife Riverside',
      submitted_at: '2026-11-15T01:00:00Z',
    };
    const rawBody = JSON.stringify(rawPayloadObj);

    // 1. Missing/Invalid HMAC signature rejected with 401
    const badSig = await apiRequest(harness.baseUrl, `/v1/webhooks/${tenantSlug}/${inboundToken}`, {
      method: 'POST',
      headers: { 'X-Webhook-Signature': 'deadbeef' },
      body: rawBody,
    });
    assert.equal(badSig.status, 401);

    // 2. Valid HMAC signature accepted with 202 Accepted
    const validSig = signWebhookPayload(rawBody, inboundSecret);
    const firstHit = await apiRequest(harness.baseUrl, `/v1/webhooks/${tenantSlug}/${inboundToken}`, {
      method: 'POST',
      headers: {
        'X-Webhook-Signature': validSig,
        'X-Idempotency-Key': 'idem-key-001',
      },
      body: rawBody,
    });
    assert.equal(firstHit.status, 202);
    assert.equal(firstHit.json.status, 'ENQUEUED');

    // 3. Duplicate X-Idempotency-Key returns 200 DUPLICATE_SKIPPED
    const dupHeader = await apiRequest(harness.baseUrl, `/v1/webhooks/${tenantSlug}/${inboundToken}`, {
      method: 'POST',
      headers: {
        'X-Webhook-Signature': validSig,
        'X-Idempotency-Key': 'idem-key-001',
      },
      body: rawBody,
    });
    assert.equal(dupHeader.status, 200);
    assert.equal(dupHeader.json.status, 'DUPLICATE_SKIPPED');

    // 4. Different key order & different volatile `submitted_at` + `request_id` WITHOUT X-Idempotency-Key
    //    is STILL caught by Canonical JSON Payload Hashing!
    const reorderedPayload = JSON.stringify({
      request_id: 'req-different-9999',
      submitted_at: '2026-11-15T09:59:59Z',
      email: '  tuan.pham@yahoo.com ',
      du_an: 'EcoLife Riverside',
      so_dien_thoai: '0909123456',
      ho_ten: 'Phạm Quốc Tuấn',
    });
    const sig2 = signWebhookPayload(reorderedPayload, inboundSecret);
    const dupCanonical = await apiRequest(harness.baseUrl, `/v1/webhooks/${tenantSlug}/${inboundToken}`, {
      method: 'POST',
      headers: { 'X-Webhook-Signature': sig2 },
      body: reorderedPayload,
    });
    assert.equal(dupCanonical.status, 200);
    assert.equal(dupCanonical.json.status, 'DUPLICATE_SKIPPED');
  });

  it('Outbound Webhook retries 5 times on failure, persists to DLQ, and recovers on Replay', async () => {
    const createOut = await apiRequest(harness.baseUrl, '/api/v1/integrations/webhooks', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'ERP Sync Endpoint',
        webhook_type: 'outbound',
        url: 'https://erp.example.com/hooks/autodata',
        subscribed_events: ['lead.stage_changed'],
      },
    });
    assert.equal(createOut.status, 201);

    let callAttempts = 0;
    let shouldSucceed = false;
    setOutboundWebhookTransportForTesting(async (_url, opts) => {
      callAttempts += 1;
      assert.ok(opts.headers['X-AutoData-Signature-256']);
      if (shouldSucceed) {
        return { status: 200, statusText: 'OK' };
      }
      return { status: 503, statusText: 'Service Unavailable' };
    });

    const dispatchRes = await dispatchOutboundWebhookEvent({
      tenantId,
      eventType: 'lead.stage_changed',
      payload: { lead_id: 'lead-123', stage: 'deposit_secured' },
      maxAttempts: 5,
      retryDelayMs: 1,
    });

    assert.equal(callAttempts, 5, 'Must attempt delivery exactly 5 times before moving to DLQ');
    assert.equal(dispatchRes.failedToDlq, 1);

    const overview = await apiRequest(harness.baseUrl, '/api/v1/integrations/overview', { token: adminToken });
    assert.equal(overview.json.data.dlq.length, 1);
    const dlqId = overview.json.data.dlq[0].id;

    // Endpoint recovers -> Replay DLQ succeeds and clears record!
    shouldSucceed = true;
    const replayRes = await apiRequest(harness.baseUrl, `/api/v1/webhooks/dlq/${dlqId}/replay`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(replayRes.status, 200);
    assert.equal(replayRes.json.data.replayed, true);

    const overviewAfter = await apiRequest(harness.baseUrl, '/api/v1/integrations/overview', { token: adminToken });
    assert.equal(overviewAfter.json.data.dlq.length, 0, 'DLQ item must be cleared after successful replay');
  });

  it('Meta CAPI v21.0 normalizes NFC Vietnamese names, omits empty fields, and fires on stage transition', async () => {
    // Decomposed NFD string "Nguyê\u0303n Hoa\u0300ng Nam" must normalize to NFC "nguyễn" / "hoàng nam"
    const decomposedName = 'Nguy\u0065\u0302\u0303n Hoa\u0300ng Nam';
    const { userData } = buildCapiUserData(tenantId, {
      leadId: 'lead-nfc-1',
      name: decomposedName,
      phone: '0912 345 678',
      email: '   ', // Empty whitespace string MUST be omitted!
    });

    assert.deepEqual(userData.ph, [sha256Hex('84912345678')]);
    assert.deepEqual(userData.ln, [sha256Hex('nguyễn'.normalize('NFC'))]);
    assert.deepEqual(userData.fn, [sha256Hex('hoàng nam'.normalize('NFC'))]);
    assert.equal('em' in userData, false, 'Empty email must never be SHA-256 hashed');

    // Live Test Event endpoint
    const testCapi = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/test-event', {
      method: 'POST',
      token: adminToken,
      body: {
        event_name: 'Purchase',
        test_event_code: 'TEST69201',
        sample_phone: '0912345678',
        sample_email: 'test.conversion@autodata.vn',
      },
    });
    assert.equal(testCapi.status, 200);
    assert.equal(testCapi.json.data.meta_http_status, 200);
    assert.ok(testCapi.json.data.fbtrace_id);

    // Transition real lead to Purchase stage -> auto-dispatches CAPI & writes to capi_logs
    const leadsRes = await apiRequest(harness.baseUrl, '/api/v1/leads', { token: adminToken });
    const leadId = leadsRes.json.data.items[0].id;

    const pipesRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', { token: adminToken });
    const purchaseStage = pipesRes.json.data[0].stages.find((s: any) => s.capi_event_mapping === 'Purchase');
    assert.ok(purchaseStage);

    const transRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      token: adminToken,
      body: {
        stage_id: purchaseStage.id,
        note: 'Khách đặt cọc 100 triệu',
        deal_value_vnd: 100_000_000,
      },
    });
    assert.equal(transRes.status, 200);
    assert.equal(transRes.json.data.capi_dispatched.event_name, 'Purchase');
  });

  it('AES-256-GCM Vault enforces zero IV reuse, blocks cross-tenant decrypt, and runs Zalo Bot commands', async () => {
    const enc1 = encryptTenantSecret(tenantId, { token: 'secret-1' });
    const enc2 = encryptTenantSecret(tenantId, { token: 'secret-1' });
    assert.notEqual(enc1.iv, enc2.iv, 'Every encryption must generate a fresh CSPRNG 96-bit IV');

    assert.throws(() => {
      decryptTenantSecret('00000000-0000-0000-0000-000000000001', enc1.configEncrypted, enc1.iv, enc1.authTag);
    }, 'Cross-tenant vault decryption must fail GCM tag authentication');

    // Force token_expires_at within 2 hours and verify proactive OAuth refresh rotates IV
    const oldIv = await withTenantTransaction(tenantId, async (client) => {
      const r = await client.query<{ iv: string }>(
        `UPDATE tenant_integrations
         SET token_expires_at = clock_timestamp() + interval '1 hour'
         WHERE tenant_id = $1 AND integration_type = 'zalo_bot'
         RETURNING iv`,
        [tenantId]
      );
      return r.rows[0].iv;
    });

    const refreshOut = await refreshExpiringZaloTokens(tenantId);
    assert.equal(refreshOut.refreshedCount, 1);
    assert.notEqual(refreshOut.newIvs[0], oldIv, 'Refreshed Zalo OAuth token must be re-encrypted with fresh IV');

    // Interactive Zalo Bot commands: /chatid, /tiepnhan, /baoloi, /duyet
    const chatIdCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      body: { chat_id: '-4829104829', text: '/chatid' },
    });
    assert.equal(chatIdCmd.status, 200);
    assert.match(chatIdCmd.json.data.replyText, /-4829104829/);

    const leadsRes = await apiRequest(harness.baseUrl, '/api/v1/leads', { token: adminToken });
    const leadId = leadsRes.json.data.items[0].id;
    const shortId = leadId.slice(0, 8);

    const acceptCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      body: { chat_id: '-4829104829', text: `/tiepnhan #${shortId}` },
    });
    assert.equal(acceptCmd.status, 200);
    assert.match(acceptCmd.json.data.replyText, /tiếp nhận khách hàng/i);

    const reportCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      body: { chat_id: '-4829104829', text: `/baoloi #${shortId} Khách nhầm số` },
    });
    assert.equal(reportCmd.status, 200);
    const ticketId = reportCmd.json.data.metadata.ticket_id;

    const approveCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      body: { chat_id: '-4829104829', text: `/duyet #${String(ticketId).slice(0, 8)}` },
    });
    assert.equal(approveCmd.status, 200);
    assert.match(approveCmd.json.data.replyText, /Đã duyệt khiếu nại/i);
  });
});
