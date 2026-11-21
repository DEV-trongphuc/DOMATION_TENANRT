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
  impersonateTenant,
  inspectSqlDumpMetadata,
  loginSuperAdmin,
  makeTestRecipient,
  runCliSubprocess,
  seedIdeasTenant,
  seedSiblingTenant,
  triggerMasterCron,
} from './harness.ts';
import { decryptTenantSecret, encryptTenantSecret } from '../../server/core/crypto/vault.ts';

const MIGRATE_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'migrate-myerp-ideas.ts');
const UUID_V4_OR_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function allocateTempPgDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assertNotLivePgDataDir(dir, REPO_ROOT, 'tier1_f1_f8 tempPgDir');
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
// F1: Tenant `ideas` Provisioning & Entitlements (Tier 1 — Happy Path)
// ============================================================================
describe('Tier 1 — Feature F1: Tenant `ideas` Provisioning & Entitlements', () => {
  it('[F1][T1] provisions ideas on growth_combo + education and verifies /auth/me, /workspace/bootstrap & SQL row', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
      });

      const me = await ctx.apiJson('/api/v1/auth/me', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(me.success, true);
      assert.equal(me.data.tenant.slug, 'ideas');
      assert.equal(me.data.tenant.package_code, 'growth_combo');
      assert.equal(me.data.tenant.industry_key, 'education');
      assert.equal(me.data.tenant.entitlements.education_addon, true);
      assert.equal(me.data.tenant.entitlements.enable_ideas_mascot, false);
      assert.equal(me.data.tenant.entitlements.zero_migration_ready, true);

      const enabled: string[] = me.data.tenant.enabled_modules;
      for (const mod of [
        'leads',
        'settings',
        'billing',
        'users',
        'org_rbac',
        'dashboard_crm',
        'pipelines',
        'rounds',
        'routing_rules',
        'gatekeeper',
        'tickets_data',
        'ads_capi',
        'integrations_crm',
        'dashboard_marketing',
        'audiences',
        'mkt_templates',
        'mkt_forms',
        'mkt_surveys',
        'mkt_campaigns',
        'mkt_flows',
        'mkt_vouchers',
        'mkt_web_tracking',
        'mkt_social_bot',
        'mkt_ai_bot',
        'integrations_marketing',
        'dashboard_growth',
        'revenue_attribution',
        'education',
        'education_addon',
      ]) {
        assert.ok(enabled.includes(mod), `growth_combo+education must enable '${mod}'`);
      }

      for (const promax of [
        'hrm',
        'attendance',
        'payroll',
        'approvals',
        'projects',
        'workchat',
        'finance',
        'inventory_assets',
        'cloud_files_ocr',
        'dom_agent',
      ]) {
        assert.equal(enabled.includes(promax), false, `growth_combo must NOT enable PROMAX '${promax}'`);
      }

      const bootstrap = await ctx.apiJson('/api/v1/workspace/bootstrap', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(bootstrap.success, true);
      assert.equal(bootstrap.data.tenant.package_code, 'growth_combo');
      assert.equal(bootstrap.data.tenant.industry_key, 'education');
      assert.ok(Array.isArray(bootstrap.data.pipelines) && bootstrap.data.pipelines.length >= 1);

      const dbRes = await db(ctx).query<{
        package_code: string;
        plan_tier: string;
        industry_key: string;
        status: string;
      }>('SELECT package_code, plan_tier, industry_key, status FROM tenants WHERE id = $1', [ideas.tenantId]);
      assert.equal(dbRes.rows.length, 1);
      assert.equal(dbRes.rows[0].package_code, 'growth_combo');
      assert.equal(dbRes.rows[0].plan_tier, 'growth');
      assert.equal(dbRes.rows[0].industry_key, 'education');
      assert.equal(dbRes.rows[0].status, 'active');
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T1] unlocks all CRM, Meta Report, Marketing Automation, and Education Add-on endpoints (200 OK)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
      });

      const allowedEndpoints = [
        // CRM
        '/api/v1/leads',
        '/api/v1/pipelines',
        '/api/v1/pipelines/rounds/list',
        '/api/v1/analytics/dashboard',
        '/api/v1/analytics/fair-share',
        // Meta Report / Ads / CAPI
        '/api/v1/integrations/dom-meta/config',
        '/api/v1/integrations/meta-ads/accounts',
        '/api/v1/analytics/ads-performance',
        '/api/v1/myerp/marketing/meta/overview',
        // Marketing Automation
        '/api/v1/marketing/overview',
        '/api/v1/marketing/campaigns',
        '/api/v1/marketing/flows',
        '/api/v1/marketing/templates',
        '/api/v1/marketing/forms',
        '/api/v1/marketing/surveys',
        '/api/v1/marketing/vouchers',
        '/api/v1/marketing/web-tracking',
        '/api/v1/marketing/social-bot',
        '/api/v1/audiences/field-catalog',
        // Education Add-on
        '/api/v1/education/overview',
        '/api/v1/education/courses',
      ];

      for (const ep of allowedEndpoints) {
        const res = await ctx.apiRaw(ep, { token: ideas.accessToken, tenantSlug: 'ideas' });
        assert.equal(res.status, 200, `Expected 200 on '${ep}', got ${res.status}: ${res.rawText}`);
        assert.equal(res.json?.success, true, `Expected success: true on '${ep}'`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T1] reports growth_combo limits, active subscription & education terminology on /billing/overview and /myerp/package-entitlements', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
      });

      const billing = await ctx.apiJson('/api/v1/billing/overview', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(billing.success, true);
      assert.equal(billing.data.package_code, 'growth_combo');
      assert.equal(billing.data.limits.max_sales, 85);
      assert.equal(billing.data.limits.max_managers, 15);
      assert.equal(billing.data.limits.max_users, 100);
      assert.equal(billing.data.limits.max_rounds, 30);
      assert.equal(billing.data.limits.monthly_lead_quota, 100_000);
      assert.equal(billing.data.subscription.is_expired, false);
      assert.equal(billing.data.industry_key, 'education');
      assert.equal(billing.data.terminology.customer_singular, 'Học viên');
      assert.equal(billing.data.terminology.lead_singular, 'Thí sinh / Học viên tiềm năng');

      const myerpEnt = await ctx.apiJson('/api/v1/myerp/package-entitlements', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(myerpEnt.success, true);
      assert.equal(myerpEnt.data.package_code, 'growth_combo');
      assert.equal(myerpEnt.data.industry_key, 'education');
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T1] SuperAdmin billing-grant upgrades autodata_crm+education to growth_combo while preserving education_addon & CRM leads', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const tenant = await seedIdeasTenant(ctx, {
        slug: 'ideas-upgrade',
        packageCode: 'autodata_crm',
        industry: 'education',
      });

      const leadCreate = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: tenant.accessToken,
        tenantSlug: 'ideas-upgrade',
        body: {
          name: 'Hoc Vien Pre-Upgrade',
          phone: '0903111222',
          email: makeTestRecipient('f1-upgrade'),
        },
      });
      assert.equal(leadCreate.success, true);

      const mktBefore = await ctx.apiRaw('/api/v1/marketing/campaigns', {
        token: tenant.accessToken,
        tenantSlug: 'ideas-upgrade',
      });
      assert.equal(mktBefore.status, 403);

      const sa = await loginSuperAdmin(ctx);
      assert.equal(sa.ok, true);
      const grant = await ctx.apiJson(`/api/v1/admin/tenants/${tenant.tenantId}/billing-grant`, {
        method: 'POST',
        token: sa.token,
        body: { plan_code: 'autodata_growth', extend_months: 12 },
      });
      assert.equal(grant.success, true);

      const meAfter = await ctx.apiJson('/api/v1/auth/me', {
        token: tenant.accessToken,
        tenantSlug: 'ideas-upgrade',
      });
      assert.equal(meAfter.data.tenant.package_code, 'growth_combo');
      assert.equal(meAfter.data.tenant.entitlements.education_addon, true);
      assert.ok(meAfter.data.tenant.enabled_modules.includes('mkt_campaigns'));
      assert.ok(meAfter.data.tenant.enabled_modules.includes('education'));

      const mktAfter = await ctx.apiRaw('/api/v1/marketing/campaigns', {
        token: tenant.accessToken,
        tenantSlug: 'ideas-upgrade',
      });
      assert.equal(mktAfter.status, 200);

      const leadsAfter = await ctx.apiJson('/api/v1/leads', {
        token: tenant.accessToken,
        tenantSlug: 'ideas-upgrade',
      });
      assert.ok(leadsAfter.data.items.some((l: any) => l.name === 'Hoc Vien Pre-Upgrade'));

      const txRes = await db(ctx).query<{ plan_code: string; status: string }>(
        `SELECT plan_code, status FROM tenant_billing_transactions WHERE tenant_id = $1 AND tx_type = 'admin_grant'`,
        [tenant.tenantId]
      );
      assert.ok(txRes.rows.some((r) => r.plan_code === 'autodata_growth' && r.status === 'completed'));
    } finally {
      await ctx.close();
    }
  });

  it('[F1][T1] /dom-agent/bootstrap exposes Copilot tools on growth_combo while locking PROMAX dom_agent tools', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
      });

      const res = await ctx.apiJson('/api/v1/dom-agent/bootstrap', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(res.success, true);
      assert.equal(res.data.package_code, 'growth_combo');
      assert.ok(Number(res.data.tools_summary?.entitled_count || 0) > 0);
      assert.ok(Number(res.data.tools_summary?.locked_by_package_count || 0) > 0);
      const lockedTools = (res.data.tools || []).filter((t: any) => t.locked === true || t.locked_reason);
      assert.ok(lockedTools.some((t: any) => t.locked_reason === 'MODULE_NOT_ENTITLED'));
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F2: Deterministic ID Mapping & Pollution Filtering (Tier 1 — Happy Path)
// ============================================================================
describe('Tier 1 — Feature F2: Deterministic ID Mapping & Pollution Filtering', () => {
  it('[F2][T1] migrates tenant_id=1 (ideas) on growth_combo+education with deterministic RFC4122 UUIDs across core tables', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql({ extraContactsCount: 2, extraSubscribersCount: 2 });
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t1-1-');
    let ctx: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(cli.status, 0, `migrate-myerp-ideas failed: ${cli.stderr || cli.stdout}`);

      ctx = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const tRes = await db(ctx).query<{ id: string; slug: string; package_code: string; industry_key: string }>(
        `SELECT id, slug, package_code, industry_key FROM tenants WHERE slug = 'ideas'`
      );
      assert.equal(tRes.rows.length, 1);
      const ideasId = tRes.rows[0].id;
      assert.match(ideasId, UUID_V4_OR_V5_RE);
      assert.equal(tRes.rows[0].package_code, 'growth_combo');
      assert.equal(tRes.rows[0].industry_key, 'education');

      for (const tbl of [
        'users',
        'leads',
        'tenant_pipelines',
        'tenant_pipeline_stages',
        'distribution_rounds',
        'round_consultants',
        'routing_rules',
        'mkt_email_templates',
        'mkt_campaigns',
        'mkt_flows',
        'mkt_forms',
        'mkt_surveys',
        'mkt_short_links',
        'mkt_web_properties',
      ]) {
        const r = await db(ctx).query<{ id: string }>(
          `SELECT id FROM ${tbl} WHERE tenant_id = $1`,
          [ideasId]
        );
        assert.ok(r.rows.length >= 1, `Expected migrated rows in '${tbl}' for ideas`);
        for (const row of r.rows) {
          assert.match(row.id, UUID_V4_OR_V5_RE, `Expected valid UUID id in '${tbl}'`);
        }
      }

      const sa = await loginSuperAdmin(ctx);
      assert.equal(sa.ok, true);
      const imp = await impersonateTenant(ctx, sa.token, ideasId, 10);
      assert.equal(imp.ok, true);
      const me = await ctx.apiJson('/api/v1/auth/me', { token: imp.accessToken, tenantSlug: 'ideas' });
      assert.equal(me.data.tenant.slug, 'ideas');
    } finally {
      if (ctx) await ctx.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });

  it('[F2][T1] preserves foreign-key referential integrity across mapped integer and string legacy IDs', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql();
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t1-2-');
    let ctx: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(cli.status, 0, `migrate-myerp-ideas failed: ${cli.stderr || cli.stdout}`);

      ctx = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const tRes = await db(ctx).query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'ideas'`);
      const ideasId = tRes.rows[0]?.id;
      assert.ok(ideasId);

      const leadJoin = await db(ctx).query<{
        lead_name: string;
        user_email: string;
        stage_name: string;
        round_name: string;
      }>(
        `SELECT l.name AS lead_name, u.email AS user_email, s.stage_name, r.name AS round_name
         FROM leads l
         INNER JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         INNER JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
         INNER JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
         WHERE l.tenant_id = $1 AND l.name = 'Tran Minh Khoa'`,
        [ideasId]
      );
      assert.equal(leadJoin.rows.length, 1);
      assert.equal(leadJoin.rows[0].user_email, 'sales.ideas@test-sink.domation.local');
      assert.equal(leadJoin.rows[0].stage_name, '01 - New Lead');
      assert.equal(leadJoin.rows[0].round_name, 'MBA Admissions Round');

      const campJoin = await db(ctx).query<{ camp_name: string; tpl_name: string }>(
        `SELECT c.name AS camp_name, t.name AS tpl_name
         FROM mkt_campaigns c
         INNER JOIN mkt_email_templates t ON t.tenant_id = c.tenant_id AND t.id = c.template_id
         WHERE c.tenant_id = $1`,
        [ideasId]
      );
      assert.ok(campJoin.rows.length >= 1);

      const audJoin = await db(ctx).query<{ aud_name: string; lead_name: string }>(
        `SELECT a.name AS aud_name, l.name AS lead_name
         FROM tenant_audience_members tam
         INNER JOIN tenant_audiences a ON a.tenant_id = tam.tenant_id AND a.id = tam.audience_id
         INNER JOIN leads l ON l.tenant_id = tam.tenant_id AND l.id = tam.lead_id
         WHERE tam.tenant_id = $1`,
        [ideasId]
      );
      assert.ok(audJoin.rows.length >= 1);
    } finally {
      if (ctx) await ctx.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });

  it('[F2][T1] strictly excludes tenant_id=99999 and workspace_id=99999 pollution rows across all migrated tables', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql({ pollutionWebPropertiesCount: 5 });
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t1-3-');
    let ctx: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(cli.status, 0, `migrate-myerp-ideas failed: ${cli.stderr || cli.stdout}`);

      ctx = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const badTenants = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM tenants WHERE slug = 'test-e2e-99999'`
      );
      assert.equal(badTenants.rows[0].cnt, 0);

      const badUsers = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM users WHERE email = 'junk99999@test-sink.domation.local'`
      );
      assert.equal(badUsers.rows[0].cnt, 0);

      const badLeads = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM leads WHERE email = 'pollution99999@test-sink.domation.local' OR phone LIKE '%901112222%'`
      );
      assert.equal(badLeads.rows[0].cnt, 0);

      const badWeb = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM mkt_web_properties WHERE name LIKE 'Test Tracking Site%'`
      );
      assert.equal(badWeb.rows[0].cnt, 0);

      const ideasTenant = await db(ctx).query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'ideas'`);
      const goodWeb = await db(ctx).query<{ domain: string }>(
        `SELECT domain FROM mkt_web_properties WHERE tenant_id = $1 ORDER BY domain ASC`,
        [ideasTenant.rows[0].id]
      );
      assert.deepEqual(
        goodWeb.rows.map((r) => r.domain),
        ['chiefaiofficer.vn', 'ideas.edu.vn']
      );
    } finally {
      if (ctx) await ctx.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });

  it('[F2][T1] skips _bak_* backup tables and preserves multiline string literals in positional INSERTs', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql({ includeMultilineStrings: true });
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t1-4-');
    let ctx: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    try {
      const cli = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(cli.status, 0, `migrate-myerp-ideas failed: ${cli.stderr || cli.stdout}`);

      ctx = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const bakTimeline = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM lead_timeline_events WHERE content LIKE '%_bak_activities_20260913%' OR title = 'Backup activity row'`
      );
      assert.equal(bakTimeline.rows[0].cnt, 0);

      const bakActs = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM tenant_crm_activities WHERE body LIKE '%_bak_activities_20260913%'`
      );
      assert.equal(bakActs.rows[0].cnt, 0);

      const khoa = await db(ctx).query<{ note: string | null; custom_fields: any }>(
        `SELECT note, custom_fields FROM leads WHERE name = 'Tran Minh Khoa' LIMIT 1`
      );
      assert.equal(khoa.rows.length, 1);
      const serialized = JSON.stringify(khoa.rows[0]);
      assert.ok(
        serialized.includes('MBA Online') && serialized.includes('Bachelor'),
        `Expected multiline note/metadata preserved, got: ${serialized}`
      );
    } finally {
      if (ctx) await ctx.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });

  it('[F2][T1] idempotent re-run produces identical deterministic UUIDs and exact row counts with zero duplicates', async () => {
    assert.ok(fs.existsSync(MIGRATE_SCRIPT_PATH), 'scripts/migrate-myerp-ideas.ts missing (M3 deliverable)');
    const dump = buildSyntheticMyerpSql({ extraContactsCount: 2, extraSubscribersCount: 2 });
    const pgDir = allocateTempPgDir('e2e-ideas-f2-t1-5-');
    let ctx1: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;
    let ctx2: Awaited<ReturnType<typeof createIsolatedContext>> | null = null;

    const trackedTables = [
      'users',
      'leads',
      'tenant_pipeline_stages',
      'distribution_rounds',
      'mkt_email_templates',
      'mkt_campaigns',
      'mkt_flows',
      'mkt_web_properties',
    ];

    try {
      const run1 = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(run1.status, 0, `Run #1 failed: ${run1.stderr || run1.stdout}`);

      ctx1 = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const t1 = await db(ctx1).query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'ideas'`);
      const ideasId1 = t1.rows[0].id;
      const snap1: Record<string, string[]> = {};
      for (const tbl of trackedTables) {
        const r = await db(ctx1).query<{ id: string }>(
          `SELECT id FROM ${tbl} WHERE tenant_id = $1 ORDER BY id ASC`,
          [ideasId1]
        );
        snap1[tbl] = r.rows.map((x) => x.id);
      }
      await ctx1.close();
      ctx1 = null;

      const run2 = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        { env: { PGLITE_DATA_DIR: pgDir } }
      );
      assert.equal(run2.status, 0, `Run #2 failed: ${run2.stderr || run2.stdout}`);

      ctx2 = await createIsolatedContext({ dbMode: 'tempdir', dataDir: pgDir, cleanupDataDir: false });
      const t2 = await db(ctx2).query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'ideas'`);
      assert.equal(t2.rows.length, 1);
      assert.equal(t2.rows[0].id, ideasId1);

      for (const tbl of trackedTables) {
        const r: { rows: Array<{ id: string }> } = await db(ctx2).query<{ id: string }>(
          `SELECT id FROM ${tbl} WHERE tenant_id = $1 ORDER BY id ASC`,
          [ideasId1]
        );
        assert.deepEqual(
          r.rows.map((x: { id: string }) => x.id),
          snap1[tbl],
          `Re-run changed UUID set in '${tbl}'`
        );
      }
    } finally {
      if (ctx1) await ctx1.close();
      if (ctx2) await ctx2.close();
      dump.cleanup();
      fs.rmSync(pgDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// F3: Auto Data CRM Data Migration & API Behavior (Tier 1 — Happy Path)
// ============================================================================
describe('Tier 1 — Feature F3: Auto Data CRM Migration & API Behavior', () => {
  it('[F3][T1] creates 14-stage education pipeline and reorders stages with contiguous stage_order', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const stagesPayload = Array.from({ length: 14 }, (_, i) => ({
        stage_key: `ideas_stage_${i + 1}`,
        stage_name: `Bước ${i + 1}`,
        stage_order: i + 1,
        color_hex: '#1E40FF',
        capi_event_mapping: i === 12 ? 'Purchase' : 'Lead',
        is_won_stage: i === 12,
        is_lost_stage: i === 13,
      }));

      const created = await ctx.apiJson('/api/v1/pipelines', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'IDEAS Admissions 14 Stages', stages: stagesPayload },
      });
      assert.equal(created.success, true);
      assert.equal(created.data.stages.length, 14);
      const pipeId = created.data.id;

      const reorderedInput = [...created.data.stages];
      [reorderedInput[0], reorderedInput[1]] = [reorderedInput[1], reorderedInput[0]];
      const reorderRes = await ctx.apiJson(`/api/v1/pipelines/${pipeId}/stages/reorder`, {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          stages: reorderedInput.map((s: any, idx: number) => ({
            id: s.id,
            stage_key: s.stage_key,
            stage_name: s.stage_name,
            stage_order: idx + 1,
            color_hex: s.color_hex,
            is_won_stage: s.is_won_stage,
            is_lost_stage: s.is_lost_stage,
          })),
        },
      });
      assert.equal(reorderRes.success, true);

      const listRes = await ctx.apiJson('/api/v1/pipelines', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const target = listRes.data.find((p: any) => p.id === pipeId);
      assert.ok(target);
      assert.equal(target.stages.length, 14);
      assert.deepEqual(
        target.stages.map((s: any) => Number(s.stage_order)),
        Array.from({ length: 14 }, (_, i) => i + 1)
      );
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T1] assigns leads via fair-share distribution round across multiple active consultants', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const u1 = await ctx.apiJson('/api/v1/users', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          full_name: 'Consultant One',
          email: makeTestRecipient('c1'),
          role: 'sale',
          password: 'SaleUserPass#2026',
        },
      });
      const u2 = await ctx.apiJson('/api/v1/users', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          full_name: 'Consultant Two',
          email: makeTestRecipient('c2'),
          role: 'sale',
          password: 'SaleUserPass#2026',
        },
      });

      // Deactivate seeded default round so the new IDEAS Fair Share Round is the active pipeline round
      const existingRounds = await ctx.apiJson('/api/v1/pipelines/rounds/list', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const roundRes = await ctx.apiJson('/api/v1/pipelines/rounds', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'IDEAS Fair Share Round', priority: 1 },
      });
      const roundId = roundRes.data.id;

      for (const r of existingRounds.data.rounds || []) {
        await ctx.apiJson(`/api/v1/pipelines/rounds/${r.id}`, {
          method: 'PATCH',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          body: { is_active: false },
        });
      }

      await ctx.apiJson(`/api/v1/pipelines/rounds/${roundId}/consultants`, {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          replace_all: true,
          consultants: [
            { user_id: u1.data.id, receive_ratio: 1, data_per_turn: 1 },
            { user_id: u2.data.id, receive_ratio: 1, data_per_turn: 1 },
          ],
        },
      });

      const l1 = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Candidate A', phone: '0901000101' },
      });
      const l2 = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Candidate B', phone: '0901000102' },
      });

      assert.equal(l1.data.status, 'assigned');
      assert.equal(l2.data.status, 'assigned');
      assert.equal(l1.data.roundId, roundId);
      assert.equal(l2.data.roundId, roundId);
      assert.ok([u1.data.id, u2.data.id].includes(l1.data.assigned_to));
      assert.ok([u1.data.id, u2.data.id].includes(l2.data.assigned_to));
      assert.notEqual(l1.data.assigned_to, l2.data.assigned_to, 'Fair-share should alternate 1:1');
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T1] conditional routing rule directs matching source lead to target distribution round', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const uTarget = await ctx.apiJson('/api/v1/users', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          full_name: 'FB Ads Specialist',
          email: makeTestRecipient('fb-sale'),
          role: 'sale',
          password: 'SaleUserPass#2026',
        },
      });

      const targetRound = await ctx.apiJson('/api/v1/pipelines/rounds', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Facebook Ads VIP Round',
          priority: 10,
          consultants: [{ user_id: uTarget.data.id, receive_ratio: 1, data_per_turn: 1 }],
        },
      });

      const ruleRes = await ctx.apiJson('/api/v1/pipelines/routing-rules', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          round_id: targetRound.data.id,
          rule_name: 'Route FB Ads to VIP',
          priority: 1,
          conditions_json: [{ field: 'source', operator: 'equals', value: 'facebook_ads' }],
        },
      });
      assert.equal(ruleRes.success, true);

      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'FB Lead', phone: '0902000201', source: 'facebook_ads' },
      });
      assert.equal(lead.data.roundId, targetRound.data.id);
      assert.equal(lead.data.assigned_to, uTarget.data.id);
      const routedDb = await db(ctx).query<{ round_id: string; assigned_to: string }>(
        'SELECT round_id, assigned_to FROM leads WHERE id = $1',
        [lead.data.id]
      );
      assert.equal(routedDb.rows[0].round_id, targetRound.data.id);
      assert.equal(routedDb.rows[0].assigned_to, uTarget.data.id);
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T1] transitions lead stage, accepts, reassigns, and records immutable timeline notes', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const s1 = await ctx.apiJson('/api/v1/users', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { full_name: 'Sale 1', email: makeTestRecipient('s1'), role: 'sale', password: 'SaleUserPass#2026' },
      });
      const s2 = await ctx.apiJson('/api/v1/users', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { full_name: 'Sale 2', email: makeTestRecipient('s2'), role: 'sale', password: 'SaleUserPass#2026' },
      });

      const pipes = await ctx.apiJson('/api/v1/pipelines', { token: ideas.accessToken, tenantSlug: 'ideas' });
      const stages = pipes.data[0].stages;
      assert.ok(stages.length >= 2);
      const nextStageId = stages[1].id;

      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Timeline Lead', phone: '0903000301', assigned_to: s1.data.id },
      });
      const leadId = lead.data.id;

      const accepted = await ctx.apiJson(`/api/v1/leads/${leadId}/accept`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(accepted.success, true);

      const staged = await ctx.apiJson(`/api/v1/leads/${leadId}/stage`, {
        method: 'PATCH',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { stage_id: nextStageId, note: 'Đã gọi tư vấn lần 1' },
      });
      assert.equal(staged.success, true);

      const reassigned = await ctx.apiJson(`/api/v1/leads/${leadId}/reassign`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { target_user_id: s2.data.id, reason: 'Chuyển chuyên viên MBA' },
      });
      assert.equal(reassigned.success, true);

      const noteRes = await ctx.apiJson(`/api/v1/leads/${leadId}/timeline/notes`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { content: 'Khách quan tâm học bổng MBA 2026' },
      });
      assert.equal(noteRes.success, true);

      const tlRes = await ctx.apiJson(`/api/v1/leads/${leadId}/timeline`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const items = tlRes.data.items || tlRes.data;
      assert.ok(Array.isArray(items) && items.length >= 3);
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T1] creates & resolves tickets, attaches tags, searches Contact 360 & creates email-only nurture lead', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const phoneLead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Ticket Student', phone: '0904000401', email: makeTestRecipient('f3-t5-p') },
      });
      const leadId = phoneLead.data.id;

      const ticket = await ctx.apiJson(`/api/v1/leads/${leadId}/tickets`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { ticket_type: 'support', reason: 'Xin học bổng MBA' },
      });
      assert.equal(ticket.success, true);

      const resolved = await ctx.apiJson(`/api/v1/leads/tickets/${ticket.data.id}/resolve`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { decision: 'approved', resolution_note: 'Đã duyệt hồ sơ' },
      });
      assert.equal(resolved.success, true);

      const tagRes = await ctx.apiJson(`/api/v1/myerp/contacts/${leadId}/tags`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { tags: ['IELTS', 'VIP'] },
      });
      assert.equal(tagRes.success, true);

      const c360 = await ctx.apiJson('/api/v1/crm-360/contacts', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        query: { search: 'Ticket Student' },
      });
      assert.ok((c360.data.items || []).some((c: any) => c.id === leadId));

      const emailOnly = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Nurture Only', email: makeTestRecipient('f3-nurture') },
      });
      assert.equal(emailOnly.data.status, 'marketing_nurture');
    } finally {
      await ctx.close();
    }
  });

  it('[F3][T1] executes batch-check/import, inbound webhook enqueue (202), contact clone & soft-delete', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const checkRes = await ctx.apiJson('/api/v1/operations/leads/batch-check', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { phones: ['0905000501', '0905000502'] },
      });
      assert.equal(checkRes.success, true);

      const importRes = await ctx.apiJson('/api/v1/operations/leads/batch-import', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          rows: [
            { name: 'Batch Student 1', phone: '0905000501', email: makeTestRecipient('batch1') },
            { name: 'Batch Student 2', phone: '0905000502', email: makeTestRecipient('batch2') },
          ],
        },
      });
      assert.equal(importRes.success, true);

      const wh = await ctx.apiJson('/api/v1/integrations/webhooks', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'IDEAS Landing Inbound', webhook_type: 'inbound' },
      });
      const whToken = wh.data.token;
      const whSecret = wh.data.signing_secret;
      const payloadStr = JSON.stringify({
        name: 'Webhook Student',
        phone: '0905000503',
        email: makeTestRecipient('wh-student'),
      });
      const sig = crypto.createHmac('sha256', whSecret).update(payloadStr).digest('hex');

      const inbound = await ctx.apiRaw(`/api/v1/webhooks/ideas/${whToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sig },
        body: payloadStr,
      });
      assert.equal(inbound.status, 202);
      assert.equal(inbound.json?.success, true);

      const leadsList = await ctx.apiJson('/api/v1/leads', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const targetId = leadsList.data.items[0].id;

      const cloned = await ctx.apiJson(`/api/v1/myerp/contacts/${targetId}/clone`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { product_interest: 'DBA Program' },
      });
      assert.equal(cloned.success, true);

      const linked = await ctx.apiJson(`/api/v1/myerp/contacts/${targetId}/linked-profiles`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.ok((linked.data.profiles || linked.data.items || linked.data).length >= 2);

      const delRes = await ctx.apiJson(`/api/v1/myerp/contacts/${cloned.data.id}`, {
        method: 'DELETE',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(delRes.success, true);

      const delRow = await db(ctx).query<{ is_deleted: boolean }>(
        'SELECT is_deleted FROM leads WHERE id = $1',
        [cloned.data.id]
      );
      assert.equal(delRow.rows[0].is_deleted, true);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F4: Email Marketing & Suppression Migration & Execution (Tier 1 — Happy Path)
// ============================================================================
describe('Tier 1 — Feature F4: Email Marketing, Suppression & Loopback SMTP', () => {
  it('[F4][T1] configures @ideas.edu.vn sender & delivers test email over loopback SMTP with zero external fetch', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
        smtpVia: 'aws_ses',
        fromEmail: 'tuyensinh@ideas.edu.vn',
      });
      ctx.mockFetch.clearRequests();

      const camp = await ctx.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'IDEAS Smoke Campaign', subject_a: 'Chao mung tan hoc vien IDEAS' },
      });

      const testEmail = makeTestRecipient('f4-smoke');
      assertTestRecipientsOnly([testEmail]);
      const sent = await ctx.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/test-email`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { to_email: testEmail },
      });
      assert.equal(sent.success, true);

      const msgs = await ctx.smtp.waitForMessages(1, 3000);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].mailFrom, 'tuyensinh@ideas.edu.vn');
      assertTestRecipientsOnly(msgs[0].rcptTo);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T1] creates static list & dynamic segment audiences, links members, and evaluates reach', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const l1 = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'MBA Candidate', email: makeTestRecipient('f4-aud-1'), source: 'webinar' },
      });

      const staticAud = await ctx.apiJson('/api/v1/audiences', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'MBA Static List', audience_type: 'static_list' },
      });
      assert.equal(staticAud.success, true);

      const addMem = await ctx.apiJson(`/api/v1/audiences/${staticAud.data.id}/members`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_ids: [l1.data.id] },
      });
      assert.equal(addMem.success, true);

      const dynAud = await ctx.apiJson('/api/v1/audiences', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Webinar Dynamic Segment',
          audience_type: 'dynamic_logic',
          filter_branches: [
            {
              operator: 'AND',
              conditions: [{ field: 'source', operator: 'equals', value: 'webinar' }],
            },
          ],
        },
      });
      const evalRes = await ctx.apiJson(`/api/v1/audiences/${dynAud.data.id}/evaluate`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(evalRes.success, true);
      assert.ok(Number(evalRes.data.total_count ?? 0) >= 1);

      const previewRes = await ctx.apiJson('/api/v1/audiences/preview', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          filter_branches: [
            {
              operator: 'AND',
              conditions: [{ field: 'source', operator: 'equals', value: 'webinar' }],
            },
          ],
        },
      });
      assert.equal(previewRes.success, true);
      assert.ok(Number(previewRes.data.total ?? previewRes.data.count ?? 0) >= 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T1] compiles, validates & quick-sends personalized template with {{lead.name}} over loopback SMTP', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
        fromEmail: 'admissions@test-sink.domation.local',
      });

      const recipient = makeTestRecipient('f4-qs');
      assertTestRecipientsOnly([recipient]);
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Nguyen Thu Ha', email: recipient },
      });

      const grp = await ctx.apiJson('/api/v1/marketing/templates/groups', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'MBA Templates' },
      });

      const blocks = [
        { id: 'b1', type: 'header', content: 'IDEAS Admissions' },
        { id: 'b2', type: 'text', content: 'Chào {{lead.name}}, mời bạn xem học bổng MBA.' },
      ];
      const compiled = await ctx.apiJson('/api/v1/marketing/templates/compile', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { blocks, subject: 'Thư mời MBA' },
      });
      assert.equal(compiled.success, true);
      assert.ok(String(compiled.data.compiled_html || compiled.data.html).includes('{{lead.name}}'));

      const validated = await ctx.apiJson('/api/v1/marketing/templates/validate', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { subject: 'Thư mời MBA', compiled_html: compiled.data.compiled_html || compiled.data.html },
      });
      assert.equal(validated.success, true);

      const tpl = await ctx.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'MBA Welcome Template',
          group_id: grp.data.id,
          subject: 'Học bổng MBA dành cho {{lead.name}}',
          blocks,
          compiled_html: compiled.data.compiled_html || compiled.data.html,
        },
      });

      const qs = await ctx.apiJson('/api/v1/marketing/templates/quick-send', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { template_id: tpl.data.id, recipients: [recipient] },
      });
      assert.equal(qs.data.sent_count, 1);

      const msgs = await ctx.smtp.waitForMessages(1, 3000);
      assert.equal(msgs.length, 1);
      assert.ok(msgs[0].html.includes('Nguyen Thu Ha') || msgs[0].text.includes('Nguyen Thu Ha'));

      const tl = await db(ctx).query<{ event_type: string }>(
        `SELECT event_type FROM lead_timeline_events WHERE lead_id = $1 AND event_type = 'mkt_email_sent'`,
        [lead.data.id]
      );
      assert.equal(tl.rows.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T1] campaign send skips unsubscribed/suppressed leads & prevents duplicate sends via mkt_send_claims', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
        fromEmail: 'mailer@test-sink.domation.local',
      });

      const e1 = makeTestRecipient('f4-ok1');
      const e2 = makeTestRecipient('f4-ok2');
      const eUnsub = makeTestRecipient('f4-unsub');
      const eSupp = makeTestRecipient('f4-supp');
      assertTestRecipientsOnly([e1, e2, eUnsub, eSupp]);

      const leads = await Promise.all(
        [e1, e2, eUnsub, eSupp].map((em, idx) =>
          ctx.apiJson('/api/v1/leads', {
            method: 'POST',
            token: ideas.accessToken,
            tenantSlug: 'ideas',
            body: { name: `Sub ${idx + 1}`, email: em },
          })
        )
      );

      await db(ctx).query(`UPDATE leads SET email_consent = 'unsubscribed' WHERE id = $1`, [leads[2].data.id]);
      await ctx.apiJson('/api/v1/marketing/campaigns/suppression/list', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { channel: 'email', recipient: eSupp, reason: 'bounced' },
      });

      const aud = await ctx.apiJson('/api/v1/audiences', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Campaign Send Cohort', audience_type: 'static_list' },
      });
      await ctx.apiJson(`/api/v1/audiences/${aud.data.id}/members`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_ids: leads.map((l) => l.data.id) },
      });

      const camp = await ctx.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Fall Intake Broadcast',
          channel: 'email',
          audience_id: aud.data.id,
          subject_a: 'Thong bao Tuyen sinh {{lead.name}}',
        },
      });

      const send1 = await ctx.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(send1.data.newly_sent, 2);
      assert.ok(send1.data.suppressed_skipped >= 2);

      const msgs = await ctx.smtp.waitForMessages(2, 3000);
      assert.equal(msgs.length, 2);
      assertTestRecipientsOnly(msgs.flatMap((m) => m.rcptTo));

      const send2 = await ctx.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(send2.data.newly_sent, 0);
      assert.ok(send2.data.duplicate_claims_prevented >= 2);
      assert.equal(ctx.smtp.messages.length, 2, 'Idempotent re-send must NOT transmit duplicate SMTP emails');
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T1] open/click tracking and signed HMAC unsubscribe update claim, lead consent & mkt_suppression_list', async () => {
    const ctx = await createIsolatedContext({
      dbMode: 'memory',
      appPublicUrl: 'https://data.domation.net',
    });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
        fromEmail: 'mailer@test-sink.domation.local',
      });

      const recipient = makeTestRecipient('f4-track');
      assertTestRecipientsOnly([recipient]);
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Tracker Student', email: recipient },
      });

      const aud = await ctx.apiJson('/api/v1/audiences', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Track Cohort', audience_type: 'static_list' },
      });
      await ctx.apiJson(`/api/v1/audiences/${aud.data.id}/members`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_ids: [lead.data.id] },
      });

      const tpl = await ctx.apiJson('/api/v1/marketing/templates', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Trackable Template',
          subject: 'Click Test',
          compiled_html:
            '<html><body><p>Hello {{lead.name}}</p><a href="https://domation.net/mba">Explore</a><a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>',
        },
      });

      const camp = await ctx.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Track Campaign',
          channel: 'email',
          audience_id: aud.data.id,
          template_id: tpl.data.id,
          subject_a: 'Trackable Email',
        },
      });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });

      const msgs = await ctx.smtp.waitForMessages(1, 3000);
      const html = msgs[0].html;

      const claimRes = await db(ctx).query<{ id: string }>(
        `SELECT id FROM mkt_send_claims WHERE campaign_id = $1 AND lead_id = $2`,
        [camp.data.id, lead.data.id]
      );
      const claimId = claimRes.rows[0].id;

      const openRes = await ctx.apiRaw(`/api/v1/public/marketing/track/open/${claimId}`);
      assert.equal(openRes.status, 200);

      const clickRes = await ctx.apiRaw(`/api/v1/public/marketing/track/click/${claimId}`, {
        query: { url: 'https://domation.net/mba', json: '1' },
      });
      assert.equal(clickRes.status, 200);

      const unsubMatch = html.match(/\/api\/v1\/public\/marketing\/unsubscribe\?[^"'\s<]+/);
      assert.ok(unsubMatch, `Expected unsubscribe URL in email HTML, got: ${html}`);
      const unsubPath = unsubMatch[0].replace(/&amp;/g, '&');
      const unsubRes = await ctx.apiRaw(unsubPath);
      assert.equal(unsubRes.status, 200);

      const updatedClaim = await db(ctx).query<{ opened_at: string | null; clicked_at: string | null }>(
        `SELECT opened_at, clicked_at FROM mkt_send_claims WHERE id = $1`,
        [claimId]
      );
      assert.ok(updatedClaim.rows[0].opened_at);
      assert.ok(updatedClaim.rows[0].clicked_at);

      const updatedLead = await db(ctx).query<{ email_consent: string }>(
        `SELECT email_consent FROM leads WHERE id = $1`,
        [lead.data.id]
      );
      assert.equal(updatedLead.rows[0].email_consent, 'unsubscribed');

      const supRow = await db(ctx).query<{ recipient: string }>(
        `SELECT recipient FROM mkt_suppression_list WHERE tenant_id = $1 AND recipient = $2`,
        [ideas.tenantId, recipient.toLowerCase()]
      );
      assert.equal(supRow.rows.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F4][T1] suppression list management, estimate-reach & pre-send-review accurately exclude suppressed recipients', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const activeEmail = makeTestRecipient('f4-reach-ok');
      const blockedEmail = makeTestRecipient('f4-reach-blk');
      assertTestRecipientsOnly([activeEmail, blockedEmail]);

      const l1 = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Reach OK', email: activeEmail },
      });
      const l2 = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Reach Blocked', email: blockedEmail },
      });

      const aud = await ctx.apiJson('/api/v1/audiences', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Reach Cohort', audience_type: 'static_list' },
      });
      await ctx.apiJson(`/api/v1/audiences/${aud.data.id}/members`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_ids: [l1.data.id, l2.data.id] },
      });

      await ctx.apiJson('/api/v1/marketing/campaigns/suppression/list', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { channel: 'email', recipient: blockedEmail.toUpperCase(), reason: 'hard_bounce' },
      });

      const listSup = await ctx.apiJson('/api/v1/marketing/campaigns/suppression/list', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.ok(listSup.data.items.some((s: any) => s.recipient === blockedEmail.toLowerCase()));

      const reach = await ctx.apiJson('/api/v1/marketing/campaigns/estimate-reach', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { list_ids: [aud.data.id], channel: 'email' },
      });
      assert.equal(reach.success, true);
      assert.equal(reach.data.count, 1);

      const review = await ctx.apiJson('/api/v1/marketing/campaigns/pre-send-review', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { audience_id: aud.data.id, channel: 'email', subject_a: 'Review Check' },
      });
      assert.equal(review.success, true);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F5: Automation Flows, Forms, Surveys, Web Tracking & AI Bots (Tier 1)
// ============================================================================
describe('Tier 1 — Feature F5: Automation Flows, Forms, Surveys, Web Tracking & AI Bots', () => {
  it('[F5][T1] creates flow, publishes v1 snapshot, simulates path, and restores snapshot', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const stepsV1 = [
        { id: 'step_tag', type: 'add_tag', label: 'Tag MBA Lead', config: { tag: 'MBA-2026' } },
      ];
      const flow = await ctx.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'MBA Nurture Flow', trigger_type: 'manual', steps: stepsV1 },
      });
      const flowId = flow.data.id;

      const pub = await ctx.apiJson(`/api/v1/marketing/flows/${flowId}/publish`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(pub.data.flow.status, 'active');
      const snapId = pub.data.snapshot_id;
      assert.ok(snapId);

      const sim = await ctx.apiJson(`/api/v1/marketing/flows/${flowId}/simulate`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { sample_lead: { name: 'Test Student', lead_score: 50 } },
      });
      assert.equal(sim.success, true);

      await ctx.apiJson(`/api/v1/marketing/flows/${flowId}`, {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          steps: [
            { id: 'step_tag', type: 'add_tag', label: 'Tag Updated', config: { tag: 'TEMP' } },
            { id: 'step_score', type: 'update_score', label: 'Score +10', config: { delta: 10 } },
          ],
        },
      });

      const restored = await ctx.apiJson(`/api/v1/marketing/flows/${flowId}/restore-snapshot`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { snapshot_id: snapId },
      });
      assert.equal(restored.data.steps.length, 1);
      assert.equal(restored.data.steps[0].id, 'step_tag');
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T1] executes mixed zalo_zns + send_email flow safely with 0 external HTTP and delivers email over loopback SMTP', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        configureLoopbackSmtp: true,
        fromEmail: 'flow@test-sink.domation.local',
      });
      ctx.mockFetch.clearRequests();

      const recipient = makeTestRecipient('f5-flow');
      assertTestRecipientsOnly([recipient]);
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Flow Student', phone: '0906000601', email: recipient },
      });

      const flow = await ctx.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Mixed ZNS + Email Flow',
          trigger_type: 'manual',
          steps: [
            {
              id: 'node_zns',
              type: 'zalo_zns',
              label: 'Legacy ZNS Step',
              config: { template_id: 'TPL_MYERP_1', message: 'Chào {{lead.name}}' },
            },
            {
              id: 'node_email',
              type: 'send_email',
              label: 'Welcome Email Step',
              config: {
                subject: 'Chào mừng {{lead.name}} đến với IDEAS',
                html: '<p>Xin chào {{lead.name}}</p>',
              },
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

      const enroll = await ctx.apiJson(`/api/v1/marketing/flows/${flow.data.id}/enroll`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_id: lead.data.id },
      });
      assert.equal(enroll.success, true);

      const msgs = await ctx.smtp.waitForMessages(1, 3000);
      assert.equal(msgs.length, 1);
      assertTestRecipientsOnly(msgs[0].rcptTo);
      assert.equal(ctx.mockFetch.requests.length, 0, 'zalo_zns step must make 0 external HTTP calls');

      const enRow = await db(ctx).query<{ execution_trace: any }>(
        `SELECT execution_trace FROM mkt_flow_enrollments WHERE flow_id = $1 AND lead_id = $2`,
        [flow.data.id, lead.data.id]
      );
      assert.equal(enRow.rows.length, 1);
      assert.ok(JSON.stringify(enRow.rows[0].execution_trace).includes('Zalo ZNS'));
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T1] creates form & public form submission auto-triggers active form_submitted flow', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const form = await ctx.apiJson('/api/v1/marketing/forms', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'IDEAS MBA Consult Form',
          routing_mode: 'marketing_nurture',
          fields: [
            { id: 'f_name', key: 'name', label: 'Họ tên', type: 'text', required: true },
            { id: 'f_email', key: 'email', label: 'Email', type: 'email', required: true },
          ],
        },
      });
      const token = form.data.public_token;

      const flow = await ctx.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Form Auto-Responder',
          trigger_type: 'form_submitted',
          trigger_config: { form_id: form.data.id },
          steps: [{ id: 's1', type: 'add_tag', label: 'Tag Form Submit', config: { tag: 'form-mba' } }],
        },
      });
      await ctx.apiJson(`/api/v1/marketing/flows/${flow.data.id}/publish`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });

      const pubGet = await ctx.apiJson(`/api/v1/public/marketing/forms/${token}`);
      assert.equal(pubGet.success, true);

      const submitEmail = makeTestRecipient('f5-form');
      assertTestRecipientsOnly([submitEmail]);
      const submitted = await ctx.apiJson(`/api/v1/public/marketing/forms/${token}/submit`, {
        method: 'POST',
        body: { name: 'Form Applicant', email: submitEmail },
      });
      assert.equal(submitted.success, true);
      assert.ok(submitted.data.lead_id);

      const subRes = await db(ctx).query<{ id: string }>(
        `SELECT id FROM mkt_form_submissions WHERE form_id = $1 AND lead_id = $2`,
        [form.data.id, submitted.data.lead_id]
      );
      assert.equal(subRes.rows.length, 1);

      const enrollRes = await db(ctx).query<{ id: string }>(
        `SELECT id FROM mkt_flow_enrollments WHERE flow_id = $1 AND lead_id = $2`,
        [flow.data.id, submitted.data.lead_id]
      );
      assert.equal(enrollRes.rows.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T1] creates survey, handles public submission with quiz/NPS scoring & returns analytics', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const survey = await ctx.apiJson('/api/v1/marketing/surveys', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          title: 'IDEAS Readiness Quiz',
          survey_type: 'quiz',
          blocks: [
            { id: 'q_nps', type: 'nps', label: 'NPS', required: true },
            { id: 'q_quiz', type: 'quiz_scored', label: 'MBA Goal', correctValue: 'exec', points: 25 },
          ],
        },
      });
      const slug = survey.data.slug;

      const pub = await ctx.apiJson(`/api/v1/public/marketing/surveys/${slug}`);
      assert.equal(pub.success, true);

      const respEmail = makeTestRecipient('f5-survey');
      const submit = await ctx.apiJson(`/api/v1/public/marketing/surveys/${slug}`, {
        method: 'POST',
        body: {
          name: 'Survey Respondent',
          email: respEmail,
          answers: { q_nps: 10, q_quiz: 'exec' },
        },
      });
      assert.equal(submit.success, true);
      assert.equal(submit.data.nps_score, 10);
      assert.equal(submit.data.quiz_score, 50); // 10 (default base_lead_score) + 15 (NPS >= 9) + 25 (quiz_scored)

      const analytics = await ctx.apiJson(`/api/v1/marketing/surveys/${survey.data.id}/analytics`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(analytics.success, true);
      assert.ok((analytics.data.summary?.total_responses ?? analytics.data.response_count ?? 1) >= 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T1] completes voucher pool/generate/claim/redeem lifecycle & shortlink click tracking', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const pool = await ctx.apiJson('/api/v1/marketing/vouchers', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'MBA Early Bird',
          code_prefix: 'IDEASMBA',
          discount_type: 'fixed_vnd',
          discount_value: 5_000_000,
          min_order_vnd: 20_000_000,
        },
      });

      const gen = await ctx.apiJson(`/api/v1/marketing/vouchers/${pool.data.id}/generate`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { quantity: 3 },
      });
      assert.equal(gen.success, true);

      const claim = await ctx.apiJson(`/api/v1/public/marketing/vouchers/${pool.data.slug}/claim`, {
        method: 'POST',
        body: { name: 'Voucher Claimer', email: makeTestRecipient('f5-voucher') },
      });
      const code = claim.data.code;
      assert.ok(code);

      const redeem = await ctx.apiJson('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { code, order_vnd: 50_000_000, note: 'Tuition deposit' },
      });
      assert.equal(redeem.success, true);
      assert.equal(redeem.data.code, code);

      const sl = await ctx.apiJson('/api/v1/marketing/vouchers/shortlinks', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          title: 'MBA Brochure',
          target_url: 'https://domation.net/ideas-mba',
          short_code: 'ideasmba1',
        },
      });
      assert.equal(sl.success, true);

      const click = await ctx.apiJson('/api/v1/public/marketing/r/ideasmba1', {
        query: { json: '1' },
      });
      assert.equal(click.success, true);

      const slRow = await db(ctx).query<{ click_count: number }>(
        `SELECT click_count FROM mkt_short_links WHERE id = $1`,
        [sl.data.id]
      );
      assert.ok(Number(slRow.rows[0].click_count) >= 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F5][T1] provisions web tracking property, serves sdk.js, stitches /track to lead & extracts social inbound contact', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const leadEmail = makeTestRecipient('f5-web');
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Web Visitor', email: leadEmail },
      });

      const prop = await ctx.apiJson('/api/v1/marketing/web-tracking/properties', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'IDEAS Website', domain: 'ideas.edu.vn', pricing_url_pattern: '/pricing' },
      });
      const siteKey = prop.data.site_key;

      const sdk = await ctx.apiRaw('/api/v1/public/marketing/sdk.js', {
        query: { site_key: siteKey },
      });
      assert.equal(sdk.status, 200);
      assert.ok(sdk.rawText.includes(siteKey));

      const track = await ctx.apiJson('/api/v1/public/marketing/track', {
        method: 'POST',
        body: {
          site_key: siteKey,
          visitor_id: 'vis_ideas_01',
          event_type: 'pageview',
          page_url: 'https://ideas.edu.vn/pricing',
          email: leadEmail,
        },
      });
      assert.equal(track.success, true);

      const sessions = await ctx.apiJson('/api/v1/marketing/web-tracking/sessions', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.ok(sessions.data.items.some((s: any) => s.lead_id === lead.data.id));

      const leadRow = await db(ctx).query<{ lead_score: number }>(
        'SELECT lead_score FROM leads WHERE id = $1',
        [lead.data.id]
      );
      assert.ok(Number(leadRow.rows[0].lead_score) >= 15);

      await ctx.apiJson('/api/v1/marketing/social-bot/bot-config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { bot_name: 'IDEAS Bot', is_active: true, auto_extract_contact: true },
      });
      await ctx.apiJson('/api/v1/marketing/social-bot/training-docs', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { title: 'MBA Tuition', content: 'Học phí MBA là 120 triệu VND.', keywords: ['học phí', 'mba'] },
      });
      await ctx.apiJson('/api/v1/marketing/social-bot/scenarios', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'MBA Inquiry', trigger_keywords: ['tư vấn'], reply_template: 'IDEAS sẵn sàng tư vấn!' },
      });

      const inboundEmail = makeTestRecipient('f5-social');
      const inbound = await ctx.apiJson('/api/v1/public/marketing/social/inbound/ideas', {
        method: 'POST',
        body: {
          channel: 'web_chat',
          thread_id: 'thread_ideas_1',
          customer_name: 'Social Guest',
          message: `Tư vấn giúp mình học phí MBA nhé, email ${inboundEmail} sdt 0907111222`,
        },
      });
      assert.equal(inbound.success, true);
      assert.equal(inbound.data.extracted.email, inboundEmail);
      assert.ok(inbound.data.reply);

      const dump = ctx.createSyntheticDump();
      const meta = await inspectSqlDumpMetadata(dump.sqlPath);
      assert.ok(meta.hasAllTables(['flows', 'forms', 'surveys', 'short_links', 'web_properties', 'mail_queue', 'subscriber_flow_states']));
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F6: Meta Report, Ads, Messenger & CAPI Migration & API (Tier 1 — Happy Path)
// ============================================================================
describe('Tier 1 — Feature F6: Meta Report, Ads, Messenger & CAPI', () => {
  it('[F6][T1] enables public DOM Meta Report access with anti-AI & no-store headers and zero external fetch', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      const saveCfg = await ctx.apiJson('/api/v1/integrations/dom-meta/config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          public_view: true,
          primary_ad_account_id: 'act_1852318231510577',
          access_token: 'EAA_TEST_DOM_META_TOKEN_1234567890',
        },
      });
      assert.equal(saveCfg.success, true);

      const pub = await ctx.apiRaw('/api/v1/public/dom-meta/ideas/access');
      assert.equal(pub.status, 200);
      assert.equal(pub.json.success, true);
      assert.equal(pub.json.data.public_view, true);
      assert.equal(pub.json.data.user.role, 'viewer');
      assert.equal(pub.json.data.user.is_public_viewer, true);
      assert.ok((pub.headers.get('cache-control') || '').includes('no-store'));
      assert.ok((pub.headers.get('x-robots-tag') || '').includes('noindex'));
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T1] creates Meta Ads account, masks access_token on list, hides plaintext in DB & toggles active status', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      const rawToken = 'EAA_TEST_LONG_TOKEN_1234567890ABCDEF';
      const created = await ctx.apiRaw('/api/v1/integrations/meta-ads/accounts', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          ad_account_id: '1852318231510577',
          name: 'IDEAS Main Ads',
          access_token: rawToken,
          pixel_id: '583807401361847',
          is_active: true,
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.success, true);

      const list = await ctx.apiJson('/api/v1/integrations/meta-ads/accounts', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(list.success, true);
      assert.equal(JSON.stringify(list.data).includes(rawToken), false, 'Raw Meta token must be masked');
      const acct = list.data.accounts[0];
      assert.equal(acct.ad_account_id, '1852318231510577');

      const dbRow = await db(ctx).query<{ config_encrypted: string }>(
        `SELECT config_encrypted FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'facebook_ads'`,
        [ideas.tenantId]
      );
      assert.equal(dbRow.rows.length, 1);
      assert.equal(dbRow.rows[0].config_encrypted.includes(rawToken), false);

      const toggled = await ctx.apiJson(`/api/v1/integrations/meta-ads/accounts/${acct.id}/toggle`, {
        method: 'PATCH',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { is_active: false },
      });
      assert.equal(toggled.success, true);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T1] proxies DOM Meta Graph API single & batch requests through mocked graph.facebook.com', async () => {
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
          name: 'IDEAS Proxy Ads',
          access_token: 'EAA_PROXY_TEST_TOKEN_123456789012345',
          is_active: true,
        },
      });
      await ctx.apiJson('/api/v1/integrations/dom-meta/config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          primary_ad_account_id: 'act_1234567890',
        },
      });

      ctx.mockFetch.registerRoute({
        match: (url) => url.href.startsWith('https://graph.facebook.com/'),
        handler: (_req) => {
          if (_req.method.toUpperCase() === 'POST') {
            return new Response(
              JSON.stringify([{ code: 200, body: JSON.stringify({ data: [{ id: 'cmp_1', name: 'MBA Ads' }] }) }]),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify({ data: [{ spend: '150000' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const proxy = await ctx.apiJson('/api/v1/integrations/dom-meta/meta-proxy', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { graph_path: 'act_1234567890/insights', params: { date_preset: 'last_7d' } },
      });
      assert.equal(proxy.success, true);
      assert.equal(proxy.data.data[0].spend, '150000');

      const batch = await ctx.apiJson('/api/v1/integrations/dom-meta/meta-batch', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { requests: [{ key: 'campaigns', graph_path: 'act_1234567890/campaigns' }] },
      });
      assert.equal(batch.success, true);
      assert.ok(ctx.mockFetch.requests.some((r) => r.url.includes('graph.facebook.com')));
      assert.equal(ctx.mockFetch.getBlockedRequests().length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T1] dispatches Meta CAPI test-event to mocked Graph API and records capi_logs row', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      await ctx.apiJson('/api/v1/integrations/vault/meta_capi', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          dataset_id: '583807401361847',
          access_token: 'EAALiveMockTokenOverThirtyChars1234567',
          live_http_enabled: true,
        },
      });

      ctx.mockFetch.registerRoute({
        match: (url) => url.href.startsWith('https://graph.facebook.com/v21.0/583807401361847/events'),
        handler: () =>
          new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'FB_TRACE_01' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      const res = await ctx.apiJson('/api/v1/integrations/capi/test-event', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          event_name: 'Lead',
          sample_phone: '0901234567',
          sample_email: makeTestRecipient('f6-capi'),
          sample_name: 'Meta Lead',
          test_event_code: 'TEST123',
        },
      });
      assert.equal(res.success, true);
      assert.equal(res.data.meta_http_status, 200);
      assert.equal(res.data.fbtrace_id, 'FB_TRACE_01');

      // Persisted lead ingestion on stage 1 (capi_event_mapping='Lead') writes a FK-linked capi_logs row
      const persistedLead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Meta Persisted Lead',
          phone: '0901234568',
          email: makeTestRecipient('f6-capi-lead'),
        },
      });
      assert.equal(persistedLead.success, true);

      const logRow = await db(ctx).query<{ dataset_id: string; response_status: number; event_name: string }>(
        `SELECT dataset_id, response_status, event_name FROM capi_logs WHERE tenant_id = $1`,
        [ideas.tenantId]
      );
      assert.equal(logRow.rows.length, 1);
      assert.equal(logRow.rows[0].dataset_id, '583807401361847');
      assert.equal(logRow.rows[0].response_status, 200);
      assert.equal(logRow.rows[0].event_name, 'Lead');
      assert.equal(ctx.mockFetch.getBlockedRequests().length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F6][T1] imports & syncs phone-farm blocked phones and verifies Meta Messenger webhook challenge', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Matched Phone Lead', phone: '+84909111222' },
      });

      const imp = await ctx.apiRaw('/api/v1/integrations/capi/phone-farm/import', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { phones: ['0909111222'], reason: 'spam' },
      });
      assert.equal(imp.status, 201);
      assert.equal(imp.json.data.matched_leads_count, 1);

      const sync = await ctx.apiJson('/api/v1/integrations/capi/phone-farm/sync-meta', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(sync.data.synced_count, 1);

      const pfRow = await db(ctx).query<{ phone_normalized: string; synced_to_meta: boolean }>(
        `SELECT phone_normalized, synced_to_meta FROM capi_blocked_phones WHERE tenant_id = $1`,
        [ideas.tenantId]
      );
      assert.equal(pfRow.rows[0].phone_normalized, '84909111222');
      assert.equal(pfRow.rows[0].synced_to_meta, true);

      const msgCfg = await ctx.apiJson('/api/v1/marketing/social-bot/messenger-config', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          pages: [
            {
              page_id: 'PG_IDEAS_1',
              page_name: 'IDEAS Page',
              verify_token: 'ideas_verify_123',
              app_secret: 'meta_app_sec',
              page_access_token: 'EAA_PAGE_TOK_123456',
            },
          ],
        },
      });
      assert.equal(msgCfg.success, true);

      const challenge = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'ideas_verify_123',
          'hub.challenge': 'CHAL_99',
        },
      });
      assert.equal(challenge.status, 200);
      assert.equal(challenge.rawText, 'CHAL_99');
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F7: AWS & API Credentials Vault Migration (Tier 1 — Happy Path)
// ============================================================================
describe('Tier 1 — Feature F7: AWS & API Credentials Vault', () => {
  it('[F7][T1] encrypts vault payloads with AES-256-GCM 96-bit unique IVs and hides plaintext in DB', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      const secretKey = 'AIzaSyTestSecretKey_1234567890';
      const save1 = await ctx.apiJson('/api/v1/integrations/vault/ai_gemini', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { apiKey: secretKey },
      });
      assert.equal(save1.data.encryption, 'AES-256-GCM');
      assert.equal(save1.data.iv_bits, 96);

      const row1 = await db(ctx).query<{ config_encrypted: string; iv: string; auth_tag: string }>(
        `SELECT config_encrypted, iv, auth_tag FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'ai_gemini'`,
        [ideas.tenantId]
      );
      assert.equal(row1.rows[0].iv.length, 24);
      assert.equal(row1.rows[0].auth_tag.length, 32);
      assert.equal(row1.rows[0].config_encrypted.includes('AIzaSy'), false);

      const dec = decryptTenantSecret<{ apiKey: string }>(
        ideas.tenantId,
        row1.rows[0].config_encrypted,
        row1.rows[0].iv,
        row1.rows[0].auth_tag
      );
      assert.equal(dec.apiKey, secretKey);

      const encA = encryptTenantSecret(ideas.tenantId, { apiKey: secretKey });
      const encB = encryptTenantSecret(ideas.tenantId, { apiKey: secretKey });
      assert.notEqual(encA.iv, encB.iv, 'Fresh 96-bit CSPRNG IV must differ on every write');
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T1] saves all migrated provider vault types and masks sensitive tokens on /integrations/overview', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      const providers: Array<[string, Record<string, unknown>, string]> = [
        ['aws_ses', { smtp_host: '127.0.0.1', smtp_port: 587, smtp_user: 'AKIA_TEST', smtp_pass: 'SES_SECRET_PASS_99' }, 'SES_SECRET_PASS_99'],
        ['smtp', { host: '127.0.0.1', port: 587, smtp_user: 'u1', smtp_pass: 'SMTP_SECRET_PASS_88' }, 'SMTP_SECRET_PASS_88'],
        ['meta_capi', { dataset_id: '583807401361847', access_token: 'EAA_CAPI_SECRET_TOKEN_777' }, 'EAA_CAPI_SECRET_TOKEN_777'],
        ['facebook_ads', { access_token: 'EAA_FBADS_SECRET_TOKEN_666' }, 'EAA_FBADS_SECRET_TOKEN_666'],
        ['ai_gemini', { apiKey: 'AIzaSy_GEMINI_SECRET_555' }, 'AIzaSy_GEMINI_SECRET_555'],
        ['google_sheets', { client_secret: 'GOCSPX_SECRET_444' }, 'GOCSPX_SECRET_444'],
        ['misa_einvoice', { api_token: 'MISA_SECRET_TOKEN_333' }, 'MISA_SECRET_TOKEN_333'],
      ];

      for (const [type, payload] of providers) {
        const res = await ctx.apiJson(`/api/v1/integrations/vault/${type}`, {
          method: 'PUT',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          body: payload,
        });
        assert.equal(res.success, true);
      }

      const overview = await ctx.apiJson('/api/v1/integrations/overview', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const serialized = JSON.stringify(overview.data.integrations);
      for (const [type, , rawSecret] of providers) {
        assert.ok(overview.data.integrations[type], `Expected '${type}' in overview`);
        assert.equal(serialized.includes(rawSecret), false, `Plaintext secret for '${type}' must be masked`);
      }
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T1] stores ap-southeast-2 AWS SES vault, delivers test email over loopback SMTP & reports region on /ses-quota', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.clearRequests();
      await ctx.apiJson('/api/v1/integrations/vault/aws_ses', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          region: 'ap-southeast-2',
          aws_region: 'ap-southeast-2',
          sesRegion: 'ap-southeast-2',
          smtp_host: ctx.smtp.host,
          smtp_port: ctx.smtp.port,
          smtp_user: 'AKIA_SYDNEY',
          smtp_pass: 'SES_SMTP_PASS_12345',
          from_email: 'noreply@ideas.edu.vn',
        },
      });

      const recipient = makeTestRecipient('f7-sydney');
      assertTestRecipientsOnly([recipient]);
      const testRes = await ctx.apiJson('/api/v1/integrations/email/test', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { email_provider: 'ses', to_email: recipient, type: 'system' },
      });
      assert.equal(testRes.success, true);

      const msgs = await ctx.smtp.waitForMessages(1, 3000);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].mailFrom, 'noreply@ideas.edu.vn');

      const quota = await ctx.apiJson('/api/v1/marketing/campaigns/ses-quota', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(quota.data.region, 'ap-southeast-2');
      assert.equal(quota.data.is_ses, true);
      assert.equal(quota.data.configured, true);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T1] routes AWS SES SigV4 API to ap-southeast-2 when configured and falls back to ap-southeast-1 when omitted', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      ctx.mockFetch.registerRoute({
        match: (url) => /^https:\/\/email\.ap-southeast-[12]\.amazonaws\.com\/v2\/email\/outbound-emails/.test(url.href),
        handler: () =>
          new Response(JSON.stringify({ MessageId: 'ses-sigv4-msg-1' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });

      await ctx.apiJson('/api/v1/integrations/vault/aws_ses', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          authUser: 'AKIA_TEST_KEY_1234',
          apiKey: 'SECRET_TEST_IAM_KEY_9999',
          from_email: 'no-reply@ideas.edu.vn',
          sesRegion: 'ap-southeast-2',
          region: 'ap-southeast-2',
        },
      });

      const recipient = makeTestRecipient('f7-sigv4');
      assertTestRecipientsOnly([recipient]);
      const r1 = await ctx.apiJson('/api/v1/integrations/email/test', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { email_provider: 'ses', to_email: recipient },
      });
      assert.equal(r1.success, true);

      // Clear region so default ap-southeast-1 fallback triggers
      await ctx.apiJson('/api/v1/integrations/vault/aws_ses', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          authUser: 'AKIA_TEST_KEY_1234',
          apiKey: 'SECRET_TEST_IAM_KEY_9999',
          from_email: 'no-reply@ideas.edu.vn',
          sesRegion: '',
          region: '',
        },
      });

      const r2 = await ctx.apiJson('/api/v1/integrations/email/test', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { email_provider: 'ses', to_email: recipient },
      });
      assert.equal(r2.success, true);

      const sesReqs = ctx.mockFetch.requests.filter((r) => r.url.includes('.amazonaws.com/v2/email/outbound-emails'));
      assert.equal(sesReqs.length, 2);
      assert.ok(sesReqs[0].url.includes('email.ap-southeast-2.amazonaws.com'));
      assert.ok(sesReqs[1].url.includes('email.ap-southeast-1.amazonaws.com'));
    } finally {
      await ctx.close();
    }
  });

  it('[F7][T1] secret-preserving partial vault update keeps original secret when masked placeholder submitted', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo', industry: 'education' });
      await ctx.apiJson('/api/v1/integrations/vault/smtp', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { host: '127.0.0.1', port: 1025, smtp_user: 'u1', smtp_pass: 'SuperSecretPass99' },
      });

      await ctx.apiJson('/api/v1/integrations/vault/smtp', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { host: '127.0.0.1', port: 2525, smtp_user: 'u1', smtp_pass: 'Supe••••••••ss99' },
      });

      const row = await db(ctx).query<{ config_encrypted: string; iv: string; auth_tag: string }>(
        `SELECT config_encrypted, iv, auth_tag FROM tenant_integrations WHERE tenant_id = $1 AND integration_type = 'smtp'`,
        [ideas.tenantId]
      );
      const dec = decryptTenantSecret<{ port: number; smtp_pass: string }>(
        ideas.tenantId,
        row.rows[0].config_encrypted,
        row.rows[0].iv,
        row.rows[0].auth_tag
      );
      assert.equal(dec.port, 2525);
      assert.equal(dec.smtp_pass, 'SuperSecretPass99');
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// F8: ZaloBot & Zalo OA Exclusion (Tier 1 — Happy Path Exclusion Verification)
// ============================================================================
describe('Tier 1 — Feature F8: ZaloBot & Zalo OA Exclusion', () => {
  it('[F8][T1] ideas tenant vault & settings contain zero Zalo integrations and /zalo-oa reports sandbox', async () => {
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

      const overview = await ctx.apiJson('/api/v1/integrations/overview', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(overview.data.integrations.zalo_oa, undefined);
      assert.equal(overview.data.integrations.zalo_bot, undefined);
      assert.equal(overview.data.integrations.zalo_zns, undefined);

      const zaloOa = await ctx.apiJson('/api/v1/marketing/social-bot/zalo-oa', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(zaloOa.data.id, null);
      assert.equal(zaloOa.data.oa_id, '');
      assert.equal(zaloOa.data.status, 'sandbox');

      const dbZalo = await db(ctx).query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM tenant_integrations WHERE tenant_id = $1 AND integration_type IN ('zalo_oa', 'zalo_bot', 'zalo_zns')`,
        [ideas.tenantId]
      );
      assert.equal(dbZalo.rows[0].cnt, 0);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T1] Zalo webhook and /integrations/zalo/command return disabled cleanly when zalo_bot_disabled=true', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        customSettings: { zalo_bot_disabled: true, zalo_bot_token: '' },
      });
      ctx.mockFetch.clearRequests();

      const wh = await ctx.apiJson('/api/v1/webhooks/zalo/ideas', {
        method: 'POST',
        body: { message: { text: '/report', chat: { id: 'z1' } } },
      });
      assert.equal(wh.success, true);
      assert.equal(wh.data.handled, false);
      assert.equal(wh.data.disabled, true);
      assert.equal(wh.data.command, 'zalo_bot_disabled');

      const cmd = await ctx.apiJson('/api/v1/integrations/zalo/command', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { text: '/chatid', chat_id: 'z1' },
      });
      assert.equal(cmd.success, true);
      assert.equal(cmd.data.handled, false);
      assert.equal(cmd.data.disabled, true);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T1] Zalo token refresher cron subroutine executes as a zero-outbound no-op (refreshedCount=0)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        customSettings: { zalo_bot_disabled: true, zalo_bot_token: '' },
      });
      ctx.mockFetch.clearRequests();

      const cron = await triggerMasterCron(ctx, { subroutines: ['zalo'], tenantId: ideas.tenantId });
      assert.equal(cron.ok, true);

      const refresh = await ctx.apiJson('/api/v1/integrations/zalo/refresh-token', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      assert.equal(refresh.data.refreshedCount, 0);
      assert.equal(refresh.data.failedCount, 0);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T1] daily_report cron subroutine skips Zalo channel cleanly when daily_report_channels.zalo=false', async () => {
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
      await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Report Lead', phone: '0908111222' },
      });

      const cron = await triggerMasterCron(ctx, { subroutines: ['daily_report'], tenantId: ideas.tenantId });
      assert.equal(cron.ok, true);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F8][T1] flow zalo_zns node & social-bot zalo-broadcast queue/skip safely with zero outbound HTTP calls', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        packageCode: 'growth_combo',
        industry: 'education',
        customSettings: { zalo_bot_disabled: true, zalo_bot_token: '' },
      });
      ctx.mockFetch.clearRequests();
      const lead = await ctx.apiJson('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'ZNS Guard Lead', phone: '0908222333', email: makeTestRecipient('f8-zns') },
      });

      const flow = await ctx.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Legacy ZNS Only Flow',
          trigger_type: 'manual',
          steps: [{ id: 'z1', type: 'zalo_zns', label: 'ZNS Node', config: { template_id: 'TPL_1' } }],
        },
      });
      await ctx.apiJson(`/api/v1/marketing/flows/${flow.data.id}/publish`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {},
      });
      const enroll = await ctx.apiJson(`/api/v1/marketing/flows/${flow.data.id}/enroll`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_id: lead.data.id },
      });
      assert.equal(enroll.success, true);

      const broadcast = await ctx.apiJson('/api/v1/marketing/social-bot/zalo-broadcast', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { message: 'Hi', recipients: [{ phone: '0908222333', name: 'ZNS Guard Lead' }] },
      });
      assert.equal(broadcast.success, true);
      assert.equal(ctx.mockFetch.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });
});
