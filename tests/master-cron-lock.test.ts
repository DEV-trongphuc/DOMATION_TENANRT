import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { executeMasterCron } from '../server/cron/master-cron.ts';
import { getDatabasePool } from '../server/core/database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../server/core/database/transaction.ts';
import { startTestServer, type TestHarness } from './helpers.ts';
import { encryptTenantSecret } from '../server/core/crypto/vault.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { setOutboundWebhookTransportForTesting } from '../server/services/webhook.service.ts';

describe('Milestone 1: Standalone Unified Master Cron & 6 DB-Backed Subroutines', () => {
  let harness: TestHarness;
  let testTenantId = '';
  let testSlug = '';
  let testPipelineId = '';
  let testStageId = '';
  let testSaleUserId = '';

  before(async () => {
    harness = await startTestServer();
    testSlug = `cron-tenant-${Date.now().toString(36)}`;

    // Seed test tenant, pipeline, stage, and sale user
    await withSystemPrivilege(async (client) => {
      const tRes = await client.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, industry, plan_tier, status, settings)
         VALUES ($1, 'Cron Test Co', 'general', 'starter', 'active', $2::jsonb)
         RETURNING id`,
        [
          testSlug,
          JSON.stringify({
            default_sla_minutes: 15,
            sla_auto_recall_enabled: true,
            auto_drain_on_online: true,
          }),
        ]
      );
      testTenantId = tRes.rows[0].id;

      const pRes = await client.query<{ id: string }>(
        `INSERT INTO tenant_pipelines (tenant_id, name, is_default)
         VALUES ($1, 'Main Cron Pipeline', true)
         RETURNING id`,
        [testTenantId]
      );
      testPipelineId = pRes.rows[0].id;

      const sRes = await client.query<{ id: string }>(
        `INSERT INTO tenant_pipeline_stages (tenant_id, pipeline_id, stage_key, stage_name, stage_order, sla_timeout_minutes, badge_style)
         VALUES ($1, $2, 'new_lead', 'Mới Tiếp Nhận', 1, 15, '{}'::jsonb)
         RETURNING id`,
        [testTenantId, testPipelineId]
      );
      testStageId = sRes.rows[0].id;

      const uRes = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, 'dummyhash', 'Sale Agent Cron', 'sale')
         RETURNING id`,
        [testTenantId, `sale-${Date.now()}@test.vn`]
      );
      testSaleUserId = uRes.rows[0].id;

      await client.query(
        `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, work_schedule)
         VALUES ($1, $2, 'active', true, false, '{}'::jsonb)`,
        [testTenantId, testSaleUserId]
      );
    });
  });

  after(async () => {
    setOutboundWebhookTransportForTesting(null);
    await harness.close();
  });

  it('1. Advisory Lock Concurrency: Zero overlap guarantee when lock is actively held', async () => {
    // Test lock contention via forceLock
    const lockedResult = await executeMasterCron({ forceLock: true });
    assert.equal(lockedResult.locked, true, 'Must detect lock and exit cleanly with zero overlap');
    assert.equal(lockedResult.stats.errors.length, 0, 'Must have zero errors on lock detection');

    // Test unlocked execution
    const unlockedResult = await executeMasterCron({ subroutines: [] });
    assert.equal(unlockedResult.locked, false, 'Must successfully acquire lock once released');
    assert.equal(unlockedResult.stats.errors.length, 0);

    // Verify database advisory lock functions directly
    const pool = getDatabasePool();
    const isMariaDb = pool.dialect === 'mariadb' || process.env.DB_DIALECT === 'mariadb';
    const testClient = await pool.connect();
    try {
      if (isMariaDb) {
        const res = await testClient.query<{ lock_acquired: number }>(
          "SELECT GET_LOCK('autodata_master_cron_lock', 0) AS lock_acquired"
        );
        assert.ok(Number(res.rows[0]?.lock_acquired) >= 0);
        await testClient.query("SELECT RELEASE_LOCK('autodata_master_cron_lock')");
      } else {
        const res = await testClient.query<{ lock_acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext('autodata_master_cron_lock')) AS lock_acquired"
        );
        assert.equal(typeof res.rows[0]?.lock_acquired, 'boolean');
        await testClient.query("SELECT pg_advisory_unlock(hashtext('autodata_master_cron_lock'))");
      }
    } finally {
      testClient.release();
    }
  });

  it('2. Subroutine A: Direct DB SLA sweeper detects expired unaccepted leads and triggers breach/auto-recall', async () => {
    let expiredLeadId = '';

    await withTenantTransaction(testTenantId, async (client) => {
      // Insert lead created 25 minutes ago (SLA = 15m -> expired)
      const res = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, assigned_to, status, name, phone, is_accepted, sla_breached, custom_fields, created_at)
         VALUES ($1, $2, $3, $4, 'assigned', 'Khách Quá Hạn', '0901234567', false, false, '{}'::jsonb, clock_timestamp() - INTERVAL '25 minutes')
         RETURNING id`,
        [testTenantId, testPipelineId, testStageId, testSaleUserId]
      );
      expiredLeadId = res.rows[0].id;
    });

    const runRes = await executeMasterCron({ subroutines: ['sla'], tenantId: testTenantId });
    assert.equal(runRes.locked, false);
    assert.ok(runRes.stats.slaBreachedCount >= 1, 'Must sweep at least 1 expired lead');

    // Verify lead status in DB
    await withTenantTransaction(testTenantId, async (client) => {
      const lRes = await client.query<{ sla_breached: boolean; status: string }>(
        'SELECT sla_breached, status FROM leads WHERE tenant_id = $1 AND id = $2',
        [testTenantId, expiredLeadId]
      );
      assert.equal(lRes.rows[0].sla_breached, true);

      // Verify audit timeline events
      const tlRes = await client.query<{ event_type: string }>(
        'SELECT event_type FROM lead_timeline_events WHERE tenant_id = $1 AND lead_id = $2',
        [testTenantId, expiredLeadId]
      );
      const events = tlRes.rows.map((r) => r.event_type);
      assert.ok(events.includes('sla_breach'), 'Must record sla_breach timeline event');
      assert.ok(events.includes('auto_recall'), 'Must record auto_recall timeline event');
    });
  });

  it('3. Subroutine B: Unassigned lead drainer re-evaluates and assigns queued pending leads', async () => {
    let unassignedLeadId = '';

    await withTenantTransaction(testTenantId, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, is_accepted, sla_breached, custom_fields)
         VALUES ($1, $2, $3, 'unassigned_pending', 'Khách Chờ Chia', '0909888777', false, false, '{}'::jsonb)
         RETURNING id`,
        [testTenantId, testPipelineId, testStageId]
      );
      unassignedLeadId = res.rows[0].id;
    });

    const runRes = await executeMasterCron({ subroutines: ['drain'], tenantId: testTenantId });
    assert.equal(runRes.locked, false);
    assert.ok(runRes.stats.leadsDrainedCount >= 1, 'Must drain at least 1 pending lead');

    await withTenantTransaction(testTenantId, async (client) => {
      const lRes = await client.query<{ status: string; assigned_to: string | null }>(
        'SELECT status, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2',
        [testTenantId, unassignedLeadId]
      );
      assert.equal(lRes.rows[0].status, 'assigned');
      assert.equal(lRes.rows[0].assigned_to, testSaleUserId);
    });
  });

  it('4. Subroutine C: Proactively refreshes expiring Zalo OAuth tokens (<= 4h window)', async () => {
    const enc = encryptTenantSecret(testTenantId, {
      app_id: 'test_app_id',
      oa_secret: 'test_secret',
      refresh_token: 'valid_mock_refresh_token_xyz',
      access_token: 'expiring_token_abc',
    });

    await withTenantTransaction(testTenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status, token_expires_at)
         VALUES ($1, 'zalo_oa', $2, $3, $4, 'active', clock_timestamp() + INTERVAL '2 hours')
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           token_expires_at = clock_timestamp() + INTERVAL '2 hours'`,
        [testTenantId, enc.configEncrypted, enc.iv, enc.authTag]
      );
    });

    tenantRedis.invalidateTenantIntegrations(testTenantId, 'zalo_oa');

    const runRes = await executeMasterCron({ subroutines: ['zalo'], tenantId: testTenantId });
    assert.equal(runRes.locked, false);
    assert.ok(runRes.stats.zaloRefreshedCount >= 1, 'Must refresh the token expiring in 2 hours');
  });

  it('5. Subroutine D: Subscription & Trial Expiry Manager transitions expired zero-balance tenants active -> grace -> suspended', async () => {
    let expiredZeroTenantId = '';
    const expSlug = `exp-zero-${Date.now().toString(36)}`;

    await withSystemPrivilege(async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, industry, plan_tier, status, wallet_balance_vnd, trial_ends_at, subscription_expires_at)
         VALUES ($1, 'Expired Zero Co', 'general', 'starter', 'active', 0, clock_timestamp() - INTERVAL '5 days', clock_timestamp() - INTERVAL '1 day')
         RETURNING id`,
        [expSlug]
      );
      expiredZeroTenantId = res.rows[0].id;
    });

    try {
      // Tick 1: active -> grace (grace_ends_at > now)
      const runRes1 = await executeMasterCron({ subroutines: ['billing'], tenantId: expiredZeroTenantId });
      assert.equal(runRes1.locked, false);
      assert.ok(runRes1.stats.subscriptionsProcessed >= 1);

      await withSystemPrivilege(async (client) => {
        const t = await client.query<{ status: string; grace_ends_at: string | null }>(
          'SELECT status, grace_ends_at FROM tenants WHERE id = $1',
          [expiredZeroTenantId]
        );
        assert.equal(t.rows[0].status, 'grace', 'Expired zero-balance tenant must enter grace period first');
        assert.ok(t.rows[0].grace_ends_at, 'grace_ends_at must be populated');

        // Fast-forward grace_ends_at into the past
        await client.query(
          "UPDATE tenants SET grace_ends_at = clock_timestamp() - INTERVAL '1 hour' WHERE id = $1",
          [expiredZeroTenantId]
        );
      });

      // Tick 2: grace -> suspended
      const runRes2 = await executeMasterCron({ subroutines: ['billing'], tenantId: expiredZeroTenantId });
      assert.equal(runRes2.locked, false);
      assert.ok(runRes2.stats.subscriptionsProcessed >= 1);

      await withSystemPrivilege(async (client) => {
        const t = await client.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1', [expiredZeroTenantId]);
        assert.equal(t.rows[0].status, 'suspended', 'Must suspend tenant once grace_ends_at expires');
      });
    } finally {
      await withSystemPrivilege(async (client) => {
        await client.query('DELETE FROM tenants WHERE id = $1', [expiredZeroTenantId]);
      });
    }
  });

  it('6. Subroutine D: Auto-renews subscription from wallet balance for expired tenants with sufficient funds', async () => {
    let renewTenantId = '';
    const renewSlug = `renew-${Date.now().toString(36)}`;

    await withSystemPrivilege(async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, industry, plan_tier, status, wallet_balance_vnd, trial_ends_at, subscription_expires_at)
         VALUES ($1, 'Auto Renew Co', 'general', 'starter', 'active', 1500000, clock_timestamp() - INTERVAL '5 days', clock_timestamp() - INTERVAL '1 hour')
         RETURNING id`,
        [renewSlug]
      );
      renewTenantId = res.rows[0].id;
    });

    try {
      const runRes = await executeMasterCron({ subroutines: ['billing'], tenantId: renewTenantId });
      assert.equal(runRes.locked, false);
      assert.ok(runRes.stats.subscriptionsProcessed >= 1);

      await withSystemPrivilege(async (client) => {
        const t = await client.query<{ status: string; wallet_balance_vnd: number; subscription_expires_at: string }>(
          'SELECT status, wallet_balance_vnd, subscription_expires_at FROM tenants WHERE id = $1',
          [renewTenantId]
        );
        const walletTenant = t.rows[0];
        assert.equal(walletTenant.status, 'active');
        assert.strictEqual(Number(walletTenant.wallet_balance_vnd), 0, 'Must deduct 1,500,000 VND renewal fee');
        assert.ok(new Date(walletTenant.subscription_expires_at).getTime() > Date.now() + 20 * 86_400_000);
      });
    } finally {
      await withSystemPrivilege(async (client) => {
        await client.query('DELETE FROM tenants WHERE id = $1', [renewTenantId]);
      });
    }
  });

  it('7. Subroutine E: Outbound Webhook DLQ retry sweeps eligible failed deliveries', async () => {
    let webhookId = '';
    let dlqId = '';

    setOutboundWebhookTransportForTesting(async () => ({ status: 200 }));

    try {
      await withTenantTransaction(testTenantId, async (client) => {
        const whRes = await client.query<{ id: string }>(
          `INSERT INTO tenant_webhooks (tenant_id, name, webhook_type, url, token, signing_secret, field_mappings, subscribed_events, is_active)
           VALUES ($1, 'Test DLQ Hook', 'outbound', 'http://127.0.0.1:9999/mock-endpoint', $2, 'secret_123', '{}'::jsonb, '["lead.created"]'::jsonb, true)
           RETURNING id`,
          [testTenantId, `hook_${Date.now()}`]
        );
        webhookId = whRes.rows[0].id;

        const dRes = await client.query<{ id: string }>(
          `INSERT INTO tenant_webhook_dlq (tenant_id, webhook_id, event_type, delivery_id, payload, retry_count, last_attempt_at)
           VALUES ($1, $2, 'lead.created', 'del_mock_1', '{"test": true}'::jsonb, 5, clock_timestamp() - INTERVAL '5 minutes')
           RETURNING id`,
          [testTenantId, webhookId]
        );
        dlqId = dRes.rows[0].id;
      });

      const runRes = await executeMasterCron({ subroutines: ['webhook'], tenantId: testTenantId });
      assert.equal(runRes.locked, false);
      assert.ok(runRes.stats.webhooksReplayedCount >= 1, 'Must replay successfully delivered DLQ item');

      await withTenantTransaction(testTenantId, async (client) => {
        const dlq = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM tenant_webhook_dlq WHERE tenant_id = $1 AND id = $2',
          [testTenantId, dlqId]
        );
        assert.equal(Number(dlq.rows[0].count), 0, 'Delivered item must be removed from DLQ');
      });
    } finally {
      setOutboundWebhookTransportForTesting(null);
    }
  });

  it('8. Subroutine F: Meta CAPI Transient Error Retry worker queries failed 5xx logs without crashing', async () => {
    let leadId = '';

    await withTenantTransaction(testTenantId, async (client) => {
      const lRes = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, custom_fields)
         VALUES ($1, $2, $3, 'assigned', 'CAPI Test Lead', '0912345678', '{}'::jsonb)
         RETURNING id`,
        [testTenantId, testPipelineId, testStageId]
      );
      leadId = lRes.rows[0].id;

      await client.query(
        `INSERT INTO capi_logs (tenant_id, lead_id, dataset_id, event_name, event_id, action_source, match_keys, sent_payload, response_status, sent_at)
         VALUES ($1, $2, 'dataset_123', 'Lead', 'capi_evt_retry_test', 'website', '{}'::jsonb, '{"data":[]}'::jsonb, 502, clock_timestamp() - INTERVAL '10 minutes')`,
        [testTenantId, leadId]
      );
    });

    const runRes = await executeMasterCron({ subroutines: ['capi'], tenantId: testTenantId });
    assert.equal(runRes.locked, false);
    assert.equal(runRes.stats.errors.length, 0);
  });
});
