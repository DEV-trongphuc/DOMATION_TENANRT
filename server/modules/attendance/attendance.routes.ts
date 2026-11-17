import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../../core/security/rbac.ts';
import { slugifyCode } from '../org-rbac/org-rbac.service.ts';
import {
  computeHaversineMeters,
  ensureDefaultApprovalWorkflowsInTx,
  ensureDefaultShiftsInTx,
  parseJsonSafe,
  toBool,
  toNum,
} from '../hrm/schema.ts';
import { createApprovalRequestInTx } from '../approvals/approval-engine.ts';
import { ensureAttendanceWaveAMiddleware } from './schema.ts';
import {
  evaluateGeofenceAgainstPolicy,
  getAttendancePolicyInTx,
  getClientIpFromRequest,
  hasActiveApprovedRemoteLeave,
  isIpMatchingWhitelist,
  normalizeGeofenceMode,
  resolveEffectiveExemptionForUser,
} from './policy-engine.ts';

function parseHHMM(val: unknown, fallbackMinutes: number): number {
  const m = String(val || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackMinutes;
  return Number(m[1]) * 60 + Number(m[2]);
}

function getLocalHHMMAndDate(ts: Date): { dateStr: string; minutesOfDay: number } {
  // Use Asia/Ho_Chi_Minh (+07:00) wall-clock offset by default for consistent shift comparison
  const vnMs = ts.getTime() + 7 * 3600_000;
  const vnDate = new Date(vnMs);
  const dateStr = vnDate.toISOString().slice(0, 10);
  const minutesOfDay = vnDate.getUTCHours() * 60 + vnDate.getUTCMinutes();
  return { dateStr, minutesOfDay };
}

export const attendanceRouter = Router();

attendanceRouter.use(ensureAttendanceWaveAMiddleware);
attendanceRouter.use(requireTenantAuth);
attendanceRouter.use(requireEntitlement('attendance'));

// Helper inside transaction: resolve active shift + locked branch for user
async function resolveUserShiftAndBranchInTx(
  client: any,
  tenantId: string,
  userId: string,
  requestedBranchId?: string | null,
  requestedShiftId?: string | null,
  allowAnyBranchCheckin = false
) {
  await ensureDefaultShiftsInTx(client, tenantId);

  const [userRes, empRes, shiftsRes, assignRes, branchesRes] = await Promise.all([
    client.query(
      'SELECT id, full_name, role, role_id, branch_id, department_id, team_id, position_id FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, userId]
    ),
    client.query(
      'SELECT id, branch_id, department_id FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
      [tenantId, userId]
    ),
    client.query(
      'SELECT * FROM tenant_hr_shifts WHERE tenant_id = $1 AND is_active = true ORDER BY is_default DESC, created_at ASC',
      [tenantId]
    ),
    client.query(
      `SELECT * FROM tenant_hr_shift_assignments
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [tenantId]
    ),
    client.query(
      'SELECT * FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC, created_at ASC',
      [tenantId]
    ),
  ]);

  const user = userRes.rows[0] || null;
  const emp = empRes.rows[0] || null;
  const empId = emp?.id ? String(emp.id) : null;
  const deptId = (emp?.department_id || user?.department_id) ? String(emp?.department_id || user?.department_id) : null;
  const userBranchId = (emp?.branch_id || user?.branch_id) ? String(emp?.branch_id || user?.branch_id) : null;

  // Resolve shift priority: explicit request -> user/emp assignment -> dept assignment -> branch assignment -> default shift
  const shiftsMap = new Map<string, any>();
  for (const s of shiftsRes.rows) shiftsMap.set(String(s.id), s);

  let resolvedShift = requestedShiftId ? shiftsMap.get(String(requestedShiftId)) : null;
  let assignedBranchId: string | null = null;

  if (!resolvedShift) {
    const matchUserAssign = assignRes.rows.find(
      (a: any) =>
        (a.user_id && String(a.user_id) === userId) ||
        (empId && a.employee_id && String(a.employee_id) === empId)
    );
    const matchDeptAssign = !matchUserAssign && deptId
      ? assignRes.rows.find((a: any) => a.department_id && String(a.department_id) === deptId)
      : null;
    const matchBranchAssign = !matchUserAssign && !matchDeptAssign && userBranchId
      ? assignRes.rows.find((a: any) => a.branch_id && String(a.branch_id) === userBranchId)
      : null;

    const chosenAssign = matchUserAssign || matchDeptAssign || matchBranchAssign;
    if (chosenAssign) {
      resolvedShift = shiftsMap.get(String(chosenAssign.shift_id)) || null;
      if (chosenAssign.branch_id) assignedBranchId = String(chosenAssign.branch_id);
    }
  }
  if (!resolvedShift) {
    resolvedShift = shiftsRes.rows[0] || null;
  }

  // Resolve locked branch: emp/user assigned branch OR shift assignment branch.
  // NEVER silently fall back to an unrelated branch; reject mismatched branch when allow_any_branch_checkin = false.
  const branches = branchesRes.rows;
  const lockedBranchId = userBranchId || assignedBranchId || null;
  let resolvedBranch: any = null;

  if (requestedBranchId) {
    const reqBranch = branches.find((b: any) => String(b.id) === String(requestedBranchId)) || null;
    if (!reqBranch) {
      throw new Error('BRANCH_NOT_FOUND');
    }
    if (lockedBranchId && String(reqBranch.id) !== lockedBranchId && !allowAnyBranchCheckin) {
      throw new Error('BRANCH_CHECKIN_RESTRICTED');
    }
    resolvedBranch = reqBranch;
  } else {
    resolvedBranch =
      (lockedBranchId ? branches.find((b: any) => String(b.id) === lockedBranchId) : null) ||
      branches.find((b: any) => toBool(b.is_headquarters, false)) ||
      branches[0] ||
      null;
  }

  if (resolvedBranch) {
    resolvedBranch = {
      ...resolvedBranch,
      gps_lat: resolvedBranch.gps_lat !== null && resolvedBranch.gps_lat !== undefined ? Number(resolvedBranch.gps_lat) : null,
      gps_lng: resolvedBranch.gps_lng !== null && resolvedBranch.gps_lng !== undefined ? Number(resolvedBranch.gps_lng) : null,
      gps_radius_meters: Number(resolvedBranch.gps_radius_meters || 150),
      branch_ip_whitelist: parseJsonSafe<string[]>(resolvedBranch.branch_ip_whitelist, []),
    };
  }

  return {
    employeeId: empId,
    lockedBranchId,
    userInfo: {
      userId,
      role: user?.role ? String(user.role) : null,
      roleId: user?.role_id ? String(user.role_id) : null,
      departmentId: deptId,
      teamId: user?.team_id ? String(user.team_id) : null,
      positionId: user?.position_id ? String(user.position_id) : null,
    },
    shift: resolvedShift,
    branch: resolvedBranch,
    allBranches: branches.map((b: any) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      address: b.address,
      gps_lat: b.gps_lat !== null && b.gps_lat !== undefined ? Number(b.gps_lat) : null,
      gps_lng: b.gps_lng !== null && b.gps_lng !== undefined ? Number(b.gps_lng) : null,
      gps_radius_meters: Number(b.gps_radius_meters || 150),
      branch_ip_whitelist: parseJsonSafe<string[]>(b.branch_ip_whitelist, []),
      is_headquarters: toBool(b.is_headquarters, false),
    })),
  };
}

// ============================================================================
// 1. Live Check-In Overview (`/overview`)
// ============================================================================
attendanceRouter.get('/overview', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const clientIp = getClientIpFromRequest(req);
    const todayStr = getLocalHHMMAndDate(new Date()).dateStr;
    const ymPrefix = todayStr.slice(0, 7);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const policy = await getAttendancePolicyInTx(client, ctx.tenantId);
      const resolved = await resolveUserShiftAndBranchInTx(
        client,
        ctx.tenantId,
        ctx.userId,
        null,
        null,
        policy.allow_any_branch_checkin
      );
      const [todayLogRes, monthStatsRes, pendingExpRes, effectiveExemption, approvedRemoteLeave] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND user_id = $2 AND work_date = $3 LIMIT 1',
          [ctx.tenantId, ctx.userId, todayStr]
        ),
        client.query<{
          my_work_units: number;
          my_late_days: number;
          company_today_checkins: number;
        }>(
          `SELECT
             COALESCE(SUM(CASE WHEN user_id = $2 THEN work_units ELSE 0 END), 0) AS my_work_units,
             COALESCE(SUM(CASE WHEN user_id = $2 AND late_minutes > 0 THEN 1 ELSE 0 END), 0) AS my_late_days,
             COALESCE(SUM(CASE WHEN work_date = $3 THEN 1 ELSE 0 END), 0) AS company_today_checkins
           FROM tenant_hr_attendance_logs
           WHERE tenant_id = $1 AND work_date >= $4`,
          [ctx.tenantId, ctx.userId, todayStr, `${ymPrefix}-01`]
        ),
        client.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt
           FROM tenant_hr_attendance_explanations
           WHERE tenant_id = $1 AND status = 'pending'`,
          [ctx.tenantId]
        ),
        resolveEffectiveExemptionForUser(client, ctx.tenantId, resolved.userInfo, todayStr),
        hasActiveApprovedRemoteLeave(client, ctx.tenantId, ctx.userId, todayStr),
      ]);

      const st = monthStatsRes.rows[0] || { my_work_units: 0, my_late_days: 0, company_today_checkins: 0 };
      const todayLog = todayLogRes.rows[0] || null;
      const ipWhitelisted = Boolean(
        policy.allow_ip_whitelist_bypass &&
          clientIp &&
          resolved.branch &&
          isIpMatchingWhitelist(clientIp, resolved.branch.branch_ip_whitelist || [])
      );

      return {
        today_date: todayStr,
        client_ip: clientIp,
        ip_whitelist_matched: ipWhitelisted,
        approved_remote_leave: approvedRemoteLeave,
        policy,
        effective_exemption: effectiveExemption,
        today_log: todayLog
          ? {
              ...todayLog,
              distance_meters: todayLog.distance_meters !== null ? toNum(todayLog.distance_meters, 0) : null,
              within_geofence: toBool(todayLog.within_geofence, true),
              work_units: toNum(todayLog.work_units, 0),
              worked_hours: toNum(todayLog.worked_hours, 0),
            }
          : null,
        active_shift: resolved.shift
          ? {
              ...resolved.shift,
              working_days: parseJsonSafe<number[]>(resolved.shift.working_days, [1, 2, 3, 4, 5]),
              require_gps: toBool(resolved.shift.require_gps, true),
              require_selfie: toBool(resolved.shift.require_selfie, true),
              allow_out_of_geofence_with_explanation: toBool(
                resolved.shift.allow_out_of_geofence_with_explanation,
                true
              ),
            }
          : null,
        active_branch: resolved.branch,
        branches: resolved.allBranches,
        summary: {
          my_month_work_units: toNum(st.my_work_units, 0),
          my_month_late_days: Number(st.my_late_days || 0),
          company_today_checkins: Number(st.company_today_checkins || 0),
          pending_explanations: Number(pendingExpRes.rows[0]?.cnt || 0),
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'ATTENDANCE_OVERVIEW_FAILED', err?.message || 'Không thể tải trạng thái chấm công.');
  }
});

