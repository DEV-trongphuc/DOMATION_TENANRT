import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  resolveUserEffectivePermissions,
  type ResolvedUserRbacResult,
} from '../../core/security/rbac.ts';
import { ensureErpOpsSchema, parseJsonSafe, clampLimit } from '../erp-ops/schema.ts';

export { parseJsonSafe, clampLimit };

export const CRM_360_TABLES = [
  'tenant_deal_stage_history',
  'tenant_entity_tabs',
  'tenant_custom_fields',
  'tenant_crm_activities',
  'tenant_task_dependencies',
  'tenant_task_comments',
  'tenant_task_attachments',
  'tenant_workspace_task_groups',
  'tenant_workspace_preferences',
  'tenant_contact_files',
  'tenant_invoices',
] as const;

const initializedPools = new WeakSet<object>();
const inFlightInitByPool = new WeakMap<object, Promise<void>>();

export interface CrmActorContext {
  rbac: ResolvedUserRbacResult;
  canUnmaskLeads: boolean;
  tenantSettings: Awaited<ReturnType<typeof getTenantSettingsCached>>;
  actorName: string;
}

export async function resolveCrmActorContext(
  client: DbClient,
  tenantId: string,
  userId: string
): Promise<CrmActorContext> {
  const [rbac, tenantSettings, userRes] = await Promise.all([
    resolveUserEffectivePermissions(client, tenantId, userId),
    getTenantSettingsCached(tenantId, client),
    client.query<{ full_name: string; email: string }>(
      'SELECT full_name, email FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, userId]
    ),
  ]);
  const canUnmaskLeads = Boolean(rbac.effectivePermissions.leads?.actions.unmask_phone);
  const actorName = String(
    userRes.rows[0]?.full_name || userRes.rows[0]?.email || 'Thành viên'
  ).trim();
  return { rbac, canUnmaskLeads, tenantSettings, actorName };
}

export async function ensureCrm360Schema(): Promise<void> {
  await ensureErpOpsSchema();

  const pool = getDatabasePool();
  if (initializedPools.has(pool)) {
    return;
  }

  const existingPromise = inFlightInitByPool.get(pool);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const initPromise = (async () => {
    const client = await pool.connect();
    try {
      const isMariaDb = client.dialect === 'mariadb' || pool.dialect === 'mariadb';
      if (isMariaDb) {
        await runCrm360MariaDbSchema(client);
      } else {
        await runCrm360PostgresSchema(client);
      }
      initializedPools.add(pool);
    } finally {
      client.release();
      inFlightInitByPool.delete(pool);
    }
  })();

  inFlightInitByPool.set(pool, initPromise);
  await initPromise;
}

