import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { HRM_APPROVALS_TENANT_TABLES } from '../server/modules/hrm/schema.ts';
import { DOM_AGENT_TOOLS_REGISTRY } from '../server/modules/dom-agent/index.ts';

describe('Stage 4A Full-Clone Suite: WorkChat (Mascot Gate + Vault + Chat-to-Task), HRM 360° Dossier/OrgChart/PublicSchedule, Payroll MyPayslips + CooperationSlips + Accounting A-Z, Deep Linked Approvals & DOM Agent 80-Tool SSE/Proposals', () => {
  let harness: TestHarness;

  let tenantA!: { id: string; slug: string; ownerId: string; ownerToken: string };
  let tenantB!: { id: string; slug: string; ownerId: string; ownerToken: string };

  let sale1!: { id: string; token: string };
  let sale2!: { id: string; token: string };
  let restrictedViewer!: { id: string; token: string };

  let branchAId = '';
  let deptAId = '';
  let empSale1Id = '';
  let periodId = '';
  let slipSale1Id = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Royal Sapphire Holdings',
        tenant_slug: 'royal-sapphire',
        admin_name: 'Phạm Hoàng Minh',
        work_email: 'ceo@royal-sapphire.vn',
        phone: '0903111222',
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
        company_name: 'Cobalt Ventures',
        tenant_slug: 'cobalt-ventures',
        admin_name: 'Đặng Thảo Vy',
        work_email: 'ceo@cobalt-ventures.vn',
        phone: '0904333444',
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

    // Upgrade both tenants to Package 4 (`domation_promax`, `education_addon: false`, default `enable_ideas_mascot: false`)
    for (const t of [tenantA, tenantB]) {
      const up = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
        method: 'POST',
        token: t.ownerToken,
        tenantSlug: t.slug,
        body: { package_code: 'domation_promax' },
      });
      assert.equal(up.status, 200);
    }

    const createMember = async (name: string, email: string, role: 'manager' | 'sale' | 'viewer') => {
      const cr = await apiRequest(harness.baseUrl, '/api/v1/users', {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: { full_name: name, email, password: 'MemberPassword123!', role },
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

    sale1 = await createMember('Nguyễn Quốc Huy', 'huy.sale@royal-sapphire.vn', 'manager');
    sale2 = await createMember('Lê Minh Châu', 'chau.sale@royal-sapphire.vn', 'manager');
    restrictedViewer = await createMember('Trần Khách Xem', 'viewer@royal-sapphire.vn', 'viewer');
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  it('1. WorkChat enforces Mascot Gate (9 general packs + 12 work badges active, ideas pack hidden/403), Media Vault, Chat-to-Task, Multi-Reaction Feed & PersonalAccount', async () => {
    const boot = await apiRequest(harness.baseUrl, '/api/v1/workchat/bootstrap', {
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.data.enable_ideas_mascot, false);
    assert.equal(boot.json.data.sticker_packs.length, 9, 'Must expose all 9 commercial sticker packs when enable_ideas_mascot=false');
    assert.ok(!boot.json.data.sticker_packs.some((p: any) => p.id === 'ideas'), 'Must hide ideas mascot pack by default');
    assert.equal(boot.json.data.work_status_badges.length, 12, 'Must expose all 12 corporate work-status badges');

    const channelId = boot.json.data.channels[0].id;

    // Sending 'ideas' mascot sticker while disabled MUST return 403 MASCOT_PACK_DISABLED
    const blockedMascot = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/channels/${channelId}/messages`,
      {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: {
          message_type: 'sticker',
          sticker_pack_id: 'ideas',
          sticker_id: 'ideas_1',
          content: '/stickers/ideas/ideas_1.webp',
        },
      }
    );
    assert.equal(blockedMascot.status, 403);
    assert.equal(blockedMascot.json?.error?.code, 'MASCOT_PACK_DISABLED');

    // Sending commercial pack ('ghost') + URL message succeeds
    const okMsg = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/channels/${channelId}/messages`,
      {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: {
          message_type: 'text',
          content: 'Chuẩn bị hồ sơ thầu Q4 tại https://portal.royal-sapphire.vn/proposal.pdf',
          attachments: [{ kind: 'file', title: 'Proposal_Q4.pdf', url: 'https://portal.royal-sapphire.vn/proposal.pdf' }],
        },
      }
    );
    assert.equal(okMsg.status, 201);
    const msgId = okMsg.json.data.id;

    // Convert chat message -> ERP Task (`POST /messages/:id/create-task`)
    const taskFromChat = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/messages/${msgId}/create-task`,
      {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: {
          title: 'Hoàn thiện hồ sơ thầu Q4 từ WorkChat',
          priority: 'high',
          assignee_user_id: sale1.id,
        },
      }
    );
    assert.equal(taskFromChat.status, 201);
    assert.equal(taskFromChat.json.data.title, 'Hoàn thiện hồ sơ thầu Q4 từ WorkChat');

    // Media Vault aggregates files, links, and task_card ERP cards
    const vaultRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/channels/${channelId}/vault`,
      {
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(vaultRes.status, 200);
    assert.ok(vaultRes.json.data.files.length >= 1);
    assert.ok(vaultRes.json.data.links.length >= 1);
    assert.ok(vaultRes.json.data.erp_cards.length >= 1);

    // Save channel wallpaper preference
    const wpRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/channels/${channelId}/wallpaper`,
      {
        method: 'PATCH',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: { wallpaper_key: 'sapphire_aurora' },
      }
    );
    assert.equal(wpRes.status, 200);
    assert.equal(wpRes.json.data.wallpaper_key, 'sapphire_aurora');

    // Enterprise Feed post + 6-type reaction (`rocket`)
    const feedPost = await apiRequest(harness.baseUrl, '/api/v1/workchat/feed', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Chúc mừng hoàn thành vượt 135% KPI Quý',
        content: 'Vinh danh toàn thể khối Kinh doanh B2B!',
        post_type: 'celebration',
        is_pinned: true,
      },
    });
    assert.equal(feedPost.status, 201);

    const reactRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/feed/${feedPost.json.data.id}/react`,
      {
        method: 'POST',
        token: sale1.token,
        tenantSlug: tenantA.slug,
        body: { reaction_type: 'rocket' },
      }
    );
    assert.equal(reactRes.status, 200);
    assert.equal(reactRes.json.data.user_reaction, 'rocket');
    assert.equal(reactRes.json.data.reactions_summary.rocket, 1);

    // Self-service PersonalAccount (`/my-account`) digital signature & profile update
    const updAcc = await apiRequest(harness.baseUrl, '/api/v1/workchat/my-account', {
      method: 'PUT',
      token: sale1.token,
      tenantSlug: tenantA.slug,
      body: {
        phone: '0918222333',
        signature_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      },
    });
    assert.equal(updAcc.status, 200);

    const getAcc = await apiRequest(harness.baseUrl, '/api/v1/workchat/my-account', {
      token: sale1.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(getAcc.status, 200);
    assert.equal(getAcc.json.data.user.phone, '0918222333');
    assert.ok(String(getAcc.json.data.user.signature_url).startsWith('data:image/png'));
  });

  it('2. HRM 360° Org Chart, Account Dossier & Unauthenticated Public Schedule work end-to-end', async () => {
    const brRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/branches', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        code: 'HQ_ROYAL',
        name: 'Trụ sở Royal Sapphire Quận 1',
        legal_entity_name: 'CÔNG TY CỔ PHẦN ROYAL SAPPHIRE HOLDINGS',
        tax_code: '0318889990',
        representative_name: 'Phạm Hoàng Minh',
        address: '100 Lê Duẩn, Quận 1, TP.HCM',
        is_headquarters: true,
      },
    });
    assert.equal(brRes.status, 201);
    branchAId = brRes.json.data.id;

    const deptRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        code: 'DEPT_ENTERPRISE',
        name: 'Khối Tư Vấn Doanh Nghiệp',
        branch_id: branchAId,
        manager_user_id: tenantA.ownerId,
      },
    });
    assert.equal(deptRes.status, 201);
    deptAId = deptRes.json.data.id;

    const empRes = await apiRequest(harness.baseUrl, '/api/v1/hrm/employees', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        user_id: sale1.id,
        employee_code: 'RS-001',
        full_name: 'Nguyễn Quốc Huy',
        work_email: 'huy.sale@royal-sapphire.vn',
        branch_id: branchAId,
        department_id: deptAId,
        manager_user_id: tenantA.ownerId,
        base_salary_vnd: 28_000_000,
        insurance_salary_vnd: 28_000_000,
        dependents_count: 1,
        tax_code: '8112233445',
        id_card_number: '079095001234',
        bank_name: 'Vietcombank',
        bank_account_number: '0071009988776',
      },
    });
    assert.equal(empRes.status, 201);
    empSale1Id = empRes.json.data.id;

    const orgChart = await apiRequest(harness.baseUrl, '/api/v1/hrm/org-chart', {
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(orgChart.status, 200);
    assert.equal(orgChart.json.data.total_employees, 1);
    assert.equal(orgChart.json.data.branches[0].departments[0].employees[0].employee_code, 'RS-001');

    const dossier = await apiRequest(harness.baseUrl, `/api/v1/hrm/employees/${empSale1Id}/dossier`, {
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(dossier.status, 200);
    assert.equal(dossier.json.data.employee.full_name, 'Nguyễn Quốc Huy');
    assert.equal(dossier.json.data.user_account.email, 'huy.sale@royal-sapphire.vn');

    // Create 1-on-1 booking link and verify Public Schedule unauthenticated endpoint
    const blRes = await apiRequest(harness.baseUrl, '/api/v1/hrm/booking-links', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        slug: 'royal-sapphire-consult',
        title: 'Tư vấn Kiến trúc Giải pháp 1-1',
        duration_minutes: 30,
      },
    });
    assert.equal(blRes.status, 201);

    const pubSched = await apiRequest(harness.baseUrl, '/api/v1/hrm/public-schedule/royal-sapphire-consult');
    assert.equal(pubSched.status, 200);
    assert.equal(pubSched.json.data.organization.name, 'Royal Sapphire Holdings');
    assert.ok(pubSched.json.data.events.length >= 1);
  });

  it('3. Payroll MyPayslips Signature/Dispute, Multi-Sale CooperationSlips (60/40 Split -> Commission Ledgers) & Accounting A-Z (TT200/TT133) work with zero hardcodes', async () => {
    // 1. Multi-Sale Cooperation Slip: reject != 100%, accept 60/40, sign by both, manager approve -> auto commission ledgers
    const badCoop = await apiRequest(harness.baseUrl, '/api/v1/payroll/cooperation-slips', {
      method: 'POST',
      token: sale1.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Phiếu sai tổng phần trăm',
        shareholders: [{ user_id: sale1.id, percentage: 70 }],
      },
    });
    assert.equal(badCoop.status, 422);

    const coopCreate = await apiRequest(harness.baseUrl, '/api/v1/payroll/cooperation-slips', {
      method: 'POST',
      token: sale1.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Hợp đồng Triển khai ERP Tập đoàn Á Châu',
        project_name: 'ERP Enterprise Rollout',
        unit_code: 'HD-ERP-2026-88',
        estimated_value_vnd: 500_000_000,
        expected_commission_vnd: 15_000_000,
        shareholders: [
          { user_id: sale1.id, percentage: 60 },
          { user_id: sale2.id, percentage: 40 },
        ],
      },
    });
    assert.equal(coopCreate.status, 201);
    const coopId = coopCreate.json.data.id;
    assert.equal(coopCreate.json.data.status, 'pending_signatures');

    // Sale 1 signs -> still pending_signatures (waiting for Sale 2)
    const s1Sign = await apiRequest(
      harness.baseUrl,
      `/api/v1/payroll/cooperation-slips/${coopId}/sign`,
      {
        method: 'POST',
        token: sale1.token,
        tenantSlug: tenantA.slug,
        body: { signature_data_url: 'data:image/png;base64,SALE1SIG==' },
      }
    );
    assert.equal(s1Sign.status, 200);
    assert.equal(s1Sign.json.data.status, 'pending_signatures');

    // Sale 2 signs -> all 100% shareholders signed -> auto-advances to `pending_manager_approval`
    const s2Sign = await apiRequest(
      harness.baseUrl,
      `/api/v1/payroll/cooperation-slips/${coopId}/sign`,
      {
        method: 'POST',
        token: sale2.token,
        tenantSlug: tenantA.slug,
        body: { signature_data_url: 'data:image/png;base64,SALE2SIG==' },
      }
    );
    assert.equal(s2Sign.status, 200);
    assert.equal(s2Sign.json.data.status, 'pending_manager_approval');

    // Manager approves for period 2026-11 -> creates 9,000,000 VND & 6,000,000 VND commission ledgers!
    const mgrApprove = await apiRequest(
      harness.baseUrl,
      `/api/v1/payroll/cooperation-slips/${coopId}/decide`,
      {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: { decision: 'approve', period_key: '2026-11', comment: 'Xác nhận doanh thu thực thu.' },
      }
    );
    assert.equal(mgrApprove.status, 200);
    assert.equal(mgrApprove.json.data.status, 'approved');

    // Generate Payroll for 2026-11 -> Sale 1 automatically receives 9,000,000 VND commission from the approved Cooperation Slip!
    const genRes = await apiRequest(harness.baseUrl, '/api/v1/payroll/periods/generate', {
      method: 'POST',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: { period_key: '2026-11' },
    });
    assert.equal(genRes.status, 201);
    periodId = genRes.json.data.period.id;
    slipSale1Id = genRes.json.data.slips[0].id;
    assert.equal(genRes.json.data.slips[0].commission_pay_vnd, 9_000_000);

    // Self-service MyPayslips: dynamic legal entity, digital signature & dispute
    const mySlips = await apiRequest(
      harness.baseUrl,
      '/api/v1/payroll/my-payslips?period_key=2026-11',
      {
        token: sale1.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(mySlips.status, 200);
    assert.equal(mySlips.json.data.legal_entity.legal_entity_name, 'CÔNG TY CỔ PHẦN ROYAL SAPPHIRE HOLDINGS');
    assert.equal(mySlips.json.data.legal_entity.tax_code, '0318889990');
    assert.doesNotMatch(JSON.stringify(mySlips.json), /IDEAS|0101234567/i);
    assert.equal(mySlips.json.data.payslip.id, slipSale1Id);

    const signSlip = await apiRequest(
      harness.baseUrl,
      `/api/v1/payroll/slips/${slipSale1Id}/sign`,
      {
        method: 'POST',
        token: sale1.token,
        tenantSlug: tenantA.slug,
        body: { signature_data_url: 'data:image/png;base64,PAYSLIPSIG==' },
      }
    );
    assert.equal(signSlip.status, 200);
    assert.equal(signSlip.json.data.signed_by_employee, true);

    const disputeSlip = await apiRequest(
      harness.baseUrl,
      `/api/v1/payroll/slips/${slipSale1Id}/dispute`,
      {
        method: 'POST',
        token: sale1.token,
        tenantSlug: tenantA.slug,
        body: { dispute_note: 'Đề nghị kiểm tra lại phụ cấp công tác ngoại tỉnh.' },
      }
    );
    assert.equal(disputeSlip.status, 200);
    assert.equal(disputeSlip.json.data.dispute_status, 'open');

    // Accounting A-Z Workspace: TT200 -> TT133 General Journal + zero hardcoded samples
    const azTt200 = await apiRequest(
      harness.baseUrl,
      '/api/v1/payroll/accounting-az?period_key=2026-11',
      {
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(azTt200.status, 200);
    assert.equal(azTt200.json.data.accounting_regime, 'TT200');
    assert.equal(azTt200.json.data.legal_entity.tax_code, '0318889990');
    assert.ok(azTt200.json.data.journal_entries.some((j: any) => j.debit_account === '6421' && j.credit_account === '3341'));
    assert.ok(azTt200.json.data.journal_entries.some((j: any) => j.debit_account === '3341' && j.credit_account === '3335'));

    const saveTt133 = await apiRequest(harness.baseUrl, '/api/v1/payroll/accounting-az', {
      method: 'PUT',
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
      body: {
        period_key: '2026-11',
        accounting_regime: 'TT133',
        custom_journal_entry: {
          debit_account: '6422',
          credit_account: '1121',
          amount_vnd: 2_500_000,
          description: 'Chi thưởng nóng đội dự án',
        },
      },
    });
    assert.equal(saveTt133.status, 200);
    assert.equal(saveTt133.json.data.accounting_regime, 'TT133');

    const azTt133 = await apiRequest(
      harness.baseUrl,
      '/api/v1/payroll/accounting-az?period_key=2026-11',
      {
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(azTt133.status, 200);
    assert.equal(azTt133.json.data.accounting_regime, 'TT133');
    assert.ok(azTt133.json.data.journal_entries.some((j: any) => j.debit_account === '6422' && j.entry_group === 'custom'));
  });

  it('4. Deep Entity-Linked Approvals (Leave Balance / Expense Preview, SLA Indicator & Batch Approve)', async () => {
    const wfs = await apiRequest(harness.baseUrl, '/api/v1/approvals/workflows', {
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(wfs.status, 200);
    const leaveWf = wfs.json.data.find((w: any) => w.category === 'leave');
    const expWf = wfs.json.data.find((w: any) => w.category === 'expense');
    assert.ok(leaveWf && expWf);

    const r1 = await apiRequest(harness.baseUrl, '/api/v1/approvals/requests', {
      method: 'POST',
      token: sale1.token,
      tenantSlug: tenantA.slug,
      body: {
        workflow_id: leaveWf.id,
        title: 'Xin nghỉ phép năm 2 ngày',
        start_date: '2026-11-24T00:00:00.000Z',
        end_date: '2026-11-25T00:00:00.000Z',
        form_data: { leave_type: 'Nghỉ phép năm (hưởng nguyên lương)', total_days: 2 },
      },
    });
    assert.equal(r1.status, 201);

    const r2 = await apiRequest(harness.baseUrl, '/api/v1/approvals/requests', {
      method: 'POST',
      token: sale1.token,
      tenantSlug: tenantA.slug,
      body: {
        workflow_id: expWf.id,
        title: 'Thanh toán chi phí tiếp khách đối tác',
        amount_vnd: 3_500_000,
        form_data: {
          expense_category: 'Công tác phí',
          has_vat_invoice: true,
          vat_amount_vnd: 350_000,
          items: [{ name: 'Hóa đơn hội nghị khách hàng', amount_vnd: 3_500_000 }],
        },
      },
    });
    assert.equal(r2.status, 201);

    // Inspect Deep Linked-Entity Preview & SLA status
    const det1 = await apiRequest(
      harness.baseUrl,
      `/api/v1/approvals/requests/${r1.json.data.id}`,
      {
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(det1.status, 200);
    assert.equal(det1.json.data.linked_preview.preview_type, 'leave_balance');
    assert.equal(det1.json.data.linked_preview.requested_days, 2);
    assert.equal(det1.json.data.sla_status.is_overdue, false);

    // Batch Approve both requests in 1 atomic transaction (`POST /requests/batch-decide`)
    const batchRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/approvals/requests/batch-decide',
      {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: {
          request_ids: [r1.json.data.id, r2.json.data.id],
          decision: 'approve',
          comment: 'Phê duyệt hàng loạt cuối ngày.',
        },
      }
    );
    assert.equal(batchRes.status, 200);
    assert.equal(batchRes.json.data.processed_count, 2);
  });

  it('5. DOM Agent exposes exact 80 RBAC tools, streams SSE events (`/chat/stream`), emits DynamicChart & enforces RBAC on `/proposals/execute`', async () => {
    assert.equal(DOM_AGENT_TOOLS_REGISTRY.length, 80);

    // Test SSE streaming endpoint (`POST /api/v1/dom-agent/chat/stream`)
    const sseResp = await fetch(`${harness.baseUrl}/api/v1/dom-agent/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantA.ownerToken}`,
        'X-Tenant-Slug': tenantA.slug,
      },
      body: JSON.stringify({
        specialist_key: 'hr_approvals',
        message: 'Xin nghỉ phép 1 ngày vào thứ Sáu tuần này và tính lương Gross 30000000',
      }),
    });
    assert.equal(sseResp.status, 200);
    assert.match(String(sseResp.headers.get('content-type')), /text\/event-stream/);
    const rawSse = await sseResp.text();
    assert.match(rawSse, /event: meta/);
    assert.match(rawSse, /event: delta/);
    assert.match(rawSse, /event: proposal/);
    assert.match(rawSse, /event: done/);

    // Authorized owner confirms ActionProposalCard -> creates real Approval Request
    const execOk = await apiRequest(
      harness.baseUrl,
      '/api/v1/dom-agent/proposals/execute',
      {
        method: 'POST',
        token: tenantA.ownerToken,
        tenantSlug: tenantA.slug,
        body: {
          action_type: 'leave',
          title: 'Đơn nghỉ phép xác nhận từ ActionProposalCard',
          params: { total_days: 1, reason: 'Xác nhận trên giao diện DOM Agent' },
        },
      }
    );
    assert.equal(execOk.status, 201);
    assert.equal(execOk.json.data.entity_type, 'approval_request');

    // Configure viewer role with view-only (create: false) on approvals -> `/proposals/execute` MUST block with 403 FORBIDDEN_RBAC_PERMISSION!
    const orgBoot = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/bootstrap', {
      token: tenantA.ownerToken,
      tenantSlug: tenantA.slug,
    });
    const viewerRole = orgBoot.json.data.roles.find((r: any) => r.role_key === 'viewer');
    if (viewerRole) {
      await apiRequest(
        harness.baseUrl,
        `/api/v1/org-rbac/roles/${viewerRole.id}/permissions`,
        {
          method: 'PUT',
          token: tenantA.ownerToken,
          tenantSlug: tenantA.slug,
          body: {
            permissions: [
              { module_key: 'leads', data_scope: 'own', actions: { view: true, create: false } },
              { module_key: 'approvals', data_scope: 'own', actions: { view: true, create: false } },
            ],
          },
        }
      );

      const execBlocked = await apiRequest(
        harness.baseUrl,
        '/api/v1/dom-agent/proposals/execute',
        {
          method: 'POST',
          token: restrictedViewer.token,
          tenantSlug: tenantA.slug,
          body: {
            action_type: 'leave',
            title: 'Viewer cố tình tạo đơn khi create=false',
            params: { total_days: 1 },
          },
        }
      );
      assert.equal(execBlocked.status, 403);
      assert.equal(execBlocked.json?.error?.code, 'FORBIDDEN_RBAC_PERMISSION');
    }
  });

  it('6. Kernel FORCE ROW LEVEL SECURITY guarantees 0 unscoped rows & 0 cross-tenant leaks across all 21 HRM/Payroll/Cooperation/AccountingAz tables', async () => {
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of HRM_APPROVALS_TENANT_TABLES) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped SELECT on ${tbl} MUST return 0 rows`);
      }
    });

    await withTenantTransaction(tenantB.id, async (client) => {
      for (const tbl of ['tenant_cooperation_slips', 'tenant_accounting_az_workspace']) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Tenant B must see 0 Tenant A rows in ${tbl}`);
      }
    });

    const bCoop = await apiRequest(harness.baseUrl, '/api/v1/payroll/cooperation-slips', {
      token: tenantB.ownerToken,
      tenantSlug: tenantB.slug,
    });
    assert.equal(bCoop.status, 200);
    assert.equal(bCoop.json.data.items.length, 0);
  });
});
