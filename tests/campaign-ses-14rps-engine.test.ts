import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import {
  closeSmtpConnectionPools,
  sendTenantEmailNotification,
  setEmailWebhookFetcherForTesting,
  setSmtpTransportForTesting,
} from '../server/services/zalo-mail.service.ts';
import {
  dispatchCampaignBatchHighSpeed,
  setZnsDispatcherForTesting,
  waitForCampaignDispatch,
} from '../server/modules/marketing/dispatchers.ts';
import { runScheduledMarketingCampaigns } from '../server/cron/subroutines/wave2-workers.ts';

describe('TEAM 1: High-Speed 14 Mail/s AWS SES Engine, Dedicated Email Provider Gate & ZNS/VN-TZ Audit', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  const origSilentMode = process.env.OUTBOUND_SILENT_MODE;

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Domation High-Speed SES Corp',
        tenant_slug: 'domation-ses-14rps',
        admin_name: 'Tran Quoc Bao',
        work_email: 'admin@ses-speed.vn',
        phone: '0909111222',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    tenantA = {
      id: reg.json.data.tenant.id,
      slug: reg.json.data.tenant.slug,
      token: reg.json.data.access_token,
    };

    // Upgrade tenantA to growth_combo so all /marketing/* endpoints are entitled
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 20000000 WHERE id = $1', [tenantA.id]);
    });
    const sw = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'growth_combo' },
    });
    assert.equal(sw.status, 200);
  });

  after(async () => {
    setEmailWebhookFetcherForTesting(null);
    setSmtpTransportForTesting(null);
    setZnsDispatcherForTesting(null);
    closeSmtpConnectionPools();
    if (origSilentMode === undefined) {
      delete process.env.OUTBOUND_SILENT_MODE;
    } else {
      process.env.OUTBOUND_SILENT_MODE = origSilentMode;
    }
    await harness.close();
  });

  it('1. Rejects Apps Script-only tenant on live campaign launch with 422 AUTOMATION_EMAIL_PROVIDER_REQUIRED (while CRM Apps Script stays intact & AWS SES/SMTP unlocks)', async () => {
    // Configure ONLY Google Apps Script (CRM basic notifications)
    const appscriptCfg = await apiRequest(harness.baseUrl, '/api/v1/integrations/email/config', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        email_provider: 'appscript',
        appscript_webhook_url: 'https://script.google.com/macros/s/AKfycbxAppscriptOnlyCRM/exec',
        ses_sender_name: 'CRM Notifier',
      },
    });
    assert.equal(appscriptCfg.status, 200);

    // Readiness & SES Quota endpoints MUST flag email_provider_ready=false, uses_appscript_only=true
    const quotaRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/ses-quota', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(quotaRes.status, 200);
    assert.equal(quotaRes.json.data.email_provider_ready, false);
    assert.equal(quotaRes.json.data.active_provider, null);
    assert.equal(quotaRes.json.data.uses_appscript_only, true);
    assert.equal(quotaRes.json.data.settings_url, '/settings?tab=email_config');

    const readyRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/readiness', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.json.data.email_provider_ready, false);
    assert.equal(readyRes.json.data.uses_appscript_only, true);

    // Seed 1 lead so campaign has target
    const audRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Gate Test Audience', audience_type: 'static_list' },
    });
    assert.equal(audRes.status, 201);
    const gateAudId = audRes.json.data.id;

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Nguyen Van A',
        email: 'gate-lead@example.vn',
        phone: '0901234567',
        email_consent: 'subscribed',
        audience_id: gateAudId,
      },
    });
    assert.equal(leadRes.status, 201);

    const draftCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Apps Script Blocked Campaign',
        channel: 'email',
        audience_id: gateAudId,
        subject_a: 'Hello {{name}}',
      },
    });
    assert.equal(draftCamp.status, 201);
    const campId = draftCamp.json.data.id;

    // Switch to live mode & capture any accidental Apps Script calls
    process.env.OUTBOUND_SILENT_MODE = 'false';
    const webhookCalls: Array<{ url: string; body: any }> = [];
    setEmailWebhookFetcherForTesting(async (url, init) => {
      webhookCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response(JSON.stringify({ ok: true, MessageId: `msg_${webhookCalls.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // Launching via /send, /launch, and POST status=sending MUST all fail with 422 AUTOMATION_EMAIL_PROVIDER_REQUIRED
    for (const ep of [
      { path: `/api/v1/marketing/campaigns/${campId}/send`, body: undefined },
      { path: `/api/v1/marketing/campaigns/${campId}/launch`, body: undefined },
      {
        path: '/api/v1/marketing/campaigns',
        body: { name: 'Immediate Live Blocked', channel: 'email', audience_id: gateAudId, status: 'sending', subject_a: 'Test' },
      },
    ]) {
      const blocked = await apiRequest(harness.baseUrl, ep.path, {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: ep.body,
      });
      assert.equal(blocked.status, 422, `Expected 422 on ${ep.path}`);
      assert.equal(blocked.json.error.code, 'AUTOMATION_EMAIL_PROVIDER_REQUIRED');
      assert.equal(blocked.json.meta.uses_appscript_only, true);
      assert.equal(blocked.json.meta.settings_url, '/settings?tab=email_config');
      assert.match(String(blocked.json.error.message), /AWS SES/i);
      assert.match(String(blocked.json.error.message), /Google Apps Script/i);
    }
    assert.equal(webhookCalls.length, 0, 'Apps Script must NEVER be invoked for Marketing Automation campaigns');

    // Verify CRM basic notification (`sendTenantEmailNotification` without disallowAppscript) STILL works via Apps Script!
    const crmNotify = await sendTenantEmailNotification({
      tenantId: tenantA.id,
      to: 'sales-rep@ses-speed.vn',
      subject: '[CRM] Lead mới phân công',
      text: 'Khách hàng mới vừa đăng ký.',
      category: 'assignment',
    });
    assert.equal(crmNotify?.sent, true);
    assert.equal(crmNotify?.provider, 'appscript');
    assert.equal(webhookCalls.length, 1);
    assert.match(webhookCalls[0].url, /script\.google\.com/);

    // Configure dedicated AWS SES vault -> unlocks campaign launch!
    const sesVaultRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/aws_ses', {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        accessKeyId: 'AKIA_TEST_SES_14RPS',
        secretAccessKey: 'SECRET_TEST_SES_14RPS_KEY_123456',
        region: 'ap-southeast-1',
        from_email: 'marketing@ses-speed.vn',
        from_name: 'Domation SES',
        max_send_rate: 14,
      },
    });
    assert.equal(sesVaultRes.status, 200);

    const readyAfter = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns/readiness', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(readyAfter.status, 200);
    assert.equal(readyAfter.json.data.email_provider_ready, true);
    assert.equal(readyAfter.json.data.active_provider, 'aws_ses');
    assert.equal(readyAfter.json.data.uses_appscript_only, false);
    assert.equal(readyAfter.json.data.max_send_rate_per_sec, 14);

    // Now /send succeeds via AWS SES v2!
    webhookCalls.length = 0;
    const sendOk = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/send`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(sendOk.status, 200);
    assert.equal(sendOk.json.data.newly_sent, 1);
    assert.equal(webhookCalls.length, 1);
    assert.match(webhookCalls[0].url, /email\.ap-southeast-1\.amazonaws\.com\/v2\/email\/outbound-emails/);
  });

  it('2. Dispatches 30 recipients concurrently via 14 req/s Token-Bucket with zero DB TX blocking, dedup/suppression, accurate stats_json & merge-tag parity', async () => {
    process.env.OUTBOUND_SILENT_MODE = 'false';

    // Create dedicated audience with 30 unique subscribed leads + 1 duplicate email + 1 suppressed email
    const audRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Batch 30 SES 14RPS Audience', audience_type: 'static_list' },
    });
    assert.equal(audRes.status, 201);
    const batchAudId = audRes.json.data.id;

    await withTenantTransaction(tenantA.id, async (client) => {
      for (let i = 1; i <= 30; i++) {
        const lid = crypto.randomUUID();
        const email = `lead${String(i).padStart(2, '0')}@batch30.vn`;
        const phone = `0901000${String(i).padStart(3, '0')}`;
        await client.query(
          `INSERT INTO leads (id, tenant_id, name, email, phone, email_consent, zns_consent, custom_fields)
           VALUES ($1, $2, $3, $4, $5, 'subscribed', 'opted_in', $6::jsonb)`,
          [
            lid,
            tenantA.id,
            `Khách Hàng ${i}`,
            email,
            phone,
            JSON.stringify({ company: `CongTy-${i}`, tier: i % 2 === 0 ? 'Platinum' : 'Gold' }),
          ]
        );
        await client.query(
          `INSERT INTO tenant_audience_members (tenant_id, audience_id, lead_id) VALUES ($1, $2, $3)`,
          [tenantA.id, batchAudId, lid]
        );
      }

      // Duplicate email lead (same email as lead01 -> MUST be deduplicated)
      const dupId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (id, tenant_id, name, email, phone, email_consent)
         VALUES ($1, $2, 'Duplicate Lead', 'LEAD01@batch30.vn', '0909999001', 'subscribed')`,
        [dupId, tenantA.id]
      );
      await client.query(
        `INSERT INTO tenant_audience_members (tenant_id, audience_id, lead_id) VALUES ($1, $2, $3)`,
        [tenantA.id, batchAudId, dupId]
      );

      // Suppressed email lead -> MUST be skipped
      const supId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (id, tenant_id, name, email, phone, email_consent)
         VALUES ($1, $2, 'Suppressed Lead', 'blocked@batch30.vn', '0909999002', 'subscribed')`,
        [supId, tenantA.id]
      );
      await client.query(
        `INSERT INTO tenant_audience_members (tenant_id, audience_id, lead_id) VALUES ($1, $2, $3)`,
        [tenantA.id, batchAudId, supId]
      );
      await client.query(
        `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
         VALUES ($1, $2, 'email', 'blocked@batch30.vn', 'hard_bounce')`,
        [crypto.randomUUID(), tenantA.id]
      );
    });

    const campRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'SES 14RPS 30-Batch Campaign',
        channel: 'email',
        audience_id: batchAudId,
        subject_a: 'Chào {{name}} tại {{company}} ({{lead.custom_fields.tier}})',
        contentBody:
          '<p>Xin chào {{name}}, email {{email}}, SĐT {{phone}}, công ty {{company}}, mã {{vip_code}}.</p><a href="https://domation.vn/promo">Xem ngay</a><a href="{{unsubscribe_url}}">Hủy</a>',
        fallback_vars: { vip_code: 'VIP-2026' },
      },
    });
    assert.equal(campRes.status, 201);
    const campId = campRes.json.data.id;

    let inFlight = 0;
    let peakConcurrency = 0;
    const sentRecords: Array<{ to: string; subject: string; html: string; ts: number }> = [];

    setEmailWebhookFetcherForTesting(async (_url, init) => {
      inFlight++;
      if (inFlight > peakConcurrency) peakConcurrency = inFlight;
      try {
        await new Promise((r) => setTimeout(r, 40));
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const to = String(body?.Destination?.ToAddresses?.[0] || '');
        const subject = String(body?.Content?.Simple?.Subject?.Data || '');
        const html = String(body?.Content?.Simple?.Body?.Html?.Data || '');
        sentRecords.push({ to, subject, html, ts: Date.now() });
        return new Response(JSON.stringify({ MessageId: `ses_14rps_${sentRecords.length}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } finally {
        inFlight--;
      }
    });

    // Launch non-blocking (`async: true`) and prove zero DB TX blocking mid-flight!
    const launchStart = Date.now();
    const launchRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/send`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { async: true },
    });
    assert.equal(launchRes.status, 200);
    assert.equal(launchRes.json.data.async, true);
    assert.equal(launchRes.json.data.campaign.status, 'sending');

    // Poll progress & stats_only endpoints concurrently mid-flight (MUST respond fast with zero DB lock!)
    const pollStart = Date.now();
    const [progMid, statsOnlyMid, detailStatsMid] = await Promise.all([
      apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/progress`, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }),
      apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}?stats_only=1`, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }),
      apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/detail?stats_only=1`, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }),
    ]);
    const pollElapsedMs = Date.now() - pollStart;
    assert.equal(progMid.status, 200);
    assert.equal(statsOnlyMid.status, 200);
    assert.equal(detailStatsMid.status, 200);
    assert.ok(pollElapsedMs < 1000, `Mid-flight DB reads should not be blocked (took ${pollElapsedMs}ms)`);

    // Wait for background high-speed dispatch to finish cleanly
    await waitForCampaignDispatch(tenantA.id, campId);
    const totalElapsedMs = Date.now() - launchStart;

    // 30 unique recipients sent, 0 duplicates, 0 suppressed, genuine concurrency > 1, realistic 14/s pacing
    assert.equal(sentRecords.length, 30, 'All 30 unique eligible recipients must be sent');
    assert.equal(new Set(sentRecords.map((r) => r.to)).size, 30, 'Zero duplicate emails allowed');
    assert.ok(!sentRecords.some((r) => r.to === 'blocked@batch30.vn'), 'Suppressed email must never be sent');
    assert.ok(peakConcurrency >= 2, `Expected concurrent worker pool (peakConcurrency=${peakConcurrency})`);
    // Token bucket at 14 req/s: burst 14 + remaining 16 paced at 14/s (~1.14s)
    assert.ok(totalElapsedMs >= 800, `Expected token-bucket pacing >= 800ms, got ${totalElapsedMs}ms`);
    assert.ok(totalElapsedMs < 8000, `Expected fast concurrent completion < 8000ms, got ${totalElapsedMs}ms`);

    // Verify final lightweight progress endpoint & stats_json
    const progDone = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/progress`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(progDone.status, 200);
    assert.equal(progDone.json.data.status, 'completed');
    assert.equal(progDone.json.data.sent, 30);
    assert.equal(progDone.json.data.failed, 0);
    assert.equal(progDone.json.data.progress_pct, 100);
    assert.ok(progDone.json.data.rate_per_sec > 0, 'rate_per_sec must be > 0');
    assert.equal(progDone.json.data.eta_seconds, 0);
    assert.equal(progDone.json.data.stats_json.sent, 30);
    assert.equal(progDone.json.data.stats_json.progress_pct, 100);

    // Verify merge-tag interpolation + tracking pixel + unsubscribe link on dispatched message
    const rec2 = sentRecords.find((r) => r.to === 'lead02@batch30.vn');
    assert.ok(rec2, 'lead02@batch30.vn must be dispatched');
    assert.equal(rec2.subject, 'Chào Khách Hàng 2 tại CongTy-2 (Platinum)');
    assert.ok(rec2.html.includes('lead02@batch30.vn'));
    assert.ok(rec2.html.includes('0901000002'));
    assert.ok(rec2.html.includes('CongTy-2'));
    assert.ok(rec2.html.includes('VIP-2026'));
    assert.ok(rec2.html.includes('/api/v1/public/marketing/track/open/'));
    assert.ok(rec2.html.includes('/api/v1/public/marketing/track/click/'));
    assert.ok(rec2.html.includes('/api/v1/public/marketing/unsubscribe?'));

    // Verify Test Email uses the EXACT same merge-tag resolver (`buildCampaignMergeContext`)
    const testMailRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/test-email`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        to_email: 'preview@batch30.vn',
        send_live: false,
        sample_lead: {
          name: 'Khách Hàng 2',
          email: 'lead02@batch30.vn',
          phone: '0901000002',
          custom_fields: { company: 'CongTy-2', tier: 'Platinum' },
        },
      },
    });
    assert.equal(testMailRes.status, 200);
    assert.equal(testMailRes.json.data.rendered_subject, '[TEST A] Chào Khách Hàng 2 tại CongTy-2 (Platinum)');
    assert.ok(testMailRes.json.data.rendered_html.includes('VIP-2026'));
    assert.ok(testMailRes.json.data.rendered_html.includes('CongTy-2'));
  });

  it('3. Accurately stores +07:00 VN scheduled_at as UTC and prevents double-send under concurrent cron pickup', async () => {
    process.env.OUTBOUND_SILENT_MODE = 'false';

    // First verify VN +07:00 -> UTC normalization accuracy
    const futureCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'VN Timezone Scheduled Campaign',
        channel: 'email',
        subject_a: 'Lịch gửi giờ VN',
        scheduled_at: '2028-06-15T10:30:00+07:00',
      },
    });
    assert.equal(futureCamp.status, 201);
    assert.equal(futureCamp.json.data.status, 'scheduled');
    assert.equal(new Date(futureCamp.json.data.scheduled_at).toISOString(), '2028-06-15T03:30:00.000Z');

    // Create 5-lead audience & due scheduled campaign (1 minute ago in +07:00 VN format)
    const audRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Cron Due 5 Audience', audience_type: 'static_list' },
    });
    assert.equal(audRes.status, 201);
    const cronAudId = audRes.json.data.id;

    await withTenantTransaction(tenantA.id, async (client) => {
      for (let i = 1; i <= 5; i++) {
        const lid = crypto.randomUUID();
        await client.query(
          `INSERT INTO leads (id, tenant_id, name, email, phone, email_consent)
           VALUES ($1, $2, $3, $4, $5, 'subscribed')`,
          [lid, tenantA.id, `Cron User ${i}`, `cron${i}@sched.vn`, `090200000${i}`]
        );
        await client.query(
          `INSERT INTO tenant_audience_members (tenant_id, audience_id, lead_id) VALUES ($1, $2, $3)`,
          [tenantA.id, cronAudId, lid]
        );
      }
    });

    const pastVnMs = Date.now() - 60_000 + 7 * 3600_000;
    const d = new Date(pastVnMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dueVnIso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+07:00`;

    const dueCamp = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Due Scheduled Atomic Cron Campaign',
        channel: 'email',
        audience_id: cronAudId,
        subject_a: 'Cron Hello {{name}}',
        scheduled_at: dueVnIso,
      },
    });
    assert.equal(dueCamp.status, 201);
    const dueCampId = dueCamp.json.data.id;

    const cronSent: string[] = [];
    setEmailWebhookFetcherForTesting(async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      cronSent.push(String(body?.Destination?.ToAddresses?.[0] || ''));
      await new Promise((r) => setTimeout(r, 15));
      return new Response(JSON.stringify({ MessageId: `cron_ses_${cronSent.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    // Run TWO workers concurrently -> atomic claim guarantees ZERO double-send!
    await Promise.all([
      runScheduledMarketingCampaigns(tenantA.id),
      runScheduledMarketingCampaigns(tenantA.id),
    ]);

    assert.equal(cronSent.length, 5, 'Each due recipient must receive exactly 1 email under concurrent cron execution');
    assert.equal(new Set(cronSent).size, 5);

    const progRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${dueCampId}/progress`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(progRes.status, 200);
    assert.equal(progRes.json.data.status, 'completed');
    assert.equal(progRes.json.data.sent, 5);
  });

  it('4. ZNS campaign enforces 06:00-22:00 VN window, VN phone normalization/dedup (0xxx <-> 84xxx), suppression & template params', async () => {
    process.env.OUTBOUND_SILENT_MODE = 'false';

    const audRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'ZNS Dedup & Suppression Audience', audience_type: 'static_list' },
    });
    assert.equal(audRes.status, 201);
    const znsAudId = audRes.json.data.id;

    await withTenantTransaction(tenantA.id, async (client) => {
      const rows = [
        { name: 'Nguyen ZNS Eligible', phone: '0912345678', consent: 'opted_in', cf: { company: 'AlphaVN', order_code: 'ORD-777' } },
        // Same phone in 84xxx format -> MUST be deduplicated
        { name: 'Nguyen ZNS Dup84', phone: '84912345678', consent: 'opted_in', cf: { company: 'DupVN' } },
        // Suppressed in 84xxx format while lead stores 0xxx -> MUST be skipped
        { name: 'Tran ZNS Suppressed', phone: '0987654321', consent: 'opted_in', cf: {} },
        // Opted-out -> MUST be skipped
        { name: 'Le ZNS OptedOut', phone: '0905556666', consent: 'opted_out', cf: {} },
      ];
      for (const r of rows) {
        const lid = crypto.randomUUID();
        await client.query(
          `INSERT INTO leads (id, tenant_id, name, phone, zns_consent, custom_fields)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [lid, tenantA.id, r.name, r.phone, r.consent, JSON.stringify(r.cf)]
        );
        await client.query(
          `INSERT INTO tenant_audience_members (tenant_id, audience_id, lead_id) VALUES ($1, $2, $3)`,
          [tenantA.id, znsAudId, lid]
        );
      }
      await client.query(
        `INSERT INTO mkt_suppression_list (id, tenant_id, channel, recipient, reason)
         VALUES ($1, $2, 'zns', '84987654321', 'zns_opt_out')`,
        [crypto.randomUUID(), tenantA.id]
      );
    });

    const znsCampRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'ZNS Order Update Campaign',
        channel: 'zns',
        audience_id: znsAudId,
        zns_template_id: '311999',
        subject_a: 'Cập nhật đơn hàng {{lead.custom_fields.order_code}}',
        config: {
          mapped_params: {
            customer_name: '{{name}}',
            order_code: '{{lead.custom_fields.order_code}}',
            company_name: '{{company}}',
          },
        },
      },
    });
    assert.equal(znsCampRes.status, 201);
    const znsCampId = znsCampRes.json.data.id;

    // Step A: Outside 06:00-22:00 VN window (23:30 VN = 16:30 UTC) -> MUST defer cleanly to next 06:00 VN (23:00 UTC)
    setZnsDispatcherForTesting(null);
    const deferredOut = await dispatchCampaignBatchHighSpeed({
      tenantId: tenantA.id,
      campaignId: znsCampId,
      publicOrigin: harness.baseUrl,
      nowOverride: new Date('2026-05-10T16:30:00.000Z'), // 23:30 VN
      enforceZnsWindow: true,
    });
    assert.equal(deferredOut.ok, true);
    assert.equal(deferredOut.deferredForZnsWindow, true);
    assert.equal(deferredOut.scheduledAt, '2026-05-10T23:00:00.000Z'); // 2026-05-11 06:00:00+07:00
    assert.equal(deferredOut.newly_sent, 0);

    // Step B: Inside 06:00-22:00 VN window (10:00 VN = 03:00 UTC) -> sends ONLY 1 normalized VN phone with mapped params
    const znsSent: Array<{ phone: string; templateId?: string | null; templateData?: Record<string, unknown> }> = [];
    setZnsDispatcherForTesting(async (inp) => {
      znsSent.push({ phone: inp.phone, templateId: inp.templateId, templateData: inp.templateData });
      return { sent: true, messageId: `zns_ok_${znsSent.length}`, provider: 'zalo_zns' };
    });

    const znsOut = await dispatchCampaignBatchHighSpeed({
      tenantId: tenantA.id,
      campaignId: znsCampId,
      publicOrigin: harness.baseUrl,
      nowOverride: new Date('2026-05-11T03:00:00.000Z'), // 10:00 VN
      enforceZnsWindow: true,
    });
    assert.equal(znsOut.ok, true);
    assert.equal(znsOut.newly_sent, 1);
    assert.ok(znsOut.duplicate_claims_prevented >= 1, '84912345678 must deduplicate against 0912345678');
    assert.ok(znsOut.suppressed_skipped >= 2, 'Suppressed 0987654321 and opted-out 0905556666 must be skipped');
    assert.equal(znsSent.length, 1);
    assert.match(znsSent[0].phone, /^\+?84912345678$/);
    assert.equal(znsSent[0].templateId, '311999');
    assert.equal(znsSent[0].templateData?.customer_name, 'Nguyen ZNS Eligible');
    assert.equal(znsSent[0].templateData?.order_code, 'ORD-777');
    assert.equal(znsSent[0].templateData?.company_name, 'AlphaVN');
  });
});
