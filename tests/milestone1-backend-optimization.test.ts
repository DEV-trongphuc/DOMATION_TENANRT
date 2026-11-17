import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { MAX_INFLIGHT_GZIP } from '../server/middleware/gzip.ts';
import { NodePgPoolAdapter } from '../server/core/database/db-adapter.ts';
import { normalizeTenantSettings } from '../server/core/settings/tenant-settings.ts';
import { DEFAULT_BILLING_CATALOG } from '../server/services/billing.service.ts';
import { processTelegramBotCommand } from '../server/services/telegram.service.ts';
import { withTenantTransaction, withSystemPrivilege } from '../server/core/database/transaction.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';

test('Milestone 1: Backend Database, Pool, Payload & Dynamic Settings Optimization', async (t) => {
  let harness: TestHarness;
  let adminToken: string;
  let tenantId: string;
  let tenantSlug: string;
  let createdLeadId: string;

  await t.test('0. Bootstrap test server and create test workspace', async () => {
    harness = await startTestServer();

    // Register a tenant
    const regRes = await apiRequest(harness.baseUrl, '/api/v1/auth/register-tenant', {
      method: 'POST',
      body: {
        company_name: 'M1 Optimize Corp',
        tenant_slug: 'm1-optimize',
        admin_name: 'M1 Admin',
        work_email: 'm1-admin@optimize.vn',
        phone: '0988333444',
        password: 'Password123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });

    assert.equal(regRes.status, 201);
    adminToken = regRes.json.data.access_token;
    tenantId = regRes.json.data.tenant.id;
    tenantSlug = regRes.json.data.tenant.slug;
    assert.ok(adminToken);
    assert.ok(tenantId);
  });

  await t.test('1. Database Schema & Indexing: All 10 Missing Indexes Exist in Kernel', async () => {
    const requiredIndexes = [
      'idx_leads_tenant_quality_created',
      'idx_leads_tenant_assigned_active_created',
      'idx_leads_tenant_active_unarchived_created',
      'idx_leads_sla_master_sweep',
      'idx_leads_drainer_unassigned',
      'idx_webhook_dlq_retry_sweep',
      'idx_capi_retry_sweep',
      'idx_tenants_subscription_expiry',
      'idx_audit_logs_actor_created',
      'idx_comp_logs_consultant',
    ];

    await withSystemPrivilege(async (client) => {
      const res = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
      );
      const existingIndexes = new Set(res.rows.map((r) => r.indexname));

      for (const idx of requiredIndexes) {
        assert.ok(
          existingIndexes.has(idx),
          `Missing index in database migration: ${idx}`
        );
      }
    });
  });

  await t.test('2. Connection Pool Hardening: NodePgPoolAdapter adds statement timeout & error listener', () => {
    assert.equal(typeof NodePgPoolAdapter, 'function');
    // Instantiate adapter with mock URI and verify error listener is attached
    const adapter = new NodePgPoolAdapter('postgres://localhost:5432/mock_db');
    const pool = (adapter as any).pool;
    assert.ok(pool, 'Pool instance must exist');
    assert.ok(pool.listenerCount('error') > 0, 'Pool must register at least one error listener');
    assert.equal((pool as any).options?.statement_timeout, 30000, 'Pool statement_timeout must be 30000ms');
    adapter.close().catch(() => {});
  });

  await t.test('3. Gzip Middleware: MAX_INFLIGHT_GZIP is raised to 128', () => {
    assert.equal(MAX_INFLIGHT_GZIP, 128, 'MAX_INFLIGHT_GZIP must be configured to 128');
  });

  await t.test('4. Query Optimization & Batch Lead Import with Duplicate Check', async () => {
    // Import 10 leads in batch
    const importRes = await apiRequest(harness.baseUrl, '/api/v1/operations/leads/batch-import', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        file_name: 'test_m1_batch.xlsx',
        rows: [
          { name: 'Lead Batch 1', phone: '0901234567', email: 'batch1@example.com' },
          { name: 'Lead Batch 2', phone: '0901234568', email: 'batch2@example.com' },
          { name: 'Lead Batch 3', phone: '0901234569', email: 'batch3@example.com' },
        ],
        is_silent: true,
        skip_duplicates: true,
      },
    });

    assert.equal(importRes.status, 201);
    assert.equal(importRes.json.data.imported_count, 3);
    assert.equal(importRes.json.data.duplicate_count, 0);

    // Re-import with same phones -> duplicate count must be 3 and imported count 0
    const reImportRes = await apiRequest(harness.baseUrl, '/api/v1/operations/leads/batch-import', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        file_name: 'test_m1_batch_re.xlsx',
        rows: [
          { name: 'Lead Batch 1 Dup', phone: '0901234567' },
          { name: 'Lead Batch 2 Dup', phone: '0901234568' },
          { name: 'Lead Batch 3 Dup', phone: '0901234569' },
          { name: 'Lead Batch 4 New', phone: '0901234570' },
        ],
        is_silent: true,
        skip_duplicates: true,
      },
    });

    assert.equal(reImportRes.status, 201);
    assert.equal(reImportRes.json.data.duplicate_count, 3);
    assert.equal(reImportRes.json.data.imported_count, 1);

    // Save one lead id for notification status test
    await withSystemPrivilege(async (client) => {
      const r = await client.query('SELECT id FROM leads WHERE tenant_id = $1 LIMIT 1', [tenantId]);
      createdLeadId = r.rows[0].id;
    });
    assert.ok(createdLeadId);
  });

  await t.test('5. Notification Status Enrichment: Returns BOTH Flat Keys and Nested Objects', async () => {
    // 5a. Operations V1 endpoint: POST /api/v1/operations/leads/notification-status
    const v1Res = await apiRequest(harness.baseUrl, '/api/v1/operations/leads/notification-status', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { lead_id: createdLeadId },
    });

    assert.equal(v1Res.status, 200);
    assert.equal(v1Res.json.success, true);
    const d1 = v1Res.json.data;
    assert.ok('zalo_status' in d1, 'Flat key zalo_status must exist');
    assert.ok('email_status' in d1, 'Flat key email_status must exist');
    assert.ok(typeof d1.zalo === 'object' && d1.zalo !== null, 'Nested object zalo must exist');
    assert.ok(typeof d1.email === 'object' && d1.email !== null, 'Nested object email must exist');
    assert.equal(typeof d1.zalo.status, 'string', 'd1.zalo.status must be a string to prevent frontend crash');
    assert.equal(typeof d1.email.status, 'string', 'd1.email.status must be a string to prevent frontend crash');

    // 5b. Legacy endpoint: /api/v1/legacy?action=get_lead_notification_status
    const legacyRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/legacy?action=get_lead_notification_status&lead_id=${createdLeadId}`,
      {
        method: 'GET',
        token: adminToken,
        tenantSlug,
      }
    );

    assert.equal(legacyRes.status, 200);
    assert.equal(legacyRes.json.success, true);
    const d2 = legacyRes.json.data;
    assert.ok('zalo_status' in d2, 'Legacy flat key zalo_status must exist');
    assert.ok('email_status' in d2, 'Legacy flat key email_status must exist');
    assert.ok(typeof d2.zalo === 'object' && d2.zalo !== null, 'Legacy nested zalo must exist');
    assert.ok(typeof d2.email === 'object' && d2.email !== null, 'Legacy nested email must exist');
    assert.equal(typeof d2.zalo.status, 'string', 'd2.zalo.status must be defined');
    assert.equal(typeof d2.email.status, 'string', 'd2.email.status must be defined');
  });

  await t.test('6. Dynamic Custom Settings: Telegram Commands & Billing Configuration', async () => {
    // 6a. TenantSettings normalization supports custom telegram commands
    const customSettings = normalizeTenantSettings({
      telegram_accept_command: '/nhan_lead',
      telegram_report_command: '/khieu_nai',
    });
    assert.equal(customSettings.telegram_accept_command, '/nhan_lead');
    assert.equal(customSettings.telegram_report_command, '/khieu_nai');

    // Update tenant settings in DB and invalidate cache
    await withSystemPrivilege(async (client) => {
      await client.query(
        'UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1',
        [tenantId, JSON.stringify({ telegram_accept_command: '/nhan_lead' })]
      );
    });
    tenantRedis.invalidateTenantCache(tenantId);

    // Test processTelegramBotCommand with the dynamic custom command
    const tgRes = await processTelegramBotCommand({
      tenantId,
      chatId: '123456789',
      text: `/nhan_lead #${createdLeadId.slice(0, 8)}`,
      senderName: 'Sale Tester',
    });

    assert.equal(tgRes.handled, true);
    assert.equal(tgRes.command, '/nhan_lead');
    assert.ok(tgRes.replyText.includes('tiếp nhận khách hàng'));

    // 6b. Billing service default catalog has dynamic fallback structure
    assert.ok(DEFAULT_BILLING_CATALOG.payment_bank_info.bank_name);
    assert.ok(DEFAULT_BILLING_CATALOG.payment_bank_info.account_number);
    assert.ok(DEFAULT_BILLING_CATALOG.base_monthly_price_vnd > 0);
  });

  await t.test('99. Teardown test harness', async () => {
    await harness.close();
  });
});
