/**
 * EcoLife Signature Knowledge Migration Seeder for DOM AI Assistant (Standalone FREE-BYOK Portal)
 *
 * Exports `seedEcoLifeDomAiPortalInTx(client, tenantId, opts)` for programmatic/test usage
 * and provides a safe CLI runner targeting `--in-memory` or `--data-dir <temp-dir>` ONLY
 * (NEVER touches live `./.autodata-pgdata`!).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDatabasePool,
  setDatabasePool,
  type DbClient,
} from '../server/core/database/db-adapter.ts';
import { runDatabaseMigrations } from '../server/core/database/migrate.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import {
  indexDomAiDocumentInTx,
  recomputeCollectionDocCountsInTx,
  searchDomAiKnowledgeInTx,
  type DomAiCitation,
} from '../server/modules/dom-ai-portal/rag.service.ts';
import {
  runDomAiPortalSchema,
  type DomAiAuthMode,
} from '../server/modules/dom-ai-portal/schema.ts';

export const DEFAULT_ECOLIFE_PHP_SEED_PATH =
  'C:\\Users\\LENOVO\\Desktop\\CHINH\\wordpress_theme\\ecolife-signature\\api\\seed-ecolife-knowledge.php';

export interface CanonicalEcoLifePhpDoc {
  id?: number;
  category: string;
  title: string;
  tags?: string;
  source_type?: string;
  content: string;
  relevance_boost?: number;
}

export interface SeedEcoLifeDomAiOptions {
  portalSlug?: string;
  portalName?: string;
  authMode?: DomAiAuthMode;
  phpSourcePath?: string;
  seedConversations?: boolean;
  seedViewers?: boolean;
}

export interface SeedEcoLifeDomAiResult {
  portal_id: string;
  portal_slug: string;
  collections_created: number;
  documents_migrated: number;
  documents_filtered_out: number;
  chunks_indexed: number;
  viewers_seeded: number;
  conversations_seeded: number;
  messages_seeded: number;
  source_mode: 'php_canonical_file' | 'embedded_fallback';
}

const EXCLUDED_FLOORPLAN_OR_PICKER_CATEGORIES = new Set([
  'bo_7_mat_bang_cac_tang',
  'ban_do_anh_xa_hinh_anh_visual_assets',
]);

function deterministicUuid(namespace: string, key: string): string {
  const hash = crypto.createHash('sha256').update(`${namespace}:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isPureFloorplanSvgOrUnitPickerDoc(doc: CanonicalEcoLifePhpDoc): boolean {
  const cat = String(doc.category || '').trim().toLowerCase();
  if (EXCLUDED_FLOORPLAN_OR_PICKER_CATEGORIES.has(cat)) {
    return true;
  }
  const content = String(doc.content || '');
  if (
    /<svg[\s>]/i.test(content) ||
    /floorplan[-_]?svg/i.test(content) ||
    /unit[-_]?picker/i.test(content) ||
    /data-unit-code/i.test(content)
  ) {
    return true;
  }
  return false;
}

function cleanMigratedDocContent(rawContent: string): string {
  return String(rawContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/\[YOUTUBE:([A-Za-z0-9_-]+)\]/g, 'https://www.youtube.com/watch?v=$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseEcoLifeCanonicalSeedDocs(
  phpPath = DEFAULT_ECOLIFE_PHP_SEED_PATH
): { docs: CanonicalEcoLifePhpDoc[]; filteredOut: number; sourceMode: 'php_canonical_file' | 'embedded_fallback' } {
  if (!fs.existsSync(phpPath)) {
    throw new Error(`ECOLIFE_SEED_PHP_NOT_FOUND: ${phpPath}`);
  }

  const rawPhp = fs.readFileSync(phpPath, 'utf8');
  const match = rawPhp.match(/<<<'ECOLIFE_SEED_JSON'\s*([\s\S]*?)\r?\nECOLIFE_SEED_JSON;/);
  if (!match || !match[1]) {
    throw new Error('ECOLIFE_SEED_JSON_HEREDOC_NOT_FOUND');
  }

  const parsed = JSON.parse(match[1].trim()) as CanonicalEcoLifePhpDoc[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('ECOLIFE_SEED_JSON_EMPTY');
  }

  const kept: CanonicalEcoLifePhpDoc[] = [];
  let filteredOut = 0;

  for (const doc of parsed) {
    if (!doc || !doc.title || !doc.content) {
      filteredOut++;
      continue;
    }
    if (isPureFloorplanSvgOrUnitPickerDoc(doc)) {
      filteredOut++;
      continue;
    }
    kept.push({
      ...doc,
      content: cleanMigratedDocContent(doc.content),
    });
  }

  return {
    docs: kept,
    filteredOut,
    sourceMode: 'php_canonical_file',
  };
}

interface CollectionDef {
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  sort_order: number;
  is_public: boolean;
}

const ECOLIFE_COLLECTIONS: CollectionDef[] = [
  {
    slug: 'tong-quan-vi-tri',
    name: 'Tổng quan & Vị trí',
    description:
      'Thông tin chủ đầu tư Capital House, quy mô dự án, 05 trụ cột định vị chiến lược, vị trí Đại lộ Mê Linh – Hồ Bàu Tràm – FTZ Liên Chiểu và video giới thiệu.',
    icon: 'Compass',
    color: '#1E40FF',
    sort_order: 1,
    is_public: true,
  },
  {
    slug: 'san-pham-thiet-ke',
    name: 'Sản phẩm & Thiết kế',
    description:
      'Chi tiết thiết kế các mẫu căn hộ 2PN (A1, A2), 3PN (B1–B6), Shophouse khối đế, Penthouse và Danh mục vật liệu bàn giao kèm HĐMB cập nhật 20/11/2026.',
    icon: 'Building2',
    color: '#0284C7',
    sort_order: 2,
    is_public: true,
  },
  {
    slug: 'chinh-sach-phap-ly',
    name: 'Chính sách & Pháp lý',
    description:
      'Bộ 06 văn bản pháp lý mở bán (GPXD 414/GPXD, 12529/SXD-QLN, bảo lãnh Agribank), Chính sách bán hàng 24/2026/CSBH và vay giải ngân song song SeABank.',
    icon: 'Scale',
    color: '#10B981',
    sort_order: 3,
    is_public: true,
  },
  {
    slug: 'tien-ich-chuan-xanh-edge',
    name: 'Tiện ích & Chuẩn Xanh EDGE',
    description:
      'Chứng chỉ công trình xanh quốc tế EDGE (SGS – IFC/World Bank), mô hình Đô thị Bọt biển Sponge City và hệ sinh thái 60 tiện ích đa tầng.',
    icon: 'Leaf',
    color: '#059669',
    sort_order: 4,
    is_public: true,
  },
  {
    slug: 'quy-trinh-dao-tao-sale',
    name: 'Quy trình & Đào tạo Sale',
    description:
      'Thông báo kế hoạch mở bán 25/2026/TB-HOMES, nguyên tắc mở giỏ hàng đợt 1, bộ 32 slide đào tạo đại lý và danh mục ấn phẩm PDF chính thức.',
    icon: 'GraduationCap',
    color: '#7C3AED',
    sort_order: 5,
    is_public: true,
  },
];

function mapEcoLifeCategoryToCollectionSlug(category: string): string {
  const c = String(category || '').toLowerCase();
  if (
    c.includes('tong_quan') ||
    c.includes('vi_tri') ||
    c === 'overview_legal' ||
    c.includes('video')
  ) {
    return 'tong-quan-vi-tri';
  }
  if (
    c.includes('can_ho') ||
    c.includes('shophouse') ||
    c.includes('danh_muc_vat_lieu')
  ) {
    return 'san-pham-thiet-ke';
  }
  if (
    c.includes('phap_ly') ||
    c.includes('finance') ||
    c.includes('seabank') ||
    c.includes('chinh_sach')
  ) {
    return 'chinh-sach-phap-ly';
  }
  if (c.includes('edge') || c.includes('tien_ich') || c.includes('xanh')) {
    return 'tien-ich-chuan-xanh-edge';
  }
  if (
    c.includes('sales_process') ||
    c.includes('slide') ||
    c.includes('pdf') ||
    c.includes('dao_tao')
  ) {
    return 'quy-trinh-dao-tao-sale';
  }
  return 'tong-quan-vi-tri';
}

function buildDerivedAmenitiesQaDoc(docs: CanonicalEcoLifePhpDoc[]): CanonicalEcoLifePhpDoc | null {
  const pillarDoc = docs.find((d) => d.category === 'overview_legal');
  if (!pillarDoc) return null;
  const pillar4Match = pillarDoc.content.match(/## PILLAR \(4\)[\s\S]*?(?=## PILLAR \(5\)|$)/);
  if (!pillar4Match) return null;

  return {
    category: 'tien_ich_60_he_sinh_thai',
    title: 'Hệ sinh thái 60 Tiện ích Chuẩn Resort & 04 Tầng Vườn Chân Mây (Tầng 6A, 11, 16, 18)',
    tags: '60 tiện ích, bể bơi vô cực điện phân muối, vườn chân mây, tầng 6a, tầng 11, tầng 16, tầng 18, pickleball, hồ cá koi, trường mầm non gca',
    source_type: 'qa',
    relevance_boost: 1.15,
    content: `### Hệ sinh thái 60 Tiện ích Nội khu Chuẩn Resort Đa tầng tại EcoLife Signature\n\n${pillar4Match[0].trim()}`,
  };
}

/**
 * Migrates EcoLife Signature canonical knowledge docs into a clean DOM AI Portal inside
 * the caller's tenant transaction. Fully idempotent via deterministic UUIDs!
 */
