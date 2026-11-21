import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPO_ROOT,
  assertNotLivePgDataDir,
  assertTestRecipientsOnly,
  buildSyntheticMyerpSql,
  createIsolatedContext,
  loginSuperAdmin,
  makeTestRecipient,
  runCliSubprocess,
  seedIdeasTenant,
  seedSiblingTenant,
  signSnsNotification,
  triggerMasterCron,
} from './harness.ts';
import {
  clearVaultKeyCacheForTesting,
  decryptTenantSecret,
  encryptTenantSecret,
} from '../../server/core/crypto/vault.ts';
import { APP_CONFIG } from '../../server/config.ts';
import { sendZaloBotNotification } from '../../server/services/zalo-mail.service.ts';
import { sendTenantZnsMessage } from '../../server/services/zalo-zns.service.ts';

const MIGRATE_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'migrate-myerp-ideas.ts');

function allocateTempPgDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assertNotLivePgDataDir(dir, REPO_ROOT, 'tier2_f1_f8 tempPgDir');
  return dir;
}

function db(target: { pool: { connect: () => Promise<{ query: <R extends Record<string, any> = any>(sql: string, params?: any[]) => Promise<{ rows: R[] }>; release: () => void }> } }) {
  return {
    async query<R extends Record<string, any> = any>(sql: string, params?: any[]): Promise<{ rows: R[] }> {
      const client = await target.pool.connect();
      try {
        return await client.query<R>(sql, params);
      } finally {
        client.release();
      }
    },
  };
}

