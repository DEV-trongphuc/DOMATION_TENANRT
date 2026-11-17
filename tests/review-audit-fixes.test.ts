import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import {
  isSafeRegexPattern,
  safeRegexTest,
  normalizeTenantSettings,
} from '../server/core/settings/tenant-settings.ts';
import { sweepExpiredSlaTimeouts } from '../server/services/distribution.service.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';

describe('Adversarial Review Audit Fixes: Security, PII, Multi-Pipeline, Multi-Hop SLA & Custom Settings', () => {
  let harness: TestHarness;
  let platformToken = '';
  let adminToken = '';
  let managerToken = '';
  let sale1Token = '';
  let sale2Token = '';
  let agencyToken = '';
  let tenantId = '';
  let sale1Id = '';
  let sale2Id = '';
  let agencyId = '';
  let defaultPipelineId = '';
  const tenantSlug = 'audit-fix-enterprise';

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    await harness.close();
  });

  it('1. ReDoS guard rejects catastrophic backtracking regexes across settings & custom fields', async () => {
    assert.equal(isSafeRegexPattern('(a+)+$'), false);
    assert.equal(isSafeRegexPattern('([a-zA-Z]+)*$'), false);
    assert.equal(isSafeRegexPattern('(a)\\1+'), false);
    assert.equal(isSafeRegexPattern('^84(3|5|7|8|9)\\d{8}$'), true);

    const normalized = normalizeTenantSettings({ custom_phone_regex: '(a+)+$' });
    assert.equal(normalized.custom_phone_regex, '');

    const t0 = Date.now();
    const matched = safeRegexTest('(a+)+$', 'a'.repeat(5000) + '!');
    assert.equal(matched, false);
    assert.ok(Date.now() - t0 < 50, 'safeRegexTest must reject unsafe regex immediately without backtracking');
  });

  it('2. Registration honors custom_settings.default_staff_password, custom zalo template & Platform Defaults reset', async () => {
    const saLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(saLogin.status, 200);
    platformToken = saLogin.json.data.access_token;

    // Configure Platform Defaults (SGD + dial code 65)
    const setPlat = await apiRequest(harness.baseUrl, '/api/v1/admin/platform-settings', {
      method: 'PATCH',
      token: platformToken,
      body: {
        default_tenant_settings: {
          default_currency: 'SGD',
          default_dial_code: '65',
          default_country_code: 'sg',
          vacation_credit_cap: 12,
        },
      },
    });
    assert.equal(setPlat.status, 200);

    // Register tenant with explicit default_staff_password and custom zalo_config.template
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Audit Fix Enterprise',
        tenant_slug: tenantSlug,
        admin_name: 'Audit CEO',
        work_email: 'ceo@audit-fix.vn',
        phone: '+6591112222',
        password: 'RootAdminPassword#2026',
        industry: 'b2b',
        seed_demo_leads: false,
        custom_settings: {
          default_staff_password: 'StaffInitPassword#88',
          pii_mask_before_accept: true,
          note_types: [
            { value: 'VIP_CALL_CHECK', label: 'Gọi chăm sóc VIP', cat: 'call', internal_only: false },
            { value: 'INTERNAL_SECRET', label: 'Biên độ lợi nhuận kín', cat: 'note', internal_only: true },
          ],
        },
        initial_sales: [
          { full_name: 'Sale One', email: 'sale1@audit-fix.vn', is_available: true, receive_ratio: 1 },
          { full_name: 'Sale Two', email: 'sale2@audit-fix.vn', is_available: true, receive_ratio: 1 },
          { full_name: 'Agency F1', email: 'f1@audit-fix.vn', is_external_agency: true, is_available: false, receive_ratio: 1 },
        ],
        zalo_config: {
          group_chat_id: '-77889900',
          template: 'CUSTOM_ZALO_TEMPLATE: {{customer_name}} | {{phone}}',
        },
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;
    assert.equal(reg.json.data.tenant.settings.default_currency, 'SGD');
    assert.equal(reg.json.data.tenant.settings.default_dial_code, '65');

    // Verify initial_sales got default_staff_password (NOT RootAdminPassword#2026)
    const wrongSaleLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'sale1@audit-fix.vn', password: 'RootAdminPassword#2026', tenant_slug: tenantSlug },
    });
    assert.equal(wrongSaleLogin.status, 401);

    const s1Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'sale1@audit-fix.vn', password: 'StaffInitPassword#88', tenant_slug: tenantSlug },
    });
    assert.equal(s1Login.status, 200);
    sale1Token = s1Login.json.data.access_token;
    sale1Id = s1Login.json.data.user.id;

    const s2Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'sale2@audit-fix.vn', password: 'StaffInitPassword#88', tenant_slug: tenantSlug },
    });
    assert.equal(s2Login.status, 200);
    sale2Token = s2Login.json.data.access_token;
    sale2Id = s2Login.json.data.user.id;

    const f1Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'f1@audit-fix.vn', password: 'StaffInitPassword#88', tenant_slug: tenantSlug },
    });
    assert.equal(f1Login.status, 200);
    agencyToken = f1Login.json.data.access_token;
    agencyId = f1Login.json.data.user.id;

    // Create a Manager account as well
    const mgrCreate = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      body: {
        full_name: 'Audit Manager',
        email: 'mgr@audit-fix.vn',
        role: 'manager',
      },
    });
    assert.equal(mgrCreate.status, 201);
    const mgrLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'mgr@audit-fix.vn', password: 'StaffInitPassword#88', tenant_slug: tenantSlug },
    });
    assert.equal(mgrLogin.status, 200);
    managerToken = mgrLogin.json.data.access_token;

    // Verify custom Zalo template was preserved in Vault
    const ov = await apiRequest(harness.baseUrl, '/api/v1/integrations/overview', { token: adminToken });
    assert.equal(ov.status, 200);
    assert.equal(
      ov.json.data.integrations.zalo_oa.config_preview.template,
      'CUSTOM_ZALO_TEMPLATE: {{customer_name}} | {{phone}}'
    );

    // Override currency to EUR, then reset_to_defaults -> must restore Platform Default ('SGD')
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      body: { settings: { default_currency: 'EUR' } },
    });
    const resetRes = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      body: { reset_to_defaults: true },
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.data.settings.default_currency, 'SGD');
    assert.equal(resetRes.json.data.settings.vacation_credit_cap, 12);

    // Re-apply test settings needed for subsequent checks
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      body: {
        settings: {
          pii_mask_before_accept: true,
          note_types: [
            { value: 'VIP_CALL_CHECK', label: 'Gọi chăm sóc VIP', cat: 'call', internal_only: false },
            { value: 'INTERNAL_SECRET', label: 'Biên độ lợi nhuận kín', cat: 'note', internal_only: true },
          ],
        },
      },
    });

    const pipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', { token: adminToken });
    defaultPipelineId = pipes.json.data[0].id;

    // Custom field with unsafe ReDoS regex must return 422
    const badCf = await apiRequest(harness.baseUrl, `/api/v1/pipelines/${defaultPipelineId}/custom-fields`, {
      method: 'POST',
      token: adminToken,
      body: {
        field_key: 'unsafe_code',
        field_label: 'Unsafe Regex',
        field_type: 'text',
        config_json: { regex: '(a+)+$' },
      },
    });
    assert.equal(badCf.status, 422);
    assert.equal(badCf.json.error.code, 'INVALID_CUSTOM_FIELD_REGEX');
  });

  it('3. Prevents PII leaks on PATCH /leads/:id, tickets list, custom dial code notes & blocks F1 internal_only notes', async () => {
    // Create lead assigned directly to External Agency F1 with +65 phone and email
    const created = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        pipeline_id: defaultPipelineId,
        name: 'Singapore VIP Lead',
        phone: '+6591234567',
        email: 'vip.client@lioncity.sg',
        assigned_to: agencyId,
      },
    });
    assert.equal(created.status, 201);
    const f1LeadId = created.json.data.lead_id;

    // PATCH /leads/:id as Agency F1 must NOT leak raw phone or email
    const patched = await apiRequest(harness.baseUrl, `/api/v1/leads/${f1LeadId}`, {
      method: 'PATCH',
      token: agencyToken,
      body: { campaign: 'Agency Updated Campaign' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.data.pii_masked, true);
    assert.ok(!patched.json.data.phone.includes('9123456'), `Expected masked phone, got ${patched.json.data.phone}`);
    assert.ok(patched.json.data.phone.includes('*'));
    assert.ok(patched.json.data.email.includes('*'), `Expected masked email, got ${patched.json.data.email}`);

    // Agency F1 attempting to post internal_only note type must be blocked with 403
    const f1InternalAttempt = await apiRequest(harness.baseUrl, `/api/v1/leads/${f1LeadId}/timeline/notes`, {
      method: 'POST',
      token: agencyToken,
      body: {
        note_type: 'INTERNAL_SECRET',
        content: 'Trying to spoof internal note',
      },
    });
    assert.equal(f1InternalAttempt.status, 403);

    // Admin posts public call note containing +65 phone & email; custom cat='call' maps to event_category='communication' & event_type='call_log'
    const adminNote = await apiRequest(harness.baseUrl, `/api/v1/leads/${f1LeadId}/timeline/notes`, {
      method: 'POST',
      token: adminToken,
      body: {
        note_type: 'VIP_CALL_CHECK',
        content: 'Khách xác nhận qua số +6591234567 và email vip.client@lioncity.sg',
      },
    });
    assert.equal(adminNote.status, 201);
    assert.equal(adminNote.json.data.event_category, 'communication');
    assert.equal(adminNote.json.data.event_type, 'call_log');

    // Agency F1 filtering timeline by category=communication receives the 'call' note with masked phone & email
    const f1Timeline = await apiRequest(
      harness.baseUrl,
      `/api/v1/leads/${f1LeadId}/timeline?category=communication`,
      { token: agencyToken }
    );
    assert.equal(f1Timeline.status, 200);
    assert.equal(f1Timeline.json.data.length, 1);
    assert.ok(!f1Timeline.json.data[0].content.includes('91234567'));
    assert.ok(!f1Timeline.json.data[0].content.includes('vip.client@lioncity.sg'));

    // Also verify GET /leads/tickets/list masks lead_phone for unaccepted Sale lead when pii_mask_before_accept = true
    const s1Unaccepted = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        pipeline_id: defaultPipelineId,
        name: 'Ticket Mask Check Lead',
        phone: '+6598765432',
        assigned_to: sale1Id,
      },
    });
    const tkLeadId = s1Unaccepted.json.data.lead_id;
    const tkCreate = await apiRequest(harness.baseUrl, `/api/v1/leads/${tkLeadId}/tickets`, {
      method: 'POST',
      token: sale1Token,
      body: { reason: 'WRONG_NUMBER', description: 'Unreachable before accept' },
    });
    assert.equal(tkCreate.status, 201);

    const s1TicketsBeforeAccept = await apiRequest(harness.baseUrl, '/api/v1/leads/tickets/list', {
      token: sale1Token,
    });
    assert.equal(s1TicketsBeforeAccept.status, 200);
    const tkRow = s1TicketsBeforeAccept.json.data.find((t: any) => t.lead_id === tkLeadId);
    assert.ok(tkRow);
    assert.ok(tkRow.lead_phone.includes('*'), `Expected masked lead_phone before accept, got ${tkRow.lead_phone}`);
  });

  it('4. Multi-pipeline routing rules switch pipeline & firstStage cleanly without cross-pipeline contamination', async () => {
    // Create Pipeline 2 with its own stage and distribution round
    const p2Res = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Enterprise Dedicated Pipeline',
        stages: [
          {
            stage_key: 'ent_new',
            stage_name: 'Enterprise Mới',
            color_hex: '#2563EB',
            capi_event_mapping: 'Lead',
            sla_timeout_minutes: 20,
          },
        ],
      },
    });
    assert.equal(p2Res.status, 201);
    const pipeline2Id = p2Res.json.data.id;

    const r2Res = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: adminToken,
      body: {
        pipeline_id: pipeline2Id,
        name: 'Vòng Chuyên Biệt P2',
        priority: 1,
      },
    });
    assert.equal(r2Res.status, 201);
    const round2Id = r2Res.json.data.id;

    await apiRequest(harness.baseUrl, `/api/v1/pipelines/rounds/${round2Id}/consultants`, {
      method: 'PUT',
      token: adminToken,
      body: { user_id: sale2Id, receive_ratio: 1 },
    });

    const ruleRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/routing-rules', {
      method: 'POST',
      token: adminToken,
      body: {
        round_id: round2Id,
        rule_name: 'Route Enterprise Source to P2',
        priority: 1,
        conditions_json: [{ field: 'source', op: 'equals', val: 'Enterprise_Portal' }],
      },
    });
    assert.equal(ruleRes.status, 201);

    // A) Lead WITHOUT explicit pipeline_id matching rule -> switches to Pipeline 2 AND Pipeline 2's first stage
    const autoRouted = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Auto Routed P2 Client',
        phone: '+6581112233',
        source: 'Enterprise_Portal',
      },
    });
    assert.equal(autoRouted.status, 201);
    assert.equal(autoRouted.json.data.assigned_to, sale2Id);

    const p2Leads = await apiRequest(harness.baseUrl, `/api/v1/leads?pipeline_id=${pipeline2Id}`, {
      token: adminToken,
    });
    const foundP2 = p2Leads.json.data.items.find((l: any) => l.id === autoRouted.json.data.lead_id);
    assert.ok(foundP2);
    assert.equal(foundP2.pipeline_id, pipeline2Id);
    assert.equal(foundP2.stage.name, 'Enterprise Mới');

    // B) Lead WITH explicit pipeline_id = defaultPipelineId -> stays in defaultPipelineId
    const explicitPipe = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        pipeline_id: defaultPipelineId,
        name: 'Explicit P1 Client',
        phone: '+6581112244',
        source: 'Enterprise_Portal',
      },
    });
    assert.equal(explicitPipe.status, 201);
    const p1Leads = await apiRequest(harness.baseUrl, `/api/v1/leads?pipeline_id=${defaultPipelineId}`, {
      token: adminToken,
    });
    const foundP1 = p1Leads.json.data.items.find((l: any) => l.id === explicitPipe.json.data.lead_id);
    assert.ok(foundP1);
    assert.equal(foundP1.pipeline_id, defaultPipelineId);
  });

  it('5. Multi-hop sla_auto_recall_enabled recalls across peers without ping-pong & migrates SLA timers on reassign/offline', async () => {
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      body: {
        settings: {
          sla_auto_recall_enabled: true,
          default_sla_minutes: 10,
          use_default_sla_fallback: true,
        },
      },
    });

    const leadCreate = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        pipeline_id: defaultPipelineId,
        name: 'Hot SLA Multi-Hop Lead',
        phone: '+6582223344',
        assigned_to: sale1Id,
      },
    });
    assert.equal(leadCreate.status, 201);
    const slaLeadId = leadCreate.json.data.lead_id;

    const initialList = await apiRequest(harness.baseUrl, `/api/v1/leads?pipeline_id=${defaultPipelineId}`, {
      token: adminToken,
    });
    const initialRow = initialList.json.data.items.find((l: any) => l.id === slaLeadId);
    const stageId = initialRow.stage.id;

    // Hop 1: Backdate SLA timer -> Sale 1 misses SLA -> auto-recalled to Sale 2
    await tenantRedis.zadd('sla_queue', Date.now() - 5000, `${slaLeadId}:${stageId}`, tenantId);
    const sweep1 = await sweepExpiredSlaTimeouts(tenantId);
    assert.ok(sweep1 >= 1);

    const afterHop1 = await apiRequest(harness.baseUrl, `/api/v1/leads?pipeline_id=${defaultPipelineId}`, {
      token: adminToken,
    });
    const rowHop1 = afterHop1.json.data.items.find((l: any) => l.id === slaLeadId);
    assert.equal(rowHop1.assigned_sale?.id, sale2Id);
    assert.equal(rowHop1.status, 'assigned');

    // Hop 2: Backdate follow-up SLA timer -> Sale 2 ALSO misses SLA -> must NOT ping-pong back to Sale 1; moves to recalled queue
    await tenantRedis.zadd('sla_queue', Date.now() - 5000, `${slaLeadId}:${stageId}`, tenantId);
    const sweep2 = await sweepExpiredSlaTimeouts(tenantId);
    assert.ok(sweep2 >= 1);

    const afterHop2 = await apiRequest(harness.baseUrl, `/api/v1/leads?pipeline_id=${defaultPipelineId}`, {
      token: adminToken,
    });
    const rowHop2 = afterHop2.json.data.items.find((l: any) => l.id === slaLeadId);
    assert.equal(rowHop2.assigned_sale, null);
    assert.equal(rowHop2.status, 'recalled');

    // Manual reassign schedules fresh SLA timer; Admin setting Sale 1 is_available=false auto-recalls unaccepted lead
    const reas = await apiRequest(harness.baseUrl, `/api/v1/leads/${slaLeadId}/reassign`, {
      method: 'POST',
      token: adminToken,
      body: { target_user_id: sale1Id, reason: 'Manual re-dispatch' },
    });
    assert.equal(reas.status, 200);
    const activeTimers = await tenantRedis.zrangebyscore('sla_queue', -Infinity, Infinity, tenantId);
    assert.ok(activeTimers.some((m) => m.startsWith(`${slaLeadId}:`)));

    const adminOffline = await apiRequest(harness.baseUrl, `/api/v1/users/${sale1Id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { is_available: false },
    });
    assert.equal(adminOffline.status, 200);
    assert.ok(adminOffline.json.data.unaccepted_leads_recalled >= 1);
  });

  it('6. Enforces Sale peer discovery RBAC, 240-min impersonation & blocks suspended tenant Zalo webhooks', async () => {
    // Sale cannot access /users/peers while allow_sale_reassign_lead is false
    const deniedPeers = await apiRequest(harness.baseUrl, '/api/v1/users/peers', { token: sale2Token });
    assert.equal(deniedPeers.status, 403);

    // Enable allow_sale_reassign_lead -> Sale 2 gets peer list cleanly
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      body: {
        settings: {
          role_permissions: { allow_sale_reassign_lead: true },
        },
      },
    });
    const allowedPeers = await apiRequest(harness.baseUrl, '/api/v1/users/peers', { token: sale2Token });
    assert.equal(allowedPeers.status, 200);
    assert.ok(allowedPeers.json.data.items.length >= 2);
    assert.equal(allowedPeers.json.data.items[0].phone, undefined);

    // Super Admin 240-minute impersonation token
    const imp240 = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}/impersonate`, {
      method: 'POST',
      token: platformToken,
      body: { duration_minutes: 240 },
    });
    assert.equal(imp240.status, 200);
    assert.equal(imp240.json.data.expires_in_seconds, 14400);

    // Suspend tenant -> public Zalo webhook must return 403 TENANT_SUSPENDED
    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      token: platformToken,
      body: { status: 'suspended' },
    });
    const suspendedZalo = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${tenantSlug}`, {
      method: 'POST',
      body: { chat_id: '-77889900', text: '/chatid' },
    });
    assert.equal(suspendedZalo.status, 403);
    assert.equal(suspendedZalo.json.error.code, 'TENANT_SUSPENDED');
  });
});