// ============================================================================
// 2. Shifts & Shift Assignments Studio (`/shifts`, `/shift-assignments`)
// ============================================================================
attendanceRouter.get('/shifts', requirePermission('attendance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultShiftsInTx(client, ctx.tenantId);
      const r = await client.query(
        'SELECT * FROM tenant_hr_shifts WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows.map((s) => ({
        ...s,
        grace_late_minutes: Number(s.grace_late_minutes || 0),
        grace_early_leave_minutes: Number(s.grace_early_leave_minutes || 0),
        break_minutes: Number(s.break_minutes || 0),
        standard_work_hours: toNum(s.standard_work_hours, 8),
        min_half_day_hours: toNum(s.min_half_day_hours, 4),
        work_unit_value: toNum(s.work_unit_value, 1),
        night_shift_multiplier: toNum(s.night_shift_multiplier, 1.3),
        overtime_multiplier: toNum(s.overtime_multiplier, 1.5),
        weekend_overtime_multiplier: toNum(s.weekend_overtime_multiplier, 2.0),
        holiday_overtime_multiplier: toNum(s.holiday_overtime_multiplier, 3.0),
        require_gps: toBool(s.require_gps, true),
        require_selfie: toBool(s.require_selfie, true),
        allow_out_of_geofence_with_explanation: toBool(s.allow_out_of_geofence_with_explanation, true),
        is_default: toBool(s.is_default, false),
        is_active: toBool(s.is_active, true),
        working_days: parseJsonSafe<number[]>(s.working_days, [1, 2, 3, 4, 5]),
      }));
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SHIFTS_FAILED', err?.message || 'Không thể tải danh sách ca làm việc.');
  }
});

attendanceRouter.post('/shifts', requirePermission('attendance', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên ca làm việc không được để trống.');
      return;
    }
    const id = crypto.randomUUID();
    const code = slugifyCode(b.code || name, 'SH');

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (b.is_default) {
        await client.query('UPDATE tenant_hr_shifts SET is_default = false WHERE tenant_id = $1', [ctx.tenantId]);
      }
      await client.query(
        `INSERT INTO tenant_hr_shifts (
           id, tenant_id, code, name, start_time, end_time,
           break_start_time, break_end_time, break_minutes,
           grace_late_minutes, grace_early_leave_minutes,
           min_half_day_hours, standard_work_hours, work_unit_value,
           night_shift_multiplier, overtime_multiplier, weekend_overtime_multiplier, holiday_overtime_multiplier,
           require_gps, require_selfie, allow_out_of_geofence_with_explanation,
           working_days, is_default, is_active
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9,
           $10, $11,
           $12, $13, $14,
           $15, $16, $17, $18,
           $19, $20, $21,
           $22::jsonb, $23, $24
         )`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          String(b.start_time || '08:30').trim(),
          String(b.end_time || '17:30').trim(),
          b.break_start_time ? String(b.break_start_time).trim() : '12:00',
          b.break_end_time ? String(b.break_end_time).trim() : '13:00',
          Math.max(0, Number(b.break_minutes ?? 60)),
          Math.max(0, Number(b.grace_late_minutes ?? 15)),
          Math.max(0, Number(b.grace_early_leave_minutes ?? 15)),
          Math.max(0.5, toNum(b.min_half_day_hours, 4)),
          Math.max(1, toNum(b.standard_work_hours, 8)),
          Math.max(0.25, toNum(b.work_unit_value, 1)),
          Math.max(1, toNum(b.night_shift_multiplier, 1.3)),
          Math.max(1, toNum(b.overtime_multiplier, 1.5)),
          Math.max(1, toNum(b.weekend_overtime_multiplier, 2.0)),
          Math.max(1, toNum(b.holiday_overtime_multiplier, 3.0)),
          b.require_gps !== false,
          b.require_selfie !== false,
          b.allow_out_of_geofence_with_explanation !== false,
          JSON.stringify(Array.isArray(b.working_days) ? b.working_days : [1, 2, 3, 4, 5]),
          Boolean(b.is_default),
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_hr_shifts WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SHIFT_FAILED', err?.message || 'Không thể tạo ca làm việc.');
  }
});

const updateShiftHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_hr_shifts WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (curRes.rows.length === 0) return null;
      const cur = curRes.rows[0];

      if (b.is_default === true) {
        await client.query('UPDATE tenant_hr_shifts SET is_default = false WHERE tenant_id = $1 AND id != $2', [
          ctx.tenantId,
          id,
        ]);
      }

      await client.query(
        `UPDATE tenant_hr_shifts
         SET name = $3,
             start_time = $4,
             end_time = $5,
             break_minutes = $6,
             grace_late_minutes = $7,
             grace_early_leave_minutes = $8,
             standard_work_hours = $9,
             night_shift_multiplier = $10,
             overtime_multiplier = $11,
             require_gps = $12,
             require_selfie = $13,
             allow_out_of_geofence_with_explanation = $14,
             working_days = $15::jsonb,
             is_default = $16,
             is_active = $17,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          id,
          b.name !== undefined ? String(b.name).trim() : cur.name,
          b.start_time !== undefined ? String(b.start_time).trim() : cur.start_time,
          b.end_time !== undefined ? String(b.end_time).trim() : cur.end_time,
          b.break_minutes !== undefined ? Number(b.break_minutes) : Number(cur.break_minutes),
          b.grace_late_minutes !== undefined ? Number(b.grace_late_minutes) : Number(cur.grace_late_minutes),
          b.grace_early_leave_minutes !== undefined
            ? Number(b.grace_early_leave_minutes)
            : Number(cur.grace_early_leave_minutes),
          b.standard_work_hours !== undefined ? toNum(b.standard_work_hours, 8) : toNum(cur.standard_work_hours, 8),
          b.night_shift_multiplier !== undefined
            ? toNum(b.night_shift_multiplier, 1.3)
            : toNum(cur.night_shift_multiplier, 1.3),
          b.overtime_multiplier !== undefined
            ? toNum(b.overtime_multiplier, 1.5)
            : toNum(cur.overtime_multiplier, 1.5),
          b.require_gps !== undefined ? Boolean(b.require_gps) : toBool(cur.require_gps, true),
          b.require_selfie !== undefined ? Boolean(b.require_selfie) : toBool(cur.require_selfie, true),
          b.allow_out_of_geofence_with_explanation !== undefined
            ? Boolean(b.allow_out_of_geofence_with_explanation)
            : toBool(cur.allow_out_of_geofence_with_explanation, true),
          b.working_days !== undefined
            ? JSON.stringify(b.working_days)
            : JSON.stringify(parseJsonSafe<number[]>(cur.working_days, [1, 2, 3, 4, 5])),
          b.is_default !== undefined ? Boolean(b.is_default) : toBool(cur.is_default, false),
          b.is_active !== undefined ? Boolean(b.is_active) : toBool(cur.is_active, true),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_hr_shifts WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'SHIFT_NOT_FOUND', 'Không tìm thấy ca làm việc.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_SHIFT_FAILED', err?.message || 'Không thể cập nhật ca làm việc.');
  }
};

attendanceRouter.put('/shifts/:id', requirePermission('attendance', 'manage_config'), updateShiftHandler);
attendanceRouter.patch('/shifts/:id', requirePermission('attendance', 'manage_config'), updateShiftHandler);

attendanceRouter.delete('/shifts/:id', requirePermission('attendance', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_hr_shifts WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_SHIFT_FAILED', err?.message || 'Không thể xóa ca làm việc.');
  }
});

attendanceRouter.get('/shift-assignments', requirePermission('attendance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT sa.*, s.name AS shift_name, s.start_time, s.end_time,
                u.full_name AS user_name, e.full_name AS employee_name,
                d.name AS department_name, b.name AS branch_name
         FROM tenant_hr_shift_assignments sa
         INNER JOIN tenant_hr_shifts s ON s.tenant_id = sa.tenant_id AND s.id = sa.shift_id
         LEFT JOIN users u ON u.tenant_id = sa.tenant_id AND u.id = sa.user_id
         LEFT JOIN tenant_hr_employees e ON e.tenant_id = sa.tenant_id AND e.id = sa.employee_id
         LEFT JOIN tenant_departments d ON d.tenant_id = sa.tenant_id AND d.id = sa.department_id
         LEFT JOIN tenant_branches b ON b.tenant_id = sa.tenant_id AND b.id = sa.branch_id
         WHERE sa.tenant_id = $1
         ORDER BY sa.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SHIFT_ASSIGNMENTS_FAILED', err?.message || 'Không thể tải phân ca nhân sự.');
  }
});

attendanceRouter.post('/shift-assignments', requirePermission('attendance', 'assign'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const shiftId = String(b.shift_id || '').trim();
    if (!shiftId) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng chọn ca làm việc cần phân công.');
      return;
    }

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_hr_shift_assignments (
           id, tenant_id, shift_id, employee_id, user_id, department_id, branch_id,
           effective_from, effective_to, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
        [
          id,
          ctx.tenantId,
          shiftId,
          b.employee_id || null,
          b.user_id || null,
          b.department_id || null,
          b.branch_id || null,
          b.effective_from || new Date().toISOString().slice(0, 10),
          b.effective_to || null,
        ]
      );
      const r = await client.query(
        'SELECT * FROM tenant_hr_shift_assignments WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_SHIFT_ASSIGNMENT_FAILED', err?.message || 'Không thể lưu phân ca.');
  }
});

attendanceRouter.delete('/shift-assignments/:id', requirePermission('attendance', 'assign'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_hr_shift_assignments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_SHIFT_ASSIGNMENT_FAILED', err?.message || 'Không thể xóa phân ca.');
  }
});

// ============================================================================
// 3. Multi-Tier GPS + Selfie Check-In & Check-Out (`/check-in`, `/check-out`)
// ============================================================================
attendanceRouter.post('/check-in', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const clientIp = getClientIpFromRequest(req);

    // ANTI-SPOOFING FIX #1: NEVER accept client `b.timestamp` or `b.work_date` — always derive from server clock!
    const checkInTs = new Date();
    const { dateStr: workDate, minutesOfDay } = getLocalHHMMAndDate(checkInTs);

    const lat = b.latitude !== undefined && b.latitude !== null && b.latitude !== '' ? Number(b.latitude) : null;
    const lng = b.longitude !== undefined && b.longitude !== null && b.longitude !== '' ? Number(b.longitude) : null;
    const accuracyMeters =
      b.accuracy_meters !== undefined && b.accuracy_meters !== null && b.accuracy_meters !== ''
        ? Number(b.accuracy_meters)
        : null;
    const selfieDataUrl = b.selfie_data_url ? String(b.selfie_data_url) : null;
    const noteText = b.note ? String(b.note).trim() : null;

    const record = await withTenantTransaction(ctx.tenantId, async (client) => {
      const policy = await getAttendancePolicyInTx(client, ctx.tenantId);
      const resolved = await resolveUserShiftAndBranchInTx(
        client,
        ctx.tenantId,
        ctx.userId,
        b.branch_id ? String(b.branch_id) : null,
        b.shift_id ? String(b.shift_id) : null,
        policy.allow_any_branch_checkin
      );

      const shift = resolved.shift;
      const branch = resolved.branch;

      const [exemption, approvedRemoteLeave] = await Promise.all([
        resolveEffectiveExemptionForUser(client, ctx.tenantId, resolved.userInfo, workDate),
        hasActiveApprovedRemoteLeave(client, ctx.tenantId, ctx.userId, workDate),
      ]);

      const geoResult = evaluateGeofenceAgainstPolicy({
        policy,
        exemption,
        approvedRemoteLeave,
        branch,
        clientIp,
        lat,
        lng,
        accuracyMeters,
        hasSelfie: Boolean(selfieDataUrl),
        isCheckOut: false,
        note: noteText,
      });

      const startMinutes = parseHHMM(shift?.start_time || '08:30', 510);
      const graceLate =
        exemption.custom_grace_late_minutes !== null
          ? exemption.custom_grace_late_minutes
          : Number(shift?.grace_late_minutes ?? policy.grace_late_minutes ?? 15);
      const rawLate = Math.max(0, minutesOfDay - startMinutes);
      const lateMinutes = exemption.exempt_checkin ? 0 : rawLate > graceLate ? rawLate : 0;

      const workUnitValue = toNum(shift?.work_unit_value, 1);
      const status = !geoResult.withinGeofence
        ? 'out_of_geofence'
        : lateMinutes > 0
          ? 'late'
          : 'valid';

      const existingRes = await client.query(
        'SELECT id FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND user_id = $2 AND work_date = $3 LIMIT 1',
        [ctx.tenantId, ctx.userId, workDate]
      );

      let logId: string;
      if (existingRes.rows.length > 0) {
        logId = String(existingRes.rows[0].id);
        await client.query(
          `UPDATE tenant_hr_attendance_logs
           SET branch_id = $3,
               shift_id = $4,
               employee_id = COALESCE($5, employee_id),
               check_in_at = $6,
               latitude = $7,
               longitude = $8,
               accuracy_meters = $9,
               distance_meters = $10,
               within_geofence = $11,
               selfie_data_url = COALESCE($12, selfie_data_url),
               device_info = COALESCE($13, device_info),
               late_minutes = $14,
               work_units = $15,
               status = $16,
               note = COALESCE($17, note),
               checkin_ip = $18,
               verification_method = $19,
               geofence_mode_applied = $20,
               exemption_applied = $21,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            logId,
            branch?.id || null,
            shift?.id || null,
            resolved.employeeId,
            checkInTs.toISOString(),
            lat !== null && Number.isFinite(lat) ? lat : null,
            lng !== null && Number.isFinite(lng) ? lng : null,
            accuracyMeters !== null && Number.isFinite(accuracyMeters) ? accuracyMeters : null,
            geoResult.distanceMeters,
            geoResult.withinGeofence,
            selfieDataUrl,
            b.device_info ? String(b.device_info).slice(0, 250) : null,
            lateMinutes,
            workUnitValue,
            status,
            noteText,
            clientIp || null,
            geoResult.verificationMethod,
            geoResult.geofenceMode,
            geoResult.exemptionApplied,
          ]
        );
      } else {
        logId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_hr_attendance_logs (
             id, tenant_id, user_id, employee_id, branch_id, shift_id,
             work_date, attendance_code, check_in_at, latitude, longitude, accuracy_meters,
             distance_meters, within_geofence, selfie_data_url, device_info,
             late_minutes, work_units, status, note,
             checkin_ip, verification_method, geofence_mode_applied, exemption_applied
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, 'X', $8, $9, $10, $11,
             $12, $13, $14, $15,
             $16, $17, $18, $19,
             $20, $21, $22, $23
           )`,
          [
            logId,
            ctx.tenantId,
            ctx.userId,
            resolved.employeeId,
            branch?.id || null,
            shift?.id || null,
            workDate,
            checkInTs.toISOString(),
            lat !== null && Number.isFinite(lat) ? lat : null,
            lng !== null && Number.isFinite(lng) ? lng : null,
            accuracyMeters !== null && Number.isFinite(accuracyMeters) ? accuracyMeters : null,
            geoResult.distanceMeters,
            geoResult.withinGeofence,
            selfieDataUrl,
            b.device_info ? String(b.device_info).slice(0, 250) : null,
            lateMinutes,
            workUnitValue,
            status,
            noteText,
            clientIp || null,
            geoResult.verificationMethod,
            geoResult.geofenceMode,
            geoResult.exemptionApplied,
          ]
        );
      }

      const saved = await client.query(
        'SELECT * FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, logId]
      );
      const row = saved.rows[0];
      return {
        ...row,
        distance_meters: row.distance_meters !== null ? toNum(row.distance_meters, 0) : null,
        accuracy_meters: row.accuracy_meters !== null ? toNum(row.accuracy_meters, 0) : null,
        within_geofence: toBool(row.within_geofence, true),
        exemption_applied: toBool(row.exemption_applied, false),
        late_minutes: Number(row.late_minutes || 0),
        work_units: toNum(row.work_units, 1),
        branch_radius_meters: branch?.gps_radius_meters ?? null,
        branch_name: branch?.name ?? null,
        geofence_mode: geoResult.geofenceMode,
        verification_method: geoResult.verificationMethod,
        ip_whitelist_matched: geoResult.ipWhitelisted,
      };
    });

    res.status(201).json({ success: true, data: record });
  } catch (err: any) {
    if (err?.message === 'OUT_OF_GEOFENCE_STRICT_BLOCK') {
      sendApiError(
        res,
        403,
        'OUT_OF_GEOFENCE_STRICT_BLOCK',
        'Vị trí hiện tại thiếu tọa độ GPS chính xác hoặc nằm ngoài bán kính cho phép theo chính sách chấm công Strict Radius.'
      );
      return;
    }
    if (err?.message === 'BRANCH_CHECKIN_RESTRICTED') {
      sendApiError(
        res,
        403,
        'BRANCH_CHECKIN_RESTRICTED',
        'Tài khoản chỉ được phép chấm công tại chi nhánh được phân công.'
      );
      return;
    }
    if (err?.message === 'BRANCH_NOT_FOUND') {
      sendApiError(res, 404, 'BRANCH_NOT_FOUND', 'Không tìm thấy chi nhánh chấm công.');
      return;
    }
    if (err?.message === 'EXPLANATION_REQUIRED') {
      sendApiError(
        res,
        422,
        'EXPLANATION_REQUIRED',
        'Vui lòng nhập lý do giải trình khi chấm công ngoài vùng quy định.'
      );
      return;
    }
    if (err?.message === 'SELFIE_REQUIRED') {
      sendApiError(res, 422, 'SELFIE_REQUIRED', 'Chính sách chấm công yêu cầu chụp ảnh Selfie hợp lệ.');
      return;
    }
    sendApiError(res, 500, 'CHECK_IN_FAILED', err?.message || 'Không thể ghi nhận Check-in.');
  }
});

attendanceRouter.post('/check-out', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const clientIp = getClientIpFromRequest(req);

    // ANTI-SPOOFING FIX #1: NEVER accept client `b.timestamp` or `b.work_date` — always derive from server clock!
    const checkOutTs = new Date();
    const { dateStr: workDate, minutesOfDay: outMinutes } = getLocalHHMMAndDate(checkOutTs);
    const yesterdayDate = getLocalHHMMAndDate(new Date(checkOutTs.getTime() - 86_400_000)).dateStr;

    const lat = b.latitude !== undefined && b.latitude !== null && b.latitude !== '' ? Number(b.latitude) : null;
    const lng = b.longitude !== undefined && b.longitude !== null && b.longitude !== '' ? Number(b.longitude) : null;
    const accuracyMeters =
      b.accuracy_meters !== undefined && b.accuracy_meters !== null && b.accuracy_meters !== ''
        ? Number(b.accuracy_meters)
        : null;
    const noteText = b.note ? String(b.note).trim() : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const policy = await getAttendancePolicyInTx(client, ctx.tenantId);

      let logRes = await client.query(
        'SELECT * FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND user_id = $2 AND work_date = $3 LIMIT 1',
        [ctx.tenantId, ctx.userId, workDate]
      );
      if (logRes.rows.length === 0 && policy.enable_night_shift) {
        logRes = await client.query(
          'SELECT * FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND user_id = $2 AND work_date = $3 AND check_out_at IS NULL LIMIT 1',
          [ctx.tenantId, ctx.userId, yesterdayDate]
        );
      }
      if (logRes.rows.length === 0) {
        throw new Error('CHECKIN_NOT_FOUND');
      }
      const curLog = logRes.rows[0];
      const targetBranchParam = b.branch_id ? String(b.branch_id) : curLog.branch_id ? String(curLog.branch_id) : null;
      const resolved = await resolveUserShiftAndBranchInTx(
        client,
        ctx.tenantId,
        ctx.userId,
        targetBranchParam,
        curLog.shift_id ? String(curLog.shift_id) : null,
        policy.allow_any_branch_checkin
      );

      const shift = resolved.shift;
      const branch = resolved.branch;
      const effectiveWorkDate = String(curLog.work_date || workDate).slice(0, 10);

      const [exemption, approvedRemoteLeave] = await Promise.all([
        resolveEffectiveExemptionForUser(client, ctx.tenantId, resolved.userInfo, effectiveWorkDate),
        hasActiveApprovedRemoteLeave(client, ctx.tenantId, ctx.userId, effectiveWorkDate),
      ]);

      // ANTI-SPOOFING FIX #4 & #5: Enforce Geofence Policy on BOTH Check-In AND Check-Out!
      const geoResult = evaluateGeofenceAgainstPolicy({
        policy,
        exemption,
        approvedRemoteLeave,
        branch,
        clientIp,
        lat,
        lng,
        accuracyMeters,
        hasSelfie: true,
        isCheckOut: true,
        note: noteText,
      });

      const checkInDate = curLog.check_in_at ? new Date(curLog.check_in_at) : checkOutTs;
      const rawElapsedHours = Math.max(0, (checkOutTs.getTime() - checkInDate.getTime()) / 3600_000);
      const breakHours = Math.max(0, Number(shift?.break_minutes ?? 60) / 60);
      const workedHours =
        Math.round(
          Math.max(0, rawElapsedHours > 5 ? rawElapsedHours - breakHours : rawElapsedHours) * 100
        ) / 100;

      const endMinutes = parseHHMM(shift?.end_time || '17:30', 1050);
      const graceEarly = Number(shift?.grace_early_leave_minutes ?? policy.grace_early_minutes ?? 15);
      const rawEarly = Math.max(0, endMinutes - outMinutes);
      const earlyLeaveMinutes = exemption.exempt_checkin ? 0 : rawEarly > graceEarly ? rawEarly : 0;

      const stdHours = Math.max(1, toNum(shift?.standard_work_hours, 8));
      const halfHours = Math.max(0.5, toNum(shift?.min_half_day_hours, 4));
      const fullUnit = toNum(shift?.work_unit_value, 1);

      // ANTI-SPOOFING FIX #2: NEVER accept client `b.keep_full_unit` — 100% server-calculated work_units!
      let workUnits = fullUnit;
      let attCode = 'X';
      if (workedHours >= stdHours * 0.85) {
        workUnits = fullUnit;
        attCode = 'X';
      } else if (workedHours >= halfHours) {
        workUnits = Math.round(fullUnit * 50) / 100;
        attCode = 'N';
      } else {
        workUnits = Math.round((workedHours / stdHours) * fullUnit * 100) / 100;
        attCode = workUnits > 0 ? 'K' : 'V';
      }

      const overtimeHours = Math.max(0, Math.round((workedHours - stdHours) * 100) / 100);

      await client.query(
        `UPDATE tenant_hr_attendance_logs
         SET check_out_at = $3,
             checkout_latitude = $4,
             checkout_longitude = $5,
             checkout_accuracy_meters = $6,
             checkout_distance_meters = $7,
             checkout_selfie_data_url = COALESCE($8, checkout_selfie_data_url),
             checkout_ip = $9,
             early_leave_minutes = $10,
             worked_hours = $11,
             overtime_hours = $12,
             work_units = $13,
             attendance_code = $14,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          curLog.id,
          checkOutTs.toISOString(),
          lat !== null && Number.isFinite(lat) ? lat : null,
          lng !== null && Number.isFinite(lng) ? lng : null,
          accuracyMeters !== null && Number.isFinite(accuracyMeters) ? accuracyMeters : null,
          geoResult.distanceMeters,
          b.selfie_data_url ? String(b.selfie_data_url) : null,
          clientIp || null,
          earlyLeaveMinutes,
          workedHours,
          overtimeHours,
          workUnits,
          attCode,
        ]
      );

      const saved = await client.query(
        'SELECT * FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, curLog.id]
      );
      const row = saved.rows[0];
      return {
        ...row,
        distance_meters: row.distance_meters !== null ? toNum(row.distance_meters, 0) : null,
        checkout_distance_meters:
          row.checkout_distance_meters !== null ? toNum(row.checkout_distance_meters, 0) : null,
        checkout_accuracy_meters:
          row.checkout_accuracy_meters !== null ? toNum(row.checkout_accuracy_meters, 0) : null,
        within_geofence: toBool(row.within_geofence, true),
        checkout_within_geofence: geoResult.withinGeofence,
        worked_hours: toNum(row.worked_hours, 0),
        overtime_hours: toNum(row.overtime_hours, 0),
        work_units: toNum(row.work_units, 0),
        geofence_mode: geoResult.geofenceMode,
        verification_method: geoResult.verificationMethod,
        ip_whitelist_matched: geoResult.ipWhitelisted,
      };
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    if (err?.message === 'CHECKIN_NOT_FOUND') {
      sendApiError(res, 404, 'CHECKIN_NOT_FOUND', 'Chưa có dữ liệu Check-in hôm nay để thực hiện Check-out.');
      return;
    }
    if (err?.message === 'OUT_OF_GEOFENCE_STRICT_BLOCK') {
      sendApiError(
        res,
        403,
        'OUT_OF_GEOFENCE_STRICT_BLOCK',
        'Vị trí Check-out thiếu tọa độ GPS chính xác hoặc nằm ngoài bán kính cho phép theo chính sách Strict Radius.'
      );
      return;
    }
    if (err?.message === 'BRANCH_CHECKIN_RESTRICTED') {
      sendApiError(
        res,
        403,
        'BRANCH_CHECKIN_RESTRICTED',
        'Tài khoản chỉ được phép chấm công tại chi nhánh được phân công.'
      );
      return;
    }
    if (err?.message === 'EXPLANATION_REQUIRED') {
      sendApiError(
        res,
        422,
        'EXPLANATION_REQUIRED',
        'Vui lòng nhập lý do giải trình khi Check-out ngoài vùng quy định.'
      );
      return;
    }
    sendApiError(res, 500, 'CHECK_OUT_FAILED', err?.message || 'Không thể ghi nhận Check-out.');
  }
});

