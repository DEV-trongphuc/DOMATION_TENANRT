import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness } from './_harness.ts';

let harness: MarketingE2eHarness;

describe('Feature 7: Channel Adapters & AI Training RAG (E2E)', () => {
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
    // [M2-REQ] True requirement: live Zalo ZNS OpenAPI calls (business.openapi.zalo.me/message/template)
    // across zalo-broadcast, ZNS campaign dispatch & flow send_zns execution.
    it('F7-T1-01: [M2-REQ] Zalo ZNS vault + OA/templates + live OpenAPI dispatch (business.openapi.zalo.me) via broadcast, campaign & flow', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const vaultRes = await harness.apiJson('/api/v1/integrations/vault/zalo_zns', {
        method: 'PUT',
        auth,
        body: {
          access_token: 'zns_live_tok_001',
          refresh_token: 'zns_ref_001',
          oa_id: 'OA_ZNS_01',
          app_id: 'APP_ZNS_01',
        },
      });
      assert.equal(vaultRes.data.integration_type, 'zalo_zns');
      assert.equal(vaultRes.data.encryption, 'AES-256-GCM');
      assert.equal(vaultRes.data.iv_bits, 96);

      const oaRes = await harness.apiJson('/api/v1/marketing/social-bot/zalo-oa', {
        method: 'PUT',
        auth,
        body: {
          oa_id: 'OA_ZNS_01',
          oa_name: 'DOM ZNS OA',
          daily_quota: 5000,
        },
      });
      assert.equal(oaRes.data.oa_id, 'OA_ZNS_01');
      assert.equal(oaRes.data.oa_name, 'DOM ZNS OA');

      const znsTplRes = await harness.apiJson('/api/v1/marketing/social-bot/zalo-templates', {
        method: 'POST',
        auth,
        body: {
          name: 'ZNS Order Confirm',
          template_code: 'ZNS_202601',
          template_type: 'zns_transaction',
          content_body: 'Chào {{customer_name}}, đơn hàng của bạn đã được xác nhận.',
          params_schema: [{ key: 'customer_name', mapTo: 'lead.name' }],
        },
      });
      const znsTemplateId = znsTplRes.data.id;
      assert.ok(znsTemplateId);
      assert.equal(znsTplRes.data.template_code, 'ZNS_202601');

      const contactRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'ZNS Lead',
          phone: '0909111222',
          email: 'zns.lead@test.vn',
        },
      });
      const leadId = contactRes.data.id;
      assert.ok(leadId);

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'ZNS Audience',
          audience_type: 'static_data',
        },
      });
      const audienceId = audRes.data.id;
      assert.ok(audienceId);

      await harness.apiJson(`/api/v1/audiences/${audienceId}/members`, {
        method: 'POST',
        auth,
        body: { lead_ids: [leadId] },
      });

      // 1) Zalo Broadcast -> live business.openapi.zalo.me ZNS capture
      const broadcastRes = await harness.apiJson('/api/v1/marketing/social-bot/zalo-broadcast', {
        method: 'POST',
        auth,
        body: {
          template_id: znsTemplateId,
          audience_id: audienceId,
        },
      });
      assert.ok(broadcastRes.data.sent_count >= 1);
      const afterBroadcastCount = harness.zaloCapture.filter(
        (z) => z.channel === 'zns' && z.url.includes('business.openapi.zalo.me')
      ).length;
      assert.ok(
        afterBroadcastCount >= 1,
        `Expected live ZNS OpenAPI call on zalo-broadcast, got ${afterBroadcastCount}`
      );

      // 2) ZNS Campaign -> live business.openapi.zalo.me ZNS capture
      const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'ZNS Campaign E2E',
          channel: 'zns',
          audience_id: audienceId,
          zns_template_id: 'ZNS_202601',
        },
      });
      const campId = campRes.data.id;
      assert.ok(campId);

      const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.ok(sendRes.data.newly_sent >= 1);
      const afterCampaignCount = harness.zaloCapture.filter(
        (z) => z.channel === 'zns' && z.url.includes('business.openapi.zalo.me')
      ).length;
      assert.ok(
        afterCampaignCount > afterBroadcastCount,
        `Expected additional live ZNS OpenAPI call on campaign send (${afterCampaignCount} vs ${afterBroadcastCount})`
      );

      // 3) Flow send_zns node -> live business.openapi.zalo.me ZNS capture
      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'ZNS Flow E2E',
          status: 'active',
          trigger_type: 'manual_enroll',
          steps: [
            {
              id: 'zns_step_1',
              type: 'send_zns',
              label: 'Send ZNS Notice',
              config: {
                template_id: 'ZNS_202601',
                zns_template_id: 'ZNS_202601',
                subject: 'Xin chào {{lead.name}}, cảm ơn bạn đã đăng ký.',
                message: 'Xin chào {{lead.name}}, cảm ơn bạn đã đăng ký.',
              },
            },
          ],
        },
      });
      const flowId = flowRes.data.id;
      assert.ok(flowId);

      const enrollRes = await harness.apiJson(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: {
          lead_id: leadId,
          skip_wait_delay: true,
        },
      });
      assert.equal(enrollRes.data.status, 'completed');
      const afterFlowCount = harness.zaloCapture.filter(
        (z) => z.channel === 'zns' && z.url.includes('business.openapi.zalo.me')
      ).length;
      assert.ok(
        afterFlowCount > afterCampaignCount,
        `Expected additional live ZNS OpenAPI call on flow send_zns (${afterFlowCount} vs ${afterCampaignCount})`
      );
    });

    // [M2-REQ] True requirement: Meta Messenger outbound agent reply calls Graph API
    // `https://graph.facebook.com/.../messages` when Messenger vault is configured.
    it('F7-T1-02: [M2-REQ] Meta Messenger vault + /public/marketing/social/inbound/:tenantSlug + live Graph outbound reply', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const vaultRes = await harness.apiJson('/api/v1/integrations/vault/facebook_ads', {
        method: 'PUT',
        auth,
        body: {
          page_id: 'page_10001',
          page_access_token: 'EAAG_messenger_tok_001_valid_token',
          access_token: 'EAAG_messenger_tok_001_valid_token',
        },
      });
      assert.equal(vaultRes.data.integration_type, 'facebook_ads');

      const overviewRes = await harness.apiJson('/api/v1/marketing/social-bot', { auth });
      assert.equal(overviewRes.data.vault_channels?.messenger?.configured, true);

      const inboundRes = await harness.apiRaw(`/api/v1/public/marketing/social/inbound/${auth.tenantSlug}`, {
        method: 'POST',
        body: {
          channel: 'messenger',
          thread_id: 'psid_778899',
          customer_name: 'Trần Messenger',
          message: 'Cho mình xin bảng giá, sđt 0912888777',
        },
      });
      assert.equal(inboundRes.status, 201);
      const convId = inboundRes.json?.data?.conversation_id;
      assert.ok(convId);
      assert.ok(inboundRes.json?.data?.lead_id);
      assert.equal(inboundRes.json?.data?.extracted?.phone, '0912888777');
      assert.ok(String(inboundRes.json?.data?.reply || '').length > 0);

      const replyRes = await harness.apiRaw(`/api/v1/marketing/social-bot/conversations/${convId}/messages`, {
        method: 'POST',
        auth,
        body: {
          sender_type: 'agent',
          content: 'Chào anh Trần, em gửi báo giá chi tiết ạ.',
        },
      });
      assert.equal(replyRes.status, 201);

      const graphMessagesReqs = harness.mockFetch
        .getRequests('graph.facebook.com')
        .filter((r) => r.pathname.endsWith('/messages') && r.method === 'POST');
      assert.ok(
        graphMessagesReqs.some((r) => r.jsonBody?.recipient?.id === 'psid_778899'),
        `Expected live Meta Messenger Graph POST .../messages to psid_778899, got ${graphMessagesReqs.length} calls`
      );

      const detailRes = await harness.apiJson(`/api/v1/marketing/social-bot/conversations/${convId}`, { auth });
      assert.ok(detailRes.data.customer_360);
      assert.ok(Array.isArray(detailRes.data.messages) && detailRes.data.messages.length >= 3);
    });

    it('F7-T1-03: Email vault (smtp, aws_ses, resend) + templates/:id/test-send preview & quick-send real dispatch', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      // 1. SMTP vault + template + test-send preview + quick-send via SMTP capture hook
      await harness.apiJson('/api/v1/integrations/vault/smtp', {
        method: 'PUT',
        auth,
        body: {
          smtp_host: 'smtp.domation.test',
          smtp_port: 587,
          smtp_user: 'mail@domation.test',
          smtp_pass: 'SmtpSecret123!',
          from_email: 'noreply@domation.test',
          from_name: 'DOM Mail',
        },
      });

      const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Quick Send Template',
          subject: 'Hi {{lead.name}}',
          blocks: [
            {
              id: 'b1',
              type: 'text',
              content: 'Welcome {{lead.name}} to {{tenant.name}}',
            },
          ],
        },
      });
      const tplId = tplRes.data.id;
      assert.ok(tplId);

      const testSendRes = await harness.apiJson(`/api/v1/marketing/templates/${tplId}/test-send`, {
        method: 'POST',
        auth,
        body: {
          to_email: 'preview@test.vn',
          sample_name: 'Lê Preview',
        },
      });
      assert.equal(testSendRes.data.vault_configured, true);
      assert.equal(testSendRes.data.to_email, 'preview@test.vn');
      assert.ok(String(testSendRes.data.rendered_subject).includes('Lê Preview'));
      assert.ok(String(testSendRes.data.rendered_html).includes('Lê Preview'));

      await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Phạm Quick',
          email: 'quicksend@test.vn',
        },
      });

      const quickSmtp = await harness.apiJson('/api/v1/marketing/templates/quick-send', {
        method: 'POST',
        auth,
        body: {
          template_id: tplId,
          recipients: ['quicksend@test.vn'],
        },
      });
      assert.equal(quickSmtp.data.sent_count, 1);
      assert.ok(
        harness.emailCapture.some((e) => e.driver === 'smtp_hook' && e.to === 'quicksend@test.vn'),
        'Expected smtp_hook capture for quick-send'
      );

      // 2. Disable customSmtpTransport to exercise aws_ses IAM HTTP & resend via mockFetch
      try {
        harness.setSmtpCaptureEnabled(false);

        await harness.apiJson('/api/v1/integrations/vault/aws_ses', {
          method: 'PUT',
          auth,
          body: {
            accessKeyId: 'AKIA_E2E_01',
            secretAccessKey: 'SECRET_E2E_01',
            region: 'ap-southeast-1',
            from_email: 'ses@domation.test',
          },
        });

        await harness.apiJson('/api/v1/auth/tenant-settings', {
          method: 'PATCH',
          auth,
          body: {
            settings: {
              email_provider: 'ses',
            },
          },
        });

        const quickSes = await harness.apiJson('/api/v1/marketing/templates/quick-send', {
          method: 'POST',
          auth,
          body: {
            template_id: tplId,
            recipients: ['quicksend@test.vn'],
          },
        });
        assert.equal(quickSes.data.sent_count, 1);
        assert.ok(
          harness.emailCapture.some(
            (e) =>
              e.driver === 'ses' &&
              e.to === 'quicksend@test.vn' &&
              String(e.url || '').includes('email.ap-southeast-1.amazonaws.com')
          ),
          'Expected SES IAM HTTP capture via mockFetch'
        );

        await harness.apiJson('/api/v1/auth/tenant-settings', {
          method: 'PATCH',
          auth,
          body: {
            settings: {
              email_provider: 'resend',
              resend_api_key: 're_e2e_tok_001',
              resend_from_email: 'resend@domation.test',
            },
          },
        });

        const quickResend = await harness.apiJson('/api/v1/marketing/templates/quick-send', {
          method: 'POST',
          auth,
          body: {
            template_id: tplId,
            recipients: ['quicksend@test.vn'],
          },
        });
        assert.equal(quickResend.data.sent_count, 1);
        assert.ok(
          harness.emailCapture.some(
            (e) =>
              e.driver === 'resend' &&
              e.to === 'quicksend@test.vn' &&
              String(e.url || '').includes('api.resend.com/emails')
          ),
          'Expected Resend HTTP capture via mockFetch'
        );
      } finally {
        harness.setSmtpCaptureEnabled(true);
      }
    });

    it('F7-T1-04: Website Chatbot /bot-config, /scenarios, /bot-test, /conversations, bot_paused takeover & /push-lead', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Chatbot Leads', audience_type: 'static_data' },
      });
      const audId = audRes.data.id;

      const cfgRes = await harness.apiJson('/api/v1/marketing/social-bot/bot-config', {
        method: 'PUT',
        auth,
        body: {
          bot_name: 'Web Concierge',
          faq_rules: [
            {
              id: 'f1',
              keywords: ['gói enterprise'],
              question: 'Gói Enterprise giá sao?',
              answer: 'Gói Enterprise 6 triệu/tháng kèm DOM Agent.',
            },
          ],
          auto_extract_contact: true,
          routing_mode: 'audience',
          target_audience_id: audId,
          is_active: true,
        },
      });
      assert.equal(cfgRes.data.bot_name, 'Web Concierge');

      const scCreate = await harness.apiJson('/api/v1/marketing/social-bot/scenarios', {
        method: 'POST',
        auth,
        body: {
          name: 'Web Greeting',
          channel: 'web_chat',
          trigger_type: 'keyword',
          keywords: ['xin chào'],
          nodes: [{ id: 'n1', type: 'message', content: 'Hi!' }],
          edges: [],
        },
      });
      const scenarioId = scCreate.data.id;
      assert.ok(scenarioId);

      const scList = await harness.apiJson('/api/v1/marketing/social-bot/scenarios', { auth });
      assert.ok(scList.data.items.some((s: any) => s.id === scenarioId));

      const scUpdate = await harness.apiJson(`/api/v1/marketing/social-bot/scenarios/${scenarioId}`, {
        method: 'PUT',
        auth,
        body: { name: 'Web Greeting Updated', is_active: true },
      });
      assert.equal(scUpdate.data.name, 'Web Greeting Updated');

      const botTest = await harness.apiJson('/api/v1/marketing/social-bot/bot-test', {
        method: 'POST',
        auth,
        body: { message: 'Cho hỏi gói enterprise, email: lead@web.vn' },
      });
      assert.equal(botTest.data.extracted_entities.email, 'lead@web.vn');
      assert.ok(String(botTest.data.reply).includes('6 triệu'));

      const conv1 = await harness.apiJson('/api/v1/marketing/social-bot/conversations', {
        method: 'POST',
        auth,
        body: {
          channel: 'web_chat',
          external_thread_id: 'wc_001',
          customer_name: 'Khách Web',
          content: 'Tư vấn gói enterprise sđt 0933444555',
        },
      });
      const convId = conv1.data.conversation_id;
      assert.ok(convId);
      assert.equal(conv1.data.extracted_entities.phone, '0933444555');
      assert.ok(conv1.data.lead_id);
      assert.ok(String(conv1.data.bot_reply).includes('6 triệu'));

      const pauseRes = await harness.apiJson(`/api/v1/marketing/social-bot/conversations/${convId}`, {
        method: 'PATCH',
        auth,
        body: { bot_paused: true, mark_read: true },
      });
      assert.equal(pauseRes.data.bot_paused, true);
      assert.equal(pauseRes.data.unread_count, 0);

      const conv2 = await harness.apiJson('/api/v1/marketing/social-bot/conversations', {
        method: 'POST',
        auth,
        body: {
          channel: 'web_chat',
          external_thread_id: 'wc_001',
          customer_name: 'Khách Web',
          content: 'Mình hỏi thêm về gói enterprise',
        },
      });
      assert.equal(conv2.data.bot_reply, null);

      const aud2Res = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Chatbot Manual Push Audience', audience_type: 'static_data' },
      });
      const aud2Id = aud2Res.data.id;
      assert.ok(aud2Id);

      const pushRes = await harness.apiJson(`/api/v1/marketing/social-bot/conversations/${convId}/push-lead`, {
        method: 'POST',
        auth,
        body: {
          mode: 'audience',
          audience_id: aud2Id,
        },
      });
      assert.ok(pushRes.data.lead_id);
      assert.equal(pushRes.data.lead_id, conv1.data.lead_id);

      const aud2MembersRes = await harness.apiJson(`/api/v1/audiences/${aud2Id}/members`, { auth });
      assert.ok(
        (aud2MembersRes.data?.items || []).some((m: any) => m.id === pushRes.data.lead_id),
        `Expected lead ${pushRes.data.lead_id} to be inserted into target audience ${aud2Id}`
      );
      const aud2DetailRes = await harness.apiJson(`/api/v1/audiences/${aud2Id}`, { auth });
      assert.ok(Number(aud2DetailRes.data?.cached_member_count || 0) >= 1);
    });

    // [M2-REQ] True requirement: AI Training Docs (mkt_ai_training_docs) RAG must be queried
    // in live POST /social-bot/conversations AND POST /public/marketing/social/inbound/:tenantSlug.
    it('F7-T1-05: [M2-REQ] AI Training Docs (/training-docs) CRUD + RAG used in /bot-test, live /conversations & live /social/inbound', async (t) => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      await t.test('training-docs CRUD & /bot-test RAG match', async () => {
        const docCreate = await harness.apiJson('/api/v1/marketing/social-bot/training-docs', {
          method: 'POST',
          auth,
          body: {
            title: 'Sapphire Warranty Policy',
            doc_type: 'policy',
            content_text: 'Tất cả sản phẩm Sapphire được bảo hành đánh bóng trọn đời 10 năm miễn phí tại showroom.',
          },
        });
        const docId = docCreate.data.id;
        assert.ok(docId);
        assert.equal(docCreate.data.status, 'indexed');
        assert.ok(Number(docCreate.data.token_count) > 0);

        const docList = await harness.apiJson('/api/v1/marketing/social-bot/training-docs', { auth });
        assert.ok(docList.data.items.some((d: any) => d.id === docId));

        await harness.apiJson(`/api/v1/marketing/social-bot/training-docs/${docId}`, {
          method: 'PUT',
          auth,
          body: {
            content_text: 'Tất cả sản phẩm Sapphire được bảo hành đánh bóng trọn đời 12 năm miễn phí tại showroom.',
          },
        });

        const botTest = await harness.apiJson('/api/v1/marketing/social-bot/bot-test', {
          method: 'POST',
          auth,
          body: { message: 'Tell me about Sapphire Warranty Policy please' },
        });
        assert.ok(String(botTest.data.reply).includes('12 năm'));
      });

      await t.test('[M2-REQ] live POST /social-bot/conversations uses RAG training docs', async () => {
        const liveConv = await harness.apiJson('/api/v1/marketing/social-bot/conversations', {
          method: 'POST',
          auth,
          body: {
            channel: 'web_chat',
            customer_name: 'Live Web RAG',
            content: 'Cho mình hỏi Sapphire Warranty Policy bên showroom?',
          },
        });
        assert.ok(
          String(liveConv.data.bot_reply || '').includes('12 năm'),
          `Expected live /conversations RAG reply to include '12 năm', got: ${liveConv.data.bot_reply}`
        );
      });

      await t.test('[M2-REQ] live POST /public/marketing/social/inbound/:tenantSlug uses RAG training docs', async () => {
        const liveInbound = await harness.apiRaw(`/api/v1/public/marketing/social/inbound/${auth.tenantSlug}`, {
          method: 'POST',
          body: {
            channel: 'messenger',
            thread_id: 'psid_rag_01',
            customer_name: 'Live FB RAG',
            message: 'Sapphire Warranty Policy áp dụng thế nào vậy?',
          },
        });
        assert.equal(liveInbound.status, 201);
        assert.ok(
          String(liveInbound.json?.data?.reply || '').includes('12 năm'),
          `Expected live /social/inbound RAG reply to include '12 năm', got: ${liveInbound.json?.data?.reply}`
        );
      });
    });

    it('F7-T1-06: Vault POST /vault + GET /integrations/overview masking + Zalo Bot /zalo/verify & /zalo/command', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const secretBotToken = 'zalo_bot_secret_token_987654';
      const saveRes = await harness.apiJson('/api/v1/integrations/vault', {
        method: 'POST',
        auth,
        body: {
          integration_type: 'zalo_bot',
          config: {
            bot_token: secretBotToken,
            chat_id: '-100889900',
            enabled: true,
          },
        },
      });
      assert.equal(saveRes.data.encryption, 'AES-256-GCM');
      assert.equal(saveRes.data.iv_bits, 96);

      const overview = await harness.apiJson('/api/v1/integrations/overview', { auth });
      const previewToken = String(overview.data.integrations?.zalo_bot?.config_preview?.bot_token || '');
      assert.ok(previewToken.includes('••••'), `Expected masked bot_token preview, got: ${previewToken}`);
      assert.equal(previewToken.includes(secretBotToken), false);

      const verifySandbox = await harness.apiJson('/api/v1/integrations/zalo/verify', {
        method: 'POST',
        auth,
        body: {
          verify_mode: 'sandbox',
          bot_token: 'demo_zalobot_token',
          chat_id: '-100889900',
        },
      });
      assert.equal(verifySandbox.data.verified, true);

      const verifyLive = await harness.apiJson('/api/v1/integrations/zalo/verify', {
        method: 'POST',
        auth,
        body: {
          verify_mode: 'live',
          bot_token: secretBotToken,
          chat_id: '-100889900',
          send_test_message: true,
        },
      });
      assert.equal(verifyLive.data.verified, true);
      assert.equal(verifyLive.data.verification_mode, 'live_zalo_api');
      assert.ok(harness.zaloCapture.some((z) => z.channel === 'zalo_bot'));

      const cmdRes = await harness.apiJson('/api/v1/integrations/zalo/command', {
        method: 'POST',
        auth,
        body: {
          chat_id: '-100889900',
          text: '/chatid',
        },
      });
      assert.equal(cmdRes.data.handled, true);
      assert.equal(cmdRes.data.command, '/chatid');
      assert.ok(String(cmdRes.data.replyText).includes('-100889900'));
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (6 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    // Note: Vault (smtp) preserves '••••••••', '' and '********', whereas PATCH /api/v1/auth/tenant-settings
    // preserves '••••••••' strictly for resend_api_key (auth.routes.ts:1893).
    it('F7-T2-01: preserves masked secrets on Vault SMTP (•••••••• / empty / ***) & Tenant Settings Resend (•••••••• only)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      await harness.apiJson('/api/v1/integrations/vault/smtp', {
        method: 'PUT',
        auth,
        body: {
          smtp_host: 'smtp1.domation.test',
          smtp_port: 587,
          smtp_user: 'mailer@test.vn',
          smtp_pass: 'RealSmtpSecret999!',
          from_email: 'mailer@test.vn',
        },
      });

      const overview = await harness.apiJson('/api/v1/integrations/overview', { auth });
      const maskedPass = String(overview.data.integrations?.smtp?.config_preview?.smtp_pass || '');
      assert.ok(maskedPass.includes('••••'));
      assert.equal(maskedPass.includes('RealSmtpSecret999!'), false);

      // Update with masked preview, then empty string, then asterisks
      await harness.apiJson('/api/v1/integrations/vault/smtp', {
        method: 'PUT',
        auth,
        body: {
          smtp_host: 'smtp2.domation.test',
          smtp_port: 465,
          smtp_user: 'mailer@test.vn',
          smtp_pass: maskedPass,
          from_email: 'mailer@test.vn',
        },
      });
      await harness.apiJson('/api/v1/integrations/vault/smtp', {
        method: 'PUT',
        auth,
        body: {
          smtp_host: 'smtp2.domation.test',
          smtp_port: 465,
          smtp_user: 'mailer@test.vn',
          smtp_pass: '',
          from_email: 'mailer@test.vn',
        },
      });
      await harness.apiJson('/api/v1/integrations/vault/smtp', {
        method: 'PUT',
        auth,
        body: {
          smtp_host: 'smtp2.domation.test',
          smtp_port: 465,
          smtp_user: 'mailer@test.vn',
          smtp_pass: '********',
          from_email: 'mailer@test.vn',
        },
      });

      const quickRes = await harness.apiJson('/api/v1/marketing/templates/quick-send', {
        method: 'POST',
        auth,
        body: {
          subject: 'Preserve Check',
          recipients: ['check@test.vn'],
        },
      });
      assert.equal(quickRes.data.sent_count, 1);
      const smtpRec = harness.emailCapture.find((e) => e.driver === 'smtp_hook' && e.to === 'check@test.vn');
      assert.ok(smtpRec, 'Expected smtp_hook capture for check@test.vn');
      assert.equal(smtpRec.config?.smtp_pass, 'RealSmtpSecret999!');
      assert.equal(smtpRec.config?.smtp_host, 'smtp2.domation.test');

      // Resend API key preservation via PATCH /api/v1/auth/tenant-settings
      await harness.apiJson('/api/v1/auth/tenant-settings', {
        method: 'PATCH',
        auth,
        body: {
          settings: {
            email_provider: 'resend',
            resend_api_key: 're_preserve_secret_777',
            resend_from_email: 'resend@test.vn',
          },
        },
      });
      await harness.apiJson('/api/v1/auth/tenant-settings', {
        method: 'PATCH',
        auth,
        body: {
          settings: {
            email_provider: 'resend',
            resend_api_key: '••••••••',
          },
        },
      });

      const [overviewAfterResend, emailCfgAfterResend] = await Promise.all([
        harness.apiJson('/api/v1/integrations/overview', { auth }),
        harness.apiJson('/api/v1/integrations/email/config', { auth }),
      ]);
      assert.equal(JSON.stringify(overviewAfterResend.data).includes('re_preserve_secret_777'), false);
      assert.equal(JSON.stringify(emailCfgAfterResend.data).includes('re_preserve_secret_777'), false);

      try {
        harness.setSmtpCaptureEnabled(false);
        await harness.apiJson('/api/v1/marketing/templates/quick-send', {
          method: 'POST',
          auth,
          body: {
            subject: 'Resend Preserve Check',
            recipients: ['check-resend@test.vn'],
          },
        });
        const resendReqs = harness.mockFetch.getRequests('api.resend.com');
        assert.ok(resendReqs.length >= 1);
        assert.equal(resendReqs[0].headers.authorization, 'Bearer re_preserve_secret_777');
      } finally {
        harness.setSmtpCaptureEnabled(true);
      }
    });

    it('F7-T2-02: enforces 422 validation errors across vault, email config/test, quick-send, social-bot & public inbound', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const badVault = await harness.apiRaw('/api/v1/integrations/vault/invalid_type_xyz', {
        method: 'PUT',
        auth,
        body: { token: 'abc' },
      });
      assert.equal(badVault.status, 422);
      assert.equal(badVault.json?.error?.code, 'INVALID_INTEGRATION_TYPE');

      const badEmailTest = await harness.apiRaw('/api/v1/integrations/email/test', {
        method: 'POST',
        auth,
        body: { to_email: 'invalid-email' },
      });
      assert.equal(badEmailTest.status, 422);
      assert.equal(badEmailTest.json?.error?.code, 'EMAIL_RECIPIENT_INVALID');

      const badAppscript = await harness.apiRaw('/api/v1/integrations/email/config', {
        method: 'POST',
        auth,
        body: { appscript_webhook_url: 'http://insecure.local/exec' },
      });
      assert.equal(badAppscript.status, 422);
      assert.equal(badAppscript.json?.error?.code, 'INVALID_APPSCRIPT_URL');

      const badQuickSend = await harness.apiRaw('/api/v1/marketing/templates/quick-send', {
        method: 'POST',
        auth,
        body: { recipients: ['bad-email'] },
      });
      assert.equal(badQuickSend.status, 422);
      assert.equal(badQuickSend.json?.error?.code, 'RECIPIENTS_REQUIRED');

      const badBotTest = await harness.apiRaw('/api/v1/marketing/social-bot/bot-test', {
        method: 'POST',
        auth,
        body: { message: '   ' },
      });
      assert.equal(badBotTest.status, 422);
      assert.equal(badBotTest.json?.error?.code, 'MESSAGE_REQUIRED');

      const badConv = await harness.apiRaw('/api/v1/marketing/social-bot/conversations', {
        method: 'POST',
        auth,
        body: { content: '' },
      });
      assert.equal(badConv.status, 422);
      assert.equal(badConv.json?.error?.code, 'MESSAGE_REQUIRED');

      const badZaloTpl = await harness.apiRaw('/api/v1/marketing/social-bot/zalo-templates', {
        method: 'POST',
        auth,
        body: { name: '' },
      });
      assert.equal(badZaloTpl.status, 422);
      assert.equal(badZaloTpl.json?.error?.code, 'ZALO_TEMPLATE_NAME_REQUIRED');

      const badDoc = await harness.apiRaw('/api/v1/marketing/social-bot/training-docs', {
        method: 'POST',
        auth,
        body: { title: '  ' },
      });
      assert.equal(badDoc.status, 422);
      assert.equal(badDoc.json?.error?.code, 'DOC_TITLE_REQUIRED');

      const badInbound = await harness.apiRaw(`/api/v1/public/marketing/social/inbound/${auth.tenantSlug}`, {
        method: 'POST',
        body: { message: '' },
      });
      assert.equal(badInbound.status, 422);
      assert.equal(badInbound.json?.error?.code, 'MESSAGE_REQUIRED');
    });

    // [M2-REQ] True requirement: ZNS OAuth 401/error -124, ZNS 503, and Messenger 502 must be surfaced/logged cleanly
    // without unhandled 500s, while Resend 502 returns 422 EMAIL_DISPATCH_FAILED.
    it('F7-T2-03: [M2-REQ] handles Zalo ZNS OAuth 401/-124, ZNS 503, Messenger 502 & Resend 502 upstream failures gracefully', async (t) => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      await harness.apiJson('/api/v1/integrations/vault/zalo_zns', {
        method: 'PUT',
        auth,
        body: {
          access_token: 'zns_err_tok_001',
          refresh_token: 'zns_err_ref_001',
          oa_id: 'OA_ERR_01',
        },
      });
      await harness.apiJson('/api/v1/integrations/vault/facebook_ads', {
        method: 'PUT',
        auth,
        body: {
          page_id: 'page_10001',
          page_access_token: 'EAAG_err_tok_001',
          access_token: 'EAAG_err_tok_001',
        },
      });

      const contactRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Error Lead', phone: '0909333444', email: 'errlead@test.vn' },
      });
      const leadId = contactRes.data.id;

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Err Aud', audience_type: 'static_data', lead_ids: [leadId] },
      });

      // 1. Resend 502 on /integrations/email/test (already wired; executes and passes pre-M2)
      await t.test('Resend 502 returns 422 EMAIL_DISPATCH_FAILED', async () => {
        try {
          harness.setSmtpCaptureEnabled(false);
          await harness.apiJson('/api/v1/auth/tenant-settings', {
            method: 'PATCH',
            auth,
            body: {
              settings: {
                email_provider: 'resend',
                resend_api_key: 're_err_tok_502',
              },
            },
          });
          harness.mockFetch.setFailureMode({ resendStatus: 502 });
          const emailErr = await harness.apiRaw('/api/v1/integrations/email/test', {
            method: 'POST',
            auth,
            body: { email_provider: 'resend', to_email: 'err@test.vn' },
          });
          assert.equal(emailErr.status, 422);
          assert.equal(emailErr.json?.error?.code, 'EMAIL_DISPATCH_FAILED');
        } finally {
          harness.mockFetch.resetFailureModes();
          harness.setSmtpCaptureEnabled(true);
        }
      });

      // 2. ZNS OAuth 401 / error -124 on campaign send
      await t.test('[M2-REQ] ZNS OAuth 401/-124 on campaign send records failed claim', async () => {
        const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
          method: 'POST',
          auth,
          body: {
            name: 'ZNS Err Campaign',
            channel: 'zns',
            audience_id: audRes.data.id,
            zns_template_id: 'ZNS_ERR_01',
          },
        });
        const campId = campRes.data.id;

        try {
          harness.mockFetch.setFailureMode({
            znsStatus: 401,
            znsErrorCode: -124,
            znsErrorMessage: 'Invalid OAuth access token',
          });
          const sendErrRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
            method: 'POST',
            auth,
            body: {},
          });
          assert.equal(sendErrRes.data.newly_sent, 0);
          assert.ok(
            sendErrRes.data.failed_count >= 1,
            `Expected failed_count >= 1 on ZNS 401/-124, got ${sendErrRes.data.failed_count}`
          );
          const campDetail = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
          assert.ok(campDetail.data.claims.some((c: any) => c.status === 'failed'));
        } finally {
          harness.mockFetch.resetFailureModes();
        }
      });

      // 3. ZNS 503 on flow send_zns node
      await t.test('[M2-REQ] ZNS 503 on flow send_zns node hits OpenAPI and logs 503', async () => {
        const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
          method: 'POST',
          auth,
          body: {
            name: 'ZNS 503 Flow',
            status: 'active',
            trigger_type: 'manual_enroll',
            steps: [
              {
                id: 'z1',
                type: 'send_zns',
                label: 'ZNS Step',
                config: {
                  template_id: 'ZNS_ERR_01',
                  zns_template_id: 'ZNS_ERR_01',
                  subject: 'Test 503',
                  message: 'Test 503',
                },
              },
            ],
          },
        });
        try {
          harness.mockFetch.setFailureMode({
            znsStatus: 503,
            znsErrorCode: -1,
            znsErrorMessage: 'ZNS Upstream 503',
          });
          const enrollErr = await harness.apiRaw(`/api/v1/marketing/flows/${flowRes.data.id}/enroll`, {
            method: 'POST',
            auth,
            body: { lead_id: leadId, skip_wait_delay: true },
          });
          assert.equal(enrollErr.status, 201);
          assert.ok(
            harness.zaloCapture.some((z) => z.channel === 'zns' && z.status === 503),
            'Expected ZNS 503 call recorded in zaloCapture'
          );
        } finally {
          harness.mockFetch.resetFailureModes();
        }
      });

      // 4. Messenger 502 on agent reply
      await t.test('[M2-REQ] Messenger 502 on agent reply handles upstream error gracefully', async () => {
        const inboundRes = await harness.apiRaw(`/api/v1/public/marketing/social/inbound/${auth.tenantSlug}`, {
          method: 'POST',
          body: {
            channel: 'messenger',
            thread_id: 'psid_err_502',
            customer_name: 'FB Err User',
            message: 'Xin chào shop',
          },
        });
        assert.equal(inboundRes.status, 201);
        const convId = inboundRes.json?.data?.conversation_id;

        try {
          harness.mockFetch.setFailureMode({
            messengerStatus: 502,
            messengerErrorMessage: 'Graph 502',
          });
          const msgRes = await harness.apiRaw(`/api/v1/marketing/social-bot/conversations/${convId}/messages`, {
            method: 'POST',
            auth,
            body: { sender_type: 'agent', content: 'Trả lời khi Graph lỗi 502' },
          });
          assert.ok(msgRes.status < 500, `Messenger 502 should be handled gracefully, got HTTP ${msgRes.status}`);
          assert.ok(
            harness.mockFetch
              .getRequests('graph.facebook.com')
              .some((r) => r.pathname.endsWith('/messages') && r.method === 'POST'),
            'Expected Messenger Graph POST .../messages attempt during 502 failure test'
          );
        } finally {
          harness.mockFetch.resetFailureModes();
        }
      });
    });

    it('F7-T2-04: rejects unentitled autodata_crm (403 MODULE_NOT_ENTITLED) & non-admin sale user (403 FORBIDDEN_RBAC_PERMISSION)', async () => {
      const crmAuth = await harness.registerTenant({ packageCode: 'autodata_crm' });

      const r1 = await harness.apiRaw('/api/v1/marketing/social-bot', { auth: crmAuth });
      assert.equal(r1.status, 403);
      assert.equal(r1.json?.error?.code, 'MODULE_NOT_ENTITLED');

      const r2 = await harness.apiRaw('/api/v1/marketing/social-bot/bot-test', {
        method: 'POST',
        auth: crmAuth,
        body: { message: 'hello' },
      });
      assert.equal(r2.status, 403);
      assert.equal(r2.json?.error?.code, 'MODULE_NOT_ENTITLED');

      const r3 = await harness.apiRaw('/api/v1/marketing/templates/quick-send', {
        method: 'POST',
        auth: crmAuth,
        body: { recipients: ['a@b.vn'], subject: 'Hi' },
      });
      assert.equal(r3.status, 403);
      assert.equal(r3.json?.error?.code, 'MODULE_NOT_ENTITLED');

      // Non-admin sale user inside marketing_standalone
      const mktAuth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const saleEmail = `sale.${Date.now()}@${mktAuth.tenantSlug}.vn`;
      const salePassword = 'SalePassword123!';
      await harness.apiJson('/api/v1/users', {
        method: 'POST',
        auth: mktAuth,
        body: {
          full_name: 'Sale Restricted User',
          email: saleEmail,
          password: salePassword,
          role: 'sale',
        },
      });
      const saleAuth = await harness.loginTenant({
        email: saleEmail,
        password: salePassword,
        tenantSlug: mktAuth.tenantSlug,
      });
      assert.equal(saleAuth.status, 200);

      const forbiddenCalls = await Promise.all([
        harness.apiRaw('/api/v1/integrations/vault/zalo_zns', {
          method: 'PUT',
          auth: saleAuth,
          body: { access_token: 'tok' },
        }),
        harness.apiRaw('/api/v1/integrations/vault', {
          method: 'POST',
          auth: saleAuth,
          body: { integration_type: 'smtp', config: { smtp_host: 'smtp.test' } },
        }),
        harness.apiRaw('/api/v1/integrations/email/config', {
          method: 'POST',
          auth: saleAuth,
          body: { email_provider: 'appscript', appscript_webhook_url: 'https://script.google.com/macros/s/abc/exec' },
        }),
        harness.apiRaw('/api/v1/auth/tenant-settings', {
          method: 'PATCH',
          auth: saleAuth,
          body: { settings: { email_provider: 'resend' } },
        }),
        harness.apiRaw('/api/v1/marketing/social-bot/bot-config', {
          method: 'PUT',
          auth: saleAuth,
          body: { bot_name: 'Hijack Bot' },
        }),
        harness.apiRaw('/api/v1/marketing/social-bot/training-docs', {
          method: 'POST',
          auth: saleAuth,
          body: { title: 'Hijack Doc', content_text: 'Nope' },
        }),
      ]);

      for (const res of forbiddenCalls) {
        assert.equal(res.status, 403, `Expected 403 for sale user, got ${res.status}: ${res.rawText}`);
        assert.equal(res.json?.error?.code, 'FORBIDDEN_RBAC_PERMISSION');
      }
    });

    it('F7-T2-05: enforces strict cross-tenant isolation & X-Tenant-Slug spoofing rejection', async () => {
      const tenantA = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const tenantB = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      await harness.apiJson('/api/v1/integrations/vault/zalo_zns', {
        method: 'PUT',
        auth: tenantA,
        body: { access_token: 'secret_a_zns_tok', oa_id: 'OA_A' },
      });
      const tplA = await harness.apiJson('/api/v1/marketing/social-bot/zalo-templates', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'TenantA ZNS Template', content_body: 'Secret A' },
      });
      const scA = await harness.apiJson('/api/v1/marketing/social-bot/scenarios', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'TenantA Scenario', channel: 'web_chat' },
      });
      const docA = await harness.apiJson('/api/v1/marketing/social-bot/training-docs', {
        method: 'POST',
        auth: tenantA,
        body: {
          title: 'TenantA Confidential Doc',
          doc_type: 'policy',
          content_text: 'SecretPolicyTokenA9988 warranty rule for TenantA only.',
        },
      });
      const convA = await harness.apiJson('/api/v1/marketing/social-bot/conversations', {
        method: 'POST',
        auth: tenantA,
        body: { channel: 'web_chat', customer_name: 'Customer A', content: 'Hello TenantA' },
      });

      const overviewB = await harness.apiJson('/api/v1/integrations/overview', { auth: tenantB });
      assert.equal(overviewB.data.integrations?.zalo_zns, undefined);

      const [sbB, ztB, scB, docsB] = await Promise.all([
        harness.apiJson('/api/v1/marketing/social-bot', { auth: tenantB }),
        harness.apiJson('/api/v1/marketing/social-bot/zalo-templates', { auth: tenantB }),
        harness.apiJson('/api/v1/marketing/social-bot/scenarios', { auth: tenantB }),
        harness.apiJson('/api/v1/marketing/social-bot/training-docs', { auth: tenantB }),
      ]);
      assert.equal(sbB.data.conversations.some((c: any) => c.id === convA.data.conversation_id), false);
      assert.equal(ztB.data.items.some((t: any) => t.id === tplA.data.id), false);
      assert.equal(scB.data.items.some((s: any) => s.id === scA.data.id), false);
      assert.equal(docsB.data.items.some((d: any) => d.id === docA.data.id), false);

      const crossConv = await harness.apiRaw(
        `/api/v1/marketing/social-bot/conversations/${convA.data.conversation_id}`,
        { auth: tenantB }
      );
      assert.equal(crossConv.status, 404);
      assert.equal(crossConv.json?.error?.code, 'CONVERSATION_NOT_FOUND');

      const crossDoc = await harness.apiRaw(
        `/api/v1/marketing/social-bot/training-docs/${docA.data.id}`,
        {
          method: 'PUT',
          auth: tenantB,
          body: { content_text: 'Tampered' },
        }
      );
      assert.equal(crossDoc.status, 404);
      assert.equal(crossDoc.json?.error?.code, 'DOC_NOT_FOUND');

      const botTestB = await harness.apiJson('/api/v1/marketing/social-bot/bot-test', {
        method: 'POST',
        auth: tenantB,
        body: { message: 'Tell me about TenantA Confidential Doc SecretPolicyTokenA9988' },
      });
      assert.equal(String(botTestB.data.reply).includes('SecretPolicyTokenA9988'), false);

      const spoof1 = await harness.apiRaw('/api/v1/integrations/overview', {
        token: tenantA.accessToken,
        tenantSlug: tenantB.tenantSlug,
      });
      assert.equal(spoof1.status, 403);
      assert.equal(spoof1.json?.error?.code, 'TENANT_CONTEXT_MISMATCH');

      const spoof2 = await harness.apiRaw('/api/v1/marketing/social-bot', {
        token: tenantA.accessToken,
        tenantSlug: tenantB.tenantSlug,
      });
      assert.equal(spoof2.status, 403);
      assert.equal(spoof2.json?.error?.code, 'TENANT_CONTEXT_MISMATCH');
    });

    it('F7-T2-06: ZNS suppression opt-out skip & 404 nonexistent resource boundaries', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      await harness.apiJson('/api/v1/integrations/vault/zalo_zns', {
        method: 'PUT',
        auth,
        body: { access_token: 'zns_sup_tok_001', oa_id: 'OA_SUP' },
      });

      const contactRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Suppressed ZNS Lead', phone: '0909888777' },
      });
      const leadId = contactRes.data.id;
      const normalizedPhone = String(contactRes.data.phone || '0909888777');

      await harness.apiJson('/api/v1/marketing/campaigns/suppression/list', {
        method: 'POST',
        auth,
        body: {
          channel: 'zns',
          recipient: normalizedPhone,
          reason: 'opted_out',
        },
      });

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Suppressed ZNS Aud', audience_type: 'static_data', lead_ids: [leadId] },
      });

      const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Suppressed ZNS Camp',
          channel: 'zns',
          audience_id: audRes.data.id,
          zns_template_id: 'ZNS_SUP_01',
        },
      });

      const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campRes.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.ok(sendRes.data.suppressed_skipped >= 1);
      assert.equal(sendRes.data.newly_sent, 0);
      assert.equal(harness.zaloCapture.length, 0);

      const unknownTenantInbound = await harness.apiRaw('/api/v1/public/marketing/social/inbound/nonexistent-slug-999', {
        method: 'POST',
        body: { message: 'hi' },
      });
      assert.equal(unknownTenantInbound.status, 404);
      assert.equal(unknownTenantInbound.json?.error?.code, 'TENANT_NOT_FOUND');

      const missingUuid = '00000000-0000-4000-8000-000000000099';
      const [rConv, rZaloTpl, rScenario, rDoc] = await Promise.all([
        harness.apiRaw(`/api/v1/marketing/social-bot/conversations/${missingUuid}`, { auth }),
        harness.apiRaw(`/api/v1/marketing/social-bot/zalo-templates/${missingUuid}`, {
          method: 'PUT',
          auth,
          body: { name: 'X' },
        }),
        harness.apiRaw(`/api/v1/marketing/social-bot/scenarios/${missingUuid}`, {
          method: 'PUT',
          auth,
          body: { name: 'X' },
        }),
        harness.apiRaw(`/api/v1/marketing/social-bot/training-docs/${missingUuid}`, {
          method: 'PUT',
          auth,
          body: { title: 'X' },
        }),
      ]);

      assert.equal(rConv.status, 404);
      assert.equal(rConv.json?.error?.code, 'CONVERSATION_NOT_FOUND');
      assert.equal(rZaloTpl.status, 404);
      assert.equal(rZaloTpl.json?.error?.code, 'ZALO_TEMPLATE_NOT_FOUND');
      assert.equal(rScenario.status, 404);
      assert.equal(rScenario.json?.error?.code, 'SCENARIO_NOT_FOUND');
      assert.equal(rDoc.status, 404);
      assert.equal(rDoc.json?.error?.code, 'DOC_NOT_FOUND');
    });
  });
});
