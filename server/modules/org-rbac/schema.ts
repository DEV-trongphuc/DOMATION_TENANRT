import type { Request, Response, NextFunction } from 'express';
import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../../core/database/transaction.ts';
import { ensureRbacScreenColumns, sendApiError } from '../../core/security/rbac.ts';

const orgSettingsPoolsInitialized = new WeakSet<object>();
const orgSettingsPoolsPending = new WeakMap<object, Promise<void>>();

export const ORG_SETTINGS_WAVE_A_TABLES = [
  'tenant_custom_fields',
  'tenant_lead_scoring_rules',
  'tenant_notification_rules',
  'tenant_email_templates',
  'tenant_entity_tabs',
  'tenant_cron_runs',
] as const;

async function addMariaDbColumnSafe(
  client: DbClient,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const res = await client.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (Number(res.rows[0]?.cnt || 0) === 0) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function runPostgresOrgSettingsDdl(client: DbClient): Promise<void> {
  const statements = [
    `ALTER TABLE tenant_branches
      ADD COLUMN IF NOT EXISTS branch_ip_whitelist JSONB NOT NULL DEFAULT '[]'::jsonb`,

    `CREATE TABLE IF NOT EXISTS tenant_custom_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      field_key VARCHAR(80) NOT NULL,
      field_label VARCHAR(160) NOT NULL,
      field_type VARCHAR(30) NOT NULL DEFAULT 'text',
      options_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_required BOOLEAN NOT NULL DEFAULT false,
      is_filterable BOOLEAN NOT NULL DEFAULT true,
      show_in_table BOOLEAN NOT NULL DEFAULT true,
      default_value TEXT,
      validation_regex TEXT,
      placeholder VARCHAR(255),
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_custom_fields_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_custom_fields_key UNIQUE (tenant_id, entity_type, field_key)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_lead_scoring_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      trigger_type VARCHAR(40) NOT NULL DEFAULT 'field_match',
      condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      score_delta INTEGER NOT NULL DEFAULT 10,
      max_applications INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_lead_scoring_rules_tenant_id UNIQUE (tenant_id, id)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_notification_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      event_key VARCHAR(80) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      recipient_strategy VARCHAR(40) NOT NULL DEFAULT 'assigned_and_managers',
      target_roles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      target_departments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      target_user_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      include_owner BOOLEAN NOT NULL DEFAULT true,
      include_team_leader BOOLEAN NOT NULL DEFAULT false,
      cc_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      channels_json JSONB NOT NULL DEFAULT '{"in_app":true,"email":false,"zalo":false,"telegram":false}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_notification_rules_tenant_id UNIQUE (tenant_id, id)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_email_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      template_key VARCHAR(100) NOT NULL,
      name VARCHAR(180) NOT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'notification',
      subject_template TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT,
      variables_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_system BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_email_templates_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_email_templates_key UNIQUE (tenant_id, template_key)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_entity_tabs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      tab_key VARCHAR(80) NOT NULL,
      label VARCHAR(140) NOT NULL DEFAULT '',
      tab_label VARCHAR(150) NOT NULL DEFAULT '',
      icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers',
      tab_type VARCHAR(30) NOT NULL DEFAULT 'fields',
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_entity_tabs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_entity_tabs_key UNIQUE (tenant_id, entity_type, tab_key)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_cron_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
      subroutine_key VARCHAR(80) NOT NULL,
      run_key VARCHAR(120),
      status VARCHAR(20) NOT NULL DEFAULT 'success',
      items_processed INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      triggered_by VARCHAR(40) NOT NULL DEFAULT 'scheduler',
      started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_cron_runs_tenant_id UNIQUE (tenant_id, id)
    )`,

    `ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS tab_label VARCHAR(150) NOT NULL DEFAULT ''`,
    `ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS fields_json JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE tenant_entity_tabs ADD COLUMN IF NOT EXISTS created_by UUID`,
    `ALTER TABLE tenant_cron_runs ADD COLUMN IF NOT EXISTS run_key VARCHAR(120)`,

    `CREATE INDEX IF NOT EXISTS idx_custom_fields_tenant_entity
      ON tenant_custom_fields (tenant_id, entity_type, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_lead_scoring_tenant_active
      ON tenant_lead_scoring_rules (tenant_id, is_active, priority)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_rules_tenant_event
      ON tenant_notification_rules (tenant_id, event_key, is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_email_templates_tenant_cat
      ON tenant_email_templates (tenant_id, category, is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_entity_tabs_tenant_entity
      ON tenant_entity_tabs (tenant_id, entity_type, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub
      ON tenant_cron_runs (tenant_id, subroutine_key, started_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_run_key
      ON tenant_cron_runs (tenant_id, subroutine_key, run_key)
      WHERE tenant_id IS NOT NULL AND run_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_status
      ON tenant_cron_runs (tenant_id, subroutine_key, status, started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_cron_runs_sub_started
      ON tenant_cron_runs (subroutine_key, started_at DESC)`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }

  for (const tbl of ORG_SETTINGS_WAVE_A_TABLES) {
    const rlsStmts = [
      `ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS tenant_isolation_${tbl} ON ${tbl}`,
      `CREATE POLICY tenant_isolation_${tbl} ON ${tbl}
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${tbl} TO autodata_app`,
    ];
    for (const s of rlsStmts) {
      await client.query(s);
    }
  }
}

async function runMariaDbOrgSettingsDdl(client: DbClient): Promise<void> {
  await addMariaDbColumnSafe(client, 'tenant_branches', 'branch_ip_whitelist', 'JSON NULL');
  await client.query(`UPDATE tenant_branches SET branch_ip_whitelist = '[]' WHERE branch_ip_whitelist IS NULL`);

  const statements = [
    `CREATE TABLE IF NOT EXISTS tenant_custom_fields (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      field_key VARCHAR(80) NOT NULL,
      field_label VARCHAR(160) NOT NULL,
      field_type VARCHAR(30) NOT NULL DEFAULT 'text',
      options_json JSON NOT NULL,
      is_required TINYINT(1) NOT NULL DEFAULT 0,
      is_filterable TINYINT(1) NOT NULL DEFAULT 1,
      show_in_table TINYINT(1) NOT NULL DEFAULT 1,
      default_value TEXT NULL,
      validation_regex TEXT NULL,
      placeholder VARCHAR(255) NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_custom_fields_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_custom_fields_key UNIQUE (tenant_id, entity_type, field_key),
      INDEX idx_custom_fields_tenant_entity (tenant_id, entity_type, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_lead_scoring_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      trigger_type VARCHAR(40) NOT NULL DEFAULT 'field_match',
      condition_json JSON NOT NULL,
      score_delta INT NOT NULL DEFAULT 10,
      max_applications INT NOT NULL DEFAULT 1,
      priority INT NOT NULL DEFAULT 100,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_lead_scoring_rules_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_lead_scoring_tenant_active (tenant_id, is_active, priority)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_notification_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      event_key VARCHAR(80) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      recipient_strategy VARCHAR(40) NOT NULL DEFAULT 'assigned_and_managers',
      target_roles_json JSON NOT NULL,
      target_departments_json JSON NOT NULL,
      target_user_ids_json JSON NOT NULL,
      include_owner TINYINT(1) NOT NULL DEFAULT 1,
      include_team_leader TINYINT(1) NOT NULL DEFAULT 0,
      cc_emails JSON NOT NULL,
      channels_json JSON NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_notification_rules_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_notification_rules_tenant_event (tenant_id, event_key, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_email_templates (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      template_key VARCHAR(100) NOT NULL,
      name VARCHAR(180) NOT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'notification',
      subject_template TEXT NOT NULL,
      body_html LONGTEXT NOT NULL,
      body_text LONGTEXT NULL,
      variables_json JSON NOT NULL,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_email_templates_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_email_templates_key UNIQUE (tenant_id, template_key),
      INDEX idx_email_templates_tenant_cat (tenant_id, category, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_entity_tabs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      entity_type VARCHAR(40) NOT NULL DEFAULT 'lead',
      tab_key VARCHAR(80) NOT NULL,
      label VARCHAR(140) NOT NULL DEFAULT '',
      tab_label VARCHAR(150) NOT NULL DEFAULT '',
      icon_name VARCHAR(60) NOT NULL DEFAULT 'Layers',
      tab_type VARCHAR(30) NOT NULL DEFAULT 'fields',
      config_json JSON NOT NULL,
      fields_json JSON NULL,
      allowed_role_ids JSON NOT NULL,
      allowed_roles JSON NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_entity_tabs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_entity_tabs_key UNIQUE (tenant_id, entity_type, tab_key),
      INDEX idx_entity_tabs_tenant_entity (tenant_id, entity_type, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_cron_runs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NULL,
      subroutine_key VARCHAR(80) NOT NULL,
      run_key VARCHAR(120) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'success',
      items_processed INT NOT NULL DEFAULT 0,
      duration_ms INT NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      details_json JSON NOT NULL,
      triggered_by VARCHAR(40) NOT NULL DEFAULT 'scheduler',
      started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      finished_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_cron_runs_tenant_id UNIQUE (tenant_id, id),
      UNIQUE INDEX uk_cron_runs_tenant_sub_run_key (tenant_id, subroutine_key, run_key),
      INDEX idx_cron_runs_tenant_sub (tenant_id, subroutine_key, started_at),
      INDEX idx_cron_runs_tenant_sub_status (tenant_id, subroutine_key, status, started_at),
      INDEX idx_cron_runs_sub_started (subroutine_key, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }
  await addMariaDbColumnSafe(client, 'tenant_entity_tabs', 'tab_label', "VARCHAR(150) NOT NULL DEFAULT ''");
  await addMariaDbColumnSafe(client, 'tenant_entity_tabs', 'fields_json', 'JSON NULL');
  await addMariaDbColumnSafe(client, 'tenant_entity_tabs', 'allowed_roles', 'JSON NULL');
  await addMariaDbColumnSafe(client, 'tenant_entity_tabs', 'created_by', 'VARCHAR(36) NULL');
  await addMariaDbColumnSafe(client, 'tenant_cron_runs', 'run_key', 'VARCHAR(120) NULL');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uk_cron_runs_tenant_sub_run_key ON tenant_cron_runs (tenant_id, subroutine_key, run_key)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_cron_runs_tenant_sub_status ON tenant_cron_runs (tenant_id, subroutine_key, status, started_at)').catch(() => {});
  await client.query('CREATE INDEX IF NOT EXISTS idx_cron_runs_sub_started ON tenant_cron_runs (subroutine_key, started_at)').catch(() => {});
}

export async function ensureOrgRbacWaveASchema(): Promise<void> {
  await ensureRbacScreenColumns();
  const pool = getDatabasePool();
  if (orgSettingsPoolsInitialized.has(pool)) {
    return;
  }
  let running = orgSettingsPoolsPending.get(pool);
  if (!running) {
    running = (async () => {
      await withSystemPrivilege(async (client) => {
        if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
          await runMariaDbOrgSettingsDdl(client);
        } else {
          await runPostgresOrgSettingsDdl(client);
        }
      });
      orgSettingsPoolsInitialized.add(pool);
    })().finally(() => {
      orgSettingsPoolsPending.delete(pool);
    });
    orgSettingsPoolsPending.set(pool, running);
  }
  await running;
}

export async function ensureOrgRbacSchemaMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await ensureOrgRbacWaveASchema();
    next();
  } catch (err: any) {
    sendApiError(
      res,
      500,
      'SCHEMA_INIT_FAILED',
      err?.message || 'Không thể khởi tạo cấu trúc dữ liệu phân hệ Tổ chức & Cấu hình.'
    );
  }
}
