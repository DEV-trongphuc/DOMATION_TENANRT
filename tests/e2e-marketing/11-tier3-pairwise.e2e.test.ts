import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  startMarketingE2eHarness,
  type MarketingE2eHarness,
  type TenantAuthContext,
} from './_harness.ts';

let harness: MarketingE2eHarness;

async function configureResendEmail(auth: TenantAuthContext, fromEmail: string): Promise<void> {
  const res = await harness.apiJson('/api/v1/auth/tenant-settings', {
    method: 'PATCH',
    auth,
    body: {
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_e2e_pair_key_001',
        resend_from_email: fromEmail,
        resend_from_name: 'DOMATION Pairwise E2E',
      },
    },
  });
  assert.equal(res.success, true);
}

async function configureZnsVault(auth: TenantAuthContext): Promise<void> {
  const res = await harness.apiJson('/api/v1/integrations/vault/zalo_zns', {
    method: 'PUT',
    auth,
    body: {
      access_token: 'zns_live_pair_tok_001',
      refresh_token: 'zns_pair_ref_001',
      oa_id: 'OA_PAIR_01',
      app_id: 'APP_PAIR_01',
    },
  });
  assert.equal(res.data.integration_type, 'zalo_zns');
}

async function setupCapiVault(
  auth: TenantAuthContext,
  opts?: { datasetId?: string; accessToken?: string; testEventCode?: string }
): Promise<void> {
  const res = await harness.apiJson('/api/v1/integrations/vault/meta_capi', {
    method: 'PUT',
    auth,
    body: {
      dataset_id: opts?.datasetId ?? '998877665544',
      access_token: opts?.accessToken ?? 'EAA_e2e_pair_capi_token_1234567890abcdef',
      live_http_enabled: true,
      test_event_code: opts?.testEventCode ?? 'TEST_PAIR_08',
    },
  });
  assert.equal(res.data.integration_type, 'meta_capi');
}

