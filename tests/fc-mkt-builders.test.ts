import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { MARKETING_TABLES } from '../server/modules/marketing/schema.ts';

describe('Stage 3B Full-Clone Marketing Visual Builders Backend & 32-Table RLS Suite', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  let tenantB: { id: string; slug: string; token: string };

  let audienceId = '';
  let templateId = '';
  let mediaAssetId = '';
  let campaignId = '';
  let reminderId = '';
  let flowId = '';
  let formId = '';
  let eventId = '';
  let voucherPoolId = '';
  let surveyId = '';
  let surveySlug = '';
  let propertyId = '';
  let siteKey = '';
  let sessionId = '';
  let heatmapId = '';
  let scenarioId = '';
  let zaloTemplateId = '';
  let trainingDocId = '';
  let webChatConvId = '';
  let leadAlphaId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Sapphire Visual Studio Corp',
        tenant_slug: 'sapphire-studio',
        admin_name: 'Quang Huy',
        work_email: 'owner@sapphire-studio.vn',
        phone: '0901223344',
        password: 'SecurePassword123!',
        industry: 'retail',
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
        company_name: 'Isolated Rival Corp',
        tenant_slug: 'isolated-rival',
        admin_name: 'Bao Tran',
        work_email: 'owner@isolated-rival.vn',
        phone: '0908776655',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
    };

    // Unlock Growth Suite (`growth_combo`) on both tenants
    for (const t of [tenantA, tenantB]) {
      await withTenantTransaction(t.id, async (client) => {
        await client.query('UPDATE tenants SET wallet_balance_vnd = 10000000 WHERE id = $1', [t.id]);
      });
      const sw = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
        method: 'POST',
        token: t.token,
        tenantSlug: t.slug,
        body: { package_code: 'growth_combo' },
      });
      assert.equal(sw.status, 200);
    }

    // Seed static Audience + 1 subscribed contact (missing name to test VariableFallbackConfig!)
    const audRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Tệp Khách Hàng Studio', audience_type: 'static_data' },
    });
    assert.equal(audRes.status, 201);
    audienceId = audRes.json.data.id;

    const impRes = await apiRequest(harness.baseUrl, `/api/v1/audiences/${audienceId}/import`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        rows: [
          { name: 'Trần Minh Khang', email: 'khach-vip@client.vn', phone: '0912345678' },
        ],
      },
    });
    assert.equal(impRes.status, 201);

    const memRes = await apiRequest(harness.baseUrl, `/api/v1/audiences/${audienceId}/members`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(memRes.status, 200);
    leadAlphaId = memRes.json.data.items[0].id;
    assert.ok(leadAlphaId);
  });

  after(async () => {
    await harness.close();
  });

  it('1. EmailEditor Studio: Deliverability Validator, Media Library, Team ACL & QuickSend with Fallbacks', async () => {
    // Media Library upload + list
    const mediaUpload = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/media', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        folder_name: 'Banner Chiến Dịch',
        file_name: 'hero-sapphire.png',
        url: 'https://domation.net/imgs/autodata/ICON.png',
        alt_text: 'DOMATION Banner',
        tags: ['hero', 'q4'],
      },
    });
    assert.equal(mediaUpload.status, 201);
    mediaAssetId = mediaUpload.json.data.id;

    const mediaList = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/media?q=hero', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(mediaList.status, 200);
    assert.equal(mediaList.json.data.items.length, 1);

    // EmailValidationPanel check
    const valRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/validate', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        subject: 'Giải pháp tự động hóa tăng trưởng cho {{lead.name}}',
        blocks: [
          {
            id: 'b_hero',
            type: 'hero_banner',
            title: 'Chào mừng Quý đối tác',
            content: 'Tối ưu chuyển đổi đa kênh',
            buttonLabel: 'Trải nghiệm ngay',
            url: 'https://domation.net/start',
          },
          {
            id: 'b_btn_bad',
            type: 'button',
            buttonLabel: 'Nút chưa gắn link',
            url: '#',
          },
        ],
      },
    });
    assert.equal(valRes.status, 200);
    assert.equal(valRes.json.data.has_unsubscribe_tag, true);
    assert.equal(valRes.json.data.links.length, 2);
    assert.equal(valRes.json.data.links[0].valid, true);
    assert.equal(valRes.json.data.links[1].valid, false);

    // Create Template + Configure ACL (`TemplateAccessModal`)
    const tplRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Mẫu Email Ra Mắt Studio',
        subject: 'Ưu đãi dành cho {{lead.name}}',
        blocks: [
          { id: 't1', type: 'text', title: 'Xin chào', content: 'Chào {{lead.name}}, cảm ơn bạn đã đồng hành!' },
        ],
      },
    });
    assert.equal(tplRes.status, 201);
    templateId = tplRes.json.data.id;

    const putAcl = await apiRequest(harness.baseUrl, `/api/v1/marketing/templates/${templateId}/acl`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        visibility: 'team',
        entries: [
          { scope_type: 'role', scope_target_id: 'marketing_lead', scope_label: 'Trưởng nhóm Marketing', permission_level: 'edit' },
        ],
      },
    });
    assert.equal(putAcl.status, 200);
    assert.equal(putAcl.json.data.visibility, 'team');
    assert.equal(putAcl.json.data.acl_entries.length, 1);

    // QuickSendEmailModal
    const quickSend = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/quick-send', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        template_id: templateId,
        recipients: ['khach-vip@client.vn'],
        fallback_vars: { 'lead.name': 'Quý Đối Tác VIP' },
      },
    });
    assert.equal(quickSend.status, 200);
    assert.equal(quickSend.json.data.sent_count, 1);
  });

  it('2. CampaignWizard, SesQuotaWidget, PreSendReviewModal, TestEmailModal, ReminderManager & CampaignDetailDrawer', async () => {
    const quota = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/ses-quota', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(quota.status, 200);
    assert.ok(quota.json.data.max_24h_send >= 200);

    const createCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Chiến dịch Đa Bước Q4',
        channel: 'email',
        audience_id: audienceId,
        template_id: templateId,
        subject_a: 'Kính gửi {{lead.custom_fields.missing_title}} - Ưu đãi Q4',
        subject_b: 'Quà tặng Q4 cho {{lead.custom_fields.missing_title}}',
        ab_split_ratio: 50,
        ab_winner_criteria: 'click_rate',
        throttle_per_minute: 120,
        fallback_vars: {
          'lead.name': 'Quý khách',
          'lead.custom_fields.missing_title': 'Anh/Chị Quản lý',
        },
        reminders: [
          { trigger_condition: 'no_open', wait_hours: 24, subject: 'Nhắc lần 1: Đừng bỏ lỡ ưu đãi Q4' },
        ],
      },
    });
    assert.equal(createCamp.status, 201);
    campaignId = createCamp.json.data.id;
    assert.equal(createCamp.json.data.throttle_per_minute, 120);

    // PreSendReviewModal check
    const preReview = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/campaigns/${campaignId}/pre-send-review`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(preReview.status, 200);
    assert.equal(preReview.json.data.audience_total, 1);
    assert.equal(preReview.json.data.missing_fallback_tags.length, 0);

    // TestEmailModal check
    const testMail = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/campaigns/${campaignId}/test-email`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { emails: ['qa@sapphire-studio.vn'], variant: 'B' },
      }
    );
    assert.equal(testMail.status, 200);
    assert.ok(String(testMail.json.data.rendered_subject).includes('Anh/Chị Quản lý'));

    // Add second follow-up reminder (`ReminderManager`)
    const addRem = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/campaigns/${campaignId}/reminders`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { step_order: 2, trigger_condition: 'no_click', wait_hours: 48, subject: 'Nhắc lần 2' },
      }
    );
    assert.equal(addRem.status, 201);
    reminderId = addRem.json.data.id;

    // Launch Campaign & inspect `CampaignDetailDrawer`
    const sendRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campaignId}/send`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.json.data.newly_sent, 1);

    const detail = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campaignId}/detail`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.funnel.sent, 1);
    assert.equal(detail.json.data.reminders.length, 2);
    assert.ok(String(detail.json.data.claims[0].metadata.subject).includes('Anh/Chị Quản lý'));
  });

  it('3. Automation Flows Studio: Settings Re-Entry Guard, ManualTrigger, FlowAnalyticsTab & StepParticipantsModal', async () => {
    const createFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Flow Chăm Sóc VIP Có Khóa Re-Entry',
        trigger_type: 'manual_enroll',
        settings: {
          quiet_hours_enabled: true,
          quiet_start: '22:00',
          quiet_end: '07:00',
          re_entry_mode: 'once',
          goal_exit_score: 80,
        },
        steps: [
          {
            id: 'node_score_1',
            type: 'update_lead_score',
            label: 'Cộng 20 điểm tương tác',
            config: { delta: 20 },
            nextStepId: 'node_tag_2',
          },
          {
            id: 'node_tag_2',
            type: 'add_remove_tag',
            label: 'Gắn nhãn VIP Flow',
            config: { mode: 'add', tag: 'VIP-Flow' },
            nextStepId: null,
          },
        ],
      },
    });
    assert.equal(createFlow.status, 201);
    flowId = createFlow.json.data.id;
    assert.equal(createFlow.json.data.settings.re_entry_mode, 'once');

    // ManualTriggerFlowModal by audience_id -> enrolls 1 lead
    const trig1 = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flowId}/manual-trigger`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { audience_id: audienceId },
    });
    assert.equal(trig1.status, 201);
    assert.equal(trig1.json.data.enrolled_count, 1);

    // Second manual-trigger MUST respect `re_entry_mode: 'once'` -> 0 re-enrolled!
    const trig2 = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flowId}/manual-trigger`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { audience_id: audienceId },
    });
    assert.equal(trig2.status, 201);
    assert.equal(trig2.json.data.enrolled_count, 0);

    // FlowAnalyticsTab
    const analytics = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flowId}/analytics`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(analytics.status, 200);
    assert.equal(analytics.json.data.step_funnel.length, 2);
    assert.equal(analytics.json.data.step_funnel[0].completed, 1);

    // StepParticipantsModal
    const stepDebug = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/flows/${flowId}/steps/node_score_1/participants`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(stepDebug.status, 200);
    assert.equal(stepDebug.json.data.total, 1);
    assert.equal(stepDebug.json.data.participants[0].lead_id, leadAlphaId);
  });

  it('4. Forms Multi-Theme Embed, Event Webhook Secret Rotation & OTP Audit Inspector', async () => {
    const fRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Form Floating Bar Tư Vấn',
        routing_mode: 'marketing_nurture',
        fields: [{ id: 'f1', key: 'phone', label: 'Số điện thoại', type: 'phone', required: true }],
      },
    });
    assert.equal(fRes.status, 201);
    formId = fRes.json.data.id;

    const embedRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/forms/${formId}/embed-config`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(embedRes.status, 200);
    assert.ok(embedRes.json.data.snippets.iframe.includes('<iframe'));
    assert.ok(embedRes.json.data.snippets.popup_modal.includes('popup_modal'));
    assert.ok(embedRes.json.data.snippets.floating_bar.includes('floating_bar'));

    const evRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms/events', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { event_name: 'Đăng ký Gói Enterprise', event_key: 'signup_ent', event_category: 'purchase' },
    });
    assert.equal(evRes.status, 201);
    eventId = evRes.json.data.id;

    const evDetail = await apiRequest(harness.baseUrl, `/api/v1/marketing/forms/events/${eventId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(evDetail.status, 200);
    const oldSecret = evDetail.json.data.event.webhook_secret;
    assert.ok(String(oldSecret).startsWith('whsec_'));

    const rotRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/forms/events/${eventId}/rotate-secret`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(rotRes.status, 200);
    assert.notEqual(rotRes.json.data.webhook_secret, oldSecret);

    // Send an OTP to populate OTP audit log
    await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/send', {
      method: 'POST',
      body: { tenant_slug: tenantA.slug, recipient: '0912345678', channel: 'sms' },
    });

    const otpAudit = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms/otp/audit', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(otpAudit.status, 200);
    assert.ok(otpAudit.json.data.summary.total_sent >= 1);
    assert.equal(otpAudit.json.data.policy.max_attempts, 5);
  });

  it('5. Vouchers Branded QR Update, Public `/claim/:id` (UUID) & Shortlink Clicks Analytics + Survey Score Redirect/Voucher Reward', async () => {
    const vRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Ưu đãi Tri Ân 25%',
        code_prefix: 'VIP25',
        discount_type: 'percentage',
        discount_value: 25,
        auto_generate_count: 5,
      },
    });
    assert.equal(vRes.status, 201);
    voucherPoolId = vRes.json.data.id;

    // Update QR design & min_order_vnd via PUT /:id
    const updV = await apiRequest(harness.baseUrl, `/api/v1/marketing/vouchers/${voucherPoolId}`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        min_order_vnd: 500_000,
        qr_design: {
          fgColor: '#1E40FF',
          gradientEndColor: '#0284C7',
          dotStyle: 'rounded',
          eyeStyle: 'circle',
          frameText: 'QUÉT NHẬN 25%',
          logoUrl: '/imgs/autodata/ICON.png',
        },
      },
    });
    assert.equal(updV.status, 200);
    assert.equal(updV.json.data.min_order_vnd, 500_000);
    assert.equal(updV.json.data.qr_design.frameText, 'QUÉT NHẬN 25%');

    // Public `/claim/:id` lookup & claim by UUID!
    const pubInfo = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/vouchers/${voucherPoolId}`);
    assert.equal(pubInfo.status, 200);
    assert.equal(pubInfo.json.data.id, voucherPoolId);

    const pubClaim = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/vouchers/${voucherPoolId}/claim`,
      {
        method: 'POST',
        body: { name: 'Hoàng Gia Bảo', phone: '0988112233' },
      }
    );
    assert.equal(pubClaim.status, 201);
    assert.ok(String(pubClaim.json.data.code).startsWith('VIP25-'));

    // Shortlink Clicks Analytics (`LinkClicksTab`)
    const slRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/shortlinks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'QR Poster Sự Kiện',
        target_url: 'https://domation.net/promo',
        utm_source: 'poster_q1',
      },
    });
    assert.equal(slRes.status, 201);
    await apiRequest(harness.baseUrl, `/api/v1/public/marketing/r/${slRes.json.data.short_code}?json=1`);

    const clickAnalytics = await apiRequest(
      harness.baseUrl,
      '/api/v1/marketing/vouchers/clicks-analytics',
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(clickAnalytics.status, 200);
    assert.equal(clickAnalytics.json.data.total_clicks, 1);

    // Survey with branching + score-based redirect & automatic voucher reward + Report & CSV Export
    const srvRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Khảo Sát Đánh Giá Chuyển Đổi Số',
        survey_type: 'quiz',
        settings: { base_lead_score: 10 },
        redirect_rules: [
          {
            minScore: 25,
            maxScore: 200,
            redirectUrl: 'https://domation.net/vip-onboarding',
            thankYouTitle: 'Chúc mừng Doanh nghiệp đạt chuẩn VIP!',
            assignTag: 'Digital-Ready',
            voucherCampaignId: voucherPoolId,
          },
        ],
        blocks: [
          {
            id: 'q1',
            type: 'single_choice',
            label: 'Quy mô đội Sale?',
            options: [
              { id: 'o1', label: '1-5 người', value: 'small', points: 5, jumpToBlockId: 'q2' },
              { id: 'o2', label: 'Trên 20 người', value: 'large', points: 25, jumpToBlockId: 'q2' },
            ],
          },
          { id: 'q2', type: 'nps', label: 'Mức độ sẵn sàng triển khai (0-10)?' },
        ],
      },
    });
    assert.equal(srvRes.status, 201);
    surveyId = srvRes.json.data.id;
    surveySlug = srvRes.json.data.slug;

    const pubSrvSub = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/surveys/${surveySlug}`, {
      method: 'POST',
      body: {
        name: 'Nguyễn Thu Trang',
        phone: '0933445566',
        answers: { q1: 'large', q2: 9 },
      },
    });
    assert.equal(pubSrvSub.status, 201);
    assert.equal(pubSrvSub.json.data.redirect_url, 'https://domation.net/vip-onboarding');
    assert.ok(String(pubSrvSub.json.data.voucher_code).startsWith('VIP25-'));
    assert.ok(pubSrvSub.json.data.tags_applied.includes('Digital-Ready'));

    const reportRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/report`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(reportRes.status, 200);
    assert.equal(reportRes.json.data.question_stats.length, 2);

    const csvResp = await fetch(`${harness.baseUrl}/api/v1/marketing/surveys/${surveyId}/export.csv`, {
      headers: {
        Authorization: `Bearer ${tenantA.token}`,
        'X-Tenant-Slug': tenantA.slug,
      },
    });
    assert.equal(csvResp.status, 200);
    const csvText = await csvResp.text();
    assert.ok(csvText.includes('Quy mô đội Sale?'));
  });

  it('6. Web Tracking Visitors Timeline, Live Traffic, Page Details, Heatmaps (`mkt_web_heatmaps`) & Web LiveChat', async () => {
    const propRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/properties', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Landing Page Studio', domain: 'studio.domation.net' },
    });
    assert.equal(propRes.status, 201);
    propertyId = propRes.json.data.id;
    siteKey = propRes.json.data.site_key;

    const trk = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: 'vis_studio_01',
        event_type: 'click',
        page_url: 'https://studio.domation.net/bang-gia',
        x_pct: 52.4,
        y_pct: 28.0,
        scroll_depth_pct: 75,
        element_selector: 'BUTTON.buy-now',
        phone: '0912345678',
      },
    });
    assert.equal(trk.status, 201);
    sessionId = trk.json.data.session_id;

    const hmCreate = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/heatmaps', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        property_id: propertyId,
        name: 'Heatmap Trang Bảng Giá Desktop',
        page_url_pattern: '/bang-gia',
        device_filter: 'desktop',
      },
    });
    assert.equal(hmCreate.status, 201);
    heatmapId = hmCreate.json.data.id;
    assert.equal(hmCreate.json.data.click_count, 1);

    const visDetail = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/web-tracking/visitors/${sessionId}`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(visDetail.status, 200);
    assert.equal(visDetail.json.data.events.length, 1);

    const liveTraffic = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/live-traffic', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(liveTraffic.status, 200);
    assert.ok(liveTraffic.json.data.active_now_count >= 1);

    const pageDetails = await apiRequest(
      harness.baseUrl,
      '/api/v1/marketing/web-tracking/page-details?page_url=bang-gia',
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(pageDetails.status, 200);
    assert.equal(pageDetails.json.data.clicks, 1);
  });

  it('7. Social Bot Omnichannel: ScenarioCanvas, Zalo OA/ZNS Templates + Broadcast, AI Training Docs RAG & Human Takeover', async () => {
    // Visual ScenarioCanvas CRUD
    const scRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/scenarios', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Kịch bản Tư vấn Báo Giá Tự Động',
        channel: 'messenger',
        trigger_type: 'keyword',
        keywords: ['báo giá nhanh', 'xin giá'],
        nodes: [
          { id: 'n1', type: 'message', content: 'Chào bạn! Bạn cần tư vấn gói nào?' },
          { id: 'n2', type: 'collect_phone', content: 'Bạn cho mình xin SĐT nhé!' },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    });
    assert.equal(scRes.status, 201);
    scenarioId = scRes.json.data.id;

    // Zalo OA Config + Zalo ZNS Template + Zalo Broadcast
    const oaRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-oa', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { oa_id: 'OA_998877', oa_name: 'Sapphire Official OA', daily_quota: 5000 },
    });
    assert.equal(oaRes.status, 200);

    const zTplRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-templates', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'ZNS Xác Nhận Đơn Hàng VIP',
        template_code: 'ZNS_VIP_001',
        template_type: 'zns_transaction',
        price_vnd: 300,
        content_body: 'Xin chào {{customer_name}}, đơn hàng {{order_code}} đã xác nhận.',
        params_schema: [
          { key: 'customer_name', sample: 'Nguyễn Văn A', mapTo: 'lead.name' },
          { key: 'order_code', sample: 'SO-1001', mapTo: 'custom' },
        ],
      },
    });
    assert.equal(zTplRes.status, 201);
    zaloTemplateId = zTplRes.json.data.id;

    const zBroadcast = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/zalo-broadcast', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { template_id: zaloTemplateId, audience_id: audienceId },
    });
    assert.equal(zBroadcast.status, 200);
    assert.ok(zBroadcast.json.data.sent_count >= 1);

    // AI Training Document RAG (`mkt_ai_training_docs`) — Tenant-Isolated!
    const docRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/training-docs', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Chính sách bảo hành kim cương Sapphire',
        doc_type: 'policy',
        content_text: 'Tất cả sản phẩm Sapphire Studio được bảo hành đánh bóng trọn đời 10 năm miễn phí tại toàn hệ thống.',
      },
    });
    assert.equal(docRes.status, 201);
    trainingDocId = docRes.json.data.id;

    const testRagA = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/bot-test', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { message: 'Cho hỏi chính sách bảo hành kim cương của bên mình?' },
    });
    assert.equal(testRagA.status, 200);
    assert.ok(String(testRagA.json.data.reply).includes('10 năm'));

    // Tenant B bot-test MUST NOT leak Tenant A's training document!
    const testRagB = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/bot-test', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { message: 'Cho hỏi chính sách bảo hành kim cương của bên mình?' },
    });
    assert.equal(testRagB.status, 200);
    assert.ok(!String(testRagB.json.data.reply).includes('10 năm'));

    // Web LiveChat conversation + Human Takeover (`PATCH /conversations/:id`)
    const wcCreate = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/conversations', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        channel: 'web_chat',
        customer_name: 'Khách Web Bảng Giá',
        content: 'Mình đang xem trang bảng giá sđt 0912345678 cần tư vấn ngay',
      },
    });
    assert.equal(wcCreate.status, 201);
    webChatConvId = wcCreate.json.data.conversation_id;

    const pauseBot = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/social-bot/conversations/${webChatConvId}`,
      {
        method: 'PATCH',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { bot_paused: true, mark_read: true },
      }
    );
    assert.equal(pauseBot.status, 200);
    assert.equal(Boolean(pauseBot.json.data.bot_paused), true);

    // Web Tracking `ConversationsTab` returns web_chat thread + visitor page trail!
    const wtConvs = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/conversations', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(wtConvs.status, 200);
    assert.equal(wtConvs.json.data.items.length, 1);
    assert.ok(wtConvs.json.data.items[0].page_trail.length >= 1);
  });

  it('8. Kernel FORCE ROW LEVEL SECURITY Zero-Leakage across ALL 32 Marketing Tables', async () => {
    assert.equal(MARKETING_TABLES.length, 32);

    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of MARKETING_TABLES) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped query on ${tbl} must return 0 rows`);
      }
    });

    await withTenantTransaction(tenantB.id, async (client) => {
      const checks: Array<[string, string]> = [
        ['mkt_media_assets', mediaAssetId],
        ['mkt_campaign_reminders', reminderId],
        ['mkt_web_heatmaps', heatmapId],
        ['mkt_automation_scenarios', scenarioId],
        ['mkt_zalo_templates', zaloTemplateId],
        ['mkt_ai_training_docs', trainingDocId],
      ];
      for (const [tbl, id] of checks) {
        const r = await client.query(`SELECT * FROM ${tbl} WHERE id = $1`, [id]);
        assert.equal(r.rows.length, 0, `Tenant B must see 0 rows of Tenant A in ${tbl}`);
      }
      const oaLeak = await client.query('SELECT * FROM mkt_zalo_oa_configs');
      assert.equal(oaLeak.rows.length, 0);
      const aclLeak = await client.query('SELECT * FROM mkt_template_acl');
      assert.equal(aclLeak.rows.length, 0);
    });
  });
});
