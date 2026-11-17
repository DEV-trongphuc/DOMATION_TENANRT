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
  ensureHrmApprovalsSchemaMiddleware,
  parseJsonSafe,
  toBool,
  toNum,
} from '../hrm/schema.ts';
import { createApprovalRequestInTx } from '../approvals/approval-engine.ts';

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

attendanceRouter.use(ensureHrmApprovalsSchemaMiddleware);
attendanceRouter.use(requireTenantAuth);
attendanceRouter.use(requireEntitlement('attendance'));

// Helper inside transaction: resolve active shift + branch for user
async function resolveUserShiftAndBranchInTx(
  client: any,
  tenantId: string,
  userId: string,
  requestedBranchId?: string | null,
  requestedShiftId?: string | null
) {
  await ensureDefaultShiftsInTx(client, tenantId);

  const [userRes, empRes, shiftsRes, assignRes, branchesRes] = await Promise.all([
    client.query('SELECT id, full_name, branch_id, department_id FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
      tenantId,
      userId,
    ]),
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

  // Resolve branch priority: explicit request -> assignment branch -> emp/user branch -> HQ branch with GPS -> first active branch
  const branches = branchesRes.rows;
  let resolvedBranch =
    (requestedBranchId ? branches.find((b: any) => String(b.id) === String(requestedBranchId)) : null) ||
    (assignedBranchId ? branches.find((b: any) => String(b.id) === assignedBranchId) : null) ||
    (userBranchId ? branches.find((b: any) => String(b.id) === userBranchId) : null) ||
    branches.find((b: any) => b.gps_lat !== null && b.gps_lng !== null) ||
    branches[0] ||
    null;

  if (resolvedBranch) {
    resolvedBranch = {
      ...resolvedBranch,
      gps_lat: resolvedBranch.gps_lat !== null && resolvedBranch.gps_lat !== undefined ? Number(resolvedBranch.gps_lat) : null,
      gps_lng: resolvedBranch.gps_lng !== null && resolvedBranch.gps_lng !== undefined ? Number(resolvedBranch.gps_lng) : null,
      gps_radius_meters: Number(resolvedBranch.gps_radius_meters || 150),
    };
  }

  return {
    employeeId: empId,
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
      is_headquarters: toBool(b.is_headquarters, false),
    })),
  };
}