// ============================================================================
// F1: Tenant `ideas` Provisioning & Entitlements (Tier 2 — Boundary & Negative)
// ============================================================================
describe('Tier 2 — Feature F1: Tenant `ideas` Provisioning & Entitlements', () => {
  it('[F1][T2] all PROMAX ERP endpoints strictly return 403 MODULE_NOT_ENTITLED on ideas growth_combo owner', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
      });

      const promaxEndpoints = [
        '/api/v1/hrm/overview',
        '/api/v1/attendance/overview',
        '/api/v1/payroll/config',
        '/api/v1/approvals/overview',
        '/api/v1/projects/overview',
        '/api/v1/finance/dashboard',
        '/api/v1/inventory/overview',
        '/api/v1/erp-ops/drive',
        '/api/v1/workchat/bootstrap',
      ];

      for (const ep of promaxEndpoints) {
        const res = await ctx.apiRaw(ep, { token: ideas.accessToken, tenantSlug: 'ideas' });
        assert.equal(res.status, 403, `Expected 403 on '${ep}', got ${res.status}: ${res.rawText}`);
        assert.equal(res.json?.success, false);
        assert.equal(res.json?.error?.code, 'MODULE_NOT_ENTITLED', `Expected MODULE_NOT_ENTITLED on '${ep}'`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T2] explicit education_addon=false disables /education/* even when industry_key=education & mascot stays false', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const tenant = await seedIdeasTenant(ctx, {
        slug: 'ideas-no-edu',
        packageCode: 'growth_combo',
        industry: 'education',
      });

      const toggleOff = await ctx.apiJson('/api/v1/billing/switch-package', {
        method: 'POST',
        token: tenant.accessToken,
        tenantSlug: 'ideas-no-edu',
        body: { package_code: 'growth_combo', education_addon: false },
      });
      assert.equal(toggleOff.success, true);

      const me = await ctx.apiJson('/api/v1/auth/me', {
        token: tenant.accessToken,
        tenantSlug: 'ideas-no-edu',
      });
      assert.equal(me.data.tenant.industry_key, 'education');
      assert.equal(me.data.tenant.entitlements.education_addon, false);
      assert.equal(me.data.tenant.entitlements.enable_ideas_mascot, false);
      assert.equal(me.data.tenant.enabled_modules.includes('education'), false);

      const eduRes = await ctx.apiRaw('/api/v1/education/courses', {
        token: tenant.accessToken,
        tenantSlug: 'ideas-no-edu',
      });
      assert.equal(eduRes.status, 403);
      assert.equal(eduRes.json?.error?.code, 'MODULE_NOT_ENTITLED');
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T2] cross-tenant X-Tenant-Slug header mismatch rejects with 403 TENANT_CONTEXT_MISMATCH', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const ecolife = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'autodata_crm' });

      const r1 = await ctx.apiRaw('/api/v1/leads', {
        token: ideas.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(r1.status, 403);
      assert.equal(r1.json?.error?.code, 'TENANT_CONTEXT_MISMATCH');

      const r2 = await ctx.apiRaw('/api/v1/leads', {
        token: ecolife.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(r2.status, 403);
      assert.equal(r2.json?.error?.code, 'TENANT_CONTEXT_MISMATCH');
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T2] suspended ideas tenant is blocked (403 TENANT_SUSPENDED) on CRM/Marketing while /billing/overview stays 200', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const sa = await loginSuperAdmin(ctx);
      assert.equal(sa.ok, true);

      const susp = await ctx.apiJson(`/api/v1/admin/tenants/${ideas.tenantId}`, {
        method: 'PATCH',
        token: sa.token,
        body: { status: 'suspended' },
      });
      assert.equal(susp.success, true);

      const leadsRes = await ctx.apiRaw('/api/v1/leads', { token: ideas.accessToken, tenantSlug: 'ideas' });
      assert.equal(leadsRes.status, 403);
      assert.equal(leadsRes.json?.error?.code, 'TENANT_SUSPENDED');

      const campRes = await ctx.apiRaw('/api/v1/marketing/campaigns', { token: ideas.accessToken, tenantSlug: 'ideas' });
      assert.equal(campRes.status, 403);
      assert.equal(campRes.json?.error?.code, 'TENANT_SUSPENDED');

      const billingRes = await ctx.apiRaw('/api/v1/billing/overview', { token: ideas.accessToken, tenantSlug: 'ideas' });
      assert.equal(billingRes.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T2] zero-balance switch-package and myerp package upgrade to domation_promax return 402 INSUFFICIENT_WALLET_BALANCE', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });

      const sw = await ctx.apiRaw('/api/v1/billing/switch-package', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { package_code: 'domation_promax', billing_cycle: 'annual' },
      });
      assert.equal(sw.status, 402);
      assert.equal(sw.json?.error?.code, 'INSUFFICIENT_WALLET_BALANCE');

      const upg = await ctx.apiRaw('/api/v1/myerp/package-entitlements/upgrade', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { package_code: 'domation_promax', billing_cycle: 'annual' },
      });
      assert.equal(upg.status, 402);
      assert.equal(upg.json?.error?.code, 'INSUFFICIENT_WALLET_BALANCE');

      const hrm = await ctx.apiRaw('/api/v1/hrm/overview', { token: ideas.accessToken, tenantSlug: 'ideas' });
      assert.equal(hrm.status, 403);
      assert.equal(hrm.json?.error?.code, 'MODULE_NOT_ENTITLED');
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T2] stale enabled_modules SQL injection on autodata_crm sibling never unlocks Marketing or PROMAX', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const sibling = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'autodata_crm' });

      await db(ctx).query(
        `UPDATE tenants SET enabled_modules = $2::jsonb WHERE id = $1`,
        [sibling.tenantId, JSON.stringify(['leads', 'mkt_campaigns', 'hrm'])]
      );
      await ctx.clearCaches();

      const camp = await ctx.apiRaw('/api/v1/marketing/campaigns', {
        token: sibling.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(camp.status, 403);
      assert.equal(camp.json?.error?.code, 'MODULE_NOT_ENTITLED');

      const hrm = await ctx.apiRaw('/api/v1/hrm/overview', {
        token: sibling.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(hrm.status, 403);
      assert.equal(hrm.json?.error?.code, 'MODULE_NOT_ENTITLED');
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F2: Deterministic ID Mapping & Pollution Filtering (Tier 2 — Boundary/Neg)
// ============================================================================
describe('Tier 2 — Feature F2: Deterministic ID Mapping & Pollution Filtering', () => {
  it('[F2][T2] --dry-run validates synthetic dump and emits summary without mutating target PGlite DB', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql();
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t2-1-');
    let ctx1: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;
    let ctx2: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      ctx1 = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      await seedSiblingTenant(ctx1, 'ecolife', { packageCode: 'autodata_crm' });
      await ctx1.close();
      ctx1 = null;

      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas', '--dry-run'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(cli.status, 0, `--dry-run failed: ${cli.stderr || cli.stdout}`);
      assert.ok(cli.stdout.trim().length > 0, 'Expected dry-run summary output');

      ctx2 = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const ideasCnt = await db(ctx2).query<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM tenants WHERE slug = 'ideas'`);
      assert.equal(ideasCnt.rows[0].cnt, 0, '--dry-run must NOT persist ideas tenant');
      const ecoCnt = await db(ctx2).query<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM tenants WHERE slug = 'ecolife'`);
      assert.equal(ecoCnt.rows[0].cnt, 1);
    } finally {
      if (ctx1) await ctx1.close();
      if (ctx2) await ctx2.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });

  it('[F2][T2] missing or non-existent --sql path exits non-zero without creating partial ideas tenant', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t2-2-');
    const missingPath = path.join(os.tmpdir(), `missing-myerp-${Date.now()}.sql`);
    let ctx: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', missingPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.notEqual(cli.status, 0, 'Missing --sql file must exit non-zero');

      ctx = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const ideasCnt = await db(ctx).query<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM tenants WHERE slug = 'ideas'`);
      assert.equal(ideasCnt.rows[0].cnt, 0);
    } finally {
      if (ctx) await ctx.close();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });

  it('[F2][T2] pre-existing sibling tenants (ecolife, ecolifesignature) remain 100% untouched across ideas migration & re-run', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql();
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t2-3-');
    let ctx1: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;
    let ctx2: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      ctx1 = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const eco = await seedSiblingTenant(ctx1, 'ecolife', { packageCode: 'autodata_crm' });
      const ecoSig = await seedSiblingTenant(ctx1, 'ecolifesignature', { packageCode: 'autodata_crm' });
      const ecoLead = await ctx1.apiJson('/api/v1/leads', {
        method: 'POST',
        token: eco.accessToken,
        tenantSlug: 'ecolife',
        body: { name: 'Ecolife Protected Lead', phone: '0909444555' },
      });
      await ctx1.close();
      ctx1 = null;

      for (const runIdx of [1, 2]) {
        const cli = await runCliSubprocess(
          ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
          { env: { PGLITE_DATA_DIR: pgDir } }
        );
        assert.equal(cli.status, 0, `Run #${runIdx} failed: ${cli.stderr || cli.stdout}`);
      }

      ctx2 = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const rows = await db(ctx2).query<{ slug: string; package_code: string }>(
        `SELECT slug, package_code FROM tenants WHERE id IN ($1, $2)`,
        [eco.tenantId, ecoSig.tenantId]
      );
      assert.equal(rows.rows.length, 2);
      assert.ok(rows.rows.every((r) => r.package_code === 'autodata_crm'));

      const ecoLeads = await db(ctx2).query<{ id: string; name: string }>(
        `SELECT id, name FROM leads WHERE tenant_id = $1`,
        [eco.tenantId]
      );
      assert.equal(ecoLeads.rows.length, 1);
      assert.equal(ecoLeads.rows[0].id, ecoLead.data.id);
    } finally {
      if (ctx1) await ctx1.close();
      if (ctx2) await ctx2.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });

  it('[F2][T2] refuses execution when postmaster.pid lockfile exists in target PGLITE_DATA_DIR', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql();
    const lockedDir = allocateTempPgDir('e2e-ideas-f2-t2-locked-');
    try {
      fs.writeFileSync(path.join(lockedDir, 'postmaster.pid'), '999999\n', 'utf8');
      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: lockedDir } }
      );
      assert.notEqual(cli.status, 0, 'Must refuse concurrent PGlite access when postmaster.pid exists');
      assert.ok(fs.existsSync(path.join(lockedDir, 'postmaster.pid')));
    } finally {
      dump.cleanup();
      fs.rmSync(lockedDir, { recursive: true, force: true });
    }
  });

  it('[F2][T2] handles escaped quotes/backslashes, NULL contact_id on bounced subscriber & 99999 email overlap safely', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql();
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t2-5-');
    let ctx: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      // Inject an escaped-quote contact and ensure null-contact subscriber (sub-ideas-0003) still maps cleanly
      const patchedSql = fs
        .readFileSync(dump.sqlPath, 'utf8')
        .replace('Tran Minh Khoa', "O\\'Brien & \"IDEAS\"");
      fs.writeFileSync(dump.sqlPath, patchedSql, 'utf8');

      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(cli.status, 0, `migrate-myerp-ideas failed: ${cli.stderr || cli.stdout}`);

      ctx = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const ideasRes = await db(ctx).query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'ideas'`);
      const ideasId = ideasRes.rows[0].id;

      const leadEsc = await db(ctx).query<{ name: string }>(
        `SELECT name FROM leads WHERE tenant_id = $1 AND name LIKE '%Brien%'`,
        [ideasId]
      );
      assert.equal(leadEsc.rows.length, 1);

      const bouncedSup = await db(ctx).query<{ recipient: string }>(
        `SELECT recipient FROM mkt_suppression_list WHERE tenant_id = $1 AND recipient = 'bounced.ideas@test-sink.domation.local'`,
        [ideasId]
      );
      assert.equal(bouncedSup.rows.length, 1);

      const badPoll = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM mkt_suppression_list WHERE recipient LIKE '%99999%'`
      );
      assert.equal(badPoll.rows[0].cnt, 0);
    } finally {
      if (ctx) await ctx.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// F3: Auto Data CRM Migration & API Behavior (Tier 2 — Boundary & Negative)
// ============================================================================
describe('Tier 2 — Feature F3: Auto Data CRM Boundaries & Error Handling', () => {
  it('[F3][T2] blocks blacklisted phone via Gatekeeper into held_leads (status=blacklisted)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const bl = await ctx.apiJson('/api/v1/operations/gatekeeper/blacklist', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { entry_type: 'phone', value: '0909998877', reason: 'Spam farm' },
      });
      assert.equal(bl.success, true);

      await ctx.apiRaw('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Blacklisted Caller', phone: '0909998877' },
      });

      const held = await ctx.apiJson('/api/v1/operations/gatekeeper/held-leads', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        query: { status: 'blacklisted' },
      });
      assert.ok(held.data.items.some((h: any) => String(h.phone).includes('909998877') && h.status === 'blacklisted'));
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T2] rejects duplicate phone with 409 DUPLICATE_LEAD_REJECTED under reject_duplicate policy', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        customSettings: { duplicate_action: 'reject_duplicate', duplicate_threshold_days: 30 },
      });

      const first = await ctx.apiRaw('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Original Lead', phone: '0911222333' },
      });
      assert.equal(first.status, 201);

      const second = await ctx.apiRaw('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Duplicate Lead', phone: '+84911222333' },
      });
      assert.equal(second.status, 409);
      assert.equal(second.json?.error?.code, 'DUPLICATE_LEAD_REJECTED');

      const cnt = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM leads WHERE tenant_id = $1 AND phone = '84911222333'`,
        [ideas.tenantId]
      );
      assert.equal(cnt.rows[0].cnt, 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T2] enforces stage transition validation (422 MISSING_STAGE_ID, 404 TARGET_STAGE_NOT_FOUND, 404 LEAD_NOT_FOUND)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Stage Boundary Lead', phone: '0912333444' },
      });

      const missingStage = await ctx.apiRaw(`/api/v1/leads/${lead.data.id}/stage`, {
        method: 'PATCH',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(missingStage.status, 422);
      assert.equal(missingStage.json?.error?.code, 'MISSING_STAGE_ID');

      const badStage = await ctx.apiRaw(`/api/v1/leads/${lead.data.id}/stage`, {
        method: 'PATCH',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { stage_id: '00000000-0000-4000-8000-000000000404' },
      });
      assert.equal(badStage.status, 404);
      assert.equal(badStage.json?.error?.code, 'TARGET_STAGE_NOT_FOUND');

      const pipes = await ctx.apiJson('/api/v1/pipelines', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const validStageId = pipes.data[0].stages[0].id;

      const badLead = await ctx.apiRaw('/api/v1/leads/00000000-0000-4000-8000-000000000404/stage', {
        method: 'PATCH',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { stage_id: validStageId },
      });
      assert.equal(badLead.status, 404);
      assert.equal(badLead.json?.error?.code, 'LEAD_NOT_FOUND');
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T2] blocks deleting last distribution round (422 CANNOT_DELETE_LAST_ROUND) & rejects invalid routing rule (422)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const rounds = await ctx.apiJson('/api/v1/pipelines/rounds/list', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(rounds.data.rounds.length, 1);
      const soleRoundId = rounds.data.rounds[0].id;

      const delLast = await ctx.apiRaw(`/api/v1/pipelines/rounds/${soleRoundId}`, {
        method: 'DELETE',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(delLast.status, 422);
      assert.equal(delLast.json?.error?.code, 'CANNOT_DELETE_LAST_ROUND');

      const badRule = await ctx.apiRaw('/api/v1/pipelines/routing-rules', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { rule_name: '' },
      });
      assert.equal(badRule.status, 422);
      assert.equal(badRule.json?.error?.code, 'VALIDATION_ERROR');
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T2] rejects contact missing both phone & email (400) and empty timeline note (422)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const badContact = await ctx.apiRaw('/api/v1/crm-360/contacts', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'No Contact Info' },
      });
      assert.equal(badContact.status, 400);
      assert.equal(badContact.json?.error?.code, 'CONTACT_PHONE_OR_EMAIL_REQUIRED');

      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Note Boundary Lead', phone: '0913444555' },
      });

      const emptyNote = await ctx.apiRaw(`/api/v1/leads/${lead.data.id}/timeline/notes`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { content: '   ' },
      });
      assert.equal(emptyNote.status, 422);
      assert.equal(emptyNote.json?.error?.code, 'EMPTY_NOTE');
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T2] enforces webhook signature/token/phone validation and strict cross-tenant lead isolation', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const ecolife = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'autodata_crm' });

      await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Secret IDEAS Lead', phone: '0914555666' },
      });

      const ecolifeLeads = await ctx.apiJson('/api/v1/leads', {
        token: ecolife.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(
        ecolifeLeads.data.items.some((l: any) => l.name === 'Secret IDEAS Lead'),
        false
      );

      const wh = await ctx.apiJson('/api/v1/integrations/webhooks', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Signed Inbound', webhook_type: 'inbound' },
      });

      const badSig = await ctx.apiRaw(`/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-signature': 'deadbeef0000' },
        body: JSON.stringify({ name: 'Bad Sig', phone: '0914555667' }),
      });
      assert.equal(badSig.status, 401);
      assert.equal(badSig.json?.error?.code, 'INVALID_WEBHOOK_SIGNATURE');

      const unknownWh = await ctx.apiRaw('/api/v1/webhooks/ideas/whk_does_not_exist', {
        method: 'POST',
        body: { name: 'Unknown Hook', phone: '0914555667' },
      });
      assert.equal(unknownWh.status, 404);
      assert.equal(unknownWh.json?.error?.code, 'WEBHOOK_NOT_FOUND_OR_INACTIVE');

      const badPhonePayload = JSON.stringify({ name: 'Bad Phone', phone: '12' });
      const validSig = crypto.createHmac('sha256', wh.data.signing_secret).update(badPhonePayload).digest('hex');
      const badPhone = await ctx.apiRaw(`/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-signature': validSig },
        body: badPhonePayload,
      });
      assert.equal(badPhone.status, 422);
      assert.equal(badPhone.json?.error?.code, 'WEBHOOK_INGEST_ERROR');
      assert.match(String(badPhone.json?.error?.message || ''), /^INVALID_PHONE/);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F4: Email Marketing & Suppression (Tier 2 — Boundary & Negative)
// ============================================================================
describe('Tier 2 — Feature F4: Email Marketing & Suppression Boundaries', () => {
  it('[F4][T2] rejects empty campaign name (422), empty template name (422) & invalid test-email (422)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });

      const badCamp = await ctx.apiRaw('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: '   ' },
      });
      assert.equal(badCamp.status, 422);
      assert.equal(badCamp.json?.error?.code, 'CAMPAIGN_NAME_REQUIRED');

      const badTpl = await ctx.apiRaw('/api/v1/marketing/templates', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: '' },
      });
      assert.equal(badTpl.status, 422);
      assert.equal(badTpl.json?.error?.code, 'TEMPLATE_NAME_REQUIRED');

      const camp = await ctx.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Valid Camp' },
      });

      const badTestEmail = await ctx.apiRaw(`/api/v1/marketing/campaigns/${camp.data.id}/test-email`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { to_email: 'not-an-email' },
      });
      assert.equal(badTestEmail.status, 422);
      assert.equal(badTestEmail.json?.error?.code, 'INVALID_TEST_EMAIL');
      assert.equal(ctx.smtp.messages.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T2] returns 404 TEMPLATE_NOT_FOUND for GET/PUT/DELETE on non-existent template UUID', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const missingId = '00000000-0000-4000-8000-000000000404';

      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await ctx.apiRaw(`/api/v1/marketing/templates/${missingId}`, {
          method,
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          ...(method === 'PUT' ? { body: { name: 'Updated' } } : {}),
        });
        assert.equal(res.status, 404, `Expected 404 on ${method}`);
        assert.equal(res.json?.error?.code, 'TEMPLATE_NOT_FOUND');
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T2] sending campaign to empty or 100%-suppressed audience produces newly_sent=0, 0 claims & 0 SMTP messages', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
      });

      const emptyAud = await ctx.apiJson('/api/v1/audiences', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Empty Audience', audience_type: 'static_list' },
      });

      const camp = await ctx.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Zero Reach Campaign', audience_id: emptyAud.data.id, channel: 'email' },
      });

      const sendRes = await ctx.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(sendRes.data.newly_sent, 0);
      assert.equal(ctx.smtp.messages.length, 0);

      const claims = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM mkt_send_claims WHERE campaign_id = $1`,
        [camp.data.id]
      );
      assert.equal(claims.rows[0].cnt, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T2] rejects tampered HMAC signature on public unsubscribe with 403 INVALID_UNSUBSCRIBE_SIGNATURE', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const email = makeTestRecipient('f4-unsub-bad');
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Unsub Guard', email },
      });

      const res = await ctx.apiRaw('/api/v1/public/marketing/unsubscribe', {
        query: {
          tenant_id: ideas.tenantId,
          lead_id: lead.data.id,
          channel: 'email',
          sig: '00deadbeef112233',
        },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json?.error?.code, 'INVALID_UNSUBSCRIBE_SIGNATURE');

      const row = await db(ctx).query<{ email_consent: string }>(
        `SELECT email_consent FROM leads WHERE id = $1`,
        [lead.data.id]
      );
      assert.equal(row.rows[0].email_consent, 'subscribed');
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T2] rejects empty suppression recipient (422) and invalid quick-send recipients (422)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });

      const badSup = await ctx.apiRaw('/api/v1/marketing/campaigns/suppression/list', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { channel: 'email', recipient: '' },
      });
      assert.equal(badSup.status, 422);
      assert.equal(badSup.json?.error?.code, 'RECIPIENT_REQUIRED');

      const badQs = await ctx.apiRaw('/api/v1/marketing/templates/quick-send', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { recipients: ['invalid-no-at-sign'] },
      });
      assert.equal(badQs.status, 422);
      assert.equal(badQs.json?.error?.code, 'RECIPIENTS_REQUIRED');
      assert.equal(ctx.smtp.messages.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T2] signed SES Permanent Bounce SNS notification suppresses lead and blocks future campaign delivery', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
      });

      const email = makeTestRecipient('f4-bounce');
      assertTestRecipientsOnly([email]);
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Bounce Target', email },
      });

      const aud = await ctx.apiJson('/api/v1/audiences', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Bounce Audience', audience_type: 'static_list' },
      });
      await ctx.apiJson(`/api/v1/audiences/${aud.data.id}/members`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_ids: [lead.data.id] },
      });

      const signed = signSnsNotification(ctx.snsSigner, {
        eventType: 'Bounce',
        bounceType: 'Permanent',
        recipients: [email],
        sourceEmail: 'noreply@test-sink.domation.local',
      });

      const snsRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: signed.headers,
        body: signed.rawBody,
      });
      assert.equal(snsRes.status, 200);

      const camp = await ctx.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Post-Bounce Campaign', audience_id: aud.data.id, channel: 'email' },
      });
      const sendRes = await ctx.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(sendRes.data.newly_sent, 0);
      assert.equal(ctx.smtp.messages.length, 0);

      const supRow = await db(ctx).query<{ recipient: string }>(
        `SELECT recipient FROM mkt_suppression_list WHERE tenant_id = $1 AND recipient = $2`,
        [ideas.tenantId, email.toLowerCase()]
      );
      assert.equal(supRow.rows.length, 1);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F5: Automation Flows, Forms, Surveys, Web Tracking & AI Bots (Tier 2)
// ============================================================================
describe('Tier 2 — Feature F5: Flows, Forms, Surveys, Vouchers & Bots Boundaries', () => {
  it('[F5][T2] validates flow empty name (422), missing lead_id on enroll (422) & unknown flow/lead UUID (404)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });

      const emptyName = await ctx.apiRaw('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: '' },
      });
      assert.equal(emptyName.status, 422);
      assert.equal(emptyName.json?.error?.code, 'FLOW_NAME_REQUIRED');

      const flow = await ctx.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Valid Flow' },
      });

      const missingLead = await ctx.apiRaw(`/api/v1/marketing/flows/${flow.data.id}/enroll`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(missingLead.status, 422);
      assert.equal(missingLead.json?.error?.code, 'LEAD_ID_REQUIRED');

      const unknownLead = await ctx.apiRaw(`/api/v1/marketing/flows/${flow.data.id}/enroll`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_id: '00000000-0000-4000-8000-000000000404' },
      });
      assert.equal(unknownLead.status, 404);
      assert.equal(unknownLead.json?.error?.code, 'FLOW_OR_LEAD_NOT_FOUND');
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T2] outbound webhook_http flow node SSRF targeting 169.254.169.254 is blocked with zero external HTTP calls', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'SSRF Lead', email: makeTestRecipient('f5-ssrf') },
      });

      const flow = await ctx.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'SSRF Test Flow',
          trigger_type: 'manual',
          steps: [
            {
              id: 'ssrf_node',
              type: 'webhook_http',
              label: 'Metadata Probe',
              config: { url: 'http://169.254.169.254/latest/meta-data/' },
            },
          ],
        },
      });
      await ctx.apiJson(`/api/v1/marketing/flows/${flow.data.id}/publish`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });

      const enroll = await ctx.apiRaw(`/api/v1/marketing/flows/${flow.data.id}/enroll`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_id: lead.data.id },
      });
      assert.ok(enroll.ok);
      assert.equal(
        ctx.mockFetch.requests.some((r) => r.url.includes('169.254.169.254')),
        false,
        'SSRF metadata URL must be blocked before fetch'
      );

      const tl = await db(ctx).query<{ event_type: string }>(
        `SELECT event_type FROM lead_timeline_events WHERE lead_id = $1 AND event_type = 'flow_webhook_blocked'`,
        [lead.data.id]
      );
      assert.equal(tl.rows.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T2] enforces form contact field requirement, unknown public token (404), missing submit contact (422) & OTP gate', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });

      const noContactField = await ctx.apiRaw('/api/v1/marketing/forms', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Invalid Schema Form',
          fields: [{ id: 'f1', key: 'company', label: 'Company', type: 'text', required: true }],
        },
      });
      assert.equal(noContactField.status, 422);
      assert.equal(noContactField.json?.error?.code, 'FORM_CONTACT_FIELD_REQUIRED');

      const unknownForm = await ctx.apiRaw('/api/v1/public/marketing/forms/frm_unknown_token_999');
      assert.equal(unknownForm.status, 404);
      assert.equal(unknownForm.json?.error?.code, 'PUBLIC_FORM_NOT_FOUND');

      const otpForm = await ctx.apiJson('/api/v1/marketing/forms', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'OTP Gated Form',
          require_otp: true,
          fields: [
            { id: 'f_name', key: 'name', label: 'Name', type: 'text', required: true },
            { id: 'f_email', key: 'email', label: 'Email', type: 'email', required: true },
          ],
        },
      });

      const emptySubmit = await ctx.apiRaw(`/api/v1/public/marketing/forms/${otpForm.data.public_token}/submit`, {
        method: 'POST',
        body: { name: 'Missing Contact' },
      });
      assert.equal(emptySubmit.status, 422);
      assert.equal(emptySubmit.json?.error?.code, 'CONTACT_REQUIRED');

      const badOtp = await ctx.apiRaw(`/api/v1/public/marketing/forms/${otpForm.data.public_token}/submit`, {
        method: 'POST',
        body: { name: 'OTP Fail', email: makeTestRecipient('f5-otp'), otp_code: '000000' },
      });
      assert.equal(badOtp.status, 422);
      assert.equal(badOtp.json?.error?.code, 'OTP_VERIFICATION_FAILED');
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T2] enforces voucher redeem boundaries (empty, unknown, min_order, already redeemed) & shortlink validation', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });

      const emptyCode = await ctx.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { code: '' },
      });
      assert.equal(emptyCode.status, 422);
      assert.equal(emptyCode.json?.error?.code, 'VOUCHER_CODE_REQUIRED');

      const unknownCode = await ctx.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { code: 'DOESNOTEXIST999', order_vnd: 100000 },
      });
      assert.equal(unknownCode.status, 400);
      assert.equal(unknownCode.json?.error?.code, 'CODE_NOT_FOUND');

      const pool = await ctx.apiJson('/api/v1/marketing/vouchers', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Min Order Pool',
          code_prefix: 'MIN50',
          discount_type: 'fixed_vnd',
          discount_value: 1_000_000,
          min_order_vnd: 50_000_000,
        },
      });
      await ctx.apiJson(`/api/v1/marketing/vouchers/${pool.data.id}/generate`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { quantity: 1 },
      });
      const claim = await ctx.apiJson(`/api/v1/public/marketing/vouchers/${pool.data.slug}/claim`, {
        method: 'POST',
        body: { name: 'Min Order Lead', email: makeTestRecipient('f5-min') },
      });
      const code = claim.data.code;

      const lowOrder = await ctx.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { code, order_vnd: 10_000_000 },
      });
      assert.equal(lowOrder.status, 400);
      assert.equal(lowOrder.json?.error?.code, 'MIN_ORDER_NOT_MET');

      const okRedeem = await ctx.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { code, order_vnd: 60_000_000 },
      });
      assert.equal(okRedeem.status, 200);

      const doubleRedeem = await ctx.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { code, order_vnd: 60_000_000 },
      });
      assert.equal(doubleRedeem.status, 400);
      assert.equal(doubleRedeem.json?.error?.code, 'CODE_ALREADY_REDEEMED');

      const badLink = await ctx.apiRaw('/api/v1/marketing/vouchers/shortlinks', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { title: 'Bad Link', target_url: 'javascript:alert(1)' },
      });
      assert.equal(badLink.status, 422);
      assert.equal(badLink.json?.error?.code, 'INVALID_SHORTLINK');

      const missingShort = await ctx.apiRaw('/api/v1/public/marketing/r/no-such-shortlink');
      assert.equal(missingShort.status, 404);
      assert.equal(missingShort.json?.error?.code, 'SHORTLINK_NOT_FOUND');
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T2] rejects web tracking property without domain (422) and unknown site_key on /track (404)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const badProp = await ctx.apiRaw('/api/v1/marketing/web-tracking/properties', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Missing Domain' },
      });
      assert.equal(badProp.status, 422);
      assert.equal(badProp.json?.error?.code, 'PROPERTY_NAME_DOMAIN_REQUIRED');

      const badTrack = await ctx.apiRaw('/api/v1/public/marketing/track', {
        method: 'POST',
        body: { site_key: 'dom_site_invalid_999', visitor_id: 'v1', event_type: 'pageview', page_url: '/' },
      });
      assert.equal(badTrack.status, 404);
      assert.equal(badTrack.json?.error?.code, 'WEB_PROPERTY_NOT_FOUND');
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T2] rejects public social inbound empty message (422), unknown tenant (404) & invalid Meta signature (401)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });

      const emptyMsg = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        method: 'POST',
        body: { channel: 'web_chat', message: '   ' },
      });
      assert.equal(emptyMsg.status, 422);
      assert.equal(emptyMsg.json?.error?.code, 'MESSAGE_REQUIRED');

      const unknownTenant = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/nonexistent-tenant-999', {
        method: 'POST',
        body: { channel: 'web_chat', message: 'Hello' },
      });
      assert.equal(unknownTenant.status, 404);
      assert.equal(unknownTenant.json?.error?.code, 'TENANT_NOT_FOUND');

      await ctx.apiJson('/api/v1/marketing/social-bot/messenger-config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          pages: [{ page_id: 'PG_1', app_secret: 'meta_sec_1', verify_token: 'v_1', page_access_token: 'tok_1' }],
        },
      });

      const badSig = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
        body: JSON.stringify({
          object: 'page',
          entry: [{ id: 'PG_1', messaging: [{ sender: { id: 'u1' }, message: { text: 'Hi' } }] }],
        }),
      });
      assert.equal(badSig.status, 401);
      assert.equal(badSig.json?.error?.code, 'INVALID_META_SIGNATURE');
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F6: Meta Report, Ads, Messenger & CAPI (Tier 2 — Boundary & Negative)
// ============================================================================
describe('Tier 2 — Feature F6: Meta Report, Ads, Messenger & CAPI Boundaries', () => {
  it('[F6][T2] denies public DOM Meta Report access when public_view is disabled (403 PUBLIC_VIEW_DISABLED)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      const res = await ctx.apiRaw('/api/v1/public/dom-meta/ideas/access');
      assert.equal(res.status, 403);
      assert.equal(res.json?.error?.code, 'PUBLIC_VIEW_DISABLED');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T2] forbids public DOM Meta viewer token from calling /dom-meta/ai-analyze (403 PUBLIC_VIEWER_AI_FORBIDDEN)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      await ctx.apiJson('/api/v1/integrations/dom-meta/config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { public_view: true, primary_ad_account_id: 'act_1852318231510577' },
      });

      const pub = await ctx.apiJson('/api/v1/public/dom-meta/ideas/access');
      const viewerToken = pub.data.access_token;
      assert.ok(viewerToken);

      const aiRes = await ctx.apiRaw('/api/v1/integrations/dom-meta/ai-analyze', {
        method: 'POST',
        token: viewerToken,
        tenantSlug: 'ideas',
        body: { scope: 'workspace', prompt: 'Analyze ads' },
      });
      assert.equal(aiRes.status, 403);
      assert.equal(aiRes.json?.error?.code, 'PUBLIC_VIEWER_AI_FORBIDDEN');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T2] blocks DOM Meta Graph proxy path traversal (422) and invalid batch sizes (0 or 61 items)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      await ctx.apiJson('/api/v1/integrations/meta-ads/accounts', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          ad_account_id: '1234567890',
          name: 'IDEAS Proxy Boundary Ads',
          access_token: 'EAA_PROXY_TEST_TOKEN_123456789012345',
          is_active: true,
        },
      });
      await ctx.apiJson('/api/v1/integrations/dom-meta/config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { primary_ad_account_id: 'act_1234567890' },
      });

      const badProxy = await ctx.apiRaw('/api/v1/integrations/dom-meta/meta-proxy', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { graph_path: '../oauth/access_token' },
      });
      assert.equal(badProxy.status, 422);
      assert.equal(badProxy.json?.error?.code, 'DOM_META_GRAPH_PROXY_ERROR');

      const emptyBatch = await ctx.apiRaw('/api/v1/integrations/dom-meta/meta-batch', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { requests: [] },
      });
      assert.equal(emptyBatch.status, 422);
      assert.equal(emptyBatch.json?.error?.code, 'DOM_META_GRAPH_BATCH_ERROR');

      const overBatch = await ctx.apiRaw('/api/v1/integrations/dom-meta/meta-batch', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          requests: Array.from({ length: 61 }, (_, i) => ({
            key: `req_${i}`,
            graph_path: 'act_1234567890/campaigns',
          })),
        },
      });
      assert.equal(overBatch.status, 422);
      assert.equal(overBatch.json?.error?.code, 'DOM_META_GRAPH_BATCH_ERROR');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T2] CAPI without live token degrades deterministically to sandbox DEMO_DATASET_PIXEL with zero Graph API fetch', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      const res = await ctx.apiJson('/api/v1/integrations/capi/test-event', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { event_name: 'Purchase', sample_phone: '0901234567', deal_value_vnd: 25_000_000 },
      });
      assert.equal(res.success, true);
      assert.equal(res.data.meta_http_status, 200);

      // Real lead ingestion triggers sandbox CAPI dispatch and persists DEMO_DATASET_PIXEL row in capi_logs
      const sandboxLead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Sandbox CAPI Lead', phone: '0901234569' },
      });
      assert.equal(sandboxLead.success, true);
      assert.equal(ctx.mockFetch.requests.length, 0);

      const logRow = await db(ctx).query<{ dataset_id: string }>(
        `SELECT dataset_id FROM capi_logs WHERE tenant_id = $1`,
        [ideas.tenantId]
      );
      assert.equal(logRow.rows.length, 1);
      assert.equal(logRow.rows[0].dataset_id, 'DEMO_DATASET_PIXEL');
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T2] Messenger webhook rejects wrong verify_token (403) and invalid x-hub-signature-256 (401)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      await ctx.apiJson('/api/v1/marketing/social-bot/messenger-config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          pages: [{ page_id: 'PG_1', verify_token: 'v_ok', app_secret: 'sec_ok', page_access_token: 'tok_ok' }],
        },
      });

      const badVerify = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong_tok', 'hub.challenge': '1' },
      });
      assert.equal(badVerify.status, 403);
      assert.equal(badVerify.json?.error?.code, 'INVALID_VERIFY_TOKEN');

      const badPost = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=bad' },
        body: JSON.stringify({
          object: 'page',
          entry: [{ id: 'PG_1', messaging: [{ sender: { id: 'u1' }, message: { text: 'Hi' } }] }],
        }),
      });
      assert.equal(badPost.status, 401);
      assert.equal(badPost.json?.error?.code, 'INVALID_META_SIGNATURE');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T2] validates Meta Ads account ID (<5 digits), empty phone-farm import, cross-tenant delete & unknown CAPI retry', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const sibling = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'autodata_crm' });

      const sibAcct = await ctx.apiJson('/api/v1/integrations/meta-ads/accounts', {
        method: 'POST',
        token: sibling.accessToken,
        tenantSlug: 'ecolife',
        body: { ad_account_id: '9876543210', name: 'Ecolife Ads', access_token: 'EAA_SIB_TOKEN_1234567890' },
      });
      const sibAcctId =
        sibAcct.account?.id ||
        sibAcct.accounts?.[0]?.id ||
        sibAcct.data?.accounts?.[0]?.id ||
        sibAcct.data?.account?.id ||
        sibAcct.data?.id;
      assert.ok(sibAcctId, 'Expected sibling Meta Ads account ID for cross-tenant delete test');

      const shortId = await ctx.apiRaw('/api/v1/integrations/meta-ads/accounts', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { ad_account_id: '12', access_token: 'EAA_SHORT_TEST_TOKEN' },
      });
      assert.equal(shortId.status, 422);
      assert.equal(shortId.json?.error?.code, 'META_ACCOUNT_VALIDATION_ERROR');

      const emptyPf = await ctx.apiRaw('/api/v1/integrations/capi/phone-farm/import', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { phones: [] },
      });
      assert.equal(emptyPf.status, 422);
      assert.equal(emptyPf.json?.error?.code, 'VALIDATION_ERROR');

      if (sibAcctId) {
        const crossDel = await ctx.apiRaw(`/api/v1/integrations/meta-ads/accounts/${sibAcctId}`, {
          method: 'DELETE',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
        });
        assert.equal(crossDel.status, 404);
        assert.equal(crossDel.json?.error?.code, 'META_ACCOUNT_NOT_FOUND');
      }

      const retryMissing = await ctx.apiRaw('/api/v1/integrations/capi/retry/00000000-0000-4000-8000-000000000099', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(retryMissing.status, 404);
      assert.equal(retryMissing.json?.error?.code, 'CAPI_LOG_NOT_FOUND');
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F7: AWS & API Credentials Vault (Tier 2 — Boundary & Negative)
// ============================================================================
describe('Tier 2 — Feature F7: AWS & API Credentials Vault Boundaries', () => {
  it('[F7][T2] rejects unsupported vault integration type with 422 INVALID_INTEGRATION_TYPE on PUT & POST', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const putBad = await ctx.apiRaw('/api/v1/integrations/vault/zalo_nonexistent', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { token: 'abc' },
      });
      assert.equal(putBad.status, 422);
      assert.equal(putBad.json?.error?.code, 'INVALID_INTEGRATION_TYPE');

      const postBad = await ctx.apiRaw('/api/v1/integrations/vault', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { integration_type: 'unknown_vendor', config: {} },
      });
      assert.equal(postBad.status, 422);
      assert.equal(postBad.json?.error?.code, 'INVALID_INTEGRATION_TYPE');
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T2] cross-tenant decryption fails GCM auth-tag verification & sibling overview never leaks ideas vault', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const sibling = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'autodata_crm' });

      await ctx.apiJson('/api/v1/integrations/vault/ai_gemini', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { apiKey: 'AIzaSyTenantIsolatedSecret' },
      });

      const row = await db(ctx).query<{ config_encrypted: string; iv: string; auth_tag: string }>(
        `SELECT config_encrypted, iv, auth_tag FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'ai_gemini'`,
        [ideas.tenantId]
      );
      assert.throws(() =>
        decryptTenantSecret(
          sibling.tenantId,
          row.rows[0].config_encrypted,
          row.rows[0].iv,
          row.rows[0].auth_tag
        )
      );

      const sibOv = await ctx.apiJson('/api/v1/integrations/overview', {
        token: sibling.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(sibOv.data.integrations.ai_gemini, undefined);
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T2] tampered auth_tag degrades gracefully to status=error on /integrations/overview without crashing or leaking', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      await ctx.apiJson('/api/v1/integrations/vault/google_sheets', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { client_secret: 'GOCSPX_TAMPER_TEST' },
      });

      await db(ctx).query(
        `UPDATE tenant_integrations SET auth_tag = '00000000000000000000000000000000' WHERE tenant_id = $1 AND integration_type = 'google_sheets'`,
        [ideas.tenantId]
      );

      const ov = await ctx.apiJson('/api/v1/integrations/overview', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(ov.data.integrations.google_sheets.status, 'error');
      assert.equal(ov.data.integrations.google_sheets.config_preview, undefined);
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T2] wrong VAULT_MASTER_SECRET fails decryption until original master secret is restored', async () => {
    const origSecret = APP_CONFIG.vaultMasterSecret;
    const tid = crypto.randomUUID();
    const enc = encryptTenantSecret(tid, { api_key: 'test-key-rotation' });
    try {
      clearVaultKeyCacheForTesting();
      APP_CONFIG.vaultMasterSecret = 'wrong-master-secret-for-negative-test';
      assert.throws(() => decryptTenantSecret(tid, enc.configEncrypted, enc.iv, enc.authTag));
    } finally {
      APP_CONFIG.vaultMasterSecret = origSecret;
      clearVaultKeyCacheForTesting();
    }
    const dec = decryptTenantSecret<{ api_key: string }>(tid, enc.configEncrypted, enc.iv, enc.authTag);
    assert.equal(dec.api_key, 'test-key-rotation');
  });

  it('[F7][T2] missing AWS SES IAM credentials and empty SMTP host fail cleanly with 422 EMAIL_DISPATCH_FAILED', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      await ctx.apiJson('/api/v1/integrations/vault/aws_ses', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { sesRegion: 'ap-southeast-2', region: 'ap-southeast-2' },
      });

      const recipient = makeTestRecipient('f7-missing-ses');
      assertTestRecipientsOnly([recipient]);
      const res = await ctx.apiRaw('/api/v1/integrations/email/test', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { email_provider: 'ses', to_email: recipient },
      });
      assert.equal(res.status, 422);
      assert.equal(res.json?.error?.code, 'EMAIL_DISPATCH_FAILED');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T2] tampered aws_ses ciphertext on /email/test returns 500 EMAIL_TEST_FAILED without leaking plaintext or calling AWS', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
      });
      ctx.mockFetch.clearRequests();

      await db(ctx).query(
        `UPDATE tenant_integrations SET auth_tag = 'ffffffffffffffffffffffffffffffff' WHERE tenant_id = $1 AND integration_type = 'aws_ses'`,
        [ideas.tenantId]
      );

      const recipient = makeTestRecipient('f7-tamper-ses');
      assertTestRecipientsOnly([recipient]);
      const res = await ctx.apiRaw('/api/v1/integrations/email/test', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { email_provider: 'ses', to_email: recipient },
      });
      assert.equal(res.status, 500);
      assert.equal(res.json?.error?.code, 'EMAIL_TEST_FAILED');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F8: ZaloBot & Zalo OA Exclusion (Tier 2 — Boundary & Guardrail Verification)
// ============================================================================
describe('Tier 2 — Feature F8: ZaloBot & Zalo OA Exclusion Guardrails', () => {
  it('[F8][T2] sendZaloBotNotification & daily_report cron fail closed when zalo_bot_disabled=true or token empty', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        customSettings: {
          zalo_bot_disabled: true,
          zalo_bot_token: '',
          daily_report_channels: { zalo: true, telegram: false, email: false, appscript: false },
        },
      });
      ctx.mockFetch.clearRequests();

      const direct = await sendZaloBotNotification(ideas.tenantId, 'Guardrail test');
      assert.equal(direct.success, false);

      const cron = await triggerMasterCron(ctx, { subroutines: ['daily_report'], tenantId: ideas.tenantId });
      assert.equal(cron.ok, true);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T2] /integrations/zalo/verify and /zalo/updates reject missing or short bot_token (422 INVALID_ZALO_BOT_TOKEN)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();

      const verifyBad = await ctx.apiRaw('/api/v1/integrations/zalo/verify', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(verifyBad.status, 422);
      assert.equal(verifyBad.json?.error?.code, 'INVALID_ZALO_BOT_TOKEN');

      const updatesBad = await ctx.apiRaw('/api/v1/integrations/zalo/updates', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { bot_token: 'short' },
      });
      assert.equal(updatesBad.status, 422);
      assert.equal(updatesBad.json?.error?.code, 'INVALID_ZALO_BOT_TOKEN');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T2] /integrations/zalo/verify sandbox mode completes locally with zero outbound HTTP', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      const res = await ctx.apiJson('/api/v1/integrations/zalo/verify', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { bot_token: 'demo_zalobot_token', verify_mode: 'sandbox' },
      });
      assert.equal(res.success, true);
      assert.equal(res.data.verified, true);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T2] sendTenantZnsMessage rejects invalid phone (INVALID_ZNS_PHONE) before touching vault or network', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      const res = await sendTenantZnsMessage({
        tenantId: ideas.tenantId,
        phone: 'not-a-phone',
        templateId: 'TPL_1',
        message: 'Test',
      });
      assert.equal(res.sent, false);
      assert.equal(res.error, 'INVALID_ZNS_PHONE');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T2] synthetic MYERP 13 zalo_* tables remain absent from PostgreSQL schema & ideas settings stay disabled', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        customSettings: {
          zalo_bot_disabled: true,
          zalo_bot_token: '',
          daily_report_channels: { zalo: false, telegram: false, email: false, appscript: false },
        },
      });
      ctx.mockFetch.clearRequests();

      const dump = ctx.createSyntheticDump({ includeAllZaloTables: true });
      assert.equal(dump.counts.zaloTables, 13);

      const legacyZaloTables = await db(ctx).query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('zalo_queue', 'zalo_broadcast_tracking', 'zalo_delivery_logs', 'zalo_message_queue', 'zalo_oa_configs')`
      );
      assert.equal(legacyZaloTables.rows.length, 0);

      const settingsRow = await db(ctx).query<{ settings: any }>(
        `SELECT settings FROM tenants WHERE id = $1`,
        [ideas.tenantId]
      );
      assert.equal(settingsRow.rows[0].settings.zalo_bot_disabled, true);
      assert.equal(settingsRow.rows[0].settings.zalo_bot_token, '');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });
});
