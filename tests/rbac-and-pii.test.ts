import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { APP_CONFIG } from '../server/config.ts';

describe('Phase 1 & 2: 4-Tier RBAC Matrix, Domain Claim Assertion & External Agency PII Masking', () => {
  let harness: TestHarness;
  let adminToken = '';
  let tenantSlug = 'nova-land';
  let tenantId = '';
  let managerToken = '';
  let internalSaleToken = '';
  let internalSaleId = '';
  let agencySaleToken = '';
  let agencySaleId = '';

  before(async () => {
    harness = await startTestServer();

    // Register primary tenant
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Nova Real Estate',
        tenant_slug: tenantSlug,
        admin_name: 'Phuc Huynh',
        work_email: 'ceo@novaland-test.vn',
        phone: '0905123456',
        password: 'AdminPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;

    // Register second tenant to test cross-subdomain token rejection
    await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Other Org',
        tenant_slug: 'other-org',
        admin_name: 'Other Admin',
        work_email: 'ceo@other.vn',
        phone: '0905999888',
        password: 'AdminPassword123!',
      },
    });

    // Tenant Admin creates Manager
    const mgrRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      body: {
        full_name: 'Manager Tuan',
        email: 'manager@novaland-test.vn',
        phone: '0911222333',
        password: 'ManagerPassword123!',
        role: 'manager',
      },
    });
    assert.equal(mgrRes.status, 201);

    const mgrLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'manager@novaland-test.vn', password: 'ManagerPassword123!' },
    });
    assert.equal(mgrLogin.status, 200);
    managerToken = mgrLogin.json.data.access_token;

    // Manager creates Internal Sale (Op 07 allowed)
    const sale1Res = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: managerToken,
      body: {
        full_name: 'Internal Sale A',
        email: 'sale.a@novaland-test.vn',
        password: 'SalePassword123!',
        role: 'sale',
        is_external_agency: false,
      },
    });
    assert.equal(sale1Res.status, 201);
    internalSaleId = sale1Res.json.data.id;

    // Manager creates External Agency F1 Sale (`is_external_agency = true`)
    const sale2Res = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: managerToken,
      body: {
        full_name: 'Đại Lý F1 Hợp Nhất',
        email: 'agency.f1@novaland-test.vn',
        password: 'SalePassword123!',
        role: 'sale',
        is_external_agency: true,
      },
    });
    assert.equal(sale2Res.status, 201);
    agencySaleId = sale2Res.json.data.id;

    const s1Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'sale.a@novaland-test.vn', password: 'SalePassword123!' },
    });
    internalSaleToken = s1Login.json.data.access_token;

    const s2Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'agency.f1@novaland-test.vn', password: 'SalePassword123!' },
    });
    agencySaleToken = s2Login.json.data.access_token;
  });

  after(async () => {
    await harness.close();
  });

  it('Penetration Check: Token for Tenant A fails with HTTP 403 when sent to Tenant B slug', async () => {
    const res = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: adminToken,
      tenantSlug: 'other-org',
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'TENANT_CONTEXT_MISMATCH');
  });

  it('RBAC Boundaries: Manager cannot create another Manager or edit Pipelines/Vault; Sale cannot create users', async () => {
    const mgrCreateMgr = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: managerToken,
      body: { full_name: 'Rogue Mgr', email: 'rogue@novaland-test.vn', role: 'manager' },
    });
    assert.equal(mgrCreateMgr.status, 403);

    const mgrVault = await apiRequest(harness.baseUrl, '/api/v1/integrations/overview', {
      token: managerToken,
    });
    assert.equal(mgrVault.status, 403);

    const saleCreateUser = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: internalSaleToken,
      body: { full_name: 'Sub Sale', email: 'sub@novaland-test.vn', role: 'sale' },
    });
    assert.equal(saleCreateUser.status, 403);
  });

  it('Field-Level PII Masking & Op 15 Lead Visibility: External Agency sees masked PII & no INTERNAL_NOTE', async () => {
    // Create lead explicitly assigned to External Agency F1
    const createForAgency = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Khách VIP Biệt Thự',
        phone: '0912345678',
        email: 'vip.customer@gmail.com',
        source: 'Facebook Lead Ads',
        force_assigned_to: agencySaleId,
      },
    });
    assert.equal(createForAgency.status, 201);
    const agencyLeadId = createForAgency.json.data.leadId;

    // Create lead assigned to Internal Sale A
    const createForInternal = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Khách Nội Bộ',
        phone: '0988777666',
        email: 'internal.client@gmail.com',
        force_assigned_to: internalSaleId,
      },
    });
    assert.equal(createForInternal.status, 201);
    const internalLeadId = createForInternal.json.data.leadId;

    // Manager adds an INTERNAL_NOTE and a regular note containing raw phone digits on Agency's lead
    await apiRequest(harness.baseUrl, `/api/v1/leads/${agencyLeadId}/timeline/notes`, {
      method: 'POST',
      token: managerToken,
      body: {
        note_type: 'INTERNAL_NOTE',
        title: 'Ghi chú mật của Quản lý',
        content: 'Hoa hồng nội bộ 3%',
      },
    });
    await apiRequest(harness.baseUrl, `/api/v1/leads/${agencyLeadId}/timeline/notes`, {
      method: 'POST',
      token: managerToken,
      body: {
        note_type: 'CALL_CONNECTED',
        title: 'Khách xác nhận qua SĐT 0912345678',
        content: 'Gọi cho khách 0912345678 lúc 9h sáng.',
      },
    });

    // External Agency queries `/api/v1/leads`: sees ONLY their 1 lead, with masked phone & email!
    const agencyLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: agencySaleToken,
    });
    assert.equal(agencyLeads.status, 200);
    assert.equal(agencyLeads.json.data.items.length, 1);
    assert.equal(agencyLeads.json.data.items[0].id, agencyLeadId);
    assert.equal(agencyLeads.json.data.items[0].phone, '0912***678');
    assert.equal(agencyLeads.json.data.items[0].email, 'vi***@gmail.com');

    // External Agency cannot view Internal Sale's lead timeline (Op 15)
    const forbiddenTl = await apiRequest(harness.baseUrl, `/api/v1/leads/${internalLeadId}/timeline`, {
      token: agencySaleToken,
    });
    assert.equal(forbiddenTl.status, 403);

    // External Agency views own lead timeline: INTERNAL_NOTE hidden & raw phones masked in text!
    const agencyTl = await apiRequest(harness.baseUrl, `/api/v1/leads/${agencyLeadId}/timeline`, {
      token: agencySaleToken,
    });
    assert.equal(agencyTl.status, 200);
    const internalNotes = agencyTl.json.data.filter((e: any) => e.metadata?.note_category === 'INTERNAL_NOTE');
    assert.equal(internalNotes.length, 0, 'INTERNAL_NOTE must be hidden from external agencies');

    const callNote = agencyTl.json.data.find((e: any) => e.metadata?.note_category === 'CALL_CONNECTED');
    assert.ok(callNote);
    assert.match(callNote.title, /0912\*\*\*678/);
    assert.match(callNote.content, /0912\*\*\*678/);

    // Meanwhile Internal Sale sees unmasked phone on their own lead
    const internalLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: internalSaleToken,
    });
    assert.equal(internalLeads.json.data.items.length, 1);
    assert.equal(internalLeads.json.data.items[0].phone, '84988777666');
  });

  it('Segregated Platform Super Admin Gateway: authenticates, suspends tenant, and issues audited impersonation token', async () => {
    // Tenant Admin token rejected on Platform Admin route
    const badAttempt = await apiRequest(harness.baseUrl, '/api/v1/admin/tenants', {
      token: adminToken,
    });
    assert.equal(badAttempt.status, 403);

    // Super Admin logs in via segregated table
    const saLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: APP_CONFIG.superadminEmail,
        password: APP_CONFIG.superadminPassword,
      },
    });
    assert.equal(saLogin.status, 200);
    const saToken = saLogin.json.data.access_token;

    const listRes = await apiRequest(harness.baseUrl, '/api/v1/admin/tenants', {
      token: saToken,
    });
    assert.equal(listRes.status, 200);
    assert.ok(listRes.json.data.total_tenants >= 2);

    // Suspend tenant -> Tenant Admin immediately blocked with 403 TENANT_SUSPENDED
    const suspendRes = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      token: saToken,
      body: { status: 'suspended' },
    });
    assert.equal(suspendRes.status, 200);

    const blockedReq = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: adminToken,
    });
    assert.equal(blockedReq.status, 403);
    assert.equal(blockedReq.json.error.code, 'TENANT_SUSPENDED');

    // Reactivate & test audited support impersonation
    await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}`, {
      method: 'PATCH',
      token: saToken,
      body: { status: 'active', plan_tier: 'enterprise' },
    });

    const impRes = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}/impersonate`, {
      method: 'POST',
      token: saToken,
    });
    assert.equal(impRes.status, 200);
    assert.equal(impRes.json.data.expires_in, 900);

    const meViaSupport = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: impRes.json.data.access_token,
    });
    assert.equal(meViaSupport.status, 200);
    assert.equal(meViaSupport.json.data.tenant.plan_tier, 'enterprise');
  });
});
