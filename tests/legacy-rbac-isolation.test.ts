import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';

describe('Milestone 1: Legacy RBAC, CRM Authorization, Lead Guard, PII Masking & Webhook Isolation', () => {
  let harness: TestHarness;
  const tenantSlug = 'm1-security';
  let tenantId = '';
  let adminToken = '';
  let managerToken = '';
  let managerId = '';
  let sale1Token = '';
  let sale1Id = '';
  let sale2Token = '';
  let sale2Id = '';
  let agencySaleToken = '';
  let agencySaleId = '';

  let lead1Id = ''; // Owned by sale1
  let lead2Id = ''; // Owned by sale2
  let lead3Id = ''; // Owned by agencySale
  let lead4UnassignedId = ''; // Unassigned
  let ticket1Id = ''; // Reported by sale1
  let ticketMgrId = ''; // Reported by manager
  let heldLeadId = ''; // In held_leads table

  before(async () => {
    harness = await startTestServer();

    // 1. Register Tenant & Admin
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Security Corp',
        tenant_slug: tenantSlug,
        admin_name: 'Admin Boss',
        work_email: 'admin@m1sec.vn',
        phone: '0901112233',
        password: 'AdminPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;

    // 2. Create Manager
    const mgrRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      body: {
        full_name: 'Manager Hoang',
        email: 'manager@m1sec.vn',
        phone: '0912223344',
        password: 'ManagerPassword123!',
        role: 'manager',
      },
    });
    assert.equal(mgrRes.status, 201);
    managerId = mgrRes.json.data.id;

    const mgrLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'manager@m1sec.vn', password: 'ManagerPassword123!' },
    });
    assert.equal(mgrLogin.status, 200);
    managerToken = mgrLogin.json.data.access_token;

    // 3. Create Internal Sale 1
    const s1Res = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: managerToken,
      body: {
        full_name: 'Sale Rep One',
        email: 'sale1@m1sec.vn',
        password: 'SalePassword123!',
        role: 'sale',
        is_external_agency: false,
      },
    });
    assert.equal(s1Res.status, 201);
    sale1Id = s1Res.json.data.id;

    const s1Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'sale1@m1sec.vn', password: 'SalePassword123!' },
    });
    assert.equal(s1Login.status, 200);
    sale1Token = s1Login.json.data.access_token;

    // 4. Create Internal Sale 2
    const s2Res = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: managerToken,
      body: {
        full_name: 'Sale Rep Two',
        email: 'sale2@m1sec.vn',
        password: 'SalePassword123!',
        role: 'sale',
        is_external_agency: false,
      },
    });
    assert.equal(s2Res.status, 201);
    sale2Id = s2Res.json.data.id;

    const s2Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'sale2@m1sec.vn', password: 'SalePassword123!' },
    });
    assert.equal(s2Login.status, 200);
    sale2Token = s2Login.json.data.access_token;

    // 5. Create External Agency Sale
    const agencyRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: managerToken,
      body: {
        full_name: 'Dai Ly Agency F1',
        email: 'agency@m1sec.vn',
        password: 'SalePassword123!',
        role: 'sale',
        is_external_agency: true,
      },
    });
    assert.equal(agencyRes.status, 201);
    agencySaleId = agencyRes.json.data.id;

    const agencyLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug,
      body: { email: 'agency@m1sec.vn', password: 'SalePassword123!' },
    });
    assert.equal(agencyLogin.status, 200);
    agencySaleToken = agencyLogin.json.data.access_token;

    // 6. Direct DB Seed: Leads & Stages for Testing
    const client = await harness.pool.connect();
    try {
      const pipRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 LIMIT 1',
        [tenantId]
      );
      const pipelineId = pipRes.rows[0].id;

      const stgRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC LIMIT 1',
        [tenantId, pipelineId]
      );
      const stageId = stgRes.rows[0].id;

      // Lead 1: Assigned to sale1
      const l1 = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, email, source, assigned_to, custom_fields)
         VALUES ($1, $2, $3, 'assigned', 'Customer Alpha', '0912345678', 'alpha@customer.vn', 'Meta Ads', $4, '{"note":"lead1"}'::jsonb)
         RETURNING id`,
        [tenantId, pipelineId, stageId, sale1Id]
      );
      lead1Id = l1.rows[0].id;

      // Lead 2: Assigned to sale2
      const l2 = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, email, source, assigned_to, custom_fields)
         VALUES ($1, $2, $3, 'assigned', 'Customer Beta', '0987654321', 'beta@customer.vn', 'Google Ads', $4, '{"note":"lead2"}'::jsonb)
         RETURNING id`,
        [tenantId, pipelineId, stageId, sale2Id]
      );
      lead2Id = l2.rows[0].id;

      // Lead 3: Assigned to agencySale
      const l3 = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, email, source, assigned_to, custom_fields)
         VALUES ($1, $2, $3, 'assigned', 'Customer Gamma', '0901234567', 'gamma@customer.vn', 'Zalo Ads', $4, '{"note":"lead3"}'::jsonb)
         RETURNING id`,
        [tenantId, pipelineId, stageId, agencySaleId]
      );
      lead3Id = l3.rows[0].id;

      // Lead 4: Unassigned
      const l4 = await client.query<{ id: string }>(
        `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone, email, source, assigned_to, custom_fields)
         VALUES ($1, $2, $3, 'unassigned_pending', 'Customer Delta', '0933445566', 'delta@customer.vn', 'Organic', NULL, '{"note":"lead4"}'::jsonb)
         RETURNING id`,
        [tenantId, pipelineId, stageId]
      );
      lead4UnassignedId = l4.rows[0].id;

      // Ticket 1: Reported by sale1
      const t1 = await client.query<{ id: string }>(
        `INSERT INTO data_reports (tenant_id, lead_id, reporter_id, reason, description, status)
         VALUES ($1, $2, $3, 'Số máy bận liên tục', 'Không liên lạc được sau 3 cuộc', 'pending')
         RETURNING id`,
        [tenantId, lead1Id, sale1Id]
      );
      ticket1Id = t1.rows[0].id;

      // Ticket Mgr: Reported by manager
      const tMgr = await client.query<{ id: string }>(
        `INSERT INTO data_reports (tenant_id, lead_id, reporter_id, reason, description, status)
         VALUES ($1, $2, $3, 'Trùng số hotline công ty', 'Báo cáo từ quản lý', 'pending')
         RETURNING id`,
        [tenantId, lead2Id, managerId]
      );
      ticketMgrId = tMgr.rows[0].id;

      // Held Lead: Quarantined
      const hld = await client.query<{ id: string }>(
        `INSERT INTO held_leads (tenant_id, name, phone, email, source, status, hold_reason)
         VALUES ($1, 'Held Customer Omega', '0977889900', 'omega@held.vn', 'AI Screener', 'held', 'Nghi ngờ số ảo')
         RETURNING id`,
        [tenantId]
      );
      heldLeadId = hld.rows[0].id;
    } finally {
      client.release();
    }
  });

  after(async () => {
    await harness.close();
  });

  describe('Task 1 (V-01): RBAC Enforcement in Legacy Admin Endpoints', () => {
    it('Sales rep receives HTTP 403 when invoking administrative mutations', async () => {
      const forbiddenActions = [
        'add_account',
        'edit_account',
        'delete_account',
        'save_settings',
        'save_ticket_settings',
        'add_meta_ad_account',
        'update_meta_ad_account',
        'delete_meta_ad_account',
        'toggle_meta_ad_account',
        'add_round',
        'edit_round',
        'delete_round',
        'add_rule',
        'edit_rule',
        'delete_rule',
        'add_connection',
        'edit_connection',
        'delete_connection',
        'test_email',
      ];

      for (const act of forbiddenActions) {
        const res = await apiRequest(harness.baseUrl, `/api/v1/legacy?action=${act}`, {
          method: 'POST',
          token: sale1Token,
          body: { name: 'Test', email: 'test@admin.vn', role: 'tenant_admin' },
        });
        assert.equal(
          res.status,
          403,
          `Action '${act}' should return 403 for sales rep but got ${res.status}: ${JSON.stringify(res.json)}`
        );
        assert.equal(res.json.success, false);
      }
    });

    it('External agency receives HTTP 403 on administrative actions', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=add_account', {
        method: 'POST',
        token: agencySaleToken,
        body: { name: 'Agency Hacker', email: 'hacker@agency.vn', role: 'tenant_admin' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.success, false);
    });

    it('Sales rep cannot read tenant administrative accounts via get_accounts', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_accounts', {
        token: sale1Token,
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.success, false);
    });

    it('Tenant admin can read accounts via get_accounts with NO password_hash leakage', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_accounts', {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.ok(Array.isArray(res.json.data));
      assert.ok(res.json.data.length >= 1);

      for (const acc of res.json.data) {
        assert.equal(acc.password_hash, undefined, 'password_hash must NEVER be exposed in get_accounts');
        assert.equal(acc.password, undefined, 'password must NEVER be exposed in get_accounts');
      }
    });
  });

  describe('Task 2 (V-02): Dispute & Ticket Authorization in Legacy CRM', () => {
    it('Sales rep receives HTTP 403 when attempting approve_report, reject_report, or compensate', async () => {
      const approveRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=approve_report', {
        method: 'POST',
        token: sale1Token,
        body: { id: ticket1Id, approval_reason: 'Self approve' },
      });
      assert.equal(approveRes.status, 403);
      assert.equal(approveRes.json.success, false);

      const rejectRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=reject_report', {
        method: 'POST',
        token: sale1Token,
        body: { id: ticket1Id, reject_reason: 'Self reject' },
      });
      assert.equal(rejectRes.status, 403);
      assert.equal(rejectRes.json.success, false);

      const compRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=compensate_approved_no_comp', {
        method: 'POST',
        token: sale1Token,
        body: { id: ticket1Id },
      });
      assert.equal(compRes.status, 403);
      assert.equal(compRes.json.success, false);
    });

    it('External agency receives HTTP 403 when attempting ticket approvals', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=approve_report', {
        method: 'POST',
        token: agencySaleToken,
        body: { id: ticket1Id },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.success, false);
    });

    it('Manager cannot approve their own report ticket (prevent self-compensation)', async () => {
      const selfApproveRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=approve_report', {
        method: 'POST',
        token: managerToken,
        body: { id: ticketMgrId, approval_reason: 'Manager self approval' },
      });
      assert.equal(selfApproveRes.status, 403);
      assert.equal(selfApproveRes.json.success, false);
      assert.match(selfApproveRes.json.error, /cannot approve your own report ticket/i);
    });

    it('Admin can successfully approve tickets', async () => {
      const adminApprove = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=approve_report', {
        method: 'POST',
        token: adminToken,
        body: { id: ticket1Id, approval_reason: 'Approved by Admin Boss' },
      });
      assert.equal(adminApprove.status, 200);
      assert.equal(adminApprove.json.success, true);
    });
  });

  describe('Task 3 (V-03): Lead Ownership & Tamper Guard', () => {
    it('Sales rep receives HTTP 403 when attempting reassign_lead', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=reassign_lead', {
        method: 'POST',
        token: sale1Token,
        body: { lead_id: lead2Id, new_consultant_id: sale1Id },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.success, false);
    });

    it('Sales rep cannot tamper with another reps lead fields', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=update_lead_fields', {
        method: 'POST',
        token: sale1Token,
        body: { lead_id: lead2Id, name: 'Hacked Name', phone: '0999999999' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.success, false);
    });

    it('Sales rep cannot alter quality status of another reps lead', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=update_lead_quality', {
        method: 'POST',
        token: sale1Token,
        body: { lead_id: lead2Id, quality_status: 'Disqualified' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.success, false);
    });

    it('Sales rep can modify fields on their OWN assigned lead', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=update_lead_fields', {
        method: 'POST',
        token: sale1Token,
        body: { lead_id: lead1Id, name: 'Alpha Customer Renamed', note: 'Updated by owner sale1' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
    });

    it('External agency cannot tamper with internal sales leads', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=update_lead_fields', {
        method: 'POST',
        token: agencySaleToken,
        body: { lead_id: lead1Id, name: 'Tampered by Agency' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.json.success, false);
    });
  });

  describe('Task 4 (V-04): PII Masking on Legacy Routes', () => {
    it('get_report_context: masks phone for external agencies and unassigned leads', async () => {
      // 1. External agency viewing lead: phone must be masked
      const agencyCtx = await apiRequest(harness.baseUrl, `/api/v1/legacy?action=get_report_context&lead_id=${lead3Id}`, {
        token: agencySaleToken,
      });
      assert.equal(agencyCtx.status, 200);
      assert.equal(agencyCtx.json.success, true);
      assert.match(agencyCtx.json.data.lead_phone, /0901\*\*\*567/);
      assert.match(agencyCtx.json.lead.lead_phone, /0901\*\*\*567/);

      // 2. Sales rep viewing an unassigned lead: phone must be masked
      const saleUnassignedCtx = await apiRequest(
        harness.baseUrl,
        `/api/v1/legacy?action=get_report_context&lead_id=${lead4UnassignedId}`,
        { token: sale1Token }
      );
      assert.equal(saleUnassignedCtx.status, 200);
      assert.equal(saleUnassignedCtx.json.success, true);
      assert.match(saleUnassignedCtx.json.data.lead_phone, /0933\*\*\*566/);

      // 3. Sales rep viewing their OWN assigned lead: phone is unmasked
      const ownCtx = await apiRequest(harness.baseUrl, `/api/v1/legacy?action=get_report_context&lead_id=${lead1Id}`, {
        token: sale1Token,
      });
      assert.equal(ownCtx.status, 200);
      assert.equal(ownCtx.json.success, true);
      assert.equal(ownCtx.json.data.lead_phone, '0912345678');
      assert.equal(ownCtx.json.lead.lead_phone, '0912345678');
    });

    it('accept_lead: returns masked phone for external agencies', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=accept_lead', {
        method: 'POST',
        token: agencySaleToken,
        body: { lead_id: lead3Id },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.match(res.json.data.phone, /0901\*\*\*567/);
      assert.match(res.json.lead.phone, /0901\*\*\*567/);
    });

    it('get_held_leads: masks phone numbers for external agencies and sales reps', async () => {
      const agencyHeld = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_held_leads', {
        token: agencySaleToken,
      });
      assert.equal(agencyHeld.status, 200);
      assert.ok(agencyHeld.json.data.length >= 1);
      const targetItemAgency = agencyHeld.json.data.find((x: any) => x.id === heldLeadId);
      assert.ok(targetItemAgency);
      assert.match(targetItemAgency.phone, /0977\*\*\*900/);

      const saleHeld = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_held_leads', {
        token: sale1Token,
      });
      assert.equal(saleHeld.status, 200);
      const targetItemSale = saleHeld.json.data.find((x: any) => x.id === heldLeadId);
      assert.ok(targetItemSale);
      assert.match(targetItemSale.phone, /0977\*\*\*900/);

      // Admin sees unmasked phone
      const adminHeld = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_held_leads', {
        token: adminToken,
      });
      assert.equal(adminHeld.status, 200);
      const targetItemAdmin = adminHeld.json.data.find((x: any) => x.id === heldLeadId);
      assert.ok(targetItemAdmin);
      assert.equal(targetItemAdmin.phone, '0977889900');
    });

    it('get_reports: masks phone for external agencies', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_reports', {
        token: agencySaleToken,
      });
      assert.equal(res.status, 200);
      for (const item of res.json.data) {
        if (item.lead_phone && item.lead_phone !== '-') {
          assert.match(item.lead_phone, /\*/);
        }
      }
    });
  });

  describe('Task 5 (V-05): Telegram Webhook Tenant Isolation', () => {
    it('Returns HTTP 400 when webhook arrives without tenant identifier', async () => {
      const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/telegram/webhook', {
        method: 'POST',
        body: {
          message: {
            text: '/chatid',
            chat: { id: 123456789 },
          },
        },
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.success, false);
      assert.match(res.json.error, /Missing tenant identifier for webhook/i);
    });

    it('Executes cleanly when explicit tenant_slug is provided', async () => {
      const res = await apiRequest(
        harness.baseUrl,
        `/api/v1/integrations/telegram/webhook?tenant_slug=${tenantSlug}`,
        {
          method: 'POST',
          body: {
            message: {
              text: '/chatid',
              chat: { id: 987654321 },
            },
          },
        }
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.ok(res.json.data);
    });
  });
});
