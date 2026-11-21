import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../../core/database/transaction.ts';

const initializedPools = new WeakSet<object>();
const inFlightInitializations = new WeakMap<object, Promise<void>>();

export const DOM_AI_PORTAL_TABLES = [
  'dom_ai_portals',
  'dom_ai_collections',
  'dom_ai_documents',
  'dom_ai_chunks',
  'dom_ai_portal_users',
  'dom_ai_groups',
  'dom_ai_conversations',
  'dom_ai_messages',
] as const;

export type DomAiAuthMode = 'public_bypass' | 'open_login' | 'viewer_whitelist';
export type DomAiDocType = 'document' | 'qa' | 'url' | 'media';
export type DomAiDocStatus = 'active' | 'draft' | 'archived';
export type DomAiUserRole = 'admin' | 'viewer';
export type DomAiUserStatus = 'active' | 'suspended';
export type DomAiFeedbackValue = 'up' | 'down' | null;

export const DEFAULT_PORTAL_PRIMARY_COLOR = '#1E40FF';
export const DEFAULT_PORTAL_MODEL = 'gemini-2.5-flash';
export const DEFAULT_PORTAL_WELCOME =
  'Xin chào! Tôi là Trợ lý AI Tri thức Doanh nghiệp. Hãy đặt câu hỏi về tài liệu, chính sách, sản phẩm hoặc quy trình nội bộ — tôi sẽ trả lời chính xác kèm trích dẫn nguồn ngay lập tức.';
export const DEFAULT_PORTAL_SYSTEM_INSTRUCTION =
  'Bạn là Trợ lý AI Tri thức Doanh nghiệp chuyên nghiệp, lịch sự và trung thực. Chỉ sử dụng dữ liệu có trong Kho Tri thức được cung cấp để trả lời. Không bịa đặt số liệu ngoài tài liệu. Trình bày rõ ràng bằng Markdown, làm nổi bật các con số và điều khoản quan trọng, và luôn bám sát trích dẫn nguồn.';

export function parseJsonArray<T = unknown>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
  raw: unknown
): T {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as T;
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return {} as T;
}

export function slugifyDomAi(input: string, fallback = 'portal'): string {
  const base = String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || fallback;
}

