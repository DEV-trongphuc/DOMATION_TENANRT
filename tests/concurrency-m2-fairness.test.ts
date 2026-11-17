import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, type TestHarness } from './helpers.ts';
import { withSystemPrivilege, withTenantTransaction } from '../server/core/database/transaction.ts';
import { ingestAndDistributeLead } from '../server/services/distribution.service.ts';
import { setTelegramTransportForTesting } from '../server/services/telegram.service.ts';
import { runUnassignedLeadDrainer } from '../server/cron/subroutines/lead-drainer.ts';
import { runMetaCapiRetryWorker, setCapiRetryFetcherForTesting } from '../server/cron/subroutines/capi-retry.ts';
import { encryptTenantSecret } from '../server/core/crypto/vault.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';

describe('Milestone 2: High Concurrency, Non-blocking Cron/Notifications & Queue Fairness', () => {
  let harness: TestHarness;
  let tenant1Id = '';
  let tenant1Slug = '';
  let tenant2Id = '';
  let tenant2Slug = '';
  let pipeline1Id = '';
  let stage1Id = '';
  let saleAId = '';
  let saleBId = '';
  let saleCId = '';

  before(async () => {
    harness = await startTestServer();
    tenant1Slug = `m2-tenant-1-${Date.now().toString(36)}`;
    tenant2Slug = `m2-tenant-2-${Date.now().toString(36)}`;

    // Seed Tenant 1
    await withSystemPrivilege(async (client) => {
      const t1 = await client.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, industry, plan_tier, status, settings)
         VALUES ($1, 'Tenant 1 M2 Corp', 'general', 'starter', 'active', $2::jsonb)
         RETURNING id`,
        [
          tenant1Slug,
          JSON.stringify({
            default_sla_minutes: 15,
            sla_auto_recall_enabled: true,
            auto_drain_on_online: true,
            queue_drain_batch_limit: 10,
          }),
        ]
      );
      tenant1Id = t1.rows[0].id;

      // Seed Tenant 2
      const t2 = await client.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, industry, plan_tier, status, settings)
         VALUES ($1, 'Tenant 2 M2 Corp', 'general', 'starter', 'active', $2::jsonb)
         RETURNING id`,
        [
          tenant2Slug,
          JSON.stringify({
            default_sla_minutes: 15,
            sla_auto_recall_enabled: true,
            auto_drain_on_online: true,
            queue_drain_batch_limit: 5,
          }),
        ]
      );
      tenant2Id = t2.rows[0].id;

      // Seed Pipeline & Stage for Tenant 1
      const p1 = await client.query<{ id: string }>(
        `INSERT INTO tenant_pipelines (tenant_id, name, is_default)
         VALUES ($1, 'Main Sales Pipeline', true)
         RETURNING id`,
        [tenant1Id]
      );
      pipeline1Id = p1.rows[0].id;

      const s1 = await client.query<{ id: string }>(
        `INSERT INTO tenant_pipeline_stages (tenant_id, pipeline_id, stage_key, stage_name, stage_order, sla_timeout_minutes, badge_style)
         VALUES ($1, $2, 'new', 'Mới Tiếp Nhận', 1, 15, '{}'::jsonb)
         RETURNING id`,
        [tenant1Id, pipeline1Id]
      );
      stage1Id = s1.rows[0].id;

      // Seed 3 active sales reps for Tenant 1: Alice, Bob, Charlie (created in sequence)
      const uA = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, 'hash_alice', 'Alice Sale', 'sale')
         RETURNING id`,
        [tenant1Id, `alice-${Date.now()}@test.vn`]
      );
      saleAId = uA.rows[0].id;

      const uB = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, 'hash_bob', 'Bob Sale', 'sale')
         RETURNING id`,
        [tenant1Id, `bob-${Date.now()}@test.vn`]
      );
      saleBId = uB.rows[0].id;

      const uC = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, 'hash_charlie', 'Charlie Sale', 'sale')
         RETURNING id`,
        [tenant1Id, `charlie-${Date.now()}@test.vn`]
      );
      saleCId = uC.rows[0].id;

      // Create active profiles for all 3 sales reps
      for (const uid of [saleAId, saleBId, saleCId]) {
        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, work_schedule)
           VALUES ($1, $2, 'active', true, false, '{}'::jsonb)`,
          [tenant1Id, uid]
        );
      }

      // Seed pipeline and stage for Tenant 2
      const p2 = await client.query<{ id: string }>(
        `INSERT INTO tenant_pipelines (tenant_id, name, is_default)
         VALUES ($1, 'Tenant 2 Pipeline', true)
         RETURNING id`,
        [tenant2Id]
      );
      const s2 = await client.query<{ id: string }>(
        `INSERT INTO tenant_pipeline_stages (tenant_id, pipeline_id, stage_key, stage_name, stage_order, sla_timeout_minutes, badge_style)
         VALUES ($1, $2, 'new', 'Mới Tiếp Nhận', 1, 15, '{}'::jsonb)
         RETURNING id`,
        [tenant2Id, p2.rows[0].id]
      );

      // Seed 1 sales rep for Tenant 2
      const u2 = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1, $2, 'hash_t2', 'T2 Sale Agent', 'sale')
         RETURNING id`,
        [tenant2Id, `t2-sale-${Date.now()}@test.vn`]
      );
      await client.query(
        `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, work_schedule)
         VALUES ($1, $2, 'active', true, false, '{}'::jsonb)`,
        [tenant2Id, u2.rows[0].id]
      );
    });
  });

  after(async () => {
    setTelegramTransportForTesting(null);
    setCapiRetryFetcherForTesting(null);
    await harness.close();
  });

  it('Task 1 (V-06): Non-blocking Telegram notification dispatch does not stall lead distribution', async () => {
    const origSilent = process.env.TELEGRAM_SILENT_MODE;
    const origEnabled = process.env.TELEGRAM_NOTIFY_ENABLED;
    const origOutbound = process.env.OUTBOUND_SILENT_MODE;
    process.env.TELEGRAM_SILENT_MODE = 'false';
    process.env.TELEGRAM_NOTIFY_ENABLED = 'true';
    process.env.OUTBOUND_SILENT_MODE = 'false';

    let transportInvoked = false;
    let transportCompleted = false;

    // Simulate slow Telegram network API (500ms delay)
    setTelegramTransportForTesting(async () => {
      transportInvoked = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      transportCompleted = true;
      return { messageId: 9999, message_id: 9999 };
    });

    try {
      const startTime = Date.now();
      const outcome = await ingestAndDistributeLead(tenant1Id, {
        name: 'Non-Blocking Test Lead',
        phone: '0901112233',
        source: 'manual',
      });
      const durationMs = Date.now() - startTime;

      // Verify that lead was distributed immediately without waiting 500ms for Telegram
      assert.ok(outcome.leadId, 'Lead must be successfully created and assigned');
      assert.ok(
        durationMs < 250,
        `ingestAndDistributeLead must return immediately (< 250ms), actual: ${durationMs}ms`
      );

      // Wait a moment for background detached dispatch to finish
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(transportInvoked, true, 'Detached Telegram transport should be triggered in background');
      assert.equal(transportCompleted, true, 'Detached Telegram transport should complete in background');
    } finally {
      process.env.TELEGRAM_SILENT_MODE = origSilent;
      process.env.TELEGRAM_NOTIFY_ENABLED = origEnabled;
      process.env.OUTBOUND_SILENT_MODE = origOutbound;
      setTelegramTransportForTesting(null);
    }
  });

  it('Task 1 (V-06): Notification failure/rejection never crashes or throws in lead distribution', async () => {
    const origSilent = process.env.TELEGRAM_SILENT_MODE;
    const origEnabled = process.env.TELEGRAM_NOTIFY_ENABLED;
    const origOutbound = process.env.OUTBOUND_SILENT_MODE;
    process.env.TELEGRAM_SILENT_MODE = 'false';
    process.env.TELEGRAM_NOTIFY_ENABLED = 'true';
    process.env.OUTBOUND_SILENT_MODE = 'false';

    // Simulate fatal Telegram network error (connection refused / timeout)
    setTelegramTransportForTesting(async () => {
      throw new Error('ECONNREFUSED api.telegram.org:443');
    });

    try {
      const outcome = await ingestAndDistributeLead(tenant1Id, {
        name: 'Fault Tolerant Lead',
        phone: '0902223344',
        source: 'manual',
      });
      assert.ok(outcome.leadId, 'Must return valid outcome despite Telegram transport failure');
    } finally {
      process.env.TELEGRAM_SILENT_MODE = origSilent;
      process.env.TELEGRAM_NOTIFY_ENABLED = origEnabled;
      process.env.OUTBOUND_SILENT_MODE = origOutbound;
      setTelegramTransportForTesting(null);
    }
  });

  it('Task 2 (V-07): Fair-Share Lead Queue Drainer distributes backlog round-robin across all active sales reps', async () => {
    // Clear any previous drain cursor for test tenant and soft-delete prior test leads
    await tenantRedis.del('drain_rr_last_sale_id', tenant1Id);
    await withTenantTransaction(tenant1Id, async (client) => {
      await client.query('UPDATE leads SET is_deleted = true WHERE tenant_id = $1', [tenant1Id]);
    });

    // Insert 6 pending leads for Tenant 1
    const leadIds: string[] = [];
    await withTenantTransaction(tenant1Id, async (client) => {
      for (let i = 1; i <= 6; i++) {
        const r = await client.query<{ id: string }>(
          `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, is_accepted, sla_breached, custom_fields)
           VALUES ($1, $2, $3, 'unassigned_pending', $4, $5, false, false, '{}'::jsonb)
           RETURNING id`,
          [tenant1Id, pipeline1Id, stage1Id, `Backlog Lead ${i}`, `090000000${i}`]
        );
        leadIds.push(r.rows[0].id);
      }
    });

    // Execute drainer for Tenant 1
    const drainedCount = await runUnassignedLeadDrainer(tenant1Id);
    assert.equal(drainedCount, 6, 'Must drain all 6 unassigned pending leads');

    // Query assignments per sales rep
    const counts = await withTenantTransaction(tenant1Id, async (client) => {
      const res = await client.query<{ assigned_to: string; count: string }>(
        `SELECT assigned_to, COUNT(*)::text as count
         FROM leads
         WHERE tenant_id = $1 AND id = ANY($2::uuid[])
         GROUP BY assigned_to`,
        [tenant1Id, leadIds]
      );
      return res.rows;
    });

    // Verify fair-share round-robin: Alice, Bob, Charlie must EACH get exactly 2 leads!
    // (Previously, Alice received 100% (6 leads) and Bob/Charlie received 0 due to oldest-rep bias)
    assert.equal(counts.length, 3, 'All 3 sales reps must have received leads');
    for (const row of counts) {
      assert.equal(
        parseInt(row.count, 10),
        2,
        `Rep ${row.assigned_to} should receive exactly 2 leads out of 6, got ${row.count}`
      );
    }

    // Now insert 2 more leads to verify round-robin cursor continuation
    const nextLeadIds: string[] = [];
    await withTenantTransaction(tenant1Id, async (client) => {
      for (let i = 7; i <= 8; i++) {
        const r = await client.query<{ id: string }>(
          `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, is_accepted, sla_breached, custom_fields)
           VALUES ($1, $2, $3, 'unassigned_pending', $4, $5, false, false, '{}'::jsonb)
           RETURNING id`,
          [tenant1Id, pipeline1Id, stage1Id, `Backlog Lead ${i}`, `090000000${i}`]
        );
        nextLeadIds.push(r.rows[0].id);
      }
    });

    const nextDrained = await runUnassignedLeadDrainer(tenant1Id);
    assert.equal(nextDrained, 2, 'Must drain the 2 new pending leads');

    const orderedReps = await withTenantTransaction(tenant1Id, async (client) => {
      const res = await client.query<{ id: string; full_name: string }>(
        `SELECT u.id, u.full_name FROM users u WHERE u.tenant_id = $1 AND u.role = 'sale' ORDER BY u.created_at ASC, u.id ASC`,
        [tenant1Id]
      );
      return res.rows;
    });

    const nextAssigned = await withTenantTransaction(tenant1Id, async (client) => {
      const res = await client.query<{ id: string; assigned_to: string }>(
        `SELECT id, assigned_to FROM leads WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY created_at ASC`,
        [tenant1Id, nextLeadIds]
      );
      return res.rows;
    });

    // In batch 1 (6 leads), each of the 3 reps received exactly 2 leads.
    // The last lead of batch 1 was assigned to orderedReps[2].
    // Therefore in batch 2 (2 leads), rotation resumes with orderedReps[0] and orderedReps[1].
    const assignedRepIds = nextAssigned.map((r) => r.assigned_to);
    assert.ok(
      assignedRepIds.includes(orderedReps[0].id),
      `New batch must allocate to next rep in round-robin sequence: ${orderedReps[0].full_name}`
    );
    assert.ok(
      assignedRepIds.includes(orderedReps[1].id),
      `New batch must allocate to following rep in round-robin sequence: ${orderedReps[1].full_name}`
    );
    assert.ok(
      !assignedRepIds.includes(orderedReps[2].id),
      `Previous rep ${orderedReps[2].full_name} should not receive a lead in this 2-lead batch`
    );
  });

  it('Task 2 (V-07): Multi-tenant queue processing avoids head-of-line blocking', async () => {
    // Clear tenant rotation cursor and soft-delete prior test leads
    await tenantRedis.del('lead_drainer_last_tenant_id', 'system');
    await withTenantTransaction(tenant1Id, async (client) => {
      await client.query('UPDATE leads SET is_deleted = true WHERE tenant_id = $1', [tenant1Id]);
    });
    await withTenantTransaction(tenant2Id, async (client) => {
      await client.query('UPDATE leads SET is_deleted = true WHERE tenant_id = $1', [tenant2Id]);
    });

    // Insert 4 leads for Tenant 1 and 2 leads for Tenant 2
    await withTenantTransaction(tenant1Id, async (client) => {
      for (let i = 1; i <= 4; i++) {
        await client.query(
          `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, custom_fields)
           VALUES ($1, $2, $3, 'unassigned_pending', $4, $5, '{}'::jsonb)`,
          [tenant1Id, pipeline1Id, stage1Id, `T1 Queue Lead ${i}`, `091100000${i}`]
        );
      }
    });

    let t2PipelineId = '';
    let t2StageId = '';
    await withTenantTransaction(tenant2Id, async (client) => {
      const p = await client.query<{ id: string }>(
        `SELECT id FROM tenant_pipelines WHERE tenant_id = $1 LIMIT 1`,
        [tenant2Id]
      );
      t2PipelineId = p.rows[0].id;
      const s = await client.query<{ id: string }>(
        `SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 LIMIT 1`,
        [tenant2Id]
      );
      t2StageId = s.rows[0].id;

      for (let i = 1; i <= 2; i++) {
        await client.query(
          `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, custom_fields)
           VALUES ($1, $2, $3, 'unassigned_pending', $4, $5, '{}'::jsonb)`,
          [tenant2Id, t2PipelineId, t2StageId, `T2 Queue Lead ${i}`, `092200000${i}`]
        );
      }
    });

    // Run drainer across ALL tenants (no filter)
    const totalDrained = await runUnassignedLeadDrainer();
    assert.ok(totalDrained >= 6, 'Must drain leads from both tenants');

    // Verify Tenant 2 leads were drained and not starved by Tenant 1
    const t2PendingCount = await withTenantTransaction(tenant2Id, async (client) => {
      const res = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM leads WHERE tenant_id = $1 AND status = 'unassigned_pending'`,
        [tenant2Id]
      );
      return parseInt(res.rows[0].count, 10);
    });
    assert.equal(t2PendingCount, 0, 'Tenant 2 queue must be fully drained without head-of-line blocking');
  });

  it('Task 3: CAPI Retry Worker executes external network fetch with ZERO database connections held', async () => {
    // Setup Meta CAPI credentials in tenant_integrations for Tenant 1
    const enc = encryptTenantSecret(tenant1Id, {
      dataset_id: '9876543210',
      access_token: 'EAAB_test_access_token_m2',
      api_version: 'v21.0',
    });

    await withTenantTransaction(tenant1Id, async (client) => {
      await client.query(
        `INSERT INTO tenant_integrations (tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
         VALUES ($1, 'meta_capi', $2, $3, $4, 'active')
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           status = 'active'`,
        [tenant1Id, enc.configEncrypted, enc.iv, enc.authTag]
      );
    });

    tenantRedis.invalidateTenantIntegrations(tenant1Id, 'meta_capi');

    // Create a lead and insert a failed CAPI log (status 502, sent 10 minutes ago)
    let testLeadId = '';
    await withTenantTransaction(tenant1Id, async (client) => {
      const l = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, custom_fields)
         VALUES ($1, $2, $3, 'assigned', 'CAPI Retry Detached Lead', '0933445566', '{}'::jsonb)
         RETURNING id`,
        [tenant1Id, pipeline1Id, stage1Id]
      );
      testLeadId = l.rows[0].id;

      await client.query(
        `INSERT INTO capi_logs (tenant_id, lead_id, dataset_id, event_name, event_id, action_source, match_keys, sent_payload, response_status, sent_at)
         VALUES ($1, $2, '9876543210', 'Lead', 'capi_evt_detached_test_1', 'system_cron_retry', '{}'::jsonb, '{"data":[{"event_name":"Lead"}]}'::jsonb, 502, clock_timestamp() - INTERVAL '10 minutes')`,
        [tenant1Id, testLeadId]
      );
    });

    let fetcherExecuted = false;

    // Custom test fetcher: simulate 100ms network round-trip and verify that
    // during the network wait, database pool operations can proceed without deadlock
    setCapiRetryFetcherForTesting(async (url, init) => {
      fetcherExecuted = true;
      assert.ok(String(url).includes('9876543210'), 'URL must target correct dataset ID');
      assert.ok(String(url).includes('access_token=EAAB_test_access_token_m2'), 'URL must include access token');

      // Crucial verification: While network call is awaiting, we can execute independent DB queries
      // proving the pool is NOT locked or held by the retry worker!
      await withSystemPrivilege(async (client) => {
        const ping = await client.query<{ ok: number }>('SELECT 1 as ok');
        assert.equal(ping.rows[0].ok, 1, 'Database pool must be completely free and accessible during external fetch');
      });

      await new Promise((r) => setTimeout(r, 100));

      return {
        status: 200,
        json: async () => ({ events_received: 1, fbtrace_id: 'fb_trace_test_detached_ok' }),
      } as any;
    });

    try {
      const retriedCount = await runMetaCapiRetryWorker(tenant1Id);
      assert.equal(fetcherExecuted, true, 'Mock fetcher must have been invoked');
      assert.equal(retriedCount, 1, 'Must report 1 successful retry');

      // Verify that the success entry was written to capi_logs
      const logs = await withTenantTransaction(tenant1Id, async (client) => {
        const res = await client.query<{ response_status: number; response_body: any }>(
          `SELECT response_status, response_body
           FROM capi_logs
           WHERE tenant_id = $1 AND lead_id = $2
           ORDER BY sent_at DESC
           LIMIT 1`,
          [tenant1Id, testLeadId]
        );
        return res.rows[0];
      });

      assert.equal(logs.response_status, 200);
      assert.equal(logs.response_body.fbtrace_id, 'fb_trace_test_detached_ok');
    } finally {
      setCapiRetryFetcherForTesting(null);
    }
  });

  it('Task 3: CAPI Retry Worker records network failures cleanly without holding DB connections', async () => {
    // Insert another failed log for retry
    let failLeadId = '';
    await withTenantTransaction(tenant1Id, async (client) => {
      const l = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, custom_fields)
         VALUES ($1, $2, $3, 'assigned', 'CAPI Network Fail Lead', '0944556677', '{}'::jsonb)
         RETURNING id`,
        [tenant1Id, pipeline1Id, stage1Id]
      );
      failLeadId = l.rows[0].id;

      await client.query(
        `INSERT INTO capi_logs (tenant_id, lead_id, dataset_id, event_name, event_id, action_source, match_keys, sent_payload, response_status, sent_at)
         VALUES ($1, $2, '9876543210', 'Purchase', 'capi_evt_network_timeout', 'system_cron_retry', '{}'::jsonb, '{"data":[]}'::jsonb, 500, clock_timestamp() - INTERVAL '15 minutes')`,
        [tenant1Id, failLeadId]
      );
    });

    // Mock network fetcher throwing a network timeout error
    setCapiRetryFetcherForTesting(async () => {
      throw new Error('ETIMEDOUT: Connection to graph.facebook.com timed out after 8000ms');
    });

    try {
      const retriedCount = await runMetaCapiRetryWorker(tenant1Id);
      assert.equal(retriedCount, 0, 'Failed retry must not increment retriedSuccess count');

      // Verify that retry failure record was written with status 502 and error details
      const failureLog = await withTenantTransaction(tenant1Id, async (client) => {
        const res = await client.query<{ response_status: number; response_body: any }>(
          `SELECT response_status, response_body
           FROM capi_logs
           WHERE tenant_id = $1 AND lead_id = $2
           ORDER BY sent_at DESC
           LIMIT 1`,
          [tenant1Id, failLeadId]
        );
        return res.rows[0];
      });

      assert.equal(failureLog.response_status, 502);
      assert.ok(
        failureLog.response_body.error.includes('ETIMEDOUT'),
        'Must record timeout error message in response body'
      );
    } finally {
      setCapiRetryFetcherForTesting(null);
    }
  });
});
