import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { domainEventBus } from '../server/core/events/event-bus.ts';
import { ERP_OPS_TABLES } from '../server/modules/erp-ops/schema.ts';

describe('Wave 2 Phase 4: Enterprise Operations (Projects, WorkChat, Finance, FIFO Inventory, Cloud/OCR, Education Add-on & RLS)', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string; userId: string };
  let tenantB: { id: string; slug: string; token: string; userId: string };
  let alphaLeadId = '';
  let alphaSecondStageId = '';
  let alphaPipelineId = '';
  let alphaProjectId = '';
  let alphaSalesOrderId = '';
  let alphaCloudFileId = '';
  let alphaCourseId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Alpha Enterprise Holdings',
        tenant_slug: 'alpha-erp',
        admin_name: 'Alpha CEO',
        work_email: 'ceo@alpha-erp.vn',
        phone: '0901112233',
        password: 'SecurePassword123!',
        industry: 'manufacturing',
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

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Beta Logistics Group',
        tenant_slug: 'beta-erp',
        admin_name: 'Beta CEO',
        work_email: 'ceo@beta-erp.vn',
        phone: '0904445566',
        password: 'SecurePassword123!',
        industry: 'retail',
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
  });

  after(async () => {
    await harness.close();
  });

  it('1. 4-Package Entitlement Gate strictly blocks ERP & Education Add-on until unlocked', async () => {
    // Default package on register is Package 1 (`autodata_crm`) -> all 6 ERP routers must return 403
    for (const ep of [
      '/api/v1/projects/overview',
      '/api/v1/workchat/bootstrap',
      '/api/v1/finance/dashboard',
      '/api/v1/inventory/overview',
      '/api/v1/erp-ops/drive',
      '/api/v1/education/overview',
    ]) {
      const blocked = await apiRequest(harness.baseUrl, ep, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      });
      assert.equal(blocked.status, 403, `Package 1 must block ${ep} with 403`);
      assert.equal(blocked.json.error.code, 'MODULE_NOT_ENTITLED');
    }

    // Switch Alpha & Beta to Package 4 (`domation_promax`) with `education_addon: false`
    const swA = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(swA.status, 200);

    const swB = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { package_code: 'domation_promax', education_addon: true },
    });
    assert.equal(swB.status, 200);

    // Core ERP Ops unlocked on Alpha, while `education` remains strictly gated (`403`)
    const projOk = await apiRequest(harness.baseUrl, '/api/v1/projects/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(projOk.status, 200);
    alphaPipelineId = projOk.json.data.pipelines[0].id;
    const stagesForDefault = projOk.json.data.stages.filter((s: any) => s.pipeline_id === alphaPipelineId);
    alphaSecondStageId = stagesForDefault[1]?.id || stagesForDefault[0]?.id;

    const eduBlocked = await apiRequest(harness.baseUrl, '/api/v1/education/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(eduBlocked.status, 403, 'Education Add-on must stay 403 when education_addon is false');
  });

  it('2. Projects Kanban, Whiteboard, Pomodoro Time Logging, Stage->Task Auto-Spawn & Helpdesk SLA', async () => {
    // Create a CRM Lead in Alpha
    const createLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Nguyễn Minh Quân',
        phone: '0918889900',
        email: 'quan.nguyen@client.vn',
        source: 'B2B Referral',
      },
    });
    assert.equal(createLead.status, 201);
    alphaLeadId = createLead.json.data.id;

    // Create Project with custom Kanban columns & Whiteboard sticky notes
    const createProj = await apiRequest(harness.baseUrl, '/api/v1/projects', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        code: 'PRJ-ERP-01',
        name: 'Triển khai Hệ thống Chuỗi Cung Ứng',
        budget_vnd: 500_000_000,
        task_columns: [
          { key: 'todo', label: 'Khởi tạo', color: '#64748B' },
          { key: 'in_progress', label: 'Đang làm', color: '#1E40FF' },
          { key: 'done', label: 'Nghiệm thu', color: '#10B981', is_done: true },
        ],
      },
    });
    assert.equal(createProj.status, 201);
    alphaProjectId = createProj.json.data.id;

    const saveBoard = await apiRequest(harness.baseUrl, `/api/v1/projects/${alphaProjectId}/whiteboard`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        elements: [
          { id: 'note-1', type: 'sticky', text: 'Kiểm thử luồng kho FIFO', x: 80, y: 120, color: '#FEF3C7' },
        ],
      },
    });
    assert.equal(saveBoard.status, 200);
    assert.equal(saveBoard.json.data.elements.length, 1);

    // Create Task + Log Focus Pomodoro 25m
    const createTask = await apiRequest(harness.baseUrl, '/api/v1/projects/tasks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        project_id: alphaProjectId,
        title: 'Thiết kế sơ đồ kho trung tâm',
        status_key: 'in_progress',
        estimated_minutes: 90,
      },
    });
    assert.equal(createTask.status, 201);
    const taskId = createTask.json.data.id;

    const logPomo = await apiRequest(harness.baseUrl, '/api/v1/projects/pomodoro/sessions', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        task_id: taskId,
        duration_minutes: 25,
        mode: 'focus',
        note: 'Hoàn tất phiên tập trung sâu #1',
      },
    });
    assert.equal(logPomo.status, 201);
    assert.equal(logPomo.json.data.updated_task_logged_minutes, 25);

    // Register Stage -> Task Automation Template & transition CRM lead stage
    const createTpl = await apiRequest(harness.baseUrl, '/api/v1/projects/workflow-templates', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        pipeline_id: alphaPipelineId,
        stage_id: alphaSecondStageId,
        project_id: alphaProjectId,
        title_template: 'Chuẩn bị hồ sơ khảo sát cho {{lead.name}}',
        priority: 'high',
        due_offset_hours: 12,
        checklist: [{ id: 'c1', text: 'Gọi xác nhận lịch hẹn', done: false }],
      },
    });
    assert.equal(createTpl.status, 201);

    const moveStage = await apiRequest(harness.baseUrl, `/api/v1/leads/${alphaLeadId}/stage`, {
      method: 'PATCH',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { stage_id: alphaSecondStageId, note: 'Khách đồng ý nhận khảo sát' },
    });
    assert.equal(moveStage.status, 200);

    const spawnedTasks = await apiRequest(
      harness.baseUrl,
      `/api/v1/projects/tasks/list?lead_id=${alphaLeadId}`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(spawnedTasks.status, 200);
    assert.equal(spawnedTasks.json.data.items.length, 1, 'Stage transition must auto-spawn exactly 1 task');
    assert.match(spawnedTasks.json.data.items[0].title, /Nguyễn Minh Quân/);
    assert.equal(spawnedTasks.json.data.items[0].checklist.length, 1);

    // Helpdesk Customer SLA Ticket (overdue detection + first response timestamp)
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    const createHd = await apiRequest(harness.baseUrl, '/api/v1/projects/tickets', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        subject: 'Hỗ trợ kỹ thuật cấu hình máy in mã vạch',
        priority: 'urgent',
        lead_id: alphaLeadId,
        sla_response_hours: 0.5,
        sla_resolution_hours: 2,
        resolution_due_at: pastIso,
      },
    });
    assert.equal(createHd.status, 201);
    assert.equal(createHd.json.data.sla_breached, true, 'Past resolution_due_at must flag sla_breached=true');
    const hdId = createHd.json.data.id;

    const addHdComment = await apiRequest(harness.baseUrl, `/api/v1/projects/tickets/${hdId}/comments`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { content: 'Kỹ thuật viên đã tiếp nhận và đang kết nối từ xa.' },
    });
    assert.equal(addHdComment.status, 201);
  });

  it('3. WorkChat Mascot Isolation (`enableIdeasMascot=false`), Commercial Stickers, Threads & Kudos Wall', async () => {
    const boot = await apiRequest(harness.baseUrl, '/api/v1/workchat/bootstrap', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.data.enable_ideas_mascot, false);
    assert.equal(boot.json.data.sticker_packs.length, 9, 'Must expose all 9 commercial sticker packs');
    assert.ok(
      !boot.json.data.sticker_packs.some((p: any) => p.id === 'ideas'),
      'Mascot pack "ideas" MUST be hidden when enable_ideas_mascot is false'
    );
    assert.equal(boot.json.data.work_status_badges.length, 12, 'Must expose all 12 quick work-status badges');

    const defaultChannelId = boot.json.data.channels[0].id;

    // Attempt sending disabled 'ideas' mascot sticker -> 403 MASCOT_PACK_DISABLED
    const blockedMascot = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/channels/${defaultChannelId}/messages`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { message_type: 'sticker', sticker_pack_id: 'ideas', sticker_id: 'ideas_1' },
      }
    );
    assert.equal(blockedMascot.status, 403);
    assert.equal(blockedMascot.json.error.code, 'MASCOT_PACK_DISABLED');

    // Send commercial sticker ('ghost') + work-status badge ('da_duyet') + threaded reply + pin + reaction
    const msgBadge = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/channels/${defaultChannelId}/messages`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { message_type: 'work_badge', content: 'Đã duyệt phương án xuất kho', sticker_id: 'da_duyet' },
      }
    );
    assert.equal(msgBadge.status, 201);
    const parentMsgId = msgBadge.json.data.id;

    const msgReply = await apiRequest(
      harness.baseUrl,
      `/api/v1/workchat/channels/${defaultChannelId}/messages`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          message_type: 'sticker',
          parent_message_id: parentMsgId,
          sticker_pack_id: 'ghost',
          sticker_id: 'ghost_1',
          content: '👻 Tuyệt vời!',
        },
      }
    );
    assert.equal(msgReply.status, 201);

    const pinRes = await apiRequest(harness.baseUrl, `/api/v1/workchat/messages/${parentMsgId}/pin`, {
      method: 'PATCH',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { is_pinned: true },
    });
    assert.equal(pinRes.status, 200);
    assert.equal(pinRes.json.data.is_pinned, true);

    const reactRes = await apiRequest(harness.baseUrl, `/api/v1/workchat/messages/${parentMsgId}/reactions`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { emoji: '🚀' },
    });
    assert.equal(reactRes.status, 200);
    assert.equal(reactRes.json.data.reactions['🚀'].length, 1);

    // Internal Feed & Kudos Wall Leaderboard
    const postFeed = await apiRequest(harness.baseUrl, '/api/v1/workchat/feed', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Thông báo Quý 4',
        content: 'Chúc mừng khối Vận hành hoàn thành vượt 120% chỉ tiêu giao hàng đúng hẹn!',
        is_pinned: true,
      },
    });
    assert.equal(postFeed.status, 201);

    const sendKudos = await apiRequest(harness.baseUrl, '/api/v1/workchat/kudos', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        recipient_user_id: tenantA.userId,
        badge_key: 'kaizen_star',
        badge_title: 'Ngôi sao Cải tiến Quy trình',
        points: 25,
        message: 'Tối ưu xuất kho FIFO giảm 40% thời gian kiểm đếm.',
      },
    });
    assert.equal(sendKudos.status, 201);

    const kudosBoard = await apiRequest(harness.baseUrl, '/api/v1/workchat/kudos', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(kudosBoard.status, 200);
    assert.equal(kudosBoard.json.data.leaderboard[0].total_points, 25);
  });

  it('4. FIFO Inventory Multi-Batch Deduction Math, POS Counter Checkout & Fixed Assets Depreciation', async () => {
    const createProd = await apiRequest(harness.baseUrl, '/api/v1/inventory/products', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        sku: 'CAM-AI-4K',
        name: 'Camera AI Nhận diện Kho thông minh 4K',
        product_type: 'goods',
        sale_price_vnd: 250_000,
        default_cost_vnd: 100_000,
      },
    });
    assert.equal(createProd.status, 201);
    const prodId = createProd.json.data.id;

    // Batch 1 (Oldest): 5 units @ 100,000 VND
    const b1 = await apiRequest(harness.baseUrl, '/api/v1/inventory/batches', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        product_id: prodId,
        batch_code: 'LOT-2026-01',
        initial_qty: 5,
        unit_cost_vnd: 100_000,
        received_at: '2026-01-10T08:00:00.000Z',
      },
    });
    assert.equal(b1.status, 201);

    // Batch 2 (Newer): 10 units @ 120,000 VND
    const b2 = await apiRequest(harness.baseUrl, '/api/v1/inventory/batches', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        product_id: prodId,
        batch_code: 'LOT-2026-02',
        initial_qty: 10,
        unit_cost_vnd: 120_000,
        received_at: '2026-02-15T08:00:00.000Z',
      },
    });
    assert.equal(b2.status, 201);

    // POS Checkout 8 units -> Must deduct 5 from LOT-2026-01 (500,000) + 3 from LOT-2026-02 (360,000) = 860,000 COGS!
    const posSale = await apiRequest(harness.baseUrl, '/api/v1/inventory/pos/checkout', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        lead_id: alphaLeadId,
        customer_name: 'Nguyễn Minh Quân',
        payment_method: 'bank_transfer',
        items: [{ product_id: prodId, qty: 8, unit_price_vnd: 250_000 }],
      },
    });
    assert.equal(posSale.status, 201);
    assert.equal(posSale.json.data.total_vnd, 2_000_000);
    assert.equal(posSale.json.data.cogs_vnd, 860_000, 'FIFO COGS must equal 5*100k + 3*120k = 860,000');
    assert.equal(posSale.json.data.gross_margin_vnd, 1_140_000);

    const batchesAfter = await apiRequest(
      harness.baseUrl,
      `/api/v1/inventory/batches?product_id=${prodId}`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(batchesAfter.json.data.items[0].batch_code, 'LOT-2026-01');
    assert.equal(batchesAfter.json.data.items[0].remaining_qty, 0);
    assert.equal(batchesAfter.json.data.items[0].status, 'depleted');
    assert.equal(batchesAfter.json.data.items[1].batch_code, 'LOT-2026-02');
    assert.equal(batchesAfter.json.data.items[1].remaining_qty, 7);

    // Fixed Asset Register & Straight-Line Depreciation
    const createAsset = await apiRequest(harness.baseUrl, '/api/v1/inventory/assets', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        asset_code: 'TS-SRV-01',
        name: 'Máy chủ Dell PowerEdge R760',
        purchase_cost_vnd: 72_000_000,
        salvage_value_vnd: 0,
        useful_life_months: 36,
      },
    });
    assert.equal(createAsset.status, 201);
    assert.equal(createAsset.json.data.monthly_depreciation_vnd, 2_000_000);
  });

  it('5. B2B Companies, Multi-Deals, Quote -> 1-Click SO -> Revenue Attribution & Event Bus + Dynamic Branch VietQR', async () => {
    // Configure HQ Branch Legal Entity in Alpha
    const createBranch = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/branches', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Trụ Sở Chính TP.HCM',
        legal_entity_name: 'CÔNG TY CỔ PHẦN TẬP ĐOÀN ALPHA ENTERPRISE',
        tax_code: '0319998888',
        representative_name: 'Lê Hoàng Nam',
        address: '88 Nguyễn Huệ, Quận 1, TP.HCM',
        is_headquarters: true,
      },
    });
    assert.equal(createBranch.status, 201);

    const qrRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/finance/vietqr-preview?amount_vnd=15000000&reference_code=SO2026',
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(qrRes.status, 200);
    assert.equal(qrRes.json.data.legal_entity.legal_entity_name, 'CÔNG TY CỔ PHẦN TẬP ĐOÀN ALPHA ENTERPRISE');
    assert.equal(qrRes.json.data.legal_entity.tax_code, '0319998888');
    assert.match(qrRes.json.data.qr_image_url, /vietqr\.io/);

    // B2B Company + 2 Independent Multi-Deals for the same Lead
    const createComp = await apiRequest(harness.baseUrl, '/api/v1/finance/companies', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'CÔNG TY CỔ PHẦN THÉP ĐÔNG DƯƠNG',
        tax_code: '0317776666',
        industry: 'Manufacturing',
        primary_lead_id: alphaLeadId,
        tier: 'enterprise',
      },
    });
    assert.equal(createComp.status, 201);
    const companyId = createComp.json.data.id;

    const deal1 = await apiRequest(harness.baseUrl, '/api/v1/finance/deals', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Hợp đồng Giai đoạn 1 — Thiết bị Kho',
        company_id: companyId,
        lead_id: alphaLeadId,
        stage: 'proposal',
        amount_vnd: 15_000_000,
      },
    });
    const deal2 = await apiRequest(harness.baseUrl, '/api/v1/finance/deals', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Hợp đồng Giai đoạn 2 — Bảo trì Năm',
        company_id: companyId,
        lead_id: alphaLeadId,
        stage: 'discovery',
        amount_vnd: 9_000_000,
      },
    });
    assert.equal(deal1.status, 201);
    assert.equal(deal2.status, 201);

    // Quote -> 1-click Convert to Sales Order -> Pay/Complete
    const createQuote = await apiRequest(harness.baseUrl, '/api/v1/finance/quotes', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'Báo giá Giải pháp Kho Giai đoạn 1',
        company_id: companyId,
        lead_id: alphaLeadId,
        deal_id: deal1.json.data.id,
        items: [{ name: 'Gói Triển khai Phần mềm Kho', qty: 1, unit_price_vnd: 15_000_000, tax_pct: 0 }],
      },
    });
    assert.equal(createQuote.status, 201);
    assert.equal(createQuote.json.data.total_vnd, 15_000_000);

    const convertSo = await apiRequest(
      harness.baseUrl,
      `/api/v1/finance/quotes/${createQuote.json.data.id}/convert-to-order`,
      { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug, body: {} }
    );
    assert.equal(convertSo.status, 201);
    alphaSalesOrderId = convertSo.json.data.sales_order.id;

    const capturedEvents: Array<{ type: string; amountVnd: number }> = [];
    const offOrderCompleted = domainEventBus.on('order.completed' as any, (evt: any) => {
      if (evt.tenantId === tenantA.id) {
        capturedEvents.push({ type: 'order.completed', amountVnd: evt.payload.amountVnd });
      }
    });
    const offDealWon = domainEventBus.on('deal.won', (evt) => {
      if (evt.tenantId === tenantA.id) {
        capturedEvents.push({ type: 'deal.won', amountVnd: evt.payload.amountVnd });
      }
    });

    try {
      const paySo = await apiRequest(
        harness.baseUrl,
        `/api/v1/finance/sales-orders/${alphaSalesOrderId}/pay-complete`,
        {
          method: 'POST',
          token: tenantA.token,
          tenantSlug: tenantA.slug,
          body: { payment_method: 'bank_transfer' },
        }
      );
      assert.equal(paySo.status, 200);
      assert.equal(paySo.json.data.order.payment_status, 'paid');
      assert.equal(paySo.json.data.revenue_delta_vnd, 15_000_000);
    } finally {
      offOrderCompleted();
      offDealWon();
    }

    assert.ok(
      capturedEvents.some((e) => e.type === 'order.completed' && e.amountVnd === 15_000_000),
      'Paying SO must emit order.completed on event-bus.ts'
    );
    assert.ok(
      capturedEvents.some((e) => e.type === 'deal.won' && e.amountVnd === 15_000_000),
      'Paying SO must emit deal.won for Revenue Attribution'
    );

    // Lead total_revenue_vnd must equal 2,000,000 (POS) + 15,000,000 (SO) = 17,000,000!
    // And Deal 2 stage ('discovery') must remain untouched!
    await withTenantTransaction(tenantA.id, async (client) => {
      const l = await client.query<{ total_revenue_vnd: string | number }>(
        'SELECT total_revenue_vnd FROM leads WHERE id = $1',
        [alphaLeadId]
      );
      assert.equal(Number(l.rows[0].total_revenue_vnd), 17_000_000);

      const d2 = await client.query<{ stage: string }>('SELECT stage FROM tenant_deals WHERE id = $1', [
        deal2.json.data.id,
      ]);
      assert.equal(d2.rows[0].stage, 'discovery', 'Deal 2 stage must remain independent when Deal 1 wins');
    });
  });

  it('6. Cloud Drive `tenants/{tenant_id}/` Namespace, Department ACL Isolation, AI OCR & Clean Global Search/Docs', async () => {
    const deptFin = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Phòng Tài Chính Kế Toán', code: 'FIN' },
    });
    const deptSale = await apiRequest(harness.baseUrl, '/api/v1/org-rbac/departments', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'Phòng Kinh Doanh', code: 'SALE' },
    });
    assert.equal(deptFin.status, 201);
    assert.equal(deptSale.status, 201);

    // Create a staff member in Dept Sales with cloud_files_ocr view permission
    const createStaff = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        full_name: 'Trần Nhân Viên Sale',
        email: 'sale.staff@alpha-erp.vn',
        password: 'StaffPassword123!',
        role: 'manager',
      },
    });
    assert.equal(createStaff.status, 201);
    const staffUserId = createStaff.json.data.id;

    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query('UPDATE users SET department_id = $2 WHERE tenant_id = $1 AND id = $3', [
        tenantA.id,
        deptSale.json.data.id,
        staffUserId,
      ]);
    });

    const loginStaff = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: tenantA.slug,
      body: { email: 'sale.staff@alpha-erp.vn', password: 'StaffPassword123!', tenant_slug: tenantA.slug },
    });
    assert.equal(loginStaff.status, 200);
    const staffToken = loginStaff.json.data.access_token;

    // Upload a Finance-only confidential file
    const uploadFinFile = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/drive/files', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Bao_Cao_Thue_Mat_Q4.pdf',
        version_tag: 'v2.1',
        visibility: 'departments',
        allowed_department_ids: [deptFin.json.data.id],
        content_preview: 'Tài liệu mật chỉ dành cho Phòng Tài Chính',
      },
    });
    assert.equal(uploadFinFile.status, 201);
    alphaCloudFileId = uploadFinFile.json.data.id;
    assert.ok(
      String(uploadFinFile.json.data.storage_key).startsWith(`tenants/${tenantA.id}/`),
      'Cloud storage_key must strictly start with tenants/{tenant_id}/'
    );

    // Staff in Dept Sale CANNOT see Finance file in list or direct GET (`403 FORBIDDEN_DEPARTMENT_ACL`)
    const staffDrive = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/drive', {
      token: staffToken,
      tenantSlug: tenantA.slug,
    });
    assert.equal(staffDrive.status, 200);
    assert.equal(staffDrive.json.data.files.length, 0, 'Dept ACL must hide Finance file from Sale department user');

    const staffDirectRead = await apiRequest(
      harness.baseUrl,
      `/api/v1/erp-ops/drive/files/${alphaCloudFileId}`,
      { token: staffToken, tenantSlug: tenantA.slug }
    );
    assert.equal(staffDirectRead.status, 403);
    assert.equal(staffDirectRead.json.error.code, 'FORBIDDEN_DEPARTMENT_ACL');

    // AI OCR Contract Extraction + Branch Legal Cross-Check + 1-Click Save
    const ocrRes = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/ocr/extract', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        doc_type: 'contract',
        source_title: 'HĐKT-2026-88 Hợp đồng Cung ứng Thiết bị',
        raw_text: `
          CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM
          HỢP ĐỒNG KINH TẾ SỐ 88/2026
          BÊN A: CÔNG TY CỔ PHẦN TẬP ĐOÀN ALPHA ENTERPRISE
          Mã số thuế: 0319998888
          BÊN B: CÔNG TY TNHH CÔNG NGHỆ SAO KHUÊ
          Mã số thuế: 0106668889
          Đại diện: Nguyễn Hoàng Long
          Địa chỉ: 120 Cầu Giấy, Hà Nội
          Tổng giá trị hợp đồng: 320.000.000 VNĐ
          Ngày hiệu lực: 15/11/2026 - 15/11/2027
        `,
      },
    });
    assert.equal(ocrRes.status, 201);
    assert.equal(ocrRes.json.data.extracted_party_name, 'CÔNG TY TNHH CÔNG NGHỆ SAO KHUÊ');
    assert.equal(ocrRes.json.data.extracted_tax_code, '0106668889');
    assert.equal(ocrRes.json.data.contract_value_vnd, 320_000_000);
    assert.equal(ocrRes.json.data.branch_verification.tax_code_matched, true);
    assert.equal(ocrRes.json.data.branch_verification.legal_name_matched, true);

    const saveOcrComp = await apiRequest(
      harness.baseUrl,
      `/api/v1/erp-ops/ocr/extractions/${ocrRes.json.data.id}/save-company`,
      { method: 'POST', token: tenantA.token, tenantSlug: tenantA.slug, body: {} }
    );
    assert.equal(saveOcrComp.status, 201);
    assert.equal(saveOcrComp.json.data.tax_code, '0106668889');

    // Global Search & OpenAPI Spec (Zero hardcode check)
    const searchRes = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/global-search?q=SAO%20KHU%C3%8A', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(searchRes.status, 200);
    assert.ok(searchRes.json.data.total_hits >= 1);

    const openApiRes = await apiRequest(harness.baseUrl, '/api/v1/erp-ops/openapi-docs', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(openApiRes.status, 200);
    const specSerialized = JSON.stringify(openApiRes.json.data);
    assert.ok(!specSerialized.includes('ideas.edu.vn'), 'OpenAPI spec must have zero legacy domain references');
  });

  it('7. Education Vertical Add-on Unlock, Timetable Room/Instructor Conflict Checker & Gradebook', async () => {
    // Enable `education_addon: true` on Tenant Alpha
    const unlockEdu = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax', education_addon: true },
    });
    assert.equal(unlockEdu.status, 200);

    const createCourse = await apiRequest(harness.baseUrl, '/api/v1/education/courses', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        code: 'CRS-DATA-101',
        name: 'Quản trị Dữ liệu Doanh nghiệp Chuyên sâu',
        duration_sessions: 16,
        tuition_fee_vnd: 12_000_000,
      },
    });
    assert.equal(createCourse.status, 201);
    alphaCourseId = createCourse.json.data.id;

    const cls1 = await apiRequest(harness.baseUrl, '/api/v1/education/classes', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        course_id: alphaCourseId,
        code: 'CLS-K01',
        name: 'Lớp K01 Tối Thứ 2',
        instructor_user_id: tenantA.userId,
        room_name: 'Phòng Lab 301',
      },
    });
    const cls2 = await apiRequest(harness.baseUrl, '/api/v1/education/classes', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        course_id: alphaCourseId,
        code: 'CLS-K02',
        name: 'Lớp K02 Chuyên Đề',
        instructor_user_id: tenantA.userId,
        room_name: 'Phòng Lab 301',
      },
    });
    assert.equal(cls1.status, 201);
    assert.equal(cls2.status, 201);

    // Schedule Class 1 on Monday (day 1) 18:30 - 20:30 in Phòng Lab 301
    const sched1 = await apiRequest(harness.baseUrl, '/api/v1/education/schedules', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        class_id: cls1.json.data.id,
        day_of_week: 1,
        start_time: '18:30',
        end_time: '20:30',
        room_name: 'Phòng Lab 301',
      },
    });
    assert.equal(sched1.status, 201);

    // Overlapping schedule on Monday 19:30 - 21:00 in Phòng Lab 301 MUST return 409 SCHEDULE_CONFLICT
    const schedConflict = await apiRequest(harness.baseUrl, '/api/v1/education/schedules', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        class_id: cls2.json.data.id,
        day_of_week: 1,
        start_time: '19:30',
        end_time: '21:00',
        room_name: 'Phòng Lab 301',
      },
    });
    assert.equal(schedConflict.status, 409, 'Overlapping room/instructor slot must be rejected with 409');
    assert.equal(schedConflict.json.error.code, 'SCHEDULE_CONFLICT');

    // Enroll student linked to `alphaLeadId` + record Attendance & Gradebook
    const enroll = await apiRequest(harness.baseUrl, '/api/v1/education/enrollments', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        class_id: cls1.json.data.id,
        lead_id: alphaLeadId,
        tuition_paid_vnd: 12_000_000,
      },
    });
    assert.equal(enroll.status, 201);

    const grade = await apiRequest(harness.baseUrl, '/api/v1/education/gradebook', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        enrollment_id: enroll.json.data.id,
        attendance_status: 'present',
        midterm_score: 8.0,
        final_score: 9.0,
        feedback: 'Hoàn thành xuất sắc đồ án thực hành.',
      },
    });
    assert.equal(grade.status, 201);
    assert.equal(grade.json.data.gpa_score, 8.6);
  });

  it('8. Kernel FORCE ROW LEVEL SECURITY Zero-Leakage across ALL 32 Wave 2 ERP Ops Tables (Tenant A vs Tenant B)', async () => {
    // Lemma 1: Unscoped queries without `app.current_tenant_id` MUST return 0 rows on all 32 tables
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of ERP_OPS_TABLES) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped query on ${tbl} must return 0 rows under FORCE RLS`);
      }
    });

    // Lemma 2: Tenant Beta cannot read or mutate Tenant Alpha records via SQL or REST API
    await withTenantTransaction(tenantB.id, async (client) => {
      const leakProj = await client.query('SELECT * FROM tenant_projects WHERE id = $1', [alphaProjectId]);
      assert.equal(leakProj.rows.length, 0);
      const leakSo = await client.query('SELECT * FROM tenant_sales_orders WHERE id = $1', [alphaSalesOrderId]);
      assert.equal(leakSo.rows.length, 0);
      const leakFile = await client.query('SELECT * FROM tenant_cloud_files WHERE id = $1', [alphaCloudFileId]);
      assert.equal(leakFile.rows.length, 0);
      const leakCourse = await client.query('SELECT * FROM tenant_edu_courses WHERE id = $1', [alphaCourseId]);
      assert.equal(leakCourse.rows.length, 0);
    });

    const betaProjects = await apiRequest(harness.baseUrl, '/api/v1/projects', {
      token: tenantB.token,
      tenantSlug: tenantB.slug,
    });
    assert.equal(betaProjects.status, 200);
    assert.equal(betaProjects.json.data.items.length, 0, 'Tenant B must see 0 of Tenant A projects');

    const betaReadAlphaFile = await apiRequest(
      harness.baseUrl,
      `/api/v1/erp-ops/drive/files/${alphaCloudFileId}`,
      { token: tenantB.token, tenantSlug: tenantB.slug }
    );
    assert.equal(betaReadAlphaFile.status, 404, 'Tenant B probing Tenant A file UUID must receive 404');
  });
});