async function runCrm360PostgresSchema(client: DbClient): Promise<void> {
  const pgDdl = `
    -- Additive columns on Master Contact, B2B Companies, Deals & Workspace Tasks
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id UUID;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS job_title VARCHAR(150);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS address TEXT;

    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS parent_company_id UUID;
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'active';
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS sla_tier VARCHAR(30) NOT NULL DEFAULT 'standard';
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_b2b_companies ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS pipeline_id UUID;
    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS stage_id UUID;
    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_deals ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS group_id UUID;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS deal_id UUID;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS company_id UUID;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS category VARCHAR(40) NOT NULL DEFAULT 'personal';
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS participant_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_tasks ADD COLUMN IF NOT EXISTS tags_json JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- 1. Deal Stage Transition History
    CREATE TABLE IF NOT EXISTS tenant_deal_stage_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      deal_id UUID NOT NULL,
      pipeline_id UUID,
      from_stage VARCHAR(80),
      to_stage VARCHAR(80) NOT NULL,
      from_stage_id UUID,
      to_stage_id UUID,
      probability INTEGER NOT NULL DEFAULT 30,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      changed_by UUID,
      changed_by_name VARCHAR(150),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_deal_stage_history_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS pipeline_id UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS from_stage VARCHAR(80);
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS to_stage VARCHAR(80) DEFAULT 'qualification';
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS from_stage_id UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS to_stage_id UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS probability INTEGER NOT NULL DEFAULT 30;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS amount_vnd BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS changed_by UUID;
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS changed_by_name VARCHAR(150);
    ALTER TABLE tenant_deal_stage_history ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_deal_stage_hist_lookup ON tenant_deal_stage_history(tenant_id, deal_id, created_at DESC);

    -- 2. Dynamic Entity Tabs (Contact / Company / Deal 360° Custom Sub-Tabs)
    CREATE TABLE IF NOT EXISTS tenant_entity_tabs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'contact',
      tab_key VARCHAR(80) NOT NULL,
      label VARCHAR(150) NOT NULL DEFAULT '',
      tab_label VARCHAR(150) NOT NULL DEFAULT '',
      icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers',
      tab_type VARCHAR(30) NOT NULL DEFAULT 'fields',
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_entity_tabs_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS entity_type VARCHAR(40) NOT NULL DEFAULT 'contact';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS tab_key VARCHAR(80);
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS label VARCHAR(150) NOT NULL DEFAULT '';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS tab_label VARCHAR(150);
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS tab_type VARCHAR(30) NOT NULL DEFAULT 'fields';
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS config_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS fields_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS created_by UUID;
    CREATE INDEX IF NOT EXISTS idx_entity_tabs_lookup ON tenant_entity_tabs(tenant_id, entity_type, is_active, sort_order ASC);

    -- 3. Global Custom Fields Studio
    CREATE TABLE IF NOT EXISTS tenant_custom_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'contact',
      field_key VARCHAR(64) NOT NULL,
      field_label VARCHAR(150) NOT NULL,
      field_type VARCHAR(30) NOT NULL DEFAULT 'text',
      is_required BOOLEAN NOT NULL DEFAULT false,
      options_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_custom_fields_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS entity_type VARCHAR(40) NOT NULL DEFAULT 'contact';
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS field_key VARCHAR(64);
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS field_label VARCHAR(150);
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS field_type VARCHAR(30) NOT NULL DEFAULT 'text';
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS options_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_custom_fields ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
    CREATE INDEX IF NOT EXISTS idx_custom_fields_lookup ON tenant_custom_fields(tenant_id, entity_type, is_active, sort_order ASC);

    -- 4. Unified Omnichannel CRM Activities
    CREATE TABLE IF NOT EXISTS tenant_crm_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      activity_type VARCHAR(40) NOT NULL DEFAULT 'note',
      subject VARCHAR(255) NOT NULL,
      body TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'planned',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      due_date TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      duration_minutes INTEGER NOT NULL DEFAULT 15,
      lead_id UUID,
      company_id UUID,
      deal_id UUID,
      task_id UUID,
      owner_user_id UUID,
      owner_name VARCHAR(150),
      mentions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      edit_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_crm_activities_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_crm_act_tenant_created ON tenant_crm_activities(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_act_lead ON tenant_crm_activities(tenant_id, lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_act_deal ON tenant_crm_activities(tenant_id, deal_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crm_act_company ON tenant_crm_activities(tenant_id, company_id, created_at DESC);

    -- 5. Task Dependencies
    CREATE TABLE IF NOT EXISTS tenant_task_dependencies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id UUID,
      task_id UUID NOT NULL,
      predecessor_task_id UUID NOT NULL,
      depends_on_task_id UUID,
      dependency_type VARCHAR(30) NOT NULL DEFAULT 'blocked_by',
      lag_days INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_task_dependencies_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS project_id UUID;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS predecessor_task_id UUID;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS depends_on_task_id UUID;
    ALTER TABLE tenant_task_dependencies ALTER COLUMN dependency_type TYPE VARCHAR(30);
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS lag_days INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE tenant_task_dependencies ADD COLUMN IF NOT EXISTS created_by UUID;
    CREATE INDEX IF NOT EXISTS idx_task_deps_lookup ON tenant_task_dependencies(tenant_id, task_id);

    -- 6. Task @Mention Comments
    CREATE TABLE IF NOT EXISTS tenant_task_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_id UUID NOT NULL,
      author_user_id UUID,
      author_name VARCHAR(150) NOT NULL DEFAULT 'Thành viên',
      content TEXT NOT NULL,
      mentions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      edit_history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_task_comments_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS author_user_id UUID;
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS author_name VARCHAR(150) NOT NULL DEFAULT 'Thành viên';
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS mentions_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_task_comments ADD COLUMN IF NOT EXISTS edit_history_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_task_comments_lookup ON tenant_task_comments(tenant_id, task_id, created_at ASC);

    -- 7. Task Attachments
    CREATE TABLE IF NOT EXISTS tenant_task_attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_id UUID NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      cloud_file_id UUID,
      uploaded_by UUID,
      uploaded_by_name VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_task_attachments_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS file_name VARCHAR(255) DEFAULT 'attachment';
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS file_url TEXT DEFAULT '';
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream';
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS cloud_file_id UUID;
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS uploaded_by UUID;
    ALTER TABLE tenant_task_attachments ADD COLUMN IF NOT EXISTS uploaded_by_name VARCHAR(150);
    CREATE INDEX IF NOT EXISTS idx_task_attachments_lookup ON tenant_task_attachments(tenant_id, task_id, created_at DESC);

    -- 8. Personal Workspace Task Groups & Preferences
    CREATE TABLE IF NOT EXISTS tenant_workspace_task_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      name VARCHAR(120) NOT NULL,
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      icon_name VARCHAR(50) NOT NULL DEFAULT 'Folder',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ws_task_groups_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ws_task_groups_user ON tenant_workspace_task_groups(tenant_id, user_id, is_pinned DESC, sort_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_workspace_preferences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      wallpaper_url TEXT NOT NULL DEFAULT '',
      grid_columns INTEGER NOT NULL DEFAULT 3,
      overlay_opacity INTEGER NOT NULL DEFAULT 15,
      hide_completed BOOLEAN NOT NULL DEFAULT false,
      settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_ws_prefs_user UNIQUE (tenant_id, user_id)
    );

    -- 9. Entity Cloud Files Linker (Contact / Company / Deal)
    CREATE TABLE IF NOT EXISTS tenant_contact_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(30) NOT NULL DEFAULT 'contact',
      entity_id UUID NOT NULL,
      cloud_file_id UUID,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      category VARCHAR(80) NOT NULL DEFAULT 'general',
      uploaded_by UUID,
      uploaded_by_name VARCHAR(150),
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_contact_files_tenant_id UNIQUE (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_files_entity ON tenant_contact_files(tenant_id, entity_type, entity_id, created_at DESC);

    -- 10. Invoices (Defensive ensure for Contact 360° & CompanyDrawer commercial rollups)
    CREATE TABLE IF NOT EXISTS tenant_invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      invoice_code VARCHAR(50) NOT NULL,
      sales_order_id UUID,
      quote_id UUID,
      lead_id UUID,
      company_id UUID,
      deal_id UUID,
      customer_name VARCHAR(200) NOT NULL DEFAULT '',
      tax_code VARCHAR(50),
      status VARCHAR(30) NOT NULL DEFAULT 'issued',
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      due_date DATE,
      issued_at TIMESTAMPTZ DEFAULT clock_timestamp(),
      items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_invoices_tenant_id UNIQUE (tenant_id, id)
    );
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS deal_id UUID;
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS lead_id UUID;
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS company_id UUID;
    ALTER TABLE tenant_invoices ADD COLUMN IF NOT EXISTS items_json JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_crm360_invoices_lead ON tenant_invoices(tenant_id, lead_id, created_at DESC);

    -- ENABLE & FORCE ROW LEVEL SECURITY + autodata_app GRANTS
    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_deal_stage_history',
        'tenant_entity_tabs',
        'tenant_custom_fields',
        'tenant_crm_activities',
        'tenant_task_dependencies',
        'tenant_task_comments',
        'tenant_task_attachments',
        'tenant_workspace_task_groups',
        'tenant_workspace_preferences',
        'tenant_contact_files',
        'tenant_invoices'
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
      END LOOP;
    END $$;

    DO $$
    DECLARE
      tbl TEXT;
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app') THEN
        FOREACH tbl IN ARRAY ARRAY[
          'tenant_deal_stage_history',
          'tenant_entity_tabs',
          'tenant_custom_fields',
          'tenant_crm_activities',
          'tenant_task_dependencies',
          'tenant_task_comments',
          'tenant_task_attachments',
          'tenant_workspace_task_groups',
          'tenant_workspace_preferences',
          'tenant_contact_files',
          'tenant_invoices'
        ]
        LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO autodata_app', tbl);
        END LOOP;
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END $$;
  `;

  if (client.exec) {
    await client.exec(pgDdl);
  } else {
    await client.query(pgDdl);
  }
}

