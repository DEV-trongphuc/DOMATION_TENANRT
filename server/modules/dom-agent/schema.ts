import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../../core/database/transaction.ts';

const initializedPools = new WeakSet<object>();
const inFlightInitializations = new WeakMap<object, Promise<void>>();

export const DOM_AGENT_TABLES = [
  'tenant_ai_agent_configs',
  'tenant_ai_knowledge_docs',
  'tenant_ai_knowledge_chunks',
  'tenant_ai_threads',
  'tenant_ai_messages',
  'tenant_ai_tool_audit_logs',
] as const;

export const DEFAULT_DOM_AGENT_NAME = 'DOM Agent';
export const DEFAULT_DOM_AGENT_AVATAR = '/imgs/autodata/ICON.png';
export const DEFAULT_DOM_AGENT_GREETING =
  'Xin chào! Tôi là DOM Agent — Trợ lý AI điều hành doanh nghiệp thông minh, tuân thủ nghiêm ngặt phân quyền RBAC và kho tri thức nội bộ của tổ chức bạn.';

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

async function runPostgresDomAgentDdl(client: DbClient): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS tenant_ai_agent_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_name VARCHAR(120) NOT NULL DEFAULT 'DOM Agent',
      avatar_url TEXT NOT NULL DEFAULT '/imgs/autodata/ICON.png',
      greeting_message TEXT NOT NULL DEFAULT 'Xin chào! Tôi là DOM Agent — Trợ lý AI điều hành doanh nghiệp thông minh, tuân thủ nghiêm ngặt phân quyền RBAC và kho tri thức nội bộ của tổ chức bạn.',
      persona_tone VARCHAR(50) NOT NULL DEFAULT 'executive_concise',
      preferred_model VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
      temperature NUMERIC(4,2) NOT NULL DEFAULT 0.25,
      enable_morning_briefing BOOLEAN NOT NULL DEFAULT true,
      guardrail_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_only UNIQUE (tenant_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_docs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'company_policy',
      source_type VARCHAR(30) NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'policy_sync', 'file_upload')),
      source_policy_id UUID,
      file_name VARCHAR(255),
      content_text TEXT NOT NULL DEFAULT '',
      allowed_department_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_knowledge_docs_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_kdocs_tenant_active ON tenant_ai_knowledge_docs(tenant_id, is_active, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_kdocs_policy_sync ON tenant_ai_knowledge_docs(tenant_id, source_policy_id);

    CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      doc_id UUID NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      chunk_text TEXT NOT NULL,
      keywords_text TEXT NOT NULL DEFAULT '',
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_doc_idx UNIQUE (tenant_id, doc_id, chunk_index),
      CONSTRAINT fk_ai_kchunks_doc FOREIGN KEY (tenant_id, doc_id) REFERENCES tenant_ai_knowledge_docs(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_kchunks_tenant_doc ON tenant_ai_knowledge_chunks(tenant_id, doc_id, chunk_index ASC);

    CREATE TABLE IF NOT EXISTS tenant_ai_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      specialist_key VARCHAR(50) NOT NULL DEFAULT 'orchestrator',
      title VARCHAR(255) NOT NULL DEFAULT 'Cuộc hội thoại mới',
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_threads_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_threads_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_threads_tenant_user ON tenant_ai_threads(tenant_id, user_id, is_pinned DESC, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_ai_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      thread_id UUID NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      content TEXT NOT NULL DEFAULT '',
      tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
      citations JSONB NOT NULL DEFAULT '[]'::jsonb,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      model_used VARCHAR(80),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_messages_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_messages_thread FOREIGN KEY (tenant_id, thread_id) REFERENCES tenant_ai_threads(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_thread_created ON tenant_ai_messages(tenant_id, thread_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS tenant_ai_tool_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      tool_name VARCHAR(100) NOT NULL,
      module_key VARCHAR(64) NOT NULL,
      required_action VARCHAR(40) NOT NULL,
      data_scope VARCHAR(30) NOT NULL DEFAULT 'none',
      allowed BOOLEAN NOT NULL DEFAULT false,
      denial_reason TEXT,
      args_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ai_tool_audit_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_tool_audit_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_tool_audit_tenant_created ON tenant_ai_tool_audit_logs(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_tool_audit_user_created ON tenant_ai_tool_audit_logs(tenant_id, user_id, created_at DESC);

    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_ai_agent_configs',
        'tenant_ai_knowledge_docs',
        'tenant_ai_knowledge_chunks',
        'tenant_ai_threads',
        'tenant_ai_messages',
        'tenant_ai_tool_audit_logs'
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

async function runMariaDbDomAgentDdl(client: DbClient): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS tenant_ai_agent_configs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      agent_name VARCHAR(120) NOT NULL DEFAULT 'DOM Agent',
      avatar_url TEXT NOT NULL,
      greeting_message TEXT NOT NULL,
      persona_tone VARCHAR(50) NOT NULL DEFAULT 'executive_concise',
      preferred_model VARCHAR(80) NOT NULL DEFAULT 'gemini-2.5-flash',
      temperature DECIMAL(4,2) NOT NULL DEFAULT 0.25,
      enable_morning_briefing TINYINT(1) NOT NULL DEFAULT 1,
      guardrail_rules JSON NOT NULL,
      updated_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_agent_configs_tenant_only UNIQUE (tenant_id),
      CONSTRAINT fk_ai_cfg_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_docs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'company_policy',
      source_type VARCHAR(30) NOT NULL DEFAULT 'manual',
      source_policy_id VARCHAR(36) NULL,
      file_name VARCHAR(255) NULL,
      content_text LONGTEXT NOT NULL,
      allowed_department_ids JSON NOT NULL,
      chunk_count INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_knowledge_docs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_kdocs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      INDEX idx_ai_kdocs_tenant_active (tenant_id, is_active, updated_at DESC),
      INDEX idx_ai_kdocs_policy_sync (tenant_id, source_policy_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_ai_knowledge_chunks (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      doc_id VARCHAR(36) NOT NULL,
      chunk_index INT NOT NULL DEFAULT 0,
      chunk_text LONGTEXT NOT NULL,
      keywords_text TEXT NOT NULL,
      token_estimate INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_ai_knowledge_chunks_doc_idx UNIQUE (tenant_id, doc_id, chunk_index),
      CONSTRAINT fk_ai_kchunks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_kchunks_doc FOREIGN KEY (tenant_id, doc_id) REFERENCES tenant_ai_knowledge_docs(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_kchunks_tenant_doc (tenant_id, doc_id, chunk_index ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_ai_threads (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      specialist_key VARCHAR(50) NOT NULL DEFAULT 'orchestrator',
      title VARCHAR(255) NOT NULL DEFAULT 'Cuộc hội thoại mới',
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      last_message_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_threads_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_threads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_threads_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_threads_tenant_user (tenant_id, user_id, is_pinned DESC, last_message_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_ai_messages (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      thread_id VARCHAR(36) NOT NULL,
      role VARCHAR(20) NOT NULL,
      content LONGTEXT NOT NULL,
      tool_calls JSON NOT NULL,
      citations JSON NOT NULL,
      latency_ms INT NOT NULL DEFAULT 0,
      model_used VARCHAR(80) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_messages_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_messages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_messages_thread FOREIGN KEY (tenant_id, thread_id) REFERENCES tenant_ai_threads(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_messages_thread_created (tenant_id, thread_id, created_at ASC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_ai_tool_audit_logs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      tool_name VARCHAR(100) NOT NULL,
      module_key VARCHAR(64) NOT NULL,
      required_action VARCHAR(40) NOT NULL,
      data_scope VARCHAR(30) NOT NULL DEFAULT 'none',
      allowed TINYINT(1) NOT NULL DEFAULT 0,
      denial_reason TEXT NULL,
      args_summary JSON NOT NULL,
      latency_ms INT NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ai_tool_audit_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_ai_tool_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_ai_tool_audit_user FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      INDEX idx_ai_tool_audit_tenant_created (tenant_id, created_at DESC),
      INDEX idx_ai_tool_audit_user_created (tenant_id, user_id, created_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }
}

/**
 * Self-initializing Multi-Tenant Schema for `DOM Agent`, memoized per database pool via WeakSet.
 */
export async function ensureDomAgentSchema(): Promise<void> {
  const pool = getDatabasePool();
  if (initializedPools.has(pool)) {
    return;
  }

  let pending = inFlightInitializations.get(pool);
  if (!pending) {
    pending = withSystemPrivilege(async (client) => {
      if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
        await runMariaDbDomAgentDdl(client);
      } else {
        await runPostgresDomAgentDdl(client);
      }
      initializedPools.add(pool);
    }).finally(() => {
      inFlightInitializations.delete(pool);
    });
    inFlightInitializations.set(pool, pending);
  }

  await pending;
}