// ============================================================================
// 4. Monthly Timesheet Matrix & Raw Logs (`/logs`, `/timesheet`)
// ============================================================================
attendanceRouter.get('/logs', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const monthParam = String(req.query.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const [yrStr, moStr] = monthParam.split('-');
    const year = Number(yrStr) || new Date().getFullYear();
    const month = Number(moStr) || new Date().getMonth() + 1;
    const lastDay = new Date(year, month, 0).getDate();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const attScope = rbac.effectivePermissions.attendance?.scope || 'own';
      const scopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, attScope, {
            tenantColumn: 'l.tenant_id',
            ownerColumn: 'l.user_id',
            startParamIndex: 1,
          })
        : { clause: 'l.tenant_id = $1', values: [ctx.tenantId], nextIndex: 2 };

      const params = [...scopeSql.values, startDate, endDate];
      const pStart = `$${params.length - 1}`;
      const pEnd = `$${params.length}`;

      const r = await client.query(
        `SELECT l.*, u.full_name AS user_name, u.email AS user_email,
                b.name AS branch_name, s.name AS shift_name
         FROM tenant_hr_attendance_logs l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
         LEFT JOIN tenant_branches b ON b.tenant_id = l.tenant_id AND b.id = l.branch_id
         LEFT JOIN tenant_hr_shifts s ON s.tenant_id = l.tenant_id AND s.id = l.shift_id
         WHERE ${scopeSql.clause} AND l.work_date >= ${pStart} AND l.work_date <= ${pEnd}
         ORDER BY l.work_date DESC, l.check_in_at DESC`,
        params
      );

      return r.rows.map((x) => ({
        ...x,
        work_date_str:
          x.work_date instanceof Date ? x.work_date.toISOString().slice(0, 10) : String(x.work_date).slice(0, 10),
        distance_meters: x.distance_meters !== null ? toNum(x.distance_meters, 0) : null,
        within_geofence: toBool(x.within_geofence, true),
        late_minutes: Number(x.late_minutes || 0),
        worked_hours: toNum(x.worked_hours, 0),
        overtime_hours: toNum(x.overtime_hours, 0),
        work_units: toNum(x.work_units, 0),
      }));
    });

    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ATTENDANCE_LOGS_FAILED', err?.message || 'Không thể tải nhật ký chấm công.');
  }
});

