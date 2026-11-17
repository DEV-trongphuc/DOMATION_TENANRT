import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import {
  ensureErpOpsSchema,
  resolveActorContext,
} from '../erp-ops/schema.ts';

export const router = Router();

router.use(requireTenantAuth);
router.use(requireEntitlement('education_addon'));
router.use(async (_req, _res, next) => {
  try {
    await ensureErpOpsSchema();
    next();
  } catch (err) {
    next(err);
  }
});

function parseHhMmToMinutes(raw: unknown): number | null {
  const s = String(raw || '').trim();
  const m = s.match(/^([0-2]?[0-9]):([0-5][0-9])$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23) return null;
  return hh * 60 + mm;
}

async function detectTimetableConflictsInTx(
  client: Parameters<Parameters<typeof withTenantTransaction>[1]>[0],
  params: {
    tenantId: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    roomName: string;
    instructorUserId?: string | null;
    excludeScheduleId?: string | null;
  }
) {
  const newStart = parseHhMmToMinutes(params.startTime);
  const newEnd = parseHhMmToMinutes(params.endTime);
  if (newStart === null || newEnd === null || newEnd <= newStart) {
    throw new Error('INVALID_TIME_RANGE: Khung giờ bắt đầu phải nhỏ hơn giờ kết thúc (định dạng HH:MM).');
  }

  const existingRes = await client.query<{
    id: string;
    class_id: string;
    class_name: string;
    class_code: string;
    start_time: string;
    end_time: string;
    room_name: string;
    instructor_user_id: string | null;
    instructor_name: string | null;
  }>(
    `SELECT sc.id, sc.class_id, cl.name AS class_name, cl.code AS class_code,
            sc.start_time, sc.end_time, sc.room_name, sc.instructor_user_id, sc.instructor_name
     FROM tenant_edu_schedules sc
     INNER JOIN tenant_edu_classes cl ON cl.tenant_id = sc.tenant_id AND cl.id = sc.class_id
     WHERE sc.tenant_id = $1
       AND sc.day_of_week = $2
       AND cl.status NOT IN ('completed', 'cancelled')`,
    [params.tenantId, params.dayOfWeek]
  );

  const conflicts: Array<{
    schedule_id: string;
    conflict_type: 'room_conflict' | 'instructor_conflict';
    class_code: string;
    class_name: string;
    time_range: string;
    detail: string;
  }> = [];

  for (const row of existingRes.rows) {
    if (params.excludeScheduleId && row.id === params.excludeScheduleId) continue;
    const exStart = parseHhMmToMinutes(row.start_time);
    const exEnd = parseHhMmToMinutes(row.end_time);
    if (exStart === null || exEnd === null) continue;

    const overlaps = exStart < newEnd && newStart < exEnd;
    if (!overlaps) continue;

    if (row.room_name.trim().toLowerCase() === params.roomName.trim().toLowerCase()) {
      conflicts.push({
        schedule_id: row.id,
        conflict_type: 'room_conflict',
        class_code: row.class_code,
        class_name: row.class_name,
        time_range: `${row.start_time} - ${row.end_time}`,
        detail: `Trùng phòng học "${row.room_name}" với lớp ${row.class_code} (${row.start_time} - ${row.end_time}).`,
      });
    }

    if (
      params.instructorUserId &&
      row.instructor_user_id &&
      row.instructor_user_id === params.instructorUserId
    ) {
      conflicts.push({
        schedule_id: row.id,
        conflict_type: 'instructor_conflict',
        class_code: row.class_code,
        class_name: row.class_name,
        time_range: `${row.start_time} - ${row.end_time}`,
        detail: `Giảng viên ${row.instructor_name || ''} đã có lịch dạy lớp ${row.class_code} (${row.start_time} - ${row.end_time}).`,
      });
    }
  }

  return conflicts;
}

