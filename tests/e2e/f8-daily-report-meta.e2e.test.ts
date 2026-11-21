import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startE2eServer,
  apiRequest,
  registerTenant,
  triggerMasterCronHttp,
  type E2eServerHarness,
} from './helpers/e2e-harness.ts';
import { installMockFetch, type MockFetchController } from './helpers/mock-fetch.ts';
import { seedTenantWorkspace, saveVaultIntegration } from './helpers/fixtures.ts';

async function waitAwayFromMinuteBoundary(): Promise<void> {
  if (new Date().getSeconds() >= 57) {
    await new Promise((r) => setTimeout(r, 3500));
  }
}

function currentVnHHmm(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hh = parts.find((p) => p.type === 'hour')?.value || '18';
  const mm = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${hh}:${mm}`;
}

async function seedMetaAdsAndChannels(
  baseUrl: string,
  adminToken: string,
  tenantSlug: string,
  opts: {
    withMetaToken?: boolean;
    channels?: { zalo?: boolean; telegram?: boolean; email?: boolean; discord?: boolean };
    emailProvider?: 'appscript' | 'resend' | 'smtp';
    includeMetaAds?: boolean;
    accountIds?: string[];
    adminUserIds?: string[];
  }
) {
  if (opts.withMetaToken !== false) {
    const connectRes = await apiRequest(baseUrl, '/api/v1/integrations/dom-meta/connect-batch', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        access_token: 'EAA_MOCK_META_VALID_TOKEN_12345678901234567890',
        primary_ad_account_id: 'act_111222333',
        accounts: [
          {
            ad_account_id: 'act_111222333',
            name: 'DOMATION Primary Ads',
            pixel_id: '998877665544',
          },
          {
            ad_account_id: 'act_999888777',
            name: 'DOMATION Secondary Ads',
            pixel_id: '112233445566',
          },
        ],
      },
    });
    assert.ok(connectRes.status === 200 || connectRes.status === 201, `Meta connect failed: ${connectRes.rawText}`);
  }

  // Configure Telegram, Zalo, Discord, Email
  await apiRequest(baseUrl, '/api/v1/integrations/telegram/config', {
    method: 'POST',
    token: adminToken,
    tenantSlug,
    body: {
      bot_token: '123456:MOCK_TELEGRAM_BOT_TOKEN_ABC',
      chat_id: '-100888999000',
      silent_mode: false,
      enabled: true,
    },
  });

  await saveVaultIntegration(baseUrl, adminToken, tenantSlug, 'zalo_bot', {
    bot_token: 'zalo_mock_bot_token_1234567890',
    chat_id: 'zalo_group_001',
    enabled: true,
  });

  await waitAwayFromMinuteBoundary();

  const saveRes = await apiRequest(baseUrl, '/api/v1/legacy?action=save_settings', {
    method: 'POST',
    token: adminToken,
    tenantSlug,
    body: {
      zalo_daily_report_time: currentVnHHmm(),
      zalo_admin_group_chat_id: 'zalo_group_001',
      zalo_notify_only_group: '0',
      daily_report_admins: opts.adminUserIds || [],
      daily_report_channels: opts.channels || { zalo: true, telegram: true, email: true, discord: false },
      daily_report_include_meta_ads: opts.includeMetaAds ?? false,
      daily_report_meta_ads_metrics: ['results', 'leads', 'messages', 'reach', 'spend', 'peak_hours'],
      daily_report_meta_account_ids: opts.accountIds || [],
      email_provider: opts.emailProvider || 'appscript',
      appscript_webhook_url: 'https://script.google.com/macros/s/AKfycbMockDailyReportExec/exec',
      appscript_secret: 'mock_appscript_secret',
      resend_api_key: 're_mock_1234567890',
      discord_webhook_url: 'https://discord.com/api/webhooks/123456/mock_discord_token',
      fallback_cc_email: `reports@${tenantSlug}.vn`,
    },
  });
  assert.equal(saveRes.status, 200, `save_settings failed: ${saveRes.rawText}`);
}

describe('F8: Combined CRM + Meta Ads Daily Bot/Email Report (Default OFF)', () => {
  let harness: E2eServerHarness;
  let mockFetch: MockFetchController;

  before(async () => {
    mockFetch = installMockFetch();
    harness = await startE2eServer();
  });

  after(async () => {
    await harness.close();
    mockFetch.restore();
  });

  beforeEach(() => {
    mockFetch.clearRequests();
    mockFetch.resetFailureModes();
  });

  // =========================================================================
  // TIER 1: HAPPY PATH & LOCKED CONTRACT COVERAGE (>= 6 tests)
  // =========================================================================

  test('Tier 1.1: Fresh tenant defaults daily_report_include_meta_ads === false (OFF)', async () => {
    const t = await registerTenant(harness.baseUrl, {
      company_name: 'F8 Default Off Co',
      tenant_slug: 'f8-default-off',
    });
    assert.equal(t.status, 201);

    const getRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token: t.adminToken,
      tenantSlug: t.tenantSlug,
    });
    assert.equal(getRes.status, 200);
    const data = getRes.json.data;
    assert.equal(
      data.daily_report_include_meta_ads,
      false,
      'daily_report_include_meta_ads MUST default to false on fresh tenant'
    );
    assert.equal(
      data.tenant_settings?.daily_report_include_meta_ads,
      false,
      'tenant_settings.daily_report_include_meta_ads MUST default to false'
    );
  });

  test('Tier 1.2: save_settings / get_settings round-trips all daily/weekly/monthly/channels/metrics/account-ids/UUID admins', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Settings Roundtrip',
      slug: 'f8-settings-rt',
      salesCount: 1,
    });
    const adminUuid = ws.adminUserId;
    const saleUuid = ws.users[0].id;

    const saveRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        zalo_daily_report_time: '21:30',
        zalo_weekly_report_day: 'mon',
        zalo_weekly_report_time: '09:00',
        zalo_monthly_report_enabled: true,
        zalo_monthly_report_time: '08:30',
        zalo_notify_only_group: '1',
        zalo_admin_group_chat_id: 'group_uuid_999',
        daily_report_admins: [adminUuid, saleUuid],
        daily_report_channels: { zalo: true, telegram: true, email: true, discord: true },
        daily_report_include_meta_ads: true,
        daily_report_meta_ads_metrics: ['results', 'leads', 'messages', 'reach', 'spend', 'peak_hours'],
        daily_report_meta_account_ids: ['act_111222333'],
      },
    });
    assert.equal(saveRes.status, 200);

    const getRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(getRes.status, 200);
    const d = getRes.json.data;

    assert.equal(d.zalo_daily_report_time, '21:30');
    assert.equal(d.zalo_weekly_report_day, 'mon');
    assert.equal(d.zalo_weekly_report_time, '09:00');
    assert.equal(d.zalo_monthly_report_enabled, true);
    assert.equal(d.zalo_monthly_report_time, '08:30');
    assert.equal(d.daily_report_include_meta_ads, true);
    assert.deepEqual(d.daily_report_channels, { zalo: true, telegram: true, email: true, discord: true });
    assert.deepEqual(d.daily_report_meta_ads_metrics, ['results', 'leads', 'messages', 'reach', 'spend', 'peak_hours']);
    assert.deepEqual(d.daily_report_meta_account_ids, ['act_111222333']);

    const parsedAdmins = typeof d.daily_report_admins === 'string' ? JSON.parse(d.daily_report_admins) : d.daily_report_admins;
    assert.deepEqual(parsedAdmins, [adminUuid, saleUuid]);
  });

  test('Tier 1.3: CRM-only daily report when Meta Ads toggle is OFF makes 0 Meta Graph calls', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Crm Only Co',
      slug: 'f8-crm-only',
      salesCount: 1,
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: true,
      includeMetaAds: false,
      channels: { zalo: false, telegram: true, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    // Seed a real CRM lead so CRM metrics are non-zero
    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'CRM Only Lead', phone: '0911222333', source: 'Facebook' },
    });
    assert.equal(leadRes.status, 201);

    mockFetch.clearRequests();
    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    const tgReqs = mockFetch.getRequests('api.telegram.org');
    const mailReqs = mockFetch.getRequests('script.google.com');
    const metaReqs = mockFetch.getRequests('graph.facebook.com');

    assert.ok(tgReqs.length >= 1 || mailReqs.length >= 1, 'Daily report must dispatch via Bot or Email');
    assert.equal(metaReqs.length, 0, 'When daily_report_include_meta_ads is OFF, 0 Meta Graph API calls may occur');

    const combinedText = [...tgReqs, ...mailReqs].map((r) => r.body).join('\n');
    assert.ok(
      combinedText.toLowerCase().includes('lead') || combinedText.toLowerCase().includes('crm'),
      'CRM daily report payload must contain CRM lead summary'
    );
  });

  test('Tier 1.4: Combined CRM + Meta Ads daily report when ON includes results, leads, messages, reach, spend, peak hours', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Combined Ads Co',
      slug: 'f8-combined-ads',
      salesCount: 1,
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: true,
      includeMetaAds: true,
      channels: { zalo: false, telegram: true, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: { name: 'Combined Ads Lead', phone: '0911444555', source: 'Meta Ads' },
    });

    mockFetch.clearRequests();
    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    const metaReqs = mockFetch.getRequests('graph.facebook.com');
    assert.ok(metaReqs.length >= 1, 'When daily_report_include_meta_ads is ON, cron must fetch Meta Ads insights');

    const tgReqs = mockFetch.getRequests('api.telegram.org');
    const mailReqs = mockFetch.getRequests('script.google.com');
    assert.ok(tgReqs.length >= 1, 'Telegram Bot daily report must be sent');
    assert.ok(mailReqs.length >= 1, 'Email daily report must be sent');

    const outboundPayload = [...tgReqs, ...mailReqs].map((r) => r.body).join('\n');
    // Mock Meta returns spend=1,230,000, reach=19,000, leads=27, messages=45, peak hour 20:00
    assert.ok(
      outboundPayload.includes('1,230,000') || outboundPayload.includes('1.230.000') || outboundPayload.includes('1230000'),
      `Outbound payload must include Meta Ads spend, got: ${outboundPayload.slice(0, 400)}`
    );
    assert.ok(
      outboundPayload.includes('19,000') || outboundPayload.includes('19.000') || outboundPayload.includes('19000'),
      'Outbound payload must include Meta Ads reach'
    );
    assert.ok(outboundPayload.includes('27'), 'Outbound payload must include Meta Ads leads count');
    assert.ok(outboundPayload.includes('45'), 'Outbound payload must include Meta Ads messages count');
    assert.ok(outboundPayload.includes('20:00') || outboundPayload.includes('20h'), 'Outbound payload must include peak hour');
  });

  test('Tier 1.5: Outbound Bot channels (telegram, zalo, discord) dispatch cleanly when enabled', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Multi Bot Co',
      slug: 'f8-multi-bot',
      salesCount: 1,
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: false,
      includeMetaAds: false,
      channels: { zalo: true, telegram: true, email: false, discord: true },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    assert.ok(mockFetch.getRequests('api.telegram.org').length >= 1, 'Telegram Bot must be called');
    assert.ok(
      mockFetch.getRequests('bot-api.zaloplatforms.com').length >= 1 || mockFetch.getRequests('openapi.zalo.me').length >= 1,
      'Zalo Bot API must be called'
    );
    assert.ok(mockFetch.getRequests('discord.com').length >= 1, 'Discord Webhook must be called');
  });

  test('Tier 1.6: Outbound Email via Resend & Apps Script dispatches cleanly', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Resend Mail Co',
      slug: 'f8-resend-mail',
      salesCount: 1,
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: false,
      includeMetaAds: false,
      emailProvider: 'resend',
      channels: { zalo: false, telegram: false, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    const resendReqs = mockFetch.getRequests('api.resend.com');
    assert.ok(resendReqs.length >= 1, 'Resend email API must be called when email_provider=resend');
  });

  test('Tier 1.7: POST /api/v1/legacy?action=test_email with type="daily_report" dispatches real email', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Test Email Co',
      slug: 'f8-test-email',
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: false,
      includeMetaAds: false,
      emailProvider: 'appscript',
    });

    mockFetch.clearRequests();
    const testRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=test_email', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        email: 'ceo@f8-test-email.vn',
        type: 'daily_report',
      },
    });
    assert.equal(testRes.status, 200);
    assert.equal(testRes.json.success, true);

    const mailReqs = mockFetch.getRequests('script.google.com');
    assert.equal(mailReqs.length, 1);
    assert.equal(mailReqs[0].jsonBody?.to, 'ceo@f8-test-email.vn');
    assert.equal(mailReqs[0].jsonBody?.category, 'daily_report');
  });

  // =========================================================================
  // TIER 2: BOUNDARY, ERROR RECOVERY & CORNER CASES (>= 6 tests)
  // =========================================================================

  test('Tier 2.1: Missing Meta token when daily_report_include_meta_ads = true safely delivers CRM report without crash', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Missing Meta Token',
      slug: 'f8-missing-token',
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: false,
      includeMetaAds: true,
      channels: { zalo: false, telegram: true, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    assert.equal(mockFetch.getRequests('graph.facebook.com').length, 0);
    assert.ok(
      mockFetch.getRequests('api.telegram.org').length >= 1 || mockFetch.getRequests('script.google.com').length >= 1,
      'CRM daily report must still be delivered when Meta token is missing'
    );
  });

  test('Tier 2.2: Meta Graph 401 OAuthException 190 safely delivers CRM report without crash', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 OAuth 190 Co',
      slug: 'f8-oauth-190',
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: true,
      includeMetaAds: true,
      channels: { zalo: false, telegram: true, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    mockFetch.setFailureMode({
      metaStatus: 401,
      metaErrorCode: 190,
      metaErrorMessage: 'Error validating access token: Session has expired',
    });

    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    assert.ok(
      mockFetch.getRequests('graph.facebook.com').length >= 1,
      'Daily report with Meta Ads ON must attempt Meta Graph API call before OAuth 190 fallback'
    );
    assert.ok(
      mockFetch.getRequests('api.telegram.org').length >= 1 || mockFetch.getRequests('script.google.com').length >= 1,
      'CRM daily report must STILL be delivered even when Meta Graph returns 401 OAuthException 190'
    );
  });

  test('Tier 2.3: Meta Graph 500 Internal Error safely delivers CRM report without crash', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Meta 500 Co',
      slug: 'f8-meta-500',
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: true,
      includeMetaAds: true,
      channels: { zalo: false, telegram: true, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    mockFetch.setFailureMode({ metaStatus: 500, metaErrorCode: 2, metaErrorMessage: 'Meta Internal Error' });

    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    assert.ok(
      mockFetch.getRequests('graph.facebook.com').length >= 1,
      'Daily report with Meta Ads ON must attempt Meta Graph API call before HTTP 500 fallback'
    );
    assert.ok(
      mockFetch.getRequests('api.telegram.org').length >= 1 || mockFetch.getRequests('script.google.com').length >= 1,
      'CRM daily report must still succeed when Meta Graph returns HTTP 500'
    );
  });

  test('Tier 2.4: Empty Ads insights (0 rows) handled cleanly in combined daily report', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Empty Ads Co',
      slug: 'f8-empty-ads',
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: true,
      includeMetaAds: true,
      channels: { zalo: false, telegram: true, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    mockFetch.setFailureMode({ emptyMetaInsights: true });

    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    const outbound = [...mockFetch.getRequests('api.telegram.org'), ...mockFetch.getRequests('script.google.com')];
    assert.ok(outbound.length >= 1, 'Daily report must still deliver cleanly with 0 insights rows');
    assert.ok(!outbound.some((r) => r.body.includes('NaN') || r.body.includes('undefined')), 'Report must not render NaN/undefined');
  });

  test('Tier 2.5: UUID strings in daily_report_admins are preserved verbatim (no NaN from Number() coercion)', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Uuid Admins Co',
      slug: 'f8-uuid-admins',
      managersCount: 1,
    });
    const managerId = ws.users[0].id;
    assert.match(managerId, /^[0-9a-f-]{36}$/i);

    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
      body: {
        daily_report_admins: [ws.adminUserId, managerId],
      },
    });

    const getRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token: ws.adminToken,
      tenantSlug: ws.tenantSlug,
    });
    assert.equal(getRes.status, 200);
    const rawAdmins = getRes.json.data.daily_report_admins;
    const arr = typeof rawAdmins === 'string' ? JSON.parse(rawAdmins) : rawAdmins;
    assert.deepEqual(arr, [ws.adminUserId, managerId]);
    assert.ok(!arr.some((x: any) => x === null || Number.isNaN(x)), 'UUID strings must never be coerced to NaN');
  });

  test('Tier 2.6: daily_report_meta_account_ids filters Meta Ads summary to only selected accounts', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Account Filter Co',
      slug: 'f8-acct-filter',
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: true,
      includeMetaAds: true,
      accountIds: ['act_111222333'],
      channels: { zalo: false, telegram: true, email: false, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    const cronRes = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(cronRes.status, 200);

    const metaReqs = mockFetch.getRequests('graph.facebook.com');
    assert.ok(metaReqs.length >= 1, 'Filtered Meta account must be queried');
    const joined = metaReqs.map((r) => `${r.url} ${r.body}`).join('\n');
    assert.ok(joined.includes('111222333'), 'Selected account act_111222333 must be queried');
    assert.ok(!joined.includes('999888777'), 'Unselected account act_999888777 must NOT be queried');
  });

  test('Tier 2.7: Duplicate same-day daily report cron runs are idempotent (no duplicate spam)', async () => {
    const ws = await seedTenantWorkspace(harness.baseUrl, {
      companyName: 'F8 Cron Idem Co',
      slug: 'f8-cron-idem',
    });

    await seedMetaAdsAndChannels(harness.baseUrl, ws.adminToken, ws.tenantSlug, {
      withMetaToken: false,
      includeMetaAds: false,
      channels: { zalo: false, telegram: true, email: true, discord: false },
      adminUserIds: [ws.adminUserId],
    });

    mockFetch.clearRequests();
    const run1 = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(run1.status, 200);
    const countAfterRun1 =
      mockFetch.getRequests('api.telegram.org').length + mockFetch.getRequests('script.google.com').length;
    assert.ok(countAfterRun1 >= 1, 'First cron tick must dispatch daily report');

    mockFetch.clearRequests();
    const run2 = await triggerMasterCronHttp(harness.baseUrl, { subroutines: ['daily_report'], tenantId: ws.tenantId });
    assert.equal(run2.status, 200);
    const countAfterRun2 =
      mockFetch.getRequests('api.telegram.org').length + mockFetch.getRequests('script.google.com').length;
    assert.equal(countAfterRun2, 0, 'Second same-day cron tick must NOT re-send duplicate daily report');
  });
});