attendanceRouter.get('/timesheet', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const monthParam = String(req.query.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const [yrStr, moStr] = monthParam.split('-');
    const year = Number(yrStr) || new Date().getFullYear();
    const month = Number(moStr) || new Date().getMonth() + 1;
    const daysInMonth = new Date(year, month, 0).getDate();
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    const matrix = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const attScope = rbac.effectivePermissions.attendance?.scope || 'own';

      const userScopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, attScope, {
            tenantColumn: 'u.tenant_id',
            ownerColumn: 'u.id',
            startParamIndex: 1,
          })
        : { clause: 'u.tenant_id = $1', values: [ctx.tenantId], nextIndex: 2 };

      const [usersRes, logsRes] = await Promise.all([
        client.query(
          `SELECT u.id AS user_id, u.full_name, u.email, d.name AS department_name, b.name AS branch_name
           FROM users u
           LEFT JOIN tenant_departments d ON d.tenant_id = u.tenant_id AND d.id = u.department_id
           LEFT JOIN tenant_branches b ON b.tenant_id = u.tenant_id AND b.id = u.branch_id
           WHERE ${userScopeSql.clause} AND u.is_system_bot = false
           ORDER BY u.full_name ASC`,
          userScopeSql.values
        ),
        client.query(
          `SELECT user_id, work_date, attendance_code, work_units, late_minutes, overtime_hours, within_geofence, status
           FROM tenant_hr_attendance_logs
           WHERE tenant_id = $1 AND work_date >= $2 AND work_date <= $3`,
          [ctx.tenantId, startDate, endDate]
        ),
      ]);

      const logsByUser = new Map<string, Record<number, any>>();
      for (const lg of logsRes.rows) {
        const uid = String(lg.user_id);
        const dStr =
          lg.work_date instanceof Date ? lg.work_date.toISOString().slice(0, 10) : String(lg.work_date).slice(0, 10);
        const dayNum = Number(dStr.slice(8, 10));
        const map = logsByUser.get(uid) || {};
        map[dayNum] = {
          code: lg.attendance_code || 'X',
          work_units: toNum(lg.work_units, 0),
          late_minutes: Number(lg.late_minutes || 0),
          overtime_hours: toNum(lg.overtime_hours, 0),
          within_geofence: toBool(lg.within_geofence, true),
          status: lg.status,
        };
        logsByUser.set(uid, map);
      }

      const rows = usersRes.rows.map((u) => {
        const uid = String(u.user_id);
        const dayCells = logsByUser.get(uid) || {};
        let totalUnits = 0;
        let lateCount = 0;
        let outGeofenceCount = 0;
        let totalOtHours = 0;

        for (const cell of Object.values(dayCells)) {
          totalUnits += cell.work_units;
          if (cell.late_minutes > 0) lateCount++;
          if (!cell.within_geofence) outGeofenceCount++;
          totalOtHours += cell.overtime_hours;
        }

        return {
          user_id: uid,
          full_name: u.full_name,
          email: u.email,
          department_name: u.department_name,
          branch_name: u.branch_name,
          days: dayCells,
          total_work_units: Math.round(totalUnits * 100) / 100,
          late_count: lateCount,
          out_of_geofence_count: outGeofenceCount,
          total_overtime_hours: Math.round(totalOtHours * 100) / 100,
        };
      });

      return {
        month: monthParam,
        days_in_month: daysInMonth,
        rows,
      };
    });

    res.json({ success: true, data: matrix });
  } catch (err: any) {
    sendApiError(res, 500, 'TIMESHEET_MATRIX_FAILED', err?.message || 'Không thể tổng hợp bảng công tháng.');
  }
});

// ============================================================================
// 5. Attendance Explanations Linked to Dynamic Approvals (`/explanations`)
// ============================================================================
attendanceRouter.get('/explanations', requirePermission('attendance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const attScope = rbac.effectivePermissions.attendance?.scope || 'own';
      const scopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, attScope, {
            tenantColumn: 'ex.tenant_id',
            ownerColumn: 'ex.user_id',
            startParamIndex: 1,
          })
        : { clause: 'ex.tenant_id = $1', values: [ctx.tenantId], nextIndex: 2 };

      const r = await client.query(
        `SELECT ex.*, u.full_name AS user_name, ar.request_code AS approval_request_code, ar.status AS approval_status
         FROM tenant_hr_attendance_explanations ex
         LEFT JOIN users u ON u.tenant_id = ex.tenant_id AND u.id = ex.user_id
         LEFT JOIN tenant_approval_requests ar ON ar.tenant_id = ex.tenant_id AND ar.id = ex.approval_request_id
         WHERE ${scopeSql.clause}
         ORDER BY ex.created_at DESC`,
        scopeSql.values
      );
      return r.rows.map((x) => ({
        ...x,
        requested_work_units: toNum(x.requested_work_units, 1),
      }));
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_EXPLANATIONS_FAILED', err?.message || 'Không thể tải danh sách giải trình chấm công.');
  }
});

attendanceRouter.post('/explanations', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const workDate = String(b.work_date || '').slice(0, 10);
    const reason = String(b.reason || '').trim();
    if (!workDate || !reason) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng chọn ngày công cần giải trình và nhập lý do.');
      return;
    }

    const expId = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultApprovalWorkflowsInTx(client, ctx.tenantId);

      const [logRes, empRes, wfRes] = await Promise.all([
        client.query(
          'SELECT id FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND user_id = $2 AND work_date = $3 LIMIT 1',
          [ctx.tenantId, ctx.userId, workDate]
        ),
        client.query(
          'SELECT id FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
          [ctx.tenantId, ctx.userId]
        ),
        client.query(
          `SELECT id FROM tenant_approval_workflows
           WHERE tenant_id = $1 AND is_active = true
           ORDER BY CASE WHEN category IN ('attendance_explanation', 'leave') THEN 0 ELSE 1 END ASC, created_at ASC
           LIMIT 1`,
          [ctx.tenantId]
        ),
      ]);

      const logId = b.attendance_log_id || logRes.rows[0]?.id || null;
      const empId = empRes.rows[0]?.id || null;
      const expType = b.explanation_type || 'late_arrival';
      const reqUnits = Math.max(0.5, Math.min(2, toNum(b.requested_work_units, 1)));

      let approvalReqId: string | null = null;
      if (wfRes.rows[0]?.id) {
        const appr = await createApprovalRequestInTx(client, {
          tenantId: ctx.tenantId,
          workflowId: String(wfRes.rows[0].id),
          requesterUserId: ctx.userId,
          title: `Giải trình công ngày ${workDate} (${expType})`,
          description: reason,
          amountVnd: 0,
          formData: {
            work_date: workDate,
            explanation_type: expType,
            requested_work_units: reqUnits,
            requested_check_in: b.requested_check_in || null,
            requested_check_out: b.requested_check_out || null,
          },
          linkedEntityType: 'attendance_explanation',
          linkedEntityId: expId,
        });
        approvalReqId = String(appr.request.id);
      }

      await client.query(
        `INSERT INTO tenant_hr_attendance_explanations (
           id, tenant_id, attendance_log_id, user_id, employee_id, work_date,
           explanation_type, requested_check_in, requested_check_out,
           requested_work_units, reason, evidence_url, status, approval_request_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13)`,
        [
          expId,
          ctx.tenantId,
          logId,
          ctx.userId,
          empId,
          workDate,
          expType,
          b.requested_check_in || null,
          b.requested_check_out || null,
          reqUnits,
          reason,
          b.evidence_url || null,
          approvalReqId,
        ]
      );

      const saved = await client.query(
        'SELECT * FROM tenant_hr_attendance_explanations WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, expId]
      );
      return saved.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_EXPLANATION_FAILED', err?.message || 'Không thể gửi giải trình chấm công.');
  }
});