export async function seedEcoLifeDomAiPortalInTx(
  client: DbClient,
  tenantId: string,
  opts: SeedEcoLifeDomAiOptions = {}
): Promise<SeedEcoLifeDomAiResult> {
  const portalSlug = (opts.portalSlug || 'ecolife-signature').trim().toLowerCase();
  const portalName = opts.portalName || 'EcoLife Signature AI Knowledge Hub';
  const authMode: DomAiAuthMode = opts.authMode || 'public_bypass';
  const ns = `dom-ai-ecolife:${tenantId}:${portalSlug}`;
  const portalId = deterministicUuid(ns, 'portal');

  const starterPrompts = [
    'Tóm tắt 05 trụ cột chiến lược và điểm mạnh nổi bật của EcoLife Signature',
    'Chính sách vay giải ngân song song SeABank cần bao nhiêu % vốn tự có Đợt 1?',
    'So sánh thiết kế căn hộ 2PN Mẫu A1, A2 và căn 3PN 3WC Mẫu B6',
    'Dự án đã có đầy đủ giấy phép xây dựng và văn bản đủ điều kiện bán chưa?',
    'Danh mục vật liệu bàn giao căn hộ khối tháp cập nhật 20/11/2026 gồm những gì?',
  ];

  const welcomeMessage =
    'Xin chào Anh/Chị! Tôi là Trợ lý AI Kho Tri thức EcoLife Signature Đà Nẵng (vận hành trên nền tảng DOM AI Assistant BYOK). Hãy đặt câu hỏi về tổng quan dự án, thiết kế căn hộ, chính sách bán hàng, pháp lý, chuẩn xanh EDGE hoặc quy trình mở bán — mọi câu trả lời đều kèm trích dẫn tài liệu gốc.';

  const systemInstruction =
    'Bạn là Trợ lý AI Tri thức chính thức của EcoLife Signature Đà Nẵng (Chủ đầu tư Capital House). Chỉ sử dụng 100% thông số chính xác từ Kho Tri thức được truy xuất (RAG), không suy diễn số liệu ngoài tài liệu. Trả lời bằng tiếng Việt lịch sự, cấu trúc Markdown rõ ràng và luôn đính kèm trích dẫn nguồn [1], [2].';

  // 1. Upsert Portal
  await client.query(
    `INSERT INTO dom_ai_portals (
       id, tenant_id, slug, name, tagline, logo_url, primary_color,
       welcome_message, system_instruction, starter_prompts_json,
       auth_mode, allow_guest_history, model, temperature, top_k,
       is_active, is_free_byok, metadata_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10::jsonb,
       $11, true, 'gemini-2.5-flash', 0.25, 6,
       true, true, $12::jsonb
     )
     ON CONFLICT (id)
     DO UPDATE SET
       name = EXCLUDED.name,
       tagline = EXCLUDED.tagline,
       primary_color = EXCLUDED.primary_color,
       welcome_message = EXCLUDED.welcome_message,
       system_instruction = EXCLUDED.system_instruction,
       starter_prompts_json = EXCLUDED.starter_prompts_json,
       auth_mode = EXCLUDED.auth_mode,
       is_active = true,
       updated_at = clock_timestamp()`,
    [
      portalId,
      tenantId,
      portalSlug,
      portalName,
      'Cổng Tra cứu Tri thức Dự án & Hỗ trợ Tư vấn Thông minh 24/7 — Chuẩn Xanh EDGE',
      '',
      '#1E40FF',
      welcomeMessage,
      systemInstruction,
      JSON.stringify(starterPrompts),
      authMode,
      JSON.stringify({
        showcase_template: 'enterprise_knowledge_portal',
        brand_badge: 'FREE FOREVER • BYOK GEMINI',
      }),
    ]
  );

  // 2. Upsert 5 Logical Collections
  const collectionIdBySlug = new Map<string, string>();
  for (const col of ECOLIFE_COLLECTIONS) {
    const colId = deterministicUuid(ns, `col:${col.slug}`);
    collectionIdBySlug.set(col.slug, colId);
    await client.query(
      `INSERT INTO dom_ai_collections (
         id, tenant_id, portal_id, slug, name, description, icon, color, sort_order, is_public, doc_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)
       ON CONFLICT (id)
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         icon = EXCLUDED.icon,
         color = EXCLUDED.color,
         sort_order = EXCLUDED.sort_order,
         is_public = EXCLUDED.is_public,
         updated_at = clock_timestamp()`,
      [
        colId,
        tenantId,
        portalId,
        col.slug,
        col.name,
        col.description,
        col.icon,
        col.color,
        col.sort_order,
        col.is_public,
      ]
    );
  }

  // 3. Parse canonical PHP docs, filter pure floorplan/unit-picker entries, migrate & index
  const parsed = parseEcoLifeCanonicalSeedDocs(opts.phpSourcePath || DEFAULT_ECOLIFE_PHP_SEED_PATH);
  const allDocsToMigrate: CanonicalEcoLifePhpDoc[] = [...parsed.docs];
  const derivedAmenities = buildDerivedAmenitiesQaDoc(parsed.docs);
  if (derivedAmenities) {
    allDocsToMigrate.push(derivedAmenities);
  }

  let totalChunks = 0;
  for (let i = 0; i < allDocsToMigrate.length; i++) {
    const doc = allDocsToMigrate[i];
    const colSlug = mapEcoLifeCategoryToCollectionSlug(doc.category);
    const colId = collectionIdBySlug.get(colSlug) || null;
    const docId = deterministicUuid(ns, `doc:${doc.category}:${doc.title}`);
    const docType = doc.source_type === 'qa' ? 'qa' : 'document';
    const tags = String(doc.tags || '')
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 25);
    const summary = doc.content
      .replace(/^#+\s*/gm, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    const boost = Number.isFinite(Number(doc.relevance_boost))
      ? Math.max(0.5, Math.min(3, Number(doc.relevance_boost)))
      : 1.0;

    await client.query(
      `INSERT INTO dom_ai_documents (
         id, tenant_id, portal_id, collection_id, title, doc_type, content, summary,
         tags_json, attachment_url, thumbnail_url, relevance_boost, chunk_count, status
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9::jsonb, '', '', $10, 0, 'active'
       )
       ON CONFLICT (id)
       DO UPDATE SET
         collection_id = EXCLUDED.collection_id,
         title = EXCLUDED.title,
         doc_type = EXCLUDED.doc_type,
         content = EXCLUDED.content,
         summary = EXCLUDED.summary,
         tags_json = EXCLUDED.tags_json,
         relevance_boost = EXCLUDED.relevance_boost,
         status = 'active',
         updated_at = clock_timestamp()`,
      [
        docId,
        tenantId,
        portalId,
        colId,
        doc.title.slice(0, 300),
        docType,
        doc.content,
        summary,
        JSON.stringify(tags),
        boost,
      ]
    );

    const indexed = await indexDomAiDocumentInTx(client, tenantId, docId);
    totalChunks += indexed.chunk_count;
  }

  await recomputeCollectionDocCountsInTx(client, tenantId, portalId);

  // 4. Seed realistic Viewer accounts
  let viewersSeeded = 0;
  const viewerRows: Array<{ id: string; email: string; full_name: string }> = [];

  if (opts.seedViewers !== false) {
    const sampleViewers = [
      {
        email: 'minh.khoi@chghomes.vn',
        full_name: 'Nguyễn Minh Khôi',
        role: 'admin',
        department: 'Ban Quản lý Bán hàng CHG Homes',
        allowed_collections: [] as string[],
        access_code: 'CHG2026',
        hours_ago: 1,
        message_count: 14,
      },
      {
        email: 'lan.anh@tunglongland.vn',
        full_name: 'Trần Thị Lan Anh',
        role: 'viewer',
        department: 'Đại lý F1 — Tùng Long Land',
        allowed_collections: [] as string[],
        access_code: 'TL2026',
        hours_ago: 3,
        message_count: 11,
      },
      {
        email: 'quoc.huy@hopnhatland.vn',
        full_name: 'Lê Quốc Huy',
        role: 'viewer',
        department: 'Đại lý F1 — Hợp Nhất Land',
        allowed_collections: [] as string[],
        access_code: 'HN2026',
        hours_ago: 6,
        message_count: 8,
      },
      {
        email: 'thu.ha@ihdgroup.vn',
        full_name: 'Phạm Thu Hà',
        role: 'viewer',
        department: 'Đại lý F1 — IHD Group',
        allowed_collections: [
          collectionIdBySlug.get('tong-quan-vi-tri')!,
          collectionIdBySlug.get('san-pham-thiet-ke')!,
          collectionIdBySlug.get('chinh-sach-phap-ly')!,
        ].filter(Boolean),
        access_code: 'IHD2026',
        hours_ago: 12,
        message_count: 6,
      },
      {
        email: 'hoang.nam@capitalhouse.vn',
        full_name: 'Đặng Hoàng Nam',
        role: 'admin',
        department: 'Phòng Pháp chế & Tri thức Capital House',
        allowed_collections: [] as string[],
        access_code: null,
        hours_ago: 24,
        message_count: 5,
      },
    ];

    for (const v of sampleViewers) {
      const uid = deterministicUuid(ns, `viewer:${v.email}`);
      const lastActive = new Date(Date.now() - v.hours_ago * 3_600_000).toISOString();
      await client.query(
        `INSERT INTO dom_ai_portal_users (
           id, tenant_id, portal_id, email, full_name, role, department,
           allowed_collection_ids_json, access_code, status, last_active_at, message_count
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8::jsonb, $9, 'active', $10, $11
         )
         ON CONFLICT (id)
         DO UPDATE SET
           full_name = EXCLUDED.full_name,
           department = EXCLUDED.department,
           allowed_collection_ids_json = EXCLUDED.allowed_collection_ids_json,
           status = 'active',
           updated_at = clock_timestamp()`,
        [
          uid,
          tenantId,
          portalId,
          v.email,
          v.full_name,
          v.role,
          v.department,
          JSON.stringify(v.allowed_collections),
          v.access_code,
          lastActive,
          v.message_count,
        ]
      );
      viewerRows.push({ id: uid, email: v.email, full_name: v.full_name });
      viewersSeeded++;
    }
  }

  // 5. Seed realistic Vietnamese Q&A conversations with REAL RAG citations, groups & feedback
  let conversationsSeeded = 0;
  let messagesSeeded = 0;

  if (opts.seedConversations !== false && viewerRows.length > 0) {
    const primaryViewer = viewerRows[1] || viewerRows[0];

    const groups = [
      { slug: 'chinh-sach-vay', name: 'Chính sách & Vay Ngân hàng', color: '#10B981', sort: 1 },
      { slug: 'san-pham-ban-giao', name: 'Thiết kế & Bàn giao 20/11', color: '#1E40FF', sort: 2 },
      { slug: 'phap-ly-mo-ban', name: 'Pháp lý & Lịch mở bán', color: '#7C3AED', sort: 3 },
    ];
    const groupIds = new Map<string, string>();
    for (const g of groups) {
      const gid = deterministicUuid(ns, `group:${primaryViewer.email}:${g.slug}`);
      groupIds.set(g.slug, gid);
      await client.query(
        `INSERT INTO dom_ai_groups (id, tenant_id, portal_id, portal_user_email, name, color, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [gid, tenantId, portalId, primaryViewer.email, g.name, g.color, g.sort]
      );
    }

    const demoConversations: Array<{
      key: string;
      viewerIdx: number;
      title: string;
      groupSlug: string | null;
      isStarred: boolean;
      daysAgo: number;
      turns: Array<{
        q: string;
        a: string;
        latencyMs: number;
        feedback: 'up' | 'down' | null;
        feedbackNote: string | null;
      }>;
    }> = [
      {
        key: 'seabank-pa1',
        viewerIdx: 1,
        title: 'Chính sách vay SeABank giải ngân song song 9% Đợt 1',
        groupSlug: 'chinh-sach-vay',
        isStarred: true,
        daysAgo: 0,
        turns: [
          {
            q: 'Khách vay SeABank theo Phương án 1 cần chuẩn bị bao nhiêu % vốn tự có Đợt 1?',
            a: 'Theo **Chính sách vay giải ngân song song SeABank (Phương án 1 — Ký HĐMB trực tiếp CĐT, 05 đợt)** [1]:\n\n- **Đợt 1 (Tổng 30% khi ký HĐMB trong 07 ngày):** Khách hàng chỉ cần chuẩn bị **9% vốn tự có** (đã bao gồm tiền đặt cọc), **SeABank giải ngân đối ứng ngay 21%**.\n- **Lộ trình các đợt tiếp theo:** Đợt 2 (6% tự có + 14% SeABank), Đợt 3 khi cất nóc (6% tự có + 14% SeABank), Đợt 4 khi bàn giao T05/2027 (9% tự có + 16% SeABank), Đợt 5 nhận Sổ hồng (0% tự có + 5% SeABank).\n- **Ưu đãi lãi suất:** Hỗ trợ lãi suất **0% trong 18 tháng** (mức CĐT hỗ trợ tối đa **10,5%/năm**) cho dư nợ tối đa **70% giá trị căn hộ** [1][2].',
            latencyMs: 680,
            feedback: 'up',
            feedbackNote: 'Rất rõ ràng, đúng số liệu từng đợt thanh toán.',
          },
        ],
      },
      {
        key: 'vat-lieu-20-11',
        viewerIdx: 1,
        title: 'Danh mục vật liệu bàn giao căn hộ khối tháp 20/11/2026',
        groupSlug: 'san-pham-ban-giao',
        isStarred: true,
        daysAgo: 1,
        turns: [
          {
            q: 'Danh mục vật liệu bàn giao căn hộ khối tháp cập nhật 20/11/2026 gồm những thiết bị nổi bật nào?',
            a: 'Theo **Phụ lục III — Danh mục vật liệu & trang thiết bị hoàn thiện Căn hộ Khối tháp (bản cập nhật mới nhất 20/11/2026)** [1]:\n\n- **Sàn căn hộ:** Cả Phòng khách, Phòng ngủ và Khu bếp đều lát **sàn gỗ công nghiệp vân gỗ nhập khẩu dày 8mm cốt HDF đen** chịu nước, chịu mài mòn, chống cháy (hoặc sàn SPC tương đương).\n- **Cửa & Kính chuẩn EDGE:** Cửa chính gỗ chống cháy kèm **khóa từ nhập khẩu 4 chức năng**; cửa sổ và cửa logia nhôm hệ **Xingfa** kèm **kính dán an toàn Solar Control** đạt chuẩn công trình xanh EDGE.\n- **Điều hòa:** Bàn giao sẵn **điều hòa cục bộ 1 chiều Samsung / LG / Midea / Hisense** tại phòng khách và tất cả phòng ngủ.\n- **Bếp & Vệ sinh:** Tủ bếp trên dưới **MDF lõi xanh chống ẩm** phủ Melamine, bếp từ **Elmich / Sunhouse / Buchen**, hút mùi **Canzy / Sunhouse / Buchen**, thiết bị vệ sinh **Bravat / Inax / Clara**, vách kính cabin tắm và bình nóng lạnh **Ferroli / Picenza / Tân Á Đại Thành** [1].',
            latencyMs: 740,
            feedback: 'up',
            feedbackNote: null,
          },
        ],
      },
      {
        key: 'edge-chung-chi-xanh',
        viewerIdx: 2,
        title: 'Chứng chỉ Xanh Quốc tế EDGE & 3 chỉ số tiết kiệm',
        groupSlug: null,
        isStarred: false,
        daysAgo: 2,
        turns: [
          {
            q: 'Chứng chỉ xanh EDGE của EcoLife Signature do tổ chức nào cấp và tiết kiệm bao nhiêu % điện nước?',
            a: 'Dự án **EcoLife Signature** đạt **Chứng chỉ Công trình Xanh Quốc tế EDGE** số **`LP1-VNM-25121810257936-376-P`** (cấp ngày `31/03/2026`), được **SGS** thẩm định và **IFC (thành viên Nhóm Ngân hàng Thế giới — World Bank)** cấp [1]:\n\n- **Tiết kiệm 24% (23,56%) điện năng:** Nhờ kính dán an toàn cản nhiệt Solar Control, sơn phản xạ nhiệt, điều hòa hiệu suất cao và 100% đèn LED.\n- **Tiết kiệm 30% (29,58%) lượng nước:** Vòi tiết kiệm nước `4,8 L/phút`, bồn cầu xả xoáy 2 chế độ và mô hình Đô thị Bọt biển (Sponge City).\n- **Tiết kiệm 30% năng lượng hàm chứa trong vật liệu:** Giảm phát thải **394,48 tấn CO₂/năm** và giúp công trình mát hơn **2–4°C** [1].',
            latencyMs: 590,
            feedback: 'up',
            feedbackNote: 'Số chứng chỉ EDGE rất chính xác để thuyết trình khách.',
          },
        ],
      },
      {
        key: 'phap-ly-nguoi-nuoc-ngoai',
        viewerIdx: 3,
        title: 'Hồ sơ pháp lý GPXD 414 & quy định khách nước ngoài',
        groupSlug: null,
        isStarred: false,
        daysAgo: 3,
        turns: [
          {
            q: 'Dự án đã có giấy phép đủ điều kiện bán chưa và người nước ngoài có mua được không?',
            a: 'EcoLife Signature đã hoàn thiện **100% bộ 06 văn bản pháp lý mở bán** [1]:\n\n1. **GPXD số `414/GPXD`** (11/09/2025) của Sở Xây dựng TP. Đà Nẵng.\n2. **Văn bản đủ điều kiện bán nhà ở hình thành trong tương lai số `12529/SXD-QLN`** (09/07/2026).\n3. **Ngân hàng bảo lãnh:** Agribank Chi nhánh Hà Nội.\n4. **Tiến độ:** Cất nóc dự kiến cuối Tháng 12/2026, bàn giao nhà Tháng 05/2027 và Sổ hồng sở hữu lâu dài Quý IV/2027.\n\n**Lưu ý quan trọng:** Theo Công văn `12529/SXD-QLN`, dự án **không bán cho tổ chức, cá nhân nước ngoài** (100% khách hàng mua là công dân/tổ chức Việt Nam) [1].',
            latencyMs: 620,
            feedback: 'up',
            feedbackNote: null,
          },
        ],
      },
      {
        key: 'can-3pn-b6-3wc',
        viewerIdx: 0,
        title: 'Chi tiết căn 3PN 3WC Mẫu B6 & quà tặng vàng Early Bird',
        groupSlug: null,
        isStarred: false,
        daysAgo: 4,
        turns: [
          {
            q: 'Mẫu căn 3PN nào có 3 nhà vệ sinh riêng biệt và được tặng mấy chỉ vàng?',
            a: 'Dự án có mẫu **Căn hộ 3PN Mẫu B6 (87,1 m² thông thủy — Trục 09 Tháp S-H)** và **Mẫu B5 (99,3–99,4 m² — Trục 03A Tháp S-G)** trang bị tới **03 Phòng vệ sinh (3WC) và 02 Ban công** [1][2].\n\n- Vì diện tích thông thủy đều **từ 80 m² trở lên**, khách hàng thuộc 50 giao dịch Booking sớm đầu tiên (đến hết 31/12/2026) được tặng **02 chỉ vàng Lộc Phát (quy đổi 28.000.000 VNĐ)** trừ trực tiếp vào giá bán theo CSBH số `24/2026/CSBH` [3].',
            latencyMs: 710,
            feedback: 'up',
            feedbackNote: null,
          },
        ],
      },
      {
        key: 'phi-quan-ly-xe',
        viewerIdx: 2,
        title: 'Hỏi về biểu phí quản lý vận hành & phí gửi ô tô hàng tháng',
        groupSlug: null,
        isStarred: false,
        daysAgo: 5,
        turns: [
          {
            q: 'Phí quản lý vận hành hàng tháng và phí gửi xe ô tô tại tầng hầm EcoLife Signature là bao nhiêu?',
            a: 'Hiện tại bộ tài liệu chính thức trong kho tri thức chưa ban hành biểu phí quản lý vận hành hàng tháng và mức phí gửi xe ô tô cố định. Anh/Chị vui lòng cập nhật thêm Q&A biểu phí từ Ban Quản lý Dự án để trợ lý trả lời chính xác cho khách hàng.',
            latencyMs: 410,
            feedback: 'down',
            feedbackNote: 'Cần Admin bổ sung tài liệu Q&A biểu phí quản lý & phí gửi xe dự kiến.',
          },
        ],
      },
    ];

    for (const c of demoConversations) {
      const viewer = viewerRows[c.viewerIdx] || primaryViewer;
      const convId = deterministicUuid(ns, `conv:${c.key}`);
      const baseTime = Date.now() - c.daysAgo * 86_400_000 - 3_600_000;
      const lastTime = new Date(baseTime + c.turns.length * 15_000).toISOString();
      const createdTime = new Date(baseTime).toISOString();
      const gId = c.groupSlug && viewer.email === primaryViewer.email ? groupIds.get(c.groupSlug) || null : null;

      await client.query(
        `INSERT INTO dom_ai_conversations (
           id, tenant_id, portal_id, portal_user_id, user_email, user_name,
           title, group_id, is_starred, message_count, last_message_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id)
         DO UPDATE SET
           title = EXCLUDED.title,
           is_starred = EXCLUDED.is_starred,
           message_count = EXCLUDED.message_count`,
        [
          convId,
          tenantId,
          portalId,
          viewer.id,
          viewer.email,
          viewer.full_name,
          c.title,
          gId,
          c.isStarred,
          c.turns.length * 2,
          lastTime,
          createdTime,
        ]
      );
      conversationsSeeded++;

      for (let tIdx = 0; tIdx < c.turns.length; tIdx++) {
        const turn = c.turns[tIdx];
        const uMsgId = deterministicUuid(ns, `msg:${c.key}:u:${tIdx}`);
        const aMsgId = deterministicUuid(ns, `msg:${c.key}:a:${tIdx}`);
        const uTime = new Date(baseTime + tIdx * 10_000).toISOString();
        const aTime = new Date(baseTime + tIdx * 10_000 + turn.latencyMs).toISOString();

        // Retrieve REAL citations from the indexed EcoLife chunks (except for intentionally unanswered demo item)
        let cites: DomAiCitation[] = [];
        if (turn.feedback !== 'down') {
          const ragHit = await searchDomAiKnowledgeInTx(client, tenantId, {
            portalId,
            query: turn.q,
            topK: 3,
            includePrivateCollections: true,
          });
          cites = ragHit.citations;
        }

        await client.query(
          `INSERT INTO dom_ai_messages (
             id, tenant_id, portal_id, conversation_id, role, content,
             citations_json, model, latency_ms, tokens_used, created_at
           ) VALUES ($1, $2, $3, $4, 'user', $5, '[]'::jsonb, '', 0, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [uMsgId, tenantId, portalId, convId, turn.q, Math.ceil(turn.q.length / 4), uTime]
        );

        await client.query(
          `INSERT INTO dom_ai_messages (
             id, tenant_id, portal_id, conversation_id, role, content,
             citations_json, model, latency_ms, tokens_used, feedback, feedback_note, created_at
           ) VALUES ($1, $2, $3, $4, 'assistant', $5, $6::jsonb, 'gemini-2.5-flash', $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [
            aMsgId,
            tenantId,
            portalId,
            convId,
            turn.a,
            JSON.stringify(cites),
            turn.latencyMs,
            Math.ceil((turn.q.length + turn.a.length) / 4),
            turn.feedback,
            turn.feedbackNote,
            aTime,
          ]
        );
        messagesSeeded += 2;
      }
    }
  }

  return {
    portal_id: portalId,
    portal_slug: portalSlug,
    collections_created: ECOLIFE_COLLECTIONS.length,
    documents_migrated: allDocsToMigrate.length,
    documents_filtered_out: parsed.filteredOut,
    chunks_indexed: totalChunks,
    viewers_seeded: viewersSeeded,
    conversations_seeded: conversationsSeeded,
    messages_seeded: messagesSeeded,
    source_mode: parsed.sourceMode,
  };
}

// ============================================================================
// Safe Standalone CLI Runner (NEVER touches live `./.autodata-pgdata`!)
// Usage:
//   npx tsx scripts/seed-ecolife-dom-ai.ts --in-memory
//   npx tsx scripts/seed-ecolife-dom-ai.ts --data-dir ./tmp-dom-ai-demo
// ============================================================================
async function runCli(): Promise<void> {
  process.env.OUTBOUND_SILENT_MODE = 'true';
  process.env.TELEGRAM_SILENT_MODE = 'true';
  process.env.MIGRATION_SILENT_MODE = 'true';

  const args = process.argv.slice(2);
  let dataDir = '';
  let inMemory = true;
  let tenantSlug = 'ecolife';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) {
      dataDir = args[i + 1];
      inMemory = false;
      i++;
    } else if (args[i] === '--in-memory') {
      inMemory = true;
    } else if (args[i] === '--tenant-slug' && args[i + 1]) {
      tenantSlug = args[i + 1].trim().toLowerCase();
      i++;
    }
  }

  if (!inMemory) {
    const resolvedTarget = path.resolve(dataDir);
    const forbiddenLive = path.resolve(process.cwd(), '.autodata-pgdata');
    if (
      resolvedTarget === forbiddenLive ||
      resolvedTarget.startsWith(forbiddenLive + path.sep) ||
      resolvedTarget.toLowerCase().includes('.autodata-pgdata')
    ) {
      console.error(
        'REFUSED: scripts/seed-ecolife-dom-ai.ts NEVER targets live ./.autodata-pgdata. Pass --in-memory or a temporary --data-dir <temp>.'
      );
      process.exit(1);
    }
  }

  const pool = createDatabasePool(inMemory ? { inMemory: true } : { dataDir });
  setDatabasePool(pool);

  try {
    await runDatabaseMigrations({ seedSuperAdmin: false });
    await runDomAiPortalSchema();

    const tenantId = deterministicUuid('dom-ai-cli-tenant', tenantSlug);
    const setupClient = await pool.connect();
    try {
      const existingTenant = await setupClient.query<{ id: string }>(
        `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
        [tenantSlug]
      );
      if (!existingTenant.rows[0]) {
        await setupClient.query(
          `INSERT INTO tenants (id, name, slug, industry, status, plan_tier, settings)
           VALUES ($1, $2, $3, 'real_estate', 'active', 'enterprise', '{}'::jsonb)`,
          [tenantId, 'EcoLife Signature - Capital House', tenantSlug]
        );
      }
    } finally {
      setupClient.release();
    }

    const effectiveTenantId = await (async () => {
      const c = await pool.connect();
      try {
        const r = await c.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [
          tenantSlug,
        ]);
        return String(r.rows[0].id);
      } finally {
        c.release();
      }
    })();

    const summary = await withTenantTransaction(effectiveTenantId, (client) =>
      seedEcoLifeDomAiPortalInTx(client, effectiveTenantId)
    );

    console.log(
      JSON.stringify(
        {
          success: true,
          mode: inMemory ? 'in_memory' : `temp_dir:${path.resolve(dataDir)}`,
          tenant_id: effectiveTenantId,
          tenant_slug: tenantSlug,
          ...summary,
        },
        null,
        2
      )
    );
  } finally {
    await pool.close();
    setDatabasePool(null);
  }
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  runCli().catch((err) => {
    console.error('[seed-ecolife-dom-ai] Failed:', err);
    process.exit(1);
  });
}
