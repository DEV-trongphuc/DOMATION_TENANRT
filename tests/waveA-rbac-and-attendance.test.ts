import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';

function getTodayVnStr(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

describe('Wave A: Zero-Hardcode Role-Screen RBAC, Attendance Anti-Spoofing & Strict/Flexible Geofence, 10-Group Settings, Databank & CAPI Parity', () => {
  let harness: TestHarness;

  const tenantASlug = 'wavea-alpha';
  const tenantBSlug = 'wavea-beta';
  let tenantAId = '';
  let tenantBId = '';

  let ownerAToken = '';
  let ownerAUserId = '';
  let ownerBToken = '';

  let branchAId = '';
  let branchNoCoordsId = '';
  let deptNorthId = '';
  let deptSouthId = '';
  let teamNorthId = '';

  let customRoleId = '';
  let customUserToken = '';
  let customUserId = '';
  let northColleagueId = '';
  let southUserToken = '';
  let southUserId = '';

  let leadNorth1Id = '';
  let leadNorth2Id = '';
  let leadSouth1Id = '';

  before(async () => {
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Wave A Alpha Corp',
        tenant_slug: tenantASlug,
        admin_name: 'Owner Alpha',
        work_email: 'owner@wavea-alpha.vn',
        phone: '0901000111',
        password: 'Password123!',
        industry: 'technology',
        seed_demo_leads: false,
        capi_config: {
          dataset_id: '987654321098765',
          access_token: 'sandbox_wavea_capi_token',
          test_event_code: 'TEST_WAVE_A',
          dual_send: false,
        },
      },
    });
    assert.equal(regA.status, 201);
    tenantAId = regA.json.data.tenant.id;
    ownerAToken = regA.json.data.access_token;
    ownerAUserId = regA.json.data.user.id;
    assert.equal(regA.json.data.user.is_tenant_owner, true, 'Tenant creator must have is_tenant_owner === true');

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Wave A Beta Corp',
        tenant_slug: tenantBSlug,
        admin_name: 'Owner Beta',
        work_email: 'owner@wavea-beta.vn',
        phone: '0902000222',
        password: 'Password123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantBId = regB.json.data.tenant.id;
    ownerBToken = regB.json.data.access_token;

    // Switch Tenant A to domation_promax (with education_addon = false)
    const swA = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(swA.status, 200);

    const swB = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: ownerBToken,
      tenantSlug: tenantBSlug,
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(swB.status, 200);
  });

  after(async () => {
    await harness.close();
  });

  it('1. Entitlements expose all 30 modules cleanly while keeping education_addon = false disabled by default', async () => {
    const me = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.user.is_tenant_owner, true);
    assert.ok(me.json.data.screen_access && typeof me.json.data.screen_access === 'object');
    assert.ok(me.json.data.quick_actions && typeof me.json.data.quick_actions === 'object');
    assert.ok(me.json.data.default_route);

    const boot = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/bootstrap', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(boot.status, 200);

    const effOwner = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/effective-permissions', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(effOwner.status, 200);

    const enabledModules: string[] = effOwner.json.data.enabled_modules || [];
    const expectedCoreAndPromax = [
      'leads',
      'rounds',
      'tickets_data',
      'ads_capi',
      'deals',
      'companies',
      'settings',
      'users',
      'billing',
      'audiences',
      'email_templates',
      'forms_triggers',
      'surveys_quiz',
      'campaigns',
      'automation_flows',
      'vouchers_qr',
      'web_tracking',
      'social_bot',
      'ai_bot_studio',
      'growth_attribution',
      'erp_hrm_org',
      'erp_attendance',
      'erp_payroll',
      'erp_approvals',
      'erp_projects_tasks',
      'erp_workchat',
      'erp_finance_inventory',
      'erp_cloud_ocr',
      'dom_agent',
    ];
    for (const key of expectedCoreAndPromax) {
      assert.ok(enabledModules.includes(key), `Missing module key in domation_promax: ${key}`);
    }
    assert.equal(
      enabledModules.includes('education_addon'),
      false,
      'education_addon MUST remain false unless addon flag is explicitly purchased'
    );
  });

  it('2. Zero-Hardcode Role-Screen-QuickAction Matrix, 7-tier Department Data Scope & Owner-Only Safeguard', async () => {
    // Create branches (Branch A with valid HCMC coords + CIDR IP whitelist, Branch B with NULL coords)
    const brARes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/branches', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        name: 'Chi nhánh TP.HCM Q1',
        code: 'HCM-Q1',
        gps_lat: 10.7769,
        gps_lng: 106.7009,
        gps_radius_meters: 100,
        branch_ip_whitelist: ['10.20.30.0/24'],
        is_headquarters: true,
      },
    });
    assert.equal(brARes.status, 201);
    branchAId = brARes.json.data.id;

    const brBRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/branches', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        name: 'Chi nhánh Kho (Không GPS)',
        code: 'NO-GPS',
        gps_lat: null,
        gps_lng: null,
        gps_radius_meters: 100,
      },
    });
    assert.equal(brBRes.status, 201);
    branchNoCoordsId = brBRes.json.data.id;

    const dNorth = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Phòng Kinh doanh Bắc', code: 'SALES-N', branch_id: branchAId },
    });
    assert.equal(dNorth.status, 201);
    deptNorthId = dNorth.json.data.id;

    const dSouth = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Phòng Kinh doanh Nam', code: 'SALES-S', branch_id: branchAId },
    });
    assert.equal(dSouth.status, 201);
    deptSouthId = dSouth.json.data.id;

    const tNorth = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/teams', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Team Inbound North', code: 'TEAM-N1', department_id: deptNorthId },
    });
    assert.equal(tNorth.status, 201);
    teamNorthId = tNorth.json.data.id;

    // Create custom role with explicit screen_access, quick_actions, default_route & department data_scope
    const roleRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/roles', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        name: 'Trưởng nhóm Khu vực',
        role_key: 'custom_dept_lead',
        default_data_scope: 'department',
        default_route: '/leads',
        screen_access: {
          '/leads': true,
          '/attendance': true,
          '/settings': false,
          '/accounts': false,
        },
        quick_actions: {
          'lead.create': true,
          'lead.export': false,
          'attendance.check_in': true,
        },
        permissions: [
          {
            module_key: 'leads',
            data_scope: 'department',
            actions: { view: true, create: true, edit: true, delete: false, assign: false, export: false, unmask_phone: false },
          },
          {
            module_key: 'attendance',
            data_scope: 'own',
            actions: { view: true, create: true, edit: false, approve: false, manage_config: false },
          },
          {
            module_key: 'erp_attendance',
            data_scope: 'own',
            actions: { view: true, create: true },
          },
          {
            module_key: 'settings',
            data_scope: 'none',
            actions: { view: false, manage_config: false },
          },
          {
            module_key: 'users',
            data_scope: 'department',
            actions: { view: true, create: false, edit: false },
          },
          {
            module_key: 'org_rbac',
            data_scope: 'none',
            actions: { view: false, manage_config: false },
          },
        ],
      },
    });
    assert.equal(roleRes.status, 201);
    customRoleId = roleRes.json.data.id;

    // Create users: customUser (Dept North), colleague (Dept North), southUser (Dept South)
    const u1 = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        full_name: 'Trưởng nhóm Bắc',
        email: 'lead.north@wavea-alpha.vn',
        password: 'Password123!',
        role: 'sale',
        role_id: customRoleId,
        branch_id: branchAId,
        department_id: deptNorthId,
        team_id: teamNorthId,
      },
    });
    assert.equal(u1.status, 201);
    customUserId = u1.json.data.id;

    const u2 = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        full_name: 'NV Kinh doanh Bắc',
        email: 'colleague.north@wavea-alpha.vn',
        password: 'Password123!',
        role: 'sale',
        branch_id: branchAId,
        department_id: deptNorthId,
        team_id: teamNorthId,
      },
    });
    assert.equal(u2.status, 201);
    northColleagueId = u2.json.data.id;

    const u3 = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        full_name: 'NV Kinh doanh Nam',
        email: 'staff.south@wavea-alpha.vn',
        password: 'Password123!',
        role: 'sale',
        branch_id: branchAId,
        department_id: deptSouthId,
      },
    });
    assert.equal(u3.status, 201);
    southUserId = u3.json.data.id;

    const loginCustom = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'lead.north@wavea-alpha.vn', password: 'Password123!', tenant_slug: tenantASlug },
    });
    assert.equal(loginCustom.status, 200);
    customUserToken = loginCustom.json.data.access_token;
    assert.equal(loginCustom.json.data.user.is_tenant_owner, false);
    assert.equal(loginCustom.json.data.default_route, '/leads');
    assert.equal(loginCustom.json.data.screen_access['/leads'], true);
    assert.equal(loginCustom.json.data.screen_access['/settings'], false);
    assert.equal(loginCustom.json.data.quick_actions['lead.export'], false);

    const effRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/effective-permissions', {
      token: customUserToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(effRes.status, 200);
    assert.equal(effRes.json.data.default_route, '/leads');
    assert.equal(effRes.json.data.screen_access['/leads'], true);
    assert.equal(effRes.json.data.screen_access['/accounts'], false);
    assert.equal(effRes.json.data.is_tenant_owner, false);

    // Custom role revoked from settings & users.create gets 403
    const deniedSettings = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: { settings: { company_brand_name: 'Unauthorized Edit' } },
    });
    assert.equal(deniedSettings.status, 403);

    const deniedCreateUser = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: { full_name: 'Hacker', email: 'hacker@wavea-alpha.vn', password: 'Password123!', role: 'sale' },
    });
    assert.equal(deniedCreateUser.status, 403);

    // OWNER-ONLY SAFEGUARD TEST: create a second NON-OWNER tenant_admin, revoke `settings` on system `tenant_admin` role ->
    // Non-owner tenant_admin MUST get 403 on `/auth/tenant-settings`, whereas `is_tenant_owner === true` MUST STILL get 200 to recover!
    const nonOwnerAdminRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        full_name: 'Non-Owner Admin',
        email: 'admin2@wavea-alpha.vn',
        password: 'Password123!',
        role: 'tenant_admin',
        branch_id: branchAId,
      },
    });
    assert.equal(nonOwnerAdminRes.status, 201);
    const admin2Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'admin2@wavea-alpha.vn', password: 'Password123!', tenant_slug: tenantASlug },
    });
    assert.equal(admin2Login.status, 200);
    assert.equal(admin2Login.json.data.user.is_tenant_owner, false);
    const admin2Token = admin2Login.json.data.access_token;

    // Look up system tenant_admin role_id
    const rolesList = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/roles', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    const sysAdminRole = rolesList.json.data.find((r: any) => String(r.role_key).toLowerCase() === 'tenant_admin');
    assert.ok(sysAdminRole?.id);

    // Strip settings & org_rbac from system `tenant_admin` role
    const stripAdminRes = await apiRequest(harness.baseUrl, `/api/v1/org-rbac/roles/${sysAdminRole.id}/permissions`, {
      method: 'PUT',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        permissions: [
          { module_key: 'settings', data_scope: 'none', actions: { view: false, manage_config: false } },
          { module_key: 'org_rbac', data_scope: 'none', actions: { view: false, manage_config: false } },
        ],
      },
    });
    assert.equal(stripAdminRes.status, 200);

    // Non-owner tenant_admin is NOW blocked (403) because ONLY is_tenant_owner retains recovery safeguard!
    const nonOwnerBlocked = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: admin2Token,
      tenantSlug: tenantASlug,
      body: { settings: { sla_minutes: 30 } },
    });
    assert.equal(nonOwnerBlocked.status, 403, 'Non-owner tenant_admin MUST obey RBAC Matrix (not hardcoded bypass)');

    // Owner (is_tenant_owner === true) STILL succeeds and recovers `tenant_admin` permissions!
    const ownerRecovery = await apiRequest(harness.baseUrl, `/api/v1/org-rbac/roles/${sysAdminRole.id}/permissions`, {
      method: 'PUT',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        permissions: [
          {
            module_key: 'settings',
            data_scope: 'company',
            actions: { view: true, create: true, edit: true, delete: true, approve: true, export: true, manage_config: true },
          },
          {
            module_key: 'org_rbac',
            data_scope: 'company',
            actions: { view: true, create: true, edit: true, delete: true, approve: true, export: true, manage_config: true },
          },
        ],
      },
    });
    assert.equal(ownerRecovery.status, 200, 'Tenant Owner must retain recovery safeguard on RBAC/Settings');

    // Data scope `department` + PII masking check: create leads in North & South
    const lN1 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Lead Bắc Own', phone: '0901110001', email: 'ln1@test.vn', assigned_to: customUserId },
    });
    assert.equal(lN1.status, 201);
    leadNorth1Id = lN1.json.data.id;

    const lN2 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Lead Bắc Đồng nghiệp', phone: '0901110002', email: 'ln2@test.vn', assigned_to: northColleagueId },
    });
    assert.equal(lN2.status, 201);
    leadNorth2Id = lN2.json.data.id;

    const lS1 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Lead Nam Khác phòng', phone: '0901110003', email: 'ls1@test.vn', assigned_to: southUserId },
    });
    assert.equal(lS1.status, 201);
    leadSouth1Id = lS1.json.data.id;

    const listAsDeptLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: customUserToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(listAsDeptLead.status, 200);
    const leadRows = Array.isArray(listAsDeptLead.json.data?.items)
      ? listAsDeptLead.json.data.items
      : Array.isArray(listAsDeptLead.json.data)
        ? listAsDeptLead.json.data
        : [];
    const seenIds = leadRows.map((x: any) => x.id);
    assert.ok(seenIds.includes(leadNorth1Id), 'Department scope must include own lead');
    assert.ok(seenIds.includes(leadNorth2Id), 'Department scope must include same-department colleague lead');
    assert.equal(seenIds.includes(leadSouth1Id), false, 'Department scope must NOT include other department lead');

    const southCol = leadRows.find((x: any) => x.id === leadNorth2Id);
    assert.equal(southCol.pii_masked, true, 'Role without leads.unmask_phone must have colleague phone masked');
    assert.ok(String(southCol.phone).includes('***'), `Masked phone must obscure digits (got ${southCol.phone})`);

    // Dynamic Stage Transition Rule for Custom Role
    const pipesRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(pipesRes.status, 200);
    const pipeline = pipesRes.json.data[0];
    assert.ok(pipeline?.stages?.length >= 2);
    const stage2 = pipeline.stages[1];

    const stageRuleRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/stage-rules', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        pipeline_id: pipeline.id,
        to_stage_id: stage2.id,
        rule_name: 'Chỉ cho phép Trưởng nhóm khu vực + Note',
        allowed_role_ids: [customRoleId],
        require_note: true,
      },
    });
    assert.equal(stageRuleRes.status, 201);

    // Blocked when missing note
    const stageMissingNote = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadNorth1Id}/stage`, {
      method: 'PATCH',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: { stage_id: stage2.id },
    });
    assert.equal(stageMissingNote.status, 422);

    // Succeeds for customRoleId when note provided
    const stageOk = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadNorth1Id}/stage`, {
      method: 'PATCH',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: { stage_id: stage2.id, note: 'Đã gọi tư vấn bước 2' },
    });
    assert.equal(stageOk.status, 200);
  });

  it('3. 10-Group Settings Engine CRUD (/custom-fields, /lead-scoring-rules, /notification-rules, /email-templates, /entity-tabs, /tags, /cron-status) + Zero Cross-Tenant RLS Leakage', async () => {
    const cf = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/custom-fields', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { entity_type: 'lead', field_label: 'Ngân sách dự kiến', field_type: 'number', is_required: false },
    });
    assert.equal(cf.status, 201);
    const cfId = cf.json.data.id;

    const lsr = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/lead-scoring-rules', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Có Email doanh nghiệp', trigger_type: 'field_match', score_delta: 25, condition_json: { field: 'email' } },
    });
    assert.equal(lsr.status, 201);

    const nr = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/notification-rules', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { event_key: 'lead.created', name: 'Thông báo Lead mới', channels_json: { in_app: true, zalo: true } },
    });
    assert.equal(nr.status, 201);

    const et = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/email-templates', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'Chào mừng Khách hàng', subject_template: 'Xin chào {{lead.name}}', body_html: '<p>Welcome</p>' },
    });
    assert.equal(et.status, 201);

    const tab = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/entity-tabs', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { entity_type: 'lead', label: 'Hồ sơ kỹ thuật', tab_type: 'fields', allowed_role_ids: [customRoleId] },
    });
    assert.equal(tab.status, 201);

    const tag = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/tags', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { name: 'VIP Enterprise', color_hex: '#1E40FF', category: 'lead' },
    });
    assert.equal(tag.status, 201);

    const cronGet = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/cron-status', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(cronGet.status, 200);
    assert.ok(cronGet.json.data.subroutines.length >= 4);

    const cronRun = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/cron-status/run', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { subroutines: ['webhook', 'capi'] },
    });
    assert.equal(cronRun.status, 200);
    assert.ok(cronRun.json.data.run_log?.id);

    // Cross-tenant RLS isolation: Tenant B cannot see or mutate Tenant A's settings records
    const [bFields, bRules, bPatchField] = await Promise.all([
      apiRequest(harness.baseUrl, '/api/v1/org-rbac/custom-fields', { token: ownerBToken, tenantSlug: tenantBSlug }),
      apiRequest(harness.baseUrl, '/api/v1/org-rbac/lead-scoring-rules', { token: ownerBToken, tenantSlug: tenantBSlug }),
      apiRequest(harness.baseUrl, `/api/v1/org-rbac/custom-fields/${cfId}`, {
        method: 'PATCH',
        token: ownerBToken,
        tenantSlug: tenantBSlug,
        body: { field_label: 'Cross Tenant Hack' },
      }),
    ]);
    assert.equal(bFields.status, 200);
    assert.equal((bFields.json.data || []).length, 0);
    assert.equal((bRules.json.data || []).length, 0);
    assert.equal(bPatchField.status, 404);
  });

  it('4. Attendance Security Fixes: Default Flexible allows remote, Client Timestamp/keep_full_unit tampering ignored, Branch Lock & Strict Radius blocks missing/inaccurate/out-of-radius Check-In & Check-Out + Exemptions/IP/Leave Bypasses', async () => {
    const todayVn = getTodayVnStr();

    // 4a. Default Policy must be `'flexible'`
    const polGet = await apiRequest(harness.baseUrl, '/api/v1/attendance/policy', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(polGet.status, 200);
    assert.equal(polGet.json.data.geofence_mode, 'flexible');

    // 4b. Flexible remote check-in from Hanoi (~1150km away) WITH spoofed timestamp & work_date succeeds, ignores fake dates!
    const flexIn = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: {
        latitude: 21.0285,
        longitude: 105.8542,
        accuracy_meters: 25,
        timestamp: '2020-01-01T01:00:00.000Z',
        work_date: '2020-01-01',
      },
    });
    assert.equal(flexIn.status, 201);
    assert.equal(String(flexIn.json.data.work_date).slice(0, 10), todayVn, 'Client work_date spoofing MUST be ignored');
    assert.ok(String(flexIn.json.data.check_in_at).startsWith(todayVn.slice(0, 7)), 'Client timestamp spoofing MUST be ignored');

    // 4c. Flexible remote check-out WITH spoofed timestamp & keep_full_unit: true ignores keep_full_unit!
    const flexOut = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-out', {
      method: 'POST',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: {
        latitude: 21.0285,
        longitude: 105.8542,
        timestamp: '2020-01-01T23:59:59.000Z',
        keep_full_unit: true,
      },
    });
    assert.equal(flexOut.status, 200);
    assert.ok(
      Number(flexOut.json.data.work_units) < 0.9,
      `Client keep_full_unit spoofing MUST be ignored (server calculated ${flexOut.json.data.work_units})`
    );

    // 4d. Branch lock: employee assigned to Branch A attempts check-in at Branch B -> 403 BRANCH_CHECKIN_RESTRICTED
    const branchLockBlock = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: { branch_id: branchNoCoordsId, latitude: 10.7769, longitude: 106.7009, accuracy_meters: 10 },
    });
    assert.equal(branchLockBlock.status, 403);
    assert.equal(branchLockBlock.json.error?.code, 'BRANCH_CHECKIN_RESTRICTED');

    // 4e. Switch Policy to STRICT RADIUS (`max_gps_accuracy_meters: 100`)
    const strictPut = await apiRequest(harness.baseUrl, '/api/v1/attendance/policy', {
      method: 'PUT',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        geofence_mode: 'strict_radius',
        max_gps_accuracy_meters: 100,
        allow_any_branch_checkin: false,
        allow_ip_whitelist_bypass: true,
        allow_remote_with_approved_leave: true,
      },
    });
    assert.equal(strictPut.status, 200);
    assert.equal(strictPut.json.data.geofence_mode, 'strict_radius');

    // Log in colleague (Branch A) & test strict mode blocks
    const colLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'colleague.north@wavea-alpha.vn', password: 'Password123!', tenant_slug: tenantASlug },
    });
    assert.equal(colLogin.status, 200);
    const colToken = colLogin.json.data.access_token;

    // 1) Missing GPS -> 403 OUT_OF_GEOFENCE_STRICT_BLOCK
    const strictNoGps = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: {},
    });
    assert.equal(strictNoGps.status, 403);
    assert.equal(strictNoGps.json.error?.code, 'OUT_OF_GEOFENCE_STRICT_BLOCK');

    // 2) Inaccurate GPS (accuracy 250m > 100m max) -> 403 OUT_OF_GEOFENCE_STRICT_BLOCK
    const strictBadAcc = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: { latitude: 10.7769, longitude: 106.7009, accuracy_meters: 250 },
    });
    assert.equal(strictBadAcc.status, 403);
    assert.equal(strictBadAcc.json.error?.code, 'OUT_OF_GEOFENCE_STRICT_BLOCK');

    // 3) Out-of-radius GPS (~1km away) -> 403 OUT_OF_GEOFENCE_STRICT_BLOCK
    const strictFar = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: { latitude: 10.785, longitude: 106.71, accuracy_meters: 15 },
    });
    assert.equal(strictFar.status, 403);
    assert.equal(strictFar.json.error?.code, 'OUT_OF_GEOFENCE_STRICT_BLOCK');

    // 4) User bound to branch with gps_lat = null MUST ALSO BE BLOCKED under strict_radius!
    const noGpsBranchUser = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        full_name: 'Warehouse User',
        email: 'warehouse@wavea-alpha.vn',
        password: 'Password123!',
        role: 'sale',
        branch_id: branchNoCoordsId,
      },
    });
    assert.equal(noGpsBranchUser.status, 201);
    const whLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'warehouse@wavea-alpha.vn', password: 'Password123!', tenant_slug: tenantASlug },
    });
    const strictNullBranch = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: whLogin.json.data.access_token,
      tenantSlug: tenantASlug,
      body: { latitude: 10.7769, longitude: 106.7009, accuracy_meters: 10 },
    });
    assert.equal(strictNullBranch.status, 403);
    assert.equal(strictNullBranch.json.error?.code, 'OUT_OF_GEOFENCE_STRICT_BLOCK');

    // 5) Valid in-radius Check-In -> 201
    const strictOkIn = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: { latitude: 10.7769, longitude: 106.7009, accuracy_meters: 12 },
    });
    assert.equal(strictOkIn.status, 201);
    assert.equal(strictOkIn.json.data.verification_method, 'strict_gps');

    // 6) BOTH Check-In AND Check-Out enforcement under strict_radius!
    const outNoGps = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-out', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: {},
    });
    assert.equal(outNoGps.status, 403);
    assert.equal(outNoGps.json.error?.code, 'OUT_OF_GEOFENCE_STRICT_BLOCK');

    const outBadAcc = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-out', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: { latitude: 10.7769, longitude: 106.7009, accuracy_meters: 500 },
    });
    assert.equal(outBadAcc.status, 403);
    assert.equal(outBadAcc.json.error?.code, 'OUT_OF_GEOFENCE_STRICT_BLOCK');

    const outFar = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-out', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: { latitude: 10.79, longitude: 106.72, accuracy_meters: 10 },
    });
    assert.equal(outFar.status, 403);
    assert.equal(outFar.json.error?.code, 'OUT_OF_GEOFENCE_STRICT_BLOCK');

    const outValid = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-out', {
      method: 'POST',
      token: colToken,
      tenantSlug: tenantASlug,
      body: { latitude: 10.77695, longitude: 106.70095, accuracy_meters: 15 },
    });
    assert.equal(outValid.status, 200);

    // 4f. Exemption Rule bypass under strict_radius (`exempt_gps: true`)
    const southLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'staff.south@wavea-alpha.vn', password: 'Password123!', tenant_slug: tenantASlug },
    });
    southUserToken = southLogin.json.data.access_token;

    const exRes = await apiRequest(harness.baseUrl, '/api/v1/attendance/exemptions', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        name: 'Miễn GPS cho NV thị trường',
        scope_type: 'user',
        target_id: southUserId,
        exempt_gps: true,
        custom_grace_late_minutes: 45,
      },
    });
    assert.equal(exRes.status, 201);

    const exemptIn = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: southUserToken,
      tenantSlug: tenantASlug,
      body: {}, // No GPS at all, still allowed due to exempt_gps!
    });
    assert.equal(exemptIn.status, 201);
    assert.equal(exemptIn.json.data.verification_method, 'exempt_gps');
    assert.equal(Boolean(exemptIn.json.data.exemption_applied), true);

    const exemptOut = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-out', {
      method: 'POST',
      token: southUserToken,
      tenantSlug: tenantASlug,
      body: {},
    });
    assert.equal(exemptOut.status, 200);

    // 4g. Branch IP Whitelist CIDR bypass (`10.20.30.0/24` via X-Forwarded-For) under strict_radius
    const ipUserRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        full_name: 'Office IP User',
        email: 'officeip@wavea-alpha.vn',
        password: 'Password123!',
        role: 'sale',
        branch_id: branchAId,
      },
    });
    assert.equal(ipUserRes.status, 201);
    const ipLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'officeip@wavea-alpha.vn', password: 'Password123!', tenant_slug: tenantASlug },
    });
    assert.equal(ipLogin.status, 200);

    const ipIn = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: ipLogin.json.data.access_token,
      tenantSlug: tenantASlug,
      headers: { 'X-Forwarded-For': '10.20.30.88' },
      body: {},
    });
    assert.equal(ipIn.status, 201);
    assert.equal(ipIn.json.data.verification_method, 'ip_whitelist');

    // 4h. Approved Remote Work Leave bypass under strict_radius
    const wfRemote = await apiRequest(harness.baseUrl, '/api/v1/approvals/workflows', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {
        code: 'WF_REMOTE_ATT',
        name: 'Duyệt làm việc từ xa (WFH)',
        category: 'remote_work',
        steps: [
          { step_order: 1, step_name: 'Admin duyệt', approver_type: 'tenant_admin', approval_mode: 'any_one', fallback_strategy: 'tenant_admin' },
        ],
      },
    });
    assert.equal(wfRemote.status, 201);
    const remoteReq = await apiRequest(harness.baseUrl, '/api/v1/approvals/requests', {
      method: 'POST',
      token: whLogin.json.data.access_token,
      tenantSlug: tenantASlug,
      body: {
        workflow_id: wfRemote.json.data.id,
        title: 'Làm việc từ xa hôm nay',
        start_date: todayVn,
        end_date: todayVn,
        form_data: { is_remote: true, start_date: todayVn, end_date: todayVn },
      },
    });
    assert.equal(remoteReq.status, 201);
    const decideRemote = await apiRequest(harness.baseUrl, `/api/v1/approvals/requests/${remoteReq.json.data.id}/decide`, {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { decision: 'approve', comment: 'Approved WFH' },
    });
    assert.equal(decideRemote.status, 200);
    assert.equal(decideRemote.json.data.status, 'approved');

    const remoteBypassIn = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: whLogin.json.data.access_token,
      tenantSlug: tenantASlug,
      body: {}, // No GPS, on strict_radius, branchNoCoords has no coords -> bypassed because of approved remote leave!
    });
    assert.equal(
      remoteBypassIn.status,
      201,
      `Remote approved leave bypass failed: ${JSON.stringify(remoteBypassIn.json)} (req=${JSON.stringify(remoteReq.json?.data)})`
    );
    assert.equal(remoteBypassIn.json.data.verification_method, 'remote_approved');

    // 4i. Attendance Confirmations & Bulk Requests + Cross-Tenant RLS isolation
    const periodMonth = todayVn.slice(0, 7);
    const batchRes = await apiRequest(harness.baseUrl, '/api/v1/attendance/confirmations/batches', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { period_month: periodMonth, from_date: `${periodMonth}-01`, to_date: `${periodMonth}-28` },
    });
    assert.equal(batchRes.status, 201);
    const confItem = batchRes.json.data.items.find((x: any) => x.user_id === customUserId);
    assert.ok(confItem?.id);

    const dispRes = await apiRequest(harness.baseUrl, `/api/v1/attendance/confirmations/${confItem.id}/dispute`, {
      method: 'POST',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: { reason: 'Thiếu 0.5 công ngày hôm trước' },
    });
    assert.equal(dispRes.status, 200);
    assert.equal(dispRes.json.data.status, 'disputed');

    const confRes = await apiRequest(harness.baseUrl, `/api/v1/attendance/confirmations/${confItem.id}/confirm`, {
      method: 'POST',
      token: customUserToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(confRes.status, 200);
    assert.equal(confRes.json.data.status, 'confirmed');

    const bulkSuggest = await apiRequest(harness.baseUrl, `/api/v1/attendance/bulk-requests/suggest?month_period=${periodMonth}`, {
      token: customUserToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(bulkSuggest.status, 200);

    const bulkCreate = await apiRequest(harness.baseUrl, '/api/v1/attendance/bulk-requests', {
      method: 'POST',
      token: customUserToken,
      tenantSlug: tenantASlug,
      body: {
        month_period: periodMonth,
        items: [{ date: todayVn, reason: 'Quên chấm công do họp khách', work_units: 1 }],
      },
    });
    assert.equal(bulkCreate.status, 201);

    const bulkApprove = await apiRequest(harness.baseUrl, `/api/v1/attendance/bulk-requests/${bulkCreate.json.data.id}/approve`, {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { decision: 'approve', admin_note: 'OK đã duyệt' },
    });
    assert.equal(bulkApprove.status, 200);
    assert.equal(bulkApprove.json.data.status, 'approved');

    // Cross-tenant RLS zero leakage on Tenant B attendance endpoints
    const [bEx, bConf, bBulk] = await Promise.all([
      apiRequest(harness.baseUrl, '/api/v1/attendance/exemptions', { token: ownerBToken, tenantSlug: tenantBSlug }),
      apiRequest(harness.baseUrl, '/api/v1/attendance/confirmations', { token: ownerBToken, tenantSlug: tenantBSlug }),
      apiRequest(harness.baseUrl, '/api/v1/attendance/bulk-requests', { token: ownerBToken, tenantSlug: tenantBSlug }),
    ]);
    assert.equal((bEx.json.data?.items || []).length, 0);
    assert.equal((bConf.json.data?.items || []).length, 0);
    assert.equal((bBulk.json.data || []).length, 0);
  });

  it('5. Public Databank Lifecycle (Release -> Concurrent Claim 409 -> Block -> Unblock -> Restore) & Full Meta CAPI Parity', async () => {
    // Release leadNorth2 into Public Databank
    const relRes = await apiRequest(harness.baseUrl, '/api/v1/leads/databank/release', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { lead_id: leadNorth2Id, reason: 'Quá hạn SLA, thả kho chung' },
    });
    assert.equal(relRes.status, 201, `Databank release failed: ${JSON.stringify(relRes.json)}`);
    const poolEntryId = relRes.json.data.id;
    assert.equal(relRes.json.data.status, 'available');

    // List databank (customUser without unmask_phone must see masked phone)
    const dbList = await apiRequest(harness.baseUrl, '/api/v1/leads/databank', {
      token: customUserToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(dbList.status, 200);
    const poolRow = (dbList.json.data?.items || []).find((i: any) => i.id === poolEntryId);
    assert.ok(poolRow);
    assert.equal(poolRow.pii_masked, true);

    // Atomic concurrent claim race: customUser vs southUser -> 1 succeeds (200), 1 gets 409!
    const [c1, c2] = await Promise.all([
      apiRequest(harness.baseUrl, `/api/v1/leads/databank/${poolEntryId}/claim`, {
        method: 'POST',
        token: customUserToken,
        tenantSlug: tenantASlug,
      }),
      apiRequest(harness.baseUrl, `/api/v1/leads/databank/${poolEntryId}/claim`, {
        method: 'POST',
        token: southUserToken,
        tenantSlug: tenantASlug,
      }),
    ]);
    const statuses = [c1.status, c2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409], 'Concurrent claim must allow only 1 winner and return 409 to loser');

    // Block -> Unblock -> Restore lifecycle
    const blk = await apiRequest(harness.baseUrl, `/api/v1/leads/databank/${poolEntryId}/block`, {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { reason: 'Số ảo spam' },
    });
    assert.equal(blk.status, 200);
    assert.equal(blk.json.data.status, 'blocked');

    const unblk = await apiRequest(harness.baseUrl, `/api/v1/leads/databank/${poolEntryId}/unblock`, {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(unblk.status, 200);
    assert.equal(unblk.json.data.status, 'available');

    const rst = await apiRequest(harness.baseUrl, `/api/v1/leads/databank/${poolEntryId}/restore`, {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { target_user_id: ownerAUserId },
    });
    assert.equal(rst.status, 200);
    assert.equal(rst.json.data.status, 'restored');

    // Meta CAPI Parity endpoints
    const bfPrev = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/backfill/preview', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(bfPrev.status, 200);
    assert.ok(Number(bfPrev.json.data.total_eligible) >= 1);

    const bfRun = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/backfill/run', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { limit: 10 },
    });
    assert.equal(bfRun.status, 200);
    assert.ok(Number(bfRun.json.data.processed) >= 1);

    const audPrev = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/audiences/preview', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(audPrev.status, 200);

    const audSync = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/audiences/sync', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { audience_name: 'WaveA High Intent' },
    });
    assert.equal(audSync.status, 200);
    assert.ok(Number(audSync.json.data.synced_count) >= 1);

    const optRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/adsets/adset_wa_999/optimize', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { action: 'adjust_budget', daily_budget_vnd: 1_500_000, reason: 'ROAS > 4.2x' },
    });
    assert.equal(optRes.status, 200);
    assert.equal(optRes.json.data.adset_id, 'adset_wa_999');

    const pfImport = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/phone-farm/import', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: { phones: ['0901110001', '0908887776'], reason: 'Phone farm spam test' },
    });
    assert.equal(pfImport.status, 201);
    assert.equal(pfImport.json.data.imported, 2);

    const pfStats = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/phone-farm/stats', {
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(pfStats.status, 200);
    assert.ok(Number(pfStats.json.data.total_blocked) >= 2);

    const pfSync = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/phone-farm/sync-meta', {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
      body: {},
    });
    assert.equal(pfSync.status, 200);
    assert.ok(Number(pfSync.json.data.synced_count) >= 2);

    // Query an existing CAPI log created by backfill/run, mark it 500, and test `/capi/retry/:logId`
    let targetLogId = '';
    await withTenantTransaction(tenantAId, async (client) => {
      const logRes = await client.query<{ id: string }>(
        'SELECT id FROM capi_logs WHERE tenant_id = $1 ORDER BY sent_at DESC LIMIT 1',
        [tenantAId]
      );
      if (logRes.rows[0]?.id) {
        targetLogId = logRes.rows[0].id;
        await client.query('UPDATE capi_logs SET response_status = 500 WHERE tenant_id = $1 AND id = $2', [
          tenantAId,
          targetLogId,
        ]);
      }
    });
    assert.ok(targetLogId, 'backfill/run should have recorded a real capi_logs row');

    const retryRes = await apiRequest(harness.baseUrl, `/api/v1/integrations/capi/retry/${targetLogId}`, {
      method: 'POST',
      token: ownerAToken,
      tenantSlug: tenantASlug,
    });
    assert.equal(retryRes.status, 200);
    assert.equal(retryRes.json.data.retried, true);
    assert.equal(retryRes.json.data.original_log_id, targetLogId);
  });
});
