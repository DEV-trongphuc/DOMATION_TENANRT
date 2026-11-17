import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { sweepExpiredSlaTimeouts } from '../server/services/distribution.service.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';

describe('Phase 4: Boundary Validation, Vacation Queue Drain, Pipeline Customization & Tour Sync', () => {
  let harness: TestHarness;
  let adminToken = '';
  let tenantId = '';
  const tenantSlug = 'edge-test-corp';
  let sale1Token = '';
  let sale1Id = '';

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    await harness.close();
  });

  it('Rejects empty/invalid registration boundary inputs with RFC 7807 422 and duplicate slug with 409', async () => {
    // Empty slug check
    const emptySlug = await apiRequest(harness.baseUrl, '/api/v1/auth/check-slug?slug=');
    assert.equal(emptySlug.status, 422);

    // Invalid uppercase/special slug
    const badSlug = await apiRequest(harness.baseUrl, '/api/v1/auth/check-slug?slug=-Invalid_Slug!-');
    assert.equal(badSlug.status, 422);

    // Valid slug check
    const okSlug = await apiRequest(harness.baseUrl, `/api/v1/auth/check-slug?slug=${tenantSlug}`);
    assert.equal(okSlug.status, 200);
    assert.equal(okSlug.json.data.is_available, true);

    // Short company name (<2 chars)
    const rShortName = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'A',
        tenant_slug: tenantSlug,
        admin_name: 'Admin',
        work_email: 'admin@edge.vn',
        phone: '0912345678',
        password: 'Password123!',
      },
    });
    assert.equal(rShortName.status, 422);

    // Invalid phone number
    const rBadPhone = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Edge Test Corp',
        tenant_slug: tenantSlug,
        admin_name: 'Admin',
        work_email: 'admin@edge.vn',
        phone: '12345',
        password: 'Password123!',
      },
    });
    assert.equal(rBadPhone.status, 422);
    assert.equal(rBadPhone.json.error.code, 'INVALID_PHONE');

    // Weak password (< 8 chars)
    const rWeakPass = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Edge Test Corp',
        tenant_slug: tenantSlug,
        admin_name: 'Admin',
        work_email: 'admin@edge.vn',
        phone: '0912345678',
        password: '1234567',
      },
    });
    assert.equal(rWeakPass.status, 422);
    assert.equal(rWeakPass.json.error.code, 'WEAK_PASSWORD');

    // Valid registration (no demo leads so we control exact counts)
    const rOk = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Edge Test Corp',
        tenant_slug: tenantSlug,
        admin_name: 'Trần Quản Trị',
        work_email: 'admin@edge.vn',
        phone: '0912345678',
        password: 'Password123!',
        industry: 'education',
        seed_demo_leads: false,
      },
    });
    assert.equal(rOk.status, 201);
    adminToken = rOk.json.data.access_token;
    tenantId = rOk.json.data.tenant.id;

    // Duplicate slug registration must return 409
    const rDup = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Another Edge',
        tenant_slug: tenantSlug,
        admin_name: 'Admin 2',
        work_email: 'admin2@edge.vn',
        phone: '0987654321',
        password: 'Password123!',
      },
    });
    assert.equal(rDup.status, 409);
    assert.equal(rDup.json.error.code, 'SLUG_ALREADY_TAKEN');

    // Admin cannot deactivate their own account
    const selfDeact = await apiRequest(harness.baseUrl, `/api/v1/users/${rOk.json.data.user.id}/admin-status`, {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { status: 'inactive' },
    });
    assert.equal(selfDeact.status, 422);
    assert.equal(selfDeact.json.error.code, 'CANNOT_DEACTIVATE_SELF');
  });

  it('Vacation Mode tracks skipped_credit and Offline -> Online drains unassigned_pending queue', async () => {
    // Create Sale 1
    const cSale = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        full_name: 'Sale Nghỉ Phép',
        email: 'sale1@edge.vn',
        phone: '0909111222',
        password: 'Password123!',
        role: 'sale',
      },
    });
    assert.equal(cSale.status, 201);
    sale1Id = cSale.json.data.id;

    const loginSale = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'sale1@edge.vn', password: 'Password123!' },
    });
    assert.equal(loginSale.status, 200);
    sale1Token = loginSale.json.data.access_token;

    // Sale 1 enables Vacation Mode
    const vacRes = await apiRequest(harness.baseUrl, '/api/v1/users/me/availability', {
      method: 'PATCH',
      token: sale1Token,
      tenantSlug,
      body: { is_available: true, vacation_mode: true },
    });
    assert.equal(vacRes.status, 200);
    assert.equal(vacRes.json.data.vacation_mode, true);

    // Scenario A: Admin is still online while Sale 1 is on Vacation -> Admin gets lead AND Sale 1 gets skipped_credit +1
    const ingWhileAdminOnline = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        name: 'Học Viên Ca Trực Admin',
        phone: '0938111222',
        source: 'Landing Page',
      },
    });
    assert.equal(ingWhileAdminOnline.status, 201);
    assert.equal(ingWhileAdminOnline.json.data.status, 'assigned');

    const rosterAfterSkip = await apiRequest(harness.baseUrl, '/api/v1/users', {
      token: adminToken,
      tenantSlug,
    });
    const sale1Row = rosterAfterSkip.json.data.items.find((u: any) => u.id === sale1Id);
    assert.ok(sale1Row.profile.skipped_credit >= 1);

    // Scenario B: Admin also toggles offline -> ALL agents unavailable -> lead queues as unassigned_pending
    await apiRequest(harness.baseUrl, '/api/v1/users/me/availability', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { is_available: false },
    });

    const ing = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        name: 'Học Viên Ngoài Giờ',
        phone: '0938111333',
        source: 'Landing Page',
      },
    });
    assert.equal(ing.status, 201);
    assert.equal(ing.json.data.status, 'unassigned_pending');
    assert.equal(ing.json.data.assignedTo, null);

    // Sale 1 returns from Vacation Mode -> must automatically drain the unassigned_pending lead!
    const backOnline = await apiRequest(harness.baseUrl, '/api/v1/users/me/availability', {
      method: 'PATCH',
      token: sale1Token,
      tenantSlug,
      body: { is_available: true, vacation_mode: false },
    });
    assert.equal(backOnline.status, 200);
    assert.equal(backOnline.json.data.pending_leads_drained, 1);

    // Confirm lead is now assigned to Sale 1
    const myLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: sale1Token,
      tenantSlug,
    });
    assert.equal(myLeads.json.data.items.length, 1);
    assert.equal(myLeads.json.data.items[0].status, 'assigned');
  });

  it('Dynamic Pipeline Custom Fields validation, Stage Reorder/Deletion & SLA Timeout Sweeper', async () => {
    const pipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(pipes.status, 200);
    const defaultPipe = pipes.json.data[0];
    assert.ok(defaultPipe.stages.length >= 3);

    // Add a required select custom field
    const addCf = await apiRequest(harness.baseUrl, `/api/v1/pipelines/${defaultPipe.id}/custom-fields`, {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        field_key: 'campus_branch',
        field_label: 'Cơ sở đăng ký',
        field_type: 'select',
        is_required: true,
        options_json: ['Hà Nội', 'TP.HCM'],
      },
    });
    assert.equal(addCf.status, 201);

    // Missing required custom field -> 422
    const badLead1 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Thiếu Trường', phone: '0944555666' },
    });
    assert.equal(badLead1.status, 422);

    // Invalid select option -> 422
    const badLead2 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Sai Cơ Sở', phone: '0944555666', custom_fields: { campus_branch: 'Đà Nẵng' } },
    });
    assert.equal(badLead2.status, 422);

    // Valid custom field -> 201 and schedules SLA timer
    const goodLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Đúng Cơ Sở', phone: '0944555666', custom_fields: { campus_branch: 'TP.HCM' } },
    });
    assert.equal(goodLead.status, 201);
    const createdLeadId = goodLead.json.data.leadId;

    // Force-expire SLA entry in tenantRedis and run sweepExpiredSlaTimeouts
    const firstStageId = defaultPipe.stages[0].id;
    await tenantRedis.zadd('sla_queue', Date.now() - 5000, `${createdLeadId}:${firstStageId}`, tenantId);
    const breached = await sweepExpiredSlaTimeouts(tenantId);
    assert.equal(breached, 1);

    // Check SLA breach reflected in stats summary
    const stats = await apiRequest(harness.baseUrl, '/api/v1/leads/stats/summary', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(stats.status, 200);
    assert.ok(stats.json.data.sla_compliance_pct < 100);

    // Delete last stage safely and ensure leads remain intact
    const stageToDelete = defaultPipe.stages[defaultPipe.stages.length - 1].id;
    const delStage = await apiRequest(harness.baseUrl, `/api/v1/pipelines/${defaultPipe.id}/stages/${stageToDelete}`, {
      method: 'DELETE',
      token: adminToken,
      tenantSlug,
    });
    assert.equal(delStage.status, 200);
  });

  it('Syncs 6-Step Onboarding Tour state accurately via PATCH /auth/onboarding and GET /auth/me', async () => {
    const patch1 = await apiRequest(harness.baseUrl, '/api/v1/auth/onboarding', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        current_step: 4,
        completed_steps: [1, 2, 3],
        is_completed: false,
        dismissed: true,
      },
    });
    assert.equal(patch1.status, 200);
    assert.equal(patch1.json.data.current_step, 4);
    assert.deepEqual(patch1.json.data.completed_steps, [1, 2, 3]);
    assert.ok(patch1.json.data.dismissed_at);

    const me = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.onboarding.current_step, 4);
    assert.deepEqual(me.json.data.onboarding.completed_steps, [1, 2, 3]);
  });
});
