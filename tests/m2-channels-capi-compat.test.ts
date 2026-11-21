import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import {
  setZnsTransportForTesting,
  type ZnsTransportRequest,
} from '../server/services/zalo-zns.service.ts';
import {
  refreshExpiringZaloTokens,
  setEmailWebhookFetcherForTesting,
  setZaloOAuthFetcherForTesting,
} from '../server/services/zalo-mail.service.ts';
import {
  setMessengerTransportForTesting,
  type MessengerTransportRequest,
} from '../server/services/meta-messenger.service.ts';
import {
  setCapiHttpTransportForTesting,
} from '../server/services/capi.service.ts';
import { executeFlowForLead } from '../server/modules/marketing/flow-engine.service.ts';
import { dispatchZnsNotification } from '../server/modules/marketing/dispatchers.ts';
import { runMarketingFlowsWorker } from '../server/cron/subroutines/wave2-workers.ts';

describe('M2 Integration Suite: Channel Adapters, Cross-App CAPI/Triggers, MYERP/PHP Compat & All 8 E2E-M2A Edge Cases', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  let tenantB: { id: string; slug: string; token: string };
  const origSilentEnv = process.env.OUTBOUND_SILENT_MODE;

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M2 Alpha Omnichannel JSC',
        tenant_slug: 'm2-alpha-omni',
        admin_name: 'Minh Anh',
        work_email: 'admin@m2-alpha.vn',
        phone: '0901112233',
        password: 'SecurePassword123!',
        industry: 'retail',
        package_code: 'enterprise',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M2 Beta Rival Corp',
        tenant_slug: 'm2-beta-rival',
        admin_name: 'Hoang Nam',
        work_email: 'admin@m2-beta.vn',
        phone: '0909887766',
        password: 'SecurePassword123!',
        industry: 'retail',
        package_code: 'enterprise',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
    };

    // Unlock Full Enterprise Suite (all marketing + ERP/CRM/CAPI entitlements) on both tenants
    for (const t of [tenantA, tenantB]) {
      await withTenantTransaction(t.id, async (client) => {
        await client.query('UPDATE tenants SET wallet_balance_vnd = 50000000 WHERE id = $1', [t.id]);
      });
      const sw = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
        method: 'POST',
        token: t.token,
        tenantSlug: t.slug,
        body: { package_code: 'enterprise' },
      });
      assert.equal(sw.status, 200);
    }
  });

  after(async () => {
    setZnsTransportForTesting(null);
    setZaloOAuthFetcherForTesting(null);
    setMessengerTransportForTesting(null);
    setEmailWebhookFetcherForTesting(null);
    setCapiHttpTransportForTesting(null);
    if (origSilentEnv === undefined) {
      delete process.env.OUTBOUND_SILENT_MODE;
    } else {
      process.env.OUTBOUND_SILENT_MODE = origSilentEnv;
    }
    await harness.close();
  });

  it('1. Zalo ZNS: boot registration, OUTBOUND_SILENT_MODE guard, zns broadcast + suppression, flow/campaign dispatch, OAuth refresh & -124 retry', async () => {
    // 1a. Configure live Zalo ZNS vault for Tenant A (with expiring token for OAuth refresh check)
    const putZns = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/zalo_zns', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        access_token: 'live_zns_tok_initial',
        refresh_token: 'live_zns_refresh_1',
        app_id: '3344556677',
        secret_key: 'zns_app_secret_abc',
        oa_id: '9988776655',
        default_template_id: '311220',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    assert.equal(putZns.status, 200);

    // Seed Zalo OA config & approved template
    await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-oa', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { oa_id: '9988776655', oa_name: 'Alpha Official OA', is_active: true },
    });
    const zTplRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-templates', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Xác nhận đơn hàng ZNS', template_code: '311220', status: 'approved', params_schema: ['customer_name'] },
    });
    assert.equal(zTplRes.status, 201);

    // 1b. Seed 2 contacts + suppress 1 phone in mkt_suppression_list
    const c1 = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Khach ZNS Active', phone: '0912345678', email: 'zns.active@example.com' },
    });
    const c2 = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Khach ZNS Suppressed', phone: '0988776655', email: 'zns.supp@example.com' },
    });
    assert.equal(c1.status, 201);
    assert.equal(c2.status, 201);
    const activeLeadId = c1.json.data.id;

    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
         VALUES ($1, $2, 'zns', '0988776655', 'opted_out')`,
        [crypto.randomUUID(), tenantA.id]
      );
    });

    // 1c. OUTBOUND_SILENT_MODE = true must queue without invoking live transport
    process.env.OUTBOUND_SILENT_MODE = 'true';
    setZnsTransportForTesting(null);
    const silentRes = await dispatchZnsNotification({
      tenantId: tenantA.id,
      phone: '0912345678',
      templateId: '311220',
      templateData: { customer_name: 'Khach ZNS' },
    });
    assert.equal(silentRes.silent, true);

    let capturedZns: ZnsTransportRequest[] = [];
    setZnsTransportForTesting(async (req) => {
      capturedZns.push(req);
      return { sent: true, messageId: 'zns_msg_mock_1' };
    });

    // 1d. Live mode: broadcast filters suppressed phone and sends real ZNS OpenAPI request with E.164 phone
    process.env.OUTBOUND_SILENT_MODE = 'false';
    const bcast = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-broadcast', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        template_id: '311220',
        recipients: [
          { phone: '0912345678', template_data: { customer_name: 'Anh A' } },
          { phone: '0988776655', template_data: { customer_name: 'Blocked' } },
        ],
      },
    });
    assert.equal(bcast.status, 200);
    assert.equal(bcast.json.data.sent_count, 1);
    assert.equal(bcast.json.data.suppressed_count, 1);
    assert.equal(capturedZns.length, 1);
    assert.equal(capturedZns[0].url, 'https://business.openapi.zalo.me/message/template');
    assert.equal(capturedZns[0].body.phone, '84912345678');
    assert.equal(capturedZns[0].headers['access_token'], 'live_zns_tok_initial');

    // 1e. Simulate -124 expired token -> auto-refresh via Zalo OAuth & retry
    capturedZns = [];
    let attempt = 0;
    const oauthCalls: Array<{ appId?: string; refreshToken?: string }> = [];
    setZnsTransportForTesting(async (req) => {
      attempt++;
      capturedZns.push(req);
      if (attempt === 1) {
        return { ok: false, status: 401, errorCode: -124, message: 'Invalid access token' };
      }
      return { ok: true, status: 200, errorCode: 0, data: { msg_id: 'zns_retried_ok' } };
    });
    setZaloOAuthFetcherForTesting(async (cfg) => {
      oauthCalls.push({ appId: cfg.app_id, refreshToken: cfg.refresh_token });
      return {
        access_token: 'live_zns_tok_refreshed_v2',
        refresh_token: 'live_zns_refresh_2',
        expires_in: 3600,
      };
    });

    const retried = await dispatchZnsNotification({
      tenantId: tenantA.id,
      phone: '0912345678',
      templateId: '311220',
      templateData: { customer_name: 'Retry User' },
    });
    assert.equal(retried.sent, true);
    assert.equal(retried.messageId, 'zns_retried_ok');
    assert.equal(oauthCalls.length, 1);
    assert.equal(oauthCalls[0].appId, '3344556677');
    assert.equal(capturedZns.length, 2);
    assert.equal(capturedZns[1].headers['access_token'], 'live_zns_tok_refreshed_v2');

    // 1f. Flow send_zns node dispatches through ZNS
    const flowRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Flow Send ZNS',
        trigger_type: 'manual_enroll',
        status: 'published',
        steps_json: [
          {
            id: 'z1',
            type: 'send_zns',
            title: 'Gửi ZNS xác nhận',
            config: { template_id: '311220', template_data: { customer_name: 'Flow Guest' } },
          },
        ],
      },
    });
    assert.equal(flowRes.status, 201);
    const execOut = await executeFlowForLead(tenantA.id, flowRes.json.data.id, activeLeadId, { skipWaitDelay: true });
    assert.equal(execOut.status, 'completed');
    assert.equal(capturedZns.length, 3);

    // 1g. Direct refreshExpiringZaloTokens picks up 'zalo_zns' too
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `UPDATE tenant_integrations
         SET token_expires_at = $2, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND integration_type = 'zalo_zns'`,
        [tenantA.id, new Date(Date.now() + 60_000).toISOString()]
      );
    });
    const batchRefresh = await refreshExpiringZaloTokens(tenantA.id);
    assert.ok(batchRefresh.refreshedCount >= 1, 'refreshExpiringZaloTokens must refresh expiring zalo_zns tokens');
    process.env.OUTBOUND_SILENT_MODE = 'true';
  });

  it('2. Meta Messenger & Chatbot RAG: masked config, Meta webhook GET/POST + X-Hub-Signature-256, web_chat preservation, Vietnamese RAG >=2 chars, scenarios, bot_paused & /sdk.js', async () => {
    const pageId = '102233445566';
    const appSecret = 'meta_app_secret_987654';
    const verifyToken = 'domation_verify_tok_2026';

    const putCfg = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/messenger-config', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        page_id: pageId,
        page_name: 'Alpha Fanpage',
        page_access_token: 'EAAG_live_messenger_page_tok_xyz',
        app_secret: appSecret,
        verify_token: verifyToken,
        is_active: true,
      },
    });
    assert.equal(putCfg.status, 200);

    const getCfg = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/messenger-config', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(getCfg.status, 200);
    assert.equal(getCfg.json.data.pages[0]?.page_id, pageId);
    assert.ok(!JSON.stringify(getCfg.json.data).includes('EAAG_live_messenger_page_tok_xyz'), 'Secrets must be masked on GET');
    assert.ok(!JSON.stringify(getCfg.json.data).includes(appSecret), 'app_secret must be masked on GET');

    // Cross-tenant isolation check (Tenant B must NOT see Tenant A's page config)
    const getCfgB = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/messenger-config', {
      token: tenantB.token,
      tenantSlug: tenantB.slug,
    });
    assert.equal(getCfgB.status, 200);
    assert.notEqual(getCfgB.json.data.pages?.[0]?.page_id, pageId);

    // Enable AI bot + upload RAG training doc + create automation scenario
    await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/bot-config', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { bot_name: 'Trợ lý Alpha', is_active: true, system_prompt: 'Hỗ trợ tư vấn sản phẩm' },
    });
    const docRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/training-docs', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Bảng giá Pro 2026',
        content: 'Bảng giá gói Pro hiện nay là 1.990.000đ/tháng, hỗ trợ Zalo ZNS và CRM.',
        status: 'indexed',
      },
    });
    assert.equal(docRes.status, 201);
    const scenRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/scenarios', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Chính sách bảo hành',
        channel: 'omnichannel',
        trigger_type: 'keyword',
        keywords: ['bảo hành', 'đổi trả'],
        nodes: [{ id: 'n1', type: 'reply', config: { reply: 'Sản phẩm được bảo hành 12 tháng chính hãng.' } }],
        is_active: true,
      },
    });
    assert.equal(scenRes.status, 201);

    // Meta Webhook GET challenge verification
    const badVerify = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/social/inbound/${tenantA.slug}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL123`
    );
    assert.equal(badVerify.status, 403);

    const goodVerifyResp = await fetch(
      `${harness.baseUrl}/api/v1/public/marketing/social/inbound/${tenantA.slug}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=CHAL_OK_789`
    );
    assert.equal(goodVerifyResp.status, 200);
    assert.equal(await goodVerifyResp.text(), 'CHAL_OK_789');

    // Meta Webhook POST signature check + live Messenger RAG reply dispatch
    const metaBodyStr = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: pageId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'psid_customer_001' },
              recipient: { id: pageId },
              message: { mid: 'm_123', text: 'giá gói pro là bao nhiêu?' },
            },
          ],
        },
      ],
    });
    const invalidSig = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/social/inbound/${tenantA.slug}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=0000' },
        body: metaBodyStr,
      }
    );
    assert.equal(invalidSig.status, 401);

    process.env.OUTBOUND_SILENT_MODE = 'false';
    const sentMessenger: MessengerTransportRequest[] = [];
    setMessengerTransportForTesting(async (req) => {
      sentMessenger.push(req);
      return { sent: true, message_id: `fb_mid_${sentMessenger.length}` };
    });

    const validHmac = 'sha256=' + crypto.createHmac('sha256', appSecret).update(metaBodyStr).digest('hex');
    const okMeta = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/social/inbound/${tenantA.slug}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': validHmac },
        body: metaBodyStr,
      }
    );
    assert.equal(okMeta.status, 200);
    assert.equal(sentMessenger.length, 1);
    assert.ok(sentMessenger[0].url.includes(`https://graph.facebook.com/v21.0/${pageId}/messages`));
    assert.equal(sentMessenger[0].body.recipient.id, 'psid_customer_001');
    assert.ok(sentMessenger[0].body.message.text.includes('1.990.000đ/tháng'), 'RAG reply must use short Vietnamese tokens');

    // Agent manual reply on Messenger conversation -> dispatches via Messenger transport
    const convs = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    const msgConv = convs.json.data.conversations.find((c: any) => c.channel === 'messenger' && c.external_thread_id === 'psid_customer_001');
    assert.ok(msgConv, 'Messenger conversation must be created');

    const agentReply = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/social-bot/conversations/${msgConv.id}/messages`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { content: 'Em gửi anh bảng giá chi tiết nhé!' },
      }
    );
    assert.equal(agentReply.status, 201);
    assert.equal(sentMessenger.length, 2);

    // Website Chatbot: 'web_chat' channel preservation + scenario match + bot_paused guard + /sdk.js
    const webIn = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/social/inbound/${tenantA.slug}`,
      {
        method: 'POST',
        body: {
          channel: 'web_chat',
          visitor_id: 'vis_web_01',
          customer_name: 'Khách Web',
          message: 'Shop có hỗ trợ bảo hành không?',
        },
      }
    );
    assert.ok([200, 201].includes(webIn.status));
    assert.equal(webIn.json.data.channel, 'web_chat');
    assert.ok(String(webIn.json.data.reply || '').includes('12 tháng'), 'Automation scenario must trigger');

    // Verify bot_paused skips auto-reply
    const webConvId = webIn.json.data.conversation_id;
    const toggleRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/social-bot/conversations/${webConvId}`, {
      method: 'PATCH',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { bot_paused: true },
    });
    assert.equal(toggleRes.status, 200);
    const pausedIn = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/social/inbound/${tenantA.slug}`,
      {
        method: 'POST',
        body: { channel: 'web_chat', visitor_id: 'vis_web_01', message: 'Alo còn ai không?' },
      }
    );
    assert.ok([200, 201].includes(pausedIn.status));
    assert.equal(pausedIn.json.data.bot_paused, true);
    assert.equal(pausedIn.json.data.reply, null);

    // /sdk.js chat widget
    const sdkResp = await fetch(`${harness.baseUrl}/api/v1/public/marketing/sdk.js?t=${tenantA.slug}&chat=1`);
    assert.equal(sdkResp.status, 200);
    const sdkJs = await sdkResp.text();
    assert.ok(sdkJs.includes('DomationChatWidget'), '/sdk.js?chat=1 must embed DomationChatWidget');
    process.env.OUTBOUND_SILENT_MODE = 'true';
  });

  it('3. Email Vault Readiness (appscript) & Live Test Send + Cross-App Domain Events & Meta CAPI Conversions', async () => {
    // Configure appscript email config + Meta CAPI vault
    const emailCfg = await apiRequest(harness.baseUrl, '/api/v1/integrations/email/config', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        email_provider: 'appscript',
        appscript_webhook_url: 'https://script.google.com/macros/s/AKfycbxTestLive123/exec',
        ses_sender_name: 'Alpha Marketing',
      },
    });
    assert.equal(emailCfg.status, 200);

    const capiCfg = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/meta_capi', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        dataset_id: '887766554433',
        access_token: 'EAAG_live_capi_token_999_abcdefghijklmnopqrstuvwxyz1234',
        test_event_code: 'TEST_M2',
      },
    });
    assert.equal(capiCfg.status, 200);

    // Email pre-send review must recognize appscript vault as configured
    const preReview = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/pre-send-review', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { channel: 'email', subject: 'Khuyến mãi Q4', html_body: '<p>Hello {{name}}</p><a href="https://example.com?unsubscribe=1">Unsub</a>' },
    });
    assert.equal(preReview.status, 200);
    assert.equal(preReview.json.data.vault_ready, true);

    // Live email test-send
    process.env.OUTBOUND_SILENT_MODE = 'false';
    const sentEmails: Array<{ url: string; payload: Record<string, unknown> }> = [];
    setEmailWebhookFetcherForTesting(async (url, init) => {
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      sentEmails.push({ url, payload: parsedBody });
      return new Response(
        JSON.stringify({ ok: true, status: 200, messageId: `app_mail_${sentEmails.length}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const testEmail = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/test-email', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { to_email: 'qa-recipient@example.com', subject: 'Live Test Email', html_body: '<p>Testing AppsScript</p>', send_live: true },
    });
    assert.equal(testEmail.status, 200);
    assert.equal(testEmail.json.data.delivery?.sent, true);
    assert.equal(sentEmails.length, 1);

    const tplCreate = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Welcome Template', channel: 'email', subject: 'Chào {{name}}', html_body: '<p>Xin chào {{name}}</p>' },
    });
    assert.equal(tplCreate.status, 201);
    const tplSend = await apiRequest(harness.baseUrl, `/api/v1/marketing/templates/${tplCreate.json.data.id}/test-send`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { to_email: 'qa-tpl@example.com', send_live: true },
    });
    assert.equal(tplSend.status, 200);
    assert.equal(sentEmails.length, 2);

    // Cross-app Meta CAPI on Deal Won + Flow Engine triggers
    const capiPayloads: Array<{ url: string; body: any }> = [];
    setCapiHttpTransportForTesting(async ({ datasetId, payload, apiVersion }) => {
      capiPayloads.push({ url: `https://graph.facebook.com/${apiVersion}/${datasetId}/events`, body: payload });
      return { httpStatus: 200, body: { events_received: 1, fbtrace_id: 'fb_trace_m2' } };
    });

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Nguyen CAPI Buyer', phone: '0907778899', email: 'capi.buyer@example.com' },
    });
    assert.equal(leadRes.status, 201);
    const buyerLeadId = leadRes.json.data.id;

    // Create static list + stage_changed flow + audience_joined flow
    const staticAud = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'VIP Static Buyers', audience_type: 'static' },
    });
    assert.equal(staticAud.status, 201);

    const joinedFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'VIP Audience Trigger',
        trigger_type: 'audience_joined',
        trigger_config: { audience_id: staticAud.json.data.id },
        status: 'published',
        steps_json: [{ id: 's1', type: 'update_lead_field', title: 'Set hot', config: { temperature: 'hot' } }],
      },
    });
    assert.equal(joinedFlow.status, 201);

    const addMem = await apiRequest(harness.baseUrl, `/api/v1/audiences/${staticAud.json.data.id}/members`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { lead_ids: [buyerLeadId] },
    });
    assert.equal(addMem.status, 200);

    // Give async microtask bus tick to flush
    await new Promise((r) => setTimeout(r, 80));

    // Create Deal -> transition to Won via PATCH /api/v1/finance/deals/:id -> fires CAPI Purchase
    const dealCreate = await apiRequest(harness.baseUrl, '/api/v1/finance/deals', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { title: 'Enterprise Contract', lead_id: buyerLeadId, amount_vnd: 25_000_000, stage: 'proposal' },
    });
    assert.equal(dealCreate.status, 201);

    const dealWon = await apiRequest(harness.baseUrl, `/api/v1/finance/deals/${dealCreate.json.data.id}`, {
      method: 'PATCH',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { stage: 'won', amount_vnd: 25_000_000 },
    });
    assert.equal(dealWon.status, 200);
    await new Promise((r) => setTimeout(r, 120));

    const purchaseEvent = capiPayloads.find(
      (c) => Array.isArray(c.body?.data) && c.body.data.some((ev: any) => ev.event_name === 'Purchase')
    );
    assert.ok(purchaseEvent, 'Transitioning a CRM deal to won must dispatch a Meta CAPI Purchase event');

    // Manual flow enroll via CRM 360 contacts route
    const enrollRes = await apiRequest(harness.baseUrl, `/api/v1/crm-360/contacts/${buyerLeadId}/enroll-flow`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { flow_id: joinedFlow.json.data.id },
    });
    assert.equal(enrollRes.status, 201);

    // Meta CAPI Audiences Sync by audience_id
    const syncRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/audiences/sync', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { audience_id: staticAud.json.data.id, custom_audience_id: '23850000111222' },
    });
    assert.equal(syncRes.status, 200);
    process.env.OUTBOUND_SILENT_MODE = 'true';
  });

  it('4. MYERP Compat, .php Bridges, Package idempotent_replay & org-rbac 13 Cron Subroutines', async () => {
    // org-rbac cron-status lists all 13 subroutines including 6 Wave 2 marketing workers
    const cronStat = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/cron-status', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(cronStat.status, 200);
    const subKeys = (cronStat.json.data.subroutines || []).map((s: any) => s.key);
    assert.equal(subKeys.length, 13);
    for (const k of ['marketing_flows', 'marketing_campaigns', 'audience_reeval', 'attendance_confirm', 'reminders', 'outbox_events']) {
      assert.ok(subKeys.includes(k), `cron-status missing subroutine: ${k}`);
    }

    // Package upgrade idempotent_replay returns 201 on first pending order, 200 with idempotent_replay: true on replay
    const idemKey = `pkg-idem-${Date.now()}`;
    const upg1 = await apiRequest(harness.baseUrl, '/api/v1/myerp/package-entitlements/upgrade', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'Idempotency-Key': idemKey },
      body: { package_code: 'enterprise', billing_cycle: 'monthly', payment_method: 'bank_transfer' },
    });
    const upg2 = await apiRequest(harness.baseUrl, '/api/v1/myerp/package-entitlements/upgrade', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'Idempotency-Key': idemKey },
      body: { package_code: 'enterprise', billing_cycle: 'monthly', payment_method: 'bank_transfer' },
    });
    assert.ok([200, 201].includes(upg1.status));
    if (upg1.json?.data?.requires_payment) {
      assert.equal(upg1.status, 201);
      assert.equal(upg1.json.data.idempotent_replay, false);
      assert.equal(upg2.status, 200);
      assert.equal(upg2.json.data.idempotent_replay, true);
    } else {
      assert.equal(upg2.status, 200);
      assert.equal(upg2.json.data.idempotent_replay, true);
    }

    // Campaign estimate-reach, pause, resume
    const estRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/campaigns/estimate-reach', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { channel: 'email' },
    });
    assert.equal(estRes.status, 200);
    assert.ok(typeof estRes.json.data.count === 'number');

    const campCreate = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Pause Resume Camp', channel: 'email', subject: 'Hi', html_body: '<p>Hi</p>', status: 'sending' },
    });
    assert.equal(campCreate.status, 201);
    const campId = campCreate.json.data.id;
    const pauseRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/pause`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.json.data.status, 'paused');
    const resumeRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/resume`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(resumeRes.status, 200);
    assert.ok(['sending', 'scheduled'].includes(resumeRes.json.data.status));

    // Public .php bridges without auth (survey_public.php, voucher_claim.php, /api/voucher_claim.php)
    const surveyRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Khảo sát Public PHP',
        questions_json: [{ id: 'q1', label: 'Mức độ hài lòng?', type: 'rating', required: true }],
      },
    });
    assert.equal(surveyRes.status, 201);
    const pubSurvey = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/survey_public.php?slug=${encodeURIComponent(surveyRes.json.data.slug)}`
    );
    assert.equal(pubSurvey.status, 200);
    assert.equal(pubSurvey.json.data.title, 'Khảo sát Public PHP');

    const voucherRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Voucher Public Claim',
        code_prefix: 'PUB',
        discount_type: 'fixed_vnd',
        discount_value: 50000,
        min_order_vnd: 100000,
      },
    });
    assert.equal(voucherRes.status, 201);
    const genRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/vouchers/${voucherRes.json.data.id}/generate`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { count: 3 },
    });
    assert.equal(genRes.status, 201);

    const claimPhp = await apiRequest(harness.baseUrl, '/api/voucher_claim.php', {
      method: 'POST',
      body: {
        tenant_slug: tenantA.slug,
        campaign_id: voucherRes.json.data.id,
        email: 'claimer.php@example.com',
      },
    });
    assert.ok([200, 201].includes(claimPhp.status));
    assert.ok(claimPhp.json.data.code);

    // Non-stubbed authenticated compat bridges (flows.php, flow_ai_review.php, integrations, zalo_oa.php, subscribers PUT/DELETE, ai_training.php)
    const flowsPhp = await apiRequest(harness.baseUrl, '/api/v1/myerp/flows.php?route=list', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(flowsPhp.status, 200);
    assert.ok(Array.isArray(flowsPhp.json.data.items));

    const aiRev = await apiRequest(harness.baseUrl, '/api/v1/myerp/flow_ai_review.php', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { steps: [{ id: 'n1', type: 'trigger', title: 'Start' }], trigger_type: 'form_submit' },
    });
    assert.equal(aiRev.status, 200);
    assert.ok(typeof aiRev.json.data.score === 'number');

    const intList = await apiRequest(harness.baseUrl, '/api/v1/myerp/integrations', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(intList.status, 200);

    const zaloAuthUrl = await apiRequest(harness.baseUrl, '/api/v1/myerp/zalo_oa.php?route=generate-auth-url', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(zaloAuthUrl.status, 200);
    assert.ok(String(zaloAuthUrl.json.data.auth_url).includes('https://oauth.zaloapp.com/v4/oa/permission'));
  });

  it('5. All 8 E2E-M2A Edge-Case Defects Verified Clean', async () => {
    // Edge 1: Voucher redeem order_vnd = 0 or omitted fails min_order_vnd check
    const vPool = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Edge MinOrder', code_prefix: 'EDG', discount_type: 'fixed_vnd', discount_value: 20000, min_order_vnd: 100000 },
    });
    assert.equal(vPool.status, 201);
    const vGen = await apiRequest(harness.baseUrl, `/api/v1/marketing/vouchers/${vPool.json.data.id}/generate`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { count: 1 },
    });
    const edgeCode = vGen.json.data.sample_codes[0];
    const redeemZero = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/redeem', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { code: edgeCode, order_vnd: 0 },
    });
    assert.equal(redeemZero.status, 400);
    assert.equal(redeemZero.json?.error?.code, 'MIN_ORDER_NOT_MET');
    const redeemOmitted = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/redeem', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { code: edgeCode },
    });
    assert.equal(redeemOmitted.status, 400);
    assert.equal(redeemOmitted.json?.error?.code, 'MIN_ORDER_NOT_MET');

    // Edge 2 & 8a: Non-numeric inactive_days & invalid date return safe 200 count:0 (no 500), non-UUID audience_id returns 400
    const badInactive = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'inactive_days', operator: 'gt', value: 'abc' },
              { field: 'created_at', operator: 'after', value: 'not-a-date' },
            ],
          },
        ],
      },
    });
    assert.equal(badInactive.status, 200);
    assert.equal(badInactive.json.data.count, 0);

    const badAudId = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { audience_id: 'not-a-uuid' },
    });
    assert.equal(badAudId.status, 400);

    // Edge 3: Shortlink /r/:code?lid=<non-existent-uuid> does not 500 on FK
    const slRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/shortlinks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { title: 'Edge Redirect', target_url: 'https://domation.net/promo' },
    });
    assert.equal(slRes.status, 201);
    const rResp = await fetch(
      `${harness.baseUrl}/api/v1/public/marketing/r/${slRes.json.data.short_code}?lid=${crypto.randomUUID()}`,
      { redirect: 'manual' }
    );
    assert.equal(rResp.status, 302);

    // Edge 4: Atomic single-use OTP + invalid UUID rejected
    const formOtp = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Edge OTP Form',
        require_otp: true,
        otp_channel: 'email',
        fields_json: [{ id: 'f1', key: 'email', label: 'Email', type: 'email', required: true }],
      },
    });
    assert.equal(formOtp.status, 201);
    const otpReq = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/otp/send`, {
      method: 'POST',
      body: { tenant_slug: tenantA.slug, channel: 'email', recipient: 'edge-otp@example.com', purpose: 'form_submit' },
    });
    assert.equal(otpReq.status, 201);
    const otpId = otpReq.json.data.otp_id;
    const otpCode = otpReq.json.data.sandbox_otp_code || otpReq.json.data.sandbox_code || otpReq.json.data.code_preview;
    assert.ok(otpCode, 'Sandbox OTP code must be returned when OUTBOUND_SILENT_MODE=true');

    const badVerify = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/forms/${formOtp.json.data.public_token}/submit`, {
      method: 'POST',
      body: { data: { email: 'edge-otp@example.com' }, otp_id: 'not-uuid', otp_code: otpCode },
    });
    assert.ok([400, 422].includes(badVerify.status));

    const okSub1 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/forms/${formOtp.json.data.public_token}/submit`, {
      method: 'POST',
      body: { data: { email: 'edge-otp@example.com' }, otp_id: otpId, otp_code: otpCode },
    });
    assert.equal(okSub1.status, 201);
    const replaySub = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/forms/${formOtp.json.data.public_token}/submit`, {
      method: 'POST',
      body: { data: { email: 'edge-otp@example.com' }, otp_id: otpId, otp_code: otpCode },
    });
    assert.equal(replaySub.status, 422);

    // Edge 5: Bresenham ab_split_ratio: 50 over 3 contacts sends A/B evenly [2, 1]
    const abAud = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'AB Split 3 Contacts', audience_type: 'static' },
    });
    const abLeadIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const lr = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { name: `AB User ${i}`, email: `ab-edge-${i}@example.com` },
      });
      abLeadIds.push(lr.json.data.id);
    }
    await apiRequest(harness.baseUrl, `/api/v1/audiences/${abAud.json.data.id}/members`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { lead_ids: abLeadIds },
    });
    const abCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'AB Edge Campaign',
        channel: 'email',
        audience_id: abAud.json.data.id,
        subject: 'Variant A',
        html_body: '<p>A</p>',
        ab_test_enabled: true,
        subject_b: 'Variant B',
        ab_split_ratio: 50,
      },
    });
    assert.equal(abCamp.status, 201);
    const abSend = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${abCamp.json.data.id}/send`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(abSend.status, 200);
    await withTenantTransaction(tenantA.id, async (client) => {
      const r = await client.query<{ variant: string; cnt: number }>(
        `SELECT COALESCE(variant, 'A') AS variant, COUNT(*)::int AS cnt
         FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2
         GROUP BY COALESCE(variant, 'A')`,
        [tenantA.id, abCamp.json.data.id]
      );
      const map = new Map(r.rows.map((x) => [x.variant, Number(x.cnt)]));
      assert.equal(map.get('A'), 2);
      assert.equal(map.get('B'), 1);
    });

    // Edge 6: rule.negate: true safely handles NULL columns & cf.* fields
    const negRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        segment_rules: {
          logic: 'AND',
          rules: [{ field: 'source', operator: 'equals', value: 'NonExistentSource', negate: true }],
        },
      },
    });
    assert.equal(negRes.status, 200);
    assert.ok(negRes.json.data.count >= 3, 'negate: true must NOT drop NULL-source leads');

    // Edge 7: Deep merge nested custom_fields preserves sibling keys
    await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Merge Contact', email: 'deep.merge@example.com', custom_fields: { profile: { tier: 'gold', city: 'HN' } } },
    });
    const m2Res = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Merge Contact', email: 'deep.merge@example.com', custom_fields: { profile: { tier: 'platinum' } } },
    });
    assert.equal(m2Res.status, 200);
    assert.equal(m2Res.json.data.custom_fields?.profile?.tier, 'platinum');
    assert.equal(m2Res.json.data.custom_fields?.profile?.city, 'HN', 'Sibling nested custom_fields subkeys must survive merge');

    // Edge 8b: POST /flows/:id/restore-snapshot non-UUID check + version bump + snapshot append
    const fl = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Restore Flow', trigger_type: 'form_submit', steps_json: [{ id: 's1', type: 'trigger', title: 'V1' }] },
    });
    const flId = fl.json.data.id;
    const pub1 = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flId}/publish`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { steps_json: [{ id: 's1', type: 'trigger', title: 'V1' }, { id: 's2', type: 'send_email', title: 'Mail' }] },
    });
    assert.equal(pub1.status, 200);

    const badRestore = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flId}/restore-snapshot`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { snapshot_id: 'not-a-uuid' },
    });
    assert.equal(badRestore.status, 404);

    const snaps = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    const snapId = snaps.json.data.snapshots?.[0]?.id;
    assert.ok(snapId);
    const okRestore = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flId}/restore-snapshot`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { snapshot_id: snapId },
    });
    assert.equal(okRestore.status, 200);
    assert.ok(Number(okRestore.json.data.version) > Number(pub1.json.data.version || 1));
  });

  it('6. Regression T3-04 (Re-entrant Dynamic Audience Deadlock) & T3-10 (VN ZNS Phone Suppression 0xxx <-> 84xxx)', async () => {
    // T3-04: Re-entrant evaluateAllDynamicAudiencesForTenant via track(identify) -> dynamic_logic -> audience.entered -> add_remove_tag -> marketing.engaged
    const dynAud = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'T3-04 High Score Dynamic',
        audience_type: 'dynamic_logic',
        filter_branches: [
          { join: 'AND', rules: [{ field: 'lead_score', operator: 'gte', value: 10 }] },
        ],
      },
    });
    assert.equal(dynAud.status, 201);

    const tagFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'T3-04 Tag On Dynamic Enter',
        trigger_type: 'audience_joined',
        trigger_config: { audience_id: dynAud.json.data.id },
        status: 'published',
        steps_json: [
          {
            id: 'tag_1',
            type: 'add_remove_tag',
            title: 'Gắn nhãn Reentrant Safe',
            config: { mode: 'add', tags: ['reentrant-safe'] },
          },
        ],
      },
    });
    assert.equal(tagFlow.status, 201);

    const webProp = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/properties', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'T3-04 Site', domain: 't304.domation.test' },
    });
    assert.equal(webProp.status, 201);
    const siteKey = webProp.json.data.site_key;

    const trackResp = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_id: 'vis_t304_01',
        event_type: 'pageview',
        page_url: 'https://t304.domation.test/pricing',
        identify: {
          name: 'T3-04 Lead',
          email: 't304.reentrant@example.com',
          phone: '0906667788',
        },
      },
    });
    assert.equal(trackResp.status, 201);
    assert.ok(trackResp.json.data.lead_id);

    await withTenantTransaction(tenantA.id, async (client) => {
      const tRes = await client.query<{ name: string }>(
        `SELECT t.name FROM lead_tags lt
         INNER JOIN tenant_tags t ON t.tenant_id = lt.tenant_id AND t.id = lt.tag_id
         WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
        [tenantA.id, trackResp.json.data.lead_id]
      );
      assert.ok(
        tRes.rows.some((r) => r.name === 'reentrant-safe'),
        'Flow triggered by dynamic audience must complete tag assignment without deadlocking'
      );
    });

    // T3-10: Suppress 0909900011 via suppression/list -> lead stored as 84909900011 must be skipped in ZNS campaign & flow
    const supLead = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'ZNS Suppressed Lead', phone: '0909900011', email: 't310.sup@example.com' },
    });
    assert.equal(supLead.status, 201);
    const supLeadId = supLead.json.data.id;

    const supAdd = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/suppression/list', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { channel: 'zns', recipient: '0909900011', reason: 't310_test' },
    });
    assert.equal(supAdd.status, 201);
    assert.equal(supAdd.json.data.recipient, '84909900011');

    const t310Aud = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'T3-10 Aud', audience_type: 'static' },
    });
    await apiRequest(harness.baseUrl, `/api/v1/audiences/${t310Aud.json.data.id}/members`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { lead_ids: [supLeadId] },
    });

    const znsDispatchedPhones: string[] = [];
    process.env.OUTBOUND_SILENT_MODE = 'false';
    setZnsTransportForTesting(async (req) => {
      znsDispatchedPhones.push(req.body.phone);
      return { sent: true, messageId: 'zns_t310_unexpected' };
    });

    const znsCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'T3-10 ZNS Camp', channel: 'zns', audience_id: t310Aud.json.data.id },
    });
    assert.equal(znsCamp.status, 201);
    const znsCampSend = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${znsCamp.json.data.id}/send`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(znsCampSend.status, 200);
    assert.equal(znsCampSend.json.data.newly_sent, 0);
    assert.ok(znsCampSend.json.data.suppressed_skipped >= 1);

    const znsFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'T3-10 ZNS Flow',
        trigger_type: 'manual_enroll',
        status: 'published',
        steps_json: [{ id: 'z_sup', type: 'send_zns', title: 'Suppressed ZNS', config: { template_id: '311220' } }],
      },
    });
    const znsFlowOut = await executeFlowForLead(tenantA.id, znsFlow.json.data.id, supLeadId, { skipWaitDelay: true });
    assert.equal(znsFlowOut.status, 'completed');
    assert.equal(znsDispatchedPhones.length, 0, 'Suppressed VN phone must NOT receive ZNS via campaign or flow');
    process.env.OUTBOUND_SILENT_MODE = 'true';
  });

  it('7. Iteration 2 Remediation: Compat RBAC, Post-Commit PUT /subscribers/:id, SQL Column Parity, custom_events.php PUT, UUID 404, Segment XOR, Static List, ZNS Opt-Out/sent_today, Multi-Page Meta, Estimate-Reach +84, Visitor lead_id & flows?id=.steps', async () => {
    // 7a. RBAC 403 enforcement on mutating compat endpoints for manager (delete: false) and view-only custom role
    const mgrCreate = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        full_name: 'M2 Manager',
        email: 'm2.manager@m2-alpha.vn',
        password: 'SecurePassword123!',
        role: 'manager',
      },
    });
    assert.equal(mgrCreate.status, 201);
    const mgrLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: tenantA.slug,
      body: { email: 'm2.manager@m2-alpha.vn', password: 'SecurePassword123!' },
    });
    assert.equal(mgrLogin.status, 200);
    const mgrToken = mgrLogin.json.data.access_token;

    const viewRoleRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/roles', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Marketing View Only',
        role_key: 'mkt_view_only_test',
        default_data_scope: 'company',
        permissions: [
          'audiences',
          'mkt_campaigns',
          'mkt_flows',
          'mkt_social_bot',
          'mkt_web_tracking',
          'mkt_templates',
          'mkt_forms',
        ].map((module_key) => ({
          module_key,
          data_scope: 'company',
          actions: { view: true, create: false, edit: false, delete: false },
        })),
      },
    });
    assert.equal(viewRoleRes.status, 201);
    const viewUserRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        full_name: 'M2 Viewer',
        email: 'm2.viewer@m2-alpha.vn',
        password: 'SecurePassword123!',
        role: 'sale',
        role_id: viewRoleRes.json.data.id,
      },
    });
    assert.equal(viewUserRes.status, 201);
    const viewLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: tenantA.slug,
      body: { email: 'm2.viewer@m2-alpha.vn', password: 'SecurePassword123!' },
    });
    assert.equal(viewLogin.status, 200);
    const viewToken = viewLogin.json.data.access_token;

    // Seed target records for RBAC, flows.php, campaigns, custom_events, subscribers
    const subCreate = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Compat Sub Target',
        email: 'compat.sub@example.com',
        phone: '0903111222',
        custom_fields: { profile: { tier: 'silver', region: 'HCM' } },
      },
    });
    assert.equal(subCreate.status, 201);
    const subId = subCreate.json.data.id;

    const flowRbac = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Compat Detail Flow',
        trigger_type: 'form_submitted',
        status: 'active',
        steps: [
          { id: 'step_trig_1', type: 'trigger', title: 'Form Submit', config: { type: 'form' } },
          { id: 'step_mail_1', type: 'send_email', title: 'Send Welcome', config: { subject: 'Welcome' } },
        ],
      },
    });
    assert.equal(flowRbac.status, 201);
    const compatFlowId = flowRbac.json.data.id;

    const campUnsub = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Unsub Compat Camp', channel: 'email', subject: 'S', html_body: '<p>Hi</p>' },
    });
    assert.equal(campUnsub.status, 201);
    const unsubCampId = campUnsub.json.data.id;
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, variant, status)
         VALUES ($1, $2, $3, $4, 'email', 'A', 'unsubscribed')`,
        [crypto.randomUUID(), tenantA.id, unsubCampId, subId]
      );
      await client.query(
        `INSERT INTO mkt_flow_enrollments (id, tenant_id, flow_id, lead_id, current_step_id, status)
         VALUES ($1, $2, $3, $4, 'step_mail_1', 'failed')`,
        [crypto.randomUUID(), tenantA.id, compatFlowId, subId]
      );
    });

    // Manager (delete: false) must receive 403 on all delete/cleanup compat endpoints
    const mgrDeleteChecks = await Promise.all([
      apiRequest(harness.baseUrl, `/api/v1/myerp/subscribers/${subId}`, { method: 'DELETE', token: mgrToken, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/flows.php?route=empty-trash', { method: 'DELETE', token: mgrToken, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/flows.php?route=bulk-delete', { method: 'POST', token: mgrToken, tenantSlug: tenantA.slug, body: { ids: [compatFlowId] } }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/campaigns.php?route=delete_unsubscribed&id=${unsubCampId}`, { method: 'POST', token: mgrToken, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/lists.php?route=cleanup', { method: 'POST', token: mgrToken, tenantSlug: tenantA.slug, body: { targetId: crypto.randomUUID(), mode: 'execute' } }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/zalo_oa', { method: 'DELETE', token: mgrToken, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/zalo_audience?id=${crypto.randomUUID()}`, { method: 'DELETE', token: mgrToken, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/ai_training.php?action=bulk_delete', { method: 'POST', token: mgrToken, tenantSlug: tenantA.slug, body: { ids: [crypto.randomUUID()] } }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/bulk_operations', { method: 'POST', token: mgrToken, tenantSlug: tenantA.slug, body: { type: 'delete', ids: [subId] } }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/upload?route=delete&id=${crypto.randomUUID()}`, { method: 'GET', token: mgrToken, tenantSlug: tenantA.slug }),
    ]);
    for (const r of mgrDeleteChecks) {
      assert.equal(r.status, 403, `Expected 403 for manager delete compat call, got ${r.status}`);
    }

    // View-only role must receive 403 on create/edit compat mutations
    const viewerMutationChecks = await Promise.all([
      apiRequest(harness.baseUrl, `/api/v1/myerp/subscribers/${subId}`, { method: 'PUT', token: viewToken, tenantSlug: tenantA.slug, body: { name: 'Blocked' } }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/campaigns.php?route=rename&id=${unsubCampId}`, { method: 'POST', token: viewToken, tenantSlug: tenantA.slug, body: { name: 'Blocked' } }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/flows.php?route=duplicate&id=${compatFlowId}`, { method: 'POST', token: viewToken, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/ai_scenarios.php?action=toggle&id=${crypto.randomUUID()}`, { method: 'POST', token: viewToken, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/ai_chatbot.php?action=send_human_reply&id=${crypto.randomUUID()}`, { method: 'POST', token: viewToken, tenantSlug: tenantA.slug, body: { content: 'hi' } }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/lists?route=create_with_filter', { method: 'POST', token: viewToken, tenantSlug: tenantA.slug, body: { name: 'No' } }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/web_blacklist', { method: 'POST', token: viewToken, tenantSlug: tenantA.slug, body: { ip: '1.2.3.4' } }),
    ]);
    for (const r of viewerMutationChecks) {
      assert.equal(r.status, 403, `Expected 403 for view-only user on mutating compat route, got ${r.status}`);
    }

    // 7b. PUT /api/v1/myerp/subscribers/:id post-commit lead.updated (with active dynamic_logic audience) + deep merge
    const putSub = await apiRequest(harness.baseUrl, `/api/v1/myerp/subscribers/${subId}`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { custom_fields: { profile: { tier: 'gold' } } },
    });
    assert.equal(putSub.status, 200);
    assert.equal(putSub.json.data.custom_fields?.profile?.tier, 'gold');
    assert.equal(putSub.json.data.custom_fields?.profile?.region, 'HCM', 'Sibling nested custom_fields key must be preserved');

    // 7c. flows.php sub-routes (enrolled_at) & GET flows?id= / flows.php?id= .steps compat payload
    for (const subRoute of ['participants', 'step-errors', 'step-unsubscribes', 'inactive-users', 'history', 'export-history']) {
      const fr = await apiRequest(harness.baseUrl, `/api/v1/myerp/flows.php?route=${subRoute}&id=${compatFlowId}`, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      });
      assert.equal(fr.status, 200, `flows.php?route=${subRoute} must return 200`);
    }
    for (const flowPath of [
      `/api/v1/myerp/flows?id=${compatFlowId}`,
      `/api/v1/myerp/automation/flows.php?id=${compatFlowId}`,
      `/api/v1/myerp/flows/${compatFlowId}`,
    ]) {
      const fDetail = await apiRequest(harness.baseUrl, flowPath, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      });
      assert.equal(fDetail.status, 200);
      assert.ok(Array.isArray(fDetail.json.data?.steps), `${flowPath} must return top-level steps array`);
      assert.equal(fDetail.json.data.steps.length, 2, `${flowPath} must preserve both flow steps`);
    }

    // 7d. campaigns?route=unsubscribed_list (sc.claimed_at)
    const unsubListRes = await apiRequest(harness.baseUrl, `/api/v1/myerp/campaigns?route=unsubscribed_list&id=${unsubCampId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(unsubListRes.status, 200);
    assert.equal(unsubListRes.json.data.items.length, 1);
    assert.ok(unsubListRes.json.data.items[0].unsubscribed_at);

    // 7e. PUT /automation/custom_events.php & purchase_events.php
    const ceCreate = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms/events', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { event_name: 'Compat Event V1', event_category: 'custom' },
    });
    assert.equal(ceCreate.status, 201);
    const ceId = ceCreate.json.data.id;
    const ceUpdate = await apiRequest(harness.baseUrl, `/api/v1/myerp/automation/custom_events.php?id=${ceId}`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { event_name: 'Compat Event V2' },
    });
    assert.equal(ceUpdate.status, 200);
    assert.equal(ceUpdate.json.data.event_name, 'Compat Event V2');
    const peUpdate = await apiRequest(harness.baseUrl, `/api/v1/myerp/automation/purchase_events.php?id=${ceId}`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { event_name: 'Compat Purchase V3' },
    });
    assert.equal(peUpdate.status, 200);

    // 7f. Non-UUID 404 checks (never 500)
    const nonUuid404s = await Promise.all([
      apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/not-a-uuid/pause', { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/not-a-uuid/resume', { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/template_groups/not-a-uuid', { method: 'PUT', token: tenantA.token, tenantSlug: tenantA.slug, body: { name: 'X' } }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/otp_profiles/not-a-uuid', { method: 'PUT', token: tenantA.token, tenantSlug: tenantA.slug, body: { name: 'X' } }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/otp_profiles/not-a-uuid', { method: 'DELETE', token: tenantA.token, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/flows.php?route=participants&id=not-a-uuid', { token: tenantA.token, tenantSlug: tenantA.slug }),
      apiRequest(harness.baseUrl, '/api/v1/myerp/subscribers/not-a-uuid', { token: tenantA.token, tenantSlug: tenantA.slug }),
    ]);
    for (const r of nonUuid404s) {
      assert.equal(r.status, 404, `Non-UUID check expected 404, got ${r.status}`);
    }

    // 7g. Segment compiler XOR: tag not_in + negate:true matches tagged lead; has_email is_empty + negate:true
    const xorTagRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/tags', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'vip-xor', color_hex: '#1E40FF' },
    });
    assert.equal(xorTagRes.status, 201);
    await apiRequest(harness.baseUrl, '/api/v1/myerp/subscribers?route=bulk-add-tag', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { ids: [subId], tag_id: xorTagRes.json.data.id },
    });
    const xorPreview = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'tag', operator: 'not_in', value: 'vip-xor', negate: true },
              { field: 'has_email', operator: 'is_empty', negate: true },
              { field: 'sla_breached', operator: 'not_equals', value: true, negate: false },
            ],
          },
        ],
      },
    });
    assert.equal(xorPreview.status, 200);
    assert.ok(xorPreview.json.data.count >= 1, 'tag not_in + negate:true XOR must match tagged lead');

    // 7h. lists?route=create_with_filter stays static_data
    const staticFiltered = await apiRequest(harness.baseUrl, '/api/v1/myerp/lists?route=create_with_filter', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Filtered Static List',
        criteria: [{ field: 'email', operator: 'contains', value: 'compat.sub@example.com' }],
      },
    });
    assert.equal(staticFiltered.status, 201);
    assert.equal(staticFiltered.json.data.audience_type, 'static_data');
    assert.ok(staticFiltered.json.data.populated_count >= 1);

    // 7i. ZNS explicit recipient zns_consent='opted_out' ('0...' vs '84...') + sent_today single-count + invalid audience_id 400
    const optOutLead = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'ZNS Opted Out', phone: '0909555666', email: 'zns.optout@example.com' },
    });
    assert.equal(optOutLead.status, 201);
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query("UPDATE leads SET zns_consent = 'opted_out' WHERE tenant_id = $1 AND id = $2", [
        tenantA.id,
        optOutLead.json.data.id,
      ]);
      // Ensure OA config exists with sent_today = 0 for accurate delta check
      await client.query(
        `UPDATE mkt_zalo_oa_configs SET sent_today = 0 WHERE tenant_id = $1`,
        [tenantA.id]
      );
    });
    const znsSentPhones: string[] = [];
    process.env.OUTBOUND_SILENT_MODE = 'false';
    setZnsTransportForTesting(async (req) => {
      znsSentPhones.push(req.body.phone);
      return { ok: true, status: 200, errorCode: 0, data: { msg_id: `zns_live_${znsSentPhones.length}` } };
    });
    const bcastOptOut = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-broadcast', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        template_id: '311220',
        recipients: [
          { phone: '84909555666', template_data: { customer_name: 'OptOut' } },
          { phone: '0912345678', template_data: { customer_name: 'Allowed' } },
        ],
      },
    });
    assert.equal(bcastOptOut.status, 200);
    assert.equal(bcastOptOut.json.data.sent_count, 1);
    assert.deepEqual(znsSentPhones, ['84912345678']);

    await withTenantTransaction(tenantA.id, async (client) => {
      const oaRes = await client.query<{ sent_today: number }>(
        'SELECT sent_today FROM mkt_zalo_oa_configs WHERE tenant_id = $1 LIMIT 1',
        [tenantA.id]
      );
      if (oaRes.rows[0]) {
        assert.equal(Number(oaRes.rows[0].sent_today), 1, 'Live zalo-broadcast must increment sent_today exactly once per send');
      }
    });
    const badBcastAud = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-broadcast', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { template_id: '311220', audience_id: 'not-a-uuid' },
    });
    assert.equal(badBcastAud.status, 400);
    process.env.OUTBOUND_SILENT_MODE = 'true';

    // 7j. Multi-page Meta Messenger webhook verifies X-Hub-Signature-256 against entry[0].id (page_2)
    const putMultiMeta = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/messenger-config', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        pages: [
          { page_id: 'page_1', page_name: 'Page One', page_access_token: 'tok_p1', app_secret: 'sec_p1', verify_token: 'vt_1', is_active: true },
          { page_id: 'page_2', page_name: 'Page Two', page_access_token: 'tok_p2', app_secret: 'sec_p2', verify_token: 'vt_2', is_active: true },
        ],
      },
    });
    assert.equal(putMultiMeta.status, 200);
    const page2Body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: 'page_2',
          time: Date.now(),
          messaging: [{ sender: { id: 'psid_p2_user' }, recipient: { id: 'page_2' }, message: { mid: 'm_p2', text: 'Chào page 2' } }],
        },
      ],
    });
    const page2Sig = 'sha256=' + crypto.createHmac('sha256', 'sec_p2').update(page2Body).digest('hex');
    const page2Hook = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/social/inbound/${tenantA.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': page2Sig },
      body: page2Body,
    });
    assert.equal(page2Hook.status, 200);

    // 7k. estimate-reach +84... phone normalization
    const plusLead1 = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Plus84 Suppressed Lead', phone: '0909666555', email: 'plus84.sup@example.com' },
    });
    const plusLead3 = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Plus84 Suppressed Entry', phone: '0909666444', email: 'plus84.sup2@example.com' },
    });
    const plusLead2 = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Plus84 Allowed', phone: '0912345000', email: 'plus84.ok@example.com' },
    });
    assert.equal(plusLead1.status, 201);
    assert.equal(plusLead2.status, 201);
    assert.equal(plusLead3.status, 201);
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query("UPDATE leads SET phone = '+84909666555' WHERE tenant_id = $1 AND id = $2", [
        tenantA.id,
        plusLead1.json.data.id,
      ]);
      await client.query(
        `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
         VALUES ($1, $2, 'zns', '+84909666444', 'plus84_raw'), ($3, $2, 'zns', '0909666555', 'plus84_lead')
         ON CONFLICT (tenant_id, channel, recipient) DO NOTHING`,
        [crypto.randomUUID(), tenantA.id, crypto.randomUUID()]
      );
    });
    const estAud = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Estimate +84 Aud', audience_type: 'static_data' },
    });
    assert.equal(estAud.status, 201);
    await apiRequest(harness.baseUrl, `/api/v1/audiences/${estAud.json.data.id}/members`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { lead_ids: [plusLead1.json.data.id, plusLead2.json.data.id, plusLead3.json.data.id] },
    });
    const estPlus = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/estimate-reach', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { channel: 'zns', listIds: [estAud.json.data.id] },
    });
    assert.equal(estPlus.status, 200);
    assert.equal(estPlus.json.data.count, 1);

    // 7l. GET /api/v1/marketing/web-tracking/visitors/:sessionId returns lead_id on events
    const wtList = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/live-traffic', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(wtList.status, 200);
    const sessId = wtList.json.data.active_visitors?.[0]?.id;
    assert.ok(sessId, 'Expected at least one tracked web session from Test 6');
    const visDetail = await apiRequest(harness.baseUrl, `/api/v1/marketing/web-tracking/visitors/${sessId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(visDetail.status, 200);
    assert.ok(visDetail.json.data.events.length >= 1);
    assert.ok(visDetail.json.data.events[0].lead_id, 'web-tracking visitor event must include lead_id');

    // 7m. M2-REQ gaps: match-domation-sync (Match-Only), /automation/campaigns?route=rename|clear_attachments, /automation/flows?route=sync, otp_profiles name persistence
    const syncAudCreate = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Compat Sync Data Audience',
        audience_type: 'sync_data',
        sync_config: { crm_source: 'autodata' },
      },
    });
    assert.equal(syncAudCreate.status, 201);
    const syncAudId = syncAudCreate.json.data.id;

    const syncBridgeRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/contacts/match-domation-sync', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        contacts: [{ email: 'unmatched-match-only@example.com' }],
      },
    });
    assert.equal(syncBridgeRes.status, 200);
    const syncData = syncBridgeRes.json.data || {};
    const totalMatched =
      Number(syncData.matched_subscribers ?? 0) +
      Number(syncData.matched_activities ?? 0) +
      Number(syncData.matched_flows ?? 0) +
      Number(syncData.matched_visitors ?? 0);
    assert.ok(totalMatched >= 1, `match-domation-sync must return non-zero matched counts, got ${JSON.stringify(syncData)}`);
    assert.ok(Number(syncData.unmatched_skipped) >= 1, 'unmatched contact must increment unmatched_skipped');
    assert.ok(Number(syncData.sync_audiences_refreshed) >= 1, 'active sync_data audience must be refreshed');

    const syncAudList = await apiRequest(harness.baseUrl, '/api/v1/audiences?audience_type=sync_data', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(syncAudList.status, 200);
    const refreshedAud = (syncAudList.json.data.items || []).find((a: any) => a.id === syncAudId);
    assert.ok(refreshedAud?.last_evaluated_at, 'match-domation-sync must stamp tenant_audiences.last_evaluated_at');

    const attCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Compat Attachments Camp',
        channel: 'email',
        subject_a: 'With Attachment',
        fallback_vars: { customer_name: 'Quý khách VIP' },
        attachments: [{ name: 'brochure.pdf', url: 'https://example.com/brochure.pdf' }],
      },
    });
    assert.equal(attCamp.status, 201);
    const attCampId = attCamp.json.data.id;

    const renameCompat = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/campaigns?route=rename', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { id: attCampId, name: 'Renamed Via Automation Path' },
    });
    assert.equal(renameCompat.status, 200);
    assert.equal(renameCompat.json.data.name, 'Renamed Via Automation Path');

    const clearAtt = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/campaigns?route=clear_attachments', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { id: attCampId },
    });
    assert.equal(clearAtt.status, 200);
    const campDetailAfterClear = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${attCampId}/detail`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(campDetailAfterClear.status, 200);
    assert.deepEqual(campDetailAfterClear.json.data.campaign.attachments, []);
    assert.equal(
      campDetailAfterClear.json.data.campaign.fallback_vars?.customer_name,
      'Quý khách VIP',
      'clear_attachments must preserve non-attachment fallback_vars'
    );

    const clearAttMissing = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/campaigns?route=clear_attachments', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { id: crypto.randomUUID() },
    });
    assert.equal(clearAttMissing.status, 404);

    const flowSyncGet = await apiRequest(harness.baseUrl, `/api/v1/myerp/automation/flows?route=sync&id=${compatFlowId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(flowSyncGet.status, 200);
    assert.equal(flowSyncGet.json.data.id, compatFlowId);
    assert.equal(flowSyncGet.json.data.name, 'Compat Detail Flow');
    assert.ok(Array.isArray(flowSyncGet.json.data.steps) && flowSyncGet.json.data.steps.length === 2);

    const flowSyncMissing = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/automation/flows?route=sync&id=${crypto.randomUUID()}`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(flowSyncMissing.status, 404);

    const otpCreate = await apiRequest(harness.baseUrl, '/api/v1/myerp/otp_profiles', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'OTP-Profile-Compat', token_length: 6, ttl_seconds: 300 },
    });
    assert.equal(otpCreate.status, 201);
    const otpList = await apiRequest(harness.baseUrl, '/api/v1/myerp/otp_profiles', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(otpList.status, 200);
    assert.ok(
      (otpList.json.data.items || []).some((p: any) => p.name === 'OTP-Profile-Compat'),
      'GET /otp_profiles must return persisted profile with name property'
    );

    // 7n. Wave 2B Secondary Audit Regressions:
    //     (a) /myerp/marketing/meta/ad-preview real meta_ads_insights columns
    //     (b) /myerp/automation/ai_org_users.php real users+tenant_user_profiles status
    //     (c) /crm-360/contacts ad_name/campaign_name enrichment without LATERAL
    //     (d) /crm-360/contacts/:id/omnichannel-journey real voucher/web/social columns & SAVEPOINT safety
    //     (e) Birthday flow cron (e.enrolled_at instead of nonexistent e.created_at)
    const nowUtc = new Date();
    const todayMmDd = `${String(nowUtc.getUTCMonth() + 1).padStart(2, '0')}-${String(nowUtc.getUTCDate()).padStart(2, '0')}`;
    const bdayContact = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Audit Omni Contact',
        phone: '0909741852',
        email: 'audit.omni@test.vn',
        custom_fields: { birthday: `1994-${todayMmDd}` },
      },
    });
    assert.equal(bdayContact.status, 201);
    const omniLeadId = String(bdayContact.json.data.id);

    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query('UPDATE leads SET ad_id = $3 WHERE tenant_id = $1 AND id = $2', [
        tenantA.id,
        omniLeadId,
        'ad_audit_7n',
      ]);
      await client.query(
        `INSERT INTO meta_ads_insights (id, tenant_id, ad_account_id, ad_id, ad_name, campaign_id, campaign_name, date_start, date_stop, spend, impressions, clicks, meta_leads)
         VALUES ($1, $2, 'act_7n', 'ad_audit_7n', 'Audit Old Ad', 'cmp_7n', 'Audit Old Camp', '2026-10-01', '2026-10-01', 100, 10, 1, 1),
                ($3, $2, 'act_7n', 'ad_audit_7n', 'Audit Latest Ad', 'cmp_7n', 'Audit Latest Camp', '2026-11-18', '2026-11-18', 250, 25, 3, 7)`,
        [crypto.randomUUID(), tenantA.id, crypto.randomUUID()]
      );
      await client.query(
        `INSERT INTO mkt_social_conversations (id, tenant_id, channel, external_thread_id, customer_name, lead_id, status, last_message_preview)
         VALUES ($1, $2, 'web_chat', 'thr_audit_7n', 'Audit Chat Guest', $3, 'open', 'Need quote')`,
        [crypto.randomUUID(), tenantA.id, omniLeadId]
      );
    });

    const crmList = await apiRequest(harness.baseUrl, '/api/v1/crm-360/contacts?search=audit.omni%40test.vn', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(crmList.status, 200);
    const crmLeadRow = (crmList.json.data.items || []).find((x: any) => x.id === omniLeadId);
    assert.equal(crmLeadRow?.ad_name, 'Audit Latest Ad');
    assert.equal(crmLeadRow?.campaign_name, 'Audit Latest Camp');

    const adPreviewRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/myerp/marketing/meta/ad-preview?ad_id=ad_audit_7n',
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(adPreviewRes.status, 200);
    assert.equal(adPreviewRes.json.data.found, true);
    assert.equal(adPreviewRes.json.data.ad_name, 'Audit Latest Ad');
    assert.equal(adPreviewRes.json.data.leads_count, 7);

    const aiOrgUsersRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/ai_org_users.php', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(aiOrgUsersRes.status, 200);
    assert.ok(Array.isArray(aiOrgUsersRes.json.data.items) && aiOrgUsersRes.json.data.items.length >= 1);
    assert.equal(typeof aiOrgUsersRes.json.data.items[0].status, 'string');

    const bdayFlowRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Audit Birthday Flow 7n',
        status: 'active',
        trigger_type: 'birthday',
        steps: [{ id: 'b1', type: 'update_lead_score', label: 'Birthday +10', config: { delta: 10 } }],
      },
    });
    assert.equal(bdayFlowRes.status, 201);
    const bdayFlowId = String(bdayFlowRes.json.data.id);
    const bdayProcessed = await runMarketingFlowsWorker(tenantA.id);
    assert.ok(bdayProcessed >= 1, `Expected birthday flow worker to process >= 1 lead, got ${bdayProcessed}`);
    const bdayFlowDetail = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${bdayFlowId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.ok(
      (bdayFlowDetail.json.data.enrollments || []).some((e: any) => e.lead_id === omniLeadId && e.status === 'completed'),
      'Expected birthday flow cron enrollment to complete using e.enrolled_at'
    );

    const omniJourneyRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/crm-360/contacts/${omniLeadId}/omnichannel-journey`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(omniJourneyRes.status, 200);
    assert.ok(
      (omniJourneyRes.json.data.conversations || []).some((c: any) => c.external_user_name === 'Audit Chat Guest'),
      'omnichannel-journey must return social conversations mapped from customer_name'
    );
    assert.ok(
      (omniJourneyRes.json.data.flow_enrollments || []).some((f: any) => f.flow_id === bdayFlowId),
      'omnichannel-journey must return flow enrollments without transaction abort'
    );
    assert.ok(
      Array.isArray(omniJourneyRes.json.data.available_flows) && omniJourneyRes.json.data.available_flows.length >= 1,
      'omnichannel-journey must return available_flows'
    );
  });
});