attendanceRouter.post('/explanations/:id/review', requirePermission('attendance', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const status = String(req.body?.status || 'approved') === 'rejected' ? 'rejected' : 'approved';
    const comment = req.body?.review_comment ? String(req.body.review_comment).trim() : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_hr_attendance_explanations WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (curRes.rows.length === 0) return null;
      const exp = curRes.rows[0];

      await client.query(
        `UPDATE tenant_hr_attendance_explanations
         SET status = $3, reviewed_by = $4, reviewed_at = clock_timestamp(), review_comment = $5, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id, status, ctx.userId, comment]
      );

      if (status === 'approved') {
        if (exp.attendance_log_id) {
          await client.query(
            `UPDATE tenant_hr_attendance_logs
             SET status = 'explained',
                 attendance_code = 'X',
                 work_units = $3,
                 late_minutes = 0,
                 early_leave_minutes = 0,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, exp.attendance_log_id, toNum(exp.requested_work_units, 1)]
          );
        } else {
          await client.query(
            `INSERT INTO tenant_hr_attendance_logs (
               id, tenant_id, user_id, employee_id, work_date, attendance_code,
               within_geofence, work_units, status, note
             ) VALUES ($1, $2, $3, $4, $5, 'X', true, $6, 'explained', $7)
             ON CONFLICT (tenant_id, user_id, work_date)
             DO UPDATE SET status = 'explained', attendance_code = 'X', work_units = EXCLUDED.work_units`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              exp.user_id,
              exp.employee_id || null,
              exp.work_date,
              toNum(exp.requested_work_units, 1),
              `Đã duyệt giải trình: ${exp.reason}`,
            ]
          );
        }
      }

      if (exp.approval_request_id) {
        await client.query(
          `UPDATE tenant_approval_requests
           SET status = $3, completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, exp.approval_request_id, status]
        );
      }

      const r = await client.query(
        'SELECT * FROM tenant_hr_attendance_explanations WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'EXPLANATION_NOT_FOUND', 'Không tìm thấy đơn giải trình.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'REVIEW_EXPLANATION_FAILED', err?.message || 'Không thể duyệt giải trình chấm công.');
  }
});

// ============================================================================
// 6. Attendance Policy CRUD (`/api/v1/attendance/policy`)
// ============================================================================
attendanceRouter.get('/policy', requirePermission('attendance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const policy = await withTenantTransaction(ctx.tenantId, (client) => getAttendancePolicyInTx(client, ctx.tenantId));
    res.json({ success: true, data: policy });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_ATTENDANCE_POLICY_FAILED', err?.message || 'Không thể tải chính sách chấm công.');
  }
});

const upsertAttendancePolicyHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await getAttendancePolicyInTx(client, ctx.tenantId);
      const next = {
        geofence_mode: b.geofence_mode !== undefined ? normalizeGeofenceMode(b.geofence_mode) : cur.geofence_mode,
        require_gps: b.require_gps !== undefined ? toBool(b.require_gps, cur.require_gps) : cur.require_gps,
        require_selfie: b.require_selfie !== undefined ? toBool(b.require_selfie, cur.require_selfie) : cur.require_selfie,
        max_gps_accuracy_meters:
          b.max_gps_accuracy_meters !== undefined
            ? Math.max(10, Math.min(50_000, Number(b.max_gps_accuracy_meters) || 150))
            : cur.max_gps_accuracy_meters,
        grace_late_minutes:
          b.grace_late_minutes !== undefined
            ? Math.max(0, Math.min(240, Number(b.grace_late_minutes) || 0))
            : cur.grace_late_minutes,
        grace_early_minutes:
          b.grace_early_minutes !== undefined
            ? Math.max(0, Math.min(240, Number(b.grace_early_minutes) || 0))
            : cur.grace_early_minutes,
        allow_any_branch_checkin:
          b.allow_any_branch_checkin !== undefined
            ? toBool(b.allow_any_branch_checkin, cur.allow_any_branch_checkin)
            : cur.allow_any_branch_checkin,
        allow_remote_with_approved_leave:
          b.allow_remote_with_approved_leave !== undefined
            ? toBool(b.allow_remote_with_approved_leave, cur.allow_remote_with_approved_leave)
            : cur.allow_remote_with_approved_leave,
        allow_ip_whitelist_bypass:
          b.allow_ip_whitelist_bypass !== undefined
            ? toBool(b.allow_ip_whitelist_bypass, cur.allow_ip_whitelist_bypass)
            : cur.allow_ip_whitelist_bypass,
        require_checkout:
          b.require_checkout !== undefined ? toBool(b.require_checkout, cur.require_checkout) : cur.require_checkout,
        enable_night_shift:
          b.enable_night_shift !== undefined ? toBool(b.enable_night_shift, cur.enable_night_shift) : cur.enable_night_shift,
        enable_weekend_shift:
          b.enable_weekend_shift !== undefined
            ? toBool(b.enable_weekend_shift, cur.enable_weekend_shift)
            : cur.enable_weekend_shift,
        holiday_schedules_json:
          b.holiday_schedules_json !== undefined
            ? Array.isArray(b.holiday_schedules_json)
              ? b.holiday_schedules_json
              : cur.holiday_schedules_json
            : cur.holiday_schedules_json,
      };

      await client.query(
        `INSERT INTO tenant_attendance_policies (
           id, tenant_id, geofence_mode, require_gps, require_selfie, max_gps_accuracy_meters,
           grace_late_minutes, grace_early_minutes, allow_any_branch_checkin,
           allow_remote_with_approved_leave, allow_ip_whitelist_bypass, require_checkout,
           enable_night_shift, enable_weekend_shift, holiday_schedules_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           geofence_mode = EXCLUDED.geofence_mode,
           require_gps = EXCLUDED.require_gps,
           require_selfie = EXCLUDED.require_selfie,
           max_gps_accuracy_meters = EXCLUDED.max_gps_accuracy_meters,
           grace_late_minutes = EXCLUDED.grace_late_minutes,
           grace_early_minutes = EXCLUDED.grace_early_minutes,
           allow_any_branch_checkin = EXCLUDED.allow_any_branch_checkin,
           allow_remote_with_approved_leave = EXCLUDED.allow_remote_with_approved_leave,
           allow_ip_whitelist_bypass = EXCLUDED.allow_ip_whitelist_bypass,
           require_checkout = EXCLUDED.require_checkout,
           enable_night_shift = EXCLUDED.enable_night_shift,
           enable_weekend_shift = EXCLUDED.enable_weekend_shift,
           holiday_schedules_json = EXCLUDED.holiday_schedules_json,
           updated_at = clock_timestamp()`,
        [
          cur.id || crypto.randomUUID(),
          ctx.tenantId,
          next.geofence_mode,
          next.require_gps,
          next.require_selfie,
          next.max_gps_accuracy_meters,
          next.grace_late_minutes,
          next.grace_early_minutes,
          next.allow_any_branch_checkin,
          next.allow_remote_with_approved_leave,
          next.allow_ip_whitelist_bypass,
          next.require_checkout,
          next.enable_night_shift,
          next.enable_weekend_shift,
          JSON.stringify(next.holiday_schedules_json),
        ]
      );
      return getAttendancePolicyInTx(client, ctx.tenantId);
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_ATTENDANCE_POLICY_FAILED', err?.message || 'Không thể lưu chính sách chấm công.');
  }
};
attendanceRouter.put('/policy', requirePermission('attendance', 'manage_config'), upsertAttendancePolicyHandler);
attendanceRouter.patch('/policy', requirePermission('attendance', 'manage_config'), upsertAttendancePolicyHandler);

// ============================================================================
// 7. Attendance Exemption Rules CRUD (`/api/v1/attendance/exemptions`)
// ============================================================================
attendanceRouter.get('/exemptions', requirePermission('attendance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const todayStr = getLocalHHMMAndDate(new Date()).dateStr;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [rulesRes, resolved] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_attendance_exemption_rules WHERE tenant_id = $1 ORDER BY created_at DESC',
          [ctx.tenantId]
        ),
        resolveUserShiftAndBranchInTx(client, ctx.tenantId, ctx.userId),
      ]);
      const myExemption = await resolveEffectiveExemptionForUser(client, ctx.tenantId, resolved.userInfo, todayStr);
      return {
        items: rulesRes.rows,
        my_exemption: myExemption,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_EXEMPTIONS_FAILED', err?.message || 'Không thể tải danh sách miễn trừ chấm công.');
  }
});

attendanceRouter.post('/exemptions', requirePermission('attendance', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const scopeType = String(b.scope_type || 'user').trim().toLowerCase();
    const targetId = String(b.target_id || '').trim();
    if (!name || !targetId || !['role', 'department', 'team', 'position', 'user'].includes(scopeType)) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần cung cấp name, scope_type hợp lệ và target_id.');
      return;
    }
    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_attendance_exemption_rules (
           id, tenant_id, name, scope_type, target_id,
           exempt_checkin, exempt_gps, exempt_selfie, custom_grace_late_minutes,
           exclude_from_absent_report, effective_from, effective_to, reason, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          id,
          ctx.tenantId,
          name,
          scopeType,
          targetId,
          Boolean(b.exempt_checkin),
          Boolean(b.exempt_gps),
          Boolean(b.exempt_selfie),
          b.custom_grace_late_minutes !== undefined && b.custom_grace_late_minutes !== null && b.custom_grace_late_minutes !== ''
            ? Math.max(0, Math.trunc(Number(b.custom_grace_late_minutes)))
            : null,
          Boolean(b.exclude_from_absent_report),
          b.effective_from ? String(b.effective_from).slice(0, 10) : null,
          b.effective_to ? String(b.effective_to).slice(0, 10) : null,
          b.reason ? String(b.reason).trim() : null,
          b.is_active !== false,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_attendance_exemption_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_EXEMPTION_FAILED', err?.message || 'Không thể tạo quy tắc miễn trừ.');
  }
});

const updateExemptionHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_attendance_exemption_rules
         SET name = COALESCE($3, name),
             scope_type = COALESCE($4, scope_type),
             target_id = COALESCE($5, target_id),
             exempt_checkin = COALESCE($6, exempt_checkin),
             exempt_gps = COALESCE($7, exempt_gps),
             exempt_selfie = COALESCE($8, exempt_selfie),
             custom_grace_late_minutes = CASE WHEN $9::boolean THEN $10 ELSE custom_grace_late_minutes END,
             exclude_from_absent_report = COALESCE($11, exclude_from_absent_report),
             effective_from = CASE WHEN $12::boolean THEN $13 ELSE effective_from END,
             effective_to = CASE WHEN $14::boolean THEN $15 ELSE effective_to END,
             reason = CASE WHEN $16::boolean THEN $17 ELSE reason END,
             is_active = COALESCE($18, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.scope_type && ['role', 'department', 'team', 'position', 'user'].includes(String(b.scope_type).trim().toLowerCase())
            ? String(b.scope_type).trim().toLowerCase()
            : null,
          b.target_id ? String(b.target_id).trim() : null,
          typeof b.exempt_checkin === 'boolean' ? b.exempt_checkin : null,
          typeof b.exempt_gps === 'boolean' ? b.exempt_gps : null,
          typeof b.exempt_selfie === 'boolean' ? b.exempt_selfie : null,
          b.custom_grace_late_minutes !== undefined,
          b.custom_grace_late_minutes !== null && b.custom_grace_late_minutes !== ''
            ? Math.max(0, Math.trunc(Number(b.custom_grace_late_minutes)))
            : null,
          typeof b.exclude_from_absent_report === 'boolean' ? b.exclude_from_absent_report : null,
          b.effective_from !== undefined,
          b.effective_from ? String(b.effective_from).slice(0, 10) : null,
          b.effective_to !== undefined,
          b.effective_to ? String(b.effective_to).slice(0, 10) : null,
          b.reason !== undefined,
          b.reason ? String(b.reason).trim() : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'EXEMPTION_NOT_FOUND', 'Không tìm thấy quy tắc miễn trừ.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_EXEMPTION_FAILED', err?.message || 'Không thể cập nhật quy tắc miễn trừ.');
  }
};
attendanceRouter.put('/exemptions/:id', requirePermission('attendance', 'manage_config'), updateExemptionHandler);
attendanceRouter.patch('/exemptions/:id', requirePermission('attendance', 'manage_config'), updateExemptionHandler);

attendanceRouter.delete('/exemptions/:id', requirePermission('attendance', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_attendance_exemption_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_EXEMPTION_FAILED', err?.message || 'Không thể xóa quy tắc miễn trừ.');
  }
});

// ============================================================================
// 8. Monthly Attendance Confirmation Batches (`/api/v1/attendance/confirmations`)
// ============================================================================
attendanceRouter.get('/confirmations', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const batchIdFilter = req.query.batch_id ? String(req.query.batch_id).trim() : null;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const scopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, rbac.effectivePermissions.attendance.scope, {
            tenantColumn: 'c.tenant_id',
            ownerColumn: 'c.user_id',
          })
        : { clause: 'c.tenant_id = $1 AND c.user_id = $2', values: [ctx.tenantId, ctx.userId], nextIndex: 3 };

      const params = [...scopeSql.values];
      let extra = '';
      if (batchIdFilter) {
        params.push(batchIdFilter);
        extra = ` AND c.batch_id = $${scopeSql.nextIndex}`;
      }

      const [batchesRes, itemsRes] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_attendance_confirmation_batches WHERE tenant_id = $1 ORDER BY period_month DESC, created_at DESC',
          [ctx.tenantId]
        ),
        client.query(
          `SELECT c.*, u.full_name, u.email, b.title AS batch_title, b.period_month, b.deadline_at
           FROM tenant_attendance_confirmations c
           LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.user_id
           LEFT JOIN tenant_attendance_confirmation_batches b ON b.tenant_id = c.tenant_id AND b.id = c.batch_id
           WHERE ${scopeSql.clause}${extra}
           ORDER BY c.created_at DESC LIMIT 300`,
          params
        ),
      ]);
      return {
        batches: batchesRes.rows,
        items: itemsRes.rows,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CONFIRMATIONS_FAILED', err?.message || 'Không thể tải danh sách xác nhận bảng công.');
  }
});

attendanceRouter.post('/confirmations/batches', requirePermission('attendance', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const periodMonth = String(b.period_month || new Date().toISOString().slice(0, 7)).slice(0, 10);
    const fromDate = String(b.from_date || `${periodMonth}-01`).slice(0, 10);
    const toDate = String(b.to_date || `${periodMonth}-31`).slice(0, 10);
    const title = String(b.title || `Xác nhận bảng công kỳ ${periodMonth}`).trim();
    const batchId = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_attendance_confirmation_batches (
           id, tenant_id, title, period_month, from_date, to_date, deadline_at, status, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          batchId,
          ctx.tenantId,
          title,
          periodMonth,
          fromDate,
          toDate,
          b.deadline_at ? new Date(b.deadline_at).toISOString() : null,
          String(b.status || 'open'),
          ctx.userId,
        ]
      );

      const [usersRes, logsRes] = await Promise.all([
        client.query(
          `SELECT u.id AS user_id, e.id AS employee_id
           FROM users u
           LEFT JOIN tenant_user_profiles tup ON tup.tenant_id = u.tenant_id AND tup.user_id = u.id
           LEFT JOIN tenant_hr_employees e ON e.tenant_id = u.tenant_id AND e.user_id = u.id
           WHERE u.tenant_id = $1 AND u.is_system_bot = false AND COALESCE(tup.status, 'active') = 'active'`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT user_id, work_units, late_minutes, early_leave_minutes, overtime_hours
           FROM tenant_hr_attendance_logs
           WHERE tenant_id = $1 AND work_date >= $2 AND work_date <= $3`,
          [ctx.tenantId, fromDate, toDate]
        ),
      ]);

      const statsByUser = new Map<
        string,
        { units: number; late: number; early: number; ot: number; days: number }
      >();
      for (const lg of logsRes.rows) {
        const uid = String(lg.user_id);
        const cur = statsByUser.get(uid) || { units: 0, late: 0, early: 0, ot: 0, days: 0 };
        cur.units += toNum(lg.work_units, 0);
        if (Number(lg.late_minutes || 0) > 0) cur.late++;
        if (Number(lg.early_leave_minutes || 0) > 0) cur.early++;
        cur.ot += toNum(lg.overtime_hours, 0);
        cur.days++;
        statsByUser.set(uid, cur);
      }

      for (const u of usersRes.rows) {
        const st = statsByUser.get(String(u.user_id)) || { units: 0, late: 0, early: 0, ot: 0, days: 0 };
        await client.query(
          `INSERT INTO tenant_attendance_confirmations (
             id, tenant_id, batch_id, user_id, employee_id,
             total_work_units, late_count, early_count, overtime_hours, status, details_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10::jsonb)
           ON CONFLICT (tenant_id, batch_id, user_id) DO NOTHING`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            batchId,
            u.user_id,
            u.employee_id || null,
            Math.round(st.units * 100) / 100,
            st.late,
            st.early,
            Math.round(st.ot * 100) / 100,
            JSON.stringify({ days_logged: st.days, from_date: fromDate, to_date: toDate }),
          ]
        );
      }

      const [batchRow, confRows] = await Promise.all([
        client.query('SELECT * FROM tenant_attendance_confirmation_batches WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          batchId,
        ]),
        client.query('SELECT * FROM tenant_attendance_confirmations WHERE tenant_id = $1 AND batch_id = $2', [
          ctx.tenantId,
          batchId,
        ]),
      ]);
      return {
        batch: batchRow.rows[0],
        items: confRows.rows,
      };
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CONFIRMATION_BATCH_FAILED', err?.message || 'Không thể tạo kỳ xác nhận công.');
  }
});