async function runPostgresDomAiPortalDdl(client: DbClient): Promise<void> {
  const ddl = `
    -- 1. Standalone AI Knowledge Portals (100% generic multi-tenant SaaS, FREE BYOK)
    CREATE TABLE IF NOT EXISTS dom_ai_portals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug VARCHAR(100) NOT NULL UNIQUE,
      name VARCHAR(200) NOT NULL,
      tagline VARCHAR(300) NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '',
      primary_color VARCHAR(32) NOT NULL DEFAULT '#1E40FF',
      welcome_message TEXT NOT NULL DEFAULT '',
      system_instruction TEXT NOT NULL DEFAULT '',
      starter_prompts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      auth_mode VARCHAR(32) NOT NULL DEFAULT 'open_login'
        CHECK (auth_mode IN ('public_bypass', 'open_login', 'viewer_whitelist')),
      allow_guest_history BOOLEAN NOT NULL DEFAULT true,
      model VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
      temperature NUMERIC(4,2) NOT NULL DEFAULT 0.25,
      top_k INTEGER NOT NULL DEFAULT 6,
      is_active BOOLEAN NOT NULL DEFAULT true,
      is_free_byok BOOLEAN NOT NULL DEFAULT true,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_portals_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dom_ai_portals_slug_lower ON dom_ai_portals(LOWER(slug));
    CREATE INDEX IF NOT EXISTS idx_dom_ai_portals_tenant_active ON dom_ai_portals(tenant_id, is_active, updated_at DESC);

    -- 2. Knowledge Collections (ACL-capable folders per portal)
    CREATE TABLE IF NOT EXISTS dom_ai_collections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      portal_id UUID NOT NULL,
      slug VARCHAR(120) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon VARCHAR(60) NOT NULL DEFAULT 'BookOpen',
      color VARCHAR(32) NOT NULL DEFAULT '#1E40FF',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_public BOOLEAN NOT NULL DEFAULT true,
      doc_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_collections_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_dom_ai_collections_portal_slug UNIQUE (tenant_id, portal_id, slug),
      CONSTRAINT fk_dom_ai_collections_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dom_ai_collections_portal_sort
      ON dom_ai_collections(tenant_id, portal_id, sort_order ASC, name ASC);

    -- 3. Knowledge Documents (documents, Q&A pairs, URLs, media entries)
    CREATE TABLE IF NOT EXISTS dom_ai_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      portal_id UUID NOT NULL,
      collection_id UUID NULL,
      title VARCHAR(300) NOT NULL,
      doc_type VARCHAR(24) NOT NULL DEFAULT 'document'
        CHECK (doc_type IN ('document', 'qa', 'url', 'media')),
      content TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachment_url TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT NOT NULL DEFAULT '',
      relevance_boost NUMERIC(5,2) NOT NULL DEFAULT 1.00,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'draft', 'archived')),
      created_by UUID NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_documents_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_documents_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dom_ai_documents_portal_status
      ON dom_ai_documents(tenant_id, portal_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dom_ai_documents_collection
      ON dom_ai_documents(tenant_id, portal_id, collection_id);

    -- 4. Indexed Knowledge Chunks for Hybrid Vietnamese RAG
    CREATE TABLE IF NOT EXISTS dom_ai_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      portal_id UUID NOT NULL,
      document_id UUID NOT NULL,
      collection_id UUID NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      keywords_text TEXT NOT NULL DEFAULT '',
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_chunks_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_dom_ai_chunks_doc_idx UNIQUE (tenant_id, document_id, chunk_index),
      CONSTRAINT fk_dom_ai_chunks_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_chunks_document FOREIGN KEY (tenant_id, document_id)
        REFERENCES dom_ai_documents(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dom_ai_chunks_portal_doc
      ON dom_ai_chunks(tenant_id, portal_id, document_id, chunk_index ASC);
    CREATE INDEX IF NOT EXISTS idx_dom_ai_chunks_portal_col
      ON dom_ai_chunks(tenant_id, portal_id, collection_id);

    -- 5. Portal Viewers & Whitelist Access Control
    CREATE TABLE IF NOT EXISTS dom_ai_portal_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      portal_id UUID NOT NULL,
      email VARCHAR(255) NOT NULL,
      full_name VARCHAR(200) NOT NULL DEFAULT '',
      role VARCHAR(24) NOT NULL DEFAULT 'viewer'
        CHECK (role IN ('admin', 'viewer')),
      department VARCHAR(150) NOT NULL DEFAULT '',
      allowed_collection_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      access_code VARCHAR(100) NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended')),
      last_active_at TIMESTAMPTZ NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_portal_users_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_dom_ai_portal_users_portal_email UNIQUE (tenant_id, portal_id, email),
      CONSTRAINT fk_dom_ai_portal_users_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dom_ai_portal_users_lookup
      ON dom_ai_portal_users(tenant_id, portal_id, LOWER(email));

    -- 6. Custom Conversation Groups per Viewer
    CREATE TABLE IF NOT EXISTS dom_ai_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      portal_id UUID NOT NULL,
      portal_user_email VARCHAR(255) NOT NULL,
      name VARCHAR(150) NOT NULL,
      color VARCHAR(32) NOT NULL DEFAULT '#1E40FF',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_groups_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_groups_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dom_ai_groups_viewer
      ON dom_ai_groups(tenant_id, portal_id, LOWER(portal_user_email), sort_order ASC);

    -- 7. Portal Chat Conversations (Sessions)
    CREATE TABLE IF NOT EXISTS dom_ai_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      portal_id UUID NOT NULL,
      portal_user_id UUID NULL,
      user_email VARCHAR(255) NOT NULL DEFAULT '',
      user_name VARCHAR(200) NOT NULL DEFAULT '',
      title VARCHAR(255) NOT NULL DEFAULT 'Cuộc hội thoại mới',
      group_id UUID NULL,
      is_starred BOOLEAN NOT NULL DEFAULT false,
      collection_filter_id UUID NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_conversations_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_conversations_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dom_ai_conversations_viewer
      ON dom_ai_conversations(tenant_id, portal_id, LOWER(user_email), is_starred DESC, last_message_at DESC);

    -- 8. Portal Chat Messages with Citations & Feedback
    CREATE TABLE IF NOT EXISTS dom_ai_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      portal_id UUID NOT NULL,
      conversation_id UUID NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL DEFAULT '',
      citations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      model VARCHAR(80) NOT NULL DEFAULT '',
      latency_ms INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      feedback VARCHAR(16) NULL CHECK (feedback IS NULL OR feedback IN ('up', 'down')),
      feedback_note TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_dom_ai_messages_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_messages_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_messages_conv FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES dom_ai_conversations(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dom_ai_messages_conv_time
      ON dom_ai_messages(tenant_id, conversation_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_dom_ai_messages_portal_time
      ON dom_ai_messages(tenant_id, portal_id, role, created_at DESC);

    -- Enforce Strict Multi-Tenant PostgreSQL Row Level Security across all 8 tables
    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'dom_ai_portals',
        'dom_ai_collections',
        'dom_ai_documents',
        'dom_ai_chunks',
        'dom_ai_portal_users',
        'dom_ai_groups',
        'dom_ai_conversations',
        'dom_ai_messages'
      ]
      LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
        pol := 'tenant_isolation_' || tbl;
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = pol
        ) THEN
          EXECUTE format(
            'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
            pol, tbl
          );
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO autodata_app', tbl);
        END IF;
      END LOOP;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END $$;
  `;

  if (client.exec) {
    await client.exec(ddl);
  } else {
    await client.query(ddl);
  }
}

