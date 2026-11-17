import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getDatabasePool, type DbClient } from '../../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../../core/database/transaction.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { sendApiError } from '../../core/security/rbac.ts';

const initializedPools = new WeakSet<object>();
const pendingPoolInit = new WeakMap<object, Promise<void>>();

export const HRM_APPROVALS_TENANT_TABLES = [
  'tenant_approval_workflows',
  'tenant_approval_workflow_steps',
  'tenant_approval_delegations',
  'tenant_approval_requests',
  'tenant_approval_step_logs',
  'tenant_hr_employees',
  'tenant_hr_contracts',
  'tenant_hr_handover_assets',
  'tenant_booking_links',
  'tenant_booking_appointments',
  'tenant_hr_shifts',
  'tenant_hr_shift_assignments',
  'tenant_hr_attendance_logs',
  'tenant_hr_attendance_explanations',
  'tenant_payroll_configs',
  'tenant_payroll_periods',
  'tenant_payroll_slips',
  'tenant_commission_rules',
  'tenant_commission_ledgers',
  'tenant_cooperation_slips',
  'tenant_accounting_az_workspace',
] as const;

export function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

export function toNum(val: unknown, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function toBool(val: unknown, fallback = false): boolean {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

/**
 * Haversine spherical distance in meters between two WGS84 coordinates.
 */
export function computeHaversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth mean radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return Math.round(R * c * 100) / 100;
}

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

async function runPostgresHrmApprovalsDdl(client: DbClient): Promise<void> {
  const ddl = `
    ALTER TABLE tenant_branches ADD COLUMN IF NOT EXISTS manager_user_id UUID;

    -- ========================================================================
    -- 1. DYNAMIC N-STEP APPROVAL ENGINE TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_approval_workflows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(80) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      category VARCHAR(40) NOT NULL DEFAULT 'leave',
      category_label VARCHAR(120),
      form_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
      icon_name VARCHAR(60) NOT NULL DEFAULT 'FileCheck',
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      require_attachment BOOLEAN NOT NULL DEFAULT false,
      auto_approve_if_creator_is_approver BOOLEAN NOT NULL DEFAULT true,
      default_watcher_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      default_watcher_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_workflows_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_workflows_code UNIQUE (tenant_id, code)
    );
    ALTER TABLE tenant_approval_workflows DROP CONSTRAINT IF EXISTS tenant_approval_workflows_category_check;
    ALTER TABLE tenant_approval_workflows ADD COLUMN IF NOT EXISTS category_label VARCHAR(120);
    ALTER TABLE tenant_approval_workflows ADD COLUMN IF NOT EXISTS default_watcher_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE tenant_approval_workflows ADD COLUMN IF NOT EXISTS default_watcher_roles JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_appr_wf_tenant_cat ON tenant_approval_workflows(tenant_id, category, is_active);

    CREATE TABLE IF NOT EXISTS tenant_approval_workflow_steps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 1,
      step_name VARCHAR(160) NOT NULL,
      approver_type VARCHAR(40) NOT NULL DEFAULT 'direct_manager'
        CHECK (approver_type IN ('direct_manager', 'team_leader', 'department_head', 'parent_department_head', 'branch_director', 'specific_role', 'specific_user')),
      approver_role_id UUID,
      approver_user_id UUID,
      min_amount_threshold NUMERIC(18,2) NOT NULL DEFAULT 0,
      max_amount_threshold NUMERIC(18,2),
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one'
        CHECK (approval_mode IN ('any_one', 'all_must_approve')),
      fallback_strategy VARCHAR(40) NOT NULL DEFAULT 'tenant_admin'
        CHECK (fallback_strategy IN ('escalate_parent_dept', 'tenant_admin')),
      sla_hours INTEGER NOT NULL DEFAULT 24,
      require_signature BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_workflow_steps_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_appr_step_workflow FOREIGN KEY (tenant_id, workflow_id)
        REFERENCES tenant_approval_workflows(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_appr_step_role FOREIGN KEY (tenant_id, approver_role_id)
        REFERENCES tenant_roles(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_appr_step_user FOREIGN KEY (tenant_id, approver_user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appr_steps_wf_order ON tenant_approval_workflow_steps(tenant_id, workflow_id, step_order ASC);

    CREATE TABLE IF NOT EXISTS tenant_approval_delegations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      delegator_user_id UUID NOT NULL,
      delegate_user_id UUID NOT NULL,
      categories JSONB NOT NULL DEFAULT '[]'::jsonb,
      valid_from TIMESTAMPTZ NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      reason TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_delegations_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_appr_delegator FOREIGN KEY (tenant_id, delegator_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_appr_delegate FOREIGN KEY (tenant_id, delegate_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_appr_delegations_lookup ON tenant_approval_delegations(tenant_id, delegator_user_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_approval_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_code VARCHAR(50) NOT NULL,
      workflow_id UUID NOT NULL,
      category VARCHAR(40) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      requester_user_id UUID NOT NULL,
      amount_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      start_date TIMESTAMPTZ,
      end_date TIMESTAMPTZ,
      form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'returned', 'cancelled')),
      current_step_order INTEGER NOT NULL DEFAULT 1,
      total_steps INTEGER NOT NULL DEFAULT 1,
      resolved_steps_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      linked_entity_type VARCHAR(60),
      linked_entity_id UUID,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_requests_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_requests_code UNIQUE (tenant_id, request_code),
      CONSTRAINT fk_appr_req_workflow FOREIGN KEY (tenant_id, workflow_id)
        REFERENCES tenant_approval_workflows(tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_appr_req_requester FOREIGN KEY (tenant_id, requester_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_appr_req_tenant_status ON tenant_approval_requests(tenant_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_appr_req_requester ON tenant_approval_requests(tenant_id, requester_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tenant_approval_step_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_id UUID NOT NULL,
      step_id UUID,
      step_order INTEGER NOT NULL,
      step_name VARCHAR(160) NOT NULL,
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one',
      assigned_user_id UUID NOT NULL,
      original_approver_user_id UUID,
      delegated_from_user_id UUID,
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'waiting', 'approved', 'rejected', 'returned', 'skipped')),
      action_comment TEXT,
      signature_data_url TEXT,
      due_at TIMESTAMPTZ,
      acted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_approval_step_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_appr_log_request FOREIGN KEY (tenant_id, request_id)
        REFERENCES tenant_approval_requests(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_appr_log_assigned_user FOREIGN KEY (tenant_id, assigned_user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_appr_step_logs_inbox ON tenant_approval_step_logs(tenant_id, assigned_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_appr_step_logs_req ON tenant_approval_step_logs(tenant_id, request_id, step_order ASC);

    -- ========================================================================
    -- 2. HRM 360°, LABOR CONTRACTS, ASSETS & SMART 1-ON-1 BOOKING TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_hr_employees (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID,
      employee_code VARCHAR(50) NOT NULL,
      full_name VARCHAR(160) NOT NULL,
      work_email VARCHAR(255),
      phone VARCHAR(40),
      gender VARCHAR(20),
      date_of_birth DATE,
      nationality VARCHAR(80) NOT NULL DEFAULT 'Việt Nam',
      id_card_number VARCHAR(50),
      address TEXT,
      branch_id UUID,
      department_id UUID,
      team_id UUID,
      position_id UUID,
      manager_user_id UUID,
      employment_status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (employment_status IN ('probation', 'active', 'on_leave', 'resigned', 'terminated')),
      employment_type VARCHAR(30) NOT NULL DEFAULT 'full_time'
        CHECK (employment_type IN ('full_time', 'part_time', 'contractor', 'intern')),
      join_date DATE,
      resign_date DATE,
      base_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_enrolled BOOLEAN NOT NULL DEFAULT true,
      social_insurance_number VARCHAR(50),
      is_resident BOOLEAN NOT NULL DEFAULT true,
      tax_code VARCHAR(50),
      dependents_count INTEGER NOT NULL DEFAULT 0,
      union_member BOOLEAN NOT NULL DEFAULT false,
      allowances_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      bank_name VARCHAR(120),
      bank_account_number VARCHAR(60),
      bank_account_holder VARCHAR(160),
      bank_branch VARCHAR(160),
      annual_leave_quota NUMERIC(6,2) NOT NULL DEFAULT 12,
      annual_leave_used NUMERIC(6,2) NOT NULL DEFAULT 0,
      compensatory_leave_balance NUMERIC(6,2) NOT NULL DEFAULT 0,
      digital_signature_data_url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_employees_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_employees_code UNIQUE (tenant_id, employee_code),
      CONSTRAINT fk_hr_emp_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_dept FOREIGN KEY (tenant_id, department_id)
        REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_team FOREIGN KEY (tenant_id, team_id)
        REFERENCES tenant_teams(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_pos FOREIGN KEY (tenant_id, position_id)
        REFERENCES tenant_positions(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_hr_emp_mgr FOREIGN KEY (tenant_id, manager_user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_emp_tenant_status ON tenant_hr_employees(tenant_id, employment_status);
    CREATE INDEX IF NOT EXISTS idx_hr_emp_user ON tenant_hr_employees(tenant_id, user_id);

    CREATE TABLE IF NOT EXISTS tenant_hr_contracts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      employee_id UUID NOT NULL,
      contract_number VARCHAR(80) NOT NULL,
      contract_type VARCHAR(30) NOT NULL DEFAULT 'fixed_term'
        CHECK (contract_type IN ('probation', 'fixed_term', 'indefinite', 'addendum', 'service')),
      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'expired', 'terminated', 'superseded')),
      start_date DATE NOT NULL,
      end_date DATE,
      base_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      allowances_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      working_schedule_note VARCHAR(255),
      signed_by_employee BOOLEAN NOT NULL DEFAULT false,
      employee_signature_url TEXT,
      signed_by_employer BOOLEAN NOT NULL DEFAULT false,
      employer_signer_name VARCHAR(160),
      signed_at TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_contracts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_contracts_number UNIQUE (tenant_id, contract_number),
      CONSTRAINT fk_hr_contract_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_contracts_emp ON tenant_hr_contracts(tenant_id, employee_id, start_date DESC);

    CREATE TABLE IF NOT EXISTS tenant_hr_handover_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      employee_id UUID NOT NULL,
      asset_code VARCHAR(80) NOT NULL,
      asset_name VARCHAR(200) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'laptop',
      serial_number VARCHAR(120),
      asset_value_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      condition_on_handover VARCHAR(120) NOT NULL DEFAULT 'Mới 100%',
      status VARCHAR(30) NOT NULL DEFAULT 'assigned'
        CHECK (status IN ('assigned', 'returned', 'damaged', 'lost')),
      handed_over_at DATE NOT NULL DEFAULT CURRENT_DATE,
      returned_at DATE,
      acknowledged_by_employee BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_handover_assets_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_hr_asset_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_assets_emp ON tenant_hr_handover_assets(tenant_id, employee_id, status);

    CREATE TABLE IF NOT EXISTS tenant_booking_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      host_user_id UUID,
      host_employee_id UUID,
      slug VARCHAR(120) NOT NULL,
      public_token VARCHAR(80) NOT NULL,
      title VARCHAR(200) NOT NULL,
      subtitle VARCHAR(255),
      description TEXT,
      meeting_purpose VARCHAR(60) NOT NULL DEFAULT 'consultation',
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      buffer_minutes INTEGER NOT NULL DEFAULT 10,
      timezone VARCHAR(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      location_type VARCHAR(40) NOT NULL DEFAULT 'video_link',
      location_value VARCHAR(255),
      availability_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
      custom_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_booking_links_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_booking_links_slug UNIQUE (slug),
      CONSTRAINT uk_tenant_booking_links_token UNIQUE (public_token),
      CONSTRAINT fk_booking_host_user FOREIGN KEY (tenant_id, host_user_id)
        REFERENCES users(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_booking_host_emp FOREIGN KEY (tenant_id, host_employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_booking_links_tenant ON tenant_booking_links(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_booking_appointments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      booking_link_id UUID NOT NULL,
      guest_name VARCHAR(160) NOT NULL,
      guest_email VARCHAR(255),
      guest_phone VARCHAR(40),
      guest_company VARCHAR(200),
      topic TEXT,
      answers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      booking_date DATE NOT NULL,
      start_time VARCHAR(10) NOT NULL,
      end_time VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'confirmed'
        CHECK (status IN ('confirmed', 'completed', 'cancelled', 'no_show')),
      lead_id UUID,
      ics_uid VARCHAR(120),
      cancel_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_booking_appointments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_booking_appt_link FOREIGN KEY (tenant_id, booking_link_id)
        REFERENCES tenant_booking_links(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_booking_appt_lead FOREIGN KEY (tenant_id, lead_id)
        REFERENCES leads(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_booking_appts_slot ON tenant_booking_appointments(tenant_id, booking_link_id, booking_date, start_time);

    -- ========================================================================
    -- 3. MULTI-TIER GPS + SELFIE ATTENDANCE & DYNAMIC SHIFTS TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_hr_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      start_time VARCHAR(10) NOT NULL DEFAULT '08:30',
      end_time VARCHAR(10) NOT NULL DEFAULT '17:30',
      break_start_time VARCHAR(10) DEFAULT '12:00',
      break_end_time VARCHAR(10) DEFAULT '13:00',
      break_minutes INTEGER NOT NULL DEFAULT 60,
      grace_late_minutes INTEGER NOT NULL DEFAULT 15,
      grace_early_leave_minutes INTEGER NOT NULL DEFAULT 15,
      min_half_day_hours NUMERIC(5,2) NOT NULL DEFAULT 4,
      standard_work_hours NUMERIC(5,2) NOT NULL DEFAULT 8,
      work_unit_value NUMERIC(5,2) NOT NULL DEFAULT 1,
      night_shift_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.3,
      overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.5,
      weekend_overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 2.0,
      holiday_overtime_multiplier NUMERIC(5,2) NOT NULL DEFAULT 3.0,
      require_gps BOOLEAN NOT NULL DEFAULT true,
      require_selfie BOOLEAN NOT NULL DEFAULT true,
      allow_out_of_geofence_with_explanation BOOLEAN NOT NULL DEFAULT true,
      working_days JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
      is_default BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_shifts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_shifts_code UNIQUE (tenant_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_hr_shifts_tenant ON tenant_hr_shifts(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_hr_shift_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      shift_id UUID NOT NULL,
      employee_id UUID,
      user_id UUID,
      department_id UUID,
      branch_id UUID,
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
      effective_to DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_shift_assignments_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_shift_assign_shift FOREIGN KEY (tenant_id, shift_id)
        REFERENCES tenant_hr_shifts(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_dept FOREIGN KEY (tenant_id, department_id)
        REFERENCES tenant_departments(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_shift_assign_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shift_assign_lookup ON tenant_hr_shift_assignments(tenant_id, user_id, employee_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_hr_attendance_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      employee_id UUID,
      branch_id UUID,
      shift_id UUID,
      work_date DATE NOT NULL,
      attendance_code VARCHAR(10) NOT NULL DEFAULT 'X',
      check_in_at TIMESTAMPTZ,
      check_out_at TIMESTAMPTZ,
      latitude NUMERIC(10,7),
      longitude NUMERIC(10,7),
      checkout_latitude NUMERIC(10,7),
      checkout_longitude NUMERIC(10,7),
      distance_meters NUMERIC(12,2),
      checkout_distance_meters NUMERIC(12,2),
      within_geofence BOOLEAN NOT NULL DEFAULT true,
      selfie_data_url TEXT,
      checkout_selfie_data_url TEXT,
      device_info VARCHAR(255),
      late_minutes INTEGER NOT NULL DEFAULT 0,
      early_leave_minutes INTEGER NOT NULL DEFAULT 0,
      worked_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
      overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
      work_units NUMERIC(5,2) NOT NULL DEFAULT 1,
      status VARCHAR(30) NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'late', 'out_of_geofence', 'missing_checkout', 'explained', 'leave')),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_attendance_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_hr_att_user_date UNIQUE (tenant_id, user_id, work_date),
      CONSTRAINT fk_att_log_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_att_log_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_att_log_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_att_log_shift FOREIGN KEY (tenant_id, shift_id)
        REFERENCES tenant_hr_shifts(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_att_logs_month ON tenant_hr_attendance_logs(tenant_id, work_date DESC, user_id);

    CREATE TABLE IF NOT EXISTS tenant_hr_attendance_explanations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      attendance_log_id UUID,
      user_id UUID NOT NULL,
      employee_id UUID,
      work_date DATE NOT NULL,
      explanation_type VARCHAR(40) NOT NULL DEFAULT 'late_arrival'
        CHECK (explanation_type IN ('late_arrival', 'early_leave', 'forgot_checkin', 'forgot_checkout', 'out_of_geofence', 'business_trip')),
      requested_check_in VARCHAR(10),
      requested_check_out VARCHAR(10),
      requested_work_units NUMERIC(5,2) NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      evidence_url TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      approval_request_id UUID,
      reviewed_by UUID,
      reviewed_at TIMESTAMPTZ,
      review_comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_hr_attendance_explanations_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_att_exp_log FOREIGN KEY (tenant_id, attendance_log_id)
        REFERENCES tenant_hr_attendance_logs(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_att_exp_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_att_exp_appr FOREIGN KEY (tenant_id, approval_request_id)
        REFERENCES tenant_approval_requests(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hr_att_exp_tenant ON tenant_hr_attendance_explanations(tenant_id, status, work_date DESC);

    -- ========================================================================
    -- 4. DYNAMIC PAYROLL, COMMISSIONS, PIT TAX, BHXH & HTKK ENGINE TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS tenant_payroll_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      standard_workdays_mode VARCHAR(20) NOT NULL DEFAULT 'calendar',
      fixed_standard_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      saturday_work_mode VARCHAR(20) NOT NULL DEFAULT 'off'
        CHECK (saturday_work_mode IN ('off', 'half', 'full')),
      emp_bhxh_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0800,
      emp_bhyt_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0150,
      emp_bhtn_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0100,
      er_bhxh_rate NUMERIC(6,4) NOT NULL DEFAULT 0.1750,
      er_bhyt_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0300,
      er_bhtn_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0100,
      er_union_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0200,
      emp_union_rate NUMERIC(6,4) NOT NULL DEFAULT 0.0100,
      bhxh_salary_cap_vnd NUMERIC(18,2) NOT NULL DEFAULT 46800000,
      bhtn_salary_cap_vnd NUMERIC(18,2) NOT NULL DEFAULT 99200000,
      personal_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 11000000,
      dependent_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 4400000,
      meal_allowance_exempt_cap_vnd NUMERIC(18,2) NOT NULL DEFAULT 730000,
      non_resident_flat_tax_rate NUMERIC(6,4) NOT NULL DEFAULT 0.2000,
      casual_withholding_threshold_vnd NUMERIC(18,2) NOT NULL DEFAULT 2000000,
      casual_flat_tax_rate NUMERIC(6,4) NOT NULL DEFAULT 0.1000,
      pit_brackets JSONB NOT NULL DEFAULT '[{"up_to":5000000,"rate":0.05},{"up_to":10000000,"rate":0.10},{"up_to":18000000,"rate":0.15},{"up_to":32000000,"rate":0.20},{"up_to":52000000,"rate":0.25},{"up_to":80000000,"rate":0.30},{"up_to":null,"rate":0.35}]'::jsonb,
      allowance_definitions JSONB NOT NULL DEFAULT '[{"key":"meal","name":"Phụ cấp ăn trưa","tax_mode":"meal_cap","prorate":true,"include_insurance":false},{"key":"responsibility","name":"Phụ cấp trách nhiệm","tax_mode":"taxable","prorate":true,"include_insurance":true},{"key":"transport","name":"Phụ cấp xăng xe & điện thoại","tax_mode":"taxable","prorate":true,"include_insurance":false}]'::jsonb,
      tax_authority_code VARCHAR(40),
      tax_authority_name VARCHAR(200),
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_payroll_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_configs_one UNIQUE (tenant_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_payroll_periods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period_key VARCHAR(10) NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL,
      branch_id UUID,
      standard_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      status VARCHAR(30) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'calculated', 'pending_approval', 'approved', 'paid', 'locked')),
      employee_count INTEGER NOT NULL DEFAULT 0,
      total_gross_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_emp_insurance_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_er_insurance_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_pit_tax_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_commission_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      total_net_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      approval_request_id UUID,
      approved_by UUID,
      approved_at TIMESTAMPTZ,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_payroll_periods_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_periods_ym UNIQUE (tenant_id, period_key),
      CONSTRAINT fk_payroll_period_branch FOREIGN KEY (tenant_id, branch_id)
        REFERENCES tenant_branches(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_periods_tenant ON tenant_payroll_periods(tenant_id, year DESC, month DESC);

    CREATE TABLE IF NOT EXISTS tenant_payroll_slips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period_id UUID NOT NULL,
      employee_id UUID NOT NULL,
      user_id UUID,
      standard_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      actual_workdays NUMERIC(5,2) NOT NULL DEFAULT 22,
      paid_leave_days NUMERIC(5,2) NOT NULL DEFAULT 0,
      unpaid_leave_days NUMERIC(5,2) NOT NULL DEFAULT 0,
      overtime_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
      base_salary_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      prorated_base_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      allowances_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tax_exempt_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      overtime_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      commission_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      bonus_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      gross_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      insurance_salary_base_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_bhxh_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_bhyt_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_bhtn_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      emp_union_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      er_insurance_total_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      dependents_count INTEGER NOT NULL DEFAULT 0,
      family_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      taxable_income_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      assessable_income_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      pit_tax_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      advance_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      other_deduction_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      net_pay_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tax_method VARCHAR(40) NOT NULL DEFAULT 'progressive',
      payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid'
        CHECK (payment_status IN ('unpaid', 'paid')),
      breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_payroll_slips_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_payroll_slip_period_emp UNIQUE (tenant_id, period_id, employee_id),
      CONSTRAINT fk_payroll_slip_period FOREIGN KEY (tenant_id, period_id)
        REFERENCES tenant_payroll_periods(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_payroll_slip_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_slips_period ON tenant_payroll_slips(tenant_id, period_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_slips_user ON tenant_payroll_slips(tenant_id, user_id);

    CREATE TABLE IF NOT EXISTS tenant_commission_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      description TEXT,
      applies_to_role_id UUID,
      applies_to_department_id UUID,
      rule_type VARCHAR(30) NOT NULL DEFAULT 'percentage_revenue'
        CHECK (rule_type IN ('percentage_revenue', 'tiered_revenue', 'fixed_per_won_lead')),
      flat_rate_pct NUMERIC(7,4) NOT NULL DEFAULT 3.0000,
      fixed_amount_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tiers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      min_revenue_threshold_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_commission_rules_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_comm_rule_role FOREIGN KEY (tenant_id, applies_to_role_id)
        REFERENCES tenant_roles(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_comm_rule_dept FOREIGN KEY (tenant_id, applies_to_department_id)
        REFERENCES tenant_departments(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comm_rules_tenant ON tenant_commission_rules(tenant_id, is_active);

    CREATE TABLE IF NOT EXISTS tenant_commission_ledgers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period_key VARCHAR(10) NOT NULL,
      employee_id UUID,
      user_id UUID NOT NULL,
      rule_id UUID,
      lead_id UUID,
      source_title VARCHAR(255) NOT NULL,
      revenue_base_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      commission_amount_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'approved'
        CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT uk_tenant_commission_ledgers_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_comm_ledger_emp FOREIGN KEY (tenant_id, employee_id)
        REFERENCES tenant_hr_employees(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_comm_ledger_user FOREIGN KEY (tenant_id, user_id)
        REFERENCES users(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_comm_ledger_rule FOREIGN KEY (tenant_id, rule_id)
        REFERENCES tenant_commission_rules(tenant_id, id) ON DELETE SET NULL,
      CONSTRAINT fk_comm_ledger_lead FOREIGN KEY (tenant_id, lead_id)
        REFERENCES leads(tenant_id, id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comm_ledgers_period ON tenant_commission_ledgers(tenant_id, period_key, user_id);

    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS signed_by_employee BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS employee_signature_url TEXT;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS employee_signed_at TIMESTAMPTZ;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(30);
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS dispute_note TEXT;
    ALTER TABLE tenant_payroll_slips ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS tenant_cooperation_slips (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slip_code VARCHAR(80),
      title VARCHAR(255) NOT NULL,
      lead_id UUID,
      deal_id UUID,
      partner_name VARCHAR(255),
      partner_contact VARCHAR(120),
      commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
      estimated_value_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_signatures',
      terms_text TEXT,
      line_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      owner_user_id UUID,
      approved_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS unit_code VARCHAR(80);
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS project_name VARCHAR(200);
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS expected_commission_vnd NUMERIC(18,2) NOT NULL DEFAULT 0;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS total_percentage NUMERIC(6,2) NOT NULL DEFAULT 100;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS dispute_details TEXT;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE tenant_cooperation_slips ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_coop_slips_status ON tenant_cooperation_slips(tenant_id, status);

    CREATE TABLE IF NOT EXISTS tenant_accounting_az_workspace (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      fiscal_period VARCHAR(20) NOT NULL,
      account_code VARCHAR(40) NOT NULL DEFAULT '111',
      account_name VARCHAR(200) NOT NULL DEFAULT 'Tiền mặt',
      voucher_no VARCHAR(80),
      entry_type VARCHAR(30) NOT NULL DEFAULT 'journal',
      debit_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      credit_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      balance_vnd NUMERIC(18,2) NOT NULL DEFAULT 0,
      tax_period VARCHAR(20),
      analytics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      extra_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS idx_acc_az_period ON tenant_accounting_az_workspace(tenant_id, fiscal_period, account_code);

    -- ========================================================================
    -- 5. FORCE ROW LEVEL SECURITY + POLICIES + GRANTS ON ALL 21 TABLES
    -- ========================================================================
    DO $$
    DECLARE
      tbl TEXT;
      pol TEXT;
    BEGIN
      FOREACH tbl IN ARRAY ARRAY[
        'tenant_approval_workflows',
        'tenant_approval_workflow_steps',
        'tenant_approval_delegations',
        'tenant_approval_requests',
        'tenant_approval_step_logs',
        'tenant_hr_employees',
        'tenant_hr_contracts',
        'tenant_hr_handover_assets',
        'tenant_booking_links',
        'tenant_booking_appointments',
        'tenant_hr_shifts',
        'tenant_hr_shift_assignments',
        'tenant_hr_attendance_logs',
        'tenant_hr_attendance_explanations',
        'tenant_payroll_configs',
        'tenant_payroll_periods',
        'tenant_payroll_slips',
        'tenant_commission_rules',
        'tenant_commission_ledgers',
        'tenant_cooperation_slips',
        'tenant_accounting_az_workspace'
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
          'tenant_approval_workflows',
          'tenant_approval_workflow_steps',
          'tenant_approval_delegations',
          'tenant_approval_requests',
          'tenant_approval_step_logs',
          'tenant_hr_employees',
          'tenant_hr_contracts',
          'tenant_hr_handover_assets',
          'tenant_booking_links',
          'tenant_booking_appointments',
          'tenant_hr_shifts',
          'tenant_hr_shift_assignments',
          'tenant_hr_attendance_logs',
          'tenant_hr_attendance_explanations',
          'tenant_payroll_configs',
          'tenant_payroll_periods',
          'tenant_payroll_slips',
          'tenant_commission_rules',
          'tenant_commission_ledgers',
          'tenant_cooperation_slips',
          'tenant_accounting_az_workspace'
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
    await client.exec(ddl);
  } else {
    await client.query(ddl);
  }
}

async function runMariaDbHrmApprovalsDdl(client: DbClient): Promise<void> {
  await addMariaDbColumnSafe(client, 'tenant_branches', 'manager_user_id', 'VARCHAR(36) NULL');
  await addMariaDbColumnSafe(client, 'tenant_approval_workflows', 'category_label', 'VARCHAR(120) NULL');
  await addMariaDbColumnSafe(client, 'tenant_approval_workflows', 'default_watcher_ids', 'JSON NULL');
  await addMariaDbColumnSafe(client, 'tenant_approval_workflows', 'default_watcher_roles', 'JSON NULL');

  const statements = [
    `CREATE TABLE IF NOT EXISTS tenant_approval_workflows (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(80) NOT NULL,
      name VARCHAR(200) NOT NULL,
      description TEXT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'leave',
      category_label VARCHAR(120) NULL,
      form_schema JSON NOT NULL,
      icon_name VARCHAR(60) NOT NULL DEFAULT 'FileCheck',
      color_hex VARCHAR(20) NOT NULL DEFAULT '#1E40FF',
      require_attachment TINYINT(1) NOT NULL DEFAULT 0,
      auto_approve_if_creator_is_approver TINYINT(1) NOT NULL DEFAULT 1,
      default_watcher_ids JSON NULL,
      default_watcher_roles JSON NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_workflows_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_workflows_code UNIQUE (tenant_id, code),
      INDEX idx_appr_wf_tenant_cat (tenant_id, category, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_approval_workflow_steps (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      workflow_id VARCHAR(36) NOT NULL,
      step_order INT NOT NULL DEFAULT 1,
      step_name VARCHAR(160) NOT NULL,
      approver_type VARCHAR(40) NOT NULL DEFAULT 'direct_manager',
      approver_role_id VARCHAR(36) NULL,
      approver_user_id VARCHAR(36) NULL,
      min_amount_threshold DECIMAL(18,2) NOT NULL DEFAULT 0,
      max_amount_threshold DECIMAL(18,2) NULL,
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one',
      fallback_strategy VARCHAR(40) NOT NULL DEFAULT 'tenant_admin',
      sla_hours INT NOT NULL DEFAULT 24,
      require_signature TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_workflow_steps_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_appr_steps_wf_order (tenant_id, workflow_id, step_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_approval_delegations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      delegator_user_id VARCHAR(36) NOT NULL,
      delegate_user_id VARCHAR(36) NOT NULL,
      categories JSON NOT NULL,
      valid_from DATETIME(6) NOT NULL,
      valid_until DATETIME(6) NOT NULL,
      reason TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_delegations_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_appr_delegations_lookup (tenant_id, delegator_user_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_approval_requests (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      request_code VARCHAR(50) NOT NULL,
      workflow_id VARCHAR(36) NOT NULL,
      category VARCHAR(40) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      requester_user_id VARCHAR(36) NOT NULL,
      amount_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      start_date DATETIME(6) NULL,
      end_date DATETIME(6) NULL,
      form_data JSON NOT NULL,
      attachments JSON NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      current_step_order INT NOT NULL DEFAULT 1,
      total_steps INT NOT NULL DEFAULT 1,
      resolved_steps_snapshot JSON NOT NULL,
      linked_entity_type VARCHAR(60) NULL,
      linked_entity_id VARCHAR(36) NULL,
      submitted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      completed_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_requests_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_approval_requests_code UNIQUE (tenant_id, request_code),
      INDEX idx_appr_req_tenant_status (tenant_id, status, created_at),
      INDEX idx_appr_req_requester (tenant_id, requester_user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_approval_step_logs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      request_id VARCHAR(36) NOT NULL,
      step_id VARCHAR(36) NULL,
      step_order INT NOT NULL,
      step_name VARCHAR(160) NOT NULL,
      approval_mode VARCHAR(30) NOT NULL DEFAULT 'any_one',
      assigned_user_id VARCHAR(36) NOT NULL,
      original_approver_user_id VARCHAR(36) NULL,
      delegated_from_user_id VARCHAR(36) NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      action_comment TEXT NULL,
      signature_data_url LONGTEXT NULL,
      due_at DATETIME(6) NULL,
      acted_at DATETIME(6) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_approval_step_logs_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_appr_step_logs_inbox (tenant_id, assigned_user_id, status),
      INDEX idx_appr_step_logs_req (tenant_id, request_id, step_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_hr_employees (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NULL,
      employee_code VARCHAR(50) NOT NULL,
      full_name VARCHAR(160) NOT NULL,
      work_email VARCHAR(255) NULL,
      phone VARCHAR(40) NULL,
      gender VARCHAR(20) NULL,
      date_of_birth DATE NULL,
      nationality VARCHAR(80) NOT NULL DEFAULT 'Việt Nam',
      id_card_number VARCHAR(50) NULL,
      address TEXT NULL,
      branch_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      team_id VARCHAR(36) NULL,
      position_id VARCHAR(36) NULL,
      manager_user_id VARCHAR(36) NULL,
      employment_status VARCHAR(30) NOT NULL DEFAULT 'active',
      employment_type VARCHAR(30) NOT NULL DEFAULT 'full_time',
      join_date DATE NULL,
      resign_date DATE NULL,
      base_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_enrolled TINYINT(1) NOT NULL DEFAULT 1,
      social_insurance_number VARCHAR(50) NULL,
      is_resident TINYINT(1) NOT NULL DEFAULT 1,
      tax_code VARCHAR(50) NULL,
      dependents_count INT NOT NULL DEFAULT 0,
      union_member TINYINT(1) NOT NULL DEFAULT 0,
      allowances_json JSON NOT NULL,
      bank_name VARCHAR(120) NULL,
      bank_account_number VARCHAR(60) NULL,
      bank_account_holder VARCHAR(160) NULL,
      bank_branch VARCHAR(160) NULL,
      annual_leave_quota DECIMAL(6,2) NOT NULL DEFAULT 12,
      annual_leave_used DECIMAL(6,2) NOT NULL DEFAULT 0,
      compensatory_leave_balance DECIMAL(6,2) NOT NULL DEFAULT 0,
      digital_signature_data_url LONGTEXT NULL,
      metadata JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_employees_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_employees_code UNIQUE (tenant_id, employee_code),
      INDEX idx_hr_emp_tenant_status (tenant_id, employment_status),
      INDEX idx_hr_emp_user (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_hr_contracts (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NOT NULL,
      contract_number VARCHAR(80) NOT NULL,
      contract_type VARCHAR(30) NOT NULL DEFAULT 'fixed_term',
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      start_date DATE NOT NULL,
      end_date DATE NULL,
      base_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      allowances_json JSON NOT NULL,
      working_schedule_note VARCHAR(255) NULL,
      signed_by_employee TINYINT(1) NOT NULL DEFAULT 0,
      employee_signature_url LONGTEXT NULL,
      signed_by_employer TINYINT(1) NOT NULL DEFAULT 0,
      employer_signer_name VARCHAR(160) NULL,
      signed_at DATETIME(6) NULL,
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_contracts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_contracts_number UNIQUE (tenant_id, contract_number),
      INDEX idx_hr_contracts_emp (tenant_id, employee_id, start_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_hr_handover_assets (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NOT NULL,
      asset_code VARCHAR(80) NOT NULL,
      asset_name VARCHAR(200) NOT NULL,
      category VARCHAR(60) NOT NULL DEFAULT 'laptop',
      serial_number VARCHAR(120) NULL,
      asset_value_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      condition_on_handover VARCHAR(120) NOT NULL DEFAULT 'Mới 100%',
      status VARCHAR(30) NOT NULL DEFAULT 'assigned',
      handed_over_at DATE NOT NULL,
      returned_at DATE NULL,
      acknowledged_by_employee TINYINT(1) NOT NULL DEFAULT 0,
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_handover_assets_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_hr_assets_emp (tenant_id, employee_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_booking_links (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      host_user_id VARCHAR(36) NULL,
      host_employee_id VARCHAR(36) NULL,
      slug VARCHAR(120) NOT NULL,
      public_token VARCHAR(80) NOT NULL,
      title VARCHAR(200) NOT NULL,
      subtitle VARCHAR(255) NULL,
      description TEXT NULL,
      meeting_purpose VARCHAR(60) NOT NULL DEFAULT 'consultation',
      duration_minutes INT NOT NULL DEFAULT 30,
      buffer_minutes INT NOT NULL DEFAULT 10,
      timezone VARCHAR(60) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      location_type VARCHAR(40) NOT NULL DEFAULT 'video_link',
      location_value VARCHAR(255) NULL,
      availability_rules JSON NOT NULL,
      custom_questions JSON NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_booking_links_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_booking_links_slug UNIQUE (slug),
      CONSTRAINT uk_tenant_booking_links_token UNIQUE (public_token),
      INDEX idx_booking_links_tenant (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_booking_appointments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      booking_link_id VARCHAR(36) NOT NULL,
      guest_name VARCHAR(160) NOT NULL,
      guest_email VARCHAR(255) NULL,
      guest_phone VARCHAR(40) NULL,
      guest_company VARCHAR(200) NULL,
      topic TEXT NULL,
      answers_json JSON NOT NULL,
      booking_date DATE NOT NULL,
      start_time VARCHAR(10) NOT NULL,
      end_time VARCHAR(10) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'confirmed',
      lead_id VARCHAR(36) NULL,
      ics_uid VARCHAR(120) NULL,
      cancel_reason TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_booking_appointments_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_booking_appts_slot (tenant_id, booking_link_id, booking_date, start_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_hr_shifts (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(150) NOT NULL,
      start_time VARCHAR(10) NOT NULL DEFAULT '08:30',
      end_time VARCHAR(10) NOT NULL DEFAULT '17:30',
      break_start_time VARCHAR(10) NULL DEFAULT '12:00',
      break_end_time VARCHAR(10) NULL DEFAULT '13:00',
      break_minutes INT NOT NULL DEFAULT 60,
      grace_late_minutes INT NOT NULL DEFAULT 15,
      grace_early_leave_minutes INT NOT NULL DEFAULT 15,
      min_half_day_hours DECIMAL(5,2) NOT NULL DEFAULT 4,
      standard_work_hours DECIMAL(5,2) NOT NULL DEFAULT 8,
      work_unit_value DECIMAL(5,2) NOT NULL DEFAULT 1,
      night_shift_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.3,
      overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.5,
      weekend_overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 2.0,
      holiday_overtime_multiplier DECIMAL(5,2) NOT NULL DEFAULT 3.0,
      require_gps TINYINT(1) NOT NULL DEFAULT 1,
      require_selfie TINYINT(1) NOT NULL DEFAULT 1,
      allow_out_of_geofence_with_explanation TINYINT(1) NOT NULL DEFAULT 1,
      working_days JSON NOT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_shifts_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_hr_shifts_code UNIQUE (tenant_id, code),
      INDEX idx_hr_shifts_tenant (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_hr_shift_assignments (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      shift_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NULL,
      department_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      effective_from DATE NOT NULL,
      effective_to DATE NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_shift_assignments_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_shift_assign_lookup (tenant_id, user_id, employee_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_hr_attendance_logs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      branch_id VARCHAR(36) NULL,
      shift_id VARCHAR(36) NULL,
      work_date DATE NOT NULL,
      attendance_code VARCHAR(10) NOT NULL DEFAULT 'X',
      check_in_at DATETIME(6) NULL,
      check_out_at DATETIME(6) NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      checkout_latitude DECIMAL(10,7) NULL,
      checkout_longitude DECIMAL(10,7) NULL,
      distance_meters DECIMAL(12,2) NULL,
      checkout_distance_meters DECIMAL(12,2) NULL,
      within_geofence TINYINT(1) NOT NULL DEFAULT 1,
      selfie_data_url LONGTEXT NULL,
      checkout_selfie_data_url LONGTEXT NULL,
      device_info VARCHAR(255) NULL,
      late_minutes INT NOT NULL DEFAULT 0,
      early_leave_minutes INT NOT NULL DEFAULT 0,
      worked_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      overtime_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      work_units DECIMAL(5,2) NOT NULL DEFAULT 1,
      status VARCHAR(30) NOT NULL DEFAULT 'valid',
      note TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_attendance_logs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_hr_att_user_date UNIQUE (tenant_id, user_id, work_date),
      INDEX idx_hr_att_logs_month (tenant_id, work_date, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_hr_attendance_explanations (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      attendance_log_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NULL,
      work_date DATE NOT NULL,
      explanation_type VARCHAR(40) NOT NULL DEFAULT 'late_arrival',
      requested_check_in VARCHAR(10) NULL,
      requested_check_out VARCHAR(10) NULL,
      requested_work_units DECIMAL(5,2) NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      evidence_url TEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      approval_request_id VARCHAR(36) NULL,
      reviewed_by VARCHAR(36) NULL,
      reviewed_at DATETIME(6) NULL,
      review_comment TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_hr_attendance_explanations_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_hr_att_exp_tenant (tenant_id, status, work_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_payroll_configs (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'VND',
      standard_workdays_mode VARCHAR(20) NOT NULL DEFAULT 'calendar',
      fixed_standard_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      saturday_work_mode VARCHAR(20) NOT NULL DEFAULT 'off',
      emp_bhxh_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0800,
      emp_bhyt_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0150,
      emp_bhtn_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0100,
      er_bhxh_rate DECIMAL(6,4) NOT NULL DEFAULT 0.1750,
      er_bhyt_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0300,
      er_bhtn_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0100,
      er_union_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0200,
      emp_union_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0100,
      bhxh_salary_cap_vnd DECIMAL(18,2) NOT NULL DEFAULT 46800000,
      bhtn_salary_cap_vnd DECIMAL(18,2) NOT NULL DEFAULT 99200000,
      personal_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 11000000,
      dependent_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 4400000,
      meal_allowance_exempt_cap_vnd DECIMAL(18,2) NOT NULL DEFAULT 730000,
      non_resident_flat_tax_rate DECIMAL(6,4) NOT NULL DEFAULT 0.2000,
      casual_withholding_threshold_vnd DECIMAL(18,2) NOT NULL DEFAULT 2000000,
      casual_flat_tax_rate DECIMAL(6,4) NOT NULL DEFAULT 0.1000,
      pit_brackets JSON NOT NULL,
      allowance_definitions JSON NOT NULL,
      tax_authority_code VARCHAR(40) NULL,
      tax_authority_name VARCHAR(200) NULL,
      updated_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_payroll_configs_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_configs_one UNIQUE (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_payroll_periods (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      period_key VARCHAR(10) NOT NULL,
      year INT NOT NULL,
      month INT NOT NULL,
      title VARCHAR(200) NOT NULL,
      branch_id VARCHAR(36) NULL,
      standard_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      employee_count INT NOT NULL DEFAULT 0,
      total_gross_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_emp_insurance_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_er_insurance_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_pit_tax_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_commission_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_net_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      approval_request_id VARCHAR(36) NULL,
      approved_by VARCHAR(36) NULL,
      approved_at DATETIME(6) NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_payroll_periods_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_tenant_payroll_periods_ym UNIQUE (tenant_id, period_key),
      INDEX idx_payroll_periods_tenant (tenant_id, year, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_payroll_slips (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      period_id VARCHAR(36) NOT NULL,
      employee_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NULL,
      standard_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      actual_workdays DECIMAL(5,2) NOT NULL DEFAULT 22,
      paid_leave_days DECIMAL(5,2) NOT NULL DEFAULT 0,
      unpaid_leave_days DECIMAL(5,2) NOT NULL DEFAULT 0,
      overtime_hours DECIMAL(6,2) NOT NULL DEFAULT 0,
      base_salary_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      prorated_base_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      allowances_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax_exempt_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      overtime_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      commission_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      bonus_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      gross_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      insurance_salary_base_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_bhxh_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_bhyt_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_bhtn_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      emp_union_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      er_insurance_total_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      dependents_count INT NOT NULL DEFAULT 0,
      family_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      taxable_income_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      assessable_income_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      pit_tax_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      advance_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      other_deduction_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      net_pay_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax_method VARCHAR(40) NOT NULL DEFAULT 'progressive',
      payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid',
      breakdown JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_payroll_slips_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uk_payroll_slip_period_emp UNIQUE (tenant_id, period_id, employee_id),
      INDEX idx_payroll_slips_period (tenant_id, period_id),
      INDEX idx_payroll_slips_user (tenant_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_commission_rules (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      applies_to_role_id VARCHAR(36) NULL,
      applies_to_department_id VARCHAR(36) NULL,
      rule_type VARCHAR(30) NOT NULL DEFAULT 'percentage_revenue',
      flat_rate_pct DECIMAL(7,4) NOT NULL DEFAULT 3.0000,
      fixed_amount_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tiers_json JSON NOT NULL,
      min_revenue_threshold_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_commission_rules_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_comm_rules_tenant (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_commission_ledgers (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      period_key VARCHAR(10) NOT NULL,
      employee_id VARCHAR(36) NULL,
      user_id VARCHAR(36) NOT NULL,
      rule_id VARCHAR(36) NULL,
      lead_id VARCHAR(36) NULL,
      source_title VARCHAR(255) NOT NULL,
      revenue_base_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      commission_amount_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'approved',
      notes TEXT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT uk_tenant_commission_ledgers_tenant_id UNIQUE (tenant_id, id),
      INDEX idx_comm_ledgers_period (tenant_id, period_key, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_cooperation_slips (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      slip_code VARCHAR(80) NULL,
      title VARCHAR(255) NOT NULL,
      lead_id VARCHAR(36) NULL,
      deal_id VARCHAR(36) NULL,
      partner_name VARCHAR(255) NULL,
      partner_contact VARCHAR(120) NULL,
      commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      estimated_value_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'pending_signatures',
      terms_text TEXT NULL,
      line_items_json JSON NOT NULL,
      owner_user_id VARCHAR(36) NULL,
      approved_by VARCHAR(36) NULL,
      unit_code VARCHAR(80) NULL,
      project_name VARCHAR(200) NULL,
      expected_commission_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      total_percentage DECIMAL(6,2) NOT NULL DEFAULT 100,
      dispute_details TEXT NULL,
      approved_at DATETIME(6) NULL,
      metadata_json JSON NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_coop_slips_status (tenant_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS tenant_accounting_az_workspace (
      id VARCHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
      tenant_id VARCHAR(36) NOT NULL,
      fiscal_period VARCHAR(20) NOT NULL,
      account_code VARCHAR(40) NOT NULL DEFAULT '111',
      account_name VARCHAR(200) NOT NULL DEFAULT 'Tiền mặt',
      voucher_no VARCHAR(80) NULL,
      entry_type VARCHAR(30) NOT NULL DEFAULT 'journal',
      debit_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      credit_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      balance_vnd DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax_period VARCHAR(20) NULL,
      analytics_json JSON NOT NULL,
      extra_json JSON NOT NULL,
      created_by VARCHAR(36) NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
      INDEX idx_acc_az_period (tenant_id, fiscal_period, account_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const stmt of statements) {
    await client.query(stmt);
  }

  await addMariaDbColumnSafe(client, 'tenant_payroll_slips', 'signed_by_employee', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addMariaDbColumnSafe(client, 'tenant_payroll_slips', 'employee_signature_url', 'TEXT NULL');
  await addMariaDbColumnSafe(client, 'tenant_payroll_slips', 'employee_signed_at', 'DATETIME(6) NULL');
  await addMariaDbColumnSafe(client, 'tenant_payroll_slips', 'dispute_status', 'VARCHAR(30) NULL');
  await addMariaDbColumnSafe(client, 'tenant_payroll_slips', 'dispute_note', 'TEXT NULL');
  await addMariaDbColumnSafe(client, 'tenant_payroll_slips', 'disputed_at', 'DATETIME(6) NULL');
  await addMariaDbColumnSafe(client, 'tenant_cooperation_slips', 'unit_code', 'VARCHAR(80) NULL');
  await addMariaDbColumnSafe(client, 'tenant_cooperation_slips', 'project_name', 'VARCHAR(200) NULL');
  await addMariaDbColumnSafe(client, 'tenant_cooperation_slips', 'expected_commission_vnd', 'DECIMAL(18,2) NOT NULL DEFAULT 0');
  await addMariaDbColumnSafe(client, 'tenant_cooperation_slips', 'total_percentage', 'DECIMAL(6,2) NOT NULL DEFAULT 100');
  await addMariaDbColumnSafe(client, 'tenant_cooperation_slips', 'dispute_details', 'TEXT NULL');
  await addMariaDbColumnSafe(client, 'tenant_cooperation_slips', 'approved_at', 'DATETIME(6) NULL');
  await addMariaDbColumnSafe(client, 'tenant_cooperation_slips', 'metadata_json', 'JSON NULL');
}

/**
 * Memoized Self-Initializing Multi-Tenant Schema for Approvals, HRM, Attendance & Payroll.
 * Safe for concurrent first requests on both PostgreSQL 16 / PGlite and MariaDB 10.6.
 */
export async function ensureHrmApprovalsSchema(): Promise<void> {
  const pool = getDatabasePool();
  if (initializedPools.has(pool)) {
    return;
  }

  let running = pendingPoolInit.get(pool);
  if (!running) {
    running = (async () => {
      await withSystemPrivilege(async (client) => {
        if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
          await runMariaDbHrmApprovalsDdl(client);
        } else {
          await runPostgresHrmApprovalsDdl(client);
        }
      });
      initializedPools.add(pool);
    })().finally(() => {
      pendingPoolInit.delete(pool);
    });
    pendingPoolInit.set(pool, running);
  }

  await running;
}

export async function ensureHrmApprovalsSchemaMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await ensureHrmApprovalsSchema();
    next();
  } catch (err: any) {
    sendApiError(
      res,
      500,
      'SCHEMA_INIT_FAILED',
      err?.message || 'Không thể khởi tạo cấu trúc dữ liệu phân hệ Nhân sự & Phê duyệt.'
    );
  }
}

export const DEFAULT_APPROVAL_WORKFLOW_TEMPLATES = [
  {
    code: 'WF_LEAVE_STANDARD',
    name: 'Đơn xin nghỉ phép / Nghỉ việc riêng',
    description: 'Luồng phê duyệt nghỉ phép tự động định tuyến đến Trưởng phòng / Quản lý trực tiếp.',
    category: 'leave',
    category_label: 'Nghỉ phép',
    color_hex: '#1E40FF',
    icon_name: 'Calendar',
    form_schema: [
      {
        key: 'leave_type',
        label: 'Loại nghỉ phép',
        type: 'select',
        required: true,
        options: ['Nghỉ phép năm (hưởng nguyên lương)', 'Nghỉ bù tăng ca', 'Nghỉ việc riêng không lương', 'Nghỉ chế độ BHXH'],
      },
      { key: 'total_days', label: 'Số ngày nghỉ', type: 'number', required: true },
      { key: 'handover_person', label: 'Người nhận bàn giao công việc', type: 'text', required: false },
    ],
    steps: [
      {
        step_order: 1,
        step_name: 'Trưởng bộ phận duyệt công việc',
        approver_type: 'department_head',
        min_amount_threshold: 0,
        max_amount_threshold: null,
        approval_mode: 'any_one',
        fallback_strategy: 'tenant_admin',
        sla_hours: 24,
      },
    ],
  },
  {
    code: 'WF_EXPENSE_MULTI_STEP',
    name: 'Đề nghị thanh toán / Tạm ứng chi phí',
    description: 'Luồng phê duyệt đa cấp tự động kích hoạt cấp Giám đốc Chi nhánh theo ngưỡng số tiền cấu hình.',
    category: 'expense',
    category_label: 'Chi phí & Thanh toán',
    color_hex: '#0284C7',
    icon_name: 'Receipt',
    form_schema: [
      {
        key: 'expense_category',
        label: 'Khoản mục chi phí',
        type: 'select',
        required: true,
        options: ['Chi phí vận hành', 'Chi phí Marketing / Sự kiện', 'Công tác phí', 'Mua sắm thiết bị', 'Thanh toán nhà cung cấp'],
      },
      { key: 'beneficiary_bank', label: 'Ngân hàng thụ hưởng', type: 'text', required: false },
      { key: 'beneficiary_account', label: 'Số tài khoản nhận', type: 'text', required: false },
    ],
    steps: [
      {
        step_order: 1,
        step_name: 'Trưởng phòng xác nhận nghiệp vụ',
        approver_type: 'department_head',
        min_amount_threshold: 0,
        max_amount_threshold: null,
        approval_mode: 'any_one',
        fallback_strategy: 'escalate_parent_dept',
        sla_hours: 24,
      },
      {
        step_order: 2,
        step_name: 'Giám đốc Chi nhánh phê duyệt ngân sách',
        approver_type: 'branch_director',
        min_amount_threshold: 10000000,
        max_amount_threshold: null,
        approval_mode: 'any_one',
        fallback_strategy: 'tenant_admin',
        sla_hours: 48,
      },
    ],
  },
  {
    code: 'WF_OVERTIME_REQUEST',
    name: 'Đăng ký làm thêm giờ (OT)',
    description: 'Xác nhận giờ tăng ca để tự động đồng bộ vào Bảng công & Bảng lương cuối kỳ.',
    category: 'overtime',
    category_label: 'Tăng ca (OT)',
    color_hex: '#059669',
    icon_name: 'Clock',
    form_schema: [
      { key: 'ot_hours', label: 'Số giờ đăng ký OT', type: 'number', required: true },
      {
        key: 'ot_day_type',
        label: 'Loại ngày làm thêm',
        type: 'select',
        required: true,
        options: ['Ngày thường (150%)', 'Ngày nghỉ hàng tuần (200%)', 'Ngày Lễ / Tết (300%)'],
      },
    ],
    steps: [
      {
        step_order: 1,
        step_name: 'Quản lý trực tiếp xác nhận OT',
        approver_type: 'direct_manager',
        min_amount_threshold: 0,
        max_amount_threshold: null,
        approval_mode: 'any_one',
        fallback_strategy: 'tenant_admin',
        sla_hours: 16,
      },
    ],
  },
];

/**
 * Seeds default dynamic approval workflows per tenant ONLY on initial bootstrap
 * when `approvals_custom_mode`, `approvals_custom_only`, `approvals_initialized`,
 * and `approvals_starter_dismissed` are all unset and workflow count is 0.
 * Once deleted or switched to custom mode, starter workflows are NEVER auto-reseeded.
 */
export async function ensureDefaultApprovalWorkflowsInTx(
  client: DbClient,
  tenantId: string
): Promise<void> {
  const tenantRes = await client.query<{ slug: string; settings: unknown }>(
    'SELECT slug, settings FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId]
  );
  const tenantRow = tenantRes.rows[0];
  const rawSettings = parseJsonSafe<Record<string, unknown>>(tenantRow?.settings, {});
  if (
    rawSettings.approvals_custom_only === true ||
    rawSettings.approvals_custom_mode === true ||
    rawSettings.approvals_initialized === true ||
    rawSettings.approvals_starter_dismissed === true
  ) {
    return;
  }
  const cntRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM tenant_approval_workflows WHERE tenant_id = $1',
    [tenantId]
  );
  if (Number(cntRes.rows[0]?.cnt || 0) > 0) return;

  for (const tpl of DEFAULT_APPROVAL_WORKFLOW_TEMPLATES) {
    const wfId = crypto.randomUUID();
    await client.query(
      `INSERT INTO tenant_approval_workflows (
         id, tenant_id, code, name, description, category, category_label, form_schema, icon_name, color_hex, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, true)`,
      [
        wfId,
        tenantId,
        tpl.code,
        tpl.name,
        tpl.description,
        tpl.category,
        tpl.category_label,
        JSON.stringify(tpl.form_schema),
        tpl.icon_name,
        tpl.color_hex,
      ]
    );

    for (const st of tpl.steps) {
      await client.query(
        `INSERT INTO tenant_approval_workflow_steps (
           id, tenant_id, workflow_id, step_order, step_name, approver_type,
           min_amount_threshold, max_amount_threshold, approval_mode, fallback_strategy, sla_hours
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          crypto.randomUUID(),
          tenantId,
          wfId,
          st.step_order,
          st.step_name,
          st.approver_type,
          st.min_amount_threshold,
          st.max_amount_threshold,
          st.approval_mode,
          st.fallback_strategy,
          st.sla_hours,
        ]
      );
    }
  }

  const nextSettings = { ...rawSettings, approvals_initialized: true };
  if (client.dialect === 'mariadb') {
    await client.query(
      'UPDATE tenants SET settings = $2, updated_at = CURRENT_TIMESTAMP(6) WHERE id = $1',
      [tenantId, JSON.stringify(nextSettings)]
    );
  } else {
    await client.query(
      'UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1',
      [tenantId, JSON.stringify(nextSettings)]
    );
  }
  if (tenantRow?.slug) {
    tenantRedis.invalidateTenantCache(tenantId, tenantRow.slug);
  }
}

/**
 * Seeds a default standard shift when a tenant has 0 shifts configured yet.
 */
export async function ensureDefaultShiftsInTx(client: DbClient, tenantId: string): Promise<void> {
  const cntRes = await client.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM tenant_hr_shifts WHERE tenant_id = $1',
    [tenantId]
  );
  if (Number(cntRes.rows[0]?.cnt || 0) > 0) return;

  await client.query(
    `INSERT INTO tenant_hr_shifts (
       id, tenant_id, code, name, start_time, end_time, break_start_time, break_end_time,
       break_minutes, grace_late_minutes, grace_early_leave_minutes, min_half_day_hours,
       standard_work_hours, work_unit_value, night_shift_multiplier, overtime_multiplier,
       weekend_overtime_multiplier, holiday_overtime_multiplier, require_gps, require_selfie,
       allow_out_of_geofence_with_explanation, working_days, is_default, is_active
     ) VALUES (
       $1, $2, 'SHIFT_OFFICE', 'Ca Hành Chính Chuẩn', '08:30', '17:30', '12:00', '13:00',
       60, 15, 15, 4, 8, 1, 1.3, 1.5, 2.0, 3.0, true, true, true, $3::jsonb, true, true
     )`,
    [crypto.randomUUID(), tenantId, JSON.stringify([1, 2, 3, 4, 5])]
  );
}