attendanceRouter.post('/confirmations/:id/confirm', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canApprove = Boolean(rbac.effectivePermissions.attendance?.actions?.approve);
      const r = await client.query(
        canApprove
          ? `UPDATE tenant_attendance_confirmations
             SET status = 'confirmed',
                 dispute_reason = NULL,
                 confirmed_at = clock_timestamp(),
                 confirmed_by_type = $3,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`
          : `UPDATE tenant_attendance_confirmations
             SET status = 'confirmed',
                 dispute_reason = NULL,
                 confirmed_at = clock_timestamp(),
                 confirmed_by_type = $4,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2 AND user_id = $3
             RETURNING *`,
        canApprove
          ? [ctx.tenantId, req.params.id, 'manager']
          : [ctx.tenantId, req.params.id, ctx.userId, 'employee']
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'CONFIRMATION_NOT_FOUND', 'Không tìm thấy phiếu xác nhận bảng công.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'CONFIRM_ATTENDANCE_FAILED', err?.message || 'Không thể xác nhận bảng công.');
  }
});

attendanceRouter.post('/confirmations/:id/dispute', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const reason = String(req.body?.dispute_reason || req.body?.reason || '').trim();
    if (!reason) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng nhập lý do khiếu nại bảng công.');
      return;
    }
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canApprove = Boolean(rbac.effectivePermissions.attendance?.actions?.approve);
      const r = await client.query(
        `UPDATE tenant_attendance_confirmations
         SET status = 'disputed',
             dispute_reason = $3,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 ${canApprove ? '' : 'AND user_id = $4'}
         RETURNING *`,
        canApprove ? [ctx.tenantId, req.params.id, reason] : [ctx.tenantId, req.params.id, reason, ctx.userId]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'CONFIRMATION_NOT_FOUND', 'Không tìm thấy phiếu xác nhận bảng công.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'DISPUTE_ATTENDANCE_FAILED', err?.message || 'Không thể gửi khiếu nại bảng công.');
  }
});

attendanceRouter.post(
  '/confirmations/batches/:batchId/recalculate',
  requirePermission('attendance', 'approve'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const bRes = await client.query(
          'SELECT * FROM tenant_attendance_confirmation_batches WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, req.params.batchId]
        );
        const batch = bRes.rows[0];
        if (!batch) return null;

        const logsRes = await client.query(
          `SELECT user_id, work_units, late_minutes, early_leave_minutes, overtime_hours
           FROM tenant_hr_attendance_logs
           WHERE tenant_id = $1 AND work_date >= $2 AND work_date <= $3`,
          [ctx.tenantId, batch.from_date, batch.to_date]
        );
        const statsByUser = new Map<string, { units: number; late: number; early: number; ot: number; days: number }>();
        for (const lg of logsRes.rows) {
          const uid = String(lg.user_id);
          const cur = statsByUser.get(uid) || { units: 0, late: 0, early: 0, ot: 0, days: 0 };
          cur.units += toNum(lg.work_units, 0);
          if (Number(lg.late_minutes || 0) > 0) cur.late++;
          if (Number(lg.early_leave_minutes || 0) > 0) cur.early++;
          cur.ot += toNum(lg.overtime_hours, 0);
          cur.days++;
          statsByUser.set(uid, cur);
        }

        const itemsRes = await client.query(
          'SELECT id, user_id FROM tenant_attendance_confirmations WHERE tenant_id = $1 AND batch_id = $2',
          [ctx.tenantId, batch.id]
        );
        for (const item of itemsRes.rows) {
          const st = statsByUser.get(String(item.user_id)) || { units: 0, late: 0, early: 0, ot: 0, days: 0 };
          await client.query(
            `UPDATE tenant_attendance_confirmations
             SET total_work_units = $3, late_count = $4, early_count = $5, overtime_hours = $6,
                 details_json = $7::jsonb, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              item.id,
              Math.round(st.units * 100) / 100,
              st.late,
              st.early,
              Math.round(st.ot * 100) / 100,
              JSON.stringify({ days_logged: st.days, from_date: batch.from_date, to_date: batch.to_date }),
            ]
          );
        }
        const refreshed = await client.query(
          'SELECT * FROM tenant_attendance_confirmations WHERE tenant_id = $1 AND batch_id = $2',
          [ctx.tenantId, batch.id]
        );
        return { batch, items: refreshed.rows };
      });
      if (!updated) {
        sendApiError(res, 404, 'BATCH_NOT_FOUND', 'Không tìm thấy đợt xác nhận công.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'RECALCULATE_CONFIRMATIONS_FAILED', err?.message || 'Không thể tính lại số liệu công.');
    }
  }
);

attendanceRouter.post(
  '/confirmations/batches/:batchId/auto-confirm',
  requirePermission('attendance', 'approve'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const count = await withTenantTransaction(ctx.tenantId, async (client) => {
        const upd = await client.query(
          `UPDATE tenant_attendance_confirmations
           SET status = 'auto_confirmed',
               confirmed_at = clock_timestamp(),
               confirmed_by_type = 'auto_deadline',
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND batch_id = $2 AND status = 'pending'`,
          [ctx.tenantId, req.params.batchId]
        );
        return upd.rowCount || 0;
      });
      res.json({ success: true, data: { auto_confirmed_count: count, batch_id: req.params.batchId } });
    } catch (err: any) {
      sendApiError(res, 500, 'AUTO_CONFIRM_FAILED', err?.message || 'Không thể tự động chốt xác nhận.');
    }
  }
);

// ============================================================================
// 9. Bulk Attendance Requests & Smart Suggestions (`/api/v1/attendance/bulk-requests`)
// ============================================================================
attendanceRouter.get('/bulk-requests/suggest', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const monthParam = String(req.query.month || new Date().toISOString().slice(0, 7)).slice(0, 7);
    const [yr, mo] = monthParam.split('-').map(Number);
    const daysInMonth = yr && mo ? new Date(yr, mo, 0).getDate() : 30;
    const startDate = `${monthParam}-01`;
    const endDate = `${monthParam}-${String(daysInMonth).padStart(2, '0')}`;

    const suggestions = await withTenantTransaction(ctx.tenantId, async (client) => {
      const policy = await getAttendancePolicyInTx(client, ctx.tenantId);
      const resolved = await resolveUserShiftAndBranchInTx(client, ctx.tenantId, ctx.userId);
      const logsRes = await client.query(
        `SELECT work_date, check_in_at, check_out_at, status, late_minutes, work_units
         FROM tenant_hr_attendance_logs
         WHERE tenant_id = $1 AND user_id = $2 AND work_date >= $3 AND work_date <= $4`,
        [ctx.tenantId, ctx.userId, startDate, endDate]
      );
      const logsByDate = new Map<string, any>();
      for (const lg of logsRes.rows) {
        const dStr = lg.work_date instanceof Date ? lg.work_date.toISOString().slice(0, 10) : String(lg.work_date).slice(0, 10);
        logsByDate.set(dStr, lg);
      }

      const workingDays = parseJsonSafe<number[]>(resolved.shift?.working_days, [1, 2, 3, 4, 5]);
      const holidaySet = new Set((policy.holiday_schedules_json || []).map((h) => String(h.date || '').slice(0, 10)));
      const todayStr = getLocalHHMMAndDate(new Date()).dateStr;
      const items: Array<{
        date: string;
        issue_type: string;
        suggested_check_in: string;
        suggested_check_out: string;
        reason: string;
      }> = [];

      for (let d = 1; d <= daysInMonth; d++) {
        const dStr = `${monthParam}-${String(d).padStart(2, '0')}`;
        if (dStr > todayStr) break;
        if (holidaySet.has(dStr)) continue;
        const jsDay = new Date(`${dStr}T12:00:00Z`).getUTCDay();
        if (!workingDays.includes(jsDay)) continue;

        const lg = logsByDate.get(dStr);
        if (!lg) {
          items.push({
            date: dStr,
            issue_type: 'missing_punch',
            suggested_check_in: resolved.shift?.start_time || '08:30',
            suggested_check_out: resolved.shift?.end_time || '17:30',
            reason: 'Bổ sung công ngày thiếu dữ liệu check-in/out',
          });
        } else if (!lg.check_out_at || Number(lg.late_minutes || 0) > 0 || lg.status === 'out_of_geofence') {
          items.push({
            date: dStr,
            issue_type: !lg.check_out_at ? 'missing_checkout' : Number(lg.late_minutes || 0) > 0 ? 'late' : 'out_of_geofence',
            suggested_check_in: resolved.shift?.start_time || '08:30',
            suggested_check_out: resolved.shift?.end_time || '17:30',
            reason: !lg.check_out_at ? 'Quên check-out cuối ca' : 'Giải trình đi muộn / ngoài vùng',
          });
        }
      }
      return items;
    });

    res.json({ success: true, data: { month: monthParam, items: suggestions } });
  } catch (err: any) {
    sendApiError(res, 500, 'SUGGEST_BULK_REQUESTS_FAILED', err?.message || 'Không thể gợi ý ngày công cần bổ sung.');
  }
});

attendanceRouter.get('/bulk-requests', requirePermission('attendance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const scopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, rbac.effectivePermissions.attendance.scope, {
            tenantColumn: 'r.tenant_id',
            ownerColumn: 'r.user_id',
          })
        : { clause: 'r.tenant_id = $1 AND r.user_id = $2', values: [ctx.tenantId, ctx.userId], nextIndex: 3 };

      const r = await client.query(
        `SELECT r.*, u.full_name AS user_name, u.email AS user_email
         FROM tenant_attendance_bulk_requests r
         LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
         WHERE ${scopeSql.clause}
         ORDER BY r.created_at DESC LIMIT 200`,
        scopeSql.values
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_BULK_REQUESTS_FAILED', err?.message || 'Không thể tải danh sách giải trình gộp.');
  }
});

attendanceRouter.get('/bulk-requests/:id', requirePermission('attendance', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const row = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT r.*, u.full_name AS user_name, u.email AS user_email
         FROM tenant_attendance_bulk_requests r
         LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
         WHERE r.tenant_id = $1 AND r.id = $2 LIMIT 1`,
        [ctx.tenantId, req.params.id]
      );
      return r.rows[0] || null;
    });
    if (!row) {
      sendApiError(res, 404, 'BULK_REQUEST_NOT_FOUND', 'Không tìm thấy đơn giải trình gộp.');
      return;
    }
    res.json({ success: true, data: row });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_BULK_REQUEST_FAILED', err?.message || 'Không thể tải chi tiết đơn giải trình gộp.');
  }
});

