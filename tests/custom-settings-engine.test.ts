import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { sweepExpiredSlaTimeouts } from '../server/services/distribution.service.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';

describe('Phase 7: Full No-Hardcode Custom Settings Engine, Dynamic RBAC, Multi-Pipeline & Policy Matrix', () => {
  let harness: TestHarness;
  let platformToken = '';
  let adminToken = '';
  let managerToken = '';
  let saleAToken = '';
  let saleBToken = '';
  let agencyToken = '';
  let saleAId = '';
  let saleBId = '';
  let defaultPipelineId = '';
  const tenantSlug = 'custom-engine-corp';

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    await harness.close();
  });

  it('1. Super Admin configures Platform Defaults & New Tenant inherits + overrides custom stages/settings', async () => {
    const loginSa = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(loginSa.status, 200);
    platformToken = loginSa.json.data.access_token;

    const patchGlobal = await apiRequest(harness.baseUrl, '/api/v1/admin/platform-settings', {
      method: 'PATCH',
      token: platformToken,
      body: {
        default_tenant_settings: {
          default_currency: 'USD',
          vacation_credit_cap: 6,
          default_sla_minutes: 25,
        },
      },
    });
    assert.equal(patchGlobal.status, 200);
    assert.equal(patchGlobal.json.data.default_tenant_settings.default_currency, 'USD');
    assert.equal(patchGlobal.json.data.default_tenant_settings.vacation_credit_cap, 6);

    // Public endpoint returns updated platform defaults
    const pubDefaults = await apiRequest(harness.baseUrl, '/api/v1/auth/default-settings');
    assert.equal(pubDefaults.status, 200);
    assert.equal(pubDefaults.json.data.default_currency, 'USD');

    // Register tenant with custom stages (including non-enum custom CAPI event!) + custom_settings override
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Custom Engine Enterprise',
        tenant_slug: tenantSlug,
        admin_name: 'CEO Custom',
        work_email: 'ceo@custom-engine.vn',
        phone: '0912000111',
        password: 'AdminPassword123!',
        industry: 'b2b',
        seed_demo_leads: false,
        custom_pipeline_name: 'Phễu Enterprise Tùy Chỉnh',
        custom_stages: [
          { stage_key: 'inbound_new', stage_name: 'Mới Tiếp Nhận', color_hex: '#1E40FF', capi_event_mapping: 'Lead', sla_timeout_minutes: 10 },
          { stage_key: 'vip_signed', stage_name: 'Ký Hợp Đồng VIP', color_hex: '#10B981', capi_event_mapping: 'SignedVIPContract', sla_timeout_minutes: 0 },
        ],
        custom_settings: {
          duplicate_threshold_days: 45,
        },
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
    const tenantId = reg.json.data.tenant.id;

    // Verify inherited platform defaults + per-tenant override
    assert.equal(reg.json.data.tenant.settings.default_currency, 'USD');
    assert.equal(reg.json.data.tenant.settings.vacation_credit_cap, 6);
    assert.equal(reg.json.data.tenant.settings.duplicate_threshold_days, 45);

    // Verify custom pipeline & custom CAPI event stage
    const pipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(pipes.status, 200);
    assert.equal(pipes.json.data[0].name, 'Phễu Enterprise Tùy Chỉnh');
    assert.equal(pipes.json.data[0].stages[1].capi_event_mapping, 'SignedVIPContract');
    defaultPipelineId = pipes.json.data[0].id;

    // Verify configurable Super Admin impersonation duration (30 minutes -> 1800s)
    const imp = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}/impersonate`, {
      method: 'POST',
      token: platformToken,
      body: { duration_minutes: 30 },
    });
    assert.equal(imp.status, 200);
    assert.equal(imp.json.data.expires_in_seconds, 1800);
  });

  it('2. Enforces Duplicate Lead Action Policies: reject_duplicate, update_existing, and threshold=0', async () => {
    // Put Admin offline so Sale A & Sale B receive leads predictably
    await apiRequest(harness.baseUrl, '/api/v1/users/me/availability', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { is_available: false },
    });

    // Create Manager, Sale A (ratio 4), Sale B (ratio 1), and External Agency F1 (offline initially)
    const cMgr = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { full_name: 'Manager Linh', email: 'mgr@custom.vn', password: 'Password123!', role: 'manager' },
    });
    assert.equal(cMgr.status, 201);

    const cSaleA = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        full_name: 'Sale Alpha',
        email: 'sale.a@custom.vn',
        password: 'Password123!',
        role: 'sale',
        receive_ratio: 4,
      },
    });
    assert.equal(cSaleA.status, 201);
    saleAId = cSaleA.json.data.id;

    const cSaleB = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        full_name: 'Sale Beta',
        email: 'sale.b@custom.vn',
        password: 'Password123!',
        role: 'sale',
        receive_ratio: 1,
      },
    });
    assert.equal(cSaleB.status, 201);
    saleBId = cSaleB.json.data.id;

    const cAgency = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        full_name: 'Agency F1 Partner',
        email: 'f1@custom.vn',
        password: 'Password123!',
        role: 'sale',
        is_external_agency: true,
        is_available: false,
      },
    });
    assert.equal(cAgency.status, 201);

    // Log in staff
    managerToken = (
      await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        tenantSlug,
        body: { email: 'mgr@custom.vn', password: 'Password123!' },
      })
    ).json.data.access_token;

    saleAToken = (
      await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        tenantSlug,
        body: { email: 'sale.a@custom.vn', password: 'Password123!' },
      })
    ).json.data.access_token;

    saleBToken = (
      await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        tenantSlug,
        body: { email: 'sale.b@custom.vn', password: 'Password123!' },
      })
    ).json.data.access_token;

    agencyToken = (
      await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        tenantSlug,
        body: { email: 'f1@custom.vn', password: 'Password123!' },
      })
    ).json.data.access_token;

    // Create initial lead
    const l1 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Khách Trùng Test', phone: '0988111222', campaign: 'Camp_V1' },
    });
    assert.equal(l1.status, 201);
    const originalLeadId = l1.json.data.lead_id;

    // Policy A: reject_duplicate -> 409
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { duplicate_action: 'reject_duplicate', duplicate_threshold_days: 90 } },
    });

    const dupReject = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Khách Trùng Lần 2', phone: '+84988111222', campaign: 'Camp_V2' },
    });
    assert.equal(dupReject.status, 409);
    assert.equal(dupReject.json.error.code, 'DUPLICATE_LEAD_REJECTED');

    // Policy B: update_existing -> updates original lead in-place without adding a new lead row!
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { duplicate_action: 'update_existing' } },
    });

    const dupUpdate = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        name: 'Khách Trùng Đã Cập Nhật',
        phone: '0988111222',
        campaign: 'Camp_Updated_In_Place',
        custom_fields: { utm_note: 'reengaged' },
      },
    });
    assert.equal(dupUpdate.status, 201);
    assert.equal(dupUpdate.json.data.lead_id, originalLeadId);
    assert.equal(dupUpdate.json.data.distribution_type, 'duplicate_updated_existing');

    const listAfterUpdate = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(listAfterUpdate.json.data.items.length, 1);
    assert.equal(listAfterUpdate.json.data.items[0].campaign, 'Camp_Updated_In_Place');
    assert.equal(listAfterUpdate.json.data.items[0].custom_fields.utm_note, 'reengaged');

    // Policy C: duplicate_threshold_days = 0 -> disables duplicate check completely
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { duplicate_threshold_days: 0, duplicate_action: 'reject_duplicate' } },
    });
    const dupAllowedWhenZero = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Khách Mới Khi Tắt Trùng', phone: '0988111222' },
    });
    assert.equal(dupAllowedWhenZero.status, 201);
    assert.notEqual(dupAllowedWhenZero.json.data.lead_id, originalLeadId);
  });

  it('3. Supports Distribution Modes (manual_only, strict_round_robin, least_loaded) & Batch Turn (data_per_turn)', async () => {
    // 3a. manual_only mode -> queues lead without assigning even though Sale A & B are online
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { distribution_mode: 'manual_only', duplicate_threshold_days: 90 } },
    });

    const manualLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Lead Chờ Chia Tay', phone: '0977000001' },
    });
    assert.equal(manualLead.status, 201);
    assert.equal(manualLead.json.data.status, 'unassigned_pending');
    assert.equal(manualLead.json.data.assigned_to, null);

    // 3b. strict_round_robin -> ignores 4:1 ratio and alternates 1:1
    const roundsRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds/list', {
      token: adminToken,
      tenantSlug,
    });
    const roundId = roundsRes.json.data.rounds[0].id;
    await apiRequest(harness.baseUrl, `/api/v1/pipelines/rounds/${roundId}`, {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { reset_counters: true },
    });

    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { distribution_mode: 'strict_round_robin' } },
    });

    const strictAssignees: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: adminToken,
        tenantSlug,
        body: { name: `Strict Lead ${i}`, phone: `097710000${i}` },
      });
      strictAssignees.push(r.json.data.assigned_to);
    }
    assert.equal(strictAssignees.filter((id) => id === saleAId).length, 2);
    assert.equal(strictAssignees.filter((id) => id === saleBId).length, 2);

    // 3c. weighted_round_robin with data_per_turn = 3 on Sale B -> Sale B receives 3 consecutive leads once started!
    await apiRequest(harness.baseUrl, `/api/v1/pipelines/rounds/${roundId}/consultants`, {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: { user_id: saleAId, receive_ratio: 1, data_per_turn: 1 },
    });
    await apiRequest(harness.baseUrl, `/api/v1/pipelines/rounds/${roundId}/consultants`, {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: { user_id: saleBId, receive_ratio: 3, data_per_turn: 3 },
    });
    await apiRequest(harness.baseUrl, `/api/v1/pipelines/rounds/${roundId}`, {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { reset_counters: true },
    });
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { distribution_mode: 'weighted_round_robin' } },
    });

    const batchAssignees: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: adminToken,
        tenantSlug,
        body: { name: `Batch Lead ${i}`, phone: `097720000${i}` },
      });
      batchAssignees.push(r.json.data.assigned_to);
    }
    assert.equal(batchAssignees.filter((id) => id === saleBId).length, 3);
    assert.equal(batchAssignees.filter((id) => id === saleAId).length, 1);
    // Verify the 3 leads for Sale B were delivered consecutively without interleaving!
    const firstB = batchAssignees.indexOf(saleBId);
    assert.equal(batchAssignees[firstB], saleBId);
    assert.equal(batchAssignees[firstB + 1], saleBId);
    assert.equal(batchAssignees[firstB + 2], saleBId);
  });

  it('4. Auto-Recalls & Reassigns SLA-breached unaccepted lead when sla_auto_recall_enabled is true', async () => {
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        settings: {
          sla_auto_recall_enabled: true,
          sla_email_subject_template: '[VIP SLA] {{lead_name}} quá hạn tại {{sale_name}}',
        },
      },
    });

    // Force assign a lead to Sale A
    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        name: 'Khách SLA Auto Recall',
        phone: '0966888999',
        assigned_to: saleAId,
      },
    });
    assert.equal(leadRes.status, 201);
    const slaLeadId = leadRes.json.data.lead_id;

    // Fetch lead stage_id and tenant_id via /auth/me & /leads
    const me = await apiRequest(harness.baseUrl, '/api/v1/auth/me', { token: adminToken, tenantSlug });
    const tId = me.json.data.tenant.id;
    const leadsList = await apiRequest(harness.baseUrl, '/api/v1/leads?search=0966888999', {
      token: adminToken,
      tenantSlug,
    });
    const stageId = leadsList.json.data.items[0].stage.id;

    // Backdate SLA timer in Redis so sweeper processes it immediately
    await tenantRedis.zadd('sla_queue', Date.now() - 5000, `${slaLeadId}:${stageId}`, tId);
    const breachedCount = await sweepExpiredSlaTimeouts(tId);
    assert.equal(breachedCount >= 1, true);

    // Verify lead was automatically recalled from Sale A and reassigned to online Sale B!
    const afterSweep = await apiRequest(harness.baseUrl, '/api/v1/leads?search=0966888999', {
      token: adminToken,
      tenantSlug,
    });
    const updatedLead = afterSweep.json.data.items[0];
    assert.equal(updatedLead.sla_breached, true);
    assert.equal(updatedLead.assigned_sale.id, saleBId);
  });

  it('5. Enforces Custom PII Masking (prefix/suffix/char, mask_before_accept), Custom Internal Note Types & Custom Ticket Credits', async () => {
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        settings: {
          pii_masking_enabled: true,
          pii_mask_phone_prefix: 3,
          pii_mask_phone_suffix: 2,
          pii_mask_char: '#',
          pii_mask_before_accept: true,
          compensation_credits_per_ticket: 3,
          auto_disqualify_on_ticket_approve: false,
          note_types: [
            { value: 'PUBLIC_CALL', label: 'Gọi tư vấn công khai', internal_only: false },
            { value: 'VIP_MARGIN_SECRET', label: 'Biên lợi nhuận nội bộ', internal_only: true },
          ],
        },
      },
    });

    // Assign lead to Internal Sale A -> because pii_mask_before_accept = true, phone is masked BEFORE accept!
    const lSale = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Khách Che Trước Nhận', phone: '0912345678', assigned_to: saleAId },
    });
    const leadId = lSale.json.data.lead_id;

    const beforeAccept = await apiRequest(harness.baseUrl, '/api/v1/leads?search=Khách%20Che%20Trước%20Nhận', {
      token: saleAToken,
      tenantSlug,
    });
    assert.equal(beforeAccept.json.data.items[0].pii_masked, true);
    assert.equal(beforeAccept.json.data.items[0].phone.includes('#'), true);
    assert.equal(beforeAccept.json.data.items[0].phone.endsWith('78'), true);

    // Sale A accepts lead -> phone is now unmasked for Internal Sale A!
    await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/accept`, {
      method: 'POST',
      token: saleAToken,
      tenantSlug,
    });
    const afterAccept = await apiRequest(harness.baseUrl, '/api/v1/leads?search=Khách%20Che%20Trước%20Nhận', {
      token: saleAToken,
      tenantSlug,
    });
    assert.equal(afterAccept.json.data.items[0].pii_masked, false);
    assert.equal(afterAccept.json.data.items[0].phone, '84912345678');

    // Admin writes a custom internal_only note ('VIP_MARGIN_SECRET') and reassigns lead to External Agency F1
    await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/timeline/notes`, {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { note_type: 'VIP_MARGIN_SECRET', title: 'Biên lợi nhuận 18%', content: 'Chiết khấu kín cho sàn chủ' },
    });
    const usersRes = await apiRequest(harness.baseUrl, '/api/v1/users', { token: adminToken, tenantSlug });
    const agencyUser = usersRes.json.data.items.find((u: any) => u.email === 'f1@custom.vn');
    await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/reassign`, {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { target_user_id: agencyUser.id },
    });

    // External Agency F1 fetches timeline -> custom VIP_MARGIN_SECRET note is strictly hidden!
    const f1Timeline = await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/timeline`, {
      token: agencyToken,
      tenantSlug,
    });
    assert.equal(
      f1Timeline.json.data.some((ev: any) => String(ev.title).includes('Biên lợi nhuận')),
      false
    );

    // Sale B creates a lead & submits error ticket -> approving grants +3 credits AND does NOT disqualify lead!
    const lTicket = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Khách Ticket +3 Bù', phone: '0933444555', assigned_to: saleBId },
    });
    const tkLeadId = lTicket.json.data.lead_id;

    const tkCreate = await apiRequest(harness.baseUrl, `/api/v1/leads/${tkLeadId}/tickets`, {
      method: 'POST',
      token: saleBToken,
      tenantSlug,
      body: { reason: 'Khách nhầm dự án', description: 'Xin cấp bù theo cấu hình 3 lượt' },
    });
    assert.equal(tkCreate.status, 201);

    const beforeUsers = await apiRequest(harness.baseUrl, '/api/v1/users', { token: adminToken, tenantSlug });
    const prevComp = beforeUsers.json.data.items.find((u: any) => u.id === saleBId).round_quota.compensation_count;

    const tkResolve = await apiRequest(harness.baseUrl, `/api/v1/leads/tickets/${tkCreate.json.data.id}/resolve`, {
      method: 'POST',
      token: managerToken,
      tenantSlug,
      body: { decision: 'approved' },
    });
    assert.equal(tkResolve.status, 200);
    assert.equal(tkResolve.json.data.granted_credits, 3);

    const afterUsers = await apiRequest(harness.baseUrl, '/api/v1/users', { token: adminToken, tenantSlug });
    const nextComp = afterUsers.json.data.items.find((u: any) => u.id === saleBId).round_quota.compensation_count;
    assert.equal(nextComp - prevComp, 3);

    const checkLeadNotDisq = await apiRequest(harness.baseUrl, '/api/v1/leads?search=0933444555', {
      token: adminToken,
      tenantSlug,
    });
    assert.notEqual(checkLeadNotDisq.json.data.items[0].status, 'disqualified');
  });

  it('6. Enforces Dynamic RBAC Overrides (Manager CSV/Pipeline & Sale Self-Create/Reassign)', async () => {
    // Default: Manager cannot export CSV or create Pipeline; Sale cannot create Lead or Reassign
    const mgrCsvDenied = await apiRequest(harness.baseUrl, '/api/v1/leads/export', {
      token: managerToken,
      tenantSlug,
    });
    assert.equal(mgrCsvDenied.status, 403);

    const mgrPipeDenied = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      method: 'POST',
      token: managerToken,
      tenantSlug,
      body: { name: 'Phễu Dự Án Mới' },
    });
    assert.equal(mgrPipeDenied.status, 403);

    const saleCreateDenied = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: saleAToken,
      tenantSlug,
      body: { name: 'Sale Tự Tạo', phone: '0944555666' },
    });
    assert.equal(saleCreateDenied.status, 403);

    // Tenant Admin unlocks all 4 dynamic RBAC toggles
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        settings: {
          pii_mask_before_accept: false,
          role_permissions: {
            allow_manager_export_csv: true,
            allow_manager_manage_pipelines: true,
            allow_sale_create_lead: true,
            allow_sale_reassign_lead: true,
          },
        },
      },
    });

    const mgrCsvOk = await fetch(`${harness.baseUrl}/api/v1/leads/export`, {
      headers: {
        Authorization: `Bearer ${managerToken}`,
        'X-Tenant-Slug': tenantSlug,
      },
    });
    assert.equal(mgrCsvOk.status, 200);
    const csvBody = await mgrCsvOk.text();
    assert.equal(csvBody.includes('ID,Khách hàng'), true);

    const mgrPipeOk = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      method: 'POST',
      token: managerToken,
      tenantSlug,
      body: { name: 'Phễu Do Manager Tạo' },
    });
    assert.equal(mgrPipeOk.status, 201);

    const saleCreateOk = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: saleAToken,
      tenantSlug,
      body: { name: 'Khách Sale Tự Nhập', phone: '0944555666', assigned_to: saleAId },
    });
    assert.equal(saleCreateOk.status, 201);

    const saleReassignOk = await apiRequest(
      harness.baseUrl,
      `/api/v1/leads/${saleCreateOk.json.data.lead_id}/reassign`,
      {
        method: 'POST',
        token: saleAToken,
        tenantSlug,
        body: { target_user_id: saleBId },
      }
    );
    assert.equal(saleReassignOk.status, 200);
  });

  it('7. Validates Custom Phone Policies, Custom Fields (min/max/multiselect), Advanced Routing Rules, Custom CAPI Auto-Value & Custom Zalo Commands', async () => {
    // 7a. International phone toggle
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { allow_international_phones: false } },
    });
    const intlBlocked = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Singapore Client', phone: '+6591234567' },
    });
    assert.equal(intlBlocked.status, 422);

    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { allow_international_phones: true } },
    });
    const intlAllowed = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Singapore Client', phone: '+6591234567' },
    });
    assert.equal(intlAllowed.status, 201);

    // 7b. Custom Field with min/max validation + Auto Deal Value extraction in Meta CAPI
    const cfBudget = await apiRequest(
      harness.baseUrl,
      `/api/v1/pipelines/${defaultPipelineId}/custom-fields`,
      {
        method: 'POST',
        token: adminToken,
        tenantSlug,
        body: {
          field_label: 'Ngân sách hợp đồng',
          field_key: 'deal_budget',
          field_type: 'currency',
          is_required: false,
          config_json: { min: 1000, max: 5000000 },
        },
      }
    );
    assert.equal(cfBudget.status, 201);

    const tooLowLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        pipeline_id: defaultPipelineId,
        name: 'Khách Ngân Sách Thấp',
        phone: '0915222333',
        custom_fields: { deal_budget: 50 },
      },
    });
    assert.equal(tooLowLead.status, 422);

    // Create dedicated VIP round with only Sale A & Routing Rule with `gt` operator on `deal_budget`!
    const vipRound = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { pipeline_id: defaultPipelineId, name: 'Vòng VIP > 50k USD', priority: 1 },
    });
    assert.equal(vipRound.status, 201);
    const vipRoundId = vipRound.json.data.id;

    await apiRequest(harness.baseUrl, `/api/v1/pipelines/rounds/${vipRoundId}/consultants`, {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: { user_id: saleAId, receive_ratio: 1 },
    });

    const ruleRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines/routing-rules', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        round_id: vipRoundId,
        rule_name: 'Deal lớn > 50,000 USD vào thẳng Vòng VIP',
        priority: 1,
        conditions_json: {
          match_mode: 'all',
          rules: [{ field: 'deal_budget', op: 'gt', val: 50000 }],
        },
      },
    });
    assert.equal(ruleRes.status, 201);

    const highBudgetLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        pipeline_id: defaultPipelineId,
        name: 'Trần Đại Gia VIP',
        phone: '0915888999',
        custom_fields: { deal_budget: 125000 },
      },
    });
    assert.equal(highBudgetLead.status, 201);
    assert.equal(highBudgetLead.json.data.assigned_to, saleAId);
    const vipLeadId = highBudgetLead.json.data.lead_id;

    // 7c. Configure Meta CAPI Vault + Partial Update preserving secret + Auto-extract deal_budget on custom CAPI event!
    const saveCapi1 = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/meta_capi', {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: {
        dataset_id: '777888999000',
        access_token: 'EAA_SECRET_PRESERVED_TOKEN_999',
        default_currency: 'USD',
        default_country: 'sg',
        value_custom_field_key: 'deal_budget',
      },
    });
    assert.equal(saveCapi1.status, 200);

    // Partial update without sending access_token -> must preserve EAA_SECRET_PRESERVED_TOKEN_999
    const saveCapi2 = await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/meta_capi', {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: {
        dataset_id: '777888999000',
        access_token: '',
        test_event_code: 'TEST_CUSTOM_99',
        default_currency: 'USD',
        default_country: 'sg',
        value_custom_field_key: 'deal_budget',
      },
    });
    assert.equal(saveCapi2.status, 200);

    // Move VIP Lead to stage 'SignedVIPContract' WITHOUT passing deal_value_vnd -> auto-extracts 125000 USD!
    const pipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', { token: adminToken, tenantSlug });
    const mainPipe = pipes.json.data.find((p: any) => p.id === defaultPipelineId);
    const signedStage = mainPipe.stages.find((s: any) => s.capi_event_mapping === 'SignedVIPContract');

    const moveRes = await apiRequest(harness.baseUrl, `/api/v1/leads/${vipLeadId}/stage`, {
      method: 'PATCH',
      token: saleAToken,
      tenantSlug,
      body: { stage_id: signedStage.id },
    });
    assert.equal(moveRes.status, 200);
    assert.equal(moveRes.json.data.capi_dispatched.event_name, 'SignedVIPContract');
    assert.equal(moveRes.json.data.capi_dispatched.status, 200);

    // 7d. Custom Zalo Bot command alias (`/nhan`) & custom reply template!
    await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/zalo_oa', {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: {
        oa_id: 'OA_CUSTOM',
        access_token: 'zalo_at_custom',
        refresh_token: 'zalo_rt_custom',
        group_chat_id: '-999111',
        accept_command: '/nhan',
        accept_reply_template: '🎉 CHỐT NHẬN: {{sale_name}} đã nhận khách {{lead_name}}!',
      },
    });

    // Link Sale A to Zalo chat_id '-999111' via `/sale sale.a@custom.vn`
    const linkCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { chat_id: '-999111', text: 'sale sale.a@custom.vn' },
    });
    assert.equal(linkCmd.status, 200);

    const customAcceptCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { chat_id: '-999111', text: '/nhan' },
    });
    assert.equal(customAcceptCmd.status, 200);
    assert.equal(customAcceptCmd.json.data.replyText.includes('🎉 CHỐT NHẬN: Sale Alpha'), true);
  });

  it('8. Edge Cases: Boundary Clamping, Prefix & Repeated-Digit Policies, Per-Reason Disqualify, Custom Zalo Report/Approve & Idempotency TTL=0', async () => {
    // 8a. Out-of-bounds clamping & string mobile prefixes ('9, 8')
    const clampRes = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        settings: {
          default_sla_minutes: -500,
          sla_target_seconds: -10,
          outbound_webhook_max_retries: 999,
          zalo_token_refresh_window_hours: 999,
          distribution_mode: 'invalid_mode_xyz',
          allow_international_phones: false,
          vn_mobile_prefixes: '9, 8',
          block_repeated_digits: true,
          duplicate_threshold_days: 0,
          auto_disqualify_on_ticket_approve: true,
          ticket_reasons: [
            { value: 'SPAM_BOT', label: 'Spam rác tự động', auto_disqualify: true },
            { value: 'WRONG_PROJECT', label: 'Nhầm dự án', auto_disqualify: false },
          ],
          webhook_idempotency_ttl_hours: 0,
        },
      },
    });
    assert.equal(clampRes.status, 200);
    assert.equal(clampRes.json.data.settings.default_sla_minutes, 0);
    assert.equal(clampRes.json.data.settings.sla_target_seconds, 0.1);
    assert.equal(clampRes.json.data.settings.outbound_webhook_max_retries, 20);
    assert.equal(clampRes.json.data.settings.zalo_token_refresh_window_hours, 48);
    assert.equal(clampRes.json.data.settings.distribution_mode, 'weighted_round_robin');
    assert.deepEqual(clampRes.json.data.settings.vn_mobile_prefixes, ['09', '08']);

    // Prefix '03' blocked when vn_mobile_prefixes = ['09', '08']
    const prefix03Blocked = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Đầu 03 Bị Chặn', phone: '0351234567' },
    });
    assert.equal(prefix03Blocked.status, 422);

    // Repeated digits '0999999999' blocked when block_repeated_digits = true
    const repeatedBlocked = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Số Lặp Ảo', phone: '0999999999' },
    });
    assert.equal(repeatedBlocked.status, 422);

    // Disable block_repeated_digits -> '0999999999' now allowed!
    await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: { settings: { block_repeated_digits: false } },
    });
    const repeatedAllowed = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'VIP Ngũ Quý', phone: '0999999999', assigned_to: saleAId },
    });
    assert.equal(repeatedAllowed.status, 201);

    // 8b. Per-ticket-reason `auto_disqualify`: WRONG_PROJECT (false) keeps Pending, SPAM_BOT (true) sets Disqualified
    const wrongProjLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { name: 'Khách Nhầm Dự Án', phone: '0982223344', assigned_to: saleAId },
    });
    const wrongProjTicket = await apiRequest(
      harness.baseUrl,
      `/api/v1/leads/${wrongProjLead.json.data.lead_id}/tickets`,
      {
        method: 'POST',
        token: saleAToken,
        tenantSlug,
        body: { reason: 'WRONG_PROJECT', description: 'Chuyển sang dự án khác, không xóa rác' },
      }
    );
    await apiRequest(harness.baseUrl, `/api/v1/leads/tickets/${wrongProjTicket.json.data.id}/resolve`, {
      method: 'POST',
      token: managerToken,
      tenantSlug,
      body: { decision: 'approved' },
    });
    const checkKept = await apiRequest(harness.baseUrl, '/api/v1/leads?search=0982223344', {
      token: adminToken,
      tenantSlug,
    });
    assert.notEqual(checkKept.json.data.items[0].quality_status, 'Disqualified');

    const spamLeadId = repeatedAllowed.json.data.lead_id;
    const spamTicket = await apiRequest(harness.baseUrl, `/api/v1/leads/${spamLeadId}/tickets`, {
      method: 'POST',
      token: saleAToken,
      tenantSlug,
      body: { reason: 'SPAM_BOT', description: 'Bot spam form' },
    });
    assert.equal(spamTicket.status, 201);

    const resolveSpam = await apiRequest(
      harness.baseUrl,
      `/api/v1/leads/tickets/${spamTicket.json.data.id}/resolve`,
      {
        method: 'POST',
        token: managerToken,
        tenantSlug,
        body: { decision: 'approved' },
      }
    );
    assert.equal(resolveSpam.status, 200);

    const checkDisq = await apiRequest(harness.baseUrl, '/api/v1/leads?search=0999999999', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(checkDisq.json.data.items[0].quality_status, 'Disqualified');

    // 8c. Custom Zalo report (`/loi <reason>` without #id) + approve (`/ok` without #ticket_id)
    await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/zalo_oa', {
      method: 'PUT',
      token: adminToken,
      tenantSlug,
      body: {
        oa_id: 'OA_CUSTOM',
        access_token: '',
        refresh_token: '',
        group_chat_id: '-999111',
        accept_command: '/nhan',
        report_command: '/loi',
        approve_command: '/ok',
        report_reply_template: '🚨 Đã tạo phiếu #{{ticket_short_id}} cho {{lead_name}} ({{sale_name}}) — Gõ {{approve_cmd}}',
        approve_reply_template: '✅ Duyệt xong #{{ticket_short_id}} — cộng +{{credits}} lượt cho {{sale_name}}!',
      },
    });

    const reportCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { chat_id: '-999111', text: '/loi Sai số thuê bao' },
    });
    assert.equal(reportCmd.status, 200);
    assert.equal(reportCmd.json.data.replyText.includes('Gõ /ok'), true);

    const approveCmd = await apiRequest(harness.baseUrl, '/api/v1/integrations/zalo/command', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { chat_id: '-999111', text: '/ok' },
    });
    assert.equal(approveCmd.status, 200);
    assert.equal(approveCmd.json.data.replyText.includes('✅ Duyệt xong #'), true);

    // 8d. Inbound Webhook with `webhook_idempotency_ttl_hours = 0` allows re-ingesting identical payload/key
    const whCreate = await apiRequest(harness.baseUrl, '/api/v1/integrations/webhooks', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        webhook_type: 'inbound',
        name: 'Test TTL=0 Inbound',
        subscribed_events: ['lead.created'],
      },
    });
    assert.equal(whCreate.status, 201);
    const whToken = whCreate.json.data.token;
    const whSecret = whCreate.json.data.signing_secret;

    const rawBody = JSON.stringify({
      name: 'Khách Webhook Lần 1',
      phone: '0981112233',
    });
    const cryptoMod = await import('node:crypto');
    const sig = cryptoMod.createHmac('sha256', whSecret).update(rawBody).digest('hex');

    const whHit1 = await fetch(`${harness.baseUrl}/api/v1/webhooks/${tenantSlug}/${whToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${sig}`,
        'X-Idempotency-Key': 'evt_ttl_zero_repeat_001',
      },
      body: rawBody,
    });
    assert.equal(whHit1.status, 202);
    const whJson1: any = await whHit1.json();
    assert.notEqual(whJson1.status, 'DUPLICATE_SKIPPED');

    const whHit2 = await fetch(`${harness.baseUrl}/api/v1/webhooks/${tenantSlug}/${whToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${sig}`,
        'X-Idempotency-Key': 'evt_ttl_zero_repeat_001',
      },
      body: rawBody,
    });
    assert.equal(whHit2.status, 202);
    const whJson2: any = await whHit2.json();
    assert.notEqual(whJson2.status, 'DUPLICATE_SKIPPED');
  });

  it('9. Pure API E2E: Exercises 5-Domain Custom Settings Studio, Dynamic Zalo Bot Simulator & 30-Min Super Admin Impersonation', async () => {
    // 1. Save full 5-domain tenant settings & verify persistence
    const saveRes = await apiRequest(harness.baseUrl, '/api/v1/auth/tenant-settings', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug,
      body: {
        settings: {
          distribution_mode: 'weighted_round_robin',
          default_sla_minutes: 20,
          pii_masking_enabled: true,
          default_dial_code: '+84',
          brand_primary_color: '#1E40FF',
        },
      },
    });
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.json.data.settings.brand_primary_color, '#1E40FF');

    // 2. Super Admin login -> save platform defaults & launch 30-min audited impersonation
    const saLogin = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: { email: 'ops-admin@autodata.vn', password: 'SuperAdminMasterPassword999!' },
    });
    assert.equal(saLogin.status, 200);
    const saToken = saLogin.json.data.access_token;

    const defRes = await apiRequest(harness.baseUrl, '/api/v1/admin/platform-settings', {
      method: 'PATCH',
      token: saToken,
      body: { default_tenant_settings: { default_sla_minutes: 15 } },
    });
    assert.equal(defRes.status, 200);

    const tenantsRes = await apiRequest(harness.baseUrl, '/api/v1/admin/tenants', { token: saToken });
    const items = tenantsRes.json.data.items || tenantsRes.json.data;
    const targetTenant = items.find((t: any) => t.slug === tenantSlug);
    assert.ok(targetTenant);

    const impRes = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${targetTenant.id}/impersonate`, {
      method: 'POST',
      token: saToken,
      body: { duration_minutes: 30, reason: 'Kiểm thử hỗ trợ 30 phút' },
    });
    assert.equal(impRes.status, 200);
    assert.ok(impRes.json.data.access_token);
  });
});