// ============================================================================
// 1. Live Check-In Overview (`/overview`)
// ============================================================================
attendanceRouter.get('/overview', requirePermission('attendance', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const todayStr = getLocalHHMMAndDate(new Date()).dateStr;
    const ymPrefix = todayStr.slice(0, 7);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserShiftAndBranchInTx(client, ctx.tenantId, ctx.userId);
      const [todayLogRes, monthStatsRes, pendingExpRes] = await Promise.all([
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
          `SELECT COUNT(*)::int AS cnt
           FROM tenant_hr_attendance_explanations
           WHERE tenant_id = $1 AND status = 'pending'`,
          [ctx.tenantId]
        ),
      ]);

      const st = monthStatsRes.rows[0] || { my_work_units: 0, my_late_days: 0, company_today_checkins: 0 };
      const todayLog = todayLogRes.rows[0] || null;

      return {
        today_date: todayStr,
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
    const checkInTs = b.timestamp ? new Date(b.timestamp) : new Date();
    const { dateStr: computedDate, minutesOfDay } = getLocalHHMMAndDate(checkInTs);
    const workDate = b.work_date ? String(b.work_date).slice(0, 10) : computedDate;

    const lat = b.latitude !== undefined && b.latitude !== null && b.latitude !== '' ? Number(b.latitude) : null;
    const lng = b.longitude !== undefined && b.longitude !== null && b.longitude !== '' ? Number(b.longitude) : null;

    const record = await withTenantTransaction(ctx.tenantId, async (client) => {
      const resolved = await resolveUserShiftAndBranchInTx(
        client,
        ctx.tenantId,
        ctx.userId,
        b.branch_id || null,
        b.shift_id || null
      );

      const shift = resolved.shift;
      const branch = resolved.branch;

      let distanceMeters: number | null = null;
      let withinGeofence = true;

      if (branch && branch.gps_lat !== null && branch.gps_lng !== null) {
        if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
          distanceMeters = computeHaversineMeters(lat, lng, branch.gps_lat, branch.gps_lng);
          withinGeofence = distanceMeters <= Number(branch.gps_radius_meters || 150);
        } else if (shift && toBool(shift.require_gps, true)) {
          withinGeofence = false;
        }
      }

      if (
        !withinGeofence &&
        shift &&
        !toBool(shift.allow_out_of_geofence_with_explanation, true)
      ) {
        throw new Error('OUT_OF_GEOFENCE_STRICT_BLOCK');
      }

      const startMinutes = parseHHMM(shift?.start_time || '08:30', 510);
      const graceLate = Number(shift?.grace_late_minutes ?? 15);
      const rawLate = Math.max(0, minutesOfDay - startMinutes);
      const lateMinutes = rawLate > graceLate ? rawLate : 0;

      const workUnitValue = toNum(shift?.work_unit_value, 1);
      const status = !withinGeofence
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
               distance_meters = $9,
               within_geofence = $10,
               selfie_data_url = COALESCE($11, selfie_data_url),
               device_info = COALESCE($12, device_info),
               late_minutes = $13,
               work_units = $14,
               status = $15,
               note = COALESCE($16, note),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            logId,
            branch?.id || null,
            shift?.id || null,
            resolved.employeeId,
            checkInTs.toISOString(),
            lat,
            lng,
            distanceMeters,
            withinGeofence,
            b.selfie_data_url ? String(b.selfie_data_url) : null,
            b.device_info ? String(b.device_info).slice(0, 250) : null,
            lateMinutes,
            workUnitValue,
            status,
            b.note ? String(b.note).trim() : null,
          ]
        );
      } else {
        logId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_hr_attendance_logs (
             id, tenant_id, user_id, employee_id, branch_id, shift_id,
             work_date, attendance_code, check_in_at, latitude, longitude,
             distance_meters, within_geofence, selfie_data_url, device_info,
             late_minutes, work_units, status, note
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, 'X', $8, $9, $10,
             $11, $12, $13, $14,
             $15, $16, $17, $18
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
            lat,
            lng,
            distanceMeters,
            withinGeofence,
            b.selfie_data_url ? String(b.selfie_data_url) : null,
            b.device_info ? String(b.device_info).slice(0, 250) : null,
            lateMinutes,
            workUnitValue,
            status,
            b.note ? String(b.note).trim() : null,
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
        within_geofence: toBool(row.within_geofence, true),
        late_minutes: Number(row.late_minutes || 0),
        work_units: toNum(row.work_units, 1),
        branch_radius_meters: branch?.gps_radius_meters ?? null,
        branch_name: branch?.name ?? null,
      };
    });

    res.status(201).json({ success: true, data: record });
  } catch (err: any) {
    if (err?.message === 'OUT_OF_GEOFENCE_STRICT_BLOCK') {
      sendApiError(
        res,
        422,
        'OUT_OF_GEOFENCE',
        'Vị trí hiện tại nằm ngoài bán kính GPS của Chi nhánh và ca làm việc này yêu cầu chấm công đúng tọa độ.'
      );
      return;
    }
    sendApiError(res, 500, 'CHECK_IN_FAILED', err?.message || 'Không thể ghi nhận Check-in.');
  }
});

