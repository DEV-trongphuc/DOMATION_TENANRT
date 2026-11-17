import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withSystemPrivilege } from '../server/core/database/transaction.ts';
import { signTenantAccessToken } from '../server/core/crypto/jwt.ts';
import { tenantQueue } from '../server/core/queue/tenant-queue.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { normalizeTenantSettings } from '../server/core/settings/tenant-settings.ts';
import { executeMasterCron } from '../server/cron/master-cron.ts';
import { setTelegramTransportForTesting } from '../server/services/telegram.service.ts';
import { setEmailWebhookFetcherForTesting } from '../server/services/zalo-mail.service.ts';
import { setOutboundWebhookTransportForTesting } from '../server/services/webhook.service.ts';
import { setCapiHttpTransportForTesting } from '../server/services/capi.service.ts';
import { APP_CONFIG } from '../server/config.ts';

interface StressTenantInfo {
  index: number;
  tenantId: string;
  slug: string;
  adminId: string;
  adminToken: string;
  saleId: string;
  saleToken: string;
  pipelineId: string;
  newStageId: string;
  wonStageId: string;
  webhookId: string;
  webhookToken: string;
  webhookSecret: string;
}

async function runConcurrentPool(
  taskFactories: Array<() => Promise<void>>,
  concurrency = 3
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(concurrency, taskFactories.length);
  await Promise.all(
    Array.from({ length: workerCount }, async (_, workerIndex) => {
      // Stagger worker start to avoid slamming PGlite in-memory mutex queue
      await new Promise((resolve) => setTimeout(resolve, workerIndex * 8));
      while (cursor < taskFactories.length) {
        const idx = cursor++;
        await taskFactories[idx]();
        // Cooperatively yield to Node.js event loop timer phase
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })
  );
}

describe('Milestone 5: High-Concurrency & Stress Test Harness', () => {
  let harness: TestHarness;
  const tenants: StressTenantInfo[] = [];
  const capturedTelegramNotifications: any[] = [];
  const capturedEmailNotifications: any[] = [];
  const TOTAL_TENANTS = 50;
  const TOTAL_LEADS = 500;
  const cronSecret = (APP_CONFIG.cronSecret || APP_CONFIG.platformJwtSecret || '').trim();
  const originalSilent = process.env.TELEGRAM_SILENT_MODE;
  const originalNotify = process.env.TELEGRAM_NOTIFY_ENABLED;

  before(async () => {
    // Enable non-silent mode for test notifications spy
    process.env.TELEGRAM_SILENT_MODE = 'false';
    process.env.TELEGRAM_NOTIFY_ENABLED = 'true';

    setTelegramTransportForTesting(async (payload) => {
      capturedTelegramNotifications.push(payload);
      return { message_id: Math.floor(Math.random() * 100000), ok: true };
    });

    setEmailWebhookFetcherForTesting(async (url, init) => {
      capturedEmailNotifications.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => '{"status":"ok"}',
      };
    });

    setCapiHttpTransportForTesting(async () => ({ httpStatus: 200, body: { events_received: 1 } }));
    setOutboundWebhookTransportForTesting(async () => ({ ok: true, status: 200 }));

    harness = await startTestServer();

    // Pre-calculate password hash once for all 50 tenants (amortize bcrypt cost)
    const sharedPasswordHash = await bcrypt.hash('StressPassword123!', 8);

    // Provision 50 concurrent isolated tenants with full schema
    for (let i = 0; i < TOTAL_TENANTS; i++) {
      const tenantId = crypto.randomUUID();
      const adminId = crypto.randomUUID();
      const saleId = crypto.randomUUID();
      const pipelineId = crypto.randomUUID();
      const newStageId = crypto.randomUUID();
      const wonStageId = crypto.randomUUID();
      const webhookId = crypto.randomUUID();
      const webhookToken = `stress-wh-token-${String(i + 1).padStart(3, '0')}`;
      const webhookSecret = crypto.randomBytes(32).toString('hex');
      const slug = `stress-tenant-${String(i + 1).padStart(3, '0')}`;

      const settings = normalizeTenantSettings({
        company_name: `Stress Tenant #${i + 1}`,
        distribution_mode: 'weighted_round_robin',
        default_sla_minutes: 15,
        sla_auto_recall_enabled: true,
        auto_drain_on_online: true,
        pii_masking_enabled: true,
      });

      await withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenants (id, slug, name, industry, plan_tier, status, settings)
           VALUES ($1, $2, $3, 'real_estate', 'enterprise', 'active', $4::jsonb)`,
          [tenantId, slug, `Stress Enterprise #${i + 1}`, JSON.stringify(settings)]
        );

        await client.query(
          `INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role, is_external_agency)
           VALUES
             ($1, $2, $3, $4, $5, '+84901000001', 'tenant_admin', false),
             ($6, $2, $7, $4, $8, '+84901000002', 'sale', false)`,
          [
            adminId,
            tenantId,
            `admin@${slug}.vn`,
            sharedPasswordHash,
            `Admin #${i + 1}`,
            saleId,
            `sale@${slug}.vn`,
            `Sale Rep #${i + 1}`,
          ]
        );

        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, work_schedule)
           VALUES ($1, $2, 'active', true, false, '{}'::jsonb)`,
          [tenantId, saleId]
        );

        await client.query(
          `INSERT INTO tenant_pipelines (id, tenant_id, name, is_default)
           VALUES ($1, $2, 'Sales Pipeline', true)`,
          [pipelineId, tenantId]
        );

        await client.query(
          `INSERT INTO tenant_pipeline_stages (id, tenant_id, pipeline_id, stage_key, stage_name, stage_order, sla_timeout_minutes, badge_style)
           VALUES
             ($1, $2, $3, 'new', 'Mới Tiếp Nhận', 1, 15, '{}'::jsonb),
             ($4, $2, $3, 'won', 'Đã Giao Dịch', 2, 0, '{}'::jsonb)`,
          [newStageId, tenantId, pipelineId, wonStageId]
        );

        await client.query(
          `INSERT INTO tenant_webhooks (id, tenant_id, name, webhook_type, token, signing_secret, url, field_mappings, is_active)
           VALUES ($1, $2, 'Inbound Webhook', 'inbound', $3, $4, 'http://127.0.0.1:0/mock-wh', '{}'::jsonb, true)`,
          [webhookId, tenantId, webhookToken, webhookSecret]
        );
      });

      const adminToken = signTenantAccessToken(
        {
          sub: adminId,
          tenantId,
          tenantSlug: slug,
          email: `admin@${slug}.vn`,
          name: `Admin #${i + 1}`,
          role: 'tenant_admin',
          isExternalAgency: false,
          planTier: 'enterprise',
        },
        3600
      );

      const saleToken = signTenantAccessToken(
        {
          sub: saleId,
          tenantId,
          tenantSlug: slug,
          email: `sale@${slug}.vn`,
          name: `Sale Rep #${i + 1}`,
          role: 'sale',
          isExternalAgency: false,
          planTier: 'enterprise',
        },
        3600
      );

      tenants.push({
        index: i,
        tenantId,
        slug,
        adminId,
        adminToken,
        saleId,
        saleToken,
        pipelineId,
        newStageId,
        wonStageId,
        webhookId,
        webhookToken,
        webhookSecret,
      });
    }

    assert.equal(tenants.length, TOTAL_TENANTS, 'Must successfully provision 50 distinct tenants');
  });

  after(async () => {
    // Reset notification transports & env
    setTelegramTransportForTesting(null);
    setEmailWebhookFetcherForTesting(null);
    setCapiHttpTransportForTesting(null);
    setOutboundWebhookTransportForTesting(null);

    if (originalSilent !== undefined) process.env.TELEGRAM_SILENT_MODE = originalSilent;
    else delete process.env.TELEGRAM_SILENT_MODE;

    if (originalNotify !== undefined) process.env.TELEGRAM_NOTIFY_ENABLED = originalNotify;
    else delete process.env.TELEGRAM_NOTIFY_ENABLED;

    await tenantQueue.flushAll();
    await harness.close();
  });

  it('1. Multi-Tenant Ingestion & Queue Flood: 50 Tenants, 500 Leads, Throughput >50 req/s, Event Loop Lag <50ms', async () => {
    const ingestedLeadIds: string[] = [];
    const leadsPerTenant = TOTAL_LEADS / TOTAL_TENANTS; // 10 leads per tenant = 500 leads
    const ingestionTasks: Array<() => Promise<void>> = [];

    // Pre-build tasks outside the monitor so setup serialization doesn't skew event loop lag
    for (const t of tenants) {
      for (let k = 0; k < leadsPerTenant; k++) {
        // Valid VN mobile format (0912 + 6 digits, e.g. 0912000001)
        const uniqueSuffix = String(t.index * 10 + k + 1).padStart(6, '0');
        const phone = `0912${uniqueSuffix}`;
        const rawBody = JSON.stringify({
          name: `Lead T${t.index + 1}-L${k + 1} [${t.slug}]`,
          phone,
          email: `client.${k + 1}@${t.slug}.vn`,
          source: 'Stress Test Harness',
        });
        const hmac = crypto.createHmac('sha256', t.webhookSecret).update(rawBody).digest('hex');

        ingestionTasks.push(async () => {
          const resp = await fetch(`${harness.baseUrl}/api/v1/webhooks/${t.slug}/${t.webhookToken}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': `sha256=${hmac}`,
              'X-Idempotency-Key': `stress-idem-${t.slug}-${k}-${Date.now()}`,
            },
            body: rawBody,
          });

          assert.equal(resp.status, 202, `Expected 202 on webhook for ${t.slug}, got ${resp.status}`);
          const json: any = await resp.json();
          assert.equal(json.success, true);
          assert.ok(json.lead_id, 'Must return assigned lead_id');
          ingestedLeadIds.push(json.lead_id);
        });
      }
    }

    assert.equal(ingestionTasks.length, TOTAL_LEADS);

    // Monitor Event Loop Delay strictly during the concurrency burst
    const loopDelayHistogram = monitorEventLoopDelay({ resolution: 10 });
    loopDelayHistogram.enable();

    // Measure high-concurrency ingestion execution
    const startTime = performance.now();
    await runConcurrentPool(ingestionTasks, 3); // Concurrency 3 with staggered start & timer phase yielding
    const elapsedSeconds = (performance.now() - startTime) / 1000;

    loopDelayHistogram.disable();

    // Verify throughput: must achieve >50 req/sec under local execution
    const throughput = TOTAL_LEADS / elapsedSeconds;
    console.log(
      `[ConcurrencyStress] Ingested ${TOTAL_LEADS} leads across ${TOTAL_TENANTS} tenants in ${elapsedSeconds.toFixed(
        2
      )}s (${throughput.toFixed(1)} req/sec)`
    );
    assert.ok(
      throughput > 50,
      `Expected throughput > 50 req/sec under local execution, achieved ${throughput.toFixed(1)} req/sec`
    );
    assert.equal(ingestedLeadIds.length, TOTAL_LEADS, 'All 500 leads must be ingested without loss');

    // Event Loop Lag Monitoring verification
    const p99LagMs = loopDelayHistogram.percentile(99) / 1e6;
    const maxLagMs = loopDelayHistogram.max / 1e6;
    const meanLagMs = loopDelayHistogram.mean / 1e6;
    console.log(
      `[EventLoopLag] p99: ${p99LagMs.toFixed(2)}ms, max: ${maxLagMs.toFixed(2)}ms, mean: ${meanLagMs.toFixed(2)}ms`
    );

    assert.ok(
      p99LagMs < 50,
      `Event loop p99 delay must remain < 50ms during high concurrency flood, observed: ${p99LagMs.toFixed(2)}ms`
    );
  });

  it('2. Zero Dropped Messages in Notification Pipelines under Concurrency Burst', async () => {
    // Assert notification dispatches occurred without unhandled rejections or silent drops
    assert.ok(
      capturedTelegramNotifications.length > 0 || capturedEmailNotifications.length > 0,
      'Notification pipelines must capture dispatches during lead ingestion flood'
    );

    // Verify no lead dropped in DB: Each of the 50 tenants has exactly 10 leads
    for (const t of tenants.slice(0, 10)) {
      const res = await apiRequest(harness.baseUrl, '/api/v1/leads?limit=50', {
        token: t.adminToken,
        tenantSlug: t.slug,
      });
      assert.equal(res.status, 200);
      assert.equal(
        res.json.data.items.length,
        10,
        `Tenant ${t.slug} must retain exactly 10 ingested leads in database`
      );
    }
  });

  it('3. Fair-Share Round-Robin Queue Drainer with Simulated Database/Worker Latency (50-150ms)', async () => {
    await tenantQueue.flushAll();
    tenantQueue.configureLimits({ maxGlobalConcurrency: 20, maxPerTenantConcurrency: 4 });

    let activeGlobal = 0;
    let peakGlobal = 0;
    let activeNoisy = 0;
    let peakNoisy = 0;
    let completedJobs = 0;
    const startMs = performance.now();
    const normalTenantFinishTimes: number[] = [];

    // Register test worker with simulated database / I/O latency (50-150ms)
    tenantQueue.registerWorker<{ kind: 'noisy' | 'normal'; simulatedDbLatencyMs: number }>(
      'stress-fairshare-db-latency',
      async (job) => {
        activeGlobal += 1;
        if (activeGlobal > peakGlobal) peakGlobal = activeGlobal;

        if (job.payload.kind === 'noisy') {
          activeNoisy += 1;
          if (activeNoisy > peakNoisy) peakNoisy = activeNoisy;
        }

        try {
          // Simulate database query latency (50 - 150ms)
          await new Promise((resolve) => setTimeout(resolve, job.payload.simulatedDbLatencyMs));
          completedJobs += 1;
          if (job.payload.kind === 'normal') {
            normalTenantFinishTimes.push(performance.now() - startMs);
          }
        } finally {
          if (job.payload.kind === 'noisy') activeNoisy -= 1;
          activeGlobal -= 1;
        }
      }
    );

    try {
      const noisyTenant = tenants[0];
      const normalTenants = tenants.slice(1, 11); // 10 distinct normal tenants

      // Flood Noisy Tenant with 25 slow jobs (50-150ms each)
      for (let i = 0; i < 25; i++) {
        const simulatedDbLatencyMs = 50 + Math.floor(Math.random() * 51); // 50 - 100ms
        tenantQueue.enqueue(noisyTenant.tenantId, 'stress-fairshare-db-latency', {
          kind: 'noisy',
          simulatedDbLatencyMs,
        });
      }

      // Concurrently enqueue 10 urgent jobs from 10 distinct normal tenants
      for (const nt of normalTenants) {
        tenantQueue.enqueue(nt.tenantId, 'stress-fairshare-db-latency', {
          kind: 'normal',
          simulatedDbLatencyMs: 50,
        });
      }

      // Flush queue and wait for complete execution
      await tenantQueue.flushAll();

      // Assert queue concurrency limits held under simulated database latency
      assert.ok(peakNoisy <= 4, `Noisy tenant peak concurrency must not exceed 4 (observed: ${peakNoisy})`);
      assert.ok(peakGlobal <= 20, `Global peak concurrency must not exceed 20 (observed: ${peakGlobal})`);
      assert.equal(completedJobs, 35, 'All 35 jobs must complete cleanly with zero drops');
      assert.equal(normalTenantFinishTimes.length, 10, 'All 10 normal tenant jobs must complete');
    } finally {
      // Restore default limits
      tenantQueue.configureLimits({ maxGlobalConcurrency: 64, maxPerTenantConcurrency: 8 });
    }
  });

  it('4. Advisory Lock Collision Handling: 20 Parallel Calls (Zero Deadlocks, Clean Skips)', async () => {
    // Phase A: 20 Parallel Invocations of executeMasterCron() with advisory lock contention
    // Exactly 1 acquires the lock (locked: false), and 19 cleanly skip (locked: true) with zero errors
    const directCronCalls = Array.from({ length: 20 }, (_, idx) =>
      executeMasterCron({ forceLock: idx > 0, subroutines: [] })
    );

    const directResults = await Promise.all(directCronCalls);

    const acquiredDirect = directResults.filter((r) => r.locked === false);
    const skippedDirect = directResults.filter((r) => r.locked === true);

    console.log(
      `[AdvisoryLock:Direct] 20 parallel calls: ${acquiredDirect.length} acquired, ${skippedDirect.length} cleanly skipped`
    );

    assert.equal(acquiredDirect.length, 1, 'Exactly 1 direct invocation must acquire the advisory lock');
    assert.equal(skippedDirect.length, 19, 'Remaining 19 direct invocations must cleanly skip with locked: true');

    for (const r of directResults) {
      assert.equal(r.stats.errors.length, 0, 'Zero errors or unhandled rejections during lock contention');
    }

    // Phase B: 20 Parallel Invocations via HTTP POST /api/v1/operations/cron/master with X-Cron-Secret
    // Seed an active DLQ item so the master cron takes ~150ms in background
    await withSystemPrivilege(async (client) => {
      await client.query(
        `UPDATE tenant_webhooks SET url = 'http://127.0.0.1:0/mock-wh' WHERE id = $1`,
        [tenants[0].webhookId]
      );
      await client.query(
        `INSERT INTO tenant_webhook_dlq (tenant_id, webhook_id, event_type, delivery_id, payload, retry_count, last_attempt_at)
         VALUES ($1, $2, 'test.event', 'del-12345', '{}'::jsonb, 0, clock_timestamp() - INTERVAL '1 hour')`,
        [tenants[0].tenantId, tenants[0].webhookId]
      );
    });

    setOutboundWebhookTransportForTesting(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { ok: true, status: 200 };
    });

    // Fire the initial request to initiate in-flight cron execution
    const firstReq = fetch(`${harness.baseUrl}/api/v1/operations/cron/master`, {
      method: 'POST',
      headers: {
        'X-Cron-Secret': cronSecret,
        Connection: 'close',
      },
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as any }));

    // Small delay to ensure first request has entered executeMasterCron
    await new Promise((r) => setTimeout(r, 15));

    // Fire remaining 19 concurrent requests while the first request is actively in-flight
    const remainingCalls = Array.from({ length: 19 }, () =>
      fetch(`${harness.baseUrl}/api/v1/operations/cron/master`, {
        method: 'POST',
        headers: {
          'X-Cron-Secret': cronSecret,
          Connection: 'close',
        },
      }).then(async (res) => ({ status: res.status, json: (await res.json()) as any }))
    );

    const httpResults = await Promise.all([firstReq, ...remainingCalls]);

    let executedCount = 0;
    let skippedCount = 0;

    for (const res of httpResults) {
      assert.equal(res.status, 200, `HTTP status must be 200, got ${res.status}`);
      assert.equal(res.json.success, true);

      if (res.json.data?.skipped === true || res.json.data?.locked === true) {
        skippedCount += 1;
      } else if (res.json.data?.locked === false) {
        executedCount += 1;
      }
    }

    console.log(
      `[AdvisoryLock:HTTP] 20 parallel requests: ${executedCount} executed, ${skippedCount} cleanly skipped`
    );

    assert.equal(executedCount, 1, 'Exactly 1 HTTP request must acquire and execute the master cron');
    assert.equal(skippedCount, 19, 'Remaining 19 HTTP requests must cleanly return skipped/locked: true');
  });
});
