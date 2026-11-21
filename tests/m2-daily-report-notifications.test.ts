import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import {
  DEFAULT_TENANT_SETTINGS,
  normalizeTenantSettings,
} from '../server/core/settings/tenant-settings.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import {
  getTelegramConfig,
  resolveTenantTelegramConfig,
  setTelegramTransportForTesting,
} from '../server/services/telegram.service.ts';
import { ingestAndDistributeLead } from '../server/services/distribution.service.ts';
import {
  sendDiscordNotification,
  sendRawSmtpMail,
  sendTenantEmailNotification,
  sendZaloBotNotification,
  setDiscordTransportForTesting,
  setEmailWebhookFetcherForTesting,
  setSmtpTransportForTesting,
  setZaloBotTransportForTesting,
  stripHtmlTagsForPlainText,
} from '../server/services/zalo-mail.service.ts';
import {
  compileTenantCrmReportMetrics,
  dispatchTenantDailyReportChannels,
  fetchTenantMetaAdsDailySummary,
  formatDailyReportBotMessages,
  formatDailyReportEmail,
  resolveReportWindow,
} from '../server/services/daily-report.service.ts';
import { runDailyReportWorker } from '../server/cron/subroutines/daily-report.ts';
import { setDomMetaExternalFetcherForTesting, clearDomMetaGraphCacheForTesting } from '../server/services/dom-meta-report.service.ts';

function startMockSmtpServer(): Promise<{
  port: number;
  commands: string[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const commands: string[] = [];
    const srv = net.createServer((socket) => {
      let buf = '';
      let inData = false;
      socket.write('220 localhost ESMTP MockSMTP\r\n');
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        while (true) {
          if (inData) {
            const endIdx = buf.indexOf('\r\n.\r\n');
            if (endIdx === -1) break;
            const body = buf.slice(0, endIdx);
            commands.push(`DATA_BODY:${body.length}`);
            buf = buf.slice(endIdx + 5);
            inData = false;
            socket.write('250 2.0.0 Ok: queued as mock_smtp_id\r\n');
            continue;
          }
          const nlIdx = buf.indexOf('\r\n');
          if (nlIdx === -1) break;
          const line = buf.slice(0, nlIdx);
          buf = buf.slice(nlIdx + 2);
          commands.push(line);
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (upper.startsWith('AUTH PLAIN')) {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (upper.startsWith('MAIL FROM:')) {
            socket.write('250 2.1.0 Ok\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            socket.write('250 2.1.5 Ok\r\n');
          } else if (upper === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 Ok\r\n');
          }
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        commands,
        close: () => new Promise((res) => srv.close(() => res())),
      });
    });
  });
}