attendanceRouter.post('/check-out', requirePermission('attendance', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const checkOutTs = b.timestamp ? new Date(b.timestamp) : new Date();
    const { dateStr: computedDate, minutesOfDay: outMinutes } = getLocalHHMMAndDate(checkOutTs);
    const workDate = b.work_date ? String(b.work_date).slice(0, 10) : computedDate;

    const lat = b.latitude !== undefined && b.latitude !== null && b.latitude !== '' ? Number(b.latitude) : null;
    const lng = b.longitude !== undefined && b.longitude !== null && b.longitude !== '' ? Number(b.longitude) : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const logRes = await client.query(
        'SELECT * FROM tenant_hr_attendance_logs WHERE tenant_id = $1 AND user_id = $2 AND work_date = $3 LIMIT 1',
        [ctx.tenantId, ctx.userId, workDate]
      );
      if (logRes.rows.length === 0) {
        throw new Error('CHECKIN_NOT_FOUND');
      }
      const curLog = logRes.rows[0];
      const resolved = await resolveUserShiftAndBranchInTx(
        client,
        ctx.tenantId,
        ctx.userId,
        curLog.branch_id ? String(curLog.branch_id) : null,
        curLog.shift_id ? String(curLog.shift_id) : null
      );

      const shift = resolved.shift;
      const branch = resolved.branch;

      let checkoutDist: number | null = null;
      if (branch && branch.gps_lat !== null && branch.gps_lng !== null && lat !== null && lng !== null) {
        checkoutDist = computeHaversineMeters(lat, lng, branch.gps_lat, branch.gps_lng);
      }

      const checkInDate = curLog.check_in_at ? new Date(curLog.check_in_at) : checkOutTs;
      const rawElapsedHours = Math.max(0, (checkOutTs.getTime() - checkInDate.getTime()) / 3600_000);
      const breakHours = Math.max(0, Number(shift?.break_minutes ?? 60) / 60);
      const workedHours =
        Math.round(
          Math.max(0, rawElapsedHours > 5 ? rawElapsedHours - breakHours : rawElapsedHours) * 100
        ) / 100;

      const endMinutes = parseHHMM(shift?.end_time || '17:30', 1050);
      const graceEarly = Number(shift?.grace_early_leave_minutes ?? 15);
      const rawEarly = Math.max(0, endMinutes - outMinutes);
      const earlyLeaveMinutes = rawEarly > graceEarly ? rawEarly : 0;

      const stdHours = Math.max(1, toNum(shift?.standard_work_hours, 8));
      const halfHours = Math.max(0.5, toNum(shift?.min_half_day_hours, 4));
      const fullUnit = toNum(shift?.work_unit_value, 1);

      let workUnits = fullUnit;
      let attCode = 'X';
      if (workedHours >= stdHours * 0.85) {
        workUnits = fullUnit;
        attCode = 'X';
      } else if (workedHours >= halfHours) {
        workUnits = Math.round(fullUnit * 50) / 100;
        attCode = 'N';
      } else if (b.keep_full_unit) {
        workUnits = fullUnit;
      } else {
        workUnits = Math.round((workedHours / stdHours) * fullUnit * 100) / 100;
      }

      const overtimeHours = Math.max(0, Math.round((workedHours - stdHours) * 100) / 100);

      await client.query(
        `UPDATE tenant_hr_attendance_logs
         SET check_out_at = $3,
             checkout_latitude = $4,
             checkout_longitude = $5,
             checkout_distance_meters = $6,
             checkout_selfie_data_url = COALESCE($7, checkout_selfie_data_url),
             early_leave_minutes = $8,
             worked_hours = $9,
             overtime_hours = $10,
             work_units = $11,
             attendance_code = $12,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          curLog.id,
          checkOutTs.toISOString(),
          lat,
          lng,
          checkoutDist,
          b.selfie_data_url ? String(b.selfie_data_url) : null,
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
        within_geofence: toBool(row.within_geofence, true),
        worked_hours: toNum(row.worked_hours, 0),
        overtime_hours: toNum(row.overtime_hours, 0),
        work_units: toNum(row.work_units, 0),
      };
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    if (err?.message === 'CHECKIN_NOT_FOUND') {
      sendApiError(res, 404, 'CHECKIN_NOT_FOUND', 'Chưa có dữ liệu Check-in hôm nay để thực hiện Check-out.');
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
