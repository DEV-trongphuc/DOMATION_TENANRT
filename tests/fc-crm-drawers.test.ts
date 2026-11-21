import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import {
  createDatabasePool,
  setDatabasePool,
  type DatabasePool,
} from '../server/core/database/db-adapter.ts';
import { runMigrations } from '../server/core/database/migrate.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { createApp } from '../server/app.ts';
import { apiRequest } from './helpers.ts';
import {
  withTenantTransaction,
  withUnscopedRlsCheck,
} from '../server/core/database/transaction.ts';
import { flushDomainEvents } from '../server/core/events/event-bus.ts';
import {
  CRM_360_TABLES,
  crm360Router,
  ensureCrm360Schema,
} from '../server/modules/crm-360/index.ts';

describe('Stage 3A: CRM 360° Screens, Slide-Over Drawers, Personal Workspace, PII Masking & Multi-Tenant RLS', () => {
  let pool: DatabasePool;
  let server: Server;
  let baseUrl = '';

  let tenantA: { id: string; slug: string; token: string; userId: string };
  let tenantB: { id: string; slug: string; token: string; userId: string };
  let restrictedSaleA: { id: string; token: string };

  let parentCompanyId = '';
  let subCompanyId = '';
  let contactId = '';
  let dealId = '';
  let groupId = '';
  let taskAId = '';
  let taskBId = '';
  let ticketId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    tenantRedis.clearAllForTesting();
    pool = createDatabasePool({ inMemory: true });
    setDatabasePool(pool);
    await runMigrations({ seedSuperAdmin: true });
    await ensureCrm360Schema();

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/v1/crm-360', crm360Router);
    app.use(createApp());

    server = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, '127.0.0.1', 4096, () => resolve(srv));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const regA = await apiRequest(baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Sapphire CRM Holdings',
        tenant_slug: 'sapphire-crm',
        admin_name: 'Sapphire Owner',
        work_email: 'owner@sapphire-crm.vn',
        phone: '0901234567',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
      userId: regA.json.data.user.id,
    };

    const regB = await apiRequest(baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Rival Corp B2B',
        tenant_slug: 'rival-b2b',
        admin_name: 'Rival CEO',
        work_email: 'ceo@rival-b2b.vn',
        phone: '0909876543',
        password: 'SecurePassword123!',
        industry: 'agency',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
      userId: regB.json.data.user.id,
    };

    // Switch both tenants to Package 4 (`domation_promax`)
    for (const t of [tenantA, tenantB]) {
      await withTenantTransaction(t.id, async (client) => {
        await client.query('UPDATE tenants SET wallet_balance_vnd = 10000000 WHERE id = $1', [t.id]);
      });
      const sw = await apiRequest(baseUrl, '/api/v1/workspace/package', {
        method: 'POST',
        token: t.token,
        tenantSlug: t.slug,
        body: { package_code: 'domation_promax', education_addon: false },
      });
      assert.equal(sw.status, 200);
    }

    // Create a sale user in Tenant A with explicit deny on `unmask_phone`
    const createUser = await apiRequest(baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        full_name: 'Sale Masked Viewer',
        email: 'sale.masked@sapphire-crm.vn',
        phone: '0912223344',
        password: 'SalePassword123!',
        role: 'sale',
      },
    });
    assert.equal(createUser.status, 201);
    const saleUserId = createUser.json.data.id;

    // Grant company view scope on leads & deals, but explicitly DENY `unmask_phone`
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `INSERT INTO tenant_user_permission_overrides (id, tenant_id, user_id, module_key, effect, data_scope, actions)
         VALUES (gen_random_uuid(), $1, $2, 'leads', 'grant', 'company', '{"view": true, "edit": true}')`,
        [tenantA.id, saleUserId]
      );
      await client.query(
        `INSERT INTO tenant_user_permission_overrides (id, tenant_id, user_id, module_key, effect, data_scope, actions)
         VALUES (gen_random_uuid(), $1, $2, 'leads', 'deny', 'company', '{"unmask_phone": true}')`,
        [tenantA.id, saleUserId]
      );
      await client.query(
        `INSERT INTO tenant_user_permission_overrides (id, tenant_id, user_id, module_key, effect, data_scope, actions)
         VALUES (gen_random_uuid(), $1, $2, 'deals', 'grant', 'company', '{"view": true}')`,
        [tenantA.id, saleUserId]
      );
    });
    tenantRedis.clearAllForTesting();

    const saleLogin = await apiRequest(baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: tenantA.slug,
      body: {
        email: 'sale.masked@sapphire-crm.vn',
        password: 'SalePassword123!',
      },
    });
    assert.equal(saleLogin.status, 200);
    restrictedSaleA = {
      id: saleUserId,
      token: saleLogin.json.data.access_token,
    };
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.close();
    setDatabasePool(null);
    tenantRedis.clearAllForTesting();
  });

  it('1. B2B Companies: Parent/Subsidiary Hierarchy, MST Lookup & SLA Tier', async () => {
    const createParent = await apiRequest(baseUrl, '/api/v1/crm-360/companies', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        code: 'HOLDING-01',
        name: 'Tập đoàn Sao Xanh Việt Nam',
        tax_code: '0316889900',
        industry: 'Bất động sản & Đầu tư',
        tier: 'enterprise',
        representative_name: 'Trần Quốc Bảo',
        phone: '02839998888',
        email: 'contact@saoxanh.vn',
      },
    });
    assert.equal(createParent.status, 201);
    parentCompanyId = createParent.json.data.id;

    // MST Lookup finds existing B2B company & validates format
    const mstCheck = await apiRequest(
      baseUrl,
      '/api/v1/crm-360/companies/mst-lookup?tax_code=0316889900',
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(mstCheck.status, 200);
    assert.equal(mstCheck.json.data.is_valid_mst_format, true);
    assert.equal(mstCheck.json.data.existing_company.id, parentCompanyId);

    // Create Subsidiary linked via `parent_company_id`
    const createSub = await apiRequest(baseUrl, '/api/v1/crm-360/companies', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        code: 'SUB-SOUTH-01',
        name: 'Công ty TNHH Sao Xanh Miền Nam',
        tax_code: '0316889900-001',
        parent_company_id: parentCompanyId,
        tier: 'gold',
      },
    });
    assert.equal(createSub.status, 201);
    subCompanyId = createSub.json.data.id;

    // Circular hierarchy self-parenting must be rejected with 400
    const circular = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/companies/${parentCompanyId}`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { parent_company_id: parentCompanyId },
      }
    );
    assert.equal(circular.status, 400);
    assert.equal(circular.json.error.code, 'CIRCULAR_COMPANY_HIERARCHY');
  });

  it('2. Master Contact 360° (7 Tabs, Dynamic Entity Tabs, Timeline Edit History, Omnichannel & PII Masking)', async () => {
    // Configure a Dynamic Entity Tab for Contacts
    const dynTab = await apiRequest(baseUrl, '/api/v1/crm-360/entity-tabs', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        entity_type: 'contact',
        tab_key: 'investment_pref',
        tab_label: 'Khẩu vị Đầu tư',
        fields_json: [
          { key: 'preferred_region', label: 'Khu vực ưu tiên', type: 'text' },
          { key: 'capital_ready', label: 'Vốn sẵn sàng (VNĐ)', type: 'currency' },
        ],
      },
    });
    assert.equal(dynTab.status, 201);

    // Create Contact linked to Parent Company
    const createContact = await apiRequest(baseUrl, '/api/v1/crm-360/contacts', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Lê Hoàng Minh Khuê',
        phone: '0988776655',
        email: 'khue.le@saoxanh.vn',
        lifecycle_stage: 'sql',
        lead_score: 82,
        company_id: parentCompanyId,
        job_title: 'Giám đốc Đầu tư',
        product_interest: 'Biệt thự ven sông',
        tags: ['VIP', 'B2B-Key'],
        custom_fields: {
          preferred_region: 'Thủ Thiêm',
          capital_ready: 15_000_000_000,
        },
      },
    });
    assert.equal(createContact.status, 201);
    contactId = createContact.json.data.id;

    // Owner sees full unmasked PII + dynamic entity tabs
    const fullDossier = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(fullDossier.status, 200);
    assert.equal(fullDossier.json.data.contact.phone, '0988776655');
    assert.equal(fullDossier.json.data.can_unmask_phone, true);
    assert.equal(fullDossier.json.data.dynamic_entity_tabs.length, 1);
    assert.equal(fullDossier.json.data.contact.tags.length, 2);

    // Restricted Sale (`unmask_phone: false`) MUST receive server-masked phone & email
    const maskedDossier = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}`,
      {
        token: restrictedSaleA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(maskedDossier.status, 200);
    assert.equal(maskedDossier.json.data.can_unmask_phone, false);
    assert.ok(maskedDossier.json.data.contact.phone.includes('*'), 'Phone must be masked');
    assert.ok(maskedDossier.json.data.contact.email.includes('*'), 'Email must be masked');

    // Add @mention timeline note containing raw phone -> edit it -> verify 3-version history & PII text masking
    const addNote = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/timeline`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          activity_type: 'note',
          subject: 'Ghi chú tư vấn lần 1',
          content: '@Sapphire_Owner khách xác nhận số 0988776655 hẹn xem dự án thứ 6.',
          mentions: [tenantA.userId],
        },
      }
    );
    assert.equal(addNote.status, 201);
    const noteId = addNote.json.data.id;

    const editNote = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/timeline/${noteId}`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          content: '@Sapphire_Owner khách dời lịch sang sáng thứ 7, gọi số 0988776655.',
        },
      }
    );
    assert.equal(editNote.status, 200);
    assert.equal(editNote.json.data.edit_history.length, 1);

    const maskedTl = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/timeline`,
      {
        token: restrictedSaleA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(maskedTl.status, 200);
    const editedItem = maskedTl.json.data.items.find((i: any) => i.id === noteId);
    assert.ok(editedItem);
    assert.ok(!editedItem.content.includes('0988776655'), 'Raw phone inside free-text note must be masked');

    // Omnichannel Journey + Issue Voucher + DOM Agent AI Summary + Quick Quote + Cloud File
    const issueVoucher = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/issue-voucher`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { code: 'SAPPHIRE-VIP50', discount_value: 50_000_000 },
      }
    );
    assert.equal(issueVoucher.status, 201);

    const journey = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/omnichannel-journey`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(journey.status, 200);
    assert.ok(journey.json.data.completeness_pct >= 70);

    const aiSummary = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/journey-ai-summary`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(aiSummary.status, 200);
    assert.ok(aiSummary.json.data.summary.includes('DOM Agent'));

    const qQuote = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/quick-quote`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { title: 'Báo giá Biệt thự Khu A', total_vnd: 12_500_000_000 },
      }
    );
    assert.equal(qQuote.status, 201);

    const addFile = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}/files`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          file_name: 'Phieu_Dang_Ky_VIP.pdf',
          file_url: 'https://cdn.domation.vn/files/phieu-vip.pdf',
          size_bytes: 245_000,
          category: 'contract',
        },
      }
    );
    assert.equal(addFile.status, 201);

    // Save Contact selection to Static Audience
    const bulkAud = await apiRequest(baseUrl, '/api/v1/crm-360/contacts/bulk', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        action: 'save_to_audience',
        contact_ids: [contactId],
        audience_name: 'Tệp Khách VIP BĐS Q4',
      },
    });
    assert.equal(bulkAud.status, 200);
    assert.equal(bulkAud.json.data.affected, 1);
    assert.ok(bulkAud.json.data.audience_id);
  });

  it('3. Multi-Deals Kanban Transition, `tenant_deal_stage_history` Audit & Company Revenue Rollup', async () => {
    const createDeal = await apiRequest(baseUrl, '/api/v1/crm-360/deals', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Hợp đồng Đầu tư Sàn Thương Mại Tầng 2',
        company_id: parentCompanyId,
        lead_id: contactId,
        stage: 'proposal',
        amount_vnd: 4_800_000_000,
        probability: 60,
        expected_close_date: '2026-12-15',
      },
    });
    assert.equal(createDeal.status, 201);
    dealId = createDeal.json.data.id;

    // Move stage proposal -> negotiation -> won
    const toNeg = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/deals/${dealId}/stage`,
      {
        method: 'PATCH',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { stage: 'negotiation', probability: 85, note: 'Đã thống nhất tiến độ thanh toán' },
      }
    );
    assert.equal(toNeg.status, 200);
    assert.equal(toNeg.json.data.stage, 'negotiation');

    const toWon = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/deals/${dealId}/stage`,
      {
        method: 'PATCH',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { stage: 'won', probability: 100, note: 'Ký hợp đồng chính thức' },
      }
    );
    assert.equal(toWon.status, 200);
    assert.equal(toWon.json.data.stage, 'won');
    await flushDomainEvents();

    // Verify DealDrawer 360° has 3 stage history rows (initial + negotiation + won)
    const dealDetail = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/deals/${dealId}`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(dealDetail.status, 200);
    assert.equal(dealDetail.json.data.stage_history.length, 3);

    // Verify CompanyDrawer 360° rolls up Subsidiaries + Contacts + Won Revenue
    const compDetail = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/companies/${parentCompanyId}`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(compDetail.status, 200);
    assert.equal(compDetail.json.data.subsidiaries.length, 1);
    assert.equal(compDetail.json.data.subsidiaries[0].id, subCompanyId);
    assert.equal(compDetail.json.data.rollup.won_deals_vnd, 4_800_000_000);
  });

  it('4. Personal Workspace (`TaskGroupSection`, Dependencies, Comments, Attachments, Focus Pomodoro) & TicketDrawer', async () => {
    // Create Personal Task Group
    const grpRes = await apiRequest(baseUrl, '/api/v1/crm-360/workspace/groups', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Ưu tiên Chốt Deal Tuần Này',
        color_hex: '#1E40FF',
        icon_name: 'Flame',
        is_pinned: true,
      },
    });
    assert.equal(grpRes.status, 201);
    groupId = grpRes.json.data.id;

    // Create 2 Tasks & link Dependency (`taskB` blocked_by `taskA`)
    const tA = await apiRequest(baseUrl, '/api/v1/crm-360/workspace/tasks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Chuẩn bị hồ sơ pháp lý dự án',
        group_id: groupId,
        lead_id: contactId,
        deal_id: dealId,
        priority: 'high',
        checklist_json: [
          { id: 'chk-1', title: 'Kiểm tra MST pháp nhân', done: true },
          { id: 'chk-2', title: 'Soạn phụ lục thanh toán', done: false },
        ],
      },
    });
    assert.equal(tA.status, 201);
    taskAId = tA.json.data.id;

    const tB = await apiRequest(baseUrl, '/api/v1/crm-360/workspace/tasks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Trình ký Tổng Giám đốc',
        group_id: groupId,
        priority: 'urgent',
      },
    });
    assert.equal(tB.status, 201);
    taskBId = tB.json.data.id;

    const depRes = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/workspace/tasks/${taskBId}/dependencies`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { depends_on_task_id: taskAId, dependency_type: 'blocked_by' },
      }
    );
    assert.equal(depRes.status, 201);

    // Comment + Attachment + Focus Pomodoro 25m on Task A
    const cmRes = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/workspace/tasks/${taskAId}/comments`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { content: '@Sapphire_Owner đã hoàn tất kiểm tra MST 0316889900.' },
      }
    );
    assert.equal(cmRes.status, 201);

    const attRes = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/workspace/tasks/${taskAId}/attachments`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          file_name: 'Du_Thao_HD_SaoXanh.docx',
          file_url: 'https://cdn.domation.vn/tasks/du-thao.docx',
          size_bytes: 128_000,
        },
      }
    );
    assert.equal(attRes.status, 201);

    const pomoRes = await apiRequest(baseUrl, '/api/v1/crm-360/workspace/pomodoro', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { task_id: taskAId, duration_minutes: 25, mode: 'focus', note: 'Soạn điều khoản cọc' },
    });
    assert.equal(pomoRes.status, 201);

    // Fetch Task A Drawer payload & verify logged_minutes = 25, comments = 1, attachments = 1
    const taskDetail = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/workspace/tasks/${taskAId}`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(taskDetail.status, 200);
    assert.equal(Number(taskDetail.json.data.task.logged_minutes), 25);
    assert.equal(taskDetail.json.data.comments.length, 1);
    assert.equal(taskDetail.json.data.attachments.length, 1);

    // TicketDrawer lifecycle
    const createTk = await apiRequest(baseUrl, '/api/v1/crm-360/tickets', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        subject: 'Yêu cầu xuất hóa đơn VAT cho đợt cọc 1',
        lead_id: contactId,
        priority: 'high',
      },
    });
    assert.equal(createTk.status, 201);
    ticketId = createTk.json.data.id;

    const tkReply = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/tickets/${ticketId}/comments`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { content: 'Phòng kế toán đã tiếp nhận thông tin MST.', is_internal_note: true },
      }
    );
    assert.equal(tkReply.status, 201);

    const tkDetail = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/tickets/${ticketId}`,
      {
        token: restrictedSaleA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(tkDetail.status, 200);
    assert.equal(tkDetail.json.data.comments.length, 1);
    assert.ok(tkDetail.json.data.ticket.lead_phone.includes('*'));
  });

  it('5. Zero Cross-Tenant Leakage & Mandatory PostgreSQL ENABLE + FORCE RLS on All CRM 360° Tables', async () => {
    // Tenant B must see 0 contacts, 0 deals, 0 companies, and 404 on Tenant A IDs
    const bDeals = await apiRequest(baseUrl, '/api/v1/crm-360/deals', {
      token: tenantB.token,
      tenantSlug: tenantB.slug,
    });
    assert.equal(bDeals.status, 200);
    assert.equal(bDeals.json.data.items.length, 0);

    const crossDeal = await apiRequest(baseUrl, `/api/v1/crm-360/deals/${dealId}`, {
      token: tenantB.token,
      tenantSlug: tenantB.slug,
    });
    assert.equal(crossDeal.status, 404);

    const crossContact = await apiRequest(
      baseUrl,
      `/api/v1/crm-360/contacts/${contactId}`,
      {
        token: tenantB.token,
        tenantSlug: tenantB.slug,
      }
    );
    assert.equal(crossContact.status, 404);

    // Unscoped RLS check across all CRM_360_TABLES must return 0 rows!
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of CRM_360_TABLES) {
        const leakCheck = await client.query(`SELECT COUNT(*) AS cnt FROM ${tbl}`);
        assert.equal(
          Number(leakCheck.rows[0]?.cnt || 0),
          0,
          `Unscoped query on ${tbl} must return 0 rows under FORCE ROW LEVEL SECURITY`
        );
      }
    });
  });
});
