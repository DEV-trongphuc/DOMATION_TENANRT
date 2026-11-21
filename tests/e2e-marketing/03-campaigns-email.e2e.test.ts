import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness, type TenantAuthContext } from './_harness.ts';

let harness: MarketingE2eHarness;

async function configureResendEmail(auth: TenantAuthContext, fromEmail = 'mkt@e2e.vn') {
  await harness.apiJson('/api/v1/auth/tenant-settings', {
    method: 'PATCH',
    auth,
    body: {
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_e2e_test_key_001',
        resend_from_email: fromEmail,
      },
    },
  });
}

describe('Feature 3: Campaigns, Email Designer & Delivery (E2E)', () => {
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
    it('F3-T1-01: creates template group, compiles/validates Email blocks, creates template & serves countdown.svg', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const groupRes = await harness.apiJson('/api/v1/marketing/templates/groups', {
        method: 'POST',
        auth,
        body: {
          name: 'Flash Sale Campaigns',
          description: 'Templates for seasonal promos',
          color_hex: '#1E40FF',
        },
      });
      const groupId = groupRes.data.id;
      assert.ok(groupId);
      assert.equal(groupRes.data.name, 'Flash Sale Campaigns');

      const blocks = [
        {
          id: 'b_hero',
          type: 'hero_banner',
          title: 'Ưu đãi đặc biệt cho {{lead.name}}',
          content: 'Giảm giá lên tới 30% hôm nay',
          buttonLabel: 'Xem ngay',
          url: 'https://example.com/hero-offer',
        },
        {
          id: 'b_text',
          type: 'text',
          title: 'Mã ưu đãi của bạn',
          content: 'Xin chào {{lead.name}}, mã voucher của bạn là {{lead.voucher_code}}.',
        },
        {
          id: 'b_btn',
          type: 'button',
          buttonLabel: 'Nhận ưu đãi',
          url: 'https://example.com/offer',
        },
        {
          id: 'b_bad_btn',
          type: 'button',
          buttonLabel: 'Placeholder',
          url: '#',
        },
        {
          id: 'b_voucher',
          type: 'voucher_box',
          title: 'Voucher VIP',
          content: 'DOM-VIP20',
        },
        {
          id: 'b_timer',
          type: 'countdown_timer',
          title: 'Kết thúc sau',
        },
      ];

      const compileRes = await harness.apiJson('/api/v1/marketing/templates/compile', {
        method: 'POST',
        auth,
        body: {
          subject: 'Ưu đãi dành riêng cho {{lead.name}}',
          name: 'Flash Sale Q4',
          blocks,
        },
      });
      assert.ok(String(compileRes.data.compiled_html).includes('{{lead.name}}'));
      assert.ok(String(compileRes.data.compiled_html).includes('{{lead.voucher_code}}'));
      assert.ok(String(compileRes.data.compiled_html).includes('https://example.com/offer'));
      assert.ok(String(compileRes.data.compiled_html).includes('{{unsubscribe_url}}'));
      assert.ok(compileRes.data.spam_analysis?.deliverabilityGrade);

      const validateRes = await harness.apiJson('/api/v1/marketing/templates/validate', {
        method: 'POST',
        auth,
        body: {
          subject: 'Ưu đãi dành riêng cho {{lead.name}}',
          blocks,
        },
      });
      assert.equal(validateRes.data.has_unsubscribe_tag, true);
      assert.equal(typeof validateRes.data.deliverability_score, 'number');
      const validLink = validateRes.data.links.find((l: any) => l.blockId === 'b_btn');
      const badLink = validateRes.data.links.find((l: any) => l.blockId === 'b_bad_btn');
      assert.equal(validLink?.valid, true);
      assert.equal(badLink?.valid, false);

      const createTplRes = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Flash Sale Master Template',
          subject: 'Flash Sale cho {{lead.name}}',
          preheader: 'Đừng bỏ lỡ ưu đãi hôm nay',
          category: 'promo',
          group_id: groupId,
          blocks: blocks.filter((b) => b.id !== 'b_bad_btn'),
        },
      });
      assert.equal(createTplRes.data.group_id, groupId);
      assert.ok(createTplRes.data.merge_tags.includes('{{lead.name}}'));

      const listRes = await harness.apiJson('/api/v1/marketing/templates', { auth });
      assert.ok(listRes.data.items.some((t: any) => t.id === createTplRes.data.id));
      assert.ok(listRes.data.groups.some((g: any) => g.id === groupId));
      assert.ok(Array.isArray(listRes.data.merge_tags) && listRes.data.merge_tags.length > 0);

      const futureTarget = new Date(Date.now() + 2 * 86400_000).toISOString();
      const svgResp = await fetch(
        `${harness.baseUrl}/api/v1/marketing/templates/countdown.svg?target=${encodeURIComponent(futureTarget)}&accent=%231E40FF&label=FlashSale`,
        {
          headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'X-Tenant-Slug': auth.tenantSlug,
          },
        }
      );
      assert.equal(svgResp.status, 200);
      assert.ok(String(svgResp.headers.get('content-type') || '').includes('image/svg+xml'));
      const svgBody = await svgResp.text();
      assert.ok(svgBody.includes('<svg'));
      assert.ok(svgBody.includes('FlashSale'));
      assert.ok(svgBody.includes('#1E40FF'));
      assert.ok(svgBody.includes('NGÀY'));
    });

    it('F3-T1-02: creates A/B split & scheduled campaigns, updates ratio, and executes due scheduled campaign via master cron', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'AB Split Template',
          subject: 'Base Subject',
          compiled_html: '<html><body><p>Hello {{lead.name}}</p><a href="https://example.com/ab">Go</a></body></html>',
        },
      });

      const futureAt = new Date(Date.now() + 3600_000).toISOString();
      const scheduledRes = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Scheduled Future Campaign',
          channel: 'email',
          template_id: tplRes.data.id,
          subject_a: 'Offer A',
          subject_b: 'Offer B',
          ab_split_ratio: 50,
          scheduled_at: futureAt,
        },
      });
      assert.equal(scheduledRes.data.status, 'scheduled');
      assert.equal(scheduledRes.data.ab_split_ratio, 50);
      assert.equal(scheduledRes.data.subject_b, 'Offer B');
      assert.ok(scheduledRes.data.scheduled_at);

      const updatedRes = await harness.apiJson(`/api/v1/marketing/campaigns/${scheduledRes.data.id}`, {
        method: 'PUT',
        auth,
        body: { ab_split_ratio: 60 },
      });
      assert.equal(updatedRes.data.ab_split_ratio, 60);

      // Create 12 subscribed leads so ab_split_ratio=10 assigns indices 0..9 -> A and 10..11 -> B
      const leadIds: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const c = await harness.apiJson('/api/v1/audiences/contacts', {
          method: 'POST',
          auth,
          body: {
            name: `AB Lead ${i}`,
            email: `ab-lead-${i}@test.vn`,
            email_consent: 'subscribed',
          },
        });
        leadIds.push(c.data.id);
      }

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'AB 12 Leads',
          audience_type: 'static_data',
          lead_ids: leadIds,
        },
      });

      const dueAt = new Date(Date.now() - 60_000).toISOString();
      const dueCampRes = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Due Scheduled AB Campaign',
          channel: 'email',
          audience_id: audRes.data.id,
          template_id: tplRes.data.id,
          subject_a: 'Variant A Subject {{lead.name}}',
          subject_b: 'Variant B Subject {{lead.name}}',
          ab_split_ratio: 10,
          scheduled_at: dueAt,
        },
      });
      assert.equal(dueCampRes.data.status, 'scheduled');

      harness.emailCapture.length = 0;
      const cronRes = await harness.triggerMasterCron(['marketing_campaigns'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      const abSentEmails = harness.emailCapture.filter((e) => e.to.endsWith('@test.vn'));
      assert.equal(abSentEmails.length, 12);

      const detailRes = await harness.apiJson(`/api/v1/marketing/campaigns/${dueCampRes.data.id}/detail`, { auth });
      assert.equal(detailRes.data.campaign.status, 'completed');
      assert.equal(detailRes.data.funnel.sent, 12);
      assert.ok(detailRes.data.ab_comparison.variant_a.sent > 0);
      assert.ok(detailRes.data.ab_comparison.variant_b.sent > 0);
      assert.equal(
        detailRes.data.ab_comparison.variant_a.sent + detailRes.data.ab_comparison.variant_b.sent,
        12
      );
    });

    it('F3-T1-03: evaluates /pre-send-review exclusions & merge tags and renders /test-email + template /:id/test-send', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const lead1 = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Primary One', email: 'p1@test.vn', email_consent: 'subscribed' },
      });
      const lead2 = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Excluded Two', email: 'p2@test.vn', email_consent: 'subscribed' },
      });

      const primaryAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Primary Aud', audience_type: 'static_data', lead_ids: [lead1.data.id, lead2.data.id] },
      });
      const excludeAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Exclusion Aud', audience_type: 'static_data', lead_ids: [lead2.data.id] },
      });

      const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Merge Review Template',
          subject: 'Xin chào {{lead.name}}',
          compiled_html:
            '<html><body><p>Chào {{lead.name}}, quan tâm {{lead.product_interest}}, mã {{custom_fallback_tag}}</p><a href="https://example.com/view">Xem</a><a href="{{unsubscribe_url}}">Hủy</a></body></html>',
        },
      });

      const reviewRes = await harness.apiJson('/api/v1/marketing/campaigns/pre-send-review', {
        method: 'POST',
        auth,
        body: {
          channel: 'email',
          audience_id: primaryAud.data.id,
          exclude_audience_ids: [excludeAud.data.id],
          template_id: tplRes.data.id,
          subject_a: 'Chào {{lead.name}}',
          fallback_vars: { custom_fallback_tag: 'DEFAULT-2026' },
        },
      });
      assert.equal(reviewRes.data.audience_total, 2);
      assert.equal(reviewRes.data.excluded_count, 1);
      assert.equal(reviewRes.data.net_reachable_estimate, 1);
      assert.ok(reviewRes.data.detected_merge_tags.includes('{{lead.name}}'));
      assert.equal(typeof reviewRes.data.readiness_score, 'number');
      assert.equal(typeof reviewRes.data.ready_to_send, 'boolean');

      const testEmailRes = await harness.apiJson('/api/v1/marketing/campaigns/test-email', {
        method: 'POST',
        auth,
        body: {
          to_email: 'qa@test.vn',
          variant: 'B',
          template_id: tplRes.data.id,
          subject_a: 'Sub A {{lead.name}}',
          subject_b: 'Sub B {{lead.name}}',
          fallback_vars: { custom_fallback_tag: 'FALLBACK99' },
          sample_lead: {
            name: 'Lan Pham',
            product_interest: 'Pro Plan',
            voucher_code: 'VIP99',
          },
        },
      });
      assert.equal(testEmailRes.data.variant, 'B');
      assert.equal(testEmailRes.data.rendered_subject, '[TEST B] Sub B Lan Pham');
      assert.ok(String(testEmailRes.data.rendered_html).includes('Lan Pham'));
      assert.ok(String(testEmailRes.data.rendered_html).includes('Pro Plan'));
      assert.ok(String(testEmailRes.data.rendered_html).includes('FALLBACK99'));

      const tplTestRes = await harness.apiJson(`/api/v1/marketing/templates/${tplRes.data.id}/test-send`, {
        method: 'POST',
        auth,
        body: { to_email: 'qa@test.vn', sample_name: 'Minh Tran' },
      });
      assert.equal(tplTestRes.data.to_email, 'qa@test.vn');
      assert.ok(String(tplTestRes.data.rendered_html).includes('Minh Tran'));
    });

    it('F3-T1-04: dispatches real tracked HTML email (Resend + SMTP hook), injects open pixel & click wrapper, and records idempotent open/click stats', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      await configureResendEmail(auth, 'campaign@e2e.vn');
      harness.setSmtpCaptureEnabled(false);

      const lead = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Hoa Nguyen',
          email: 'hoa.nguyen@test.vn',
          email_consent: 'subscribed',
        },
      });
      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Resend Track Audience', audience_type: 'static_data', lead_ids: [lead.data.id] },
      });

      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Tracked HTML Template',
          subject: 'Chào {{lead.name}}',
          compiled_html:
            '<html><body><p>Xin chào {{lead.name}}</p><a href="https://example.com/landing?ref=1">Khám phá</a><a href="{{unsubscribe_url}}">Hủy đăng ký</a></body></html>',
        },
      });

      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Tracked Live Send',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Ưu đãi cho {{lead.name}}',
        },
      });

      harness.emailCapture.length = 0;
      const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(sendRes.data.newly_sent, 1);
      assert.equal(sendRes.data.claim_ids.length, 1);
      const claimId = sendRes.data.claim_ids[0];

      const resendSent = harness.emailCapture.filter((e) => e.driver === 'resend');
      assert.equal(resendSent.length, 1);
      const captured = resendSent[0];
      assert.equal(captured.driver, 'resend');
      assert.equal(captured.to, 'hoa.nguyen@test.vn');
      assert.equal(captured.subject, 'Ưu đãi cho Hoa Nguyen');
      const html = String(captured.html || '');
      assert.ok(html.includes('Xin chào Hoa Nguyen'));
      assert.ok(html.includes(`/api/v1/public/marketing/track/open/${claimId}`));
      assert.ok(html.includes(`/api/v1/public/marketing/track/click/${claimId}?url=`));
      assert.ok(html.includes('/api/v1/public/marketing/unsubscribe?'));

      const openMatch = html.match(/src="([^"]*\/api\/v1\/public\/marketing\/track\/open\/[^"]+)"/);
      const clickMatch = html.match(/href="([^"]*\/api\/v1\/public\/marketing\/track\/click\/[^"]+)"/);
      assert.ok(openMatch?.[1]);
      assert.ok(clickMatch?.[1]);
      const openUrl = openMatch![1].replace(/&amp;/g, '&');
      const clickUrl = clickMatch![1].replace(/&amp;/g, '&');

      // Hit open pixel twice -> idempotent opened_count === 1
      const open1 = await fetch(openUrl);
      assert.equal(open1.status, 200);
      assert.ok(String(open1.headers.get('content-type') || '').includes('image/gif'));
      const open2 = await fetch(openUrl);
      assert.equal(open2.status, 200);

      // Hit wrapped click URL with redirect: 'manual' -> 302 to original target
      const clickResp = await fetch(clickUrl, { redirect: 'manual' });
      assert.equal(clickResp.status, 302);
      assert.equal(clickResp.headers.get('location'), 'https://example.com/landing?ref=1');

      const detailRes = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/detail`, { auth });
      assert.equal(detailRes.data.campaign.opened_count, 1);
      assert.equal(detailRes.data.campaign.clicked_count, 1);
      assert.equal(detailRes.data.funnel.opened, 1);
      assert.equal(detailRes.data.funnel.clicked, 1);
      assert.equal(detailRes.data.click_map.length, 1);
      assert.equal(detailRes.data.click_map[0].url, 'https://example.com/landing?ref=1');

      // Also verify smtp_hook capture mode via quick-send
      harness.emailCapture.length = 0;
      harness.setSmtpCaptureEnabled(true);
      const qsRes = await harness.apiJson('/api/v1/marketing/templates/quick-send', {
        method: 'POST',
        auth,
        body: {
          to_email: 'smtp.verify@test.vn',
          subject: 'SMTP Hook Check',
          compiled_html: '<p>SMTP body content</p>',
        },
      });
      assert.equal(qsRes.data.sent_count, 1);
      assert.equal(harness.emailCapture.length, 1);
      assert.equal(harness.emailCapture[0].driver, 'smtp_hook');
      assert.equal(harness.emailCapture[0].to, 'smtp.verify@test.vn');
    });

    it('F3-T1-05: creates reminders and dispatches sequential no_open & no_click reminders with accurate /detail funnel', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const leadA = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Opened Lead A', email: 'leada@test.vn', email_consent: 'subscribed' },
      });
      const leadB = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Unopened Lead B', email: 'leadb@test.vn', email_consent: 'subscribed' },
      });

      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Reminder Audience',
          audience_type: 'static_data',
          lead_ids: [leadA.data.id, leadB.data.id],
        },
      });

      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Reminder Template',
          subject: 'Initial Offer',
          compiled_html: '<html><body><p>Hi {{lead.name}}</p><a href="https://example.com/rem">CTA</a></body></html>',
        },
      });

      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Reminder Sequence Campaign',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Original Subject',
        },
      });
      const campId = camp.data.id;

      const remNoOpen = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/reminders`, {
        method: 'POST',
        auth,
        body: {
          step_order: 1,
          trigger_condition: 'no_open',
          wait_hours: 24,
          subject: 'Nhắc mở mail {{lead.name}}',
          template_id: tpl.data.id,
          channel: 'email',
        },
      });
      const remNoClick = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/reminders`, {
        method: 'POST',
        auth,
        body: {
          step_order: 2,
          trigger_condition: 'no_click',
          wait_hours: 48,
          subject: 'Nhắc click CTA {{lead.name}}',
          template_id: tpl.data.id,
          channel: 'email',
        },
      });
      assert.ok(remNoOpen.data.id);
      assert.ok(remNoClick.data.id);

      const remList = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/reminders`, { auth });
      assert.equal(remList.data.items.length, 2);

      harness.emailCapture.length = 0;
      const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(sendRes.data.newly_sent, 2);
      const initialEmails = harness.emailCapture.filter((e) => e.to.endsWith('@test.vn'));
      assert.equal(initialEmails.length, 2);

      const detailBefore = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
      const claimA = detailBefore.data.claims.find((c: any) => c.lead_id === leadA.data.id);
      assert.ok(claimA?.id);

      // Lead A opens email; Lead B does not open
      const openResp = await fetch(`${harness.baseUrl}/api/v1/public/marketing/track/open/${claimA.id}`);
      assert.equal(openResp.status, 200);

      // Process no_open reminder -> only Lead B receives it
      harness.emailCapture.length = 0;
      const procNoOpen = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/process-reminders`, {
        method: 'POST',
        auth,
        body: { trigger_condition: 'no_open', reminder_id: remNoOpen.data.id },
      });
      assert.equal(procNoOpen.data.reminders_dispatched, 1);
      const noOpenEmails = harness.emailCapture.filter((e) => e.to.endsWith('@test.vn'));
      assert.equal(noOpenEmails.length, 1);
      assert.equal(noOpenEmails[0].to, 'leadb@test.vn');

      // Process no_click reminder -> Lead A opened but hasn't clicked, Lead B already had reminder_sent=true
      harness.emailCapture.length = 0;
      const procNoClick = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/process-reminders`, {
        method: 'POST',
        auth,
        body: { trigger_condition: 'no_click', reminder_id: remNoClick.data.id },
      });
      assert.equal(procNoClick.data.reminders_dispatched, 1);
      const noClickEmails = harness.emailCapture.filter((e) => e.to.endsWith('@test.vn'));
      assert.equal(noClickEmails.length, 1);
      assert.equal(noClickEmails[0].to, 'leada@test.vn');

      // Repeating process-reminders dispatches 0
      harness.emailCapture.length = 0;
      const procRepeat = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/process-reminders`, {
        method: 'POST',
        auth,
        body: { trigger_condition: 'all' },
      });
      assert.equal(procRepeat.data.reminders_dispatched, 0);
      const repeatEmails = harness.emailCapture.filter((e) => e.to.endsWith('@test.vn'));
      assert.equal(repeatEmails.length, 0);

      const detailAfter = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
      assert.equal(detailAfter.data.funnel.targeted, 2);
      assert.equal(detailAfter.data.funnel.sent, 2);
      assert.equal(detailAfter.data.funnel.opened, 1);
      assert.equal(detailAfter.data.funnel.clicked, 0);
      assert.equal(detailAfter.data.claims.length, 2);
      assert.ok(detailAfter.data.reminders.every((r: any) => Number(r.dispatched_count) >= 1));
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (5 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F3-T2-01: rejects empty/whitespace campaign, template & template-group names with 422', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const campErr = await harness.apiRaw('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: { name: '   ', channel: 'email' },
      });
      assert.equal(campErr.status, 422);
      assert.equal(campErr.json?.error?.code, 'CAMPAIGN_NAME_REQUIRED');

      const tplErr = await harness.apiRaw('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: { name: '', subject: 'No name' },
      });
      assert.equal(tplErr.status, 422);
      assert.equal(tplErr.json?.error?.code, 'TEMPLATE_NAME_REQUIRED');

      const grpErr = await harness.apiRaw('/api/v1/marketing/templates/groups', {
        method: 'POST',
        auth,
        body: { name: '   ' },
      });
      assert.equal(grpErr.status, 422);
      assert.equal(grpErr.json?.error?.code, 'GROUP_NAME_REQUIRED');
    });

    it('F3-T2-02: rejects invalid test-email, template test-send & empty suppression recipient with 422', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: { name: 'Validation Template', compiled_html: '<p>Hi</p>' },
      });
      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: { name: 'Validation Campaign', template_id: tpl.data.id },
      });

      const testEmailBad = await harness.apiRaw('/api/v1/marketing/campaigns/test-email', {
        method: 'POST',
        auth,
        body: { to_email: 'not-an-email' },
      });
      assert.equal(testEmailBad.status, 422);
      assert.equal(testEmailBad.json?.error?.code, 'INVALID_TEST_EMAIL');

      const campTestBad = await harness.apiRaw(`/api/v1/marketing/campaigns/${camp.data.id}/test-email`, {
        method: 'POST',
        auth,
        body: { emails: ['bad-format', '   '] },
      });
      assert.equal(campTestBad.status, 422);
      assert.equal(campTestBad.json?.error?.code, 'INVALID_TEST_EMAIL');

      const tplTestBad = await harness.apiRaw(`/api/v1/marketing/templates/${tpl.data.id}/test-send`, {
        method: 'POST',
        auth,
        body: { to_email: 'invalid-address' },
      });
      assert.equal(tplTestBad.status, 422);
      assert.equal(tplTestBad.json?.error?.code, 'INVALID_TEST_EMAIL');

      const supBad = await harness.apiRaw('/api/v1/marketing/campaigns/suppression/list', {
        method: 'POST',
        auth,
        body: { recipient: '   ', channel: 'email' },
      });
      assert.equal(supBad.status, 422);
      assert.equal(supBad.json?.error?.code, 'RECIPIENT_REQUIRED');
    });

    it('F3-T2-03: enforces mkt_suppression_list, rejects tampered HMAC /unsubscribe (403), and blocks subsequent sends after valid opt-out', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      await configureResendEmail(auth, 'optout@e2e.vn');
      harness.setSmtpCaptureEnabled(false);

      const lead1 = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Suppressed Lead', email: 'suppressed@test.vn', email_consent: 'subscribed' },
      });
      const lead2 = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'OptOut Lead', email: 'optout@test.vn', email_consent: 'subscribed' },
      });

      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Suppression Test Aud',
          audience_type: 'static_data',
          lead_ids: [lead1.data.id, lead2.data.id],
        },
      });

      // Tampered HMAC signature -> 403 INVALID_UNSUBSCRIBE_SIGNATURE
      const tamperedRes = await harness.apiRaw('/api/v1/public/marketing/unsubscribe', {
        method: 'GET',
        query: {
          tenant_id: auth.tenantId,
          lead_id: lead1.data.id,
          channel: 'email',
          sig: 'deadbeef'.repeat(8),
        },
      });
      assert.equal(tamperedRes.status, 403);
      assert.equal(tamperedRes.json?.error?.code, 'INVALID_UNSUBSCRIBE_SIGNATURE');

      // Add Lead 1 to suppression list
      const supAdd = await harness.apiRaw('/api/v1/marketing/campaigns/suppression/list', {
        method: 'POST',
        auth,
        body: { recipient: 'suppressed@test.vn', channel: 'email', reason: 'hard_bounce' },
      });
      assert.equal(supAdd.status, 201);

      const supList = await harness.apiJson('/api/v1/marketing/campaigns/suppression/list', { auth });
      assert.ok(supList.data.items.some((i: any) => i.recipient === 'suppressed@test.vn'));

      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: {
          name: 'Unsub Link Template',
          subject: 'Check Unsub',
          compiled_html: '<html><body><p>Hello {{lead.name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>',
        },
      });

      const camp1 = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Campaign Before Unsub',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Campaign 1',
        },
      });

      harness.emailCapture.length = 0;
      const send1 = await harness.apiJson(`/api/v1/marketing/campaigns/${camp1.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(send1.data.newly_sent, 1);
      assert.equal(send1.data.suppressed_skipped, 1);
      const resendEmails = harness.emailCapture.filter((e) => e.driver === 'resend');
      assert.equal(resendEmails.length, 1);
      assert.equal(resendEmails[0].to, 'optout@test.vn');

      const html = String(resendEmails[0].html || '');
      const unsubMatch = html.match(/href="([^"]*\/api\/v1\/public\/marketing\/unsubscribe\?[^"]+)"/);
      assert.ok(unsubMatch?.[1]);
      const unsubUrl = unsubMatch![1].replace(/&amp;/g, '&');

      // Valid HMAC unsubscribe -> 200
      const unsubResp = await fetch(unsubUrl);
      assert.equal(unsubResp.status, 200);
      const unsubJson: any = await unsubResp.json();
      assert.equal(unsubJson.data?.unsubscribed, true);
      assert.equal(unsubJson.data?.channel, 'email');

      const detail1 = await harness.apiJson(`/api/v1/marketing/campaigns/${camp1.data.id}/detail`, { auth });
      assert.equal(detail1.data.campaign.unsubscribed_count, 1);

      // Second campaign to same audience skips both Lead 1 & Lead 2
      harness.emailCapture.length = 0;
      const camp2 = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Campaign After Unsub',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Campaign 2',
        },
      });
      const send2 = await harness.apiJson(`/api/v1/marketing/campaigns/${camp2.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(send2.data.newly_sent, 0);
      assert.equal(send2.data.suppressed_skipped, 2);
      assert.equal(harness.emailCapture.length, 0);
    });

    it('F3-T2-04: enforces exclude_audience_ids exclusion & atomic idempotent send claims preventing duplicate sends', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const leadA = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Target A', email: 'targeta@test.vn', email_consent: 'subscribed' },
      });
      const leadB = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Excluded B', email: 'excludedb@test.vn', email_consent: 'subscribed' },
      });

      const primaryAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Primary', audience_type: 'static_data', lead_ids: [leadA.data.id, leadB.data.id] },
      });
      const excludeAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Exclude', audience_type: 'static_data', lead_ids: [leadB.data.id] },
      });

      const tpl = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth,
        body: { name: 'Idem Template', subject: 'Idem', compiled_html: '<p>Hi {{lead.name}}</p>' },
      });
      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Exclusion & Idempotency Campaign',
          channel: 'email',
          audience_id: primaryAud.data.id,
          exclude_audience_ids: [excludeAud.data.id],
          template_id: tpl.data.id,
          subject_a: 'Only Target A',
        },
      });

      harness.emailCapture.length = 0;
      const firstSend = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(firstSend.data.newly_sent, 1);
      assert.equal(firstSend.data.duplicate_claims_prevented, 0);
      const firstSendEmails = harness.emailCapture.filter((e) => e.to.endsWith('@test.vn'));
      assert.equal(firstSendEmails.length, 1);
      assert.equal(firstSendEmails[0].to, 'targeta@test.vn');

      harness.emailCapture.length = 0;
      const secondSend = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(secondSend.data.newly_sent, 0);
      assert.equal(secondSend.data.duplicate_claims_prevented, 1);
      const secondSendEmails = harness.emailCapture.filter((e) => e.to.endsWith('@test.vn'));
      assert.equal(secondSendEmails.length, 0);
    });

    it('F3-T2-05: isolates templates & campaigns across tenants (404 on cross-tenant access/mutation)', async () => {
      const tenantA = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const tenantB = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const tplA = await harness.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'Tenant A Secret Template', compiled_html: '<p>Secret A</p>' },
      });
      const campA = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'Tenant A Secret Campaign', template_id: tplA.data.id },
      });

      // Tenant B lists should not expose Tenant A records
      const listTplsB = await harness.apiJson('/api/v1/marketing/templates', { auth: tenantB });
      assert.equal(listTplsB.data.items.some((t: any) => t.id === tplA.data.id), false);

      const listCampsB = await harness.apiJson('/api/v1/marketing/campaigns', { auth: tenantB });
      assert.equal(listCampsB.data.items.some((c: any) => c.id === campA.data.id), false);

      // Cross-tenant template endpoints -> 404 TEMPLATE_NOT_FOUND
      for (const req of [
        { method: 'GET', path: `/api/v1/marketing/templates/${tplA.data.id}` },
        { method: 'PUT', path: `/api/v1/marketing/templates/${tplA.data.id}`, body: { name: 'Hijack' } },
        { method: 'DELETE', path: `/api/v1/marketing/templates/${tplA.data.id}` },
      ]) {
        const res = await harness.apiRaw(req.path, { method: req.method, auth: tenantB, body: req.body });
        assert.equal(res.status, 404);
        assert.equal(res.json?.error?.code, 'TEMPLATE_NOT_FOUND');
      }

      // Cross-tenant campaign endpoints -> 404 CAMPAIGN_NOT_FOUND
      for (const req of [
        { method: 'GET', path: `/api/v1/marketing/campaigns/${campA.data.id}/detail` },
        { method: 'PUT', path: `/api/v1/marketing/campaigns/${campA.data.id}`, body: { name: 'Hijack' } },
        { method: 'DELETE', path: `/api/v1/marketing/campaigns/${campA.data.id}` },
        { method: 'POST', path: `/api/v1/marketing/campaigns/${campA.data.id}/send`, body: {} },
        {
          method: 'POST',
          path: `/api/v1/marketing/campaigns/${campA.data.id}/reminders`,
          body: { trigger_condition: 'no_open', subject: 'Hijack' },
        },
        { method: 'POST', path: `/api/v1/marketing/campaigns/${campA.data.id}/process-reminders`, body: {} },
      ]) {
        const res = await harness.apiRaw(req.path, { method: req.method, auth: tenantB, body: req.body });
        assert.equal(res.status, 404);
        assert.equal(res.json?.error?.code, 'CAMPAIGN_NOT_FOUND');
      }
    });
  });
});
