import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import {
  sendTelegramNotification,
  setTelegramTransportForTesting,
  getTelegramConfig,
  processTelegramBotCommand,
  type TelegramTransportFn,
} from '../server/services/telegram.service.ts';
import { ingestAndDistributeLead } from '../server/services/distribution.service.ts';
import { encryptTenantSecret } from '../server/core/crypto/vault.ts';
import { withTenantTransaction, withSystemPrivilege } from '../server/core/database/transaction.ts';

describe('Milestone 2: Telegram Bot Notification Integration & Webhook Handler', () => {
  let harness: TestHarness;
  let adminToken = '';
  let tenantId = '';
  let tenantSlug = 'telegram-test-tenant';
  let saleId = '';

  before(async () => {
    harness = await startTestServer();

    // Register a test organization
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Telegram Test Property Group',
        tenant_slug: tenantSlug,
        admin_name: 'Admin Telegram',
        work_email: 'admin@telegram-test.vn',
        phone: '0908889999',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
        initial_sales: [
          {
            full_name: 'Consultant Minh',
            email: 'minh.sale@telegram-test.vn',
            phone: '0901112233',
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
    saleId = reg.json.data.initial_sales?.[0]?.id || '';
  });

  after(async () => {
    setTelegramTransportForTesting(null);
    await harness.close();
  });

  beforeEach(() => {
    setTelegramTransportForTesting(null);
  });

  describe('1. Telegram Service Unit Tests & Outbound Delivery via Mock Transport', () => {
    it('captures outbound notification payload and formatting via mock transport', async () => {
      const delivered: Array<{ chatId: string; text: string; parseMode?: string }> = [];
      setTelegramTransportForTesting(async (payload) => {
        delivered.push(payload);
        return { message_id: 88801, ok: true };
      });

      const res = await sendTelegramNotification(
        null,
        '🎯 <b>Lead Mới:</b> Nguyễn Văn An\n• SĐT: 0901234567\n• Mã: #lead001',
        {
          chatId: '-10099887766',
          parseMode: 'HTML',
          silentOverride: false,
        }
      );

      assert.equal(res.success, true);
      assert.equal(res.messageId, 88801);
      assert.equal(res.silent, false);
      assert.equal(res.mocked, true);

      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].chatId, '-10099887766');
      assert.match(delivered[0].text, /Nguyễn Văn An/);
      assert.equal(delivered[0].parseMode, 'HTML');
    });

    it('supports MarkdownV2 parseMode and custom chat ID override', async () => {
      let capturedPayload: any = null;
      setTelegramTransportForTesting(async (payload) => {
        capturedPayload = payload;
        return { messageId: 99902 };
      });

      const res = await sendTelegramNotification(
        null,
        '*Thông báo:* Khách hàng mới được phân bổ',
        {
          chatId: '55667788',
          parseMode: 'MarkdownV2',
          silentOverride: false,
        }
      );

      assert.equal(res.success, true);
      assert.equal(res.messageId, 99902);
      assert.equal(capturedPayload?.chatId, '55667788');
      assert.equal(capturedPayload?.parseMode, 'MarkdownV2');
    });

    it('returns error when bot token or chatId is missing and silentOverride is false', async () => {
      const savedToken = process.env.TELEGRAM_BOT_TOKEN;
      const savedChatId = process.env.TELEGRAM_CHAT_ID;
      try {
        delete process.env.TELEGRAM_BOT_TOKEN;
        delete process.env.TELEGRAM_CHAT_ID;

        // No botToken
        const res = await sendTelegramNotification(null, 'Test message', {
          silentOverride: false,
        });
        assert.equal(res.success, false);
        assert.equal(res.silent, false);
        assert.match(res.error || '', /TELEGRAM_BOT_TOKEN is not configured/);
      } finally {
        if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
        if (savedChatId !== undefined) process.env.TELEGRAM_CHAT_ID = savedChatId;
      }
    });
  });

  describe('2. Strict Silent / Mock Mode Verification (R2 Requirement)', () => {
    it('guarantees 100% silent execution: ZERO outbound HTTP requests to api.telegram.org in silent mode', async () => {
      let httpCallsCount = 0;
      const originalFetch = globalThis.fetch;

      // Spy on fetch to detect any outbound network activity
      globalThis.fetch = (async (input: any, init: any) => {
        const url = String(input);
        if (url.includes('api.telegram.org')) {
          httpCallsCount++;
          throw new Error('VIOLATION: Outbound HTTP request fired to api.telegram.org during silent mode!');
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        // Test with explicit silentOverride: true
        const res1 = await sendTelegramNotification(
          null,
          'Test lead message during mock migration',
          {
            chatId: '-100112233',
            silentOverride: true,
          }
        );

        assert.equal(res1.success, true);
        assert.equal(res1.silent, true);
        assert.equal(res1.mocked, true);
        assert.equal(httpCallsCount, 0, 'Zero HTTP requests must be sent to api.telegram.org');

        // Test with TELEGRAM_SILENT_MODE = 'true'
        const prevSilentMode = process.env.TELEGRAM_SILENT_MODE;
        process.env.TELEGRAM_SILENT_MODE = 'true';
        try {
          const res2 = await sendTelegramNotification(null, 'Test lead with TELEGRAM_SILENT_MODE=true', {
            chatId: '-100112233',
          });
          assert.equal(res2.success, true);
          assert.equal(res2.silent, true);
          assert.equal(res2.mocked, true);
          assert.equal(httpCallsCount, 0, 'Zero HTTP requests must be sent when TELEGRAM_SILENT_MODE=true');
        } finally {
          if (prevSilentMode !== undefined) {
            process.env.TELEGRAM_SILENT_MODE = prevSilentMode;
          } else {
            delete process.env.TELEGRAM_SILENT_MODE;
          }
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('guarantees ZERO outbound HTTP calls when TELEGRAM_NOTIFY_ENABLED=false', async () => {
      let outboundAttempted = false;
      const originalFetch = globalThis.fetch;

      globalThis.fetch = (async (input: any, init: any) => {
        const url = String(input);
        if (url.includes('api.telegram.org')) {
          outboundAttempted = true;
          throw new Error('VIOLATION: api.telegram.org was invoked while TELEGRAM_NOTIFY_ENABLED=false');
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const prevNotify = process.env.TELEGRAM_NOTIFY_ENABLED;
      process.env.TELEGRAM_NOTIFY_ENABLED = 'false';

      try {
        const res = await sendTelegramNotification(null, 'Notification should be suppressed', {
          chatId: '-1009988',
        });
        assert.equal(res.success, true);
        assert.equal(res.silent, true);
        assert.equal(res.mocked, true);
        assert.equal(outboundAttempted, false, 'No HTTP request should be fired when notify is disabled');
      } finally {
        if (prevNotify !== undefined) {
          process.env.TELEGRAM_NOTIFY_ENABLED = prevNotify;
        } else {
          delete process.env.TELEGRAM_NOTIFY_ENABLED;
        }
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('3. Tenant Vault Token & Chat ID Lookup', () => {
    it('resolves Telegram credentials from AES-256 encrypted tenant vault with fallback', async () => {
      // Extend integration_type constraint for test database
      await withSystemPrivilege(async (client) => {
        await client.query(
          'ALTER TABLE tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_integration_type_check'
        );
        await client.query(
          "ALTER TABLE tenant_integrations ADD CONSTRAINT tenant_integrations_integration_type_check CHECK (integration_type IN ('zalo_oa', 'zalo_bot', 'meta_capi', 'smtp', 'google_sheets', 'telegram', 'telegram_bot'))"
        );
      });

      // Save telegram credentials encrypted in tenant_integrations vault
      const encrypted = encryptTenantSecret(tenantId, {
        bot_token: 'vault_bot_token_secret_12345',
        chat_id: '-100888777666',
        enabled: true,
      });

      await withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenant_integrations (
            tenant_id, integration_type, config_encrypted, iv, auth_tag, status
          ) VALUES ($1, 'telegram_bot', $2, $3, $4, 'active')
          ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
            config_encrypted = EXCLUDED.config_encrypted,
            iv = EXCLUDED.iv,
            auth_tag = EXCLUDED.auth_tag,
            status = 'active'`,
          [tenantId, encrypted.configEncrypted, encrypted.iv, encrypted.authTag]
        );
      });

      let capturedChatId = '';
      setTelegramTransportForTesting(async (payload) => {
        capturedChatId = payload.chatId;
        return { message_id: 55443 };
      });

      const res = await sendTelegramNotification(tenantId, 'Tenant vault notification test', {
        silentOverride: false,
      });

      assert.equal(res.success, true);
      assert.equal(capturedChatId, '-100888777666');
    });
  });

  describe('4. Telegram Interactive Webhook Endpoint (POST /api/v1/integrations/telegram/webhook)', () => {
    it('executes /chatid command to return chat identifier', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/webhook', {
        method: 'POST',
        token: adminToken,
        body: {
          chat_id: '-10099887766',
          text: '/chatid',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.handled, true);
      assert.equal(res.json.data.command, '/chatid');
      assert.match(res.json.data.replyText, /-10099887766/);
      assert.equal(res.json.data.metadata?.chat_id, '-10099887766');
    });

    it('supports standard Telegram Update object format for /chatid', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/webhook', {
        method: 'POST',
        headers: {
          'X-Tenant-Slug': tenantSlug,
        },
        body: {
          update_id: 10001,
          message: {
            message_id: 50,
            from: { id: 778899, first_name: 'Minh', username: 'minh_sale' },
            chat: { id: -100445566, title: 'Sales War Room', type: 'supergroup' },
            text: '/chatid',
          },
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.handled, true);
      assert.match(res.json.data.replyText, /-100445566/);
    });

    it('executes /tiepnhan <leadId> to accept lead and resolve stage SLA', async () => {
      // Ingest a test lead
      const leadOutcome = await ingestAndDistributeLead(tenantId, {
        name: 'Trần Văn Hoàng',
        phone: '0912345678',
        email: 'hoang.tran@gmail.com',
        source: 'Landing Page Test',
      });

      const leadId = leadOutcome.leadId;
      const shortId = leadId.slice(0, 8);

      // Execute /tiepnhan #shortId via webhook
      const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/webhook', {
        method: 'POST',
        token: adminToken,
        body: {
          chat_id: '-10099887766',
          text: `/tiepnhan #${shortId}`,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.handled, true);
      assert.equal(res.json.data.command, '/tiepnhan');
      assert.match(res.json.data.replyText, /Trần Văn Hoàng/);

      // Verify DB state: lead is_accepted should now be true
      const leadsCheck = await apiRequest(harness.baseUrl, `/api/v1/leads`, {
        token: adminToken,
      });
      const acceptedLead = leadsCheck.json.data?.items?.find((l: any) => l.id === leadId);
      assert.ok(acceptedLead);
      assert.equal(acceptedLead.is_accepted, true);
    });

    it('executes /baoloi <leadId> <noidung> to log complaint ticket and timeline event', async () => {
      // Ingest a second test lead
      const leadOutcome = await ingestAndDistributeLead(tenantId, {
        name: 'Lê Thị Thuỷ',
        phone: '0987654321',
        email: 'thuy.le@gmail.com',
        source: 'Hotline Facebook',
      });

      const leadId = leadOutcome.leadId;
      const shortId = leadId.slice(0, 8);

      // Execute /baoloi #shortId Khách nhầm số
      const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/webhook', {
        method: 'POST',
        token: adminToken,
        body: {
          chat_id: '-10099887766',
          text: `/baoloi #${shortId} Khách hàng không nghe máy`,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.data.handled, true);
      assert.equal(res.json.data.command, '/baoloi');
      assert.match(res.json.data.replyText, /khiếu nại/i);
      assert.ok(res.json.data.metadata?.ticket_id);

      // Verify ticket in data_reports
      const ticketId = res.json.data.metadata.ticket_id;
      const dbTicket = await withTenantTransaction(tenantId, async (client) => {
        const r = await client.query<{ id: string; status: string; reason: string; description: string }>(
          `SELECT id, status, reason, description FROM data_reports WHERE id = $1`,
          [ticketId]
        );
        return r.rows[0];
      });

      assert.ok(dbTicket);
      assert.equal(dbTicket.status, 'pending');
      assert.match(dbTicket.description, /không nghe máy/);
    });

    it('returns graceful guidance on unrecognized commands', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/webhook', {
        method: 'POST',
        token: adminToken,
        body: {
          chat_id: '-10099887766',
          text: '/huongdan',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.data.handled, false);
      assert.match(res.json.data.replyText, /Lệnh không được nhận diện/);
    });

    it('rejects payloads missing text with HTTP 400', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/webhook', {
        method: 'POST',
        token: adminToken,
        body: {
          chat_id: '-10099887766',
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.json.success, false);
      assert.equal(res.json.error.code, 'INVALID_TELEGRAM_PAYLOAD');
    });
  });

  describe('5. Lead Distribution Flow Telegram Notification Integration', () => {
    it('dispatches Telegram notification during lead assignment when silent mode is disabled', async () => {
      const capturedNotifications: Array<{ chatId: string; text: string; parseMode?: string }> = [];
      setTelegramTransportForTesting(async (payload) => {
        capturedNotifications.push(payload);
        return { message_id: 112233, ok: true };
      });

      const prevSilentMode = process.env.TELEGRAM_SILENT_MODE;
      const prevNotifyEnabled = process.env.TELEGRAM_NOTIFY_ENABLED;

      process.env.TELEGRAM_SILENT_MODE = 'false';
      process.env.TELEGRAM_NOTIFY_ENABLED = 'true';

      try {
        const outcome = await ingestAndDistributeLead(tenantId, {
          name: 'Phạm Thanh Bình',
          phone: '0933112233',
          email: 'binh.pham@gmail.com',
          source: 'Bất Động Sản Hà Nội',
        });

        assert.equal(outcome.status, 'assigned');
        assert.equal(capturedNotifications.length, 1);
        assert.match(capturedNotifications[0].text, /Phạm Thanh Bình/);
        assert.match(capturedNotifications[0].text, /84933112233/);
        assert.match(capturedNotifications[0].text, /\/tiepnhan/);
        assert.equal(capturedNotifications[0].parseMode, 'HTML');
      } finally {
        if (prevSilentMode !== undefined) {
          process.env.TELEGRAM_SILENT_MODE = prevSilentMode;
        } else {
          delete process.env.TELEGRAM_SILENT_MODE;
        }
        if (prevNotifyEnabled !== undefined) {
          process.env.TELEGRAM_NOTIFY_ENABLED = prevNotifyEnabled;
        } else {
          delete process.env.TELEGRAM_NOTIFY_ENABLED;
        }
      }
    });

    it('suppresses notification dispatch completely when silent mode is active', async () => {
      let notificationFired = false;
      setTelegramTransportForTesting(async () => {
        notificationFired = true;
      });

      const prevSilentMode = process.env.TELEGRAM_SILENT_MODE;
      process.env.TELEGRAM_SILENT_MODE = 'true';

      try {
        const outcome = await ingestAndDistributeLead(tenantId, {
          name: 'Đặng Quốc Huy',
          phone: '0977889900',
          email: 'huy.dang@gmail.com',
          source: 'Website Form',
        });

        assert.equal(outcome.status, 'assigned');
        assert.equal(notificationFired, false, 'No notification transport should be called when silent mode is true');
      } finally {
        if (prevSilentMode !== undefined) {
          process.env.TELEGRAM_SILENT_MODE = prevSilentMode;
        } else {
          delete process.env.TELEGRAM_SILENT_MODE;
        }
      }
    });
  });
});