async function runMariaDbDomAiPortalDdl(client: DbClient): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS dom_ai_portals (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      slug VARCHAR(100) NOT NULL,
      name VARCHAR(200) NOT NULL,
      tagline VARCHAR(300) NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL,
      primary_color VARCHAR(32) NOT NULL DEFAULT '#1E40FF',
      welcome_message TEXT NOT NULL,
      system_instruction LONGTEXT NOT NULL,
      starter_prompts_json JSON NOT NULL,
      auth_mode VARCHAR(32) NOT NULL DEFAULT 'open_login',
      allow_guest_history TINYINT(1) NOT NULL DEFAULT 1,
      model VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
      temperature DECIMAL(4,2) NOT NULL DEFAULT 0.25,
      top_k INT NOT NULL DEFAULT 6,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_free_byok TINYINT(1) NOT NULL DEFAULT 1,
      metadata_json JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_portals_slug UNIQUE (slug),
      CONSTRAINT uk_dom_ai_portals_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_portals_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      INDEX idx_dom_ai_portals_tenant_active (tenant_id, is_active, updated_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS dom_ai_collections (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      portal_id VARCHAR(36) NOT NULL,
      slug VARCHAR(120) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      icon VARCHAR(60) NOT NULL DEFAULT 'BookOpen',
      color VARCHAR(32) NOT NULL DEFAULT '#1E40FF',
      sort_order INT NOT NULL DEFAULT 0,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      doc_count INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_collections_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_dom_ai_collections_portal_slug UNIQUE (tenant_id, portal_id, slug),
      CONSTRAINT fk_dom_ai_collections_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_collections_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_dom_ai_collections_portal_sort (tenant_id, portal_id, sort_order ASC, name ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS dom_ai_documents (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      portal_id VARCHAR(36) NOT NULL,
      collection_id VARCHAR(36) NULL,
      title VARCHAR(300) NOT NULL,
      doc_type VARCHAR(24) NOT NULL DEFAULT 'document',
      content LONGTEXT NOT NULL,
      summary TEXT NOT NULL,
      tags_json JSON NOT NULL,
      attachment_url TEXT NOT NULL,
      thumbnail_url TEXT NOT NULL,
      relevance_boost DECIMAL(5,2) NOT NULL DEFAULT 1.00,
      chunk_count INT NOT NULL DEFAULT 0,
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_documents_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_documents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_documents_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_dom_ai_documents_portal_status (tenant_id, portal_id, status, updated_at DESC),
      INDEX idx_dom_ai_documents_collection (tenant_id, portal_id, collection_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS dom_ai_chunks (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      portal_id VARCHAR(36) NOT NULL,
      document_id VARCHAR(36) NOT NULL,
      collection_id VARCHAR(36) NULL,
      chunk_index INT NOT NULL DEFAULT 0,
      content LONGTEXT NOT NULL,
      keywords_text TEXT NOT NULL,
      token_estimate INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_chunks_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_dom_ai_chunks_doc_idx UNIQUE (tenant_id, document_id, chunk_index),
      CONSTRAINT fk_dom_ai_chunks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_chunks_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_chunks_document FOREIGN KEY (tenant_id, document_id)
        REFERENCES dom_ai_documents(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_dom_ai_chunks_portal_doc (tenant_id, portal_id, document_id, chunk_index ASC),
      INDEX idx_dom_ai_chunks_portal_col (tenant_id, portal_id, collection_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS dom_ai_portal_users (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      portal_id VARCHAR(36) NOT NULL,
      email VARCHAR(255) NOT NULL,
      full_name VARCHAR(200) NOT NULL DEFAULT '',
      role VARCHAR(24) NOT NULL DEFAULT 'viewer',
      department VARCHAR(150) NOT NULL DEFAULT '',
      allowed_collection_ids_json JSON NOT NULL,
      access_code VARCHAR(100) NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      last_active_at DATETIME(6) NULL,
      message_count INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_portal_users_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_dom_ai_portal_users_portal_email UNIQUE (tenant_id, portal_id, email),
      CONSTRAINT fk_dom_ai_portal_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_portal_users_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_dom_ai_portal_users_lookup (tenant_id, portal_id, email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS dom_ai_groups (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      portal_id VARCHAR(36) NOT NULL,
      portal_user_email VARCHAR(255) NOT NULL,
      name VARCHAR(150) NOT NULL,
      color VARCHAR(32) NOT NULL DEFAULT '#1E40FF',
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_groups_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_groups_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_groups_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_dom_ai_groups_viewer (tenant_id, portal_id, portal_user_email, sort_order ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS dom_ai_conversations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      portal_id VARCHAR(36) NOT NULL,
      portal_user_id VARCHAR(36) NULL,
      user_email VARCHAR(255) NOT NULL DEFAULT '',
      user_name VARCHAR(200) NOT NULL DEFAULT '',
      title VARCHAR(255) NOT NULL DEFAULT 'Cuộc hội thoại mới',
      group_id VARCHAR(36) NULL,
      is_starred TINYINT(1) NOT NULL DEFAULT 0,
      collection_filter_id VARCHAR(36) NULL,
      message_count INT NOT NULL DEFAULT 0,
      last_message_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_conversations_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_conversations_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_conversations_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_dom_ai_conversations_viewer (tenant_id, portal_id, user_email, is_starred DESC, last_message_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS dom_ai_messages (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      portal_id VARCHAR(36) NOT NULL,
      conversation_id VARCHAR(36) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content LONGTEXT NOT NULL,
      citations_json JSON NOT NULL,
      model VARCHAR(80) NOT NULL DEFAULT '',
      latency_ms INT NOT NULL DEFAULT 0,
      tokens_used INT NOT NULL DEFAULT 0,
      feedback VARCHAR(16) NULL,
      feedback_note TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_dom_ai_messages_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_dom_ai_messages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_messages_portal FOREIGN KEY (tenant_id, portal_id)
        REFERENCES dom_ai_portals(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_dom_ai_messages_conv FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES dom_ai_conversations(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_dom_ai_messages_conv_time (tenant_id, conversation_id, created_at ASC),
      INDEX idx_dom_ai_messages_portal_time (tenant_id, portal_id, role, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }
}

export async function runDomAiPortalSchema(): Promise<void> {
  const pool = getDatabasePool();
  if (initializedPools.has(pool)) {
    return;
  }

  const pending = inFlightInitializations.get(pool);
  if (pending) {
    return pending;
  }

  const initPromise = withSystemPrivilege(async (client) => {
    if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
      await runMariaDbDomAiPortalDdl(client);
    } else {
      await runPostgresDomAiPortalDdl(client);
    }
    initializedPools.add(pool);
  }).finally(() => {
    inFlightInitializations.delete(pool);
  });

  inFlightInitializations.set(pool, initPromise);
  return initPromise;
}

export const ensureDomAiPortalSchema = runDomAiPortalSchema;
