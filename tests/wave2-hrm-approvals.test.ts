import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { HRM_APPROVALS_TENANT_TABLES } from '../server/modules/hrm/schema.ts';

describe('Wave 2 Phase 3: Dynamic N-Step Approvals, HRM 360°, GPS Attendance, Payroll/HTKK & Zero-Leakage RLS', () => {
  let harness: TestHarness;

  let tenantA!: {
    id: string;
    slug: string;
    ownerId: string;
    ownerToken: string;
  };
  let tenantB!: {
    id: string;
    slug: string;
    ownerId: string;
    ownerToken: string;
  };

  // Org hierarchy users in Tenant A
  let branchDirector!: { id: string; token: string };
  let parentDeptHead!: { id: string; token: string };
  let deptHead!: { id: string; token: string };
  let delegateApprover!: { id: string; token: string };
  let requesterStaff!: { id: string; token: string };

  let branchAId = '';
  let parentDeptAId = '';
  let childDeptAId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    // Register Tenant A & Tenant B (initially on Package 1: autodata_crm)
    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Sapphire Enterprise Corp',
        tenant_slug: 'sapphire-corp',
        admin_name: 'Linh Tran',
        work_email: 'ceo@sapphire-corp.vn',
        phone: '0901000111',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      ownerId: regA.json.data.user.id,
      ownerToken: regA.json.data.access_token,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Emerald Retail Group',
        tenant_slug: 'emerald-group',
        admin_name: 'Minh Le',
        work_email: 'ceo@emerald-group.vn',
        phone: '0902000222',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      ownerId: regB.json.data.user.id,
      ownerToken: regB.json.data.access_token,
    };
  });

  after(async () => {
    await harness.close();
  });

  it('1. 4-Package Entitlement Gate blocks ERP HRM/Approvals/Attendance/Payroll on Package 1 & unlocks on DOMATION PROMAX', async () => {
    for (const path of [
      '/api/v1/approvals/workflows',
      '/api/v1/hrm/employees',
      '/api/v1/attendance/shifts',
      '/api/v1/payroll/config',
    ]) {
      const blocked = await apiRequest(harness.baseUrl, path, {
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
      });
      assert.equal(blocked.status, 403, `Expected 403 MODULE_NOT_ENTITLED on ${path} under autodata_crm`);
      assert.equal(blocked.json?.error?.code, 'MODULE_NOT_ENTITLED');
    }

    // Upgrade both Tenant A and Tenant B to Package 4 (`domation_promax`)
    const upA = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax' },
    });
    assert.equal(upA.status, 200);

    const upB = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantB.ownerToken,
      tenantSlug: tenantB.slug,
      body: { package_code: 'domation_promax' },
    });
    assert.equal(upB.status, 200);

    const unlocked = await apiRequest(harness.baseUrl, '/api/v1/approvals/workflows', {
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(unlocked.status, 200);
    assert.ok(Array.isArray(unlocked.json.data));
    assert.ok(unlocked.json.data.length >= 3, 'Default dynamic approval workflows seeded cleanly');
  });

  it('2. Dynamic N-Step Approval Engine resolves Dept Head -> Parent Dept Head -> Branch Director, Amount Thresholds & Out-of-Office Delegation', async () => {
    // Helper to create & login users in Tenant A
    const createMember = async (name: string, email: string, role: 'manager' | 'sale') => {
      const cr = await apiRequest(harness.baseUrl, '/api/v1/users', {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: {
          full_name: name,
          email,
          password: 'MemberPassword123!',
          role,
        },
      });
      assert.equal(cr.status, 201);
      const lg = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
        method: 'POST',
        tenantSlug: tenantA.slug,
        body: { email, password: 'MemberPassword123!' },
      });
      assert.equal(lg.status, 200);
      return { id: String(cr.json.data.id), token: String(lg.json.data.access_token) };
    };

    branchDirector = await createMember('Branch Director Khoa', 'director@sapphire-corp.vn', 'manager');
    parentDeptHead = await createMember('Division VP Lan', 'vp@sapphire-corp.vn', 'manager');
    deptHead = await createMember('Sales Dept Head Hung', 'head@sapphire-corp.vn', 'manager');
    delegateApprover = await createMember('Acting Manager Mai', 'delegate@sapphire-corp.vn', 'manager');
    requesterStaff = await createMember('Staff Specialist An', 'staff@sapphire-corp.vn', 'manager');

    // Create HQ Branch with GPS coordinates & assign Branch Director
    const brRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/branches', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        code: 'HQ_SGN',
        name: 'Trụ sở Quận 1 TP.HCM',
        legal_entity_name: 'CÔNG TY CỔ PHẦN SAPPHIRE ENTERPRISE',
        tax_code: '0319998887',
        representative_name: 'Trần Khánh Linh',
        address: '88 Nguyễn Huệ, Quận 1, TP.HCM',
        gps_lat: 10.7745,
        gps_lng: 106.7035,
        gps_radius_meters: 150,
        work_schedule: { director_user_id: branchDirector.id },
        is_headquarters: true,
      },
    });
    assert.equal(brRes.status, 201);
    branchAId = brRes.json.data.id;

    // Also set additive `manager_user_id` column on tenant_branches
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        'UPDATE tenant_branches SET manager_user_id = $2 WHERE tenant_id = $1 AND id = $3',
        [tenantA.id, branchDirector.id, branchAId]
      );
    });

    // Create Parent Department & Child Department
    const pDeptRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        code: 'DIV_COMMERCE',
        name: 'Khối Thương Mại',
        branch_id: branchAId,
        manager_user_id: parentDeptHead.id,
      },
    });
    assert.equal(pDeptRes.status, 201);
    parentDeptAId = pDeptRes.json.data.id;

    const cDeptRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        code: 'DEPT_B2B',
        name: 'Phòng Kinh Doanh B2B',
        branch_id: branchAId,
        parent_department_id: parentDeptAId,
        manager_user_id: deptHead.id,
      },
    });
    assert.equal(cDeptRes.status, 201);
    childDeptAId = cDeptRes.json.data.id;

    // Create HR Employee profile for requesterStaff linked to branch + childDept
    const empStaffRes = await apiRequest(harness.baseUrl, '/api/v1/hrm/employees', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        user_id: requesterStaff.id,
        employee_code: 'NV-B2B-01',
        full_name: 'Staff Specialist An',
        work_email: 'staff@sapphire-corp.vn',
        branch_id: branchAId,
        department_id: childDeptAId,
        manager_user_id: deptHead.id,
        base_salary_vnd: 25_000_000,
        dependents_count: 1,
        tax_code: '8001234567',
        allowances_json: { meal: 730_000, responsibility: 3_000_000 },
      },
    });
    assert.equal(empStaffRes.status, 201);

    // Build a custom 3-Step Dynamic Purchase Order Workflow with Amount Thresholds
    const wfRes = await apiRequest(harness.baseUrl, '/api/v1/approvals/workflows', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        code: 'WF_PO_3TIER',
        name: 'Phê duyệt Đơn mua hàng PO Đa cấp động',
        category: 'purchase_order',
        form_schema: [
          { key: 'vendor_name', label: 'Nhà cung cấp', type: 'text', required: true },
          { key: 'delivery_days', label: 'Thời gian giao hàng (ngày)', type: 'number', required: false },
        ],
        steps: [
          {
            step_order: 1,
            step_name: 'Trưởng phòng duyệt nhu cầu',
            approver_type: 'department_head',
            min_amount_threshold: 0,
            max_amount_threshold: null,
            approval_mode: 'any_one',
            fallback_strategy: 'escalate_parent_dept',
            sla_hours: 12,
          },
          {
            step_order: 2,
            step_name: 'Giám đốc Khối duyệt hạn mức trung',
            approver_type: 'parent_department_head',
            min_amount_threshold: 10_000_000,
            max_amount_threshold: null,
            approval_mode: 'any_one',
            fallback_strategy: 'tenant_admin',
            sla_hours: 24,
          },
          {
            step_order: 3,
            step_name: 'Giám đốc Chi nhánh duyệt ngân sách lớn',
            approver_type: 'branch_director',
            min_amount_threshold: 50_000_000,
            max_amount_threshold: null,
            approval_mode: 'any_one',
            fallback_strategy: 'tenant_admin',
            sla_hours: 48,
            require_signature: true,
          },
        ],
      },
    });
    assert.equal(wfRes.status, 201);
    const poWorkflowId = wfRes.json.data.id;

    // Case A: Small PO (4,000,000 VND < 10,000,000 VND) -> resolves ONLY 1 step (deptHead)
    const smallReq = await apiRequest(harness.baseUrl, '/api/v1/approvals/requests', {
      method: 'POST',
      token: requesterStaff.token,
      tenantSlug: tenantA.slug,
      body: {
        workflow_id: poWorkflowId,
        title: 'Mua văn phòng phẩm Q4',
        amount_vnd: 4_000_000,
        form_data: { vendor_name: 'Công ty VPP Thiên Long', delivery_days: 3 },
      },
    });
    assert.equal(smallReq.status, 201);
    assert.equal(smallReq.json.data.total_steps, 1, '4M VND request must dynamically filter down to 1 step');
    assert.equal(smallReq.json.data.step_logs[0].assigned_user_id, deptHead.id);

    // Configure Out-of-Office Delegation: `deptHead` delegates to `delegateApprover`
    const now = Date.now();
    const delRes = await apiRequest(harness.baseUrl, '/api/v1/approvals/delegations', {
      method: 'POST',
      token: deptHead.token,
      tenantSlug: tenantA.slug,
      body: {
        delegate_user_id: delegateApprover.id,
        categories: ['purchase_order'],
        valid_from: new Date(now - 3600_000).toISOString(),
        valid_until: new Date(now + 5 * 86400_000).toISOString(),
        reason: 'Đi công tác nước ngoài 5 ngày',
      },
    });
    assert.equal(delRes.status, 201);

    // Case B: Large PO (80,000,000 VND >= 50,000,000 VND) -> resolves ALL 3 steps, with Step 1 routed to `delegateApprover`!
    const largeReq = await apiRequest(harness.baseUrl, '/api/v1/approvals/requests', {
      method: 'POST',
      token: requesterStaff.token,
      tenantSlug: tenantA.slug,
      body: {
        workflow_id: poWorkflowId,
        title: 'Mua cụm máy chủ AI nội bộ',
        amount_vnd: 80_000_000,
        form_data: { vendor_name: 'Dell Enterprise VN', delivery_days: 14 },
      },
    });
    assert.equal(largeReq.status, 201);
    assert.equal(largeReq.json.data.total_steps, 3, '80M VND request must activate all 3 dynamic steps');

    const logs = largeReq.json.data.step_logs;
    assert.equal(logs.length, 3);
    assert.equal(logs[0].assigned_user_id, delegateApprover.id, 'Step 1 routed to delegateApprover via OOO delegation');
    assert.equal(logs[0].delegated_from_user_id, deptHead.id, 'Records original delegator user ID');
    assert.equal(logs[0].status, 'pending');
    assert.equal(logs[1].assigned_user_id, parentDeptHead.id, 'Step 2 resolved to parent_department_head');
    assert.equal(logs[1].status, 'waiting');
    assert.equal(logs[2].assigned_user_id, branchDirector.id, 'Step 3 resolved to branch_director');
    assert.equal(logs[2].status, 'waiting');

    const largeReqId = largeReq.json.data.id;

    // Verify delegateApprover sees it in My Pending To-Approve Inbox (`?view=inbox`)
    const delegateInbox = await apiRequest(harness.baseUrl, '/api/v1/approvals/requests?view=inbox', {
      token: delegateApprover.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(delegateInbox.status, 200);
    assert.ok(delegateInbox.json.data.some((r: any) => r.id === largeReqId));

    // Step 1 Approve by `delegateApprover` -> advances to Step 2
    const step1Act = await apiRequest(harness.baseUrl, `/api/v1/approvals/requests/${largeReqId}/decide`, {
      method: 'POST',
      token: delegateApprover.token,
      tenantSlug: tenantA.slug,
      body: { decision: 'approve', comment: 'Đã kiểm tra báo giá hợp lệ (duyệt thay Trưởng phòng).' },
    });
    assert.equal(step1Act.status, 200);
    assert.equal(step1Act.json.data.status, 'pending');
    assert.equal(step1Act.json.data.current_step_order, 2);

    // Step 2 Approve by `parentDeptHead` -> advances to Step 3
    const step2Act = await apiRequest(harness.baseUrl, `/api/v1/approvals/requests/${largeReqId}/decide`, {
      method: 'POST',
      token: parentDeptHead.token,
      tenantSlug: tenantA.slug,
      body: { decision: 'approve', comment: 'Khối Thương Mại đồng ý cấp ngân sách.' },
    });
    assert.equal(step2Act.status, 200);
    assert.equal(step2Act.json.data.status, 'pending');
    assert.equal(step2Act.json.data.current_step_order, 3);

    // Step 3 Approve by `branchDirector` with Digital Signature -> completes as `'approved'`!
    const step3Act = await apiRequest(harness.baseUrl, `/api/v1/approvals/requests/${largeReqId}/decide`, {
      method: 'POST',
      token: branchDirector.token,
      tenantSlug: tenantA.slug,
      body: {
        decision: 'approve',
        comment: 'Phê duyệt giải ngân.',
        signature_data_url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==',
      },
    });
    assert.equal(step3Act.status, 200);
    assert.equal(step3Act.json.data.status, 'approved');
    assert.ok(step3Act.json.data.completed_at);
  });

  it('3. HRM 360° Contracts, Signatures, Assets & Public Unauthenticated Smart 1-on-1 Booking work end-to-end', async () => {
    const empsRes = await apiRequest(harness.baseUrl, '/api/v1/hrm/employees', {
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(empsRes.status, 200);
    assert.ok(empsRes.json.data.length >= 1);
    const empId = empsRes.json.data[0].id;

    // Create labor contract + sign digitally
    const ctRes = await apiRequest(harness.baseUrl, '/api/v1/hrm/contracts', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        employee_id: empId,
        contract_number: 'HDLD-2026-001',
        contract_type: 'fixed_term',
        start_date: '2026-01-01',
        end_date: '2027-12-31',
        base_salary_vnd: 25_000_000,
        insurance_salary_vnd: 25_000_000,
      },
    });
    assert.equal(ctRes.status, 201);
    const signRes = await apiRequest(harness.baseUrl, `/api/v1/hrm/contracts/${ctRes.json.data.id}/sign`, {
      method: 'POST',
      token: requesterStaff.token,
      tenantSlug: tenantA.slug,
      body: {
        party: 'employee',
        signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    });
    assert.equal(signRes.status, 200);
    assert.equal(Boolean(signRes.json.data.signed_by_employee), true);

    // Handover laptop asset
    const assetRes = await apiRequest(harness.baseUrl, '/api/v1/hrm/assets', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        employee_id: empId,
        asset_name: 'MacBook Pro 14 M3 Pro',
        category: 'laptop',
        serial_number: 'SN-MBP-8899',
        asset_value_vnd: 48_000_000,
      },
    });
    assert.equal(assetRes.status, 201);

    // Create Smart 1-on-1 Booking Link
    const linkRes = await apiRequest(harness.baseUrl, '/api/v1/hrm/booking-links', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        slug: 'sapphire-executive-demo',
        title: 'Lịch tư vấn giải pháp B2B 1-1',
        duration_minutes: 30,
        buffer_minutes: 15,
        location_type: 'video_link',
        location_value: 'https://meet.example.com/sapphire-b2b',
        availability_rules: [
          { day_of_week: 1, start_time: '09:00', end_time: '12:00' },
          { day_of_week: 2, start_time: '09:00', end_time: '12:00' },
          { day_of_week: 3, start_time: '09:00', end_time: '12:00' },
          { day_of_week: 4, start_time: '09:00', end_time: '12:00' },
          { day_of_week: 5, start_time: '09:00', end_time: '12:00' },
        ],
      },
    });
    assert.equal(linkRes.status, 201);

    // Public UNAUTHENTICATED read (NO Bearer token, NO X-Tenant-Slug!)
    const pubGet = await apiRequest(
      harness.baseUrl,
      '/api/v1/hrm/public-booking/sapphire-executive-demo?from_date=2026-11-16'
    );
    assert.equal(pubGet.status, 200);
    assert.equal(pubGet.json.data.booking_link.title, 'Lịch tư vấn giải pháp B2B 1-1');
    assert.ok(pubGet.json.data.available_days.length >= 1);

    const targetDate = pubGet.json.data.available_days[0].date;
    const targetStart = pubGet.json.data.available_days[0].slots[0].start_time;

    // Public UNAUTHENTICATED slot booking
    const pubBook1 = await apiRequest(
      harness.baseUrl,
      '/api/v1/hrm/public-booking/sapphire-executive-demo/book',
      {
        method: 'POST',
        body: {
          guest_name: 'Hoàng Quốc Bảo',
          guest_email: 'bao.hoang@client.vn',
          guest_phone: '0988777666',
          guest_company: 'Công ty TNHH Minh Phát',
          booking_date: targetDate,
          start_time: targetStart,
          topic: 'Tư vấn triển khai ERP đa chi nhánh',
        },
      }
    );
    assert.equal(pubBook1.status, 201);
    assert.ok(pubBook1.json.data.ics_content.includes('BEGIN:VCALENDAR'));

    // Double-booking exact same slot must return 409 SLOT_ALREADY_BOOKED
    const pubBookConflict = await apiRequest(
      harness.baseUrl,
      '/api/v1/hrm/public-booking/sapphire-executive-demo/book',
      {
        method: 'POST',
        body: {
          guest_name: 'Khách Trùng Giờ',
          booking_date: targetDate,
          start_time: targetStart,
        },
      }
    );
    assert.equal(pubBookConflict.status, 409);
    assert.equal(pubBookConflict.json?.error?.code, 'SLOT_ALREADY_BOOKED');
  });

  it('4. Multi-Tier GPS + Selfie Check-In computes exact Haversine distance against tenant_branches (anti-spoofing server clock) & syncs Explanation with Approvals', async () => {
    // HQ Branch is at (10.7745, 106.7035) with radius 150m.
    // Check-in 1: Inside geofence (~35m away: 10.7747, 106.7037); server ignores spoofed client timestamps
    const inFence = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: requesterStaff.token,
      tenantSlug: tenantA.slug,
      body: {
        work_date: '2020-01-01', // ignored by server anti-spoofing
        timestamp: '2020-01-01T01:25:00.000Z', // ignored by server anti-spoofing
        latitude: 10.7747,
        longitude: 106.7037,
        accuracy_meters: 15,
        selfie_data_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        device_info: 'Chrome 131 Desktop WebRTC',
      },
    });
    assert.equal(inFence.status, 201);
    assert.notEqual(String(inFence.json.data.work_date).slice(0, 10), '2020-01-01', 'Server must ignore spoofed client work_date');
    assert.equal(inFence.json.data.within_geofence, true);
    assert.ok(inFence.json.data.distance_meters < 150, `Expected <150m, got ${inFence.json.data.distance_meters}`);

    // Check-out inside geofence (work_units computed server-side, never from client keep_full_unit)
    const outFence = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-out', {
      method: 'POST',
      token: requesterStaff.token,
      tenantSlug: tenantA.slug,
      body: {
        latitude: 10.7746,
        longitude: 106.7036,
        accuracy_meters: 15,
        keep_full_unit: true, // ignored by server anti-spoofing
      },
    });
    assert.equal(outFence.status, 200);
    assert.ok(typeof outFence.json.data.work_units === 'number');

    // Check-in 2 (under default flexible geofence mode): Outside geofence (~2.5km away: 10.7950, 106.7150) logs distance without blocking
    const outOfGeo = await apiRequest(harness.baseUrl, '/api/v1/attendance/check-in', {
      method: 'POST',
      token: requesterStaff.token,
      tenantSlug: tenantA.slug,
      body: {
        latitude: 10.7950,
        longitude: 106.7150,
        accuracy_meters: 20,
      },
    });
    assert.equal(outOfGeo.status, 201);
    assert.equal(outOfGeo.json.data.within_geofence, false);
    assert.ok(outOfGeo.json.data.distance_meters > 1500);
    assert.equal(outOfGeo.json.data.status, 'out_of_geofence');
    const serverWorkDate = String(outOfGeo.json.data.work_date).slice(0, 10);

    // Submit Attendance Explanation -> automatically creates linked Approval Request
    const expRes = await apiRequest(harness.baseUrl, '/api/v1/attendance/explanations', {
      method: 'POST',
      token: requesterStaff.token,
      tenantSlug: tenantA.slug,
      body: {
        work_date: serverWorkDate,
        explanation_type: 'business_trip',
        requested_work_units: 1,
        reason: 'Đi họp trực tiếp tại văn phòng khách hàng Quận Bình Thạnh',
      },
    });
    assert.equal(expRes.status, 201);
    assert.ok(expRes.json.data.approval_request_id, 'Explanation linked to dynamic Approval Request');

    // Review explanation -> updates log status to `'explained'` and clears `late_minutes`
    const revRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/attendance/explanations/${expRes.json.data.id}/review`,
      {
        method: 'POST',
        token: deptHead.token,
        tenantSlug: tenantA.slug,
        body: { status: 'approved', review_comment: 'Xác nhận lịch gặp khách hàng.' },
      }
    );
    assert.equal(revRes.status, 200);
    assert.equal(revRes.json.data.status, 'approved');
  });

  it('5. Dynamic Payroll Engine computes Progressive PIT, BHXH Caps, Commissions, Gross<->Net Inversion & valid HTKK XML / CSV', async () => {
    // Verify Gross <-> Net Simulator bidirectional consistency
    const simG2N = await apiRequest(harness.baseUrl, '/api/v1/payroll/simulate', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        mode: 'gross_to_net',
        amount_vnd: 30_000_000,
        dependents_count: 1,
      },
    });
    assert.equal(simG2N.status, 200);
    const computedNet = simG2N.json.data.net_pay_vnd;
    // Manual check for 30,000,000 VND Gross, 1 dependent under default VN statutory config:
    // Insurance base = 30M (<= 46.8M cap) -> emp BHXH 8% (2.4M) + BHYT 1.5% (450k) + BHTN 1% (300k) = 3,150,000
    // Deductions = 11,000,000 + 4,400,000 = 15,400,000
    // Assessable income = 30,000,000 - 3,150,000 - 15,400,000 = 11,450,000
    // Progressive PIT:
    //   0..5M @ 5% = 250,000
    //   5M..10M @ 10% = 500,000
    //   10M..11.45M (1.45M) @ 15% = 217,500
    //   Total PIT = 967,500
    // Net = 30,000,000 - 3,150,000 - 967,500 = 25,882,500
    assert.equal(simG2N.json.data.emp_insurance_total_vnd, 3_150_000);
    assert.equal(simG2N.json.data.assessable_income_vnd, 11_450_000);
    assert.equal(simG2N.json.data.pit_tax_vnd, 967_500);
    assert.equal(computedNet, 25_882_500);

    // Invert Net (25,882,500) -> Gross must recover 30,000,000!
    const simN2G = await apiRequest(harness.baseUrl, '/api/v1/payroll/simulate', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        mode: 'net_to_gross',
        amount_vnd: computedNet,
        dependents_count: 1,
      },
    });
    assert.equal(simN2G.status, 200);
    assert.ok(Math.abs(simN2G.json.data.gross_pay_vnd - 30_000_000) <= 2);

    // Create Commission Ledger for requesterStaff in 2026-11
    const commRes = await apiRequest(harness.baseUrl, '/api/v1/payroll/commissions', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        period_key: '2026-11',
        user_id: requesterStaff.id,
        source_title: 'Hoa hồng hợp đồng B2B Enterprise',
        revenue_base_vnd: 200_000_000,
        commission_amount_vnd: 6_000_000,
      },
    });
    assert.equal(commRes.status, 201);

    // Generate Payroll Period for 2026-11
    const genRes = await apiRequest(harness.baseUrl, '/api/v1/payroll/periods/generate', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: { period_key: '2026-11' },
    });
    assert.equal(genRes.status, 201);
    assert.equal(genRes.json.data.period.period_key, '2026-11');
    assert.equal(genRes.json.data.slips.length, 1);
    assert.equal(genRes.json.data.slips[0].commission_pay_vnd, 6_000_000);
    const periodId = genRes.json.data.period.id;

    // Export HTKK 05/KK-TNCN XML & verify legal entity + tax code + statutory tags
    const xmlRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/payroll/periods/${periodId}/export-htkk-xml`,
      {
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(xmlRes.status, 200);
    const xmlStr: string = xmlRes.json.data.xml_content;
    assert.ok(xmlStr.includes('<maTKhai>864</maTKhai>'));
    assert.ok(xmlStr.includes('<mst>0319998887</mst>'));
    assert.ok(xmlStr.includes('<tenNNT>CÔNG TY CỔ PHẦN SAPPHIRE ENTERPRISE</tenNNT>'));
    assert.ok(xmlStr.includes('<ct16>1</ct16>'));

    // Export Payroll CSV
    const csvRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/payroll/periods/${periodId}/export-csv`,
      {
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.json.data.csv_content.includes('NV-B2B-01'));
  });

  it('6. Kernel FORCE ROW LEVEL SECURITY blocks unscoped queries & cross-tenant access across ALL 19 HRM/Approvals/Attendance/Payroll tables', async () => {
    // Lemma 1: Unscoped queries without app.current_tenant_id return 0 rows on every single table
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of HRM_APPROVALS_TENANT_TABLES) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped query on ${tbl} MUST return 0 rows`);
      }
    });

    // Lemma 2: Tenant B sees 0 rows of Tenant A across all 4 module APIs and raw SQL inside withTenantTransaction(tenantB.id)
    await withTenantTransaction(tenantB.id, async (client) => {
      for (const tbl of [
        'tenant_approval_requests',
        'tenant_hr_employees',
        'tenant_hr_contracts',
        'tenant_booking_links',
        'tenant_hr_attendance_logs',
        'tenant_payroll_periods',
        'tenant_payroll_slips',
      ]) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Tenant B must see 0 Tenant A rows in ${tbl}`);
      }
    });

    const bEmps = await apiRequest(harness.baseUrl, '/api/v1/hrm/employees', {
      token: tenantB.ownerToken,
      tenantSlug: tenantB.slug,
    });
    assert.equal(bEmps.status, 200);
    assert.equal(bEmps.json.data.length, 0);

    const bPeriods = await apiRequest(harness.baseUrl, '/api/v1/payroll/periods', {
      token: tenantB.ownerToken,
      tenantSlug: tenantB.slug,
    });
    assert.equal(bPeriods.status, 200);
    assert.equal(bPeriods.json.data.length, 0);
  });
});