describe('M2: Notification Senders, Settings Preservation & Combined CRM + Meta Ads Daily Report', () => {
  let harness: TestHarness;
  let adminToken = '';
  let tenantId = '';
  let tenantSlug = 'm2-notify-corp';
  let adminId = '';
  let saleId = '';

  before(async () => {
    harness = await startTestServer();
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M2 Notify Corp',
        tenant_slug: tenantSlug,
        admin_name: 'M2 Admin',
        work_email: 'admin@m2notify.vn',
        phone: '0909111222',
        password: 'AdminPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
        initial_sales: [
          {
            full_name: 'Sale An',
            email: 'an@m2notify.vn',
            phone: '0909333444',
            role: 'sale',
            receive_ratio: 1,
            is_available: true,
          },
        ],
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;
    adminId = reg.json.data.user?.id || reg.json.data.admin?.id || '';
    if (!adminId) {
      const meRes = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
        token: adminToken,
        tenantSlug,
      });
      adminId = meRes.json.data?.id || '';
    }
    saleId = reg.json.data.initial_sales?.[0]?.id || '';
    if (!saleId) {
      const usersRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
        token: adminToken,
        tenantSlug,
      });
      const list = usersRes.json.data?.items || usersRes.json.data || [];
      const foundSale = Array.isArray(list) ? list.find((u: any) => u.role === 'sale') : null;
      if (foundSale?.id) {
        saleId = foundSale.id;
      } else {
        const createSale = await apiRequest(harness.baseUrl, '/api/v1/users', {
          method: 'POST',
          token: adminToken,
          tenantSlug,
          body: {
            full_name: 'Sale An',
            email: 'an.fallback@m2notify.vn',
            phone: '0909333445',
            password: 'SalePassword123!',
            role: 'sale',
          },
        });
        saleId = createSale.json.data?.id || '';
      }
    }
    assert.ok(adminId && saleId, `Missing adminId=${adminId} or saleId=${saleId}`);
  });

  after(async () => {
    setTelegramTransportForTesting(null);
    setSmtpTransportForTesting(null);
    setEmailWebhookFetcherForTesting(null);
    setZaloBotTransportForTesting(null);
    setDiscordTransportForTesting(null);
    setDomMetaExternalFetcherForTesting(null);
    clearDomMetaGraphCacheForTesting();
    await harness.close();
  });

  beforeEach(() => {
    setTelegramTransportForTesting(null);
    setSmtpTransportForTesting(null);
    setEmailWebhookFetcherForTesting(null);
    setZaloBotTransportForTesting(null);
    setDiscordTransportForTesting(null);
    setDomMetaExternalFetcherForTesting(null);
    clearDomMetaGraphCacheForTesting();
  });

  it('1. TenantSettings defaults daily_report_include_meta_ads === false and preserves string UUID admins', () => {
    assert.equal(DEFAULT_TENANT_SETTINGS.daily_report_include_meta_ads, false);
    assert.deepEqual(DEFAULT_TENANT_SETTINGS.daily_report_meta_ads_metrics, [
      'results',
      'leads',
      'messages',
      'reach',
      'spend',
      'peak_hours',
    ]);
    assert.deepEqual(DEFAULT_TENANT_SETTINGS.daily_report_channels, {
      zalo: false,
      telegram: false,
      email: false,
      discord: false,
    });

    const uuid1 = 'a1111111-2222-3333-4444-555555555555';
    const uuid2 = 'b6666666-7777-8888-9999-000000000000';
    const normalized = normalizeTenantSettings({
      zalo_notify_only_group: '1',
      zalo_monthly_report_enabled: '0',
      daily_report_include_meta_ads: '1',
      daily_report_admins: JSON.stringify([uuid1, uuid2, 'null', 'NaN', '', uuid1]),
      daily_report_meta_account_ids: ['act_111222333', 'act_111222333'],
      zalo_weekly_report_day: 'FRI',
      zalo_admin_group_chat_id: '',
    });

    assert.equal(normalized.zalo_notify_only_group, true);
    assert.equal(normalized.zalo_monthly_report_enabled, false);
    assert.equal(normalized.daily_report_include_meta_ads, true);
    assert.deepEqual(normalized.daily_report_admins, [uuid1, uuid2]);
    assert.deepEqual(normalized.daily_report_meta_account_ids, ['act_111222333']);
    assert.equal(normalized.zalo_weekly_report_day, 'fri');
    assert.equal(normalized.zalo_admin_group_chat_id, '');
  });

  it('2. PATCH /auth/tenant-settings preserves operational keys (appscript, resend, discord, _daily_report_sent_date)', async () => {
    const saveLegacy = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        email_provider: 'resend',
        appscript_webhook_url: 'https://script.google.com/macros/s/AKfycbPreserve/exec',
        resend_api_key: 're_preserve_123',
        discord_webhook_url: 'https://discord.com/api/webhooks/999/preserve',
        daily_report_admins: [adminId, saleId],
        daily_report_include_meta_ads: false,
      },
    });
    assert.equal(saveLegacy.status, 200);

    const patchRes = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        settings: {
          brand_display_name: 'M2 Patched Brand',
        },
      },
    });
    assert.equal(patchRes.status, 200);

    const getRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.json.data.brand_display_name, 'M2 Patched Brand');
    assert.equal(getRes.json.data.email_provider, 'resend');
    assert.equal(getRes.json.data.appscript_webhook_url, 'https://script.google.com/macros/s/AKfycbPreserve/exec');
    assert.equal(getRes.json.data.discord_webhook_url, 'https://discord.com/api/webhooks/999/preserve');
    assert.equal(getRes.json.data.daily_report_include_meta_ads, false);
    assert.deepEqual(JSON.parse(getRes.json.data.daily_report_admins), [adminId, saleId]);
  });

  it('3. distribution.service & telegram.service honor Tenant Vault Telegram config when env var is unset', async () => {
    const saveTg = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/config', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        bot_token: 'vault_bot_token_999',
        chat_id: '-100vault999',
        silent_mode: false,
        enabled: true,
      },
    });
    assert.equal(saveTg.status, 200);

    const prevSilent = process.env.TELEGRAM_SILENT_MODE;
    const prevEnabled = process.env.TELEGRAM_NOTIFY_ENABLED;
    delete process.env.TELEGRAM_SILENT_MODE;
    delete process.env.TELEGRAM_NOTIFY_ENABLED;

    const captured: Array<{ chatId: string; text: string }> = [];
    setTelegramTransportForTesting(async (p) => {
      captured.push({ chatId: p.chatId, text: p.text });
      return { message_id: 7771, ok: true };
    });

    try {
      const resolved = await resolveTenantTelegramConfig(tenantId);
      assert.equal(resolved.config.silentMode, false);
      assert.equal(resolved.config.enabled, true);
      assert.equal(resolved.config.botToken, 'vault_bot_token_999');
      assert.equal(resolved.config.chatId, '-100vault999');

      // Kill switch overrides Vault
      process.env.TELEGRAM_SILENT_MODE = 'true';
      assert.equal(getTelegramConfig(resolved.vaultConfig).silentMode, true);
      delete process.env.TELEGRAM_SILENT_MODE;

      const outcome = await ingestAndDistributeLead(tenantId, {
        name: 'Lead Telegram Vault',
        phone: '0919888777',
        source: 'Facebook',
      });
      assert.equal(outcome.status, 'assigned');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(captured.length, 1);
      assert.equal(captured[0].chatId, '-100vault999');
    } finally {
      if (prevSilent !== undefined) process.env.TELEGRAM_SILENT_MODE = prevSilent;
      else delete process.env.TELEGRAM_SILENT_MODE;
      if (prevEnabled !== undefined) process.env.TELEGRAM_NOTIFY_ENABLED = prevEnabled;
      else delete process.env.TELEGRAM_NOTIFY_ENABLED;
    }
  });

  it('4. Outbound Zalo Bot & Discord senders chunk >2000 chars, strip HTML for Zalo, and fail loudly on missing/HTTP error', async () => {
    const origFetch = globalThis.fetch;
    const prevSilent = process.env.OUTBOUND_SILENT_MODE;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.OUTBOUND_SILENT_MODE = 'false';
    process.env.NODE_ENV = 'development';

    const calls: Array<{ url: string; body: any }> = [];
    let forceZaloFail = false;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('bot-api.zaloplatforms.com') || url.includes('discord.com')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });
        if (forceZaloFail && url.includes('zaloplatforms')) {
          return new Response(JSON.stringify({ ok: false, error: -1, description: 'Invalid bot token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, error: 0, id: 'disc_1', result: { message_id: 'z_1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      // Missing credentials must NEVER return success: true
      const missingZalo = await sendZaloBotNotification(null, 'Hello', { silentOverride: false });
      assert.equal(missingZalo.success, false);
      const missingDiscord = await sendDiscordNotification(null, 'Hello', { silentOverride: false });
      assert.equal(missingDiscord.success, false);

      // Long message chunking + HTML stripping for Zalo Bot
      const longMsg = `<b>Header</b>\n${Array.from({ length: 60 }, (_, i) => `Line ${i}: 1234567890123456789012345678901234567890`).join('\n')}`;
      const zOk = await sendZaloBotNotification(null, longMsg, {
        botToken: 'z_tok_test',
        chatId: 'z_chat_test',
        silentOverride: false,
      });
      assert.equal(zOk.success, true);
      const zaloCalls = calls.filter((c) => c.url.includes('bot-api.zaloplatforms.com/botz_tok_test/sendMessage'));
      assert.ok(zaloCalls.length >= 2, 'Long Zalo message must be chunked');
      assert.ok(!zaloCalls[0].body.text.includes('<b>'), 'Zalo plain text must strip HTML tags');

      // Discord chunking + wait=true
      const dOk = await sendDiscordNotification(null, longMsg, {
        webhookUrl: 'https://discord.com/api/webhooks/111/abc',
        silentOverride: false,
      });
      assert.equal(dOk.success, true);
      const discCalls = calls.filter((c) => c.url.includes('discord.com/api/webhooks/111/abc?wait=true'));
      assert.ok(discCalls.length >= 2, 'Long Discord message must be chunked');

      // HTTP error must return success: false
      forceZaloFail = true;
      const zErr = await sendZaloBotNotification(null, 'Fail test', {
        botToken: 'z_tok_test',
        chatId: 'z_chat_test',
        silentOverride: false,
      });
      assert.equal(zErr.success, false);
    } finally {
      globalThis.fetch = origFetch;
      if (prevSilent !== undefined) process.env.OUTBOUND_SILENT_MODE = prevSilent;
      else delete process.env.OUTBOUND_SILENT_MODE;
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });

  it('5. Email drivers dispatch Resend (without AppScript hijack), pure-Node SMTP, AWS SES SigV4, and reject unconfigured sends', async () => {
    const httpCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    setEmailWebhookFetcherForTesting(async (url, init) => {
      httpCalls.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ id: 'email_mock_id_1', MessageId: 'ses_msg_1', success: true }),
      };
    });

    // 5a. Resend selected even though appscript_webhook_url is saved!
    const resendRes = await sendTenantEmailNotification({
      tenantId,
      to: 'ceo@m2notify.vn',
      subject: 'M2 Resend Test',
      text: 'Hello Resend',
      category: 'daily_report',
      overrideProvider: 'resend',
    });
    assert.equal(resendRes?.sent, true);
    assert.equal(resendRes?.provider, 'resend');
    assert.equal(httpCalls[0].url, 'https://api.resend.com/emails');
    assert.equal(httpCalls[0].headers.Authorization, 'Bearer re_preserve_123');

    // 5b. Unconfigured / empty-override Resend returns sent: false (never falls back to stored key or silent { sent: true })
    setEmailWebhookFetcherForTesting(null);
    const badResend = await sendTenantEmailNotification({
      tenantId,
      to: 'ceo@m2notify.vn',
      subject: 'No Key',
      text: 'No Key',
      overrideProvider: 'resend',
      overrideSecret: '',
    });
    assert.equal(badResend?.sent, false);
    assert.equal(badResend?.provider, 'resend');

    const badSes = await sendTenantEmailNotification({
      tenantId,
      to: 'ceo@m2notify.vn',
      subject: 'No SES',
      text: 'No SES',
      overrideProvider: 'ses',
    });
    assert.equal(badSes?.sent, false);
    assert.equal(badSes?.provider, 'ses');

    // 5c. Unconfigured SMTP returns sent: false (does NOT fall back to silent { sent: true })
    const badSmtp = await sendTenantEmailNotification({
      tenantId,
      to: 'ceo@m2notify.vn',
      subject: 'No SMTP',
      text: 'No SMTP',
      overrideProvider: 'smtp',
    });
    assert.equal(badSmtp?.sent, false);
    assert.equal(badSmtp?.provider, 'smtp');

    // 5d. AWS SES SigV4 headers verified via mock fetcher
    const saveSesVault = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/aws_ses', {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: {
        sesRegion: 'ap-southeast-1',
        authUser: 'AKIA_M2_TEST',
        apiKey: 'SECRET_M2_TEST_KEY',
        from_email: 'noreply@m2notify.vn',
      },
    });
    assert.equal(saveSesVault.status, 200);

    httpCalls.length = 0;
    setEmailWebhookFetcherForTesting(async (url, init) => {
      httpCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ MessageId: 'ses_v2_999' }),
      };
    });

    const sesRes = await sendTenantEmailNotification({
      tenantId,
      to: 'ceo@m2notify.vn',
      subject: 'M2 SES SigV4 Test',
      text: 'Hello SES',
      overrideProvider: 'ses',
    });
    assert.equal(sesRes?.sent, true);
    assert.equal(sesRes?.provider, 'ses');
    assert.equal(sesRes?.smtpHost, 'email.ap-southeast-1.amazonaws.com');
    assert.equal(httpCalls[0].url, 'https://email.ap-southeast-1.amazonaws.com/v2/email/outbound-emails');
    assert.match(httpCalls[0].headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIA_M2_TEST\//);
    assert.ok(httpCalls[0].headers['X-Amz-Date']);
    assert.ok(httpCalls[0].headers['X-Amz-Content-Sha256']);

    // 5e. Pure-Node SMTP driver against real ephemeral node:net server
    setEmailWebhookFetcherForTesting(null);
    const mockSmtp = await startMockSmtpServer();
    try {
      const smtpDirect = await sendRawSmtpMail({
        host: '127.0.0.1',
        port: mockSmtp.port,
        user: 'smtp_user@m2notify.vn',
        pass: 'smtp_pass_123',
        fromEmail: 'noreply@m2notify.vn',
        fromName: 'M2 Notify',
        to: 'ceo@m2notify.vn',
        subject: 'Báo cáo SMTP UTF-8',
        text: 'Xin chào SMTP',
        html: '<p>Xin chào SMTP</p>',
      });
      assert.equal(smtpDirect.accepted, true, `SMTP error: ${smtpDirect.error}`);
      assert.ok(mockSmtp.commands.some((c) => c.startsWith('AUTH PLAIN')));
      assert.ok(mockSmtp.commands.includes('MAIL FROM:<noreply@m2notify.vn>'));
      assert.ok(mockSmtp.commands.includes('RCPT TO:<ceo@m2notify.vn>'));
      assert.ok(mockSmtp.commands.some((c) => c.startsWith('DATA_BODY:')));
    } finally {
      await mockSmtp.close();
    }
  });

  it('6. Daily Report Service compiles CRM KPIs, enforces Meta Ads OFF default, filters accounts, and degrades safely on Graph errors', async () => {
    const cfgOff = normalizeTenantSettings({
      daily_report_admins: [adminId],
      daily_report_include_meta_ads: false,
    });
    const window = resolveReportWindow('daily', 'Asia/Ho_Chi_Minh');

    // Seed a closed lead for metrics verification
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, name, phone, source, status, assigned_to, is_accepted, accepted_at,
           sla_breached, quality_status, total_revenue_vnd, created_at
         ) VALUES ($1, $2, 'Lead Closed M2', '84908000111', 'Meta Ads', 'assigned', $3, true, clock_timestamp(), false, 'Closed', 25000000, clock_timestamp())`,
        [crypto.randomUUID(), tenantId, saleId]
      );
    });

    const crm = await withTenantTransaction(tenantId, (client) =>
      compileTenantCrmReportMetrics(client, tenantId, window, cfgOff)
    );
    assert.ok(crm.totalNewLeads >= 1);
    assert.ok(crm.closedCount >= 1);
    assert.ok(crm.pipelineRevenueVnd >= 25_000_000);
    assert.equal(crm.adminRecipients.length, 1);
    assert.equal(crm.adminRecipients[0].id, adminId);

    // OFF -> returns null without touching Graph
    const metaOff = await fetchTenantMetaAdsDailySummary(tenantId, window, cfgOff, {
      allowGraphInSilentMode: true,
    });
    assert.equal(metaOff, null);

    // Connect two Meta accounts and enable Meta Ads with filter to act_111222333
    const connectRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/connect-batch', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        access_token: 'EAA_M2_UNIT_META_TOKEN_123456789012345',
        accounts: [
          { ad_account_id: 'act_111222333', name: 'Primary M2' },
          { ad_account_id: 'act_999888777', name: 'Secondary M2' },
        ],
      },
    });
    assert.ok(connectRes.status === 200 || connectRes.status === 201);

    const fetchedUrls: string[] = [];
    setDomMetaExternalFetcherForTesting(async (url) => {
      fetchedUrls.push(url);
      const isHourly = url.includes('hourly_stats');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: isHourly
            ? [
                {
                  hourly_stats_aggregated_by_audience_time_zone: '20:00:00 - 20:59:59',
                  spend: '780000',
                  actions: [
                    { action_type: 'lead', value: '19' },
                    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '31' },
                  ],
                },
              ]
            : [
                {
                  spend: '1230000',
                  impressions: '23600',
                  reach: '19000',
                  clicks: '650',
                  actions: [
                    { action_type: 'lead', value: '27' },
                    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '45' },
                  ],
                },
              ],
        }),
      };
    });

    const cfgOn = normalizeTenantSettings({
      daily_report_admins: [adminId],
      daily_report_include_meta_ads: true,
      daily_report_meta_account_ids: ['act_111222333'],
    });
    const metaOn = await fetchTenantMetaAdsDailySummary(tenantId, window, cfgOn, {
      allowGraphInSilentMode: true,
      skipCache: true,
    });
    assert.equal(metaOn?.available, true);
    assert.equal(metaOn?.spend, 1_230_000);
    assert.equal(metaOn?.reach, 19_000);
    assert.equal(metaOn?.leads, 27);
    assert.equal(metaOn?.messages, 45);
    assert.equal(metaOn?.results, 72);
    assert.equal(metaOn?.peakHours[0]?.hour, '20:00');
    assert.ok(fetchedUrls.some((u) => u.includes('act_111222333')));
    assert.ok(!fetchedUrls.some((u) => u.includes('act_999888777')));

    const formattedBot = formatDailyReportBotMessages(
      { tenantId, tenantName: 'M2 Notify Corp', tenantSlug, brandName: 'M2 Notify Corp', window, crm, metaAds: metaOn },
      cfgOn
    );
    assert.ok(formattedBot.telegramHtml.includes('1,230,000'));
    assert.ok(formattedBot.telegramHtml.includes('20:00'));

    const formattedEmail = formatDailyReportEmail(
      { tenantId, tenantName: 'M2 Notify Corp', tenantSlug, brandName: 'M2 Notify Corp', window, crm, metaAds: metaOn },
      cfgOn
    );
    assert.ok(!formattedEmail.html.includes('NaN') && !formattedEmail.html.includes('undefined'));

    // Safe degradation on OAuth 190
    setDomMetaExternalFetcherForTesting(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Session expired', code: 190 } }),
    }));
    const metaDegraded = await fetchTenantMetaAdsDailySummary(tenantId, window, cfgOn, {
      allowGraphInSilentMode: true,
      skipCache: true,
    });
    assert.equal(metaDegraded?.available, false);
    assert.ok(metaDegraded?.warning && metaDegraded.warning.includes('Session expired'), `Expected OAuth 190 warning, got: ${metaDegraded?.warning}`);
    const degradedBot = formatDailyReportBotMessages(
      { tenantId, tenantName: 'M2 Notify Corp', tenantSlug, brandName: 'M2 Notify Corp', window, crm, metaAds: metaDegraded },
      cfgOn
    );
    assert.ok(!degradedBot.plainText.includes('NaN') && !degradedBot.plainText.includes('undefined'));
  });

  it('7. runDailyReportWorker enforces same-day idempotency and skips suspended tenants', async () => {
    const zp = getVnNowHm();
    const sentZalo: string[] = [];
    setZaloBotTransportForTesting(async (p) => {
      sentZalo.push(p.chatId);
      return { messageId: 'z_worker_1', ok: true };
    });

    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        zalo_daily_report_time: zp,
        zalo_admin_group_chat_id: 'grp_m2_worker',
        zalo_notify_only_group: '1',
        daily_report_channels: { zalo: true, telegram: false, email: false, discord: false },
        daily_report_include_meta_ads: false,
      },
    });

    const firstCount = await runDailyReportWorker(tenantId);
    assert.equal(firstCount, 1);
    assert.deepEqual(sentZalo, ['grp_m2_worker']);

    // Second run same day -> 0 dispatches
    const secondCount = await runDailyReportWorker(tenantId);
    assert.equal(secondCount, 0);
    assert.equal(sentZalo.length, 1);

    // Suspended tenant -> skipped even if marker cleared
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(`UPDATE tenants SET status = 'suspended', settings = settings - '_daily_report_sent_date' WHERE id = $1`, [tenantId]);
    });
    tenantRedis.invalidateTenantCache(tenantId, tenantSlug);
    const suspCount = await runDailyReportWorker(tenantId);
    assert.equal(suspCount, 0);
  });

  it('8. Multi-CC daily report splits recipients cleanly across SMTP, Resend, and AWS SES v2', async () => {
    const ccSlug = `m2-multicc-${Date.now()}`;
    const regCc = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M2 MultiCC Corp',
        tenant_slug: ccSlug,
        admin_name: 'CC Admin',
        work_email: 'ccadmin@ccprobe.vn',
        phone: '0909777888',
        password: 'AdminPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regCc.status, 201);
    const ccToken = regCc.json.data.access_token;
    const ccTenantId = regCc.json.data.tenant.id;

    const mockSmtp = await startMockSmtpServerStrictNoComma();
    const webhookCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const prevSilent = process.env.OUTBOUND_SILENT_MODE;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.OUTBOUND_SILENT_MODE = 'false';
    process.env.NODE_ENV = 'development';

    try {
      const window = resolveReportWindow('daily', 'Asia/Ho_Chi_Minh');
      const cfgEmail = normalizeTenantSettings({
        daily_report_channels: { zalo: false, telegram: false, email: true, discord: false },
      });
      const payload = {
        tenantId: ccTenantId,
        tenantName: 'M2 MultiCC Corp',
        tenantSlug: ccSlug,
        brandName: 'M2 MultiCC Corp',
        window,
        crm: {
          totalNewLeads: 1,
          assignedLeads: 1,
          unassignedPending: 0,
          duplicateLeads: 0,
          acceptedCount: 1,
          slaBreachedCount: 0,
          slaCompliancePct: 100,
          avgResponseSeconds: 10,
          qualifiedCount: 1,
          bookedCount: 0,
          bookingCount: 0,
          depositedCount: 0,
          closedCount: 0,
          badtimingCount: 0,
          noAnswerCount: 0,
          notleadCount: 0,
          unratedCount: 0,
          pipelineRevenueVnd: 0,
          conversionRatePct: 0,
          ticketsPending: 0,
          ticketsApproved: 0,
          ticketsRejected: 0,
          bySale: [],
          adminRecipients: [
            { id: 'u1', fullName: 'A1', email: 'a1@ccprobe.vn', zaloChatId: null },
            { id: 'u2', fullName: 'A2', email: 'a2@ccprobe.vn', zaloChatId: null },
            { id: 'u3', fullName: 'A3', email: 'a3@ccprobe.vn', zaloChatId: null },
          ],
        },
        metaAds: null,
      };

      // 8a. SMTP strict server rejecting comma in RCPT TO
      const smtpSettings = {
        email_provider: 'smtp',
        ses_host: '127.0.0.1',
        ses_port: mockSmtp.port,
        ses_sender_email: 'noreply@ccprobe.vn',
      };
      await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
        method: 'POST',
        token: ccToken,
        tenantSlug: ccSlug,
        body: smtpSettings,
      });
      const smtpMulti = await dispatchTenantDailyReportChannels({
        payload,
        cfg: cfgEmail,
        rawSettings: smtpSettings,
      });
      assert.deepEqual(smtpMulti.channelsDelivered, ['email'], `SMTP multi-CC errors: ${smtpMulti.errors.join('; ')}`);
      const rcptCmds = mockSmtp.commands.filter((c) => c.startsWith('RCPT TO:'));
      assert.deepEqual(rcptCmds, ['RCPT TO:<a1@ccprobe.vn>', 'RCPT TO:<a2@ccprobe.vn>', 'RCPT TO:<a3@ccprobe.vn>']);
      assert.ok(mockSmtp.dataHeaders.some((h) => h === 'Cc: a2@ccprobe.vn, a3@ccprobe.vn'));

      // 8b. Resend receives split cc array
      setEmailWebhookFetcherForTesting(async (url, init) => {
        webhookCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ id: 'resend_cc_ok' }),
        };
      });
      const resendSettings = {
        email_provider: 'resend',
        resend_api_key: 're_multi_cc_key',
      };
      await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
        method: 'POST',
        token: ccToken,
        tenantSlug: ccSlug,
        body: resendSettings,
      });
      const resendMulti = await dispatchTenantDailyReportChannels({
        payload,
        cfg: cfgEmail,
        rawSettings: resendSettings,
      });
      assert.deepEqual(resendMulti.channelsDelivered, ['email'], `Resend errors: ${resendMulti.errors.join('; ')}`);
      assert.deepEqual(webhookCalls[0].body.cc, ['a2@ccprobe.vn', 'a3@ccprobe.vn']);

      // 8c. AWS SES v2 receives split CcAddresses array
      webhookCalls.length = 0;
      const sesSettings = {
        email_provider: 'ses',
        ses_host: '',
        ses_username: 'AKIA_MULTI',
        ses_password: 'SECRET_MULTI',
        ses_sender_email: 'noreply@ccprobe.vn',
      };
      await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
        method: 'POST',
        token: ccToken,
        tenantSlug: ccSlug,
        body: sesSettings,
      });
      const sesMulti = await dispatchTenantDailyReportChannels({
        payload,
        cfg: cfgEmail,
        rawSettings: sesSettings,
      });
      assert.deepEqual(sesMulti.channelsDelivered, ['email'], `SES errors: ${sesMulti.errors.join('; ')}`);
      assert.deepEqual(webhookCalls[0].body.Destination.CcAddresses, ['a2@ccprobe.vn', 'a3@ccprobe.vn']);
    } finally {
      await mockSmtp.close();
      setEmailWebhookFetcherForTesting(null);
      if (prevSilent !== undefined) process.env.OUTBOUND_SILENT_MODE = prevSilent;
      else delete process.env.OUTBOUND_SILENT_MODE;
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });

  it('9. Never leaks SMTP Vault password to Resend, and honors rawSettings.ses_port in SES SMTP mode', async () => {
    const cleanSlug = `m2-isolation-${Date.now()}`;
    const regClean = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M2 Isolation Corp',
        tenant_slug: cleanSlug,
        admin_name: 'Iso Admin',
        work_email: 'iso@m2notify.vn',
        phone: '0909555666',
        password: 'AdminPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regClean.status, 201);
    const cleanToken = regClean.json.data.access_token;
    const cleanTenantId = regClean.json.data.tenant.id;

    // Save Vault SMTP password ONLY (no resend_api_key)
    const vaultSmtp = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/smtp', {
      method: 'PUT',
      token: cleanToken,
      tenantSlug: cleanSlug,
      body: {
        host: '127.0.0.1',
        port: 2525,
        user: 'smtp_iso_user',
        pass: 'SUPER_SECRET_SMTP_PASS',
        from_email: 'noreply@iso.vn',
      },
    });
    assert.equal(vaultSmtp.status, 200);

    let resendRequests = 0;
    setEmailWebhookFetcherForTesting(async () => {
      resendRequests += 1;
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const prevResendEnv = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const leakCheck = await sendTenantEmailNotification({
        tenantId: cleanTenantId,
        to: 'target@iso.vn',
        subject: 'No Leak',
        text: 'No Leak',
        overrideProvider: 'resend',
      });
      assert.equal(leakCheck?.sent, false);
      assert.equal(leakCheck?.provider, 'resend');
      assert.equal(resendRequests, 0, 'SMTP Vault password must NEVER be sent to api.resend.com');
    } finally {
      if (prevResendEnv !== undefined) process.env.RESEND_API_KEY = prevResendEnv;
      setEmailWebhookFetcherForTesting(null);
    }

    // SES SMTP mode honors rawSettings.ses_port
    const mockSmtp = await startMockSmtpServerStrictNoComma();
    const prevSilent = process.env.OUTBOUND_SILENT_MODE;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.OUTBOUND_SILENT_MODE = 'false';
    process.env.NODE_ENV = 'development';
    try {
      await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
        method: 'POST',
        token: cleanToken,
        tenantSlug: cleanSlug,
        body: {
          email_provider: 'ses',
          ses_host: '127.0.0.1',
          ses_port: mockSmtp.port,
          ses_username: 'ses_smtp_user',
          ses_password: 'ses_smtp_password',
          ses_sender_email: 'noreply@iso.vn',
        },
      });
      const sesSmtpRes = await sendTenantEmailNotification({
        tenantId: cleanTenantId,
        to: 'target@iso.vn',
        subject: 'SES Custom Port',
        text: 'SES Custom Port Body',
      });
      assert.equal(sesSmtpRes?.sent, true, `Expected SES SMTP on custom port ${mockSmtp.port}, got: ${sesSmtpRes?.error}`);
      assert.ok(mockSmtp.commands.includes('RCPT TO:<target@iso.vn>'));
    } finally {
      await mockSmtp.close();
      if (prevSilent !== undefined) process.env.OUTBOUND_SILENT_MODE = prevSilent;
      else delete process.env.OUTBOUND_SILENT_MODE;
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });

  it('10. Non-UUID daily_report_admins do not crash SQL and weekly window handles UTC>=+12 & Monday prior week', async () => {
    const window = resolveReportWindow('daily', 'Asia/Ho_Chi_Minh');
    const cfgMixed = normalizeTenantSettings({
      daily_report_admins: ['legacy-non-uuid-admin', adminId],
    });
    const crmMixed = await withTenantTransaction(tenantId, (client) =>
      compileTenantCrmReportMetrics(client, tenantId, window, cfgMixed)
    );
    assert.equal(crmMixed.adminRecipients.length, 1);
    assert.equal(crmMixed.adminRecipients[0].id, adminId);

    const cfgLegacyOnly = normalizeTenantSettings({
      daily_report_admins: ['legacy-only-admin'],
    });
    const crmLegacyOnly = await withTenantTransaction(tenantId, (client) =>
      compileTenantCrmReportMetrics(client, tenantId, window, cfgLegacyOnly)
    );
    assert.equal(crmLegacyOnly.adminRecipients.length, 0);

    // Pacific/Kiritimati (+14:00) Friday 2026-11-20 19:00 local -> Monday 2026-11-16
    const kiritimati = resolveReportWindow('weekly', 'Pacific/Kiritimati', new Date('2026-11-20T05:00:00.000Z'));
    assert.equal(kiritimati.sinceYmd, '2026-11-16');
    assert.equal(kiritimati.untilYmd, '2026-11-20');

    // Monday 2026-11-23 09:00 VN -> prior completed Mon-Sun week (2026-11-16 .. 2026-11-22)
    const mondayPrior = resolveReportWindow('weekly', 'Asia/Ho_Chi_Minh', new Date('2026-11-23T02:00:00.000Z'));
    assert.equal(mondayPrior.sinceYmd, '2026-11-16');
    assert.equal(mondayPrior.untilYmd, '2026-11-22');
    assert.equal(mondayPrior.runKey, 'weekly:2026-W47');
  });

  it('11. Transient channel failure rolls back marker so same-day cron retries cleanly', async () => {
    const zp = getVnNowHm();
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE tenants SET status = 'active', settings = settings - '_daily_report_sent_date' WHERE id = $1`,
        [tenantId]
      );
      await client.query(`DELETE FROM tenant_cron_runs WHERE tenant_id = $1 AND subroutine_key = 'daily_report'`, [tenantId]);
    });
    tenantRedis.invalidateTenantCache(tenantId, tenantSlug);

    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        zalo_daily_report_time: zp,
        zalo_admin_group_chat_id: 'grp_m2_retry',
        zalo_notify_only_group: '1',
        daily_report_channels: { zalo: true, telegram: false, email: false, discord: false },
      },
    });

    // Attempt 1: transient Zalo failure
    let shouldFail = true;
    const delivered: string[] = [];
    setZaloBotTransportForTesting(async (p) => {
      if (shouldFail) throw new Error('Transient Zalo 500');
      delivered.push(p.chatId);
      return { messageId: 'z_retry_ok', ok: true };
    });

    const firstAttempt = await runDailyReportWorker(tenantId);
    assert.equal(firstAttempt, 0);

    // Attempt 2: outage resolved -> same-day retry succeeds
    shouldFail = false;
    const secondAttempt = await runDailyReportWorker(tenantId);
    assert.equal(secondAttempt, 1);
    assert.deepEqual(delivered, ['grp_m2_retry']);
  });

  it('12. Minor polish checks: HTML tag stripper preserves < >, case-insensitive bools, masked secret preservation, Telegram string bools', async () => {
    assert.equal(
      stripHtmlTagsForPlainText('Doanh thu < 500tr và > 100tr <b>OK</b>'),
      'Doanh thu < 500tr và > 100tr OK'
    );

    const tgCfg = getTelegramConfig({
      bot_token: 'tok',
      chat_id: '123',
      silent_mode: 'false' as any,
      enabled: 'true' as any,
    });
    const prevSilent = process.env.TELEGRAM_SILENT_MODE;
    const prevEnabled = process.env.TELEGRAM_NOTIFY_ENABLED;
    delete process.env.TELEGRAM_SILENT_MODE;
    delete process.env.TELEGRAM_NOTIFY_ENABLED;
    try {
      const tgParsed = getTelegramConfig({
        bot_token: 'tok',
        chat_id: '123',
        silent_mode: 'false' as any,
        enabled: 'false' as any,
      });
      assert.equal(tgParsed.silentMode, false);
      assert.equal(tgParsed.enabled, false);
      assert.equal(tgCfg.botToken, 'tok');
    } finally {
      if (prevSilent !== undefined) process.env.TELEGRAM_SILENT_MODE = prevSilent;
      if (prevEnabled !== undefined) process.env.TELEGRAM_NOTIFY_ENABLED = prevEnabled;
    }

    // Case-insensitive legacy bool + masked secret preservation across PATCH /tenant-settings & /myerp/settings
    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        daily_report_include_meta_ads: 'TRUE',
        resend_api_key: 're_keep_secret_999',
        ses_password: 'ses_keep_secret_999',
      },
    });
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        settings: {
          resend_api_key: '••••••••',
          ses_password: '••••••••',
        },
      },
    });
    const checkRaw = await withTenantTransaction(tenantId, async (client) => {
      const r = await client.query<{ settings: Record<string, any> }>('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
      return r.rows[0].settings;
    });
    assert.equal(checkRaw.daily_report_include_meta_ads, true);
    assert.equal(checkRaw.resend_api_key, 're_keep_secret_999');
    assert.equal(checkRaw.ses_password, 'ses_keep_secret_999');
  });
});

