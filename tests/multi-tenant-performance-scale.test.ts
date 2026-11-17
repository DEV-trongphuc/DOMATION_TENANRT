import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import { signTenantAccessToken, verifyTenantAccessToken } from '../server/core/crypto/jwt.ts';
import {
  encryptTenantSecret,
  decryptTenantSecret,
  clearVaultKeyCacheForTesting,
} from '../server/core/crypto/vault.ts';
import { tenantQueue } from '../server/core/queue/tenant-queue.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { normalizeTenantSettings } from '../server/core/settings/tenant-settings.ts';
import { seedTenantWorkspace } from '../server/services/preset.service.ts';
import { sweepExpiredSlaTimeouts } from '../server/services/distribution.service.ts';
import { setCapiHttpTransportForTesting } from '../server/services/capi.service.ts';

interface ProvisionedScaleTenant {
  index: number;
  tenantId: string;
  slug: string;
  adminId: string;
  adminToken: string;
  internalSaleId: string;
  internalSaleToken: string;
  agencySaleId: string;
  agencySaleToken: string;
  pipelineId: string;
  wonStageId: string;
  webhookToken: string;
  webhookSecret: string;
}

async function runConcurrentPool(
  taskFactories: Array<() => Promise<void>>,
  concurrency = 150
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(concurrency, taskFactories.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < taskFactories.length) {
        const idx = cursor++;
        await taskFactories[idx]();
      }
    })
  );
}

