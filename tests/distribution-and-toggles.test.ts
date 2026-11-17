import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';

describe('Phase 2: Fair-Share Distribution, 90d Duplicate Reminder & Dual-Dimension Sale Toggles', () => {
  let harness: TestHarness;
  let adminToken = '';
  let tenantSlug = 'capital-house';
  let saleSeniorId = '';
  let saleSeniorToken = '';
  let saleJuniorId = '';
  let saleJuniorToken = '';

  before(async () => {
    harness = await startTestServer();

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Capital House Group',
        tenant_slug: tenantSlug,
        admin_name: 'Admin Capital',
        work_email: 'admin@capitalhouse.vn',
        phone: '0903888999',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
        initial_sales: [
          {
            full_name: 'Senior Sale Minh',
            email: 'senior@capitalhouse.vn',
            phone: '0903111222',
            role: 'sale',
            receive_ratio: 2,
            is_available: true,
          },
          {
            full_name: 'Junior Sale Lan',
            email: 'junior@capitalhouse.vn',
            phone: '0903333444',
            role: 'sale',
            receive_ratio: 1,
            is_available: true,
          },
        ],
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;

    const usersList = await apiRequest(harness.baseUrl, '/api/v1/users?role=sale', { token: adminToken });
    const senior = usersList.json.data.items.find((u: any) => u.email === 'senior@capitalhouse.vn');
    const junior = usersList.json.data.items.find((u: any) => u.email === 'junior@capitalhouse.vn');
    saleSeniorId = senior.id;
    saleJuniorId = junior.id;

    const loginSenior = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'senior@capitalhouse.vn', password: 'SecurePassword123!' },
    });
    saleSeniorToken = loginSenior.json.data.access_token;

    const loginJunior = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'junior@capitalhouse.vn', password: 'SecurePassword123!' },
    });
    saleJuniorToken = loginJunior.json.data.access_token;
  });

  after(async () => {
    await harness.close();
  });

  it('Weighted Round-Robin distributes 15 leads in exact 2:1 ratio (10 Senior : 5 Junior)', async () => {
    const counts: Record<string, number> = { [saleSeniorId]: 0, [saleJuniorId]: 0 };

    for (let i = 0; i < 15; i++) {
      const phone = `0915000${String(100 + i)}`;
      const res = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: adminToken,
        body: { name: `Lead Ratio #${i + 1}`, phone, source: 'Facebook Ads' },
      });
      assert.equal(res.status, 201);
      counts[res.json.data.assignedTo] = (counts[res.json.data.assignedTo] || 0) + 1;
    }

    assert.equal(counts[saleSeniorId], 10, 'Senior (ratio 2) must receive exactly 10 of 15 leads');
    assert.equal(counts[saleJuniorId], 5, 'Junior (ratio 1) must receive exactly 5 of 15 leads');
  });

  it('90-Day Duplicate Reminder routes re-engaging client directly to original consultant', async () => {
    // Find one of Junior Sale's leads
    const juniorLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', { token: saleJuniorToken });
    const existingPhone = juniorLeads.json.data.items[0].phone; // e.g. '84915000101'
    const localFormat = '0' + existingPhone.slice(2);

    // Submit 3 times in a row: even though Senior would normally get turns, all 3 route to Junior as duplicate reminders!
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dupRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: adminToken,
        body: {
          name: 'Returning Client',
          phone: localFormat,
          source: 'Google Re-remarketing',
        },
      });
      assert.equal(dupRes.status, 201);
      assert.equal(dupRes.json.data.isDuplicateReminder, true);
      assert.equal(dupRes.json.data.assignedTo, saleJuniorId);
    }
  });

  it('Approved Error Ticket grants compensation credit and prioritizes that Sale immediately', async () => {
    const juniorLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', { token: saleJuniorToken });
    const targetLeadId = juniorLeads.json.data.items[0].id;

    // Junior submits error ticket (Op 23)
    const tkRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${targetLeadId}/tickets`, {
      method: 'POST',
      token: saleJuniorToken,
      body: { reason: 'Thuê bao không tồn tại', description: 'Gọi 3 lần báo số không đúng' },
    });
    assert.equal(tkRes.status, 201);
    const ticketId = tkRes.json.data.id;

    // Admin approves ticket -> grants +1 compensation_count to Junior (Op 24)
    const resolveRes = await apiRequest(harness.baseUrl, `/api/v1/leads/tickets/${ticketId}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: { decision: 'approved', resolution_note: 'Đã kiểm tra tổng đài, duyệt bù số' },
    });
    assert.equal(resolveRes.status, 200);

    // Next fresh lead MUST go to Junior with dispatchReason === 'compensation_credit'
    const nextLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Compensated Lead', phone: '0938765432', source: 'Ladipage' },
    });
    assert.equal(nextLead.status, 201);
    assert.equal(nextLead.json.data.assignedTo, saleJuniorId);
    assert.equal(nextLead.json.data.dispatchReason, 'compensation_credit');
  });

  it('Concurrent burst of identical phone submissions serializes cleanly via advisory lock', async () => {
    const burstCalls = Array.from({ length: 6 }, (_, i) =>
      apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: adminToken,
        body: { name: `Burst #${i}`, phone: '0977123456', source: 'Livestream Flash' },
      })
    );

    const outcomes = await Promise.all(burstCalls);
    for (const o of outcomes) {
      assert.equal(o.status, 201);
    }

    // All 6 records must belong to the EXACT SAME consultant (1st via round-robin, remaining 5 via 90d duplicate reminder!)
    const assignees = new Set(outcomes.map((o) => o.json.data.assignedTo));
    assert.equal(assignees.size, 1, 'Concurrent identical phones must never split across multiple sales');
    const reminderCount = outcomes.filter((o) => o.json.data.isDuplicateReminder).length;
    assert.equal(reminderCount, 5);
  });

  it('Admin Deactivation Toggle auto-recalls unaccepted leads AND blacklists JWT session immediately', async () => {
    // Senior accepts 1 lead first, leaves remaining leads unaccepted
    const seniorLeadsBefore = await apiRequest(harness.baseUrl, '/api/v1/leads', { token: saleSeniorToken });
    const firstSeniorLeadId = seniorLeadsBefore.json.data.items[0].id;

    const acceptRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${firstSeniorLeadId}/accept`, {
      method: 'POST',
      token: saleSeniorToken,
    });
    assert.equal(acceptRes.status, 200);
    assert.equal(acceptRes.json.data.is_accepted, true);

    // Admin toggles Senior Sale status -> 'inactive' and transfers recalled/active leads to Junior Sale
    const toggleRes = await apiRequest(harness.baseUrl, `/api/v1/users/${saleSeniorId}/admin-status`, {
      method: 'POST',
      token: adminToken,
      body: {
        status: 'inactive',
        reassignment_mode: 'auto_recall_and_transfer',
        target_user_id: saleJuniorId,
        reason: 'Nghỉ công tác dài hạn',
      },
    });
    assert.equal(toggleRes.status, 200);
    assert.ok(toggleRes.json.data.leads_recalled >= 1, 'Unaccepted leads must be recalled');
    assert.ok(toggleRes.json.data.leads_transferred >= 1, 'Accepted leads must be transferred');
    assert.equal(toggleRes.json.data.session_revoked, true);

    // Senior Sale's existing JWT token is IMMEDIATELY rejected with HTTP 401 ACCOUNT_DEACTIVATED!
    const revokedAttempt = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: saleSeniorToken,
    });
    assert.equal(revokedAttempt.status, 401);
    assert.equal(revokedAttempt.json.error.code, 'ACCOUNT_DEACTIVATED');
  });
});
