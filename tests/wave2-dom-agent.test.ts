import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { DOM_AGENT_TABLES, DOM_AGENT_TOOLS_REGISTRY } from '../server/modules/dom-agent/index.ts';

describe('Wave 2 Phase 5: Multi-Tenant DOM Agent, 72 RBAC Tools, Department-ACL RAG & Zero RLS Leakage', () => {
  let harness: TestHarness;
  let alpha: { id: string; slug: string; token: string; ownerId: string };
  let beta: { id: string; slug: string; token: string; ownerId: string };

  let hrDeptId = '';
  let salesDeptId = '';
  let saleRoleId = '';

  let saleA: { id: string; token: string };
  let saleB: { id: string; token: string };
  let hrStaff: { id: string; token: string };

  let alphaHrSecretDocId = '';
  let alphaThreadId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regAlpha = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Sapphire Enterprise Corp',
        tenant_slug: 'sapphire-corp',
        admin_name: 'Minh Khôi Owner',
        work_email: 'owner@sapphire-corp.vn',
        phone: '0901112233',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regAlpha.status, 201);
    alpha = {
      id: regAlpha.json.data.tenant.id,
      slug: regAlpha.json.data.tenant.slug,
      token: regAlpha.json.data.access_token,
      ownerId: regAlpha.json.data.user.id,
    };

    const regBeta = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Emerald Retail Group',
        tenant_slug: 'emerald-retail',
        admin_name: 'Lan Anh Owner',
        work_email: 'owner@emerald-retail.vn',
        phone: '0902223344',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regBeta.status, 201);
    beta = {
      id: regBeta.json.data.tenant.id,
      slug: regBeta.json.data.tenant.slug,
      token: regBeta.json.data.access_token,
      ownerId: regBeta.json.data.user.id,
    };
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  it('1. Registers 80 categorized tools across all 5 ecosystem groups with zero legacy branding leaks', async () => {
    assert.equal(
      DOM_AGENT_TOOLS_REGISTRY.length,
      80,
      `Expected exact 80 tools, got ${DOM_AGENT_TOOLS_REGISTRY.length}`
    );

    const groupCounts = new Map<string, number>();
    for (const tool of DOM_AGENT_TOOLS_REGISTRY) {
      groupCounts.set(tool.group, (groupCounts.get(tool.group) || 0) + 1);
      const combined = `${tool.name} ${tool.title} ${tool.description}`;
      assert.doesNotMatch(combined, /SI Agent|SI IDEAS|@ideas\.edu\.vn/i);
    }

    assert.equal(groupCounts.get('crm_autodata'), 16);
    assert.equal(groupCounts.get('marketing_audiences'), 17);
    assert.equal(groupCounts.get('org_rbac_rag'), 10);
    assert.equal(groupCounts.get('hrm_payroll'), 15);
    assert.equal(groupCounts.get('erp_ops_finance'), 22);

    const boot = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/bootstrap', {
      token: alpha.token,
      tenantSlug: alpha.slug,
    });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.data.config.agent_name, 'DOM Agent');
    assert.equal(boot.json.data.config.avatar_url, '/imgs/autodata/ICON.png');
    assert.equal(boot.json.data.tools.length, 80);
    assert.equal(boot.json.data.package_code, 'autodata_crm');
  });

  it('2. Enforces strict Package Entitlement Lock on Gói 1 (autodata_crm) vs Gói 4 (domation_promax) + education_addon & logs audit trail', async () => {
    // On default Gói 1 (`autodata_crm`): CRM tools succeed, Marketing/HRM/Finance tools are locked (403 MODULE_NOT_ENTITLED)
    const crmAllowed = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'crm_round_robin_queue_status', args: {} },
    });
    assert.equal(crmAllowed.status, 200);
    assert.equal(crmAllowed.json.data.allowed, true);

    const mktDenied = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'mkt_list_audiences', args: {} },
    });
    assert.equal(mktDenied.status, 403);
    assert.equal(mktDenied.json.error.code, 'MODULE_NOT_ENTITLED');
    assert.equal(mktDenied.json.data.allowed, false);
    assert.ok(mktDenied.json.data.upgrade_hint);

    const financeDenied = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'ops_cashflow_pnl_summary', args: {} },
    });
    assert.equal(financeDenied.status, 403);
    assert.equal(financeDenied.json.error.code, 'MODULE_NOT_ENTITLED');

    // Gói 4 specialist (`executive_bi`) is also blocked on Gói 1
    const promaxSpecBlocked = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/chat', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { specialist_key: 'executive_bi', message: 'Tổng hợp KPI toàn công ty' },
    });
    assert.equal(promaxSpecBlocked.status, 403);
    assert.equal(promaxSpecBlocked.json.error.code, 'SPECIALIST_NOT_ENTITLED');

    // Verify `tenant_ai_tool_audit_logs` persisted `allowed = false` denials!
    const auditsPkg1 = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/audit-logs', {
      token: alpha.token,
      tenantSlug: alpha.slug,
    });
    assert.equal(auditsPkg1.status, 200);
    const deniedAud = auditsPkg1.json.data.find(
      (a: Record<string, unknown>) => a.tool_name === 'mkt_list_audiences' && a.allowed === false
    );
    assert.ok(deniedAud, 'Denied package entitlement execution must be recorded in tenant_ai_tool_audit_logs');

    // Fund Alpha wallet and upgrade Alpha to Gói 4 (`domation_promax`, `education_addon: false`) -> Marketing, HRM & Finance unlock immediately!
    await withTenantTransaction(alpha.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 10000000 WHERE id = $1', [alpha.id]);
    });
    const swPromax = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(swPromax.status, 200);

    const mktUnlocked = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'mkt_list_audiences', args: {} },
    });
    assert.equal(mktUnlocked.status, 200);
    assert.equal(mktUnlocked.json.data.allowed, true);

    const pitCalc = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'hrm_pit_bhxh_calculator', args: { gross_salary_vnd: 30_000_000, dependents_count: 1 } },
    });
    assert.equal(pitCalc.status, 200);
    assert.ok(Number(pitCalc.json.data.output.net_salary_vnd) > 0);

    // Education tool remains locked while `education_addon = false`
    const eduLocked = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'edu_class_schedule_lookup', args: {} },
    });
    assert.equal(eduLocked.status, 403);
    assert.equal(eduLocked.json.error.code, 'MODULE_NOT_ENTITLED');

    // Enable `education_addon = true` -> Education tool unlocks immediately!
    await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { package_code: 'domation_promax', education_addon: true },
    });
    const eduUnlocked = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'edu_class_schedule_lookup', args: {} },
    });
    assert.equal(eduUnlocked.status, 200);
    assert.equal(eduUnlocked.json.data.allowed, true);
  });

  it('3. Enforces Granular RBAC `own` scope + `unmask_phone=false` Server PII Masking inside tool output and chat', async () => {
    // Bootstrap Org & RBAC in Alpha
    const orgBoot = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/bootstrap', {
      token: alpha.token,
      tenantSlug: alpha.slug,
    });
    assert.equal(orgBoot.status, 200);
    const saleRole = orgBoot.json.data.roles.find((r: Record<string, unknown>) => r.role_key === 'sale');
    assert.ok(saleRole);
    saleRoleId = saleRole.id;

    // Create Sales Department & HR Department
    const salesDeptRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { name: 'Phòng Kinh Doanh Sàn 1' },
    });
    assert.equal(salesDeptRes.status, 201);
    salesDeptId = salesDeptRes.json.data.id;

    const hrDeptRes = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { name: 'Phòng Hành Chính Nhân Sự' },
    });
    assert.equal(hrDeptRes.status, 201);
    hrDeptId = hrDeptRes.json.data.id;

    // Configure `sale` role: `data_scope: 'own'`, `unmask_phone: false` on `leads` & `sale_portal`
    const setSalePerms = await apiRequest(
      harness.baseUrl,
      `/api/v1/org-rbac/roles/${saleRoleId}/permissions`,
      {
        method: 'PUT',
        token: alpha.token,
        tenantSlug: alpha.slug,
        body: {
          permissions: [
            {
              module_key: 'leads',
              data_scope: 'own',
              actions: { view: true, create: false, edit: true, unmask_phone: false },
            },
            {
              module_key: 'sale_portal',
              data_scope: 'own',
              actions: { view: true, unmask_phone: false },
            },
            {
              module_key: 'dom_sales_copilot',
              data_scope: 'own',
              actions: { view: true, unmask_phone: false },
            },
          ],
        },
      }
    );
    assert.equal(setSalePerms.status, 200);

    // Create Sale A (in Sales Dept), Sale B (in Sales Dept), and HR Staff (in HR Dept)
    const uSaleA = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {
        full_name: 'Sale An',
        email: 'an.sale@sapphire-corp.vn',
        password: 'SalePassword123!',
        role: 'sale',
        department_id: salesDeptId,
      },
    });
    assert.equal(uSaleA.status, 201);

    const uSaleB = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {
        full_name: 'Sale Bình',
        email: 'binh.sale@sapphire-corp.vn',
        password: 'SalePassword123!',
        role: 'sale',
        department_id: salesDeptId,
      },
    });
    assert.equal(uSaleB.status, 201);

    const uHr = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {
        full_name: 'Chuyên viên Nhân sự Hà',
        email: 'ha.hr@sapphire-corp.vn',
        password: 'HrPassword123!',
        role: 'manager',
        department_id: hrDeptId,
      },
    });
    assert.equal(uHr.status, 201);

    // Ensure department_id is bound on users table explicitly
    await withTenantTransaction(alpha.id, async (client) => {
      await client.query('UPDATE users SET department_id = $2 WHERE tenant_id = $1 AND id = $3', [
        alpha.id,
        salesDeptId,
        uSaleA.json.data.id,
      ]);
      await client.query('UPDATE users SET department_id = $2 WHERE tenant_id = $1 AND id = $3', [
        alpha.id,
        salesDeptId,
        uSaleB.json.data.id,
      ]);
      await client.query('UPDATE users SET department_id = $2 WHERE tenant_id = $1 AND id = $3', [
        alpha.id,
        hrDeptId,
        uHr.json.data.id,
      ]);

      // Seed 1 lead assigned to Sale A and 1 lead assigned to Sale B
      const pipeRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 LIMIT 1',
        [alpha.id]
      );
      const stRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY stage_order ASC LIMIT 1',
        [alpha.id, pipeRes.rows[0].id]
      );
      await client.query(
        `INSERT INTO leads (id, tenant_id, pipeline_id, stage_id, assigned_to, status, name, phone, email, lead_score, is_accepted)
         VALUES ($1, $2, $3, $4, $5, 'assigned', 'Trần Quốc Bảo', '0912345678', 'bao.vip@gmail.com', 88, true)`,
        [crypto.randomUUID(), alpha.id, pipeRes.rows[0].id, stRes.rows[0].id, uSaleA.json.data.id]
      );
      await client.query(
        `INSERT INTO leads (id, tenant_id, pipeline_id, stage_id, assigned_to, status, name, phone, email, lead_score, is_accepted)
         VALUES ($1, $2, $3, $4, $5, 'assigned', 'Lê Thu Trang', '0988776655', 'trang.other@gmail.com', 92, true)`,
        [crypto.randomUUID(), alpha.id, pipeRes.rows[0].id, stRes.rows[0].id, uSaleB.json.data.id]
      );
    });

    const loginSaleA = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: alpha.slug,
      body: { tenant_slug: alpha.slug, email: 'an.sale@sapphire-corp.vn', password: 'SalePassword123!' },
    });
    assert.equal(loginSaleA.status, 200);
    saleA = { id: uSaleA.json.data.id, token: loginSaleA.json.data.access_token };

    const loginSaleB = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: alpha.slug,
      body: { tenant_slug: alpha.slug, email: 'binh.sale@sapphire-corp.vn', password: 'SalePassword123!' },
    });
    assert.equal(loginSaleB.status, 200);
    saleB = { id: uSaleB.json.data.id, token: loginSaleB.json.data.access_token };

    const loginHr = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: alpha.slug,
      body: { tenant_slug: alpha.slug, email: 'ha.hr@sapphire-corp.vn', password: 'HrPassword123!' },
    });
    assert.equal(loginHr.status, 200);
    hrStaff = { id: uHr.json.data.id, token: loginHr.json.data.access_token };

    // Sale A executes `crm_search_leads`: MUST ONLY see 'Trần Quốc Bảo' (`own` scope), NEVER 'Lê Thu Trang', AND phone/email MUST be server-masked!
    const saleASearch = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: saleA.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'crm_search_leads', args: {} },
    });
    assert.equal(saleASearch.status, 200);
    assert.equal(saleASearch.json.data.effective_scope, 'own');
    assert.equal(saleASearch.json.data.pii_masked, true);
    const items = saleASearch.json.data.output.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1, 'Sale A with own scope must only see 1 assigned lead');
    assert.equal(items[0].name, 'Trần Quốc Bảo');
    assert.equal(items[0].phone, '0912***678', 'Phone must be server-masked when unmask_phone=false');
    assert.equal(items[0].email, 'ba***@gmail.com', 'Email must be server-masked when unmask_phone=false');
    assert.doesNotMatch(JSON.stringify(saleASearch.json), /0912345678|bao\.vip@gmail\.com|0988776655/);

    // Sale A asks DOM Agent via Chat -> assistant response also enforces `own` scope & PII masking
    const saleAChat = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/chat', {
      method: 'POST',
      token: saleA.token,
      tenantSlug: alpha.slug,
      body: { specialist_key: 'crm_sales', message: 'Tìm kiếm danh sách khách hàng của tôi' },
    });
    assert.equal(saleAChat.status, 200);
    assert.doesNotMatch(JSON.stringify(saleAChat.json), /0912345678|bao\.vip@gmail\.com|Lê Thu Trang/);

    // Sale A attempts `ops_cashflow_pnl_summary` (`finance` / `view_financials`) -> blocked by RBAC (`403 FORBIDDEN_RBAC_PERMISSION`)
    const saleAFinanceDenied = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/tools/execute', {
      method: 'POST',
      token: saleA.token,
      tenantSlug: alpha.slug,
      body: { tool_name: 'ops_cashflow_pnl_summary', args: {} },
    });
    assert.equal(saleAFinanceDenied.status, 403);
    assert.equal(saleAFinanceDenied.json.error.code, 'FORBIDDEN_RBAC_PERMISSION');
    assert.equal(saleAFinanceDenied.json.data.allowed, false);
  });

  it('4. Enforces Department-ACL RAG Isolation, Policy Sync & White-Label Persona Config', async () => {
    // Create headquarters branch + Wave 1 Policy Document and sync into DOM Agent RAG
    await apiRequest(harness.baseUrl, '/api/v1/org-rbac/branches', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {
        name: 'Trụ sở Quận 1',
        legal_entity_name: 'CÔNG TY CỔ PHẦN SAPPHIRE ENTERPRISE',
        tax_code: '0319998888',
        representative_name: 'Nguyễn Minh Khôi',
        is_headquarters: true,
      },
    });

    const createPol = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/policy-documents', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {
        title: 'Quy định Bảo hành & Chăm sóc Khách hàng Toàn công ty',
        doc_category: 'warranty_return',
        content_html: '<p>Pháp nhân {{company.legal_name}} (MST: {{company.tax_code}}) cam kết phản hồi bảo hành trong 4 giờ làm việc (MA_CHINH_SACH_CHUNG_247).</p>',
        allowed_department_ids: [],
      },
    });
    assert.equal(createPol.status, 201);

    const syncRes = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/knowledge/sync-policies', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {},
    });
    assert.equal(syncRes.status, 200);
    assert.ok(syncRes.json.data.synced_count >= 1);

    // Create HR-restricted RAG knowledge doc (`allowed_department_ids: [hrDeptId]`)
    const hrDocRes = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/knowledge', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {
        title: 'Khung Thưởng Nội Bộ Ban Nhân Sự',
        category: 'hr_confidential',
        content_text: 'Quy chế mật chỉ dành riêng cho Phòng Hành Chính Nhân Sự: hệ số thưởng đặc biệt MA_MAT_NHAN_SU_9000.',
        allowed_department_ids: [hrDeptId],
      },
    });
    assert.equal(hrDocRes.status, 201);
    alphaHrSecretDocId = hrDocRes.json.data.id;

    // Sale A (in `salesDeptId`) queries RAG for `MA_MAT_NHAN_SU_9000` -> MUST return 0 citations!
    const saleARagSecret = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/knowledge/query', {
      method: 'POST',
      token: saleA.token,
      tenantSlug: alpha.slug,
      body: { query: 'MA_MAT_NHAN_SU_9000 thưởng đặc biệt' },
    });
    assert.equal(saleARagSecret.status, 200);
    assert.equal(saleARagSecret.json.data.citations.length, 0, 'Sales user must NOT retrieve HR-restricted RAG doc');
    assert.ok(saleARagSecret.json.data.filtered_by_department_acl >= 1);

    // Sale A queries company-wide synced policy `MA_CHINH_SACH_CHUNG_247` -> succeeds with rendered legal entity name!
    const saleARagPublic = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/knowledge/query', {
      method: 'POST',
      token: saleA.token,
      tenantSlug: alpha.slug,
      body: { query: 'MA_CHINH_SACH_CHUNG_247 bảo hành' },
    });
    assert.equal(saleARagPublic.status, 200);
    assert.ok(saleARagPublic.json.data.citations.length >= 1);
    assert.match(saleARagPublic.json.data.citations[0].snippet, /CÔNG TY CỔ PHẦN SAPPHIRE ENTERPRISE/);

    // HR Staff (in `hrDeptId`) queries `MA_MAT_NHAN_SU_9000` -> retrieves HR-restricted citation!
    const hrRagSecret = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/knowledge/query', {
      method: 'POST',
      token: hrStaff.token,
      tenantSlug: alpha.slug,
      body: { query: 'MA_MAT_NHAN_SU_9000' },
    });
    assert.equal(hrRagSecret.status, 200);
    assert.ok(hrRagSecret.json.data.citations.length >= 1);
    assert.match(hrRagSecret.json.data.citations[0].snippet, /MA_MAT_NHAN_SU_9000/);

    // Update White-Label Persona + BYOK Vault Key & generate Morning Executive Briefing
    const updateCfg = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/config', {
      method: 'PUT',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: {
        agent_name: 'Sapphire Executive AI',
        persona_tone: 'analytical_precise',
        gemini_api_key: 'AIzaSyTestVaultKey9988776655',
      },
    });
    assert.equal(updateCfg.status, 200);
    assert.equal(updateCfg.json.data.agent_name, 'Sapphire Executive AI');
    assert.equal(updateCfg.json.data.has_byok_gemini, true);
    assert.doesNotMatch(JSON.stringify(updateCfg.json), /AIzaSyTestVaultKey9988776655/);

    const ownerChat = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/chat', {
      method: 'POST',
      token: alpha.token,
      tenantSlug: alpha.slug,
      body: { specialist_key: 'orchestrator', message: 'Cho tôi biết quy định MA_CHINH_SACH_CHUNG_247' },
    });
    assert.equal(ownerChat.status, 200);
    alphaThreadId = ownerChat.json.data.thread.id;
    assert.ok(ownerChat.json.data.citations.length >= 1);

    const briefing = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/briefing', {
      token: alpha.token,
      tenantSlug: alpha.slug,
    });
    assert.equal(briefing.status, 200);
    assert.equal(briefing.json.data.agent_name, 'Sapphire Executive AI');
    assert.ok(Array.isArray(briefing.json.data.sections));
  });

  it('5. Proves Kernel FORCE ROW LEVEL SECURITY & Zero Cross-Tenant Leakage (Tenant Alpha vs Tenant Beta)', async () => {
    // Lemma 1: Unscoped connection (`app.current_tenant_id = ''` under `autodata_app`) MUST return 0 rows on all 6 tables
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of DOM_AGENT_TABLES) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped SELECT on ${tbl} must return 0 rows`);
      }
    });

    // Lemma 2: Tenant Beta transaction querying Alpha's exact UUIDs returns 0 rows
    await withTenantTransaction(beta.id, async (client) => {
      const leakDoc = await client.query('SELECT * FROM tenant_ai_knowledge_docs WHERE id = $1', [
        alphaHrSecretDocId,
      ]);
      assert.equal(leakDoc.rows.length, 0);

      const leakChunks = await client.query('SELECT * FROM tenant_ai_knowledge_chunks');
      assert.equal(leakChunks.rows.length, 0);

      const leakThread = await client.query('SELECT * FROM tenant_ai_threads WHERE id = $1', [
        alphaThreadId,
      ]);
      assert.equal(leakThread.rows.length, 0);

      const leakAudits = await client.query('SELECT * FROM tenant_ai_tool_audit_logs');
      assert.equal(leakAudits.rows.length, 0);
    });

    // Lemma 3: Tenant Beta API calls cannot access Alpha's RAG knowledge, threads, or white-label config
    const betaRag = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/knowledge/query', {
      method: 'POST',
      token: beta.token,
      tenantSlug: beta.slug,
      body: { query: 'MA_CHINH_SACH_CHUNG_247 SAPPHIRE MA_MAT_NHAN_SU_9000' },
    });
    assert.equal(betaRag.status, 200);
    assert.equal(betaRag.json.data.citations.length, 0, 'Beta must get 0 citations from Alpha knowledge');

    const betaReadAlphaThread = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-agent/threads/${alphaThreadId}/messages`,
      {
        token: beta.token,
        tenantSlug: beta.slug,
      }
    );
    assert.equal(betaReadAlphaThread.status, 404);

    const betaCfg = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/config', {
      token: beta.token,
      tenantSlug: beta.slug,
    });
    assert.equal(betaCfg.status, 200);
    assert.equal(betaCfg.json.data.agent_name, 'DOM Agent');
    assert.equal(betaCfg.json.data.has_byok_gemini, false);

    // Also verify Intra-Tenant Thread Privacy: Sale B in Alpha cannot read Owner's private AI thread!
    const saleBReadOwnerThread = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-agent/threads/${alphaThreadId}/messages`,
      {
        token: saleB.token,
        tenantSlug: alpha.slug,
      }
    );
    assert.equal(saleBReadOwnerThread.status, 404);
  });
});