describe('Phase 8: Multi-Tenant High-Concurrency Scale (120+ Tenants, 1,200+ Concurrent Ops, Fair-Share Queue & Zero-Hardcode Settings)', () => {
  let harness: TestHarness;
  const scaleTenants: ProvisionedScaleTenant[] = [];

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    await tenantQueue.flushAll();
    await harness.close();
  });

  it('1. Sustains 120 active tenants & 1,200+ simultaneous mixed user/webhook HTTP operations with zero cross-tenant leakage', async () => {
    const TOTAL_TENANTS = 120;
    const sharedHash = await bcrypt.hash('ScaleTestPass123!', 8);
    const industries = ['real_estate', 'education', 'healthcare', 'b2b'];

    // Provision 120 genuine PostgreSQL RLS-isolated tenants (360 users, 120 pipelines, 120 HMAC webhooks)
    for (let i = 0; i < TOTAL_TENANTS; i++) {
      const tenantId = crypto.randomUUID();
      const adminId = crypto.randomUUID();
      const slug = `scale-tenant-${String(i + 1).padStart(3, '0')}`;
      const industry = industries[i % industries.length];
      const settings = normalizeTenantSettings({
        capi_event_source_name: `AutoData Scale Source #${i + 1}`,
        session_ttl_minutes: 90,
        pii_masking_enabled: true,
        pii_mask_phone_prefix: 4,
        pii_mask_phone_suffix: 3,
        pii_mask_char: '*',
        role_permissions: {
          allow_manager_export_csv: false,
          allow_manager_manage_pipelines: false,
          allow_sale_create_lead: true,
          allow_sale_reassign_lead: true,
        },
      });

      const provisioned = await withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenants (id, slug, name, industry, plan_tier, status, settings)
           VALUES ($1, $2, $3, $4, 'enterprise', 'active', $5::jsonb)`,
          [tenantId, slug, `Scale Enterprise #${i + 1}`, industry, JSON.stringify(settings)]
        );

        await client.query(
          `INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role, is_external_agency)
           VALUES ($1, $2, $3, $4, $5, $6, 'tenant_admin', false)`,
          [adminId, tenantId, `ceo@${slug}.vn`, sharedHash, `CEO #${i + 1}`, `+84901${String(100000 + i)}`]
        );

        const seedInfo = await seedTenantWorkspace(client, {
          tenantId,
          tenantSlug: slug,
          adminName: `CEO #${i + 1}`,
          adminUserId: adminId,
          industry,
          options: {
            seedDemoLeads: false,
            defaultPasswordHash: sharedHash,
            initialSales: [
              {
                full_name: `Sale Nội Bộ #${i + 1}`,
                email: `sale.in@${slug}.vn`,
                is_external_agency: false,
                is_available: true,
                receive_ratio: 2,
              },
              {
                full_name: `Đại Lý F1 #${i + 1}`,
                email: `sale.f1@${slug}.vn`,
                is_external_agency: true,
                is_available: true,
                receive_ratio: 1,
              },
            ],
            capiConfig: {
              dataset_id: `PIXEL_${i + 1}`,
              access_token: 'sandbox_demo_capi_token',
            },
          },
        });

        const salesRes = await client.query<{
          id: string;
          email: string;
          full_name: string;
          is_external_agency: boolean;
        }>(
          `SELECT id, email, full_name, is_external_agency
           FROM users
           WHERE tenant_id = $1 AND role = 'sale'
           ORDER BY is_external_agency ASC`,
          [tenantId]
        );

        const whRes = await client.query<{ token: string; signing_secret: string }>(
          `SELECT token, signing_secret
           FROM tenant_webhooks
           WHERE tenant_id = $1 AND webhook_type = 'inbound'
           LIMIT 1`,
          [tenantId]
        );

        const stageRes = await client.query<{ id: string }>(
          `SELECT id FROM tenant_pipeline_stages
           WHERE tenant_id = $1 AND pipeline_id = $2
           ORDER BY stage_order DESC LIMIT 1`,
          [tenantId, seedInfo.pipelineId]
        );

        return {
          pipelineId: seedInfo.pipelineId,
          wonStageId: stageRes.rows[0].id,
          internalSale: salesRes.rows.find((s) => !s.is_external_agency)!,
          agencySale: salesRes.rows.find((s) => s.is_external_agency)!,
          webhook: whRes.rows[0],
        };
      });

      const adminToken = signTenantAccessToken(
        {
          sub: adminId,
          tenantId,
          tenantSlug: slug,
          email: `ceo@${slug}.vn`,
          name: `CEO #${i + 1}`,
          role: 'tenant_admin',
          isExternalAgency: false,
          planTier: 'enterprise',
        },
        90 * 60
      );

      const internalSaleToken = signTenantAccessToken(
        {
          sub: provisioned.internalSale.id,
          tenantId,
          tenantSlug: slug,
          email: provisioned.internalSale.email,
          name: provisioned.internalSale.full_name,
          role: 'sale',
          isExternalAgency: false,
          planTier: 'enterprise',
        },
        90 * 60
      );

      const agencySaleToken = signTenantAccessToken(
        {
          sub: provisioned.agencySale.id,
          tenantId,
          tenantSlug: slug,
          email: provisioned.agencySale.email,
          name: provisioned.agencySale.full_name,
          role: 'sale',
          isExternalAgency: true,
          planTier: 'enterprise',
        },
        90 * 60
      );

      scaleTenants.push({
        index: i,
        tenantId,
        slug,
        adminId,
        adminToken,
        internalSaleId: provisioned.internalSale.id,
        internalSaleToken,
        agencySaleId: provisioned.agencySale.id,
        agencySaleToken,
        pipelineId: provisioned.pipelineId,
        wonStageId: provisioned.wonStageId,
        webhookToken: provisioned.webhook.token,
        webhookSecret: provisioned.webhook.signing_secret,
      });
    }

    assert.equal(scaleTenants.length, 120);

    // Phase A + B: Build 1,200 mixed Webhook + Authenticated User/Admin operations across all 120 tenants & 360 users
    const createdLeadIdsByTenant = new Map<string, string[]>();
    const mixedTaskFactories: Array<() => Promise<void>> = [];

    for (const t of scaleTenants) {
      createdLeadIdsByTenant.set(t.tenantId, []);
      for (let k = 0; k < 3; k++) {
        const uniqueSuffix = String(t.index * 10 + k).padStart(6, '0');
        const phone = `0912${uniqueSuffix}`;
        const rawBody = JSON.stringify({
          name: `Khách T${t.index + 1}-L${k + 1} [${t.slug}]`,
          phone,
          email: `lead.${k + 1}@${t.slug}.vn`,
          source: `Campaign-${t.slug}`,
          custom_fields: { budget: 2500000000 },
        });
        const hmac = crypto.createHmac('sha256', t.webhookSecret).update(rawBody).digest('hex');

        mixedTaskFactories.push(async () => {
          const resp = await fetch(`${harness.baseUrl}/api/v1/webhooks/${t.slug}/${t.webhookToken}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': `sha256=${hmac}`,
              'X-Idempotency-Key': `scale-idem-${t.slug}-${k}`,
            },
            body: rawBody,
          });
          assert.equal(resp.status, 202, `Expected 202 on webhook for ${t.slug}, got ${resp.status}`);
          const json: any = await resp.json();
          assert.equal(json.success, true);
          assert.ok(json.lead_id);
          createdLeadIdsByTenant.get(t.tenantId)!.push(json.lead_id);
        });
      }

      // 1. Admin KPI Summary
      mixedTaskFactories.push(async () => {
        const res = await apiRequest(harness.baseUrl, `/api/v1/leads/stats/summary?pipeline_id=${t.pipelineId}`, {
          token: t.adminToken,
          tenantSlug: t.slug,
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
      });

      // 2. Admin Staff Roster (hash-CTE aggregation)
      mixedTaskFactories.push(async () => {
        const res = await apiRequest(harness.baseUrl, '/api/v1/users?limit=50', {
          token: t.adminToken,
          tenantSlug: t.slug,
        });
        assert.equal(res.status, 200);
        const users = res.json.data.items as Array<{ email: string }>;
        assert.equal(users.length, 3);
        assert.ok(
          users.some((u) => u.email === `ceo@${t.slug}.vn`),
          `Admin roster for ${t.slug} must contain its own CEO`
        );
      });

      // 3. Internal Sale Peer Discovery
      mixedTaskFactories.push(async () => {
        const res = await apiRequest(harness.baseUrl, '/api/v1/users/peers', {
          token: t.internalSaleToken,
          tenantSlug: t.slug,
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.data.items.length, 3);
      });

      // 4. Internal Sale Lead Queue
      mixedTaskFactories.push(async () => {
        const res = await apiRequest(harness.baseUrl, '/api/v1/leads?limit=50', {
          token: t.internalSaleToken,
          tenantSlug: t.slug,
        });
        assert.equal(res.status, 200);
        for (const item of res.json.data.items) {
          assert.ok(
            String(item.name).includes(`[${t.slug}]`),
            `Leakage detected! Tenant ${t.slug} saw foreign lead ${item.name}`
          );
        }
      });

      // 5. External Agency F1 Lead Queue (verifying PII masking under concurrency)
      mixedTaskFactories.push(async () => {
        const res = await apiRequest(harness.baseUrl, '/api/v1/leads?limit=50', {
          token: t.agencySaleToken,
          tenantSlug: t.slug,
        });
        assert.equal(res.status, 200);
        for (const item of res.json.data.items) {
          assert.ok(
            String(item.name).includes(`[${t.slug}]`),
            `Leakage detected! Agency in ${t.slug} saw foreign lead ${item.name}`
          );
          assert.ok(
            String(item.phone).includes('***'),
            `Unmasked phone leaked to External Agency F1 in ${t.slug}: ${item.phone}`
          );
        }
      });

      // 6. Pipeline Metadata Fetch
      mixedTaskFactories.push(async () => {
        const res = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
          token: t.adminToken,
          tenantSlug: t.slug,
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.data[0].id, t.pipelineId);
      });

      // 7. Cross-Tenant Penetration Probe under heavy load (Token of Tenant i against Tenant (i+1)%120 MUST fail 403)
      const neighborSlug = scaleTenants[(t.index + 1) % scaleTenants.length].slug;
      mixedTaskFactories.push(async () => {
        const res = await apiRequest(harness.baseUrl, '/api/v1/leads', {
          token: t.adminToken,
          tenantSlug: neighborSlug,
        });
        assert.equal(res.status, 403, `Cross-tenant token probe ${t.slug} -> ${neighborSlug} must return 403`);
      });
    }

    assert.equal(mixedTaskFactories.length, 1200);
    await runConcurrentPool(mixedTaskFactories, 120);

    // Phase C: 120 Stage Transitions + Meta CAPI v21.0 dispatches + 240 strict Tenant Isolation & PII Audits (360 more concurrent ops)
    await runConcurrentPool(
      scaleTenants.map((t) => async () => {
        const tenantLeadIds = createdLeadIdsByTenant.get(t.tenantId)!;
        assert.equal(tenantLeadIds.length, 3);

        const moveRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${tenantLeadIds[0]}/stage`, {
          method: 'PATCH',
          token: t.adminToken,
          tenantSlug: t.slug,
          body: { stage_id: t.wonStageId },
        });
        assert.equal(moveRes.status, 200);

        const [adminLeads, f1Leads] = await Promise.all([
          apiRequest(harness.baseUrl, '/api/v1/leads?limit=50', {
            token: t.adminToken,
            tenantSlug: t.slug,
          }),
          apiRequest(harness.baseUrl, '/api/v1/leads?limit=50', {
            token: t.agencySaleToken,
            tenantSlug: t.slug,
          }),
        ]);
        assert.equal(adminLeads.status, 200);
        assert.equal(adminLeads.json.data.items.length, 3);
        for (const lead of adminLeads.json.data.items) {
          assert.ok(String(lead.name).includes(`[${t.slug}]`));
        }
        assert.equal(f1Leads.status, 200);
        assert.ok(f1Leads.json.data.items.length >= 1, `Expected F1 sale in ${t.slug} to receive at least 1 lead`);
        for (const lead of f1Leads.json.data.items) {
          assert.ok(String(lead.name).includes(`[${t.slug}]`));
          assert.match(String(lead.phone), /\*{3,}/);
        }
      }),
      80
    );

    // Phase D: Verify Super Admin Platform Console CTE Aggregation over 120+ tenants completes rapidly
    const saLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(saLogin.status, 200);
    const saToken = saLogin.json.data.access_token as string;

    const t0 = performance.now();
    const saTenants = await apiRequest(harness.baseUrl, '/api/v1/admin/tenants?limit=200', {
      token: saToken,
    });
    const adminListMs = performance.now() - t0;
    assert.equal(saTenants.status, 200);
    assert.equal(saTenants.json.data.total_tenants, 120);
    assert.equal(saTenants.json.data.total_leads_platform, 360);
    assert.ok(adminListMs < 500, `Expected hash-CTE /admin/tenants over 120 tenants in <500ms, got ${adminListMs.toFixed(1)}ms`);
  });

  it('2. Isolates Noisy-Neighbor Backlog via Fair-Share Round-Robin Queue & Per-Tenant Concurrency Cap', async () => {
    await tenantQueue.flushAll();
    tenantQueue.configureLimits({ maxGlobalConcurrency: 12, maxPerTenantConcurrency: 3 });

    let activeGlobal = 0;
    let peakGlobal = 0;
    let activeNoisy = 0;
    let peakNoisy = 0;
    const normalFinishTimesMs: number[] = [];
    const startMs = performance.now();

    tenantQueue.registerWorker<{ kind: 'noisy' | 'normal'; delayMs: number }>('scale-fairshare-test', async (job) => {
      activeGlobal += 1;
      if (activeGlobal > peakGlobal) peakGlobal = activeGlobal;
      if (job.payload.kind === 'noisy') {
        activeNoisy += 1;
        if (activeNoisy > peakNoisy) peakNoisy = activeNoisy;
      }

      try {
        await new Promise((r) => setTimeout(r, job.payload.delayMs));
        if (job.payload.kind === 'normal') {
          normalFinishTimesMs.push(performance.now() - startMs);
        }
      } finally {
        if (job.payload.kind === 'noisy') activeNoisy -= 1;
        activeGlobal -= 1;
      }
    });

    try {
      // Flood Noisy Tenant #1 with 75 slow jobs (20ms each => ~500ms total backlog at cap=3)
      for (let i = 0; i < 75; i++) {
        tenantQueue.enqueue(scaleTenants[0].tenantId, 'scale-fairshare-test', {
          kind: 'noisy',
          delayMs: 20,
        });
      }

      // Immediately enqueue 24 urgent jobs from 24 distinct Normal Tenants (#2..#25)
      for (let tIdx = 1; tIdx <= 24; tIdx++) {
        tenantQueue.enqueue(scaleTenants[tIdx].tenantId, 'scale-fairshare-test', {
          kind: 'normal',
          delayMs: 10,
        });
      }

      await tenantQueue.flushAll();

      assert.ok(peakNoisy <= 3, `Noisy tenant exceeded per-tenant cap of 3: observed ${peakNoisy}`);
      assert.ok(peakGlobal <= 12, `Global queue exceeded global cap of 12: observed ${peakGlobal}`);
      assert.equal(normalFinishTimesMs.length, 24);

      const maxNormalFinishMs = Math.max(...normalFinishTimesMs);
      assert.ok(
        maxNormalFinishMs < 220,
        `Fair-share starvation! Normal tenants waited ${maxNormalFinishMs.toFixed(1)}ms behind noisy tenant backlog`
      );
    } finally {
      tenantQueue.configureLimits({ maxGlobalConcurrency: 64, maxPerTenantConcurrency: 8 });
    }
  });

  it('3. Accelerates AES-256-GCM Vault PBKDF2 Key Derivation via Bounded LRU Cache without weakening cross-tenant auth', () => {
    clearVaultKeyCacheForTesting();
    const tenantIds = Array.from({ length: 50 }, () => crypto.randomUUID());

    // Cold-warm the 50 distinct tenant keys once (50 x 100k PBKDF2 iterations)
    for (const tid of tenantIds) {
      encryptTenantSecret(tid, { warm: true });
    }

    const t0 = performance.now();
    const samples: Array<{ tenantId: string; enc: ReturnType<typeof encryptTenantSecret> }> = [];

    // Measure 2,000 hot encrypt + decrypt cycles (4,000 key accesses) across 50 tenants
    for (let i = 0; i < 2000; i++) {
      const tid = tenantIds[i % tenantIds.length];
      const secretPayload = { access_token: `tok_${i}`, dataset_id: `ds_${tid.slice(0, 8)}` };
      const enc = encryptTenantSecret(tid, secretPayload);
      const dec = decryptTenantSecret<{ access_token: string; dataset_id: string }>(
        tid,
        enc.configEncrypted,
        enc.iv,
        enc.authTag
      );
      assert.equal(dec.access_token, `tok_${i}`);
      if (i < 2) samples.push({ tenantId: tid, enc });
    }
    const elapsedMs = performance.now() - t0;

    // Uncached 4,000 x 100k PBKDF2 iterations stalls the event loop for ~44,000ms; LRU-cached completes in <120ms!
    assert.ok(
      elapsedMs < 150,
      `Expected 2,000 Vault encrypt+decrypt cycles across 50 tenants in <150ms, got ${elapsedMs.toFixed(1)}ms`
    );

    // Cross-tenant decrypt MUST still fail GCM authentication tag verification
    assert.throws(() => {
      decryptTenantSecret(
        samples[1].tenantId,
        samples[0].enc.configEncrypted,
        samples[0].enc.iv,
        samples[0].enc.authTag
      );
    });
  });

  it('4. Executes SLA Timeout Sweeper in O(expired) across 120 tenants and <15ms when idle', async () => {
    const now = Date.now();

    // Ensure future (non-expired) SLA deadlines exist across 117 tenants in 'sla_queue'
    for (let i = 3; i < scaleTenants.length; i++) {
      const t = scaleTenants[i];
      await tenantRedis.zadd('sla_queue', now + 600_000, `future-lead-${i}:stage-${i}`, t.tenantId);
    }

    // Register 3 expired SLA deadlines on real leads in Tenants #0, #1, #2
    const targetLeadIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = scaleTenants[i];
      const leadInfo = await withTenantTransaction(t.tenantId, async (client) => {
        const r = await client.query<{ id: string; stage_id: string }>(
          `SELECT id, stage_id FROM leads
           WHERE tenant_id = $1 AND is_accepted = false
           LIMIT 1`,
          [t.tenantId]
        );
        return r.rows[0];
      });
      assert.ok(leadInfo, `Expected unaccepted lead in ${t.slug}`);
      targetLeadIds.push(leadInfo.id);
      await tenantRedis.zadd('sla_queue', now - 5_000, `${leadInfo.id}:${leadInfo.stage_id}`, t.tenantId);
    }

    const breachedCount1 = await sweepExpiredSlaTimeouts();
    assert.ok(breachedCount1 >= 3, `Expected at least 3 SLA breaches, got ${breachedCount1}`);

    // Verify all 3 leads were marked sla_breached = true in PostgreSQL
    for (let i = 0; i < 3; i++) {
      const t = scaleTenants[i];
      const row = await withTenantTransaction(t.tenantId, async (client) => {
        const r = await client.query<{ sla_breached: boolean }>(
          'SELECT sla_breached FROM leads WHERE tenant_id = $1 AND id = $2',
          [t.tenantId, targetLeadIds[i]]
        );
        return r.rows[0];
      });
      assert.equal(row?.sla_breached, true);
    }

    // Immediate 2nd sweep across 120 tenants (all remaining timers are in the future) -> 0 DB queries, <15ms!
    const idleStart = performance.now();
    const breachedCount2 = await sweepExpiredSlaTimeouts();
    const idleMs = performance.now() - idleStart;
    assert.equal(breachedCount2, 0);
    assert.ok(idleMs < 15, `Expected O(1) idle SLA sweep across 120 tenants in <15ms, got ${idleMs.toFixed(2)}ms`);
  });

  it('5. Enforces Zero-Hardcode Custom Settings (session_ttl_minutes, max_page_size, max_export_rows, capi_event_source_name) & Instant Cache Invalidation', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Zero Hardcode Enterprise',
        tenant_slug: 'zero-hardcode-ent',
        admin_name: 'Lê Kiến Trúc',
        work_email: 'admin@zerohardcode.vn',
        phone: '0919888777',
        password: 'ZeroHardcodePass123!',
        industry: 'b2b',
        seed_demo_leads: true,
        capi_config: {
          dataset_id: 'PIXEL_CUSTOM_999',
          access_token: 'sandbox_demo_capi_token',
        },
        custom_settings: {
          session_ttl_minutes: 180,
          max_page_size: 10,
          max_export_rows: 10,
          capi_timeout_ms: 4500,
          capi_event_source_name: 'Turnio Quiet-Luxury Signal Hub',
        },
      },
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.data.expires_in, 180 * 60);

    const regClaims = verifyTenantAccessToken(reg.json.data.access_token);
    assert.equal(regClaims.exp - regClaims.iat, 180 * 60);

    // Login must also honor per-tenant `session_ttl_minutes`
    const loginRes = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        tenant_slug: 'zero-hardcode-ent',
        email: 'admin@zerohardcode.vn',
        password: 'ZeroHardcodePass123!',
      },
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.json.data.expires_in, 180 * 60);
    const token = loginRes.json.data.access_token as string;
    const tenantId = loginRes.json.data.tenant.id as string;

    // Add 8 more leads (5 seeded + 8 created = 13 total leads) so we exceed the 10-row caps
    for (let j = 0; j < 8; j++) {
      const cr = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token,
        tenantSlug: 'zero-hardcode-ent',
        body: {
          name: `Khách B2B #${j + 1}`,
          phone: `09381002${String(10 + j)}`,
        },
      });
      assert.equal(cr.status, 201);
    }

    // `max_page_size = 10` clamps `?limit=500` to 10 items out of 13 total (total_pages = 2)
    const listClamped = await apiRequest(harness.baseUrl, '/api/v1/leads?limit=500', {
      token,
      tenantSlug: 'zero-hardcode-ent',
    });
    assert.equal(listClamped.status, 200);
    assert.equal(listClamped.json.data.items.length, 10);
    assert.equal(listClamped.json.data.pagination.total, 13);
    assert.equal(listClamped.json.data.pagination.total_pages, 2);

    // `max_export_rows = 10` caps CSV export rows (13 total leads -> 1 header + 10 rows max!)
    const csvResp = await fetch(`${harness.baseUrl}/api/v1/leads/export`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Slug': 'zero-hardcode-ent',
      },
    });
    assert.equal(csvResp.status, 200);
    const csvText = (await csvResp.text()).replace(/^\uFEFF/, '').trim();
    const csvLines = csvText.split(/\r?\n/);
    assert.equal(csvLines.length, 1 + 10, `Expected 1 header + 10 capped CSV rows, got ${csvLines.length}`);

    // `capi_event_source_name` propagates into both `/capi/test-event` and real stage CAPI payload logged in `capi_logs`
    const capiTest = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/test-event', {
      method: 'POST',
      token,
      tenantSlug: 'zero-hardcode-ent',
      body: { event_name: 'Schedule', deal_value: 95000000 },
    });
    assert.equal(capiTest.status, 200);
    assert.equal(capiTest.json.data.event_source_name, 'Turnio Quiet-Luxury Signal Hub');

    // Move a persisted lead to a stage with CAPI mapping to verify `capi_logs.sent_payload`
    const pipesRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token,
      tenantSlug: 'zero-hardcode-ent',
    });
    assert.equal(pipesRes.status, 200);
    const targetLead = listClamped.json.data.items[0];
    const capiStage = (pipesRes.json.data[0]?.stages || []).find(
      (s: any) =>
        s.id !== targetLead.stage_id && s.capi_event_mapping && s.capi_event_mapping !== 'Skip'
    );
    assert.ok(capiStage, 'Expected seeded pipeline to contain at least one distinct CAPI-mapped stage');

    const targetLeadId = targetLead.id as string;
    const stageMoveRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${targetLeadId}/stage`, {
      method: 'PATCH',
      token,
      tenantSlug: 'zero-hardcode-ent',
      body: { stage_id: capiStage.id },
    });
    assert.equal(stageMoveRes.status, 200);

    const capiLogPayload = await withTenantTransaction(tenantId, async (client) => {
      const r = await client.query<{ sent_payload: any }>(
        'SELECT sent_payload FROM capi_logs WHERE tenant_id = $1 ORDER BY sent_at DESC LIMIT 1',
        [tenantId]
      );
      return r.rows[0]?.sent_payload;
    });
    assert.equal(
      capiLogPayload?.data?.[0]?.custom_data?.lead_event_source,
      'Turnio Quiet-Luxury Signal Hub'
    );

    // Update `max_page_size` to 25 via PATCH /auth/tenant-settings -> cache invalidates immediately on next GET!
    const patchCfg = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token,
      tenantSlug: 'zero-hardcode-ent',
      body: { settings: { max_page_size: 25 } },
    });
    assert.equal(patchCfg.status, 200);

    const listUpdated = await apiRequest(harness.baseUrl, '/api/v1/leads?limit=500', {
      token,
      tenantSlug: 'zero-hardcode-ent',
    });
    assert.equal(listUpdated.status, 200);
    assert.equal(listUpdated.json.data.items.length, 13);
    assert.equal(listUpdated.json.data.pagination.total_pages, 1);
  });

  it('6. Compresses >1KB API JSON responses with Async Gzip when Accept-Encoding includes gzip', async () => {
    const saLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(saLogin.status, 200);
    const saToken = saLogin.json.data.access_token as string;

    // Request raw HTTP stream via node:http to inspect raw wire Content-Encoding & compressed bytes
    const httpMod = await import('node:http');
    const urlObj = new URL(`${harness.baseUrl}/api/v1/admin/tenants?limit=200`);

    const rawResult = await new Promise<{
      statusCode: number;
      contentEncoding: string | undefined;
      vary: string | undefined;
      rawBytes: Buffer;
    }>((resolve, reject) => {
      const req = httpMod.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${saToken}`,
            'Accept-Encoding': 'gzip',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              contentEncoding: res.headers['content-encoding'] as string | undefined,
              vary: res.headers['vary'] as string | undefined,
              rawBytes: Buffer.concat(chunks),
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(rawResult.statusCode, 200);
    assert.equal(rawResult.contentEncoding, 'gzip');
    assert.match(String(rawResult.vary || ''), /Accept-Encoding/i);

    const decompressed = zlib.gunzipSync(rawResult.rawBytes).toString('utf8');
    assert.ok(
      rawResult.rawBytes.length < Buffer.byteLength(decompressed, 'utf8'),
      `Expected gzip payload (${rawResult.rawBytes.length}B) to be smaller than raw JSON (${Buffer.byteLength(decompressed, 'utf8')}B)`
    );
    const parsed = JSON.parse(decompressed);
    assert.equal(parsed.success, true);
    assert.ok(parsed.data.items.length >= 120);
  });

  it('7. Detaches Live Slow Meta Graph API CAPI Calls (250ms Dual-Send) from DB Transactions so Other Tenants Never Stall', async () => {
    const t0Tenant = scaleTenants[0];

    // Seed 12 leads in Tenant #0 so we can trigger 12 concurrent Dual-Send Live CAPI stage transitions (24 Graph API calls)
    const stageLeadIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const cr = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: t0Tenant.adminToken,
        tenantSlug: t0Tenant.slug,
        body: {
          name: `Live CAPI Stress Lead #${i + 1}`,
          phone: `097788${String(1000 + i)}`,
        },
      });
      assert.equal(cr.status, 201);
      stageLeadIds.push(cr.json.data.id as string);
    }

    // Enable Live HTTP + Dual-Send on Tenant #0's Meta CAPI Vault
    const saveVault = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/meta_capi', {
      method: 'PUT',
      token: t0Tenant.adminToken,
      tenantSlug: t0Tenant.slug,
      body: {
        dataset_id: 'LIVE_PRIMARY_PIXEL_001',
        access_token: 'EAAB_LIVE_PRIMARY_TOKEN_001',
        live_http_enabled: true,
        dual_send: true,
        agency_dataset_id: 'LIVE_AGENCY_PIXEL_002',
        agency_access_token: 'EAAB_LIVE_AGENCY_TOKEN_002',
      },
    });
    assert.equal(saveVault.status, 200);

    let externalHttpCalls = 0;
    setCapiHttpTransportForTesting(async (url) => {
      externalHttpCalls += 1;
      await new Promise((r) => setTimeout(r, 240));
      return {
        httpStatus: 200,
        body: {
          events_received: 1,
          fbtrace_id: `trace_live_${externalHttpCalls}`,
          target_url: url,
        },
      };
    });

    try {
      const wallStart = performance.now();

      // Launch all 12 slow Live Dual-Send CAPI stage transitions concurrently
      const slowCapiMoves = Promise.all(
        stageLeadIds.map((lid) =>
          apiRequest(harness.baseUrl, `/api/v1/leads/${lid}/stage`, {
            method: 'PATCH',
            token: t0Tenant.adminToken,
            tenantSlug: t0Tenant.slug,
            body: { stage_id: t0Tenant.wonStageId, deal_value: 150000000 },
          })
        )
      );

      // Wait 30ms so all 12 stage transitions are actively awaiting the 240ms Meta Graph API HTTP calls
      await new Promise((r) => setTimeout(r, 30));

      // Concurrently execute 20 DB-backed requests across Tenants #1..#20 — they MUST NOT wait behind Tenant #0's 240ms HTTP calls!
      const neighborLatenciesMs: number[] = [];
      await Promise.all(
        scaleTenants.slice(1, 21).map(async (nt) => {
          const reqStart = performance.now();
          const res = await apiRequest(harness.baseUrl, '/api/v1/leads?limit=20', {
            token: nt.adminToken,
            tenantSlug: nt.slug,
          });
          neighborLatenciesMs.push(performance.now() - reqStart);
          assert.equal(res.status, 200);
        })
      );

      const moveResults = await slowCapiMoves;
      const totalWallMs = performance.now() - wallStart;

      for (const mr of moveResults) {
        assert.equal(mr.status, 200);
        assert.equal(mr.json.data.capi_dispatched?.status, 200);
      }
      assert.equal(externalHttpCalls, 24, 'Expected 12 primary + 12 Dual-Send Graph API HTTP calls');

      const sortedLat = [...neighborLatenciesMs].sort((a, b) => a - b);
      const medianNeighborMs = sortedLat[Math.floor(sortedLat.length / 2)];
      assert.ok(
        medianNeighborMs < 150,
        `Neighbor tenants stalled (${medianNeighborMs.toFixed(1)}ms median) while Tenant #0 awaited Meta Graph API!`
      );
      // Parallel detached Dual-Send finishes all 24 x 240ms HTTP calls in ~250-900ms instead of 12 * 480ms = 5,760ms sequential DB lock!
      assert.ok(
        totalWallMs < 1800,
        `Expected detached parallel Dual-Send CAPI moves in <1800ms, got ${totalWallMs.toFixed(1)}ms`
      );
    } finally {
      setCapiHttpTransportForTesting(null);
    }
  });

  it('8. Enforces Instant RBAC Demotion, F1 External Agency PII Masking & Password-Reset Token Revocation Without Stale JWT Delay', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Instant RBAC Security Corp',
        tenant_slug: 'instant-rbac-corp',
        admin_name: 'CEO Security',
        work_email: 'ceo@instantrbac.vn',
        phone: '0918222333',
        password: 'AdminPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
        custom_settings: {
          session_ttl_minutes: 10080, // 7-day access token TTL
          pii_masking_enabled: true,
        },
      },
    });
    assert.equal(reg.status, 201);
    const adminToken = reg.json.data.access_token as string;

    // Create a Manager account (internal, non-F1)
    const createStaff = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug: 'instant-rbac-corp',
      body: {
        full_name: 'Trần Quản Lý',
        email: 'manager@instantrbac.vn',
        phone: '0918444555',
        password: 'InitialStaffPass123!',
        role: 'manager',
        is_external_agency: false,
      },
    });
    assert.equal(createStaff.status, 201);
    const staffId = createStaff.json.data.id as string;

    // Assign a lead with raw phone 0909555888 to this staff member
    const createLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug: 'instant-rbac-corp',
      body: {
        name: 'Khách VIP Bảo Mật',
        phone: '0909555888',
        email: 'vip.secret@client.vn',
        assigned_to: staffId,
      },
    });
    assert.equal(createLead.status, 201);

    // Staff logs in -> receives 7-day JWT with role='manager', isExternalAgency=false
    const staffLogin1 = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        tenant_slug: 'instant-rbac-corp',
        email: 'manager@instantrbac.vn',
        password: 'InitialStaffPass123!',
      },
    });
    assert.equal(staffLogin1.status, 200);
    const oldJwt = staffLogin1.json.data.access_token as string;

    // Verify Manager access works and sees unmasked phone before demotion
    const rosterBefore = await apiRequest(harness.baseUrl, '/api/v1/users', {
      token: oldJwt,
      tenantSlug: 'instant-rbac-corp',
    });
    assert.equal(rosterBefore.status, 200);

    const leadsBefore = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: oldJwt,
      tenantSlug: 'instant-rbac-corp',
    });
    assert.equal(leadsBefore.status, 200);
    assert.ok(!String(leadsBefore.json.data.items[0].phone).includes('*'));

    // Admin demotes Manager -> External Agency F1 Sale via PATCH /users/:id
    const demoteRes = await apiRequest(harness.baseUrl, `/api/v1/users/${staffId}`, {
      method: 'PATCH',
      token: adminToken,
      tenantSlug: 'instant-rbac-corp',
      body: {
        role: 'sale',
        is_external_agency: true,
      },
    });
    assert.equal(demoteRes.status, 200);

    // Reusing the SAME 7-day JWT MUST immediately lose Manager access AND mask PII!
    const rosterAfterDemote = await apiRequest(harness.baseUrl, '/api/v1/users', {
      token: oldJwt,
      tenantSlug: 'instant-rbac-corp',
    });
    assert.equal(rosterAfterDemote.status, 403, 'Demoted manager JWT must immediately be blocked from /users');

    const leadsAfterDemote = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: oldJwt,
      tenantSlug: 'instant-rbac-corp',
    });
    assert.equal(leadsAfterDemote.status, 200);
    assert.match(
      String(leadsAfterDemote.json.data.items[0].phone),
      /\*{3,}/,
      'F1 PII masking must apply immediately to existing JWTs upon PATCH /users/:id'
    );

    // Admin resets staff password -> old JWT must be immediately revoked (401), and re-login with new password must work!
    const resetPwRes = await apiRequest(harness.baseUrl, `/api/v1/users/${staffId}`, {
      method: 'PATCH',
      token: adminToken,
      tenantSlug: 'instant-rbac-corp',
      body: {
        password: 'NewRotatedStaffPass999!',
      },
    });
    assert.equal(resetPwRes.status, 200);

    const afterPwResetProbe = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: oldJwt,
      tenantSlug: 'instant-rbac-corp',
    });
    assert.equal(afterPwResetProbe.status, 401, 'Old JWT must be revoked immediately when admin rotates user password');

    const staffLogin2 = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        tenant_slug: 'instant-rbac-corp',
        email: 'manager@instantrbac.vn',
        password: 'NewRotatedStaffPass999!',
      },
    });
    assert.equal(staffLogin2.status, 200);
    const freshCheck = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: staffLogin2.json.data.access_token,
      tenantSlug: 'instant-rbac-corp',
    });
    assert.equal(freshCheck.status, 200);
  });

  it('9. Offloads Concurrent Bcrypt Logins to Worker Threads, Enforces Pre-DB Zalo Bot Rate-Limiting & Honors Custom Refresh/Zalo TTLs', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Worker Crypto & TTL Corp',
        tenant_slug: 'worker-ttl-corp',
        admin_name: 'Admin Crypto',
        work_email: 'admin@workerttl.vn',
        phone: '0917666555',
        password: 'WorkerCryptoPass123!',
        industry: 'education',
        seed_demo_leads: false,
        custom_settings: {
          refresh_token_ttl_days: 30,
          zalo_token_ttl_hours: 48,
          zalo_rate_limit_per_sec: 3,
        },
      },
    });
    assert.equal(reg.status, 201);
    const token = reg.json.data.access_token as string;
    const tenantId = reg.json.data.tenant.id as string;

    // Decode refresh_token JWT payload to verify `refresh_token_ttl_days = 30` (2,592,000s, not hardcoded 7d)
    const refreshParts = String(reg.json.data.refresh_token).split('.');
    const refreshClaims = JSON.parse(Buffer.from(refreshParts[1], 'base64url').toString('utf8'));
    assert.equal(refreshClaims.exp - refreshClaims.iat, 30 * 86_400);

    // Save Zalo Bot Vault -> verify `token_expires_at` honors `zalo_token_ttl_hours = 48` (not hardcoded 25h)
    const beforeVaultMs = Date.now();
    const saveZalo = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/zalo_bot', {
      method: 'PUT',
      token,
      tenantSlug: 'worker-ttl-corp',
      body: {
        bot_token: 'zalo_bot_custom_ttl_tok',
        group_chat_id: '-999888777',
      },
    });
    assert.equal(saveZalo.status, 200);

    const expiryRow = await withTenantTransaction(tenantId, async (client) => {
      const r = await client.query<{ token_expires_at: string }>(
        "SELECT token_expires_at FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'zalo_bot'",
        [tenantId]
      );
      return r.rows[0];
    });
    const ttlHoursObserved = (new Date(expiryRow.token_expires_at).getTime() - beforeVaultMs) / 3_600_000;
    assert.ok(
      ttlHoursObserved > 47.5 && ttlHoursObserved < 48.5,
      `Expected ~48h Zalo token TTL from tenant custom settings, got ${ttlHoursObserved.toFixed(2)}h`
    );

    // Flood public Zalo Bot webhook with 20 simultaneous requests -> token bucket (`3/s`) rejects excess in O(1) memory
    const zaloBurst = await Promise.all(
      Array.from({ length: 20 }, (_, idx) =>
        apiRequest(harness.baseUrl, '/api/v1/webhooks/zalo/worker-ttl-corp', {
          method: 'POST',
          body: { chat_id: '-999888777', sender_id: `u_${idx}`, text: '/chatid' },
        })
      )
    );
    const rateLimitedCount = zaloBurst.filter((r) => r.json?.data?.command === 'rate_limited').length;
    assert.ok(rateLimitedCount >= 14, `Expected >=14 burst Zalo commands to be rate-limited, got ${rateLimitedCount}`);

    // Measure main-thread V8 event-loop responsiveness during 16 concurrent bcrypt logins
    let maxLoopLagMs = 0;
    let lastTick = performance.now();
    const lagTimer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - lastTick - 10);
      if (lag > maxLoopLagMs) maxLoopLagMs = lag;
      lastTick = now;
    }, 10);

    try {
      const loginBurst = await Promise.all(
        Array.from({ length: 16 }, () =>
          apiRequest(harness.baseUrl, '/api/v1/auth/login', {
            method: 'POST',
            body: {
              tenant_slug: 'worker-ttl-corp',
              email: 'admin@workerttl.vn',
              password: 'WorkerCryptoPass123!',
            },
          })
        )
      );
      for (const lr of loginBurst) {
        assert.equal(lr.status, 200);
      }
    } finally {
      clearInterval(lagTimer);
    }

    // Main-thread synchronous bcrypt x 16 would block the event loop for ~800-1,200ms; worker pool keeps main loop responsive!
    assert.ok(
      maxLoopLagMs < 250,
      `Main V8 event loop blocked for ${maxLoopLagMs.toFixed(1)}ms during 16 concurrent logins`
    );
  });

  it('10. Honors RFC 9110 Accept-Encoding q=0 Opt-Out, Sets Vary: Accept-Encoding Consistently & Streams Gzipped CSV Exports', async () => {
    const saLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(saLogin.status, 200);
    const saToken = saLogin.json.data.access_token as string;

    const httpMod = await import('node:http');
    const rawHttpGet = (pathWithQuery: string, headers: Record<string, string>) => {
      const u = new URL(`${harness.baseUrl}${pathWithQuery}`);
      return new Promise<{
        statusCode: number;
        contentEncoding: string | undefined;
        contentType: string | undefined;
        vary: string | undefined;
        rawBytes: Buffer;
      }>((resolve, reject) => {
        const req = httpMod.request(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: 'GET',
            headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () =>
              resolve({
                statusCode: res.statusCode || 0,
                contentEncoding: res.headers['content-encoding'] as string | undefined,
                contentType: res.headers['content-type'] as string | undefined,
                vary: res.headers['vary'] as string | undefined,
                rawBytes: Buffer.concat(chunks),
              })
            );
          }
        );
        req.on('error', reject);
        req.end();
      });
    };

    // 1. `Accept-Encoding: gzip;q=0` on a >50KB payload MUST NOT compress, yet MUST set `Vary: Accept-Encoding`
    const optOutRes = await rawHttpGet('/api/v1/admin/tenants?limit=200', {
      Authorization: `Bearer ${saToken}`,
      'Accept-Encoding': 'gzip;q=0, identity;q=1',
    });
    assert.equal(optOutRes.statusCode, 200);
    assert.equal(optOutRes.contentEncoding, undefined, 'Must not gzip when client specifies gzip;q=0');
    assert.match(String(optOutRes.vary || ''), /Accept-Encoding/i);
    const plainJson = JSON.parse(optOutRes.rawBytes.toString('utf8'));
    assert.equal(plainJson.success, true);

    // 2. Small `<1KB` JSON (`/api/v1/health`) MUST also advertise `Vary: Accept-Encoding` for CDN safety
    const healthRes = await rawHttpGet('/api/v1/health', {
      'Accept-Encoding': 'gzip',
    });
    assert.equal(healthRes.statusCode, 200);
    assert.match(String(healthRes.vary || ''), /Accept-Encoding/i);

    // 3. Keyset-streamed CSV export compresses cleanly when `Accept-Encoding: gzip` and >8 rows
    const csvGzipRes = await rawHttpGet('/api/v1/leads/export?header_style=machine', {
      Authorization: `Bearer ${scaleTenants[0].adminToken}`,
      'X-Tenant-Slug': scaleTenants[0].slug,
      'Accept-Encoding': 'gzip',
    });
    assert.equal(csvGzipRes.statusCode, 200);
    assert.equal(csvGzipRes.contentEncoding, 'gzip');
    assert.match(String(csvGzipRes.contentType || ''), /text\/csv/i);
    const csvBody = zlib.gunzipSync(csvGzipRes.rawBytes).toString('utf8');
    assert.ok(csvBody.startsWith('\uFEFFlead_id,name,phone,email'));
    const exportedLines = csvBody.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    assert.ok(exportedLines.length >= 16, `Expected header + >=15 leads for Tenant #0, got ${exportedLines.length}`);
  });
});