// ============================================================================
// 1. Education Vertical Add-on Overview
// ============================================================================
router.get('/overview', requirePermission('education', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [coursesSum, classesSum, enrollSum, schedCount, staffRes, leadsRes] = await Promise.all([
        client.query<{ cnt: string | number }>(
          'SELECT COUNT(*)::int AS cnt FROM tenant_edu_courses WHERE tenant_id = $1 AND is_active = true',
          [ctx.tenantId]
        ),
        client.query<{ total_classes: string | number; active_classes: string | number }>(
          `SELECT COUNT(*)::int AS total_classes,
                  COALESCE(SUM(CASE WHEN status IN ('enrolling', 'ongoing') THEN 1 ELSE 0 END), 0) AS active_classes
           FROM tenant_edu_classes
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ students_count: string | number; tuition_collected_vnd: string | number }>(
          `SELECT COUNT(*)::int AS students_count,
                  COALESCE(SUM(tuition_paid_vnd), 0) AS tuition_collected_vnd
           FROM tenant_edu_enrollments
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ cnt: string | number }>(
          'SELECT COUNT(*)::int AS cnt FROM tenant_edu_schedules WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, full_name, email, role FROM users WHERE tenant_id = $1 AND is_system_bot = false ORDER BY full_name ASC',
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, name, phone, email FROM leads WHERE tenant_id = $1 AND is_deleted = false ORDER BY created_at DESC LIMIT 100',
          [ctx.tenantId]
        ),
      ]);

      return {
        summary: {
          courses_count: Number(coursesSum.rows[0]?.cnt || 0),
          total_classes: Number(classesSum.rows[0]?.total_classes || 0),
          active_classes: Number(classesSum.rows[0]?.active_classes || 0),
          students_count: Number(enrollSum.rows[0]?.students_count || 0),
          tuition_collected_vnd: Number(enrollSum.rows[0]?.tuition_collected_vnd || 0),
          weekly_slots_count: Number(schedCount.rows[0]?.cnt || 0),
        },
        instructors: staffRes.rows,
        leads: leadsRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'EDUCATION_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan Đào tạo & Học vụ.');
  }
});

// ============================================================================
// 2. Courses / Programs (`tenant_edu_courses`) & Classes / Cohorts (`tenant_edu_classes`)
// ============================================================================
router.get('/courses', requirePermission('education', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT c.*,
                (SELECT COUNT(*)::int FROM tenant_edu_classes cl WHERE cl.tenant_id = c.tenant_id AND cl.course_id = c.id) AS classes_count
         FROM tenant_edu_courses c
         WHERE c.tenant_id = $1
         ORDER BY c.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        duration_sessions: Number(row.duration_sessions || 0),
        tuition_fee_vnd: Number(row.tuition_fee_vnd || 0),
        classes_count: Number(row.classes_count || 0),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_COURSES_FAILED', err?.message || 'Không thể tải danh mục Chương trình / Khóa học.');
  }
});

router.post('/courses', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'COURSE_NAME_REQUIRED', 'Vui lòng nhập tên Chương trình / Khóa học.');
      return;
    }

    const code =
      String(body.code || '').trim().toUpperCase() || `CRS-${Date.now().toString(36).toUpperCase().slice(-5)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_edu_courses (
           id, tenant_id, code, name, category, duration_sessions, tuition_fee_vnd, description
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          body.category ? String(body.category).trim() : 'Program',
          Math.max(1, Math.round(Number(body.duration_sessions || 12))),
          Math.max(0, Math.round(Number(body.tuition_fee_vnd || 0))),
          body.description ? String(body.description) : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_edu_courses WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        duration_sessions: Number(r.rows[0].duration_sessions || 0),
        tuition_fee_vnd: Number(r.rows[0].tuition_fee_vnd || 0),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_COURSE_FAILED', err?.message || 'Không thể tạo Khóa học mới.');
  }
});

router.get('/classes', requirePermission('education', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT cl.*,
                c.name AS course_name,
                c.tuition_fee_vnd,
                (SELECT COUNT(*)::int FROM tenant_edu_enrollments en WHERE en.tenant_id = cl.tenant_id AND en.class_id = cl.id AND en.status <> 'dropped') AS enrolled_count
         FROM tenant_edu_classes cl
         INNER JOIN tenant_edu_courses c ON c.tenant_id = cl.tenant_id AND c.id = cl.course_id
         WHERE cl.tenant_id = $1
         ORDER BY cl.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        max_capacity: Number(row.max_capacity || 30),
        enrolled_count: Number(row.enrolled_count || 0),
        tuition_fee_vnd: Number(row.tuition_fee_vnd || 0),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CLASSES_FAILED', err?.message || 'Không thể tải danh sách Lớp học.');
  }
});

router.post('/classes', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const courseId = String(body.course_id || '').trim();
    const name = String(body.name || '').trim();
    if (!courseId || !name) {
      sendApiError(res, 422, 'CLASS_FIELDS_REQUIRED', 'Vui lòng chọn Khóa học và nhập tên Lớp học.');
      return;
    }

    const code =
      String(body.code || '').trim().toUpperCase() || `CLS-${Date.now().toString(36).toUpperCase().slice(-5)}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      let instructorName = body.instructor_name ? String(body.instructor_name).trim() : null;
      if (body.instructor_user_id && !instructorName) {
        const uRes = await client.query<{ full_name: string }>(
          'SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, body.instructor_user_id]
        );
        instructorName = uRes.rows[0]?.full_name || null;
      }

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_edu_classes (
           id, tenant_id, course_id, code, name, instructor_user_id, instructor_name,
           branch_id, room_name, max_capacity, start_date, end_date, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          ctx.tenantId,
          courseId,
          code,
          name,
          body.instructor_user_id || null,
          instructorName,
          body.branch_id || null,
          body.room_name ? String(body.room_name).trim() : 'Phòng 101',
          Math.max(1, Math.round(Number(body.max_capacity || 30))),
          body.start_date || null,
          body.end_date || null,
          ['planning', 'enrolling', 'ongoing', 'completed', 'cancelled'].includes(String(body.status))
            ? body.status
            : 'enrolling',
        ]
      );
      const r = await client.query('SELECT * FROM tenant_edu_classes WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CLASS_FAILED', err?.message || 'Không thể mở Lớp học mới.');
  }
});

