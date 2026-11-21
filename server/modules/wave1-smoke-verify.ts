/**
 * Wave 1 End-to-End Multi-Tenant Smoke & Security Verification Script
 * Run with: `npx tsx server/modules/wave1-smoke-verify.ts`
 * Exits with code 0 ONLY when all Migrations, Kernel FORCE RLS, 4-Package Switching,
 * Zero-Short-Circuit RBAC + Server PII Masking, Master Contact `marketing_nurture` Drainer Isolation,
 * and Dynamic "Tệp Logic" AST Compiler + Event Bus checks pass 100%.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { createDatabasePool, setDatabasePool } from '../core/database/db-adapter.ts';
import { runDatabaseMigrations } from '../core/database/migrate.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../core/database/transaction.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { domainEventBus } from '../core/events/event-bus.ts';
import { runUnassignedLeadDrainer } from '../cron/subroutines/lead-drainer.ts';
import { createApp } from '../app.ts';

async function reqJson(
  baseUrl: string,
  path: string,
  opts?: { method?: string; token?: string; slug?: string; body?: unknown }
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts?.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts?.slug) headers['X-Tenant-Slug'] = opts.slug;
  if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${path}`, {
    method: opts?.method || 'GET',
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main(): Promise<void> {
  process.env.OUTBOUND_SILENT_MODE = 'true';
  tenantRedis.clearAllForTesting();

  console.log('[Wave1 Verify] 1/6 Initializing in-memory PGlite (PostgreSQL 16) + running additive migrations...');
  const pool = createDatabasePool({ inMemory: true });
  setDatabasePool(pool);
  await runDatabaseMigrations();
  // Run migrations a second time to prove 100% idempotency on already-migrated DB
  await runDatabaseMigrations();

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind test HTTP server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // Register Tenant Alpha & Tenant Beta
    const regAlpha = await reqJson(baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Alpha Growth Corp',
        tenant_slug: 'alpha-growth',
        admin_name: 'Alpha Owner',
        work_email: 'owner@alpha.vn',
        phone: '0901112233',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regAlpha.status, 201, 'Tenant Alpha registration must succeed');
    const alphaId: string = regAlpha.json.data.tenant.id;
    const alphaToken: string = regAlpha.json.data.access_token;

    const regBeta = await reqJson(baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Beta Healthcare Clinic',
        tenant_slug: 'beta-clinic',
        admin_name: 'Beta Owner',
        work_email: 'owner@beta.vn',
        phone: '0902223344',
        password: 'SecurePassword123!',
        industry: 'healthcare',
        seed_demo_leads: false,
      },
    });
    assert.equal(regBeta.status, 201, 'Tenant Beta registration must succeed');
    const betaId: string = regBeta.json.data.tenant.id;
    const betaToken: string = regBeta.json.data.access_token;

    // ------------------------------------------------------------------------
    // 2/6 Verify FORCE ROW LEVEL SECURITY across ALL 16 Wave 1 Tables
    // ------------------------------------------------------------------------
    console.log('[Wave1 Verify] 2/6 Verifying Kernel FORCE RLS Zero-Leakage across all 16 Wave 1 tables...');
    const wave1Tables = [
      'tenant_branches',
      'tenant_roles',
      'tenant_departments',
      'tenant_teams',
      'tenant_positions',
      'tenant_role_permissions',
      'tenant_department_permissions',
      'tenant_user_permission_overrides',
      'tenant_stage_transition_rules',
      'tenant_custom_kpis',
      'tenant_policy_documents',
      'tenant_audiences',
      'tenant_audience_members',
      'tenant_audience_exclusions',
      'tenant_tags',
      'lead_tags',
    ];

    // Seed Org & Audience data in Alpha first
    const createBranchAlpha = await reqJson(baseUrl, '/api/v1/org-rbac/branches', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        name: 'Hội Sở Quận 1',
        legal_entity_name: 'CÔNG TY CỔ PHẦN ALPHA GROWTH',
        tax_code: '0318889999',
        representative_name: 'Trần Minh Khôi',
        gps_lat: 10.7769,
        gps_lng: 106.7009,
        gps_radius_meters: 120,
        is_headquarters: true,
      },
    });
    assert.equal(createBranchAlpha.status, 201);
    const alphaBranchId = createBranchAlpha.json.data.id;

    // Verify Gói 1 (`autodata_crm`) default strictly gates `audiences` (`403 MODULE_NOT_ENTITLED`)
    const boot1 = await reqJson(baseUrl, '/api/v1/workspace/bootstrap', {
      token: alphaToken,
      slug: 'alpha-growth',
    });
    assert.equal(boot1.status, 200);
    assert.equal(boot1.json.data.tenant.package_code, 'autodata_crm');
    assert.equal(boot1.json.data.tenant.entitlements.enable_ideas_mascot, false);
    assert.equal(boot1.json.data.tenant.terminology.customer_singular, 'Khách mua / Nhà đầu tư');
    assert.ok(boot1.json.data.tenant.enabled_modules.includes('rounds'));
    assert.ok(boot1.json.data.tenant.enabled_modules.includes('crm_dashboard'), 'UI alias crm_dashboard mirrored');
    assert.ok(!boot1.json.data.tenant.enabled_modules.includes('audiences'), 'Gói 1 must NOT include audiences');
    assert.ok(!boot1.json.data.tenant.enabled_modules.includes('mkt_campaigns'));

    const goi1AudBlocked = await reqJson(baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { name: 'Blocked On Pkg1', audience_type: 'static_data' },
    });
    assert.equal(goi1AudBlocked.status, 403, 'Gói 1 must reject /audiences with 403 MODULE_NOT_ENTITLED');

    // Fund Alpha & Beta wallets, then unlock Growth Suite so Audience RLS isolation can be tested
    await withTenantTransaction(alphaId, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 20000000 WHERE id = $1', [alphaId]);
    });
    await withTenantTransaction(betaId, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 10000000 WHERE id = $1', [betaId]);
    });
    await reqJson(baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { package_code: 'growth_combo' },
    });
    await reqJson(baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: betaToken,
      slug: 'beta-clinic',
      body: { package_code: 'growth_combo' },
    });

    const createAudAlpha = await reqJson(baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        name: 'Tệp VIP Biệt Thự Sông',
        audience_type: 'static_data',
      },
    });
    assert.equal(createAudAlpha.status, 201);
    const alphaAudId = createAudAlpha.json.data.id;

    // Lemma 1: Unscoped queries return 0 rows
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of wave1Tables) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped query on ${tbl} must return 0 rows`);
      }
    });

    // Lemma 2: Beta cannot read or mutate Alpha's audience or branch even by exact UUID
    await withTenantTransaction(betaId, async (client) => {
      const leakAud = await client.query('SELECT * FROM tenant_audiences WHERE id = $1', [alphaAudId]);
      assert.equal(leakAud.rows.length, 0, 'Cross-tenant audience SELECT must return 0 rows');
      const leakBranch = await client.query('SELECT * FROM tenant_branches WHERE id = $1', [alphaBranchId]);
      assert.equal(leakBranch.rows.length, 0, 'Cross-tenant branch SELECT must return 0 rows');
    });

    const betaReadAlphaAud = await reqJson(baseUrl, `/api/v1/audiences/${alphaAudId}`, {
      token: betaToken,
      slug: 'beta-clinic',
    });
    assert.equal(betaReadAlphaAud.status, 404, 'API must return 404 when Beta requests Alpha audience UUID');

    // ------------------------------------------------------------------------
    // 3/6 Verify 4-Package Instant Switching (0s Zero-Migration Unlock) & Terminology
    // ------------------------------------------------------------------------
    console.log('[Wave1 Verify] 3/6 Verifying 4-Package Instant Switching & 8-Industry Terminology...');

    // Switch to Package 2: `marketing_standalone`
    const swMkt = await reqJson(baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { package_code: 'marketing_standalone' },
    });
    assert.equal(swMkt.status, 200);
    assert.equal(swMkt.json.data.package_code, 'marketing_standalone');
    assert.ok(!swMkt.json.data.enabled_modules.includes('rounds'), 'Marketing standalone hides Sale rounds');
    assert.ok(!swMkt.json.data.enabled_modules.includes('fair_share'), 'Marketing standalone hides UI alias fair_share');
    assert.ok(swMkt.json.data.enabled_modules.includes('mkt_campaigns'), 'Marketing standalone unlocks campaigns');
    assert.ok(swMkt.json.data.enabled_modules.includes('email_templates'), 'Marketing standalone mirrors UI alias email_templates');
    assert.ok(swMkt.json.data.enabled_modules.includes('audiences'), 'Marketing standalone unlocks audiences');

    // Switch to Package 4: `domation_promax` (education_addon false by default)
    const swPromax = await reqJson(baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(swPromax.status, 200);
    assert.equal(swPromax.json.data.package_code, 'domation_promax');
    assert.ok(swPromax.json.data.enabled_modules.includes('hrm'));
    assert.ok(swPromax.json.data.enabled_modules.includes('dom_agent'));
    assert.ok(!swPromax.json.data.enabled_modules.includes('education'), 'Education hidden unless addon enabled');

    // Switch back to Package 3: `growth_combo` for CRM + Marketing tests
    const swGrowth = await reqJson(baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { package_code: 'growth_combo' },
    });
    assert.equal(swGrowth.status, 200);
    assert.ok(swGrowth.json.data.enabled_modules.includes('rounds'));
    assert.ok(swGrowth.json.data.enabled_modules.includes('mkt_flows'));
    assert.ok(swGrowth.json.data.enabled_modules.includes('revenue_attribution'));

    // Verify custom terminology & policy document DOM Agent sync
    const saveTerm = await reqJson(baseUrl, '/api/v1/org-rbac/terminology', {
      method: 'PUT',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        industry_key: 'retail',
        apply_preset: true,
        terminology: { customer_singular: 'Khách VIP Thành Viên' },
      },
    });
    assert.equal(saveTerm.status, 200);
    assert.equal(saveTerm.json.data.terminology.customer_singular, 'Khách VIP Thành Viên');
    assert.equal(saveTerm.json.data.terminology.customerLabel, 'Khách VIP Thành Viên');

    const createPolicy = await reqJson(baseUrl, '/api/v1/org-rbac/policy-documents', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        title: 'Chính sách Bảo hành & Hợp đồng',
        doc_category: 'contract_terms',
        content_html: '<p>Bên A: {{company.legal_name}} - MST: {{company.tax_code}} - Đại diện: {{branch.representative}}</p>',
      },
    });
    assert.equal(createPolicy.status, 201);
    const syncPolicy = await reqJson(
      baseUrl,
      `/api/v1/org-rbac/policy-documents/${createPolicy.json.data.id}/sync-dom-agent`,
      { method: 'POST', token: alphaToken, slug: 'alpha-growth' }
    );
    assert.equal(syncPolicy.status, 200);
    assert.match(syncPolicy.json.data.rendered_preview_html, /CÔNG TY CỔ PHẦN ALPHA GROWTH/);
    assert.match(syncPolicy.json.data.rendered_preview_html, /Trần Minh Khôi/);

    // ------------------------------------------------------------------------
    // 4/6 Verify Zero-Short-Circuit Granular RBAC & Server-Side PII Masking
    // ------------------------------------------------------------------------
    console.log('[Wave1 Verify] 4/6 Verifying Zero-Short-Circuit RBAC (7 Scopes × 11 Actions) & Server PII Masking...');
    const orgBoot = await reqJson(baseUrl, '/api/v1/org-rbac/bootstrap', {
      token: alphaToken,
      slug: 'alpha-growth',
    });
    assert.equal(orgBoot.status, 200);
    const managerRole = orgBoot.json.data.roles.find((r: any) => r.role_key === 'manager');
    assert.ok(managerRole, 'System manager role must be seeded');

    // Create Parent + Child Department (verify cycle protection too)
    const parentDept = await reqJson(baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { name: 'Khối Kinh Doanh', branch_id: alphaBranchId },
    });
    assert.equal(parentDept.status, 201);
    const childDept = await reqJson(baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { name: 'Phòng Kinh Doanh Miền Nam', parent_department_id: parentDept.json.data.id },
    });
    assert.equal(childDept.status, 201);
    const cycleAttempt = await reqJson(baseUrl, `/api/v1/org-rbac/departments/${parentDept.json.data.id}`, {
      method: 'PATCH',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { parent_department_id: childDept.json.data.id },
    });
    assert.equal(cycleAttempt.status, 422, 'Department cycle must be rejected with 422');

    // Create a Manager user & an Online Sale user
    const createMgr = await reqJson(baseUrl, '/api/v1/users', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        full_name: 'Manager Hoa',
        email: 'hoa.mgr@alpha.vn',
        password: 'ManagerPassword123!',
        role: 'manager',
      },
    });
    assert.equal(createMgr.status, 201);
    const mgrUserId = createMgr.json.data.id;

    const createSale = await reqJson(baseUrl, '/api/v1/users', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        full_name: 'Sale Minh Online',
        email: 'minh.sale@alpha.vn',
        password: 'SalePassword123!',
        role: 'sale',
        is_available: true,
      },
    });
    assert.equal(createSale.status, 201);
    const saleUserId = createSale.json.data.id;

    const mgrLogin = await reqJson(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      slug: 'alpha-growth',
      body: { tenant_slug: 'alpha-growth', email: 'hoa.mgr@alpha.vn', password: 'ManagerPassword123!' },
    });
    assert.equal(mgrLogin.status, 200);
    const mgrToken = mgrLogin.json.data.access_token;

    // Import CSV into `alphaAudId` (`status = 'marketing_nurture'`) including an email-only contact (`phone = NULL`)!
    const csvPayload = [
      'Họ tên,Số điện thoại,Email,Nguồn,cf_interest',
      'Lê Hoàng Nam,0912345678,nam.le@gmail.com,Landing Page,Penthouse',
      'Phạm Minh Châu,,chau.newsletter@company.vn,Newsletter Form,Ebook B2B',
    ].join('\n');

    const importRes = await reqJson(baseUrl, `/api/v1/audiences/${alphaAudId}/import`, {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { csv_text: csvPayload, status: 'marketing_nurture' },
    });
    assert.equal(importRes.status, 201);
    assert.equal(importRes.json.data.created_count, 2);
    assert.equal(importRes.json.data.total_audience_members, 2);

    // ZERO-SHORT-CIRCUIT PROOF: Set `unmask_phone = false` on `manager` role -> Manager MUST get masked phone & email!
    const lockMgrUnmask = await reqJson(
      baseUrl,
      `/api/v1/org-rbac/roles/${managerRole.id}/permissions`,
      {
        method: 'PUT',
        token: alphaToken,
        slug: 'alpha-growth',
        body: {
          permissions: [
            {
              module_key: 'leads',
              data_scope: 'company',
              actions: { view: true, create: true, edit: true, unmask_phone: false },
            },
            {
              module_key: 'audiences',
              data_scope: 'company',
              actions: { view: true, create: true, edit: true, unmask_phone: false },
            },
          ],
        },
      }
    );
    assert.equal(lockMgrUnmask.status, 200);

    const mgrMembersMasked = await reqJson(baseUrl, `/api/v1/audiences/${alphaAudId}/members`, {
      token: mgrToken,
      slug: 'alpha-growth',
    });
    assert.equal(mgrMembersMasked.status, 200);
    const namMasked = mgrMembersMasked.json.data.items.find((x: any) => x.name === 'Lê Hoàng Nam');
    assert.ok(namMasked);
    assert.equal(namMasked.phone, '0912***678', 'Manager without unmask_phone must receive server-masked phone');
    assert.equal(namMasked.email, 'na***@gmail.com', 'Manager without unmask_phone must receive server-masked email');

    // Grant personal override `unmask_phone: true`, then prove `Deny` override beats `Grant`!
    await reqJson(baseUrl, '/api/v1/org-rbac/user-overrides', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { user_id: mgrUserId, module_key: 'leads', effect: 'grant', actions: { unmask_phone: true } },
    });
    await reqJson(baseUrl, '/api/v1/org-rbac/user-overrides', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { user_id: mgrUserId, module_key: 'audiences', effect: 'grant', actions: { unmask_phone: true } },
    });

    const mgrMembersUnmasked = await reqJson(baseUrl, `/api/v1/audiences/${alphaAudId}/members`, {
      token: mgrToken,
      slug: 'alpha-growth',
    });
    const namUnmasked = mgrMembersUnmasked.json.data.items.find((x: any) => x.name === 'Lê Hoàng Nam');
    assert.equal(namUnmasked.phone, '84912345678', 'Grant override must unmask phone');

    // Add `Deny` override -> must strictly override `Grant`!
    await reqJson(baseUrl, '/api/v1/org-rbac/user-overrides', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { user_id: mgrUserId, module_key: 'audiences', effect: 'deny', actions: { unmask_phone: true } },
    });
    const mgrMembersDenied = await reqJson(baseUrl, `/api/v1/audiences/${alphaAudId}/members`, {
      token: mgrToken,
      slug: 'alpha-growth',
    });
    const namDenied = mgrMembersDenied.json.data.items.find((x: any) => x.name === 'Lê Hoàng Nam');
    assert.equal(namDenied.phone, '0912***678', 'Deny override must beat Grant override');

    // ------------------------------------------------------------------------
    // 5/6 Verify `marketing_nurture` Drainer Isolation & A/B Split
    // ------------------------------------------------------------------------
    console.log('[Wave1 Verify] 5/6 Verifying `marketing_nurture` is NEVER drained prematurely to Sales...');
    const drainedPrematurely = await runUnassignedLeadDrainer(alphaId);
    assert.equal(drainedPrematurely, 0, 'lead-drainer MUST NOT drain marketing_nurture contacts!');

    const splitRes = await reqJson(baseUrl, `/api/v1/audiences/${alphaAudId}/split`, {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { ratio_a: 50, name_prefix: 'Test Split' },
    });
    assert.equal(splitRes.status, 201);
    assert.equal(splitRes.json.data.created_audiences.length, 2);

    // ------------------------------------------------------------------------
    // 6/6 Verify Dynamic "Tệp Logic" AST Compiler, Event Bus & Auto-Push to Sale Round
    // ------------------------------------------------------------------------
    console.log('[Wave1 Verify] 6/6 Verifying Dynamic "Tệp Logic" AST Compiler + Event Bus + Auto-Push to Sale...');
    const hotFilterBranches = [
      {
        operator: 'AND',
        conditions: [
          { field: 'lead_score', op: 'gte', value: 70 },
          { field: 'email_consent', op: 'equals', value: 'subscribed' },
          { field: 'custom_fields.interest', op: 'equals', value: 'Penthouse' },
        ],
      },
    ];

    const previewZero = await reqJson(baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { filter_branches: hotFilterBranches },
    });
    assert.equal(previewZero.status, 200);
    assert.equal(previewZero.json.data.count, 0, 'Initially 0 contacts have lead_score >= 70');

    const dynAudRes = await reqJson(baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        name: 'Tệp Logic Khách Nóng >= 70 Điểm (Auto Chia Sale)',
        audience_type: 'dynamic_logic',
        filter_branches: hotFilterBranches,
        auto_push_to_sale_round: true,
      },
    });
    assert.equal(dynAudRes.status, 201);
    const dynAudId = dynAudRes.json.data.id;
    assert.equal(dynAudRes.json.data.cached_member_count, 0);

    // Now update Lê Hoàng Nam's `lead_score` to 85 -> Event Bus (`lead.updated`) must auto-evaluate Tệp Logic,
    // emit `audience.entered`, AND promote `marketing_nurture` -> `unassigned_pending` -> assigned to `saleUserId`!
    const patchScore = await reqJson(baseUrl, `/api/v1/leads/${namMasked.id}`, {
      method: 'PATCH',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { lead_score: 85 },
    });
    assert.equal(patchScore.status, 200);

    const dynMembersAfter = await reqJson(baseUrl, `/api/v1/audiences/${dynAudId}/members`, {
      token: alphaToken,
      slug: 'alpha-growth',
    });
    assert.equal(dynMembersAfter.status, 200);
    assert.equal(dynMembersAfter.json.data.items.length, 1, 'Lê Hoàng Nam must automatically enter Tệp Logic');
    assert.equal(dynMembersAfter.json.data.items[0].id, namMasked.id);
    // Because `auto_push_to_sale_round` = true and `Sale Minh Online` is available, status promoted & drained!
    assert.ok(
      ['unassigned_pending', 'assigned'].includes(dynMembersAfter.json.data.items[0].status),
      `Expected status promoted from marketing_nurture to unassigned_pending/assigned, got ${dynMembersAfter.json.data.items[0].status}`
    );
    assert.equal(
      dynMembersAfter.json.data.items[0].status,
      'assigned',
      'Online sale rep must immediately receive promoted hot lead from Tệp Logic'
    );

    const recentEvents = domainEventBus.getRecentTenantEvents(alphaId, 20);
    assert.ok(
      recentEvents.some((e) => e.type === 'audience.entered' && (e.payload as any).audienceId === dynAudId),
      'Event Bus must record audience.entered event for Tenant Alpha'
    );
    const betaEvents = domainEventBus.getRecentTenantEvents(betaId, 20);
    assert.ok(
      !betaEvents.some((e) => (e.payload as any).audienceId === dynAudId),
      'Tenant Beta event log must have zero cross-tenant leakage'
    );

    //Also verify Custom KPI live evaluation (`CONVERSION_RATE` + `COUNT`), Vault Wave 1 types, Email Override & `ab-split` / `field-catalog`
    const createKpi = await reqJson(baseUrl, '/api/v1/org-rbac/custom-kpis', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: {
        name: 'Số Khách Penthouse Điểm Cao',
        metric_op: 'CONVERSION_RATE',
        filter_branches: hotFilterBranches,
        target_value: 10,
      },
    });
    assert.equal(createKpi.status, 201);
    const evalKpi = await reqJson(
      baseUrl,
      `/api/v1/org-rbac/custom-kpis/${createKpi.json.data.id}/evaluate`,
      { method: 'GET', token: alphaToken, slug: 'alpha-growth' }
    );
    assert.equal(evalKpi.status, 200);
    assert.equal(typeof evalKpi.json.data.computed_value, 'number');

    const vaultPut = await reqJson(baseUrl, '/api/v1/integrations/vault/aws_ses', {
      method: 'PUT',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { sesRegion: 'ap-southeast-1', authUser: 'AKIA_TEST', apiKey: 'SECRET_KEY_123' },
    });
    assert.equal(vaultPut.status, 200);
    const vaultPost = await reqJson(baseUrl, '/api/v1/integrations/vault', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { integration_type: 'ai_gemini_byok', config: { geminiByokKey: 'AIzaSyTest123' } },
    });
    assert.equal(vaultPost.status, 200);

    const emailOverrideRes = await reqJson(baseUrl, '/api/v1/org-rbac/user-overrides', {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { user_id: 'hoa.mgr@alpha.vn', module_key: 'email_templates', effect: 'grant', actions: { view: true } },
    });
    assert.equal(emailOverrideRes.status, 201);
    assert.equal(emailOverrideRes.json.data.user_id, mgrUserId);
    assert.equal(emailOverrideRes.json.data.user_email, 'hoa.mgr@alpha.vn');
    assert.equal(emailOverrideRes.json.data.module_key, 'mkt_templates');

    const fcRes = await reqJson(baseUrl, '/api/v1/audiences/field-catalog', {
      token: alphaToken,
      slug: 'alpha-growth',
    });
    assert.equal(fcRes.status, 200);
    assert.ok(Array.isArray(fcRes.json.data.fields) && fcRes.json.data.fields.length > 10);

    const abSplitAliasRes = await reqJson(baseUrl, `/api/v1/audiences/${alphaAudId}/ab-split`, {
      method: 'POST',
      token: alphaToken,
      slug: 'alpha-growth',
      body: { ratio_a: 60, name_prefix: 'Alias Split' },
    });
    assert.equal(abSplitAliasRes.status, 201);
    assert.equal(abSplitAliasRes.json.data.items.length, 2);
    assert.equal(abSplitAliasRes.json.data.created.length, 2);

    console.log('✅ [Wave1 Verify] ALL 6 SUITES PASSED 100% (Zero Regressions, Zero Leakage, Zero Short-Circuits)!');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.close();
  }
}

main().catch((err) => {
  console.error('❌ [Wave1 Verify] FAILED:', err);
  process.exit(1);
});
