import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness } from './_harness.ts';

let harness: MarketingE2eHarness;

describe('Feature 6: Website Tracking, Surveys, Vouchers & Analytics (E2E)', () => {
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
  // Tier 1 — Happy Path (5 tests)
  // =========================================================================
  describe('Tier 1: Happy Path', () => {
    it('F6-T1-01: serves /sdk.js, tracks anonymous events, stitches form lead on identify, and scores pricing_intent', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const propRes = await harness.apiRaw('/api/v1/marketing/web-tracking/properties', {
        method: 'POST',
        auth,
        body: {
          name: 'Main Storefront',
          domain: 'shop.test.vn',
          pricing_url_pattern: '/pricing,/bang-gia',
          auto_alert_pricing: true,
        },
      });
      assert.equal(propRes.status, 201);
      const propId = propRes.json.data.id;
      const siteKey = propRes.json.data.site_key;
      assert.ok(String(siteKey).startsWith('dom_site_'));

      // Public /sdk.js
      const sdkRes = await harness.apiRaw('/api/v1/public/marketing/sdk.js', {
        method: 'GET',
        query: { site_key: siteKey },
      });
      assert.equal(sdkRes.status, 200);
      assert.ok(String(sdkRes.headers.get('content-type') || '').includes('javascript'));
      assert.ok(sdkRes.rawText.includes(siteKey));
      assert.ok(sdkRes.rawText.includes('/api/v1/public/marketing/track'));

      // Create lead via public form submission
      const formRes = await harness.apiJson('/api/v1/marketing/forms', {
        method: 'POST',
        auth,
        body: {
          name: 'Lead Capture Form',
          fields: [
            { id: 'f_name', key: 'name', label: 'Họ tên', type: 'text', required: true },
            { id: 'f_email', key: 'email', label: 'Email', type: 'email', required: true },
            { id: 'f_phone', key: 'phone', label: 'SĐT', type: 'phone', required: false },
          ],
        },
      });
      const formToken = formRes.data.public_token;

      const submitRes = await harness.apiRaw(`/api/v1/public/marketing/forms/${formToken}/submit`, {
        method: 'POST',
        body: {
          name: 'Stitch Lead',
          email: 'stitch@test.vn',
          phone: '0909333444',
        },
      });
      assert.equal(submitRes.status, 201);
      const leadId = submitRes.json.data.lead_id;
      assert.ok(leadId);

      // Anonymous pageview & click on /home (disjoint from /pricing)
      const anonUrl = 'https://shop.test.vn/home';
      const ev1 = await harness.apiRaw('/api/v1/public/marketing/track', {
        method: 'POST',
        body: {
          site_key: siteKey,
          visitor_token: 'vis_f6_01',
          event_type: 'pageview',
          page_url: anonUrl,
        },
      });
      assert.equal(ev1.status, 201);
      assert.equal(ev1.json.data.stitched, false);
      assert.equal(ev1.json.data.lead_id, null);
      assert.equal(ev1.json.data.pricing_intent_detected, false);
      const sessionId = ev1.json.data.session_id;
      assert.ok(sessionId);

      const ev2 = await harness.apiRaw('/api/v1/public/marketing/track', {
        method: 'POST',
        body: {
          site_key: siteKey,
          visitor_token: 'vis_f6_01',
          event_type: 'click',
          page_url: anonUrl,
          x_pct: 40,
          y_pct: 55,
          element_selector: 'BUTTON.cta-start',
        },
      });
      assert.equal(ev2.status, 201);

      const pageDetailsBefore = await harness.apiJson(
        `/api/v1/marketing/web-tracking/page-details?page_url=${encodeURIComponent(anonUrl)}`,
        { auth }
      );
      assert.equal(pageDetailsBefore.data.pageviews, 1);
      assert.equal(pageDetailsBefore.data.clicks, 1);
      assert.equal(pageDetailsBefore.data.identified_leads, 0);

      // Identify on /pricing -> retroactive stitch + pricing_intent_detected + lead_score >= 15
      const ev3 = await harness.apiRaw('/api/v1/public/marketing/track', {
        method: 'POST',
        body: {
          site_key: siteKey,
          visitor_token: 'vis_f6_01',
          event_type: 'identify',
          page_url: 'https://shop.test.vn/pricing',
          email: 'stitch@test.vn',
        },
      });
      assert.equal(ev3.status, 201);
      assert.equal(ev3.json.data.stitched, true);
      assert.equal(ev3.json.data.lead_id, leadId);
      assert.equal(ev3.json.data.pricing_intent_detected, true);

      // Prior anonymous /home events must now have lead_id stitched in DB
      const pageDetailsAfter = await harness.apiJson(
        `/api/v1/marketing/web-tracking/page-details?page_url=${encodeURIComponent(anonUrl)}`,
        { auth }
      );
      assert.equal(pageDetailsAfter.data.pageviews, 1);
      assert.equal(pageDetailsAfter.data.clicks, 1);
      assert.equal(pageDetailsAfter.data.identified_leads, 1);

      const sessionsRes = await harness.apiJson(
        `/api/v1/marketing/web-tracking/sessions?property_id=${encodeURIComponent(propId)}&pricing_intent=true`,
        { auth }
      );
      assert.equal(sessionsRes.data.items.length, 1);
      assert.equal(sessionsRes.data.items[0].id, sessionId);
      assert.equal(sessionsRes.data.items[0].lead_id, leadId);
      assert.equal(sessionsRes.data.items[0].pricing_intent_detected, true);
      assert.ok(Number(sessionsRes.data.items[0].lead_score) >= 15);

      const visitorDetail = await harness.apiJson(`/api/v1/marketing/web-tracking/visitors/${sessionId}`, { auth });
      assert.equal(visitorDetail.data.events.length, 3);

      const heatmapRes = await harness.apiJson(
        `/api/v1/marketing/web-tracking/heatmap?property_id=${encodeURIComponent(propId)}`,
        { auth }
      );
      assert.equal(heatmapRes.data.click_points.length, 1);

      const overviewRes = await harness.apiJson('/api/v1/marketing/web-tracking', { auth });
      assert.equal(overviewRes.data.summary.total_sessions, 1);
      assert.equal(overviewRes.data.summary.identified_leads, 1);
      assert.equal(overviewRes.data.summary.pricing_intent_alerts, 1);
    });

    it('F6-T1-02: submits public quiz survey, persists redirect_rules assignTag to lead_tags, updates quiz_score & passes segment evaluation', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const surveyCreate = await harness.apiRaw('/api/v1/marketing/surveys', {
        method: 'POST',
        auth,
        body: {
          title: 'VIP Readiness Quiz',
          survey_type: 'quiz',
          blocks: [
            { id: 'q1', type: 'quiz_scored', label: 'Which tier?', correctValue: 'pro', points: 25 },
            { id: 'nps1', type: 'nps', label: 'NPS?' },
          ],
          settings: {
            base_lead_score: 5,
            auto_tag: 'Quiz Done',
          },
          redirect_rules: [
            {
              minScore: 40,
              maxScore: 100,
              assignTag: 'VIP Quiz Winner',
              redirectUrl: 'https://domation.net/vip',
              thankYouTitle: 'VIP Ready',
            },
          ],
        },
      });
      assert.equal(surveyCreate.status, 201);
      const surveyId = surveyCreate.json.data.id;
      const slug = surveyCreate.json.data.slug;

      const pubSurvey = await harness.apiJson(`/api/v1/public/marketing/surveys/${slug}`);
      assert.equal(pubSurvey.data.title, 'VIP Readiness Quiz');
      assert.equal(pubSurvey.data.blocks.length, 2);

      const subRes = await harness.apiRaw(`/api/v1/public/marketing/surveys/${slug}`, {
        method: 'POST',
        body: {
          tenant_slug: auth.tenantSlug,
          name: 'Quiz User',
          email: 'quiz@test.vn',
          answers: { q1: 'pro', nps1: 10 },
        },
      });
      assert.equal(subRes.status, 201);
      // base(5) + quiz_scored(25) + nps>=9(15) = 45
      assert.equal(subRes.json.data.quiz_score, 45);
      assert.equal(subRes.json.data.nps_score, 10);
      assert.equal(subRes.json.data.redirect_url, 'https://domation.net/vip');
      assert.equal(subRes.json.data.thank_you?.title, 'VIP Ready');
      assert.ok(subRes.json.data.tags_applied.includes('VIP Quiz Winner'));
      assert.ok(subRes.json.data.tags_applied.includes('NPS Promoter'));
      assert.ok(subRes.json.data.tags_applied.includes('Quiz Done'));

      // True DB persistence check via /audiences/contacts
      const contactsRes = await harness.apiJson('/api/v1/audiences/contacts?search=quiz%40test.vn', { auth });
      assert.equal(contactsRes.data.items.length, 1);
      const lead = contactsRes.data.items[0];
      assert.ok(Number(lead.lead_score) >= 45);
      const tagNames = lead.tags.map((t: any) => t.name);
      assert.ok(tagNames.includes('VIP Quiz Winner'));
      assert.ok(tagNames.includes('NPS Promoter'));
      assert.ok(tagNames.includes('Quiz Done'));

      // Dynamic segment matching both tag + quiz_score
      const segRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Quiz VIP Segment',
          audience_type: 'dynamic_logic',
          filter_branches: [
            {
              join: 'AND',
              rules: [
                { field: 'tag', op: 'equals', value: 'VIP Quiz Winner' },
                { field: 'quiz_score', op: 'gte', value: 40 },
              ],
            },
          ],
        },
      });
      assert.equal(segRes.data.cached_member_count, 1);
      assert.ok(segRes.data.evaluation.entered_lead_ids.includes(subRes.json.data.lead_id));

      const evalRes = await harness.apiJson(`/api/v1/audiences/${segRes.data.id}/evaluate`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(evalRes.data.total_count, 1);
      const segMembers = await harness.apiJson(`/api/v1/audiences/${segRes.data.id}/members`, { auth });
      assert.ok(segMembers.data.items.some((m: any) => m.id === subRes.json.data.lead_id));

      const analyticsRes = await harness.apiJson(`/api/v1/marketing/surveys/${surveyId}/analytics`, { auth });
      assert.equal(analyticsRes.data.summary.total_responses, 1);
      assert.equal(analyticsRes.data.summary.avg_quiz_score, 45);
      assert.equal(analyticsRes.data.summary.nps_index, 100);
    });

    it('F6-T1-03: creates voucher pool, exposes public voucher page, claims code, and redeems at POS', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const poolCreate = await harness.apiRaw('/api/v1/marketing/vouchers', {
        method: 'POST',
        auth,
        body: {
          name: 'VIP 20% Off',
          code_prefix: 'VIP',
          discount_type: 'percentage',
          discount_value: 20,
          min_order_vnd: 500000,
          auto_generate_count: 3,
        },
      });
      assert.equal(poolCreate.status, 201);
      const poolId = poolCreate.json.data.id;
      const slug = poolCreate.json.data.slug;

      const pubPool = await harness.apiJson(`/api/v1/public/marketing/vouchers/${slug}`);
      assert.equal(pubPool.data.total_codes, 3);
      assert.equal(pubPool.data.name, 'VIP 20% Off');

      const claimRes = await harness.apiRaw(`/api/v1/public/marketing/vouchers/${slug}/claim`, {
        method: 'POST',
        body: {
          name: 'Voucher Buyer',
          phone: '0908111222',
          email: 'buyer@test.vn',
        },
      });
      assert.equal(claimRes.status, 201);
      const claimedCode = claimRes.json.data.code;
      assert.ok(String(claimedCode).startsWith('VIP-'));
      assert.ok(claimRes.json.data.lead_id);

      const redeemRes = await harness.apiJson('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth,
        body: {
          code: claimedCode,
          order_vnd: 750000,
          note: 'POS E2E Redeem',
        },
      });
      assert.equal(redeemRes.data.code, claimedCode);
      assert.equal(redeemRes.data.discount_value, 20);
      assert.equal(redeemRes.data.order_vnd, 750000);

      const codesRes = await harness.apiJson(`/api/v1/marketing/vouchers/${poolId}/codes`, { auth });
      assert.equal(codesRes.data.pool.claimed_codes, 1);
      assert.equal(codesRes.data.pool.redeemed_codes, 1);
      const redeemedRow = codesRes.data.codes.find((c: any) => c.code === claimedCode);
      assert.equal(redeemedRow?.status, 'redeemed');
    });

    it('F6-T1-04: creates shortlink, issues 302 redirect with UTM params, and records distinct visitor click analytics', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const shortCode = `f6p${Date.now().toString(36)}`;

      const linkRes = await harness.apiRaw('/api/v1/marketing/vouchers/shortlinks', {
        method: 'POST',
        auth,
        body: {
          title: 'Campaign Promo Link',
          target_url: 'https://domation.net/promo',
          short_code: shortCode,
          utm_source: 'zalo',
          utm_medium: 'oa',
          utm_campaign: 'tet2026',
        },
      });
      assert.equal(linkRes.status, 201);
      const linkId = linkRes.json.data.id;

      // Two distinct visitors hit /r/:code with redirect: 'manual'
      const r1 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '203.0.113.10', 'User-Agent': 'BrowserA/1.0' },
      });
      assert.equal(r1.status, 302);
      const loc1 = String(r1.headers.get('location') || '');
      assert.ok(loc1.startsWith('https://domation.net/promo'));
      assert.ok(loc1.includes('utm_source=zalo'));
      assert.ok(loc1.includes('utm_medium=oa'));
      assert.ok(loc1.includes('utm_campaign=tet2026'));

      const r2 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '203.0.113.20', 'User-Agent': 'BrowserB/2.0' },
      });
      assert.equal(r2.status, 302);

      const listRes = await harness.apiJson('/api/v1/marketing/vouchers', { auth });
      const shortRow = listRes.data.shortlinks.find((s: any) => s.id === linkId);
      assert.equal(shortRow?.click_count, 2);
      assert.equal(shortRow?.unique_click_count, 2);

      const analyticsRes = await harness.apiJson(
        `/api/v1/marketing/vouchers/clicks-analytics?short_link_id=${encodeURIComponent(linkId)}`,
        { auth }
      );
      assert.equal(analyticsRes.data.total_clicks, 2);
      assert.equal(analyticsRes.data.unique_visitors, 2);
      assert.ok(analyticsRes.data.by_utm_source.some((u: any) => u.source === 'zalo' && u.count === 2));
    });

    it('F6-T1-05: dispatches real OTP email, verifies OTP for gated form submission, and records campaign open/click measurement', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      // OTP-gated form
      const formRes = await harness.apiJson('/api/v1/marketing/forms', {
        method: 'POST',
        auth,
        body: {
          name: 'OTP Verified Form',
          require_otp: true,
          otp_channel: 'email',
          fields: [
            { id: 'f_name', key: 'name', label: 'Họ tên', type: 'text', required: true },
            { id: 'f_email', key: 'email', label: 'Email', type: 'email', required: true },
          ],
        },
      });
      const formToken = formRes.data.public_token;

      harness.emailCapture.length = 0;
      const otpSend = await harness.apiRaw('/api/v1/public/marketing/otp/send', {
        method: 'POST',
        body: {
          form_token: formToken,
          recipient: 'otp.ok@test.vn',
          channel: 'email',
        },
      });
      assert.equal(otpSend.status, 201);
      assert.equal(otpSend.json.data.dispatched, true);
      const otpId = otpSend.json.data.otp_id;
      const otpCode = String(otpSend.json.data.sandbox_otp_code || '');
      assert.ok(otpCode.length >= 4);

      const otpEmails = harness.emailCapture.filter((e) => e.to === 'otp.ok@test.vn');
      assert.equal(otpEmails.length, 1);
      assert.ok(otpEmails[0].text.includes(otpCode));

      const otpVerify = await harness.apiJson('/api/v1/public/marketing/otp/verify', {
        method: 'POST',
        body: { otp_id: otpId, code: otpCode },
      });
      assert.equal(otpVerify.data.verified, true);

      const formSub = await harness.apiRaw(`/api/v1/public/marketing/forms/${formToken}/submit`, {
        method: 'POST',
        body: {
          name: 'OTP Lead',
          email: 'otp.ok@test.vn',
          otp_id: otpId,
        },
      });
      assert.equal(formSub.status, 201);

      const otpAudit = await harness.apiJson('/api/v1/marketing/forms/otp/audit', { auth });
      assert.ok(otpAudit.data.summary.total_sent >= 1);
      assert.ok(otpAudit.data.summary.verified_count >= 1);

      // Campaign open + click tracking measurement
      const trackLead = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Track Lead', email: 'track.ok@test.vn', email_consent: 'subscribed' },
      });
      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Track Aud', audience_type: 'static_data', lead_ids: [trackLead.data.id] },
      });
      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Measurement Tpl',
          subject: 'Open & Click Test',
          compiled_html: '<p>Hello {{lead.name}}</p><a href="https://domation.net/cta">CTA</a>',
        },
      });
      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Measurement Campaign',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Measure Me',
        },
      });
      const sendOut = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      const claimId = sendOut.data.claim_ids[0];

      const open1 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/track/open/${claimId}`);
      assert.equal(open1.status, 200);
      assert.ok(String(open1.headers.get('content-type') || '').includes('image/gif'));

      const open2 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/track/open/${claimId}`);
      assert.equal(open2.status, 200);

      const clickResp = await fetch(
        `${harness.baseUrl}/api/v1/public/marketing/track/click/${claimId}?url=${encodeURIComponent('https://domation.net/cta')}`,
        { redirect: 'manual' }
      );
      assert.equal(clickResp.status, 302);
      assert.equal(clickResp.headers.get('location'), 'https://domation.net/cta');

      const detail = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/detail`, { auth });
      assert.equal(detail.data.funnel.sent, 1);
      assert.equal(detail.data.funnel.opened, 1);
      assert.equal(detail.data.funnel.clicked, 1);
      assert.equal(detail.data.click_map[0].url, 'https://domation.net/cta');
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (5 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F6-T2-01: deduplicates repeated shortlink clicks from same visitor/IP so unique_click_count is not inflated', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const shortCode = `dedup${Date.now().toString(36)}`;

      const linkRes = await harness.apiJson('/api/v1/marketing/vouchers/shortlinks', {
        method: 'POST',
        auth,
        body: {
          title: 'Dedup Shortlink',
          target_url: 'https://domation.net/dedup',
          short_code: shortCode,
        },
      });
      const linkId = linkRes.data.id;

      // 4 clicks from identical IP + User-Agent
      for (let i = 0; i < 4; i += 1) {
        const resp = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}`, {
          redirect: 'manual',
          headers: { 'X-Forwarded-For': '198.51.100.55', 'User-Agent': 'SameUA/1.0' },
        });
        assert.equal(resp.status, 302);
      }

      // 1 click from a second distinct visitor
      const resp2 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '198.51.100.99', 'User-Agent': 'DiffUA/2.0' },
      });
      assert.equal(resp2.status, 302);

      const listRes = await harness.apiJson('/api/v1/marketing/vouchers', { auth });
      const shortRow = listRes.data.shortlinks.find((s: any) => s.id === linkId);
      assert.equal(shortRow?.click_count, 5);
      assert.equal(shortRow?.unique_click_count, 2);

      const analyticsRes = await harness.apiJson(
        `/api/v1/marketing/vouchers/clicks-analytics?short_link_id=${encodeURIComponent(linkId)}`,
        { auth }
      );
      assert.equal(analyticsRes.data.total_clicks, 5);
      assert.equal(analyticsRes.data.unique_visitors, 2);

      // Cross-IP/UA deduplication when carrying the same valid ?lid=<leadId>
      const lidLead = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Lid Dedup Lead', email: 'liddedup@test.vn' },
      });
      const lid = lidLead.data.id;

      const lidClick1 = await fetch(
        `${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}?lid=${encodeURIComponent(lid)}`,
        {
          redirect: 'manual',
          headers: { 'X-Forwarded-For': '198.51.100.201', 'User-Agent': 'LidMobile/1.0' },
        }
      );
      assert.equal(lidClick1.status, 302);

      const lidClick2 = await fetch(
        `${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}?lid=${encodeURIComponent(lid)}`,
        {
          redirect: 'manual',
          headers: { 'X-Forwarded-For': '198.51.100.202', 'User-Agent': 'LidDesktop/2.0' },
        }
      );
      assert.equal(lidClick2.status, 302);

      const listAfterLid = await harness.apiJson('/api/v1/marketing/vouchers', { auth });
      const shortRowAfterLid = listAfterLid.data.shortlinks.find((s: any) => s.id === linkId);
      assert.equal(shortRowAfterLid?.click_count, 7);
      assert.equal(shortRowAfterLid?.unique_click_count, 3);

      const analyticsAfterLid = await harness.apiJson(
        `/api/v1/marketing/vouchers/clicks-analytics?short_link_id=${encodeURIComponent(linkId)}`,
        { auth }
      );
      assert.equal(analyticsAfterLid.data.total_clicks, 7);
      assert.equal(analyticsAfterLid.data.unique_visitors, 3);
    });

    it('F6-T2-02: rejects tampered/missing HMAC /unsubscribe with 403 INVALID_UNSUBSCRIBE_SIGNATURE while valid HMAC opts out', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const lead = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'HMAC Target', email: 'hmac.unsub@test.vn', email_consent: 'subscribed' },
      });
      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'HMAC Aud', audience_type: 'static_data', lead_ids: [lead.data.id] },
      });
      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: { name: 'HMAC Tpl', subject: 'HMAC', compiled_html: '<p>Hi</p><a href="{{unsubscribe_url}}">Unsub</a>' },
      });
      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'HMAC Campaign',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'HMAC Sub',
        },
      });
      await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });

      const detail = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/detail`, { auth });
      const validUnsubUrl = String(detail.data.claims[0]?.metadata?.unsubscribe_url || '');
      assert.ok(validUnsubUrl.includes('/api/v1/public/marketing/unsubscribe?'));

      const parsed = new URL(validUnsubUrl);
      const basePath = parsed.pathname;
      const baseParams = Object.fromEntries(parsed.searchParams.entries());

      // 1. Tampered sig
      const badSig = await harness.apiRaw(basePath, {
        method: 'GET',
        query: { ...baseParams, sig: '0'.repeat(64) },
      });
      assert.equal(badSig.status, 403);
      assert.equal(badSig.json?.error?.code, 'INVALID_UNSUBSCRIBE_SIGNATURE');

      // 2. Tampered channel
      const badChannel = await harness.apiRaw(basePath, {
        method: 'GET',
        query: { ...baseParams, channel: 'zns' },
      });
      assert.equal(badChannel.status, 403);
      assert.equal(badChannel.json?.error?.code, 'INVALID_UNSUBSCRIBE_SIGNATURE');

      // 3. Missing sig
      const { sig: _removed, ...noSigParams } = baseParams;
      const missingSig = await harness.apiRaw(basePath, {
        method: 'GET',
        query: noSigParams,
      });
      assert.equal(missingSig.status, 403);
      assert.equal(missingSig.json?.error?.code, 'INVALID_UNSUBSCRIBE_SIGNATURE');

      // 4. Valid unmodified URL succeeds and writes to suppression list
      const okResp = await fetch(validUnsubUrl);
      assert.equal(okResp.status, 200);
      const okJson: any = await okResp.json();
      assert.equal(okJson.data?.unsubscribed, true);
      assert.equal(okJson.data?.channel, 'email');

      const supList = await harness.apiJson('/api/v1/marketing/campaigns/suppression/list', { auth });
      assert.ok(supList.data.items.some((s: any) => s.recipient === 'hmac.unsub@test.vn'));
    });

    it('F6-T2-03: rejects below-min-order, already-redeemed, expired & unknown voucher codes (400 / 410)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const poolA = await harness.apiJson('/api/v1/marketing/vouchers', {
        method: 'POST',
        auth,
        body: {
          name: 'Min Order Pool',
          code_prefix: 'MIN',
          discount_type: 'fixed_vnd',
          discount_value: 50000,
          min_order_vnd: 500000,
          auto_generate_count: 2,
        },
      });

      const claimA = await harness.apiJson(`/api/v1/public/marketing/vouchers/${poolA.data.slug}/claim`, {
        method: 'POST',
        body: { email: 'vtest@test.vn' },
      });
      const codeA = claimA.data.code;

      const belowMin = await harness.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth,
        body: { code: codeA, order_vnd: 200000 },
      });
      assert.equal(belowMin.status, 400);
      assert.equal(belowMin.json?.error?.code, 'MIN_ORDER_NOT_MET');

      const validRedeem = await harness.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth,
        body: { code: codeA, order_vnd: 500000 },
      });
      assert.equal(validRedeem.status, 200);

      const dupRedeem = await harness.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth,
        body: { code: codeA, order_vnd: 500000 },
      });
      assert.equal(dupRedeem.status, 400);
      assert.equal(dupRedeem.json?.error?.code, 'CODE_ALREADY_REDEEMED');

      // Expired pool
      const poolB = await harness.apiJson('/api/v1/marketing/vouchers', {
        method: 'POST',
        auth,
        body: {
          name: 'Expired Pool',
          code_prefix: 'EXP',
          discount_value: 10,
          auto_generate_count: 1,
          expires_at: new Date(Date.now() - 3600_000).toISOString(),
        },
      });
      const poolBCodes = await harness.apiJson(`/api/v1/marketing/vouchers/${poolB.data.id}/codes`, { auth });
      const expiredCode = poolBCodes.data.codes[0].code;

      const redeemExpired = await harness.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth,
        body: { code: expiredCode, order_vnd: 100000 },
      });
      assert.equal(redeemExpired.status, 400);
      assert.equal(redeemExpired.json?.error?.code, 'CODE_EXPIRED');

      const claimExpired = await harness.apiRaw(`/api/v1/public/marketing/vouchers/${poolB.data.slug}/claim`, {
        method: 'POST',
        body: { email: 'expired@test.vn' },
      });
      assert.equal(claimExpired.status, 410);
      assert.equal(claimExpired.json?.error?.code, 'VOUCHER_CAMPAIGN_EXPIRED');

      // Unknown code
      const unknownRedeem = await harness.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth,
        body: { code: 'NOPE-9999', order_vnd: 100000 },
      });
      assert.equal(unknownRedeem.status, 400);
      assert.equal(unknownRedeem.json?.error?.code, 'CODE_NOT_FOUND');
    });

    it('F6-T2-04: enforces OTP mismatch, max-attempts lockout (5 failures -> OTP_MAX_ATTEMPTS), and expiration (422 OTP_EXPIRED)', async (t) => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const send1 = await harness.apiJson('/api/v1/public/marketing/otp/send', {
        method: 'POST',
        body: {
          tenant_slug: auth.tenantSlug,
          recipient: 'lockout@test.vn',
          channel: 'email',
        },
      });
      const otpId1 = send1.data.otp_id;
      const validCode1 = String(send1.data.sandbox_otp_code);
      const wrongCode = validCode1 === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i += 1) {
        const badVerify = await harness.apiRaw('/api/v1/public/marketing/otp/verify', {
          method: 'POST',
          body: { otp_id: otpId1, code: wrongCode },
        });
        assert.equal(badVerify.status, 422);
        assert.equal(badVerify.json?.error?.code, 'OTP_MISMATCH');
      }

      // 6th attempt even with valid code is locked out
      const lockedVerify = await harness.apiRaw('/api/v1/public/marketing/otp/verify', {
        method: 'POST',
        body: { otp_id: otpId1, code: validCode1 },
      });
      assert.equal(lockedVerify.status, 422);
      assert.equal(lockedVerify.json?.error?.code, 'OTP_MAX_ATTEMPTS');

      // Expiry check via Date mock timers
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      try {
        const send2 = await harness.apiJson('/api/v1/public/marketing/otp/send', {
          method: 'POST',
          body: {
            tenant_slug: auth.tenantSlug,
            recipient: 'expired.otp@test.vn',
            channel: 'email',
          },
        });
        t.mock.timers.tick(6 * 60_000);

        const expiredVerify = await harness.apiRaw('/api/v1/public/marketing/otp/verify', {
          method: 'POST',
          body: { otp_id: send2.data.otp_id, code: String(send2.data.sandbox_otp_code) },
        });
        assert.equal(expiredVerify.status, 422);
        assert.equal(expiredVerify.json?.error?.code, 'OTP_EXPIRED');
      } finally {
        t.mock.timers.reset();
      }
    });

    it('F6-T2-05: returns 404 for unknown form_token, survey_slug, site_key, short_code & voucher_slug', async () => {
      const checks: Array<{ method: string; path: string; body?: unknown; expectedCode: string }> = [
        {
          method: 'GET',
          path: '/api/v1/public/marketing/forms/frm_does_not_exist',
          expectedCode: 'PUBLIC_FORM_NOT_FOUND',
        },
        {
          method: 'POST',
          path: '/api/v1/public/marketing/forms/frm_does_not_exist/submit',
          body: { email: 'x@y.vn' },
          expectedCode: 'PUBLIC_FORM_NOT_FOUND',
        },
        {
          method: 'GET',
          path: '/api/v1/public/marketing/surveys/no-such-survey-slug',
          expectedCode: 'PUBLIC_SURVEY_NOT_FOUND',
        },
        {
          method: 'POST',
          path: '/api/v1/public/marketing/surveys/no-such-survey-slug',
          body: { answers: {} },
          expectedCode: 'PUBLIC_SURVEY_NOT_FOUND',
        },
        {
          method: 'POST',
          path: '/api/v1/public/marketing/track',
          body: { site_key: 'dom_site_missing', event_type: 'pageview' },
          expectedCode: 'WEB_PROPERTY_NOT_FOUND',
        },
        {
          method: 'GET',
          path: '/api/v1/public/marketing/r/missing_short_code',
          expectedCode: 'SHORTLINK_NOT_FOUND',
        },
        {
          method: 'GET',
          path: '/api/v1/public/marketing/vouchers/missing-voucher-slug',
          expectedCode: 'VOUCHER_CAMPAIGN_NOT_FOUND',
        },
      ];

      for (const c of checks) {
        const res = await harness.apiRaw(c.path, { method: c.method, body: c.body });
        assert.equal(res.status, 404, `Expected 404 for ${c.method} ${c.path}`);
        assert.equal(res.json?.error?.code, c.expectedCode);
      }
    });
  });
});