// ============================================================================
// 3. Weekly Room & Instructor Timetable + Conflict Checker
// ============================================================================
router.get('/schedules', requirePermission('education', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT sc.*, cl.code AS class_code, cl.name AS class_name, c.name AS course_name
         FROM tenant_edu_schedules sc
         INNER JOIN tenant_edu_classes cl ON cl.tenant_id = sc.tenant_id AND cl.id = sc.class_id
         INNER JOIN tenant_edu_courses c ON c.tenant_id = cl.tenant_id AND c.id = cl.course_id
         WHERE sc.tenant_id = $1
         ORDER BY sc.day_of_week ASC, sc.start_time ASC`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({ ...row, day_of_week: Number(row.day_of_week || 0) }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_SCHEDULES_FAILED', err?.message || 'Không thể tải Thời khóa biểu tuần.');
  }
});

router.post('/schedules/check-conflict', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const dayOfWeek = Math.min(6, Math.max(0, Math.round(Number(body.day_of_week ?? 1))));
    const startTime = String(body.start_time || '08:30').trim();
    const endTime = String(body.end_time || '10:30').trim();
    const roomName = String(body.room_name || 'Phòng 101').trim();

    const conflicts = await withTenantTransaction(ctx.tenantId, async (client) =>
      detectTimetableConflictsInTx(client, {
        tenantId: ctx.tenantId,
        dayOfWeek,
        startTime,
        endTime,
        roomName,
        instructorUserId: body.instructor_user_id || null,
      })
    );

    res.json({
      success: true,
      data: {
        has_conflict: conflicts.length > 0,
        conflicts,
      },
    });
  } catch (err: any) {
    sendApiError(res, 422, 'CHECK_CONFLICT_FAILED', err?.message || 'Không thể kiểm tra xung đột lịch học.');
  }
});

router.post('/schedules', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const classId = String(body.class_id || '').trim();
    const roomName = String(body.room_name || '').trim();
    const startTime = String(body.start_time || '').trim();
    const endTime = String(body.end_time || '').trim();
    const dayOfWeek = Math.min(6, Math.max(0, Math.round(Number(body.day_of_week ?? 1))));

    if (!classId || !roomName || !startTime || !endTime) {
      sendApiError(res, 422, 'SCHEDULE_FIELDS_REQUIRED', 'Vui lòng chọn Lớp học, Phòng học và Khung giờ học.');
      return;
    }

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const clsRes = await client.query<{
        id: string;
        instructor_user_id: string | null;
        instructor_name: string | null;
      }>(
        'SELECT id, instructor_user_id, instructor_name FROM tenant_edu_classes WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, classId]
      );
      if (!clsRes.rows[0]) return { status: 'class_not_found' as const };

      const instructorUserId = body.instructor_user_id || clsRes.rows[0].instructor_user_id || null;
      let instructorName = body.instructor_name || clsRes.rows[0].instructor_name || null;
      if (instructorUserId && !instructorName) {
        const uRes = await client.query<{ full_name: string }>(
          'SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, instructorUserId]
        );
        instructorName = uRes.rows[0]?.full_name || null;
      }

      const conflicts = await detectTimetableConflictsInTx(client, {
        tenantId: ctx.tenantId,
        dayOfWeek,
        startTime,
        endTime,
        roomName,
        instructorUserId,
      });

      if (conflicts.length > 0) {
        return { status: 'conflict' as const, conflicts };
      }

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_edu_schedules (
           id, tenant_id, class_id, day_of_week, start_time, end_time,
           room_name, instructor_user_id, instructor_name, topic
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          ctx.tenantId,
          classId,
          dayOfWeek,
          startTime,
          endTime,
          roomName,
          instructorUserId,
          instructorName,
          body.topic ? String(body.topic) : null,
        ]
      );

      const r = await client.query('SELECT * FROM tenant_edu_schedules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return { status: 'created' as const, schedule: r.rows[0] };
    });

    if (outcome.status === 'class_not_found') {
      sendApiError(res, 404, 'CLASS_NOT_FOUND', 'Không tìm thấy Lớp học.');
      return;
    }
    if (outcome.status === 'conflict') {
      sendApiError(
        res,
        409,
        'SCHEDULE_CONFLICT',
        outcome.conflicts.map((c) => c.detail).join(' | ')
      );
      return;
    }

    res.status(201).json({ success: true, data: outcome.schedule });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INVALID_TIME_RANGE')) {
      sendApiError(res, 422, 'INVALID_TIME_RANGE', msg);
      return;
    }
    sendApiError(res, 500, 'CREATE_SCHEDULE_FAILED', msg || 'Không thể xếp lịch học.');
  }
});

router.delete('/schedules/:id', requirePermission('education', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM tenant_edu_schedules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rowCount > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'SCHEDULE_NOT_FOUND', 'Không tìm thấy ca học.');
      return;
    }
    res.json({ success: true, data: { id, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_SCHEDULE_FAILED', err?.message || 'Không thể xóa lịch học.');
  }
});

// ============================================================================
// 4. Student Enrollments (Linked to `leads`) & Attendance / Gradebook
// ============================================================================
router.get('/enrollments', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const classId = typeof req.query.class_id === 'string' ? req.query.class_id.trim() : '';

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      let sql = `
        SELECT en.*, cl.code AS class_code, cl.name AS class_name
        FROM tenant_edu_enrollments en
        INNER JOIN tenant_edu_classes cl ON cl.tenant_id = en.tenant_id AND cl.id = en.class_id
        WHERE en.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (classId && classId !== 'all') {
        sql += ' AND en.class_id = $2';
        params.push(classId);
      }
      sql += ' ORDER BY en.enrolled_at DESC';

      const r = await client.query(sql, params);
      return r.rows.map((row) => {
        const masked = maskContactPiiIfDisallowed(
          { phone: row.student_phone, email: row.student_email },
          canUnmaskLeads,
          tenantSettings
        );
        return {
          ...row,
          student_phone: masked.phone,
          student_email: masked.email,
          tuition_paid_vnd: Number(row.tuition_paid_vnd || 0),
        };
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ENROLLMENTS_FAILED', err?.message || 'Không thể tải danh sách Học viên ghi danh.');
  }
});

router.post('/enrollments', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const classId = String(body.class_id || '').trim();
    if (!classId) {
      sendApiError(res, 422, 'CLASS_ID_REQUIRED', 'Vui lòng chọn Lớp học ghi danh.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      let studentName = body.student_name ? String(body.student_name).trim() : '';
      let studentPhone = body.student_phone ? String(body.student_phone).trim() : null;
      let studentEmail = body.student_email ? String(body.student_email).trim() : null;

      if (body.lead_id) {
        const lRes = await client.query<{ name: string; phone: string | null; email: string | null }>(
          'SELECT name, phone, email FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, body.lead_id]
        );
        if (lRes.rows[0]) {
          studentName = studentName || lRes.rows[0].name;
          studentPhone = studentPhone || lRes.rows[0].phone;
          studentEmail = studentEmail || lRes.rows[0].email;
        }
      }

      if (!studentName) {
        throw new Error('STUDENT_NAME_REQUIRED');
      }

      const tuitionPaid = Math.max(0, Math.round(Number(body.tuition_paid_vnd || 0)));
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_edu_enrollments (
           id, tenant_id, class_id, lead_id, student_name, student_phone, student_email, status, tuition_paid_vnd
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
        [
          id,
          ctx.tenantId,
          classId,
          body.lead_id || null,
          studentName,
          studentPhone,
          studentEmail,
          tuitionPaid,
        ]
      );

      if (body.lead_id && tuitionPaid > 0) {
        await client.query(
          `UPDATE leads
           SET total_revenue_vnd = total_revenue_vnd + $3,
               lifecycle_stage = 'customer',
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, body.lead_id, tuitionPaid]
        );
      }

      const r = await client.query('SELECT * FROM tenant_edu_enrollments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return { ...r.rows[0], tuition_paid_vnd: Number(r.rows[0].tuition_paid_vnd || 0) };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    if (err?.message === 'STUDENT_NAME_REQUIRED') {
      sendApiError(res, 422, 'STUDENT_NAME_REQUIRED', 'Vui lòng nhập họ tên Học viên hoặc chọn từ Hồ sơ CRM.');
      return;
    }
    sendApiError(res, 500, 'CREATE_ENROLLMENT_FAILED', err?.message || 'Không thể ghi danh Học viên.');
  }
});

router.get('/gradebook', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const classId = typeof req.query.class_id === 'string' ? req.query.class_id.trim() : '';

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT g.*, en.student_name, cl.code AS class_code, cl.name AS class_name
        FROM tenant_edu_attendance_grades g
        INNER JOIN tenant_edu_enrollments en ON en.tenant_id = g.tenant_id AND en.id = g.enrollment_id
        INNER JOIN tenant_edu_classes cl ON cl.tenant_id = g.tenant_id AND cl.id = g.class_id
        WHERE g.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (classId && classId !== 'all') {
        sql += ' AND g.class_id = $2';
        params.push(classId);
      }
      sql += ' ORDER BY g.session_date DESC, g.created_at DESC';

      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        midterm_score: row.midterm_score !== null ? Number(row.midterm_score) : null,
        final_score: row.final_score !== null ? Number(row.final_score) : null,
        gpa_score: row.gpa_score !== null ? Number(row.gpa_score) : null,
      }));
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_GRADEBOOK_FAILED', err?.message || 'Không thể tải Sổ điểm & Điểm danh.');
  }
});

router.post('/gradebook', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const enrollmentId = String(body.enrollment_id || '').trim();
    if (!enrollmentId) {
      sendApiError(res, 422, 'ENROLLMENT_REQUIRED', 'Vui lòng chọn Học viên để chấm điểm / điểm danh.');
      return;
    }

    const midterm =
      body.midterm_score !== undefined && body.midterm_score !== null && body.midterm_score !== ''
        ? Math.min(10, Math.max(0, Number(body.midterm_score)))
        : null;
    const finalScore =
      body.final_score !== undefined && body.final_score !== null && body.final_score !== ''
        ? Math.min(10, Math.max(0, Number(body.final_score)))
        : null;
    const gpa =
      midterm !== null && finalScore !== null
        ? Number((midterm * 0.4 + finalScore * 0.6).toFixed(2))
        : midterm ?? finalScore;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const enr = await client.query<{ id: string; class_id: string }>(
        'SELECT id, class_id FROM tenant_edu_enrollments WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, enrollmentId]
      );
      if (!enr.rows[0]) return null;

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_edu_attendance_grades (
           id, tenant_id, enrollment_id, class_id, session_date,
           attendance_status, midterm_score, final_score, gpa_score, feedback, recorded_by
         ) VALUES (
           $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE),
           $6, $7, $8, $9, $10, $11
         )`,
        [
          id,
          ctx.tenantId,
          enrollmentId,
          enr.rows[0].class_id,
          body.session_date || null,
          ['present', 'late', 'excused', 'absent'].includes(String(body.attendance_status))
            ? body.attendance_status
            : 'present',
          midterm,
          finalScore,
          gpa,
          body.feedback ? String(body.feedback) : null,
          ctx.userId,
        ]
      );

      const r = await client.query(
        'SELECT * FROM tenant_edu_attendance_grades WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      return {
        ...r.rows[0],
        midterm_score: r.rows[0].midterm_score !== null ? Number(r.rows[0].midterm_score) : null,
        final_score: r.rows[0].final_score !== null ? Number(r.rows[0].final_score) : null,
        gpa_score: r.rows[0].gpa_score !== null ? Number(r.rows[0].gpa_score) : null,
      };
    });

    if (!created) {
      sendApiError(res, 404, 'ENROLLMENT_NOT_FOUND', 'Không tìm thấy hồ sơ ghi danh Học viên.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'RECORD_GRADEBOOK_FAILED', err?.message || 'Không thể lưu điểm danh & bảng điểm.');
  }
});

export default router;
