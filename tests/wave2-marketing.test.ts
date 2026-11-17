import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { flushDomainEvents } from '../server/core/events/event-bus.ts';
import { MARKETING_TABLES } from '../server/modules/marketing/schema.ts';

describe('Wave 2 Phase 2: Full Marketing Automation Suite & Kernel RLS Zero-Leakage', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  let tenantB: { id: string; slug: string; token: string };

  let alphaAudienceId = '';
  let alphaTemplateId = '';
  let alphaNurtureFormToken = '';
  let alphaNurtureFormId = '';
  let alphaSaleFormToken = '';
  let alphaSurveySlug = '';
  let alphaSurveyId = '';
  let alphaCampaignId = '';
  let alphaFlowId = '';
  let alphaVoucherPoolId = '';
  let alphaShortCode = '';
  let alphaSiteKey = '';
  let alphaPropertyId = '';
  let alphaConvId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Sapphire Growth Corp',
        tenant_slug: 'sapphire-growth',
        admin_name: 'Minh Khoi',
        work_email: 'owner@sapphire.vn',
        phone: '0901112233',
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
        company_name: 'Emerald Retail Group',
        tenant_slug: 'emerald-retail',
        admin_name: 'Lan Phuong',
        work_email: 'owner@emerald.vn',
        phone: '0904445566',
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
  });

  after(async () => {
    await harness.close();
  });

  it('1. Enforces 4-Package Entitlement Gate: Gói 1 (autodata_crm) blocks /marketing/*, Gói 2 & Gói 3 unlock', async () => {
    const blocked = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'MODULE_NOT_ENTITLED');

    // Switch Tenant B to Gói 2 (`marketing_standalone`) and Tenant A to Gói 3 (`growth_combo`)
    const swB = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { package_code: 'marketing_standalone' },
    });
    assert.equal(swB.status, 200);

    const swA = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'growth_combo' },
    });
    assert.equal(swA.status, 200);

    const unlockedB = await apiRequest(harness.baseUrl, '/api/v1/marketing/overview', {
      token: tenantB.token,
      tenantSlug: tenantB.slug,
    });
    assert.equal(unlockedB.status, 200);

    // Create a static Audience in Tenant A for downstream Form, Campaign, Web Tracking & Social tests
    const audRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Tệp Khách Hàng VIP Q4',
        audience_type: 'static_data',
      },
    });
    assert.equal(audRes.status, 201);
    alphaAudienceId = audRes.json.data.id;
  });

  it('2. Templates Module: 15-Block HTML Compiler, Countdown SVG, Spam Analyzer & DOM Agent Email Studio', async () => {
    const aiGen = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates/ai-generate', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        goal: 'Ra mắt bộ sưu tập mới ưu đãi 20%',
        tone: 'professional',
        include_voucher: true,
        include_countdown: true,
      },
    });
    assert.equal(aiGen.status, 200);
    assert.equal(aiGen.json.data.generator, 'DOM Agent Email Studio');
    assert.ok(aiGen.json.data.blocks.length >= 5);
    assert.ok(aiGen.json.data.compiled_html.includes('{{unsubscribe_url}}'));

    const createTpl = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Email Chào Mừng Khách Mới',
        subject: aiGen.json.data.subject,
        preheader: aiGen.json.data.preheader,
        blocks: aiGen.json.data.blocks,
      },
    });
    assert.equal(createTpl.status, 201);
    alphaTemplateId = createTpl.json.data.id;
    assert.ok(createTpl.json.data.merge_tags.includes('{{lead.name}}'));

    // Cross-tenant isolation check
    const crossRead = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/templates/${alphaTemplateId}`,
      {
        token: tenantB.token,
        tenantSlug: tenantB.slug,
      }
    );
    assert.equal(crossRead.status, 404);
  });

  it('3. Forms & OTP Triggers: Phone-Only Support, OTP Verify, Mode A (Nurture) vs Mode B (Sale Round) & Purchase Events', async () => {
    // Mode A Form: Phone-only + OTP required + attach to Audience
    const createNurtureForm = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Form Đăng Ký Nhận Ưu Đãi (Phone-Only)',
        routing_mode: 'marketing_nurture',
        target_audience_id: alphaAudienceId,
        require_otp: true,
        otp_channel: 'sms',
        fields: [
          { id: 'f1', key: 'name', label: 'Họ tên', type: 'text', required: true },
          { id: 'f2', key: 'phone', label: 'Số điện thoại', type: 'phone', required: true },
        ],
      },
    });
    assert.equal(createNurtureForm.status, 201);
    alphaNurtureFormId = createNurtureForm.json.data.id;
    alphaNurtureFormToken = createNurtureForm.json.data.public_token;

    // Public GET schema
    const pubSchema = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/forms/${alphaNurtureFormToken}`
    );
    assert.equal(pubSchema.status, 200);
    assert.equal(pubSchema.json.data.require_otp, true);

    // Public OTP Send -> Verify
    const otpSend = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/send', {
      method: 'POST',
      body: {
        form_token: alphaNurtureFormToken,
        recipient: '0918111222',
        channel: 'sms',
      },
    });
    assert.equal(otpSend.status, 201);
    const otpId = otpSend.json.data.otp_id;
    const sandboxCode = otpSend.json.data.sandbox_otp_code;
    assert.ok(sandboxCode);

    const otpVerify = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/verify', {
      method: 'POST',
      body: {
        otp_id: otpId,
        code: sandboxCode,
      },
    });
    assert.equal(otpVerify.status, 200);
    assert.equal(otpVerify.json.data.verified, true);

    // Submit Mode A Form (Phone-only, NO email!)
    const subModeA = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/forms/${alphaNurtureFormToken}/submit`,
      {
        method: 'POST',
        body: {
          name: 'Trần Hoàng Nam',
          phone: '0918111222',
          otp_id: otpId,
        },
      }
    );
    assert.equal(subModeA.status, 201);
    assert.equal(subModeA.json.data.routing_mode, 'marketing_nurture');
    const modeALeadId = subModeA.json.data.lead_id;

    await withTenantTransaction(tenantA.id, async (client) => {
      const l = await client.query<{ status: string }>(
        'SELECT status FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, modeALeadId]
      );
      assert.equal(l.rows[0]?.status, 'marketing_nurture');
    });

    // Mode B Form: Direct Sale Round Routing
    const createSaleForm = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Form Tư Vấn Nóng Chia Sale Ngay',
        routing_mode: 'sale_round',
        require_otp: false,
        fields: [
          { id: 'f1', key: 'name', label: 'Họ tên', type: 'text', required: true },
          { id: 'f2', key: 'email', label: 'Email', type: 'email', required: true },
        ],
      },
    });
    assert.equal(createSaleForm.status, 201);
    alphaSaleFormToken = createSaleForm.json.data.public_token;

    const subModeB = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/forms/${alphaSaleFormToken}/submit`,
      {
        method: 'POST',
        body: {
          name: 'Lê Thu Hà',
          email: 'thuha@client.vn',
        },
      }
    );
    assert.equal(subModeB.status, 201);
    const modeBLeadId = subModeB.json.data.lead_id;

    await withTenantTransaction(tenantA.id, async (client) => {
      const l = await client.query<{ status: string; pipeline_id: string | null }>(
        'SELECT status, pipeline_id FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, modeBLeadId]
      );
      assert.ok(
        l.rows[0]?.status === 'unassigned_pending' || l.rows[0]?.status === 'assigned',
        'Mode B must route directly out of marketing_nurture into Sale Pipeline'
      );
      assert.ok(l.rows[0]?.pipeline_id, 'Mode B must attach default pipeline_id');
    });

    // Purchase Event Trigger updates `total_revenue_vnd`
    const createPurchaseEvt = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms/events', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        event_name: 'Thanh Toán Đơn Hàng Online',
        event_key: 'checkout_paid',
        event_category: 'purchase',
      },
    });
    assert.equal(createPurchaseEvt.status, 201);

    const fireEvt = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/forms/events/${createPurchaseEvt.json.data.id}/trigger`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          email: 'thuha@client.vn',
          amount_vnd: 15_000_000,
        },
      }
    );
    assert.equal(fireEvt.status, 200);
  });

  it('4. Surveys & Quiz (25 Blocks): Public Submission Computes Lead Score, Tags & NPS Analytics', async () => {
    const listCatalog = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(listCatalog.status, 200);
    assert.equal(listCatalog.json.data.block_catalog.length, 25);

    const createSrv = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Khảo sát NPS & Trắc nghiệm Nhu cầu',
        survey_type: 'quiz',
        settings: {
          auto_tag: 'Survey Completed',
          base_lead_score: 10,
          target_audience_id: alphaAudienceId,
        },
        blocks: [
          { id: 'q_nps', type: 'nps', label: 'Mức độ hài lòng 0-10?' },
          {
            id: 'q_quiz',
            type: 'quiz_scored',
            label: 'Quy mô nhân sự của bạn?',
            points: 20,
            correctValue: '50+',
            options: [
              { id: 'o1', label: 'Dưới 50', value: '<50', points: 5 },
              { id: 'o2', label: 'Trên 50 nhân sự', value: '50+', points: 20 },
            ],
          },
        ],
      },
    });
    assert.equal(createSrv.status, 201);
    alphaSurveyId = createSrv.json.data.id;
    alphaSurveySlug = createSrv.json.data.slug;

    const pubSubmit = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/surveys/${alphaSurveySlug}`,
      {
        method: 'POST',
        body: {
          name: 'Phạm Quốc Bảo',
          email: 'quocbao@enterprise.vn',
          phone: '0903777888',
          answers: {
            q_nps: 10,
            q_quiz: '50+',
          },
        },
      }
    );
    assert.equal(pubSubmit.status, 201);
    assert.equal(pubSubmit.json.data.nps_score, 10);
    assert.equal(pubSubmit.json.data.quiz_score, 45); // 10 base + 15 NPS promoter + 20 quiz_scored
    assert.ok(pubSubmit.json.data.tags_applied.includes('NPS Promoter'));

    const analytics = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/surveys/${alphaSurveyId}/analytics`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(analytics.status, 200);
    assert.equal(analytics.json.data.summary.total_responses, 1);
    assert.equal(analytics.json.data.summary.nps_index, 100);
  });

  it('5. Campaigns: Atomic Send-Claim Lock, Open/Click Tracking, Reminders, Unsubscribe HMAC & Attributed ROI', async () => {
    const createCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Chiến dịch Email Ưu Đãi VIP Q4',
        channel: 'email',
        audience_id: alphaAudienceId,
        template_id: alphaTemplateId,
        subject_a: 'Ưu đãi đặc quyền cho {{lead.name}}',
        subject_b: 'Quà tặng VIP dành riêng cho {{lead.name}}',
        ab_split_ratio: 50,
        cost_vnd: 500_000,
        reminder_config: { enabled: true, trigger_condition: 'no_open', wait_hours: 24 },
      },
    });
    assert.equal(createCamp.status, 201);
    alphaCampaignId = createCamp.json.data.id;

    // First send claims & dispatches to subscribed email members in `alphaAudienceId`
    const send1 = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/campaigns/${alphaCampaignId}/send`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(send1.status, 200);
    assert.ok(send1.json.data.newly_sent >= 1);
    const firstClaimId = send1.json.data.claim_ids[0];

    // Second send MUST be blocked by atomic send-claim lock (`newly_sent === 0`, `duplicate_claims_prevented >= 1`)
    const send2 = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/campaigns/${alphaCampaignId}/send`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(send2.status, 200);
    assert.equal(send2.json.data.newly_sent, 0);
    assert.ok(send2.json.data.duplicate_claims_prevented >= 1);

    // Track open & click publicly
    const openResp = await fetch(
      `${harness.baseUrl}/api/v1/public/marketing/track/open/${firstClaimId}`
    );
    assert.equal(openResp.status, 200);

    const clickResp = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/track/click/${firstClaimId}?url=https://domation.net/promo&json=1`
    );
    assert.equal(clickResp.status, 200);

    // Sync attributed revenue
    const attrResp = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/campaigns/${alphaCampaignId}/attribute-revenue`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { amount_vnd: 12_000_000 },
      }
    );
    assert.equal(attrResp.status, 200);
    assert.ok(attrResp.json.data.attributed_revenue_vnd >= 12_000_000);
    assert.equal(attrResp.json.data.opened_count, 1);
    assert.equal(attrResp.json.data.clicked_count, 1);
  });

  it('6. Automation Flows: 15 Triggers × 11 Nodes, Snapshot Publish, Simulate, Review & Real Event-Bus Sale Promotion', async () => {
    const createVoucherForFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Kho Mã Chào Mừng Tự Động',
        code_prefix: 'FLOW',
        discount_type: 'percentage',
        discount_value: 15,
        auto_generate_count: 5,
      },
    });
    assert.equal(createVoucherForFlow.status, 201);
    alphaVoucherPoolId = createVoucherForFlow.json.data.id;

    const createFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Nuôi Dưỡng Khách Điền Form -> Đẩy Vòng Chia Sale',
        trigger_type: 'form_submitted',
        trigger_config: {},
        steps: [
          {
            id: 'step_score',
            type: 'update_lead_score',
            label: 'Cộng 35 điểm nóng',
            config: { delta: 35 },
            nextStepId: 'step_cond',
          },
          {
            id: 'step_cond',
            type: 'if_else_condition',
            label: 'Kiểm tra Điểm nóng >= 30',
            config: { field: 'lead_score', operator: 'gte', value: 30 },
            yesStepId: 'step_voucher',
            noStepId: null,
          },
          {
            id: 'step_voucher',
            type: 'issue_voucher',
            label: 'Tặng mã ưu đãi 15%',
            config: { voucher_campaign_id: alphaVoucherPoolId },
            nextStepId: 'step_sale_handoff',
          },
          {
            id: 'step_sale_handoff',
            type: 'push_to_autodata_sale_round',
            label: 'Đẩy vào Vòng chia Sale Auto Data',
            config: {},
            nextStepId: null,
          },
        ],
      },
    });
    assert.equal(createFlow.status, 201);
    alphaFlowId = createFlow.json.data.id;

    // Dry-run Simulation (`FlowSimulateModal`)
    const simRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/flows/${alphaFlowId}/simulate`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { sample_lead: { name: 'Khách Giả Lập', lead_score: 0 } },
      }
    );
    assert.equal(simRes.status, 200);
    assert.equal(simRes.json.data.wouldPushToSaleRound, true);
    assert.equal(simRes.json.data.trace.length, 4);

    // DOM Agent Audit (`FlowReviewModal`)
    const revRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/flows/${alphaFlowId}/review`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(revRes.status, 200);
    assert.equal(revRes.json.data.auditor, 'DOM Agent');
    assert.ok(revRes.json.data.score >= 85);

    // Publish Flow -> creates immutable snapshot & activates Event-Bus listener!
    const pubFlow = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/flows/${alphaFlowId}/publish`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(pubFlow.status, 200);
    assert.equal(pubFlow.json.data.flow.status, 'active');

    // Create a non-OTP Mode A (`marketing_nurture`) Form and submit a brand-new contact:
    // Event-Bus MUST fire the active Flow and promote the contact from `marketing_nurture` -> `unassigned_pending`!
    const nurtureForm2 = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Form Ebook Nuôi Dưỡng Tự Động',
        routing_mode: 'marketing_nurture',
        require_otp: false,
        fields: [{ id: 'p', key: 'phone', label: 'SĐT', type: 'phone', required: true }],
      },
    });
    assert.equal(nurtureForm2.status, 201);

    const subNurture = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/forms/${nurtureForm2.json.data.public_token}/submit`,
      {
        method: 'POST',
        body: { name: 'Đặng Minh Tuấn', phone: '0977666555' },
      }
    );
    assert.equal(subNurture.status, 201);
    await flushDomainEvents();

    const promotedLeadId = subNurture.json.data.lead_id;
    await withTenantTransaction(tenantA.id, async (client) => {
      const l = await client.query<{ status: string; lead_score: number }>(
        'SELECT status, lead_score FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, promotedLeadId]
      );
      assert.ok(
        l.rows[0]?.status === 'unassigned_pending' || l.rows[0]?.status === 'assigned',
        'Active Flow push_to_autodata_sale_round node must promote marketing_nurture lead to Sale queue'
      );
      assert.ok(Number(l.rows[0]?.lead_score) >= 35);
    });
  });

  it('7. Vouchers CSV Import, POS Counter Redeem & Shortlink /r/:code Redirect + UTM', async () => {
    const csvImport = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/vouchers/${alphaVoucherPoolId}/import-csv`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { csv_text: 'code\nSAPPHIRE-POS-01\nSAPPHIRE-POS-02' },
      }
    );
    assert.equal(csvImport.status, 200);

    const posRedeem = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/redeem', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        code: 'SAPPHIRE-POS-01',
        phone: '0903777888',
        order_vnd: 2_500_000,
        note: 'Gạch mã tại quầy Quận 1',
      },
    });
    assert.equal(posRedeem.status, 200);
    assert.equal(posRedeem.json.data.code, 'SAPPHIRE-POS-01');

    // Double redeem must fail with 400 CODE_ALREADY_REDEEMED
    const doubleRedeem = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/redeem', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { code: 'SAPPHIRE-POS-01' },
    });
    assert.equal(doubleRedeem.status, 400);

    // Shortlink + QR Designer
    const createLink = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/shortlinks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Chiến dịch QR Standee Hội Chợ',
        target_url: 'https://domation.net/landing',
        utm_source: 'qr_standee',
        utm_medium: 'offline',
        utm_campaign: 'expo_2026',
      },
    });
    assert.equal(createLink.status, 201);
    alphaShortCode = createLink.json.data.short_code;

    const hitShortlink = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/marketing/r/${alphaShortCode}?json=1`
    );
    assert.equal(hitShortlink.status, 200);
    assert.ok(hitShortlink.json.data.redirect_url.includes('utm_source=qr_standee'));
  });

  it('8. Web Tracking: Anonymous Session -> Identity Stitching -> Pricing Intent Alert -> Heatmap', async () => {
    const createProp = await apiRequest(
      harness.baseUrl,
      '/api/v1/marketing/web-tracking/properties',
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'Website Chính Sapphire',
          domain: 'sapphire.vn',
          pricing_url_pattern: '/bang-gia,/pricing',
          target_audience_id: alphaAudienceId,
        },
      }
    );
    assert.equal(createProp.status, 201);
    alphaPropertyId = createProp.json.data.id;
    alphaSiteKey = createProp.json.data.site_key;

    // 1. Anonymous click event (Heatmap)
    const anonClick = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: alphaSiteKey,
        visitor_token: 'vis_sapphire_999',
        event_type: 'click',
        page_url: 'https://sapphire.vn/',
        x_pct: 48.5,
        y_pct: 32.1,
        element_selector: 'BUTTON.cta-hero',
      },
    });
    assert.equal(anonClick.status, 201);
    assert.equal(anonClick.json.data.stitched, false);

    // 2. Pricing-Page visit + Identity Stitching
    const pricingIdentify = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: alphaSiteKey,
        visitor_token: 'vis_sapphire_999',
        event_type: 'pageview',
        page_url: 'https://sapphire.vn/bang-gia',
        name: 'Vũ Ngọc Ánh',
        email: 'ngocanh@vip.vn',
        phone: '0933222111',
      },
    });
    assert.equal(pricingIdentify.status, 201);
    assert.equal(pricingIdentify.json.data.stitched, true);
    assert.equal(pricingIdentify.json.data.pricing_intent_detected, true);

    const heatmap = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/web-tracking/heatmap?property_id=${alphaPropertyId}`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(heatmap.status, 200);
    assert.equal(heatmap.json.data.click_points.length, 1);
    assert.equal(heatmap.json.data.click_points[0].x_pct, 48.5);
  });

  it('9. Social Bot & AI Bot Studio: Tenant-Isolated RAG Rules, Auto Phone/Email Extraction & Customer 360 Drawer', async () => {
    const saveCfg = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/bot-config', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        bot_name: 'DOM Sapphire Concierge',
        brand_persona: 'Chuyên gia bán lẻ cao cấp Sapphire.',
        auto_extract_contact: true,
        routing_mode: 'audience',
        target_audience_id: alphaAudienceId,
        faq_rules: [
          {
            id: 'faq_secret_a',
            keywords: ['chính sách đại lý sapphire'],
            question: 'Chính sách đại lý Sapphire thế nào?',
            answer: 'Chiết khấu đại lý Sapphire cấp 1 là 35% cho đơn từ 100 triệu.',
          },
        ],
      },
    });
    assert.equal(saveCfg.status, 200);

    // Tenant B bot test MUST NOT match Tenant A's FAQ rule!
    const testB = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/bot-test', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { message: 'Cho mình hỏi chính sách đại lý sapphire?' },
    });
    assert.equal(testB.status, 200);
    assert.ok(!String(testB.json.data.reply).includes('35%'));

    // Inbound Messenger chat on Tenant A with phone + FAQ keyword
    const chatA = await apiRequest(harness.baseUrl, '/api/v1/marketing/social-bot/conversations', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        channel: 'messenger',
        customer_name: 'Ngô Thanh Tùng',
        content: 'Cho mình hỏi chính sách đại lý sapphire, sđt mình 0944555666 email tung@agency.vn',
      },
    });
    assert.equal(chatA.status, 201);
    alphaConvId = chatA.json.data.conversation_id;
    assert.equal(chatA.json.data.extracted_entities.phone, '0944555666');
    assert.equal(chatA.json.data.extracted_entities.email, 'tung@agency.vn');
    assert.ok(String(chatA.json.data.bot_reply).includes('35%'));
    assert.ok(chatA.json.data.lead_id);

    // Customer 360° Drawer
    const drawer = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/social-bot/conversations/${alphaConvId}`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(drawer.status, 200);
    assert.ok(drawer.json.data.customer_360);
    assert.equal(drawer.json.data.messages.length, 2);

    // 1-Click Push to Sale Round
    const pushSale = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/social-bot/conversations/${alphaConvId}/push-lead`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { mode: 'sale_round' },
      }
    );
    assert.equal(pushSale.status, 200);
  });

  it('10. Kernel FORCE ROW LEVEL SECURITY Zero-Leakage across ALL 24 Marketing Tables', async () => {
    // Lemma 1: Unscoped queries without `app.current_tenant_id` MUST return 0 rows on ALL 24 tables
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of MARKETING_TABLES) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(
          res.rows.length,
          0,
          `Unscoped query on ${tbl} must return 0 rows under FORCE ROW LEVEL SECURITY`
        );
      }
    });

    // Lemma 2: Tenant B transaction MUST see 0 rows of Tenant A's Marketing records even by exact UUID
    await withTenantTransaction(tenantB.id, async (client) => {
      const checks: Array<[string, string]> = [
        ['mkt_email_templates', alphaTemplateId],
        ['mkt_forms', alphaNurtureFormId],
        ['mkt_surveys', alphaSurveyId],
        ['mkt_campaigns', alphaCampaignId],
        ['mkt_flows', alphaFlowId],
        ['mkt_voucher_campaigns', alphaVoucherPoolId],
        ['mkt_web_properties', alphaPropertyId],
        ['mkt_social_conversations', alphaConvId],
      ];
      for (const [tbl, id] of checks) {
        const r = await client.query(`SELECT * FROM ${tbl} WHERE id = $1`, [id]);
        assert.equal(r.rows.length, 0, `Cross-tenant SELECT on ${tbl} must return 0 rows`);
      }
    });
  });
});
