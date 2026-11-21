import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { DOM_AI_PORTAL_TABLES } from '../server/modules/dom-ai-portal/index.ts';
import { translatePostgresSqlToMariaDb } from '../server/core/database/sql-translator.ts';
import { seedEcoLifeDomAiPortalInTx } from '../scripts/seed-ecolife-dom-ai.ts';

describe('DOM AI Assistant — Standalone FREE-BYOK Enterprise Knowledge Portal, Auth Modes, ACL RAG, RLS & EcoLife Migration', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  let tenantB: { id: string; slug: string; token: string };

  let portalAId = '';
  const portalASlug = 'acme-knowledge-hub';
  let publicColId = '';
  let privateColId = '';
  let publicDocId = '';
  let privateDocId = '';
  let tenantBPortalId = '';
  const tenantBPortalSlug = 'globex-ai-portal';

  let restrictedViewerToken = '';
  let privilegedViewerToken = '';
  let negativeAssistantMsgId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Acme Enterprise Software',
        tenant_slug: 'acme-saas',
        admin_name: 'Minh Anh Admin',
        work_email: 'admin@acme-saas.vn',
        phone: '0903331111',
        password: 'SecurePassword123!',
        industry: 'technology',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Globex Logistics Vietnam',
        tenant_slug: 'globex-vn',
        admin_name: 'Thanh Tung Admin',
        work_email: 'admin@globex-vn.com',
        phone: '0904442222',
        password: 'SecurePassword123!',
        industry: 'logistics',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
    };
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  it('0. Zero EcoLife / floorplan / unit-picker hardcode inside server/modules/dom-ai-portal/*', () => {
    const modDir = path.resolve(process.cwd(), 'server', 'modules', 'dom-ai-portal');
    const files = fs.readdirSync(modDir).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 4);
    for (const f of files) {
      const src = fs.readFileSync(path.join(modDir, f), 'utf8');
      assert.doesNotMatch(src, /ecolife|bàu tràm|capital house|mặt bằng căn|chỉ căn|s-g\.06a/i, `${f} must stay 100% generic SaaS`);
    }
  });

  it('1. Admin creates generic portal, collections, documents & encrypted Gemini BYOK vault key (FREE on any package)', async () => {
    const createPortal = await apiRequest(harness.baseUrl, '/api/v1/dom-ai-portal/portals', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        slug: portalASlug,
        name: 'Acme Enterprise AI Assistant',
        tagline: 'Trợ lý tra cứu quy trình & chính sách nội bộ 24/7',
        primary_color: '#1E40FF',
        auth_mode: 'public_bypass',
        starter_prompts: ['Chính sách bảo hành SLA của Acme là gì?'],
      },
    });
    assert.equal(createPortal.status, 201);
    assert.equal(createPortal.json.data.slug, portalASlug);
    assert.equal(createPortal.json.data.is_free_byok, true);
    portalAId = createPortal.json.data.id;

    // Duplicate global slug across tenants rejected with 409
    const dupSlug = await apiRequest(harness.baseUrl, '/api/v1/dom-ai-portal/portals', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { slug: portalASlug, name: 'Collision Portal' },
    });
    assert.equal(dupSlug.status, 409);
    assert.equal(dupSlug.json.error.code, 'PORTAL_SLUG_TAKEN');

    // Create Tenant B portal for RLS tests
    const createB = await apiRequest(harness.baseUrl, '/api/v1/dom-ai-portal/portals', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: {
        slug: tenantBPortalSlug,
        name: 'Globex Secret Operations AI',
        auth_mode: 'viewer_whitelist',
      },
    });
    assert.equal(createB.status, 201);
    tenantBPortalId = createB.json.data.id;

    // Save encrypted Gemini BYOK key into Vault + test connectivity
    const saveKey = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/api-key`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          api_key: 'AIzaSyTestFakeKeyForVaultVerification123456',
          model: 'gemini-2.5-flash',
        },
      }
    );
    assert.equal(saveKey.status, 200);
    assert.equal(saveKey.json.data.has_api_key, true);
    assert.ok(String(saveKey.json.data.api_key_hint).includes('••••'));
    assert.ok(!JSON.stringify(saveKey.json).includes('AIzaSyTestFakeKeyForVaultVerification123456'));

    const testKey = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/api-key/test`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {},
      }
    );
    assert.equal(testKey.status, 200);
    assert.equal(testKey.json.data.ok, true);

    // Create 1 public collection & 1 private confidential collection
    const colPub = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/collections`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'Tài liệu Sản phẩm & SLA',
          description: 'Hướng dẫn sử dụng và cam kết SLA công khai',
          is_public: true,
          sort_order: 1,
        },
      }
    );
    assert.equal(colPub.status, 201);
    publicColId = colPub.json.data.id;

    const colPriv = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/collections`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'Tài chính & Quỹ thưởng Nội bộ',
          description: 'Tài liệu mật chỉ dành cho quản lý cấp cao',
          is_public: false,
          sort_order: 2,
        },
      }
    );
    assert.equal(colPriv.status, 201);
    privateColId = colPriv.json.data.id;

    // Create & auto-index documents in both collections
    const docPub = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/documents`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          collection_id: publicColId,
          title: 'Cam kết Chất lượng Dịch vụ SLA 99.95% & Hỗ trợ 24/7',
          doc_type: 'document',
          tags: ['sla', 'bảo hành', 'hỗ trợ kỹ thuật', 'uptime'],
          content:
            '## Cam kết SLA Doanh nghiệp\nAcme cam kết thời gian hoạt động hệ thống (Uptime SLA) đạt **99,95%/tháng**. Thời gian phản hồi sự cố mức P1 tối đa **15 phút** qua kênh Hotline kỹ thuật và Ticket ưu tiên.',
        },
      }
    );
    assert.equal(docPub.status, 201);
    assert.ok(docPub.json.data.chunk_count >= 1);
    publicDocId = docPub.json.data.id;

    const docPriv = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/documents`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          collection_id: privateColId,
          title: 'Biên bản Quỹ thưởng ESOP Executive 2026',
          doc_type: 'document',
          tags: ['esop', 'thưởng ban giám đốc', 'quỹ nội bộ'],
          content:
            '## Cơ cấu Quỹ thưởng ESOP 2026\nMã bí mật phê duyệt là **ALPHA-ESOP-7788**. Tổng ngân sách quỹ thưởng ban điều hành năm 2026 là **18,5 tỷ VNĐ** phân bổ theo tỷ lệ KPI lợi nhuận ròng.',
        },
      }
    );
    assert.equal(docPriv.status, 201);
    assert.ok(docPriv.json.data.chunk_count >= 1);
    privateDocId = docPriv.json.data.id;
  });

  it('2. Enforces all 3 auth_mode policies (public_bypass, open_login, viewer_whitelist) & hides secrets on bootstrap', async () => {
    // Public bootstrap MUST hide API key, byok_vault, system_instruction, and private collections
    const boot = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/bootstrap`
    );
    assert.equal(boot.status, 200);
    assert.equal(boot.json.data.portal.auth_mode, 'public_bypass');
    assert.equal(boot.json.data.portal.has_api_key, true);
    assert.equal(boot.json.data.portal.system_instruction, undefined);
    assert.ok(!JSON.stringify(boot.json).includes('AIzaSyTestFakeKey'));
    assert.ok(!JSON.stringify(boot.json).includes('byok_vault'));
    assert.equal(boot.json.data.collections.length, 1, 'Bootstrap must only expose is_public=true collections');
    assert.equal(boot.json.data.collections[0].id, publicColId);

    // (a) public_bypass: enters immediately without email and gets signed viewer JWT
    const enterGuest = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/auth/enter`,
      { method: 'POST', body: { full_name: 'Khách Trải Nghiệm' } }
    );
    assert.equal(enterGuest.status, 200);
    assert.ok(enterGuest.json.data.token);
    assert.equal(enterGuest.json.data.viewer.is_guest, true);

    // (b) Switch to open_login -> auto-registers new viewer email
    const swOpen = await apiRequest(harness.baseUrl, `/api/v1/dom-ai-portal/portals/${portalAId}`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { auth_mode: 'open_login' },
    });
    assert.equal(swOpen.status, 200);
    assert.equal(swOpen.json.data.auth_mode, 'open_login');

    const openNoEmail = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/auth/enter`,
      { method: 'POST', body: {} }
    );
    assert.equal(openNoEmail.status, 422);

    const openRegister = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/auth/enter`,
      {
        method: 'POST',
        body: { email: 'new.member@acme-saas.vn', full_name: 'Nguyễn Văn Mở' },
      }
    );
    assert.equal(openRegister.status, 200);
    assert.ok(openRegister.json.data.token);
    assert.equal(openRegister.json.data.viewer.email, 'new.member@acme-saas.vn');
    assert.equal(openRegister.json.data.viewer.is_guest, false);

    // (c) Switch to viewer_whitelist -> rejects unauthorized email with 403 VIEWER_NOT_AUTHORIZED
    const swWhitelist = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { auth_mode: 'viewer_whitelist' },
      }
    );
    assert.equal(swWhitelist.status, 200);

    const rejectedStranger = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/auth/enter`,
      {
        method: 'POST',
        body: { email: 'stranger@outside.io', full_name: 'Stranger' },
      }
    );
    assert.equal(rejectedStranger.status, 403);
    assert.equal(rejectedStranger.json.error.code, 'VIEWER_NOT_AUTHORIZED');

    // Old guest token is now rejected on viewer_whitelist portal!
    const guestRejected = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/collections`,
      { token: enterGuest.json.data.token }
    );
    assert.equal(guestRejected.status, 403);
    assert.equal(guestRejected.json.error.code, 'VIEWER_NOT_AUTHORIZED');

    // Whitelist 2 users with distinct collection ACLs + access_code
    const addRestricted = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/users`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          email: 'staff.public@acme-saas.vn',
          full_name: 'Trần Nhân Viên',
          department: 'CSKH',
          allowed_collection_ids: [publicColId],
          access_code: 'CSKH2026',
        },
      }
    );
    assert.equal(addRestricted.status, 201);

    const addPrivileged = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/users`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          email: 'cfo.vip@acme-saas.vn',
          full_name: 'Lê Giám Đốc',
          department: 'Ban Điều Hành',
          allowed_collection_ids: [publicColId, privateColId],
          access_code: 'CFO999',
        },
      }
    );
    assert.equal(addPrivileged.status, 201);

    // Wrong access code -> 403 INVALID_ACCESS_CODE
    const wrongCode = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/auth/enter`,
      {
        method: 'POST',
        body: { email: 'staff.public@acme-saas.vn', access_code: 'WRONG' },
      }
    );
    assert.equal(wrongCode.status, 403);
    assert.equal(wrongCode.json.error.code, 'INVALID_ACCESS_CODE');

    // Correct whitelisted email + access_code -> 200 OK
    const enterRestricted = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/auth/enter`,
      {
        method: 'POST',
        body: { email: 'staff.public@acme-saas.vn', access_code: 'CSKH2026' },
      }
    );
    assert.equal(enterRestricted.status, 200);
    restrictedViewerToken = enterRestricted.json.data.token;

    const enterPrivileged = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/auth/enter`,
      {
        method: 'POST',
        body: { email: 'cfo.vip@acme-saas.vn', access_code: 'CFO999' },
      }
    );
    assert.equal(enterPrivileged.status, 200);
    privilegedViewerToken = enterPrivileged.json.data.token;

    // Cross-portal viewer token replay must fail with 403 PORTAL_TOKEN_MISMATCH
    const replayAttempt = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${tenantBPortalSlug}/collections`,
      { token: privilegedViewerToken }
    );
    assert.equal(replayAttempt.status, 403);
    assert.equal(replayAttempt.json.error.code, 'PORTAL_TOKEN_MISMATCH');
  });

  it('3. Enforces Collection ACL scoping, Hybrid Vietnamese RAG citations, Groups/Starring & Feedback', async () => {
    // Restricted viewer only sees publicCol & cannot read privateDoc or get ESOP RAG citations!
    const restrictedCols = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/collections`,
      { token: restrictedViewerToken }
    );
    assert.equal(restrictedCols.status, 200);
    assert.equal(restrictedCols.json.data.length, 1);
    assert.equal(restrictedCols.json.data[0].id, publicColId);

    const restrictedDocs = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/documents`,
      { token: restrictedViewerToken }
    );
    assert.equal(restrictedDocs.status, 200);
    assert.equal(restrictedDocs.json.data.items.length, 1);
    assert.equal(restrictedDocs.json.data.items[0].id, publicDocId);

    const restrictedPrivateDocDirect = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/documents/${privateDocId}`,
      { token: restrictedViewerToken }
    );
    assert.equal(restrictedPrivateDocDirect.status, 404);

    // Restricted viewer asks about secret ESOP -> MUST get 0 citations and ZERO leak of ALPHA-ESOP-7788!
    const secretProbe = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/chat`,
      {
        method: 'POST',
        token: restrictedViewerToken,
        body: { message: 'Quỹ thưởng ESOP 2026 và mã phê duyệt nội bộ là gì?' },
      }
    );
    assert.equal(secretProbe.status, 200);
    assert.equal(secretProbe.json.data.citations.length, 0);
    assert.ok(!String(secretProbe.json.data.reply).includes('ALPHA-ESOP-7788'));
    negativeAssistantMsgId = secretProbe.json.data.assistant_message.id;

    // Record thumbs-down feedback on unanswered query
    const fbDown = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/messages/${negativeAssistantMsgId}/feedback`,
      {
        method: 'POST',
        token: restrictedViewerToken,
        body: { feedback: 'down', feedback_note: 'Cần bổ sung hướng dẫn chung về phúc lợi nhân viên.' },
      }
    );
    assert.equal(fbDown.status, 200);
    assert.equal(fbDown.json.data.feedback, 'down');

    // Privileged viewer asks diacritic-free Vietnamese query about ESOP -> gets exact grounded citation!
    const privChat = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/chat`,
      {
        method: 'POST',
        token: privilegedViewerToken,
        body: { message: 'quy thuong esop 2026 ngan sach bao nhieu' },
      }
    );
    assert.equal(privChat.status, 200);
    assert.ok(privChat.json.data.citations.length >= 1);
    assert.equal(privChat.json.data.citations[0].document_id, privateDocId);
    assert.ok(String(privChat.json.data.reply).includes('ALPHA-ESOP-7788'));
    const convId = privChat.json.data.conversation.id;
    const goodMsgId = privChat.json.data.assistant_message.id;

    // Record thumbs-up feedback
    const fbUp = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/messages/${goodMsgId}/feedback`,
      {
        method: 'POST',
        token: privilegedViewerToken,
        body: { feedback: 'up', feedback_note: 'Trích dẫn chính xác.' },
      }
    );
    assert.equal(fbUp.status, 200);
    assert.equal(fbUp.json.data.feedback, 'up');

    // Custom Group creation + session rename + star toggle + group assignment
    const createGroup = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/groups`,
      {
        method: 'POST',
        token: privilegedViewerToken,
        body: { name: 'Hồ sơ Quan trọng Q4', color: '#7C3AED' },
      }
    );
    assert.equal(createGroup.status, 201);
    const groupId = createGroup.json.data.id;

    const patchSession = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/sessions/${convId}`,
      {
        method: 'PATCH',
        token: privilegedViewerToken,
        body: {
          title: 'Kiểm tra Quỹ thưởng ESOP 2026',
          is_starred: true,
          group_id: groupId,
        },
      }
    );
    assert.equal(patchSession.status, 200);
    assert.equal(patchSession.json.data.is_starred, true);
    assert.equal(patchSession.json.data.group_id, groupId);
    assert.equal(patchSession.json.data.title, 'Kiểm tra Quỹ thưởng ESOP 2026');

    const sessionsByGroup = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/sessions?group_id=${groupId}&starred=true`,
      { token: privilegedViewerToken }
    );
    assert.equal(sessionsByGroup.status, 200);
    assert.equal(sessionsByGroup.json.data.length, 1);
    assert.equal(sessionsByGroup.json.data[0].id, convId);
  });

  it('4. Admin dashboard stats, bulk CSV users, log audit & 1-click promote-qa continuous training loop', async () => {
    // Bulk CSV import viewers
    const bulkRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/users/bulk`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          allowed_collection_ids: [publicColId],
          csv_text:
            'email,full_name,department,access_code\nkhanh.linh@acme-saas.vn,Phạm Khánh Linh,Sales,SALE01\nhoang.viet@acme-saas.vn,Đỗ Hoàng Việt,CSKH,CSKH02',
        },
      }
    );
    assert.equal(bulkRes.status, 201);
    assert.equal(bulkRes.json.data.imported, 2);

    // Dashboard stats check
    const dash = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/dashboard?days=7`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(dash.status, 200);
    assert.equal(dash.json.data.summary.total_collections, 2);
    assert.equal(dash.json.data.summary.active_documents, 2);
    assert.equal(dash.json.data.summary.feedback_up, 1);
    assert.equal(dash.json.data.summary.feedback_down, 1);
    assert.equal(dash.json.data.summary.satisfaction_rate, 50);
    assert.equal(dash.json.data.daily_trends.length, 7);
    assert.ok(dash.json.data.top_cited_documents.length >= 1);
    assert.ok(dash.json.data.top_unanswered_or_negative.length >= 1);

    // Audit logs filtered by feedback=down
    const logsDown = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/logs?feedback=down`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(logsDown.status, 200);
    assert.equal(logsDown.json.data.items.length, 1);
    assert.equal(logsDown.json.data.items[0].message_id, negativeAssistantMsgId);

    // 1-click promote-qa: Admin adds clean public Q&A answer for staff questions
    const promoteRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/logs/${negativeAssistantMsgId}/promote-qa`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          collection_id: publicColId,
          question: 'Chính sách phúc lợi và thưởng KPI công khai cho nhân viên năm 2026 là gì?',
          answer:
            'Toàn thể nhân viên chính thức của Acme được hưởng thưởng tháng 13, gói bảo hiểm sức khỏe PVI Care và phụ cấp đào tạo 12 triệu VNĐ/năm.',
          tags: ['phúc lợi', 'thưởng kpi', 'pvi care'],
        },
      }
    );
    assert.equal(promoteRes.status, 201);
    assert.equal(promoteRes.json.data.document.doc_type, 'qa');
    assert.ok(promoteRes.json.data.chunks_indexed >= 1);
    const promotedDocId = promoteRes.json.data.document.id;

    // Immediately verify RAG Playground retrieves the newly promoted Q&A document!
    const ragTest = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/rag/test`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { query: 'phu cap dao tao va bao hiem suc khoe pvi care' },
      }
    );
    assert.equal(ragTest.status, 200);
    assert.ok(ragTest.json.data.citations.length >= 1);
    assert.equal(ragTest.json.data.citations[0].document_id, promotedDocId);
  });

  it('5. Proves strict PostgreSQL Multi-Tenant RLS Zero-Leakage across all 8 dom_ai_* tables', async () => {
    // Lemma 1: Unscoped RLS check returns 0 rows on ALL 8 dom_ai_* tables
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of DOM_AI_PORTAL_TABLES) {
        const r = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(r.rows.length, 0, `Table ${tbl} must return 0 rows without app.current_tenant_id`);
      }
    });

    // Lemma 2: Tenant B cannot read, update, or delete Tenant A's portal/docs/messages via SQL or API
    await withTenantTransaction(tenantB.id, async (client) => {
      const readPortal = await client.query('SELECT * FROM dom_ai_portals WHERE id = $1', [portalAId]);
      assert.equal(readPortal.rows.length, 0);

      const readDocs = await client.query('SELECT * FROM dom_ai_documents WHERE portal_id = $1', [portalAId]);
      assert.equal(readDocs.rows.length, 0);

      const readMsgs = await client.query('SELECT * FROM dom_ai_messages WHERE portal_id = $1', [portalAId]);
      assert.equal(readMsgs.rows.length, 0);

      const updAttempt = await client.query(
        "UPDATE dom_ai_portals SET name = 'HACKED' WHERE id = $1 RETURNING id",
        [portalAId]
      );
      assert.equal(updAttempt.rows.length, 0);
    });

    const apiCrossRead = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/dashboard`,
      { token: tenantB.token, tenantSlug: tenantB.slug }
    );
    assert.equal(apiCrossRead.status, 404);

    const apiCrossDelete = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}`,
      { method: 'DELETE', token: tenantB.token, tenantSlug: tenantB.slug }
    );
    assert.equal(apiCrossDelete.status, 404);

    // Tenant B's own portal still intact
    const bList = await apiRequest(harness.baseUrl, '/api/v1/dom-ai-portal/portals', {
      token: tenantB.token,
      tenantSlug: tenantB.slug,
    });
    assert.equal(bList.status, 200);
    assert.equal(bList.json.data.length, 1);
    assert.equal(bList.json.data[0].id, tenantBPortalId);
  });

  it('6. Migrates canonical EcoLife Signature docs from seed-ecolife-knowledge.php cleanly & idempotently', async () => {
    const firstRun = await withTenantTransaction(tenantA.id, (client) =>
      seedEcoLifeDomAiPortalInTx(client, tenantA.id, { portalSlug: 'ecolife-signature' })
    );
    assert.equal(firstRun.source_mode, 'php_canonical_file');
    assert.equal(firstRun.collections_created, 5);
    assert.ok(firstRun.documents_migrated >= 20, `Expected >=20 migrated docs, got ${firstRun.documents_migrated}`);
    assert.ok(firstRun.documents_filtered_out >= 2, 'Pure floorplan/visual-asset picker docs must be filtered out');
    assert.ok(firstRun.chunks_indexed >= 40, `Expected >=40 indexed chunks, got ${firstRun.chunks_indexed}`);
    assert.equal(firstRun.viewers_seeded, 5);
    assert.equal(firstRun.conversations_seeded, 6);

    // Run a second time to guarantee 100% idempotency with zero duplicates
    const secondRun = await withTenantTransaction(tenantA.id, (client) =>
      seedEcoLifeDomAiPortalInTx(client, tenantA.id, { portalSlug: 'ecolife-signature' })
    );
    assert.equal(secondRun.portal_id, firstRun.portal_id);
    assert.equal(secondRun.documents_migrated, firstRun.documents_migrated);

    // Verify public bootstrap & real RAG Q&A on migrated EcoLife portal
    const ecoBoot = await apiRequest(
      harness.baseUrl,
      '/api/v1/public/dom-ai/ecolife-signature/bootstrap'
    );
    assert.equal(ecoBoot.status, 200);
    assert.equal(ecoBoot.json.data.collections.length, 5);
    const colNames = ecoBoot.json.data.collections.map((c: Record<string, unknown>) => c.name);
    assert.deepEqual(colNames, [
      'Tổng quan & Vị trí',
      'Sản phẩm & Thiết kế',
      'Chính sách & Pháp lý',
      'Tiện ích & Chuẩn Xanh EDGE',
      'Quy trình & Đào tạo Sale',
    ]);

    const ecoEnter = await apiRequest(
      harness.baseUrl,
      '/api/v1/public/dom-ai/ecolife-signature/auth/enter',
      { method: 'POST', body: { full_name: 'Khách hàng Đà Nẵng' } }
    );
    assert.equal(ecoEnter.status, 200);
    const ecoToken = ecoEnter.json.data.token;

    // Ask real EcoLife question without diacritics -> retrieves real SeABank 9% doc citation!
    const ecoChat = await apiRequest(
      harness.baseUrl,
      '/api/v1/public/dom-ai/ecolife-signature/chat',
      {
        method: 'POST',
        token: ecoToken,
        body: { message: 'chinh sach vay giai ngan song song seabank dot 1 can bao nhieu phan tram von tu co' },
      }
    );
    assert.equal(ecoChat.status, 200);
    assert.ok(ecoChat.json.data.citations.length >= 1);
    assert.match(String(ecoChat.json.data.citations[0].title), /SeABank/i);
    assert.match(String(ecoChat.json.data.reply), /9%/);
  });

  it('7. Enforces live viewer suspension, document archive/reindex, session/group deletion & MariaDB SQL compatibility', async () => {
    // Find staff.public@acme-saas.vn user id and suspend them -> existing JWT must be rejected immediately!
    const usersList = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/users`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(usersList.status, 200);
    const staffUser = usersList.json.data.find(
      (u: Record<string, unknown>) => u.email === 'staff.public@acme-saas.vn'
    );
    assert.ok(staffUser);

    const suspendRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/users/${staffUser.id}`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { status: 'suspended' },
      }
    );
    assert.equal(suspendRes.status, 200);
    assert.equal(suspendRes.json.data.status, 'suspended');

    const blockedAfterSuspend = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/collections`,
      { token: restrictedViewerToken }
    );
    assert.equal(blockedAfterSuspend.status, 403);
    assert.equal(blockedAfterSuspend.json.error.code, 'VIEWER_NOT_AUTHORIZED');

    // Archive privateDoc -> chunk_count drops to 0, then re-activate & reindex!
    const archiveDoc = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/documents/${privateDocId}`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { status: 'archived' },
      }
    );
    assert.equal(archiveDoc.status, 200);
    assert.equal(archiveDoc.json.data.chunk_count, 0);

    const reactivateDoc = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/documents/${privateDocId}`,
      {
        method: 'PUT',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { status: 'active' },
      }
    );
    assert.equal(reactivateDoc.status, 200);
    assert.ok(reactivateDoc.json.data.chunk_count >= 1);

    const reindexRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/dom-ai-portal/portals/${portalAId}/documents/reindex`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {},
      }
    );
    assert.equal(reindexRes.status, 200);
    assert.ok(reindexRes.json.data.documents_indexed >= 3);
    assert.ok(reindexRes.json.data.total_chunks >= 3);

    // Create & delete a public session + custom group cleanly
    const tempGrp = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/groups`,
      { method: 'POST', token: privilegedViewerToken, body: { name: 'Temp Group' } }
    );
    assert.equal(tempGrp.status, 201);
    const tempSess = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/sessions`,
      {
        method: 'POST',
        token: privilegedViewerToken,
        body: { title: 'Temp Session', group_id: tempGrp.json.data.id },
      }
    );
    assert.equal(tempSess.status, 201);

    const delGrp = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/groups/${tempGrp.json.data.id}`,
      { method: 'DELETE', token: privilegedViewerToken }
    );
    assert.equal(delGrp.status, 200);

    const delSess = await apiRequest(
      harness.baseUrl,
      `/api/v1/public/dom-ai/${portalASlug}/sessions/${tempSess.json.data.id}`,
      { method: 'DELETE', token: privilegedViewerToken }
    );
    assert.equal(delSess.status, 200);

    // MariaDB SQL translator sanity check on representative dom_ai_* queries
    const mariaSample = translatePostgresSqlToMariaDb(
      `INSERT INTO dom_ai_portals (id, tenant_id, slug, name, starter_prompts_json, metadata_json, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, clock_timestamp())`,
      ['id-1', 't-1', 'slug-1', 'Name', '[]', '{}']
    );
    assert.ok(!mariaSample.sql.includes('::jsonb'));
    assert.ok(!mariaSample.sql.includes('clock_timestamp()'));
    assert.equal(mariaSample.params.length, 6);
  });
});
