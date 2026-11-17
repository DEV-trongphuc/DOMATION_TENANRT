import type { Request, Response, NextFunction } from 'express';
import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../../core/database/transaction.ts';
import { sendApiError } from '../../core/security/rbac.ts';
import { ensureHrmApprovalsSchema } from '../hrm/schema.ts';

const attWaveAPoolsInitialized = new WeakSet<object>();
const attWaveAPoolsPending = new WeakMap<object, Promise<void>>();

export const ATTENDANCE_WAVE_A_TABLES = [
  'tenant_attendance_policies',
  'tenant_attendance_exemption_rules',
  'tenant_attendance_confirmation_batches',
  'tenant_attendance_confirmations',
  'tenant_attendance_bulk_requests',
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

async function runPostgresAttendanceWaveADdl(client: DbClient): Promise<void> {
  const statements = [
    `ALTER TABLE tenant_branches
      ADD COLUMN IF NOT EXISTS branch_ip_whitelist JSONB NOT NULL DEFAULT '[]'::jsonb`,

    `ALTER TABLE tenant_hr_attendance_logs
      ADD COLUMN IF NOT EXISTS accuracy_meters NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS checkout_accuracy_meters NUMERIC(10,2),
      ADD COLUMN IF NOT EXISTS checkin_ip VARCHAR(64),
      ADD COLUMN IF NOT EXISTS checkout_ip VARCHAR(64),
      ADD COLUMN IF NOT EXISTS verification_method VARCHAR(40) NOT NULL DEFAULT 'standard',
      ADD COLUMN IF NOT EXISTS geofence_mode_applied VARCHAR(30) NOT NULL DEFAULT 'flexible',
      ADD COLUMN IF NOT EXISTS exemption_applied BOOLEAN NOT NULL DEFAULT false`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      geofence_mode VARCHAR(30) NOT NULL DEFAULT 'flexible'
        CHECK (geofence_mode IN ('flexible', 'warn_with_explanation', 'strict_radius')),
      require_gps BOOLEAN NOT NULL DEFAULT false,
      require_selfie BOOLEAN NOT NULL DEFAULT false,
      max_gps_accuracy_meters INTEGER NOT NULL DEFAULT 150,
      grace_late_minutes INTEGER NOT NULL DEFAULT 15,
      grace_early_minutes INTEGER NOT NULL DEFAULT 15,
      allow_any_branch_checkin BOOLEAN NOT NULL DEFAULT false,
      allow_remote_with_approved_leave BOOLEAN NOT NULL DEFAULT true,
      allow_ip_whitelist_bypass BOOLEAN NOT NULL DEFAULT true,
      require_checkout BOOLEAN NOT NULL DEFAULT true,
      enable_night_shift BOOLEAN NOT NULL DEFAULT true,
      enable_weekend_shift BOOLEAN NOT NULL DEFAULT true,
      holiday_schedules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_policy_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_policy_unique_tenant UNIQUE (tenant_id)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_exemption_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      scope_type VARCHAR(30) NOT NULL DEFAULT 'user'
        CHECK (scope_type IN ('role', 'department', 'team', 'position', 'user')),
      target_id VARCHAR(64) NOT NULL,
      exempt_checkin BOOLEAN NOT NULL DEFAULT false,
      exempt_gps BOOLEAN NOT NULL DEFAULT false,
      exempt_selfie BOOLEAN NOT NULL DEFAULT false,
      custom_grace_late_minutes INTEGER,
      exclude_from_absent_report BOOLEAN NOT NULL DEFAULT false,
      effective_from DATE,
      effective_to DATE,
      reason TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_exemption_tenant_id UNIQUE (tenant_id, id)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_confirmation_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      title VARCHAR(200) NOT NULL,
      period_month VARCHAR(10) NOT NULL,
      from_date VARCHAR(10) NOT NULL,
      to_date VARCHAR(10) NOT NULL,
      deadline_at TIMESTAMPTZ,
      status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('draft', 'open', 'closed')),
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_conf_batch_tenant_id UNIQUE (tenant_id, id)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_confirmations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      batch_id UUID NOT NULL,
      user_id UUID NOT NULL,
      employee_id UUID,
      total_work_units NUMERIC(8,2) NOT NULL DEFAULT 0,
      late_count INTEGER NOT NULL DEFAULT 0,
      early_count INTEGER NOT NULL DEFAULT 0,
      overtime_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'confirmed', 'disputed', 'auto_confirmed')),
      dispute_reason TEXT,
      confirmed_at TIMESTAMPTZ,
      confirmed_by_type VARCHAR(20),
      details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_conf_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_conf_batch_user UNIQUE (tenant_id, batch_id, user_id)
    )`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_bulk_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      employee_id UUID,
      month_period VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_manager'
        CHECK (status IN ('draft', 'pending_manager', 'approved', 'rejected')),
      approver_id UUID,
      approved_by UUID,
      approved_at TIMESTAMPTZ,
      admin_note TEXT,
      details_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      approval_request_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_att_bulk_req_tenant_id UNIQUE (tenant_id, id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_att_exemption_tenant_scope
      ON tenant_attendance_exemption_rules (tenant_id, is_active, scope_type, target_id)`,
    `CREATE INDEX IF NOT EXISTS idx_att_conf_batch_tenant
      ON tenant_attendance_confirmations (tenant_id, batch_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_att_bulk_req_tenant_user
      ON tenant_attendance_bulk_requests (tenant_id, user_id, month_period)`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }

  for (const tbl of ATTENDANCE_WAVE_A_TABLES) {
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

async function runMariaDbAttendanceWaveADdl(client: DbClient): Promise<void> {
  await addMariaDbColumnSafe(client, 'tenant_branches', 'branch_ip_whitelist', 'JSON NULL');
  await client.query(`UPDATE tenant_branches SET branch_ip_whitelist = '[]' WHERE branch_ip_whitelist IS NULL`);

  await addMariaDbColumnSafe(client, 'tenant_hr_attendance_logs', 'accuracy_meters', 'DECIMAL(10,2) NULL');
  await addMariaDbColumnSafe(client, 'tenant_hr_attendance_logs', 'checkout_accuracy_meters', 'DECIMAL(10,2) NULL');
  await addMariaDbColumnSafe(client, 'tenant_hr_attendance_logs', 'checkin_ip', 'VARCHAR(64) NULL');
  await addMariaDbColumnSafe(client, 'tenant_hr_attendance_logs', 'checkout_ip', 'VARCHAR(64) NULL');
  await addMariaDbColumnSafe(
    client,
    'tenant_hr_attendance_logs',
    'verification_method',
    "VARCHAR(40) NOT NULL DEFAULT 'standard'"
  );
  await addMariaDbColumnSafe(
    client,
    'tenant_hr_attendance_logs',
    'geofence_mode_applied',
    "VARCHAR(30) NOT NULL DEFAULT 'flexible'"
  );
  await addMariaDbColumnSafe(client, 'tenant_hr_attendance_logs', 'exemption_applied', 'TINYINT(1) NOT NULL DEFAULT 0');

  const statements = [
    `CREATE TABLE IF NOT EXISTS tenant_attendance_policies (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      geofence_mode VARCHAR(30) NOT NULL DEFAULT 'flexible',
      require_gps TINYINT(1) NOT NULL DEFAULT 0,
      require_selfie TINYINT(1) NOT NULL DEFAULT 0,
      max_gps_accuracy_meters INT NOT NULL DEFAULT 150,
      grace_late_minutes INT NOT NULL DEFAULT 15,
      grace_early_minutes INT NOT NULL DEFAULT 15,
      allow_any_branch_checkin TINYINT(1) NOT NULL DEFAULT 0,
      allow_remote_with_approved_leave TINYINT(1) NOT NULL DEFAULT 1,
      allow_ip_whitelist_bypass TINYINT(1) NOT NULL DEFAULT 1,
      require_checkout TINYINT(1) NOT NULL DEFAULT 1,
      enable_night_shift TINYINT(1) NOT NULL DEFAULT 1,
      enable_weekend_shift TINYINT(1) NOT NULL DEFAULT 1,
      holiday_schedules_json JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_policy_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_policy_unique_tenant UNIQUE (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_exemption_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(160) NOT NULL,
      scope_type VARCHAR(30) NOT NULL DEFAULT 'user',
      target_id VARCHAR(64) NOT NULL,
      exempt_checkin TINYINT(1) NOT NULL DEFAULT 0,
      exempt_gps TINYINT(1) NOT NULL DEFAULT 0,
      exempt_selfie TINYINT(1) NOT NULL DEFAULT 0,
      custom_grace_late_minutes INT NULL,
      exclude_from_absent_report TINYINT(1) NOT NULL DEFAULT 0,
      effective_from VARCHAR(10) NULL,
      effective_to VARCHAR(10) NULL,
      reason TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_exemption_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_att_exemption_tenant_scope (tenant_id, is_active, scope_type, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_confirmation_batches (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      title VARCHAR(200) NOT NULL,
      period_month VARCHAR(10) NOT NULL,
      from_date VARCHAR(10) NOT NULL,
      to_date VARCHAR(10) NOT NULL,
      deadline_at DATETIME(6) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_conf_batch_tenant_id UNIQUE (tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_confirmations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      batch_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      total_work_units DECIMAL(8,2) NOT NULL DEFAULT 0,
      late_count INT NOT NULL DEFAULT 0,
      early_count INT NOT NULL DEFAULT 0,
      overtime_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      dispute_reason TEXT NULL,
      confirmed_at DATETIME(6) NULL,
      confirmed_by_type VARCHAR(20) NULL,
      details_json JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_conf_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_att_conf_batch_user UNIQUE (tenant_id, batch_id, user_id),
      INDEX idx_att_conf_batch_tenant (tenant_id, batch_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_attendance_bulk_requests (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      month_period VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_manager',
      approver_id VARCHAR(36) NULL,
      approved_by VARCHAR(36) NULL,
      approved_at DATETIME(6) NULL,
      admin_note TEXT NULL,
      details_json JSON NOT NULL,
      approval_request_id VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_att_bulk_req_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_att_bulk_req_tenant_user (tenant_id, user_id, month_period)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }
}

export async function ensureAttendanceWaveASchema(): Promise<void> {
  await ensureHrmApprovalsSchema();
  const pool = getDatabasePool();
  if (attWaveAPoolsInitialized.has(pool)) {
    return;
  }
  let running = attWaveAPoolsPending.get(pool);
  if (!running) {
    running = (async () => {
      await withSystemPrivilege(async (client) => {
        if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
          await runMariaDbAttendanceWaveADdl(client);
        } else {
          await runPostgresAttendanceWaveADdl(client);
        }
      });
      attWaveAPoolsInitialized.add(pool);
    })().finally(() => {
      attWaveAPoolsPending.delete(pool);
    });
    attWaveAPoolsPending.set(pool, running);
  }
  await running;
}

export async function ensureAttendanceWaveAMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await ensureAttendanceWaveASchema();
    next();
  } catch (err: any) {
    sendApiError(
      res,
      500,
      'SCHEMA_INIT_FAILED',
      err?.message || 'Không thể khởi tạo cấu trúc dữ liệu chính sách Chấm công.'
    );
  }
}