function signHmacHex(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function decodeHtmlHref(rawHref: string): string {
  return rawHref.replace(/&amp;/g, '&');
}

describe('Tier 3: Cross-Feature Pairwise Combinations (E2E)', () => {
  before(async () => {
    harness = await startMarketingE2eHarness();
  });

  after(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.resetCaptures();
  });

  it('T3-01: Form/Survey submission -> Tag & Quiz Score persistence -> Dynamic Segment evaluation', async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

    const formRes = await harness.apiJson('/api/v1/marketing/forms', {
      method: 'POST',
      auth,
      body: {
        name: 'Pairwise VIP Form',
        fields: [
          { id: 'f_name', key: 'name', label: 'Name', type: 'text', required: true },
          { id: 'f_email', key: 'email', label: 'Email', type: 'email', required: true },
          { id: 'f_phone', key: 'phone', label: 'Phone', type: 'phone' },
        ],
      },
    });
    const formToken = String(formRes.data.public_token);
    assert.ok(formToken);

    const formSubRes = await harness.apiRaw(`/api/v1/public/marketing/forms/${formToken}/submit`, {
      method: 'POST',
      body: {
        name: 'Pair1 Lead',
        email: 'pair1@test.vn',
        phone: '0909100001',
        tier: 'vip',
      },
    });
    assert.equal(formSubRes.status, 201);
    const leadId = String(formSubRes.json?.data?.lead_id || '');
    assert.ok(leadId);
    assert.equal(formSubRes.json?.data?.status, 'marketing_nurture');

    const surveyRes = await harness.apiJson('/api/v1/marketing/surveys', {
      method: 'POST',
      auth,
      body: {
        title: 'Pairwise Tag Quiz',
        survey_type: 'quiz',
        blocks: [
          { id: 'q1', type: 'quiz_scored', label: 'Plan?', correctValue: 'pro', points: 45 },
        ],
        settings: {
          base_lead_score: 5,
          auto_tag: 'Survey Completed',
        },
        redirect_rules: [
          {
            minScore: 40,
            maxScore: 100,
            assignTag: 'VIP Qualified',
            redirectUrl: 'https://domation.net/vip',
          },
        ],
      },
    });
    const surveySlug = String(surveyRes.data.slug);
    assert.ok(surveySlug);

    const surveySubRes = await harness.apiRaw(`/api/v1/public/marketing/surveys/${surveySlug}`, {
      method: 'POST',
      body: {
        tenant_slug: auth.tenantSlug,
        name: 'Pair1 Lead',
        email: 'pair1@test.vn',
        phone: '0909100001',
        answers: { q1: 'pro' },
      },
    });
    assert.equal(surveySubRes.status, 201);
    assert.equal(surveySubRes.json?.data?.lead_id, leadId);
    assert.equal(surveySubRes.json?.data?.quiz_score, 50);
    assert.ok(surveySubRes.json?.data?.tags_applied?.includes('VIP Qualified'));
    assert.ok(surveySubRes.json?.data?.tags_applied?.includes('Survey Completed'));

    const contactsRes = await harness.apiJson('/api/v1/audiences/contacts?search=pair1%40test.vn', { auth });
    assert.equal(contactsRes.data.items.length, 1);
    const contact = contactsRes.data.items[0];
    assert.equal(contact.id, leadId);
    // Survey persists quiz_score=50 to leads.lead_score (form.submitted only emits scoreDelta=15 as an event hint)
    assert.ok(Number(contact.lead_score) >= 50);
    const tagNames = (contact.tags || []).map((t: any) => t.name);
    assert.ok(tagNames.includes('VIP Qualified'), `Expected VIP Qualified tag, got ${JSON.stringify(tagNames)}`);
    assert.ok(tagNames.includes('Survey Completed'), `Expected Survey Completed tag, got ${JSON.stringify(tagNames)}`);

    const branches = [
      {
        join: 'AND',
        rules: [
          { field: 'submitted_form', val: true },
          { field: 'tag', op: 'equals', val: 'VIP Qualified' },
          { field: 'quiz_score', op: 'gte', value: 40 },
          { field: 'cf.tier', op: 'equals', val: 'vip' },
        ],
      },
    ];

    const segRes = await harness.apiRaw('/api/v1/audiences', {
      method: 'POST',
      auth,
      body: {
        name: 'Form+Survey Tag Dynamic Seg',
        audience_type: 'dynamic_logic',
        filter_branches: branches,
      },
    });
    assert.equal(segRes.status, 201);
    const segId = String(segRes.json?.data?.id);
    assert.equal(segRes.json?.data?.cached_member_count, 1);
    assert.ok(segRes.json?.data?.evaluation?.entered_lead_ids?.includes(leadId));

    const membersRes = await harness.apiJson(`/api/v1/audiences/${segId}/members`, { auth });
    assert.ok(membersRes.data.items.some((m: any) => m.id === leadId));

    const previewRes = await harness.apiJson('/api/v1/audiences/preview', {
      method: 'POST',
      auth,
      body: { filter_branches: branches },
    });
    assert.equal(previewRes.data.count, 1);
  });

  it('T3-02: Dynamic Segment -> Flow Enrollment (wait_delay + Master Cron resume at current_step_id) -> Email & ZNS Dispatch', async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
    await configureResendEmail(auth, 'segwait@e2e.vn');
    await configureZnsVault(auth);
    harness.setSmtpCaptureEnabled(false);
    harness.emailCapture.length = 0;
    harness.zaloCapture.length = 0;

    try {
      await harness.apiJson('/api/v1/marketing/social-bot/zalo-templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair ZNS',
          template_code: 'ZNS_PAIR_02',
          content_body: 'Chào {{customer_name}}',
        },
      });

      const segRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Wait Flow Target Seg',
          audience_type: 'dynamic_logic',
          filter_branches: [
            {
              join: 'AND',
              rules: [{ field: 'cf.segment_ready', op: 'equals', val: 'yes' }],
            },
          ],
        },
      });
      const segId = String(segRes.data.id);

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Segment Wait Email ZNS Flow',
          status: 'active',
          trigger_type: 'audience_joined',
          trigger_config: { audience_id: segId },
          steps: [
            {
              id: 's1_score',
              type: 'update_lead_score',
              label: 'Score +10',
              config: { delta: 10 },
              nextStepId: 's2_wait',
            },
            {
              id: 's2_wait',
              type: 'wait_delay',
              label: 'Wait 0.005m',
              config: { duration: 0.005, unit: 'minutes' },
              nextStepId: 's3_email',
            },
            {
              id: 's3_email',
              type: 'send_email',
              label: 'Send Email',
              config: {
                subject: 'Seg Email {{lead.name}}',
                customHtml: '<p>Welcome {{lead.name}}</p>',
              },
              nextStepId: 's4_zns',
            },
            {
              id: 's4_zns',
              type: 'send_zns',
              label: 'Send ZNS',
              config: {
                template_id: 'ZNS_PAIR_02',
                subject: 'ZNS {{lead.name}}',
              },
            },
          ],
        },
      });
      const flowId = String(flowRes.data.id);

      const contactRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Seg Wait Lead',
          email: 'segwait@test.vn',
          phone: '0909200002',
          email_consent: 'subscribed',
          lead_score: 10,
          custom_fields: { segment_ready: 'yes' },
        },
      });
      const leadId = String(contactRes.data.id);

      const evalRes = await harness.apiJson(`/api/v1/audiences/${segId}/evaluate`, {
        method: 'POST',
        auth,
        body: {},
      });
      // POST /audiences/contacts already emits lead.created -> evaluateAllDynamicAudiencesForTenant -> auto-enters leadId
      assert.equal(evalRes.data.total_count, 1);

      const flowBeforeCron = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.equal(flowBeforeCron.data.enrollments.length, 1);
      assert.equal(flowBeforeCron.data.enrollments[0].lead_id, leadId);
      assert.equal(flowBeforeCron.data.enrollments[0].status, 'waiting');
      const waitParticipants = await harness.apiJson(
        `/api/v1/marketing/flows/${flowId}/steps/s2_wait/participants?status=waiting`,
        { auth }
      );
      assert.equal(
        waitParticipants.data.participants.some((p: any) => p.lead_id === leadId && p.enrollment_status === 'waiting'),
        true
      );

      const contactBeforeCron = await harness.apiJson('/api/v1/audiences/contacts?search=segwait%40test.vn', { auth });
      assert.equal(contactBeforeCron.data.items[0].lead_score, 20);
      assert.equal(harness.emailCapture.length, 0);
      assert.equal(harness.zaloCapture.length, 0);

      await new Promise((r) => setTimeout(r, 450));
      const cron = await harness.triggerMasterCron(['marketing_flows'], auth.tenantId);
      assert.equal(cron.status, 200);
      assert.ok(Number(cron.stats.marketingFlowsProcessed || 0) >= 1);

      const flowAfterCron = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.equal(flowAfterCron.data.enrollments.length, 1);
      assert.equal(flowAfterCron.data.enrollments[0].status, 'completed');

      const contactAfterCron = await harness.apiJson('/api/v1/audiences/contacts?search=segwait%40test.vn', { auth });
      assert.equal(
        contactAfterCron.data.items[0].lead_score,
        20,
        'wait_delay resume must NOT re-execute s1_score before s2_wait'
      );

      assert.equal(
        harness.emailCapture.some(
          (e) => e.driver === 'resend' && e.to === 'segwait@test.vn' && e.subject === 'Seg Email Seg Wait Lead'
        ),
        true
      );
      assert.equal(
        harness.zaloCapture.some(
          (z) =>
            z.channel === 'zns' &&
            z.url.includes('business.openapi.zalo.me') &&
            z.body?.template_id === 'ZNS_PAIR_02' &&
            String(z.body?.phone || '').endsWith('909200002')
        ),
        true
      );
    } finally {
      harness.setSmtpCaptureEnabled(true);
    }
  });

  it('T3-03: Email Send -> Open Pixel / Click Redirect -> marketing.engaged Flow Trigger', async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
    await configureResendEmail(auth, 'engage@e2e.vn');
    harness.setSmtpCaptureEnabled(false);

    try {
      const contactRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Engaged Reader',
          email: 'engaged@test.vn',
          email_consent: 'subscribed',
          lead_score: 0,
        },
      });
      const leadId = String(contactRes.data.id);

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Engage Aud', audience_type: 'static_data', lead_ids: [leadId] },
      });
      const audId = String(audRes.data.id);

      const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Engage Tpl',
          subject: 'Click Offer',
          compiled_html:
            '<html><body><p>Hi {{lead.name}}</p><a href="https://domation.net/promo-cta">Claim</a><a href="{{unsubscribe_url}}">Unsub</a></body></html>',
        },
      });
      const tplId = String(tplRes.data.id);

      const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Engage Camp',
          channel: 'email',
          audience_id: audId,
          template_id: tplId,
          subject_a: 'Open & Click {{lead.name}}',
        },
      });
      const campId = String(campRes.data.id);

      const openFlowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'On Email Opened Flow',
          status: 'active',
          trigger_type: 'email_opened',
          steps: [
            {
              id: 'op1',
              type: 'add_remove_tag',
              label: 'Tag Opened',
              config: { tag: 'opened-campaign', mode: 'add' },
            },
          ],
        },
      });
      const openFlowId = String(openFlowRes.data.id);

      const clickFlowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'On Link Clicked Flow',
          status: 'active',
          trigger_type: 'link_clicked',
          steps: [
            {
              id: 'cl1',
              type: 'add_remove_tag',
              label: 'Tag Clicked',
              config: { tag: 'clicked-campaign', mode: 'add' },
              nextStepId: 'cl2',
            },
            {
              id: 'cl2',
              type: 'update_lead_score',
              label: 'Click +20',
              config: { delta: 20 },
            },
          ],
        },
      });
      const clickFlowId = String(clickFlowRes.data.id);

      const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(sendRes.data.newly_sent, 1);
      const claimId = String(sendRes.data.claim_ids[0]);
      assert.ok(claimId);

      const sentEmail = harness.emailCapture.find((e) => e.driver === 'resend' && e.to === 'engaged@test.vn');
      assert.ok(sentEmail?.html, 'Expected captured Resend email HTML with injected tracking URLs');

      const openMatch = sentEmail!.html!.match(
        new RegExp(`https?://[^"'\\s>]+/api/v1/public/marketing/track/open/${claimId}[^"'\\s>]*`)
      );
      const clickMatch = sentEmail!.html!.match(
        new RegExp(`https?://[^"'\\s>]+/api/v1/public/marketing/track/click/${claimId}\\?[^"'\\s>]+`)
      );
      assert.ok(openMatch, 'Expected tracking pixel URL in email HTML');
      assert.ok(clickMatch, 'Expected click wrapper URL in email HTML');

      const openUrl = decodeHtmlHref(openMatch![0]);
      const clickUrl = decodeHtmlHref(clickMatch![0]);

      const openResp = await fetch(openUrl);
      assert.equal(openResp.status, 200);
      assert.ok(String(openResp.headers.get('content-type') || '').includes('image/gif'));

      const clickResp = await fetch(clickUrl, { redirect: 'manual' });
      assert.equal(clickResp.status, 302);
      assert.equal(clickResp.headers.get('location'), 'https://domation.net/promo-cta');

      const detailRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
      assert.equal(detailRes.data.funnel.opened, 1);
      assert.equal(detailRes.data.funnel.clicked, 1);

      const openFlowDetail = await harness.apiJson(`/api/v1/marketing/flows/${openFlowId}`, { auth });
      assert.equal(
        openFlowDetail.data.enrollments.some((e: any) => e.lead_id === leadId && e.status === 'completed'),
        true
      );

      const clickFlowDetail = await harness.apiJson(`/api/v1/marketing/flows/${clickFlowId}`, { auth });
      assert.equal(
        clickFlowDetail.data.enrollments.some((e: any) => e.lead_id === leadId && e.status === 'completed'),
        true
      );

      const contactAfter = await harness.apiJson('/api/v1/audiences/contacts?search=engaged%40test.vn', { auth });
      const row = contactAfter.data.items[0];
      const tagNames = (row.tags || []).map((t: any) => t.name);
      assert.ok(tagNames.includes('opened-campaign'));
      assert.ok(tagNames.includes('clicked-campaign'));
      // clickFlow's update_lead_score adds +20 (track/open & track/click emit scoreDelta hints without mutating DB lead_score)
      assert.ok(Number(row.lead_score) >= 20);
    } finally {
      harness.setSmtpCaptureEnabled(true);
    }
  });

  it(
    'T3-04: Web Tracking (/sdk.js + /track) anonymous-to-known stitching -> Dynamic Segment -> Flow enrollment',
    { timeout: 25_000 },
    async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

    const propRes = await harness.apiJson('/api/v1/marketing/web-tracking/properties', {
      method: 'POST',
      auth,
      body: {
        name: 'Pairwise Site',
        domain: 'pair4.test.vn',
        pricing_url_pattern: '/pricing,/bang-gia',
        auto_alert_pricing: true,
      },
    });
    const siteKey = String(propRes.data.site_key);
    assert.ok(siteKey);

    const sdkRes = await harness.apiRaw('/api/v1/public/marketing/sdk.js', {
      method: 'GET',
      query: { site_key: siteKey },
    });
    assert.equal(sdkRes.status, 200);
    assert.ok(sdkRes.rawText.includes(siteKey));
    assert.ok(sdkRes.rawText.includes('/api/v1/public/marketing/track'));

    const segRes = await harness.apiJson('/api/v1/audiences', {
      method: 'POST',
      auth,
      body: {
        name: 'Pricing Intent Seg',
        audience_type: 'dynamic_logic',
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'visited_url', val: '/pricing' },
              { field: 'lead_score', op: 'gte', value: 15 },
            ],
          },
        ],
      },
    });
    const segId = String(segRes.data.id);

    const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
      method: 'POST',
      auth,
      body: {
        name: 'Pricing Segment Flow',
        status: 'active',
        trigger_type: 'audience_joined',
        trigger_config: { audience_id: segId },
        steps: [
          {
            id: 'w_tag',
            type: 'add_remove_tag',
            label: 'Pricing Hot',
            config: { tag: 'pricing-hot', mode: 'add' },
          },
        ],
      },
    });
    const flowId = String(flowRes.data.id);

    const anonEv = await harness.apiRaw('/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: 'vis_pair_04',
        event_type: 'pageview',
        page_url: 'https://pair4.test.vn/home',
      },
    });
    assert.equal(anonEv.status, 201);
    assert.equal(anonEv.json?.data?.stitched, false);
    assert.equal(anonEv.json?.data?.lead_id, null);
    const sessionId = String(anonEv.json?.data?.session_id);

    const identifyResp = await fetch(`${harness.baseUrl}/api/v1/public/marketing/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_key: siteKey,
        visitor_token: 'vis_pair_04',
        event_type: 'identify',
        page_url: 'https://pair4.test.vn/pricing',
        email: 'webstitch.pair4@test.vn',
        name: 'Web Stitch Pair4',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const identifyJson = (await identifyResp.json()) as any;
    assert.equal(identifyResp.status, 201);
    assert.equal(identifyJson?.data?.stitched, true);
    assert.equal(identifyJson?.data?.pricing_intent_detected, true);
    const leadId = String(identifyJson?.data?.lead_id);
    assert.ok(leadId);

    const visitorDetail = await harness.apiJson(`/api/v1/marketing/web-tracking/visitors/${sessionId}`, { auth });
    assert.equal(visitorDetail.data.session?.lead_id, leadId);
    assert.equal(visitorDetail.data.events.length, 2);

    const pageDetailsHome = await harness.apiJson(
      `/api/v1/marketing/web-tracking/page-details?page_url=${encodeURIComponent('https://pair4.test.vn/home')}`,
      { auth }
    );
    assert.equal(pageDetailsHome.data.identified_leads, 1);

    const segMembers = await harness.apiJson(`/api/v1/audiences/${segId}/members`, { auth });
    assert.equal(
      segMembers.data.items.some((m: any) => m.id === leadId),
      true
    );

    const flowDetail = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
    assert.equal(
      flowDetail.data.enrollments.some((e: any) => e.lead_id === leadId && e.status === 'completed'),
      true
    );

    const contactsRes = await harness.apiJson('/api/v1/audiences/contacts?search=webstitch.pair4%40test.vn', { auth });
    const tagNames = (contactsRes.data.items[0]?.tags || []).map((t: any) => t.name);
    assert.ok(tagNames.includes('pricing-hot'));
  });

  it('T3-05: Shortlink /r/:code deduplicated click -> Voucher claim + POS redeem -> Campaign Revenue Attribution', async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
    await configureResendEmail(auth, 'voucher@e2e.vn');
    harness.setSmtpCaptureEnabled(false);

    try {
      const poolRes = await harness.apiJson('/api/v1/marketing/vouchers', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair5 Promo Pool',
          code_prefix: 'PR5',
          discount_type: 'fixed_vnd',
          discount_value: 200000,
          min_order_vnd: 500000,
          auto_generate_count: 5,
        },
      });
      const voucherSlug = String(poolRes.data.slug);
      assert.ok(voucherSlug);

      const shortCode = `pr5${Date.now().toString(36)}`;
      const linkRes = await harness.apiJson('/api/v1/marketing/vouchers/shortlinks', {
        method: 'POST',
        auth,
        body: {
          title: 'Voucher Claim Link',
          target_url: `https://app.domation.net/claim/${voucherSlug}`,
          short_code: shortCode,
          utm_source: 'email',
          utm_campaign: 'pair5',
        },
      });
      const linkId = String(linkRes.data.id);

      const leadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Voucher Buyer',
          email: 'vbuyer@test.vn',
          phone: '0909500005',
          email_consent: 'subscribed',
        },
      });
      const leadId = String(leadRes.data.id);

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Pair5 Aud', audience_type: 'static_data', lead_ids: [leadId] },
      });

      const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair5 Tpl',
          subject: 'Voucher For You',
          compiled_html: `<p>Hi</p><a href="https://app.domation.net/claim/${voucherSlug}">Claim</a>`,
        },
      });

      const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair5 Revenue Camp',
          channel: 'email',
          audience_id: audRes.data.id,
          template_id: tplRes.data.id,
          subject_a: 'Claim PR5',
          cost_vnd: 500000,
        },
      });
      const campId = String(campRes.data.id);

      const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      const claimId = String(sendRes.data.claim_ids[0]);
      assert.ok(claimId);

      const clickTrack = await fetch(
        `${harness.baseUrl}/api/v1/public/marketing/track/click/${claimId}?url=${encodeURIComponent(`https://app.domation.net/claim/${voucherSlug}`)}`,
        { redirect: 'manual' }
      );
      assert.equal(clickTrack.status, 302);

      // Same leadId across two different IPs/UAs = 1 unique visitor; plus 1 anonymous visitor = 2 unique visitors, 3 total clicks
      const r1 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}?lid=${encodeURIComponent(leadId)}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '198.51.100.11', 'User-Agent': 'MobilePair5/1.0' },
      });
      assert.equal(r1.status, 302);

      const r2 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}?lid=${encodeURIComponent(leadId)}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '198.51.100.12', 'User-Agent': 'DesktopPair5/2.0' },
      });
      assert.equal(r2.status, 302);

      const r3 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '198.51.100.77', 'User-Agent': 'AnonUA/1.0' },
      });
      assert.equal(r3.status, 302);

      const voucherList = await harness.apiJson('/api/v1/marketing/vouchers', { auth });
      const shortRow = (voucherList.data.shortlinks || []).find((s: any) => s.id === linkId);
      assert.equal(shortRow?.click_count, 3);
      assert.equal(shortRow?.unique_click_count, 2);

      const claimRes = await harness.apiRaw(`/api/v1/public/marketing/vouchers/${voucherSlug}/claim`, {
        method: 'POST',
        body: { email: 'vbuyer@test.vn', phone: '0909500005', name: 'Voucher Buyer' },
      });
      assert.equal(claimRes.status, 201);
      assert.equal(claimRes.json?.data?.lead_id, leadId);
      const claimedCode = String(claimRes.json?.data?.code);

      const redeemRes = await harness.apiJson('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth,
        body: { code: claimedCode, order_vnd: 2_000_000, note: 'POS Checkout Pair5' },
      });
      assert.equal(redeemRes.data.order_vnd, 2_000_000);

      const evtRes = await harness.apiJson('/api/v1/marketing/forms/events', {
        method: 'POST',
        auth,
        body: { event_name: 'POS Order Paid', event_category: 'purchase' },
      });
      const evtId = String(evtRes.data.id);

      const trigRes = await harness.apiJson(`/api/v1/marketing/forms/events/${evtId}/trigger`, {
        method: 'POST',
        auth,
        body: { email: 'vbuyer@test.vn', phone: '0909500005', amount_vnd: 2_000_000 },
      });
      assert.equal(trigRes.data.triggered, true);

      const attrRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/attribute-revenue`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(attrRes.data.attributed_revenue_vnd, 2_000_000);
      assert.equal(attrRes.data.roi_multiple, 4);

      const detailRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
      assert.equal(detailRes.data.campaign.attributed_revenue_vnd, 2_000_000);
    } finally {
      harness.setSmtpCaptureEnabled(true);
    }
  });

  it('T3-06: Package Upgrade (marketing_standalone -> domation_promax) preserves marketing data and unlocks CRM/CAPI', async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

    const blockedRounds = await harness.apiRaw('/api/v1/pipelines/rounds/list', { auth });
    assert.equal(blockedRounds.status, 403);
    assert.equal(blockedRounds.json?.error?.code, 'MODULE_NOT_ENTITLED');

    const blockedCapi = await harness.apiRaw('/api/v1/integrations/capi/test-event', {
      method: 'POST',
      auth,
      body: { event_name: 'Lead' },
    });
    assert.equal(blockedCapi.status, 403);
    assert.equal(blockedCapi.json?.error?.code, 'MODULE_NOT_ENTITLED');

    const contactRes = await harness.apiJson('/api/v1/audiences/contacts', {
      method: 'POST',
      auth,
      body: { name: 'Promax Lead', email: 'promax@test.vn', phone: '0909600006' },
    });
    const leadId = String(contactRes.data.id);

    const audRes = await harness.apiJson('/api/v1/audiences', {
      method: 'POST',
      auth,
      body: { name: 'Pre-Upgrade Aud', audience_type: 'static_data', lead_ids: [leadId] },
    });
    const audId = String(audRes.data.id);

    const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
      method: 'POST',
      auth,
      body: {
        name: 'Pre-Upgrade Tpl',
        subject: 'Sub',
        blocks: [{ id: 'b1', type: 'text', content: 'Body' }],
      },
    });
    const tplId = String(tplRes.data.id);

    const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
      method: 'POST',
      auth,
      body: {
        name: 'Pre-Upgrade Flow',
        status: 'active',
        trigger_type: 'manual_enroll',
        steps: [{ id: 's1', type: 'update_lead_score', config: { delta: 5 } }],
      },
    });
    const flowId = String(flowRes.data.id);

    const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
      method: 'POST',
      auth,
      body: {
        name: 'Pre-Upgrade Camp',
        channel: 'email',
        audience_id: audId,
        template_id: tplId,
        subject_a: 'Pre-Upgrade',
      },
    });
    const campId = String(campRes.data.id);

    const upg = await harness.upgradePackage(auth, 'domation_promax', {
      billingCycle: 'monthly',
      paymentMethod: 'wallet',
    });
    assert.equal(upg.upgraded, true);
    assert.equal(upg.zero_migration_preserved, true);
    assert.equal(upg.previous_package, 'marketing_standalone');
    assert.equal(upg.package_code, 'domation_promax');
    for (const mod of ['pipelines', 'rounds', 'ads_capi', 'hrm', 'deals']) {
      assert.ok(upg.enabled_modules.includes(mod), `Expected unlocked module ${mod}`);
    }

    const flowsAfter = await harness.apiJson('/api/v1/marketing/flows', { auth });
    assert.ok((flowsAfter.data.items || flowsAfter.data || []).some((f: any) => f.id === flowId));

    const campsAfter = await harness.apiJson('/api/v1/marketing/campaigns', { auth });
    assert.ok((campsAfter.data.items || campsAfter.data || []).some((c: any) => c.id === campId));

    const audsAfter = await harness.apiJson('/api/v1/audiences', { auth });
    const preservedAud = (audsAfter.data.items || audsAfter.data || []).find((a: any) => a.id === audId);
    assert.ok(preservedAud);
    assert.equal(preservedAud.cached_member_count, 1);

    const tplsAfter = await harness.apiJson('/api/v1/marketing/templates', { auth });
    assert.ok((tplsAfter.data.items || tplsAfter.data || []).some((t: any) => t.id === tplId));

    const unlockedRounds = await harness.apiJson('/api/v1/pipelines/rounds/list', { auth });
    assert.equal(Array.isArray(unlockedRounds.data.rounds), true);

    await setupCapiVault(auth);
    const testCapi = await harness.apiJson('/api/v1/integrations/capi/test-event', {
      method: 'POST',
      auth,
      body: { event_name: 'Lead', test_event_code: 'TEST_UPG_06' },
    });
    assert.equal(testCapi.data.events_received, 1);
    assert.ok(harness.capiCapture.length >= 1);
  });

  it('T3-07: Chatbot RAG (training-docs) -> Contact Extraction -> CRM Sale Round Push (push-lead)', async () => {
    const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });

    const saleUserRes = await harness.apiJson('/api/v1/users', {
      method: 'POST',
      auth,
      body: {
        full_name: 'Sale Chatbot',
        email: `sale.bot@${auth.tenantSlug}.vn`,
        password: 'SalePassword123!',
        role: 'sale',
        is_available: true,
      },
    });
    const saleUserId = String(saleUserRes.data.id);
    assert.ok(saleUserId);

    const docRes = await harness.apiJson('/api/v1/marketing/social-bot/training-docs', {
      method: 'POST',
      auth,
      body: {
        title: 'Diamond Package Warranty',
        doc_type: 'policy',
        content_text: 'Gói Diamond bảo hành chính hãng 24 tháng 1 đổi 1 tại tất cả chi nhánh.',
      },
    });
    assert.equal(docRes.data.status, 'indexed');

    await harness.apiJson('/api/v1/marketing/social-bot/bot-config', {
      method: 'PUT',
      auth,
      body: {
        bot_name: 'RAG Concierge',
        auto_extract_contact: true,
        routing_mode: 'audience',
        is_active: true,
      },
    });

    const convRes = await harness.apiRaw('/api/v1/marketing/social-bot/conversations', {
      method: 'POST',
      auth,
      body: {
        channel: 'web_chat',
        external_thread_id: 'wc_pair7',
        customer_name: 'Lê Chatbot',
        content: 'Cho mình hỏi Diamond Package Warranty? Số mình là 0912345678, email chat7@test.vn',
      },
    });
    assert.equal(convRes.status, 201);
    const convId = String(convRes.json?.data?.conversation_id);
    const leadId = String(convRes.json?.data?.lead_id);
    assert.ok(convId);
    assert.ok(leadId);
    assert.equal(convRes.json?.data?.extracted_entities?.phone, '0912345678');
    assert.equal(convRes.json?.data?.extracted_entities?.email, 'chat7@test.vn');
    assert.ok(String(convRes.json?.data?.bot_reply || '').includes('24 tháng'));

    const pushRes = await harness.apiJson(`/api/v1/marketing/social-bot/conversations/${convId}/push-lead`, {
      method: 'POST',
      auth,
      body: { mode: 'sale_round' },
    });
    assert.equal(pushRes.data.lead_id, leadId);
    assert.equal(pushRes.data.mode, 'sale_round');

    const leadsRes = await harness.apiJson('/api/v1/leads?search=chat7%40test.vn', { auth });
    const crmLead = (leadsRes.data.items || []).find((l: any) => l.id === leadId);
    assert.ok(crmLead);
    assert.equal(crmLead.status, 'assigned');
    assert.equal(crmLead.assigned_sale?.id, saleUserId);
    assert.ok(crmLead.pipeline_id);
    assert.ok(crmLead.stage?.id);

    const tlRes = await harness.apiJson(`/api/v1/leads/${leadId}/timeline`, { auth });
    const tlItems = tlRes.data?.items || tlRes.data || [];
    assert.equal(
      tlItems.some((e: any) => e.event_type === 'pushed_to_sale_round'),
      true
    );
  });

  it('T3-08: lead.stage_changed -> Marketing Flow + Meta CAPI + Outbound Webhook HMAC', async () => {
    const auth = await harness.registerTenant({
      packageCode: 'growth_combo',
      industry: 'real_estate',
      seedDemoLeads: false,
    });
    await setupCapiVault(auth);

    const pipesRes = await harness.apiJson('/api/v1/pipelines', { auth });
    const pipelines: any[] = pipesRes.data || [];
    const defaultPipeline = pipelines.find((p) => p.is_default) || pipelines[0];
    const stages: any[] = defaultPipeline?.stages || [];
    const scheduleStage =
      stages.find((s) => s.capi_event_mapping === 'Schedule') ||
      stages.find((s) => !s.is_won_stage && !s.is_lost_stage && s.id !== stages[0]?.id) ||
      stages[1];
    assert.ok(scheduleStage?.id);

    const whRes = await harness.apiJson('/api/v1/integrations/webhooks', {
      method: 'POST',
      auth,
      body: {
        name: 'Pair8 Stage Sink',
        webhook_type: 'outbound',
        url: harness.webhookSink.url,
        subscribed_events: ['lead.stage_changed'],
        is_active: true,
      },
    });
    const signingSecret = String(whRes.data.signing_secret || '');
    assert.ok(signingSecret);

    const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
      method: 'POST',
      auth,
      body: {
        name: 'Stage Changed Pair8 Flow',
        status: 'active',
        trigger_type: 'stage_changed',
        trigger_config: { stage_id: scheduleStage.id },
        steps: [
          {
            id: 'st1',
            type: 'add_remove_tag',
            label: 'Tag Scheduled',
            config: { tag: 'scheduled-visit', mode: 'add' },
            nextStepId: 'st2',
          },
          {
            id: 'st2',
            type: 'update_lead_score',
            label: 'Score +25',
            config: { delta: 25 },
          },
        ],
      },
    });
    const flowId = String(flowRes.data.id);

    const leadRes = await harness.apiJson('/api/v1/leads', {
      method: 'POST',
      auth,
      body: {
        name: 'Stage Pair8 Lead',
        phone: '0909800008',
        email: 'stage8@test.vn',
        fbclid: 'fb_pair8_999',
      },
    });
    const leadId = String(leadRes.data.id || leadRes.data.lead_id);

    const stageRes = await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
      method: 'PATCH',
      auth,
      body: { stage_id: scheduleStage.id, note: 'Booked consultation' },
    });
    assert.equal(stageRes.data.current_stage, scheduleStage.stage_key);
    assert.equal(stageRes.data.capi_dispatched?.event_name, 'Schedule');
    assert.equal(stageRes.data.capi_dispatched?.status, 200);

    const capiMatch = harness.capiCapture.find((c) => {
      const evs = Array.isArray((c.payload as any)?.data) ? (c.payload as any).data : [];
      return evs.some((ev: any) => ev.event_name === 'Schedule');
    });
    assert.ok(capiMatch);
    const capiEv = ((capiMatch!.payload as any).data as any[]).find((ev) => ev.event_name === 'Schedule');
    assert.ok(Array.isArray(capiEv.user_data?.ph) && capiEv.user_data.ph.length >= 1);
    assert.ok(Array.isArray(capiEv.user_data?.em) && capiEv.user_data.em.length >= 1);
    assert.ok(String(capiEv.user_data?.fbc || '').includes('fb_pair8_999'));

    const deliveries = await harness.webhookSink.waitForDeliveries(1, 3000);
    const stageDelivery = deliveries.find((d) => d.headers['x-autodata-event'] === 'lead.stage_changed');
    assert.ok(stageDelivery);
    assert.equal(stageDelivery!.json?.lead_id, leadId);
    assert.equal(stageDelivery!.headers['x-autodata-signature-256'], signHmacHex(stageDelivery!.rawBody, signingSecret));

    const flowDetail = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
    assert.equal(
      flowDetail.data.enrollments.some((e: any) => e.lead_id === leadId && e.status === 'completed'),
      true
    );

    const contactsRes = await harness.apiJson('/api/v1/audiences/contacts?search=stage8%40test.vn', { auth });
    const row = contactsRes.data.items[0];
    const tagNames = (row.tags || []).map((t: any) => t.name);
    assert.ok(tagNames.includes('scheduled-visit'));
    assert.ok(Number(row.lead_score) >= 25);
  });

  it('T3-09: Legacy Compat Bridge (.php / myerp/automation) write -> Canonical /api/v1/marketing/* read & trigger parity', async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

    const compatForm = await harness.apiRaw('/api/v1/myerp/automation/forms.php', {
      method: 'POST',
      auth,
      body: {
        name: 'Compat Parity Form',
        fields: [
          { id: 'fn', key: 'name', label: 'Name', type: 'text' },
          { id: 'fe', key: 'email', label: 'Email', type: 'email' },
        ],
      },
    });
    assert.equal(compatForm.status, 201);
    const formId = String(compatForm.json?.data?.id);
    const formToken = String(compatForm.json?.data?.public_token);

    const compatFlow = await harness.apiRaw('/api/v1/myerp/automation/flows.php', {
      method: 'POST',
      auth,
      body: {
        name: 'Compat Parity Flow',
        status: 'active',
        trigger_type: 'form_submitted',
        trigger_config: { form_id: formId },
        steps: [
          {
            id: 'cf1',
            type: 'add_remove_tag',
            label: 'Tag Compat',
            config: { tag: 'from-compat-php', mode: 'add' },
          },
        ],
      },
    });
    assert.equal(compatFlow.status, 201);
    const flowId = String(compatFlow.json?.data?.id);

    const compatCamp = await harness.apiRaw('/api/v1/myerp/automation/campaigns.php', {
      method: 'POST',
      auth,
      body: {
        name: 'Compat Parity Campaign',
        channel: 'email',
        subject_a: 'Compat Hello',
      },
    });
    assert.equal(compatCamp.status, 201);
    const campId = String(compatCamp.json?.data?.id);

    const segBranches = [
      { join: 'AND', rules: [{ field: 'tag', op: 'equals', val: 'from-compat-php' }] },
    ];
    const compatSeg = await harness.apiRaw('/api/v1/myerp/automation/segments.php', {
      method: 'POST',
      auth,
      body: {
        name: 'Compat Parity Segment',
        audience_type: 'dynamic_logic',
        filter_branches: segBranches,
      },
    });
    assert.equal(compatSeg.status, 201);
    const segId = String(compatSeg.json?.data?.id);

    // Canonical read parity
    const canonForms = await harness.apiJson('/api/v1/marketing/forms', { auth });
    assert.equal((canonForms.data.items || canonForms.data || []).some((f: any) => f.id === formId), true);

    const canonFlow = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
    assert.equal(canonFlow.data.flow.name, 'Compat Parity Flow');

    const canonCamp = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
    assert.equal(canonCamp.data.campaign.name, 'Compat Parity Campaign');

    const canonSeg = await harness.apiJson(`/api/v1/audiences/${segId}`, { auth });
    assert.equal(canonSeg.data.name, 'Compat Parity Segment');

    // Public trigger -> canonical flow execution -> compat preview & /backend/* read parity
    const pubSub = await harness.apiRaw(`/api/v1/public/marketing/forms/${formToken}/submit`, {
      method: 'POST',
      body: { name: 'Compat Parity Lead', email: 'compat.parity@test.vn' },
    });
    assert.equal(pubSub.status, 201);
    const leadId = String(pubSub.json?.data?.lead_id);

    const canonFlowAfter = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
    assert.equal(
      canonFlowAfter.data.enrollments.some((e: any) => e.lead_id === leadId && e.status === 'completed'),
      true
    );

    const evalRes = await harness.apiJson(`/api/v1/audiences/${segId}/evaluate`, {
      method: 'POST',
      auth,
      body: {},
    });
    assert.equal(evalRes.data.total_count, 1);

    const compatPreview = await harness.apiJson('/api/v1/myerp/automation/segments.php?action=preview', {
      method: 'POST',
      auth,
      body: { filter_branches: segBranches },
    });
    assert.equal(compatPreview.data.count, 1);
    assert.equal(compatPreview.data.items[0].id, leadId);

    const backendFlow = await harness.apiRaw(`/backend/automation/flows.php?id=${encodeURIComponent(flowId)}`, {
      auth,
    });
    assert.equal(backendFlow.status, 200);
    assert.equal(backendFlow.json?.data?.flow?.id, flowId);
  });

  it('T3-10: Campaign Suppression/Unsubscribe HMAC -> Excluded from BOTH Campaign Send AND Flow Email/ZNS', async () => {
    const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
    await configureResendEmail(auth, 'unsub-pair10@e2e.vn');
    await configureZnsVault(auth);
    harness.setSmtpCaptureEnabled(false);

    try {
      const leadKeep = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Keep Lead',
          email: 'keep10@test.vn',
          phone: '0909900010',
          email_consent: 'subscribed',
        },
      });
      const leadOptOut = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'OptOut Lead',
          email: 'optout10@test.vn',
          phone: '0909900011',
          email_consent: 'subscribed',
        },
      });
      const keepId = String(leadKeep.data.id);
      const optOutId = String(leadOptOut.data.id);

      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair10 Aud',
          audience_type: 'static_data',
          lead_ids: [keepId, optOutId],
        },
      });

      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair10 Tpl',
          subject: 'Hello',
          compiled_html: '<p>Hi {{lead.name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
        },
      });

      const camp1 = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair10 Camp 1',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Batch 1',
        },
      });
      const send1 = await harness.apiJson(`/api/v1/marketing/campaigns/${camp1.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(send1.data.newly_sent, 2);

      const optOutEmail = harness.emailCapture.find(
        (e) => e.driver === 'resend' && e.to === 'optout10@test.vn'
      );
      assert.ok(optOutEmail?.html);
      const unsubMatch = optOutEmail!.html!.match(
        /https?:\/\/[^"'\s>]+\/api\/v1\/public\/marketing\/unsubscribe\?[^"'\s>]+/
      );
      assert.ok(unsubMatch, 'Expected HMAC unsubscribe URL in email HTML');

      const unsubResp = await fetch(decodeHtmlHref(unsubMatch![0]));
      assert.equal(unsubResp.status, 200);
      const unsubJson = (await unsubResp.json()) as any;
      assert.equal(unsubJson.data?.unsubscribed, true);
      assert.equal(unsubJson.data?.channel, 'email');

      const znsSupp = await harness.apiRaw('/api/v1/marketing/campaigns/suppression/list', {
        method: 'POST',
        auth,
        body: {
          recipient: '0909900011',
          channel: 'zns',
          reason: 'opt_out_pair10',
        },
      });
      assert.equal(znsSupp.status, 201);

      harness.emailCapture.length = 0;
      harness.zaloCapture.length = 0;

      const camp2 = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair10 Camp 2 Multi',
          channel: 'multi',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Batch 2',
          zns_template_id: 'ZNS_PAIR10',
        },
      });
      const send2 = await harness.apiJson(`/api/v1/marketing/campaigns/${camp2.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(send2.data.newly_sent, 2);
      assert.equal(send2.data.suppressed_skipped, 2);
      assert.deepEqual(
        harness.emailCapture.map((e) => e.to),
        ['keep10@test.vn']
      );
      assert.equal(
        harness.zaloCapture.every((z) => String(z.body?.phone || '').endsWith('909900010')),
        true
      );
      assert.equal(harness.zaloCapture.length, 1);

      const flow = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Pair10 Multi Flow',
          status: 'active',
          trigger_type: 'manual_enroll',
          steps: [
            {
              id: 'fe1',
              type: 'send_email',
              label: 'Flow Email',
              config: { subject: 'Flow Mail {{lead.name}}', customHtml: '<p>Flow</p>' },
              nextStepId: 'fz1',
            },
            {
              id: 'fz1',
              type: 'send_zns',
              label: 'Flow ZNS',
              config: { template_id: 'ZNS_PAIR10', subject: 'Flow ZNS' },
            },
          ],
        },
      });

      harness.emailCapture.length = 0;
      harness.zaloCapture.length = 0;

      const enrollOptOut = await harness.apiRaw(`/api/v1/marketing/flows/${flow.data.id}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: optOutId, skip_wait_delay: true },
      });
      assert.equal(enrollOptOut.status, 201);
      assert.equal(enrollOptOut.json?.data?.status, 'completed');
      assert.equal(harness.emailCapture.length, 0);
      assert.equal(harness.zaloCapture.length, 0);
      assert.ok(String(enrollOptOut.json?.data?.trace?.[0]?.outcome || '').includes('Bỏ qua gửi Email'));
      assert.ok(String(enrollOptOut.json?.data?.trace?.[1]?.outcome || '').includes('Bỏ qua gửi Zalo ZNS'));

      const enrollKeep = await harness.apiRaw(`/api/v1/marketing/flows/${flow.data.id}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: keepId, skip_wait_delay: true },
      });
      assert.equal(enrollKeep.status, 201);
      assert.equal(
        harness.emailCapture.some((e) => e.to === 'keep10@test.vn'),
        true
      );
      assert.equal(
        harness.zaloCapture.some(
          (z) => z.channel === 'zns' && String(z.body?.phone || '').endsWith('909900010')
        ),
        true
      );
    } finally {
      harness.setSmtpCaptureEnabled(true);
    }
  });
});