async function ensureMariaColumn(
  client: DbClient,
  table: string,
  column: string,
  colDef: string
): Promise<void> {
  const existing = await client.query(`SHOW COLUMNS FROM ${table} LIKE $1`, [column]);
  if (existing.rows.length === 0) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${colDef}`);
  }
}

async function runCrm360MariaDbSchema(client: DbClient): Promise<void> {
  await ensureMariaColumn(client, 'leads', 'company_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'leads', 'job_title', 'VARCHAR(150) NULL');
  await ensureMariaColumn(client, 'leads', 'address', 'TEXT NULL');

  await ensureMariaColumn(client, 'tenant_b2b_companies', 'parent_company_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_b2b_companies', 'status', "VARCHAR(30) NOT NULL DEFAULT 'active'");
  await ensureMariaColumn(client, 'tenant_b2b_companies', 'sla_tier', "VARCHAR(30) NOT NULL DEFAULT 'standard'");
  await ensureMariaColumn(client, 'tenant_b2b_companies', 'tags_json', 'JSON NULL');
  await ensureMariaColumn(client, 'tenant_b2b_companies', 'custom_fields', 'JSON NULL');

  await ensureMariaColumn(client, 'tenant_deals', 'pipeline_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_deals', 'stage_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_deals', 'tags_json', 'JSON NULL');
  await ensureMariaColumn(client, 'tenant_deals', 'custom_fields', 'JSON NULL');

  await ensureMariaColumn(client, 'tenant_tasks', 'group_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_tasks', 'deal_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_tasks', 'company_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_tasks', 'category', "VARCHAR(40) NOT NULL DEFAULT 'personal'");
  await ensureMariaColumn(client, 'tenant_tasks', 'is_muted', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureMariaColumn(client, 'tenant_tasks', 'is_hidden', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureMariaColumn(client, 'tenant_tasks', 'participant_ids_json', 'JSON NULL');
  await ensureMariaColumn(client, 'tenant_tasks', 'tags_json', 'JSON NULL');

  const mariaTables = [
    `CREATE TABLE IF NOT EXISTS tenant_deal_stage_history (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      deal_id VARCHAR(36) NOT NULL,
      pipeline_id VARCHAR(36) NULL,
      from_stage VARCHAR(80) NULL,
      to_stage VARCHAR(80) NOT NULL,
      from_stage_id VARCHAR(36) NULL,
      to_stage_id VARCHAR(36) NULL,
      probability INT NOT NULL DEFAULT 30,
      amount_vnd BIGINT NOT NULL DEFAULT 0,
      duration_seconds INT NOT NULL DEFAULT 0,
      note TEXT NULL,
      changed_by VARCHAR(36) NULL,
      changed_by_name VARCHAR(150) NULL,
      metadata JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_deal_stage_history_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_entity_tabs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'contact',
      tab_key VARCHAR(80) NOT NULL,
      label VARCHAR(150) NOT NULL DEFAULT '',
      tab_label VARCHAR(150) NOT NULL DEFAULT '',
      icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers',
      tab_type VARCHAR(30) NOT NULL DEFAULT 'fields',
      config_json JSON NULL,
      allowed_role_ids JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      fields_json JSON NULL,
      allowed_roles JSON NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_entity_tabs_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_custom_fields (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'contact',
      field_key VARCHAR(64) NOT NULL,
      field_label VARCHAR(150) NOT NULL,
      field_type VARCHAR(30) NOT NULL DEFAULT 'text',
      is_required TINYINT(1) NOT NULL DEFAULT 0,
      options_json JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_custom_fields_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_crm_activities (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      activity_type VARCHAR(40) NOT NULL DEFAULT 'note',
      subject VARCHAR(255) NOT NULL,
      body TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'planned',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      due_date DATETIME(6) NULL,
      completed_at DATETIME(6) NULL,
      duration_minutes INT NOT NULL DEFAULT 15,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      task_id VARCHAR(36) NULL,
      owner_user_id VARCHAR(36) NULL,
      owner_name VARCHAR(150) NULL,
      mentions_json JSON NULL,
      edit_history_json JSON NULL,
      metadata JSON NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_crm_activities_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_task_dependencies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NULL,
      task_id VARCHAR(36) NOT NULL,
      predecessor_task_id VARCHAR(36) NOT NULL,
      depends_on_task_id VARCHAR(36) NULL,
      dependency_type VARCHAR(30) NOT NULL DEFAULT 'blocked_by',
      lag_days INT NOT NULL DEFAULT 0,
      note TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_dependencies_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_task_comments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      author_user_id VARCHAR(36) NULL,
      author_name VARCHAR(150) NOT NULL DEFAULT 'Thành viên',
      content TEXT NOT NULL,
      mentions_json JSON NULL,
      attachments_json JSON NULL,
      edit_history_json JSON NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_comments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_task_attachments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      task_id VARCHAR(36) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      cloud_file_id VARCHAR(36) NULL,
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_task_attachments_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_workspace_task_groups (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      name VARCHAR(120) NOT NULL,
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      icon_name VARCHAR(50) NOT NULL DEFAULT 'Folder',
      sort_order INT NOT NULL DEFAULT 0,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ws_task_groups_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_workspace_preferences (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      wallpaper_url TEXT NULL,
      grid_columns INT NOT NULL DEFAULT 3,
      overlay_opacity INT NOT NULL DEFAULT 15,
      hide_completed TINYINT(1) NOT NULL DEFAULT 0,
      settings_json JSON NULL,
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_ws_prefs_user UNIQUE (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_contact_files (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(30) NOT NULL DEFAULT 'contact',
      entity_id VARCHAR(36) NOT NULL,
      cloud_file_id VARCHAR(36) NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      category VARCHAR(80) NOT NULL DEFAULT 'general',
      uploaded_by VARCHAR(36) NULL,
      uploaded_by_name VARCHAR(150) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_contact_files_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_invoices (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      invoice_code VARCHAR(50) NOT NULL,
      sales_order_id VARCHAR(36) NULL,
      quote_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      company_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      customer_name VARCHAR(200) NOT NULL DEFAULT '',
      tax_code VARCHAR(50) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'issued',
      subtotal_vnd BIGINT NOT NULL DEFAULT 0,
      discount_vnd BIGINT NOT NULL DEFAULT 0,
      tax_vnd BIGINT NOT NULL DEFAULT 0,
      total_vnd BIGINT NOT NULL DEFAULT 0,
      paid_vnd BIGINT NOT NULL DEFAULT 0,
      due_date DATE NULL,
      issued_at DATETIME(6) NULL,
      items_json JSON NULL,
      notes TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_invoices_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const stmt of mariaTables) {
    await client.query(stmt);
  }

  // Ensure additive columns on shared MariaDB tables created earlier by org-rbac / erp-ops
  await ensureMariaColumn(client, 'tenant_entity_tabs', 'label', "VARCHAR(150) NOT NULL DEFAULT ''");
  await ensureMariaColumn(client, 'tenant_entity_tabs', 'tab_label', 'VARCHAR(150) NULL');
  await ensureMariaColumn(client, 'tenant_entity_tabs', 'fields_json', 'JSON NULL');
  await ensureMariaColumn(client, 'tenant_entity_tabs', 'allowed_roles', 'JSON NULL');
  await ensureMariaColumn(client, 'tenant_entity_tabs', 'created_by', 'VARCHAR(36) NULL');

  await ensureMariaColumn(client, 'tenant_task_dependencies', 'predecessor_task_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_task_dependencies', 'depends_on_task_id', 'VARCHAR(36) NULL');
  await ensureMariaColumn(client, 'tenant_task_dependencies', 'note', 'TEXT NULL');
  await ensureMariaColumn(client, 'tenant_task_dependencies', 'created_by', 'VARCHAR(36) NULL');
  await client.query(
    "ALTER TABLE tenant_task_dependencies MODIFY COLUMN dependency_type VARCHAR(30) NOT NULL DEFAULT 'blocked_by'"
  );
}
