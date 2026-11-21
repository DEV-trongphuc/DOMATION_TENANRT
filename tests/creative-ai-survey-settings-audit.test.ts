import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';

describe('Team 4 Audit: Granular AI Switches, AI Email & Banner Generator, Deep Surveys/Vouchers & SocialBot Human Takeover', () => {
  let harness: TestHarness;
  let tempUploadsDir = '';
  let prevUploadsDir: string | undefined;
  let tenant: { id: string; slug: string; token: string };

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    prevUploadsDir = process.env.UPLOADS_DIR;
    tempUploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domation-team4-uploads-'));
    process.env.UPLOADS_DIR = tempUploadsDir;

    harness = await startTestServer();

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Domation Creative Lab',
        tenant_slug: 'domation-creative-lab',
        admin_name: 'Quynh Anh',
        work_email: 'owner@creative-lab.vn',
        phone: '0909123123',
        password: 'SecurePassword123!',
        industry: 'education',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    tenant = {
      id: reg.json.data.tenant.id,
      slug: reg.json.data.tenant.slug,
      token: reg.json.data.access_token,
    };

    // Fund wallet and switch to growth_combo so CRM + Marketing + AI modules are all entitled
    await withTenantTransaction(tenant.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 20000000 WHERE id = $1', [tenant.id]);
    });
    const sw = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: { package_code: 'growth_combo', billing_cycle: 'monthly' },
    });
    assert.equal(sw.status, 200);
  });

  after(async () => {
    await harness.close();
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    if (tempUploadsDir) {
      await fs.rm(tempUploadsDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('(a) All 7 granular AI feature toggles & dedicated Automation Email Vault persist and round-trip cleanly', async () => {
    // 1. Verify defaults are all true
    const initCfg = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(initCfg.status, 200);
    assert.equal(initCfg.json.data.ai_lead_eval_enabled, true);
    assert.equal(initCfg.json.data.ai_ads_eval_enabled, true);
    assert.equal(initCfg.json.data.ai_segment_analysis_enabled, true);
    assert.equal(initCfg.json.data.ai_user_behavior_enabled, true);
    assert.equal(initCfg.json.data.ai_email_designer_enabled, true);
    assert.equal(initCfg.json.data.ai_image_generator_enabled, true);
    assert.equal(initCfg.json.data.ai_agent_training_enabled, true);

    // 2. Toggle mixed combination via unified /ai-config endpoint + save Gemini BYOK key
    const putRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/ai-config', {
      method: 'PUT',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        api_key: 'AIzaSyTestUnifiedByokKey123456789',
        model: 'gemini-2.5-flash',
        ai_lead_eval_enabled: false,
        ai_ads_eval_enabled: true,
        ai_segment_analysis_enabled: false,
        ai_user_behavior_enabled: true,
        ai_email_designer_enabled: true,
        ai_image_generator_enabled: false,
        ai_agent_training_enabled: true,
      },
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.json.data.has_api_key, true);
    assert.equal(putRes.json.data.ai_lead_eval_enabled, false);
    assert.equal(putRes.json.data.ai_ads_eval_enabled, true);
    assert.equal(putRes.json.data.ai_segment_analysis_enabled, false);
    assert.equal(putRes.json.data.ai_user_behavior_enabled, true);
    assert.equal(putRes.json.data.ai_email_designer_enabled, true);
    assert.equal(putRes.json.data.ai_image_generator_enabled, false);
    assert.equal(putRes.json.data.ai_agent_training_enabled, true);

    // 3. Round-trip read via /dom-meta/ai-config AND /auth/me tenant settings
    const readBack = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(readBack.status, 200);
    assert.equal(readBack.json.data.ai_lead_eval_enabled, false);
    assert.equal(readBack.json.data.ai_segment_analysis_enabled, false);
    assert.equal(readBack.json.data.ai_image_generator_enabled, false);
    assert.equal(readBack.json.data.ai_agent_training_enabled, true);

    const meRes = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.json.data.tenant.settings.ai_segment_analysis_enabled, false);
    assert.equal(meRes.json.data.tenant.settings.ai_image_generator_enabled, false);

    // 4. Verify disabled ai_image_generator_enabled blocks POST /ai-generate-image with 403
    const blockedImg = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/ai-generate-image', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: { prompt: 'Test blocked banner' },
    });
    assert.equal(blockedImg.status, 403);
    assert.equal(blockedImg.json.error.code, 'AI_IMAGE_GENERATOR_DISABLED');

    // Re-enable all 7 AI toggles for subsequent tests
    const reEnable = await apiRequest(harness.baseUrl, '/api/v1/integrations/ai-config', {
      method: 'PUT',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        ai_lead_eval_enabled: true,
        ai_ads_eval_enabled: true,
        ai_segment_analysis_enabled: true,
        ai_user_behavior_enabled: true,
        ai_email_designer_enabled: true,
        ai_image_generator_enabled: true,
        ai_agent_training_enabled: true,
      },
    });
    assert.equal(reEnable.status, 200);

    // 5. Verify dedicated Email Service status (Apps Script != automation ready; AWS SES Vault => automation_email_ready = true)
    const emailInit = await apiRequest(harness.baseUrl, '/api/v1/integrations/email/config', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(emailInit.status, 200);
    assert.equal(emailInit.json.data.automation_email_ready, false);

    const sesVault = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/aws_ses', {
      method: 'PUT',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        host: 'email-smtp.ap-southeast-1.amazonaws.com',
        region: 'ap-southeast-1',
        port: 587,
        username: 'AKIAEXAMPLE',
        password: 'SecretExamplePassword',
        from_email: 'marketing@creative-lab.vn',
      },
    });
    assert.equal(sesVault.status, 200);

    const emailAfter = await apiRequest(harness.baseUrl, '/api/v1/integrations/email/config', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(emailAfter.status, 200);
    assert.equal(emailAfter.json.data.automation_email_ready, true);
    assert.ok(emailAfter.json.data.dedicated_email_vault_providers.includes('aws_ses'));
  });

  it('(b) AI Email Designer & AI Banner Image Generator (with Reference + Logo) persist PNG to UPLOADS_DIR & Media Library', async () => {
    const tinyPngBase64 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    // 1. Generate AI Banner Image with reference image + brand logo + 3:1 aspect ratio
    const imgRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/ai-generate-image', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        prompt: 'Banner hội thảo tuyển sinh MBA 2026 phong cách sang trọng',
        aspect_ratio: '3:1',
        style_preset: 'event_invite',
        brand_color: '#1E40FF',
        reference_image_base64: tinyPngBase64,
        logo_image_base64: tinyPngBase64,
        save_to_library: true,
      },
    });
    assert.equal(imgRes.status, 201);
    const imgData = imgRes.json.data;
    assert.ok(imgData.url.startsWith('/uploadss/ai_generated/'), `Expected /uploadss/ai_generated/... got ${imgData.url}`);
    assert.ok(imgData.url.endsWith('.png'));
    assert.ok(imgData.asset_id, 'Should register asset in mkt_media_assets');
    assert.equal(imgData.width, 720);
    assert.equal(imgData.height, 240);
    assert.equal(imgData.used_reference, true);
    assert.equal(imgData.used_logo, true);

    // 2. Verify generated PNG is served over HTTP with valid PNG magic signature
    const fetchImg = await fetch(`${harness.baseUrl}${imgData.url}`);
    assert.equal(fetchImg.status, 200);
    const bytes = Buffer.from(await fetchImg.arrayBuffer());
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50); // P
    assert.equal(bytes[2], 0x4e); // N
    assert.equal(bytes[3], 0x47); // G

    // 3. Verify asset appears under folder 'AI Generated' in Media Library
    const mediaRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/marketing/templates/media?folder=AI%20Generated',
      { token: tenant.token, tenantSlug: tenant.slug }
    );
    assert.equal(mediaRes.status, 200);
    assert.ok(mediaRes.json.data.items.some((item: any) => item.id === imgData.asset_id));

    // 4. Upgraded AI Email Designer with auto_generate_hero_banner=true
    const emailGen = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/ai-generate', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        goal: 'Mở cổng học bổng Quản trị Kinh doanh Quốc tế 2026',
        tone: 'luxury',
        industry: 'education',
        brand_color: '#1E40FF',
        reference_cues: 'Bố cục tối giản Apple editorial, có khối chứng thực và voucher',
        logo_url: '/imgs/autodata/domation_ai_icon.svg',
        auto_generate_hero_banner: true,
        include_voucher: true,
        include_countdown: true,
      },
    });
    assert.equal(emailGen.status, 200);
    assert.equal(emailGen.json.data.generator, 'DOM Agent Email Studio');
    assert.ok(emailGen.json.data.blocks.length >= 7);
    assert.ok(Array.isArray(emailGen.json.data.editor_blocks) && emailGen.json.data.editor_blocks.length >= 6);
    assert.ok(emailGen.json.data.hero_banner_asset?.url?.startsWith('/uploadss/ai_generated/'));
    assert.ok(emailGen.json.data.compiled_html.includes('{{unsubscribe_url}}'));
  });

  it('(c) Deep Survey settings (branching logic, quiz weights, score tiers, NPS, voucher reward, duplicate block, max cap) & Voucher validation', async () => {
    // 1. Voucher validation guardrails: reject >100% and invalid prefix
    const badPct = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: { name: 'Bad Pct', code_prefix: 'VIP', discount_type: 'percentage', discount_value: 150 },
    });
    assert.equal(badPct.status, 422);
    assert.equal(badPct.json.error.code, 'INVALID_DISCOUNT_PERCENTAGE');

    // Create valid voucher reward pool
    const vPool = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'Quà Khảo Sát 20%',
        code_prefix: 'SRV20',
        discount_type: 'percentage',
        discount_value: 20,
        min_order_vnd: 500000,
        max_uses_per_code: 1,
        auto_generate_count: 5,
        expires_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
      },
    });
    assert.equal(vPool.status, 201);
    const poolId = vPool.json.data.id;
    assert.equal(vPool.json.data.total_codes, 5);
    assert.equal(vPool.json.data.max_uses_per_code, 1);

    // Create target audience list for auto-add
    const aud = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: { name: 'Survey Promoters List', audience_type: 'static_list' },
    });
    assert.equal(aud.status, 201);
    const audienceId = aud.json.data.id;

    // 2. Create deep Survey with branching logic, quiz weights, NPS, score tiers, voucher reward, max_responses=2, allow_multiple=false
    const srv = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        title: 'Đánh giá Trải nghiệm & Năng lực Chuyển đổi số',
        survey_type: 'quiz',
        blocks: [
          {
            id: 'q_branch',
            type: 'single_choice',
            label: 'Bạn đã dùng hệ thống CRM chưa?',
            options: [
              { id: 'o1', label: 'Đã dùng', value: 'yes', points: 10 },
              { id: 'o2', label: 'Chưa dùng', value: 'no', points: 5 },
            ],
            logic_rules: [
              { operator: 'equals', value: 'no', action: 'skip_to', target: 'q_nps' },
            ],
          },
          {
            id: 'q_skipped_if_no',
            type: 'quiz_scored',
            label: 'Câu hỏi nâng cao cho người đã dùng CRM',
            correctValue: 'automation',
            points: 30,
          },
          {
            id: 'q_nps',
            type: 'nps',
            label: 'Mức độ sẵn sàng giới thiệu (0-10)',
          },
        ],
        settings: {
          auto_tag: 'Survey_2026',
          base_lead_score: 0,
          target_audience_id: audienceId,
          reward_voucher_campaign_id: poolId,
          max_responses: 2,
          allow_multiple_submissions: false,
          custom_redirect_url: 'https://domation.net/thank-you',
          append_redirect_params: true,
        },
        redirect_rules: [
          {
            minScore: 40,
            maxScore: 200,
            label: 'Platinum Executive',
            assignTag: 'VIP_Quiz_Winner',
            thankYouTitle: 'Chúc mừng Hạng Platinum!',
          },
          {
            minScore: 0,
            maxScore: 39,
            label: 'Starter Growth',
            assignTag: 'Starter_Nurture',
          },
        ],
      },
    });
    assert.equal(srv.status, 201);
    const surveyId = srv.json.data.id;
    assert.equal(srv.json.data.settings.voucher_campaign_id, poolId);
    assert.equal(srv.json.data.settings.reward_voucher_campaign_id, poolId);
    assert.equal(srv.json.data.settings.max_responses, 2);
    assert.equal(srv.json.data.settings.allow_multiple_submissions, false);

    // 3. Submit #1 (High score + Promoter NPS 10 -> Platinum tier + Voucher issued + Redirect params!)
    const sub1 = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/submit`, {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'Tran Bao Long',
        email: 'baolong@company.vn',
        phone: '0912333444',
        answers: {
          q_branch: 'yes',
          q_skipped_if_no: 'automation',
          q_nps: 10,
        },
      },
    });
    assert.equal(sub1.status, 201);
    assert.equal(sub1.json.data.quiz_score, 55); // 10 + 30 + 15 (NPS Promoter)
    assert.equal(sub1.json.data.score_tier, 'Platinum Executive');
    assert.equal(sub1.json.data.nps_classification, 'Promoter');
    assert.ok(sub1.json.data.tags_applied.includes('Survey_2026'));
    assert.ok(sub1.json.data.tags_applied.includes('NPS Promoter'));
    assert.ok(sub1.json.data.tags_applied.includes('VIP_Quiz_Winner'));
    const issuedVoucher = String(sub1.json.data.voucher_code || '');
    assert.ok(issuedVoucher.startsWith('SRV20-'), `Expected SRV20- voucher, got ${issuedVoucher}`);
    assert.ok(sub1.json.data.redirect_url.includes(`voucher=${issuedVoucher}`));
    assert.ok(sub1.json.data.redirect_url.includes('score=55'));
    assert.equal(sub1.json.data.skipped_block_ids.length, 0);

    // 4. Duplicate submission by same respondent must be blocked (allow_multiple_submissions=false)
    const dupSub = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/submit`, {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'Tran Bao Long',
        email: 'baolong@company.vn',
        answers: { q_branch: 'yes', q_nps: 9 },
      },
    });
    assert.equal(dupSub.status, 409);
    assert.equal(dupSub.json.error.code, 'DUPLICATE_SUBMISSION_NOT_ALLOWED');

    // 5. Submit #2 (Branching skip_to q_nps skips q_skipped_if_no even if answer supplied + Detractor NPS 4)
    const sub2 = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/submit`, {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'Le Minh Chau',
        email: 'minhchau@company.vn',
        answers: {
          q_branch: 'no',
          q_skipped_if_no: 'automation', // Must be skipped due to logic_rules skip_to q_nps!
          q_nps: 4,
        },
      },
    });
    assert.equal(sub2.status, 201);
    assert.ok(sub2.json.data.skipped_block_ids.includes('q_skipped_if_no'));
    assert.equal(sub2.json.data.quiz_score, 5); // Only q_branch ('no' = 5 pts), q_skipped_if_no skipped!
    assert.equal(sub2.json.data.nps_classification, 'Detractor');
    assert.equal(sub2.json.data.score_tier, 'Starter Growth');

    // 6. Submit #3 exceeds max_responses=2 -> 409 SURVEY_LIMIT_REACHED
    const sub3 = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/submit`, {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'Third User',
        email: 'third@company.vn',
        answers: { q_branch: 'yes', q_nps: 8 },
      },
    });
    assert.equal(sub3.status, 409);
    assert.equal(sub3.json.error.code, 'SURVEY_LIMIT_REACHED');

    // 7. POS Redeem the voucher issued by Survey #1 + verify exact discount calculation + double redeem block
    const redeemRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/redeem', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        code: issuedVoucher,
        order_vnd: 1000000,
        note: 'POS Quầy Q1',
      },
    });
    assert.equal(redeemRes.status, 200);
    assert.equal(redeemRes.json.data.discount_amount_vnd, 200000);
    assert.equal(redeemRes.json.data.final_order_vnd, 800000);

    const doubleRedeem = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/redeem', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: { code: issuedVoucher, order_vnd: 1000000 },
    });
    assert.equal(doubleRedeem.status, 400);
    assert.equal(doubleRedeem.json.error.code, 'CODE_ALREADY_REDEEMED');
  });

  it('(d) SocialBot human takeover (bot_paused=true) blocks auto-reply & scenarios across Zalo/Messenger/Web and resumes cleanly', async () => {
    // 1. Create active omnichannel keyword scenario + verify conflict detection on overlapping scenario
    const scen1 = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/scenarios', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'Báo giá Khóa học',
        channel: 'omnichannel',
        trigger_type: 'keyword',
        keywords: ['học phí', 'bảng giá'],
        nodes: [{ id: 'root', content: 'Học phí chương trình là 25 triệu VNĐ (ưu đãi 20% tháng này)!' }],
        is_active: true,
      },
    });
    assert.equal(scen1.status, 201);

    const scenConflict = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/scenarios', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'Báo giá Trùng Từ Khóa',
        channel: 'zalo_oa',
        trigger_type: 'keyword',
        keywords: ['bảng giá'],
        nodes: [{ id: 'root', content: 'Kịch bản phụ' }],
        is_active: true,
      },
    });
    assert.equal(scenConflict.status, 201);
    assert.ok(scenConflict.json.data.conflict_warnings.length >= 1, 'Should warn about overlapping keyword scenario');

    // 2. Test Human Takeover + Resume across ALL 3 channels: zalo_oa, messenger, web_chat
    for (const channel of ['zalo_oa', 'messenger', 'web_chat'] as const) {
      const threadId = `thread_${channel}_takeover_1`;

      // Initial message -> AI/scenario active & replies
      const initMsg = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/conversations', {
        method: 'POST',
        token: tenant.token,
        tenantSlug: tenant.slug,
        body: {
          channel,
          external_thread_id: threadId,
          customer_name: `Khách ${channel}`,
          content: 'Cho mình hỏi bảng giá khóa học?',
          webhook_event_id: `evt_${channel}_1`,
        },
      });
      assert.equal(initMsg.status, 201);
      assert.ok(initMsg.json.data.bot_reply, `Expected bot auto-reply on ${channel} before pause`);
      const convId = initMsg.json.data.conversation_id;

      // Duplicate webhook event must NOT produce a duplicate bot reply
      const dupWebhook = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/conversations', {
        method: 'POST',
        token: tenant.token,
        tenantSlug: tenant.slug,
        body: {
          channel,
          external_thread_id: threadId,
          customer_name: `Khách ${channel}`,
          content: 'Cho mình hỏi bảng giá khóa học?',
          webhook_event_id: `evt_${channel}_1`,
        },
      });
      assert.equal(dupWebhook.status, 201);
      assert.equal(dupWebhook.json.data.bot_reply, null);
      assert.equal(dupWebhook.json.data.deduplicated, true);

      // Pause bot (Human Takeover!)
      const pauseRes = await apiRequest(
        harness.baseUrl,
        `/api/v1/marketing/social-bot/conversations/${convId}`,
        {
          method: 'PATCH',
          token: tenant.token,
          tenantSlug: tenant.slug,
          body: {
            bot_paused: true,
            handoff_reason: `VIP customer takeover on ${channel}`,
          },
        }
      );
      assert.equal(pauseRes.status, 200);
      assert.equal(pauseRes.json.data.bot_paused, true);
      assert.ok(pauseRes.json.data.assigned_agent_id);
      assert.equal(pauseRes.json.data.handoff_reason, `VIP customer takeover on ${channel}`);
      assert.ok(pauseRes.json.data.handoff_at);

      // While bot_paused=true, inbound customer message MUST NOT trigger bot OR keyword scenario!
      const mutedMsg = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/conversations', {
        method: 'POST',
        token: tenant.token,
        tenantSlug: tenant.slug,
        body: {
          channel,
          external_thread_id: threadId,
          customer_name: `Khách ${channel}`,
          content: 'Mình hỏi lại bảng giá học phí nhé',
          webhook_event_id: `evt_${channel}_2`,
        },
      });
      assert.equal(mutedMsg.status, 201);
      assert.equal(mutedMsg.json.data.bot_reply, null, `Bot MUST stay silent on ${channel} when bot_paused=true`);
      assert.equal(mutedMsg.json.data.bot_paused, true);
      assert.equal(mutedMsg.json.data.bot_suppressed_reason, 'human_takeover_paused');

      // Also check follow-up via /conversations/:id/messages with sender_type='customer' while paused
      const mutedFollowup = await apiRequest(
        harness.baseUrl,
        `/api/v1/marketing/social-bot/conversations/${convId}/messages`,
        {
          method: 'POST',
          token: tenant.token,
          tenantSlug: tenant.slug,
          body: { sender_type: 'customer', content: 'Alo bảng giá ơi?' },
        }
      );
      assert.equal(mutedFollowup.status, 201);
      assert.equal(mutedFollowup.json.data.bot_reply, null);
      assert.equal(mutedFollowup.json.data.bot_suppressed_reason, 'human_takeover_paused');

      // Resume AI (bot_paused=false) -> clears handoff state & cleanly re-enables auto-reply!
      const resumeRes = await apiRequest(
        harness.baseUrl,
        `/api/v1/marketing/social-bot/conversations/${convId}`,
        {
          method: 'PATCH',
          token: tenant.token,
          tenantSlug: tenant.slug,
          body: { bot_paused: false },
        }
      );
      assert.equal(resumeRes.status, 200);
      assert.equal(resumeRes.json.data.bot_paused, false);
      assert.equal(resumeRes.json.data.assigned_agent_id, null);
      assert.equal(resumeRes.json.data.handoff_reason, null);

      const resumedMsg = await apiRequest(
        harness.baseUrl,
        `/api/v1/marketing/social-bot/conversations/${convId}/messages`,
        {
          method: 'POST',
          token: tenant.token,
          tenantSlug: tenant.slug,
          body: { sender_type: 'customer', content: 'Cho mình xin lại bảng giá nhé!' },
        }
      );
      assert.equal(resumedMsg.status, 201);
      assert.ok(
        resumedMsg.json.data.bot_reply && resumedMsg.json.data.bot_reply.length > 0,
        `Bot MUST resume replying cleanly on ${channel} after bot_paused=false`
      );
    }
  });
});