function startMockSmtpServerStrictNoComma(): Promise<{
  port: number;
  commands: string[];
  dataHeaders: string[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const commands: string[] = [];
    const dataHeaders: string[] = [];
    const srv = net.createServer((socket) => {
      let buf = '';
      let inData = false;
      socket.write('220 localhost ESMTP StrictMockSMTP\r\n');
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        while (true) {
          if (inData) {
            const endIdx = buf.indexOf('\r\n.\r\n');
            if (endIdx === -1) break;
            const body = buf.slice(0, endIdx);
            for (const line of body.split('\r\n')) {
              if (!line) break;
              dataHeaders.push(line);
            }
            buf = buf.slice(endIdx + 5);
            inData = false;
            socket.write('250 2.0.0 Ok\r\n');
            continue;
          }
          const nlIdx = buf.indexOf('\r\n');
          if (nlIdx === -1) break;
          const line = buf.slice(0, nlIdx);
          buf = buf.slice(nlIdx + 2);
          commands.push(line);
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (upper.startsWith('AUTH PLAIN')) {
            socket.write('235 2.7.0 Ok\r\n');
          } else if (upper.startsWith('MAIL FROM:')) {
            socket.write('250 2.1.0 Ok\r\n');
          } else if (upper.startsWith('RCPT TO:')) {
            if (line.includes(',')) {
              socket.write('501 5.1.3 Bad recipient address syntax\r\n');
            } else {
              socket.write('250 2.1.5 Ok\r\n');
            }
          } else if (upper === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else {
            socket.write('250 Ok\r\n');
          }
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        commands,
        dataHeaders,
        close: () => new Promise((res) => srv.close(() => res())),
      });
    });
  });
}

function getVnNowHm(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hh = parts.find((p) => p.type === 'hour')?.value || '00';
  const mm = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${hh}:${mm}`;
}