attendanceRouter.post('/bulk-requests', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const details = Array.isArray(b.details_json ?? b.items) ? (b.details_json ?? b.items) : [];
    if (details.length === 0) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần ít nhất 1 ngày giải trình trong đơn gộp.');
      return;
    }
    const monthPeriod = String(b.month_period || String(details[0]?.date || '').slice(0, 7) || new Date().toISOString().slice(0, 7)).slice(0, 10);
    const id = crypto.randomUUID();
    const initialStatus = b.status === 'draft' ? 'draft' : 'pending_manager';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultApprovalWorkflowsInTx(client, ctx.tenantId);
      const empRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
        [ctx.tenantId, ctx.userId]
      );
      const employeeId = empRes.rows[0]?.id || null;

      let approvalRequestId: string | null = null;
      if (initialStatus !== 'draft') {
        const wfRes = await client.query<{ id: string }>(
          `SELECT id FROM tenant_approval_workflows
           WHERE tenant_id = $1 AND category IN ('attendance_explanation', 'leave') AND is_active = true
           ORDER BY (CASE WHEN category = 'attendance_explanation' THEN 0 ELSE 1 END) ASC LIMIT 1`,
          [ctx.tenantId]
        );
        if (wfRes.rows[0]?.id) {
          const appr = await createApprovalRequestInTx(client, ctx.tenantId, ctx.userId, {
            workflow_id: String(wfRes.rows[0].id),
            title: `Giải trình bảng công tháng ${monthPeriod} (${details.length} ngày)`,
            description: String(b.admin_note || `Tổng hợp ${details.length} ngày công cần giải trình`),
            form_data: { month_period: monthPeriod, items: details },
            linked_entity_type: 'attendance_bulk_request',
            linked_entity_id: id,
          });
          approvalRequestId = appr.id;
        }
      }

      await client.query(
        `INSERT INTO tenant_attendance_bulk_requests (
           id, tenant_id, user_id, employee_id, month_period, status,
           approver_id, admin_note, details_json, approval_request_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          id,
          ctx.tenantId,
          ctx.userId,
          employeeId,
          monthPeriod,
          initialStatus,
          b.approver_id || null,
          b.admin_note ? String(b.admin_note).trim() : null,
          JSON.stringify(details),
          approvalRequestId,
        ]
      );

      const r = await client.query('SELECT * FROM tenant_attendance_bulk_requests WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_BULK_REQUEST_FAILED', err?.message || 'Không thể tạo đơn giải trình gộp.');
  }
});

const updateBulkRequestHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_attendance_bulk_requests
         SET details_json = COALESCE($4::jsonb, details_json),
             admin_note = CASE WHEN $5::boolean THEN $6 ELSE admin_note END,
             status = COALESCE($7, status),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND status IN ('draft', 'pending_manager')
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          ctx.userId,
          (b.details_json ?? b.items) !== undefined ? JSON.stringify(b.details_json ?? b.items) : null,
          b.admin_note !== undefined,
          b.admin_note ? String(b.admin_note).trim() : null,
          b.status === 'draft' || b.status === 'pending_manager' ? b.status : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'BULK_REQUEST_NOT_FOUND', 'Không tìm thấy hoặc không thể chỉnh sửa đơn đã chốt.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_BULK_REQUEST_FAILED', err?.message || 'Không thể cập nhật đơn giải trình gộp.');
  }
};
attendanceRouter.put('/bulk-requests/:id', requirePermission('attendance', 'edit'), updateBulkRequestHandler);
attendanceRouter.patch('/bulk-requests/:id', requirePermission('attendance', 'edit'), updateBulkRequestHandler);

attendanceRouter.post('/bulk-requests/:id/approve', requirePermission('attendance', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const decision = b.status === 'rejected' || b.decision === 'reject' ? 'rejected' : 'approved';
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_attendance_bulk_requests WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      const cur = curRes.rows[0];
      if (!cur) return null;

      const items = parseJsonSafe<Array<Record<string, any>>>(cur.details_json, []);
      if (decision === 'approved') {
        for (const item of items) {
          const dStr = String(item?.date || '').slice(0, 10);
          if (!dStr) continue;
          const workUnits = item.work_units !== undefined ? toNum(item.work_units, 1) : 1;
          await client.query(
            `INSERT INTO tenant_hr_attendance_logs (
               id, tenant_id, user_id, employee_id, work_date, attendance_code,
               within_geofence, work_units, late_minutes, early_leave_minutes, status, note, verification_method
             ) VALUES ($1, $2, $3, $4, $5, 'X', true, $6, 0, 0, 'explained', $7, 'bulk_request_approved')
             ON CONFLICT (tenant_id, user_id, work_date)
             DO UPDATE SET
               status = 'explained',
               attendance_code = 'X',
               within_geofence = true,
               work_units = EXCLUDED.work_units,
               late_minutes = 0,
               early_leave_minutes = 0,
               verification_method = 'bulk_request_approved',
               updated_at = clock_timestamp()`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              cur.user_id,
              cur.employee_id || null,
              dStr,
              workUnits,
              String(item?.reason || b.admin_note || 'Đã duyệt đơn giải trình gộp'),
            ]
          );
        }
      }

      const updRes = await client.query(
        `UPDATE tenant_attendance_bulk_requests
         SET status = $3,
             approved_by = $4,
             approved_at = clock_timestamp(),
             admin_note = COALESCE($5, admin_note),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [ctx.tenantId, cur.id, decision, ctx.userId, b.admin_note ? String(b.admin_note).trim() : null]
      );

      if (cur.approval_request_id) {
        await client.query(
          `UPDATE tenant_approval_requests
           SET status = $3, completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, cur.approval_request_id, decision]
        );
      }

      return updRes.rows[0];
    });
    if (!updated) {
      sendApiError(res, 404, 'BULK_REQUEST_NOT_FOUND', 'Không tìm thấy đơn giải trình gộp.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'APPROVE_BULK_REQUEST_FAILED', err?.message || 'Không thể duyệt đơn giải trình gộp.');
  }
});

attendanceRouter.delete('/bulk-requests/:id', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const canDeleteAll = Boolean(rbac.effectivePermissions.attendance?.actions?.delete);
      const r = await client.query(
        `DELETE FROM tenant_attendance_bulk_requests
         WHERE tenant_id = $1 AND id = $2 ${canDeleteAll ? '' : "AND user_id = $3 AND status IN ('draft', 'pending_manager')"}`,
        canDeleteAll ? [ctx.tenantId, req.params.id] : [ctx.tenantId, req.params.id, ctx.userId]
      );
      return (r.rowCount || 0) > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'BULK_REQUEST_NOT_FOUND', 'Không tìm thấy hoặc không có quyền xóa đơn giải trình.');
      return;
    }
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_BULK_REQUEST_FAILED', err?.message || 'Không thể xóa đơn giải trình gộp.');
  }
});
