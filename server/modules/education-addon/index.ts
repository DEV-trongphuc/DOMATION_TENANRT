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
  clampLimit,
  ensureErpOpsSchema,
  parseJsonSafe,
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

export type GradingScaleType = 'scale_10' | 'ects_6' | 'gpa_4';

export interface CourseSubjectSpec {
  code: string;
  name: string;
  credits: number;
}

export interface ComputedGradeOutcome {
  attendance_score: number | null;
  assignment_score: number | null;
  midterm_score: number | null;
  final_score: number | null;
  gpa_score: number | null;
  ects_score_6: number | null;
  scale_10_score: number | null;
  gpa_4_score: number | null;
  letter_grade: string | null;
  pass_status: 'passed' | 'failed' | 'pending';
}

function normalizeGradingScale(raw: unknown, fallback: GradingScaleType = 'scale_10'): GradingScaleType {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'ects_6' || s === 'ects' || s === '6.0') return 'ects_6';
  if (s === 'gpa_4' || s === 'gpa4' || s === '4.0') return 'gpa_4';
  if (s === 'scale_10' || s === '10' || s === '10.0') return 'scale_10';
  return fallback;
}

function normalizeSubjectsJson(raw: unknown): CourseSubjectSpec[] {
  const parsed = parseJsonSafe<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const out: CourseSubjectSpec[] = [];
  const seen = new Set<string>();
  parsed.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name || rec.subject_name || '').trim();
    if (!name) return;
    const rawCode = String(rec.code || rec.subject_code || '')
      .trim()
      .toUpperCase();
    const code = rawCode || `SUB-${String(idx + 1).padStart(2, '0')}`;
    if (seen.has(code)) return;
    seen.add(code);
    const creditsNum = Number(rec.credits ?? 3);
    const credits = Number.isFinite(creditsNum) && creditsNum > 0 ? Math.min(30, Math.round(creditsNum)) : 3;
    out.push({ code, name, credits });
  });
  return out;
}

function parseNullableScore(raw: unknown, maxBound = 100): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const cleaned = typeof raw === 'string' ? raw.trim().replace(',', '.') : raw;
  if (cleaned === '') return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return Math.min(maxBound, Math.max(0, Math.round(num * 100) / 100));
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Configurable Grading Scale Converter (`scale_10` | `ects_6` | `gpa_4`):
 * - `ects_6` official thresholds:
 *   A >= 5.25, B >= 4.75, C >= 4.50, D >= 4.25, E >= 4.00 (passed), F < 4.00 (failed)
 * - `gpa_4` thresholds:
 *   A >= 3.60, B >= 3.20, C >= 2.50, D >= 2.00 (passed), F < 2.00 (failed)
 * - `scale_10` thresholds:
 *   A >= 8.50, B >= 7.00, C >= 5.50, D >= 4.00 (passed), F < 4.00 (failed)
 */
export function computeConfigurableGrade(params: {
  gradingScale: GradingScaleType;
  attendanceScore?: unknown;
  assignmentScore?: unknown;
  midtermScore?: unknown;
  finalScore?: unknown;
}): ComputedGradeOutcome {
  const maxRaw = params.gradingScale === 'ects_6' ? 100 : params.gradingScale === 'gpa_4' ? 100 : 100;
  const att = parseNullableScore(params.attendanceScore, maxRaw);
  const asg = parseNullableScore(params.assignmentScore, maxRaw);
  const mid = parseNullableScore(params.midtermScore, maxRaw);
  const fin = parseNullableScore(params.finalScore, maxRaw);

  let compositeRaw: number | null = null;
  if (att !== null || asg !== null || mid !== null || fin !== null) {
    if (mid !== null && fin !== null && att === null && asg === null) {
      compositeRaw = mid * 0.4 + fin * 0.6;
    } else if (mid !== null && fin !== null && (att !== null || asg !== null)) {
      let wSum = 0;
      let vSum = 0;
      if (att !== null) {
        wSum += 0.1;
        vSum += att * 0.1;
      }
      if (asg !== null) {
        wSum += 0.2;
        vSum += asg * 0.2;
      }
      wSum += 0.2;
      vSum += mid * 0.2;
      wSum += 0.5;
      vSum += fin * 0.5;
      compositeRaw = wSum > 0 ? vSum / wSum : fin;
    } else if (fin !== null && mid === null && att === null && asg === null) {
      compositeRaw = fin;
    } else if (fin !== null && (att !== null || asg !== null) && mid === null) {
      // If final_score is provided alongside quiz/assignment, allow explicit final_score if already computed,
      // otherwise blend attendance/assignment/final proportionally
      if (att !== null && asg !== null) {
        // Check if fin was passed as explicit subject final or exam component
        compositeRaw = fin;
      } else {
        compositeRaw = fin;
      }
    } else if (att !== null && asg !== null && fin === null && mid === null) {
      compositeRaw = att * 0.5 + asg * 0.5;
    } else {
      compositeRaw = fin ?? mid ?? asg ?? att;
    }
  }

  if (compositeRaw === null) {
    return {
      attendance_score: att,
      assignment_score: asg,
      midterm_score: mid,
      final_score: fin,
      gpa_score: null,
      ects_score_6: null,
      scale_10_score: null,
      gpa_4_score: null,
      letter_grade: null,
      pass_status: 'pending',
    };
  }

  let scale10: number;
  let ects6: number;
  let gpa4: number;
  let letter: string;
  let passStatus: 'passed' | 'failed';

  if (params.gradingScale === 'ects_6') {
    if (compositeRaw > 10) {
      ects6 = Math.min(6, Math.max(0, (compositeRaw / 100) * 6));
    } else if (compositeRaw > 6) {
      ects6 = Math.min(6, Math.max(0, (compositeRaw / 10) * 6));
    } else {
      ects6 = Math.min(6, Math.max(0, compositeRaw));
    }
    ects6 = round2(ects6);
    scale10 = round2((ects6 / 6) * 10);
    gpa4 = round2((ects6 / 6) * 4);

    if (ects6 >= 5.25) {
      letter = 'A';
      passStatus = 'passed';
    } else if (ects6 >= 4.75) {
      letter = 'B';
      passStatus = 'passed';
    } else if (ects6 >= 4.5) {
      letter = 'C';
      passStatus = 'passed';
    } else if (ects6 >= 4.25) {
      letter = 'D';
      passStatus = 'passed';
    } else if (ects6 >= 4.0) {
      letter = 'E';
      passStatus = 'passed';
    } else {
      letter = 'F';
      passStatus = 'failed';
    }
  } else if (params.gradingScale === 'gpa_4') {
    if (compositeRaw > 10) {
      gpa4 = Math.min(4, Math.max(0, (compositeRaw / 100) * 4));
    } else if (compositeRaw > 4) {
      gpa4 = Math.min(4, Math.max(0, (compositeRaw / 10) * 4));
    } else {
      gpa4 = Math.min(4, Math.max(0, compositeRaw));
    }
    gpa4 = round2(gpa4);
    scale10 = round2((gpa4 / 4) * 10);
    ects6 = round2((gpa4 / 4) * 6);

    if (gpa4 >= 3.6) {
      letter = 'A';
      passStatus = 'passed';
    } else if (gpa4 >= 3.2) {
      letter = 'B';
      passStatus = 'passed';
    } else if (gpa4 >= 2.5) {
      letter = 'C';
      passStatus = 'passed';
    } else if (gpa4 >= 2.0) {
      letter = 'D';
      passStatus = 'passed';
    } else {
      letter = 'F';
      passStatus = 'failed';
    }
  } else {
    // 'scale_10'
    if (compositeRaw > 10) {
      scale10 = Math.min(10, Math.max(0, compositeRaw / 10));
    } else {
      scale10 = Math.min(10, Math.max(0, compositeRaw));
    }
    scale10 = round2(scale10);
    ects6 = round2((scale10 / 10) * 6);
    gpa4 = round2((scale10 / 10) * 4);

    if (scale10 >= 8.5) {
      letter = 'A';
      passStatus = 'passed';
    } else if (scale10 >= 7.0) {
      letter = 'B';
      passStatus = 'passed';
    } else if (scale10 >= 5.5) {
      letter = 'C';
      passStatus = 'passed';
    } else if (scale10 >= 4.0) {
      letter = 'D';
      passStatus = 'passed';
    } else {
      letter = 'F';
      passStatus = 'failed';
    }
  }

  const effectiveFinal =
    fin !== null
      ? fin
      : params.gradingScale === 'ects_6'
      ? ects6
      : params.gradingScale === 'gpa_4'
      ? gpa4
      : scale10;

  const storedGpaScore =
    params.gradingScale === 'gpa_4' ? gpa4 : params.gradingScale === 'ects_6' ? gpa4 : scale10;

  return {
    attendance_score: att,
    assignment_score: asg,
    midterm_score: mid,
    final_score: round2(effectiveFinal),
    gpa_score: storedGpaScore,
    ects_score_6: ects6,
    scale_10_score: scale10,
    gpa_4_score: gpa4,
    letter_grade: letter,
    pass_status: passStatus,
  };
}

function normalizeIsoDateString(raw: unknown): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const vnMatch = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (vnMatch) {
    const dd = vnMatch[1].padStart(2, '0');
    const mm = vnMatch[2].padStart(2, '0');
    return `${vnMatch[3]}-${mm}-${dd}`;
  }
  return null;
}

function extractPostponeOcrPayload(params: {
  rawText: string;
  fallbackStudentName: string;
  explicitReason?: string;
  explicitUntil?: string | null;
  documentUrl?: string | null;
  remindLeadDays?: number;
}) {
  const raw = String(params.rawText || '').trim();
  const dateTokens: string[] = [];
  if (raw) {
    const isoRegex = /\b(\d{4}-\d{2}-\d{2})\b/g;
    let m: RegExpExecArray | null;
    while ((m = isoRegex.exec(raw)) !== null) {
      dateTokens.push(m[1]);
    }
    const vnRegex = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/g;
    while ((m = vnRegex.exec(raw)) !== null) {
      const normalized = normalizeIsoDateString(m[1]);
      if (normalized && !dateTokens.includes(normalized)) {
        dateTokens.push(normalized);
      }
    }
  }

  const nameMatch = raw.match(
    /(?:họ\s*(?:và\s*)?tên(?:\s*học\s*viên)?|tôi\s*tên\s*(?:là)?|student\s*name)\s*[:\-]?\s*([^\n\r,;]+)/i
  );
  const extractedStudentName = nameMatch ? nameMatch[1].trim() : params.fallbackStudentName;

  const codeMatch = raw.match(/(?:mã\s*học\s*viên|mssv|student\s*(?:id|code))\s*[:\-]?\s*([A-Z0-9_-]{3,30})/i);
  const extractedStudentCode = codeMatch ? codeMatch[1].trim() : null;

  const reasonMatch = raw.match(
    /(?:lý\s*do(?:\s*xin)?(?:\s*bảo\s*lưu|\s*tạm\s*hoãn)?|reason(?:\s*for\s*deferral)?)\s*[:\-]\s*([^\n\r]+)/i
  );
  const extractedReason = reasonMatch
    ? reasonMatch[1].trim()
    : params.explicitReason
    ? String(params.explicitReason).trim()
    : '';

  const untilMatch = raw.match(
    /(?:đến\s*(?:hết\s*)?ngày|hạn\s*bảo\s*lưu|bảo\s*lưu\s*đến|until|to\s*date)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})/i
  );
  const fromMatch = raw.match(
    /(?:từ\s*ngày|bắt\s*đầu\s*từ|from\s*date|from)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})/i
  );

  const extractedFromDate = fromMatch
    ? normalizeIsoDateString(fromMatch[1])
    : dateTokens.length >= 2
    ? dateTokens[0]
    : new Date().toISOString().slice(0, 10);

  const extractedUntilDate =
    params.explicitUntil ||
    (untilMatch ? normalizeIsoDateString(untilMatch[1]) : null) ||
    (dateTokens.length >= 2 ? dateTokens[dateTokens.length - 1] : dateTokens[0] || null);

  const leadDays = Math.max(1, Math.min(60, Math.round(Number(params.remindLeadDays || 14))));
  let remindDate: string | null = null;
  if (extractedUntilDate) {
    const dt = new Date(`${extractedUntilDate}T00:00:00Z`);
    if (!Number.isNaN(dt.getTime())) {
      dt.setUTCDate(dt.getUTCDate() - leadDays);
      remindDate = dt.toISOString().slice(0, 10);
    }
  }

  const normExtracted = extractedStudentName.toLowerCase().replace(/\s+/g, ' ').trim();
  const normExpected = params.fallbackStudentName.toLowerCase().replace(/\s+/g, ' ').trim();
  const nameMatched = Boolean(
    normExtracted &&
      normExpected &&
      (normExtracted.includes(normExpected) || normExpected.includes(normExtracted))
  );

  return {
    extracted_student_name: extractedStudentName,
    extracted_student_code: extractedStudentCode,
    extracted_reason: extractedReason,
    extracted_from_date: extractedFromDate,
    extracted_until_date: extractedUntilDate,
    detected_dates: dateTokens,
    remind_date: remindDate,
    remind_days_before: leadDays,
    name_matched: nameMatched,
    confidence: raw ? 0.94 : 0.85,
    document_url: params.documentUrl || null,
    raw_excerpt: raw ? raw.slice(0, 800) : null,
    extracted_at: new Date().toISOString(),
  };
}

function normalizeCourseRow(row: Record<string, unknown>) {
  const subjects = normalizeSubjectsJson(row.subjects_json);
  const creditsRaw = Number(row.credits);
  const computedCredits =
    Number.isFinite(creditsRaw) && creditsRaw > 0
      ? Math.round(creditsRaw)
      : subjects.length > 0
      ? subjects.reduce((acc, s) => acc + s.credits, 0)
      : 3;

  return {
    ...row,
    grading_scale: normalizeGradingScale(row.grading_scale, 'scale_10'),
    credits: computedCredits,
    subjects_json: subjects,
    subjects,
    duration_sessions: Number(row.duration_sessions || 0),
    tuition_fee_vnd: Number(row.tuition_fee_vnd || 0),
    classes_count: row.classes_count !== undefined ? Number(row.classes_count || 0) : undefined,
    is_active: row.is_active === undefined ? true : Boolean(row.is_active),
  };
}

export interface NormalizedGradeCell {
  id: string;
  tenant_id: string;
  enrollment_id: string;
  class_id: string;
  session_date: unknown;
  attendance_status: string;
  subject_key: string;
  subject_name: string | null;
  attendance_score: number | null;
  assignment_score: number | null;
  midterm_score: number | null;
  final_score: number | null;
  gpa_score: number | null;
  ects_score_6: number | null;
  letter_grade: string | null;
  pass_status: string;
  feedback: string | null;
  recorded_by: string | null;
  student_name?: string;
  class_code?: string;
  class_name?: string;
  created_at?: unknown;
  updated_at?: unknown;
}

function normalizeGradeRow(row: Record<string, unknown>): NormalizedGradeCell {
  return {
    ...(row as unknown as NormalizedGradeCell),
    id: String(row.id || ''),
    tenant_id: String(row.tenant_id || ''),
    enrollment_id: String(row.enrollment_id || ''),
    class_id: String(row.class_id || ''),
    session_date: row.session_date ?? null,
    attendance_status: String(row.attendance_status || 'present'),
    subject_key: String(row.subject_key || 'GENERAL'),
    subject_name: row.subject_name ? String(row.subject_name) : null,
    attendance_score: row.attendance_score !== null && row.attendance_score !== undefined ? Number(row.attendance_score) : null,
    assignment_score: row.assignment_score !== null && row.assignment_score !== undefined ? Number(row.assignment_score) : null,
    midterm_score: row.midterm_score !== null && row.midterm_score !== undefined ? Number(row.midterm_score) : null,
    final_score: row.final_score !== null && row.final_score !== undefined ? Number(row.final_score) : null,
    gpa_score: row.gpa_score !== null && row.gpa_score !== undefined ? Number(row.gpa_score) : null,
    ects_score_6: row.ects_score_6 !== null && row.ects_score_6 !== undefined ? Number(row.ects_score_6) : null,
    letter_grade: row.letter_grade ? String(row.letter_grade) : null,
    pass_status: String(row.pass_status || 'passed'),
    feedback: row.feedback !== null && row.feedback !== undefined ? String(row.feedback) : null,
    recorded_by: row.recorded_by ? String(row.recorded_by) : null,
  };
}

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
      const [coursesSum, classesSum, enrollSum, schedCount, annCount, staffRes, leadsRes] = await Promise.all([
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
        client.query<{
          students_count: string | number;
          tuition_collected_vnd: string | number;
          deferred_students_count: string | number;
          requested_postpones_count: string | number;
        }>(
          `SELECT COUNT(*)::int AS students_count,
                  COALESCE(SUM(tuition_paid_vnd), 0) AS tuition_collected_vnd,
                  COALESCE(SUM(CASE WHEN status = 'deferred' THEN 1 ELSE 0 END), 0) AS deferred_students_count,
                  COALESCE(SUM(CASE WHEN postpone_status = 'requested' THEN 1 ELSE 0 END), 0) AS requested_postpones_count
           FROM tenant_edu_enrollments
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ cnt: string | number }>(
          'SELECT COUNT(*)::int AS cnt FROM tenant_edu_schedules WHERE tenant_id = $1',
          [ctx.tenantId]
        ),
        client.query<{ cnt: string | number }>(
          'SELECT COUNT(*)::int AS cnt FROM tenant_edu_announcements WHERE tenant_id = $1',
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
          deferred_students_count: Number(enrollSum.rows[0]?.deferred_students_count || 0),
          requested_postpones_count: Number(enrollSum.rows[0]?.requested_postpones_count || 0),
          weekly_slots_count: Number(schedCount.rows[0]?.cnt || 0),
          announcements_count: Number(annCount.rows[0]?.cnt || 0),
        },
        instructors: staffRes.rows,
        leads: leadsRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải tổng quan Đào tạo & Học vụ.';
    sendApiError(res, 500, 'EDUCATION_OVERVIEW_FAILED', message);
  }
});

// ============================================================================
// 2. Courses / Curriculum (`tenant_edu_courses`) & Classes (`tenant_edu_classes`)
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
      return r.rows.map((row) => normalizeCourseRow(row as Record<string, unknown>));
    });
    res.json({ success: true, data: { items } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải danh mục Chương trình / Khóa học.';
    sendApiError(res, 500, 'LIST_COURSES_FAILED', message);
  }
});

router.post('/courses', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'COURSE_NAME_REQUIRED', 'Vui lòng nhập tên Chương trình / Khóa học.');
      return;
    }

    const code =
      String(body.code || '').trim().toUpperCase() || `CRS-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const gradingScale = normalizeGradingScale(body.grading_scale, 'scale_10');
    const subjects = normalizeSubjectsJson(body.subjects_json ?? body.subjects);
    const defaultCredits = subjects.length > 0 ? subjects.reduce((acc, s) => acc + s.credits, 0) : 3;
    const credits = Math.max(1, Math.round(Number(body.credits ?? defaultCredits) || defaultCredits));

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_edu_courses (
           id, tenant_id, code, name, category, duration_sessions, tuition_fee_vnd,
           description, grading_scale, credits, subjects_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          body.category ? String(body.category).trim() : 'Program',
          Math.max(1, Math.round(Number(body.duration_sessions || 12))),
          Math.max(0, Math.round(Number(body.tuition_fee_vnd || 0))),
          body.description ? String(body.description) : null,
          gradingScale,
          credits,
          JSON.stringify(subjects),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_edu_courses WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return normalizeCourseRow(r.rows[0] as Record<string, unknown>);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tạo Khóa học mới.';
    sendApiError(res, 500, 'CREATE_COURSE_FAILED', message);
  }
});

async function handlePatchCourse(courseId: string, body: Record<string, unknown>, tenantId: string) {
  return withTenantTransaction(tenantId, async (client) => {
    const existingRes = await client.query('SELECT * FROM tenant_edu_courses WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
      tenantId,
      courseId,
    ]);
    const existing = existingRes.rows[0] as Record<string, unknown> | undefined;
    if (!existing) return null;

    const nextCode =
      body.code !== undefined ? String(body.code || '').trim().toUpperCase() || String(existing.code) : String(existing.code);
    const nextName =
      body.name !== undefined ? String(body.name || '').trim() || String(existing.name) : String(existing.name);
    const nextCategory =
      body.category !== undefined ? String(body.category || 'Program').trim() : String(existing.category || 'Program');
    const nextSessions =
      body.duration_sessions !== undefined
        ? Math.max(1, Math.round(Number(body.duration_sessions || 12)))
        : Math.max(1, Math.round(Number(existing.duration_sessions || 12)));
    const nextTuition =
      body.tuition_fee_vnd !== undefined
        ? Math.max(0, Math.round(Number(body.tuition_fee_vnd || 0)))
        : Math.max(0, Math.round(Number(existing.tuition_fee_vnd || 0)));
    const nextDescription =
      body.description !== undefined
        ? body.description
          ? String(body.description)
          : null
        : existing.description
        ? String(existing.description)
        : null;
    const nextScale =
      body.grading_scale !== undefined
        ? normalizeGradingScale(body.grading_scale, normalizeGradingScale(existing.grading_scale))
        : normalizeGradingScale(existing.grading_scale);

    const hasSubjectsUpdate = body.subjects_json !== undefined || body.subjects !== undefined;
    const nextSubjects = hasSubjectsUpdate
      ? normalizeSubjectsJson(body.subjects_json ?? body.subjects)
      : normalizeSubjectsJson(existing.subjects_json);

    const fallbackCredits =
      nextSubjects.length > 0 ? nextSubjects.reduce((acc, s) => acc + s.credits, 0) : Number(existing.credits || 3);
    const nextCredits =
      body.credits !== undefined
        ? Math.max(1, Math.round(Number(body.credits) || fallbackCredits))
        : Math.max(1, Math.round(fallbackCredits));
    const nextActive = body.is_active !== undefined ? Boolean(body.is_active) : Boolean(existing.is_active ?? true);

    await client.query(
      `UPDATE tenant_edu_courses
       SET code = $3,
           name = $4,
           category = $5,
           duration_sessions = $6,
           tuition_fee_vnd = $7,
           description = $8,
           grading_scale = $9,
           credits = $10,
           subjects_json = $11::jsonb,
           is_active = $12,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        courseId,
        nextCode,
        nextName,
        nextCategory,
        nextSessions,
        nextTuition,
        nextDescription,
        nextScale,
        nextCredits,
        JSON.stringify(nextSubjects),
        nextActive,
      ]
    );

    const updatedRes = await client.query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM tenant_edu_classes cl WHERE cl.tenant_id = c.tenant_id AND cl.course_id = c.id) AS classes_count
       FROM tenant_edu_courses c
       WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, courseId]
    );
    return normalizeCourseRow(updatedRes.rows[0] as Record<string, unknown>);
  });
}

router.patch('/courses/:id', requirePermission('education', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const courseId = String(req.params.id || '').trim();
    const updated = await handlePatchCourse(courseId, (req.body || {}) as Record<string, unknown>, ctx.tenantId);
    if (!updated) {
      sendApiError(res, 404, 'COURSE_NOT_FOUND', 'Không tìm thấy Chương trình / Khóa học.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể cập nhật Chương trình / Khóa học.';
    sendApiError(res, 500, 'UPDATE_COURSE_FAILED', message);
  }
});

router.patch('/courses', requirePermission('education', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;
    const courseId = String(body.id || body.course_id || '').trim();
    if (!courseId) {
      sendApiError(res, 422, 'COURSE_ID_REQUIRED', 'Vui lòng cung cấp ID Khóa học cần cập nhật.');
      return;
    }
    const updated = await handlePatchCourse(courseId, body, ctx.tenantId);
    if (!updated) {
      sendApiError(res, 404, 'COURSE_NOT_FOUND', 'Không tìm thấy Chương trình / Khóa học.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể cập nhật Chương trình / Khóa học.';
    sendApiError(res, 500, 'UPDATE_COURSE_FAILED', message);
  }
});

router.get('/classes', requirePermission('education', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT cl.*,
                c.code AS course_code,
                c.name AS course_name,
                c.tuition_fee_vnd,
                c.grading_scale,
                c.credits AS course_credits,
                c.subjects_json AS course_subjects_json,
                (SELECT COUNT(*)::int FROM tenant_edu_enrollments en WHERE en.tenant_id = cl.tenant_id AND en.class_id = cl.id AND en.status <> 'dropped') AS enrolled_count
         FROM tenant_edu_classes cl
         INNER JOIN tenant_edu_courses c ON c.tenant_id = cl.tenant_id AND c.id = cl.course_id
         WHERE cl.tenant_id = $1
         ORDER BY cl.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => {
        const rec = row as Record<string, unknown>;
        const subjects = normalizeSubjectsJson(rec.course_subjects_json);
        return {
          ...rec,
          grading_scale: normalizeGradingScale(rec.grading_scale, 'scale_10'),
          course_credits: Number(rec.course_credits || 3),
          subjects,
          max_capacity: Number(rec.max_capacity || 30),
          enrolled_count: Number(rec.enrolled_count || 0),
          tuition_fee_vnd: Number(rec.tuition_fee_vnd || 0),
        };
      });
    });
    res.json({ success: true, data: { items } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải danh sách Lớp học.';
    sendApiError(res, 500, 'LIST_CLASSES_FAILED', message);
  }
});

router.post('/classes', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;
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
            ? String(body.status)
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể mở Lớp học mới.';
    sendApiError(res, 500, 'CREATE_CLASS_FAILED', message);
  }
});

// ============================================================================
// 2B. Matrix Class Gradebook & Batch Excel/CSV Import
// ============================================================================
router.get('/classes/:id/gradebook-matrix', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const classId = String(req.params.id || '').trim();

    const payload = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);

      const clsRes = await client.query(
        `SELECT cl.*,
                c.id AS course_id,
                c.code AS course_code,
                c.name AS course_name,
                c.grading_scale,
                c.credits AS course_credits,
                c.subjects_json
         FROM tenant_edu_classes cl
         INNER JOIN tenant_edu_courses c ON c.tenant_id = cl.tenant_id AND c.id = cl.course_id
         WHERE cl.tenant_id = $1 AND cl.id = $2
         LIMIT 1`,
        [ctx.tenantId, classId]
      );
      const clsRow = clsRes.rows[0] as Record<string, unknown> | undefined;
      if (!clsRow) return null;

      const gradingScale = normalizeGradingScale(clsRow.grading_scale, 'scale_10');
      const baseSubjects = normalizeSubjectsJson(clsRow.subjects_json);
      const subjects: CourseSubjectSpec[] =
        baseSubjects.length > 0
          ? [...baseSubjects]
          : [
              {
                code: 'GENERAL',
                name: String(clsRow.course_name || 'Điểm tổng kết môn học'),
                credits: Math.max(1, Math.round(Number(clsRow.course_credits || 3))),
              },
            ];

      const [enrollRes, gradeRes] = await Promise.all([
        client.query(
          `SELECT * FROM tenant_edu_enrollments
           WHERE tenant_id = $1 AND class_id = $2 AND status <> 'dropped'
           ORDER BY student_name ASC, enrolled_at ASC`,
          [ctx.tenantId, classId]
        ),
        client.query(
          `SELECT * FROM tenant_edu_attendance_grades
           WHERE tenant_id = $1 AND class_id = $2
           ORDER BY updated_at ASC, created_at ASC`,
          [ctx.tenantId, classId]
        ),
      ]);

      const knownSubCodes = new Set(subjects.map((s) => s.code.toUpperCase()));
      for (const g of gradeRes.rows) {
        const gRec = g as Record<string, unknown>;
        const sk = String(gRec.subject_key || 'GENERAL').trim();
        if (sk && !knownSubCodes.has(sk.toUpperCase())) {
          knownSubCodes.add(sk.toUpperCase());
          subjects.push({
            code: sk,
            name: String(gRec.subject_name || sk),
            credits: 3,
          });
        }
      }

      const students = enrollRes.rows.map((r) => {
        const row = r as Record<string, unknown>;
        const masked = maskContactPiiIfDisallowed(
          {
            phone: row.student_phone ? String(row.student_phone) : null,
            email: row.student_email ? String(row.student_email) : null,
          },
          canUnmaskLeads,
          tenantSettings
        );
        return {
          id: String(row.id),
          enrollment_id: String(row.id),
          lead_id: row.lead_id ? String(row.lead_id) : null,
          student_name: String(row.student_name || ''),
          student_phone: masked.phone,
          student_email: masked.email,
          status: String(row.status || 'active'),
          postpone_status: String(row.postpone_status || 'none'),
          tuition_paid_vnd: Number(row.tuition_paid_vnd || 0),
          enrolled_at: row.enrolled_at,
        };
      });

      const matrix: Record<string, Record<string, ReturnType<typeof normalizeGradeRow>>> = {};
      for (const st of students) {
        matrix[st.id] = {};
      }

      const cells = gradeRes.rows.map((r) => {
        const norm = normalizeGradeRow(r as Record<string, unknown>);
        const enrId = String(norm.enrollment_id);
        const subKey = String(norm.subject_key || 'GENERAL');
        if (!matrix[enrId]) matrix[enrId] = {};
        matrix[enrId][subKey] = norm;
        return norm;
      });

      return {
        class_info: {
          id: String(clsRow.id),
          code: String(clsRow.code),
          name: String(clsRow.name),
          course_id: String(clsRow.course_id),
          course_code: String(clsRow.course_code),
          course_name: String(clsRow.course_name),
          instructor_user_id: clsRow.instructor_user_id ? String(clsRow.instructor_user_id) : null,
          instructor_name: clsRow.instructor_name ? String(clsRow.instructor_name) : null,
          room_name: clsRow.room_name ? String(clsRow.room_name) : null,
          max_capacity: Number(clsRow.max_capacity || 30),
          status: String(clsRow.status || 'enrolling'),
        },
        course: {
          id: String(clsRow.course_id),
          code: String(clsRow.course_code),
          name: String(clsRow.course_name),
          grading_scale: gradingScale,
          credits: Number(clsRow.course_credits || 3),
          subjects,
        },
        grading_scale: gradingScale,
        subjects,
        students,
        matrix,
        cells,
      };
    });

    if (!payload) {
      sendApiError(res, 404, 'CLASS_NOT_FOUND', 'Không tìm thấy Lớp học.');
      return;
    }

    res.json({ success: true, data: payload });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải Ma trận Bảng điểm lớp.';
    sendApiError(res, 500, 'GRADEBOOK_MATRIX_FAILED', message);
  }
});

router.post('/classes/:id/gradebook-batch', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const classId = String(req.params.id || '').trim();
    const body = (req.body || {}) as Record<string, unknown>;
    const rawRows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];

    if (rawRows.length === 0) {
      sendApiError(res, 422, 'ROWS_REQUIRED', 'Vui lòng cung cấp danh sách điểm học viên cần cập nhật.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const clsRes = await client.query(
        `SELECT cl.id, cl.code, cl.name,
                c.id AS course_id, c.name AS course_name, c.grading_scale, c.subjects_json
         FROM tenant_edu_classes cl
         INNER JOIN tenant_edu_courses c ON c.tenant_id = cl.tenant_id AND c.id = cl.course_id
         WHERE cl.tenant_id = $1 AND cl.id = $2
         LIMIT 1`,
        [ctx.tenantId, classId]
      );
      const clsRow = clsRes.rows[0] as Record<string, unknown> | undefined;
      if (!clsRow) return null;

      const courseScale = normalizeGradingScale(clsRow.grading_scale, 'scale_10');
      const effectiveScale =
        body.grading_scale !== undefined ? normalizeGradingScale(body.grading_scale, courseScale) : courseScale;
      const courseSubjects = normalizeSubjectsJson(clsRow.subjects_json);
      const subNameByCode = new Map<string, string>();
      courseSubjects.forEach((s) => subNameByCode.set(s.code.toUpperCase(), s.name));

      const defaultSubKey = String(body.subject_key || courseSubjects[0]?.code || 'GENERAL').trim() || 'GENERAL';
      const defaultSubName =
        (body.subject_name ? String(body.subject_name).trim() : '') ||
        subNameByCode.get(defaultSubKey.toUpperCase()) ||
        String(clsRow.course_name || defaultSubKey);
      const sessionDate = normalizeIsoDateString(body.session_date);

      const enrollRes = await client.query(
        'SELECT * FROM tenant_edu_enrollments WHERE tenant_id = $1 AND class_id = $2',
        [ctx.tenantId, classId]
      );
      const enrollments = enrollRes.rows.map((r) => r as Record<string, unknown>);

      const normalizeDigits = (val: unknown) => String(val || '').replace(/\D+/g, '');

      const upsertedCells: Array<ReturnType<typeof normalizeGradeRow>> = [];
      let insertedCount = 0;
      let updatedCount = 0;
      let autoEnrolledCount = 0;
      let skippedCount = 0;

      for (const row of rawRows) {
        const rowEnrollmentId = String(row.enrollment_id || '').trim();
        const rowEmail = String(row.student_email || row.email || '')
          .trim()
          .toLowerCase();
        const rowPhoneDigits = normalizeDigits(row.student_phone ?? row.phone);
        const rowName = String(row.student_name || row.full_name || '').trim();

        let matched = enrollments.find((en) => rowEnrollmentId && String(en.id) === rowEnrollmentId);
        if (!matched && rowEmail) {
          matched = enrollments.find(
            (en) => String(en.student_email || '').trim().toLowerCase() === rowEmail
          );
        }
        if (!matched && rowPhoneDigits && rowPhoneDigits.length >= 7) {
          matched = enrollments.find((en) => normalizeDigits(en.student_phone) === rowPhoneDigits);
        }
        if (!matched && rowName) {
          matched = enrollments.find(
            (en) => String(en.student_name || '').trim().toLowerCase() === rowName.toLowerCase()
          );
        }

        if (!matched && rowName) {
          const newEnrId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_edu_enrollments (
               id, tenant_id, class_id, student_name, student_phone, student_email, status, tuition_paid_vnd
             ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0)`,
            [
              newEnrId,
              ctx.tenantId,
              classId,
              rowName,
              row.student_phone ? String(row.student_phone).trim() : null,
              rowEmail || null,
            ]
          );
          matched = {
            id: newEnrId,
            class_id: classId,
            student_name: rowName,
            student_phone: row.student_phone ? String(row.student_phone).trim() : null,
            student_email: rowEmail || null,
          };
          enrollments.push(matched);
          autoEnrolledCount += 1;
        }

        if (!matched) {
          skippedCount += 1;
          continue;
        }

        const enrollmentId = String(matched.id);

        // Support either nested `row.grades` map or single-subject row
        const perSubjectEntries: Array<{
          subjectKey: string;
          subjectName: string;
          attStatus: string;
          attScore: unknown;
          asgScore: unknown;
          midScore: unknown;
          finScore: unknown;
          feedback: string | null;
        }> = [];

        if (row.grades && typeof row.grades === 'object' && !Array.isArray(row.grades)) {
          for (const [sk, cellVal] of Object.entries(row.grades as Record<string, unknown>)) {
            if (!cellVal || typeof cellVal !== 'object') continue;
            const cRec = cellVal as Record<string, unknown>;
            const cleanSk = String(sk || defaultSubKey).trim() || defaultSubKey;
            perSubjectEntries.push({
              subjectKey: cleanSk,
              subjectName:
                (cRec.subject_name ? String(cRec.subject_name).trim() : '') ||
                subNameByCode.get(cleanSk.toUpperCase()) ||
                defaultSubName,
              attStatus: ['present', 'late', 'excused', 'absent'].includes(String(cRec.attendance_status))
                ? String(cRec.attendance_status)
                : 'present',
              attScore: cRec.attendance_score,
              asgScore: cRec.assignment_score,
              midScore: cRec.midterm_score,
              finScore: cRec.final_score,
              feedback: cRec.feedback !== undefined && cRec.feedback !== null ? String(cRec.feedback) : null,
            });
          }
        } else {
          const rowSubKey = String(row.subject_key || defaultSubKey).trim() || defaultSubKey;
          const rowSubName =
            (row.subject_name ? String(row.subject_name).trim() : '') ||
            subNameByCode.get(rowSubKey.toUpperCase()) ||
            defaultSubName;
          perSubjectEntries.push({
            subjectKey: rowSubKey,
            subjectName: rowSubName,
            attStatus: ['present', 'late', 'excused', 'absent'].includes(String(row.attendance_status))
              ? String(row.attendance_status)
              : 'present',
            attScore: row.attendance_score,
            asgScore: row.assignment_score,
            midScore: row.midterm_score,
            finScore: row.final_score,
            feedback: row.feedback !== undefined && row.feedback !== null ? String(row.feedback) : null,
          });
        }

        for (const entry of perSubjectEntries) {
          const converted = computeConfigurableGrade({
            gradingScale: effectiveScale,
            attendanceScore: entry.attScore,
            assignmentScore: entry.asgScore,
            midtermScore: entry.midScore,
            finalScore: entry.finScore,
          });

          const existingCell = await client.query<{ id: string }>(
            `SELECT id FROM tenant_edu_attendance_grades
             WHERE tenant_id = $1 AND class_id = $2 AND enrollment_id = $3 AND subject_key = $4
             ORDER BY updated_at DESC, created_at DESC
             LIMIT 1`,
            [ctx.tenantId, classId, enrollmentId, entry.subjectKey]
          );

          let targetGradeId: string;
          if (existingCell.rows[0]?.id) {
            targetGradeId = existingCell.rows[0].id;
            await client.query(
              `UPDATE tenant_edu_attendance_grades
               SET subject_name = $3,
                   attendance_status = $4,
                   attendance_score = $5,
                   assignment_score = $6,
                   midterm_score = $7,
                   final_score = $8,
                   gpa_score = $9,
                   ects_score_6 = $10,
                   letter_grade = $11,
                   pass_status = $12,
                   feedback = $13,
                   recorded_by = $14,
                   updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [
                ctx.tenantId,
                targetGradeId,
                entry.subjectName,
                entry.attStatus,
                converted.attendance_score,
                converted.assignment_score,
                converted.midterm_score,
                converted.final_score,
                converted.gpa_score,
                converted.ects_score_6,
                converted.letter_grade,
                converted.pass_status === 'pending' ? 'passed' : converted.pass_status,
                entry.feedback,
                ctx.userId,
              ]
            );
            updatedCount += 1;
          } else {
            targetGradeId = crypto.randomUUID();
            await client.query(
              `INSERT INTO tenant_edu_attendance_grades (
                 id, tenant_id, enrollment_id, class_id, session_date,
                 attendance_status, subject_key, subject_name,
                 attendance_score, assignment_score, midterm_score, final_score,
                 gpa_score, ects_score_6, letter_grade, pass_status, feedback, recorded_by
               ) VALUES (
                 $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE),
                 $6, $7, $8,
                 $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18
               )`,
              [
                targetGradeId,
                ctx.tenantId,
                enrollmentId,
                classId,
                sessionDate,
                entry.attStatus,
                entry.subjectKey,
                entry.subjectName,
                converted.attendance_score,
                converted.assignment_score,
                converted.midterm_score,
                converted.final_score,
                converted.gpa_score,
                converted.ects_score_6,
                converted.letter_grade,
                converted.pass_status === 'pending' ? 'passed' : converted.pass_status,
                entry.feedback,
                ctx.userId,
              ]
            );
            insertedCount += 1;
          }

          const savedRes = await client.query(
            'SELECT * FROM tenant_edu_attendance_grades WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, targetGradeId]
          );
          if (savedRes.rows[0]) {
            upsertedCells.push(normalizeGradeRow(savedRes.rows[0] as Record<string, unknown>));
          }
        }
      }

      return {
        class_id: classId,
        grading_scale: effectiveScale,
        subject_key: defaultSubKey,
        inserted_count: insertedCount,
        updated_count: updatedCount,
        auto_enrolled_count: autoEnrolledCount,
        skipped_count: skippedCount,
        total_processed: insertedCount + updatedCount,
        items: upsertedCells,
      };
    });

    if (!result) {
      sendApiError(res, 404, 'CLASS_NOT_FOUND', 'Không tìm thấy Lớp học.');
      return;
    }

    res.json({ success: true, data: result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể cập nhật bảng điểm hàng loạt.';
    sendApiError(res, 500, 'GRADEBOOK_BATCH_FAILED', message);
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải Thời khóa biểu tuần.';
    sendApiError(res, 500, 'LIST_SCHEDULES_FAILED', message);
  }
});

router.post('/schedules/check-conflict', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;
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
        instructorUserId: body.instructor_user_id ? String(body.instructor_user_id) : null,
      })
    );

    res.json({
      success: true,
      data: {
        has_conflict: conflicts.length > 0,
        conflicts,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể kiểm tra xung đột lịch học.';
    sendApiError(res, 422, 'CHECK_CONFLICT_FAILED', message);
  }
});

router.post('/schedules', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;
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

      const instructorUserId = body.instructor_user_id
        ? String(body.instructor_user_id)
        : clsRes.rows[0].instructor_user_id || null;
      let instructorName = body.instructor_name
        ? String(body.instructor_name)
        : clsRes.rows[0].instructor_name || null;
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể xóa lịch học.';
    sendApiError(res, 500, 'DELETE_SCHEDULE_FAILED', message);
  }
});

// ============================================================================
// 4. Student Enrollments, Postpone / Reserve Study OCR & Gradebook
// ============================================================================
router.get('/enrollments', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const classId = typeof req.query.class_id === 'string' ? req.query.class_id.trim() : '';

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      let sql = `
        SELECT en.*, cl.code AS class_code, cl.name AS class_name,
               c.id AS course_id, c.code AS course_code, c.name AS course_name, c.grading_scale
        FROM tenant_edu_enrollments en
        INNER JOIN tenant_edu_classes cl ON cl.tenant_id = en.tenant_id AND cl.id = en.class_id
        INNER JOIN tenant_edu_courses c ON c.tenant_id = cl.tenant_id AND c.id = cl.course_id
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
        const rec = row as Record<string, unknown>;
        const masked = maskContactPiiIfDisallowed(
          {
            phone: rec.student_phone ? String(rec.student_phone) : null,
            email: rec.student_email ? String(rec.student_email) : null,
          },
          canUnmaskLeads,
          tenantSettings
        );
        return {
          ...rec,
          student_phone: masked.phone,
          student_email: masked.email,
          tuition_paid_vnd: Number(rec.tuition_paid_vnd || 0),
          grading_scale: normalizeGradingScale(rec.grading_scale, 'scale_10'),
          postpone_status: String(rec.postpone_status || 'none'),
          postpone_ocr_json: parseJsonSafe<Record<string, unknown>>(rec.postpone_ocr_json, {}),
          metadata_json: parseJsonSafe<Record<string, unknown>>(rec.metadata_json, {}),
        };
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải danh sách Học viên ghi danh.';
    sendApiError(res, 500, 'LIST_ENROLLMENTS_FAILED', message);
  }
});

router.post('/enrollments', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;
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
           id, tenant_id, class_id, lead_id, student_name, student_phone, student_email,
           program_code, status, tuition_paid_vnd
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
        [
          id,
          ctx.tenantId,
          classId,
          body.lead_id || null,
          studentName,
          studentPhone,
          studentEmail,
          body.program_code ? String(body.program_code).trim() : null,
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
      const row = r.rows[0] as Record<string, unknown>;
      return { ...row, tuition_paid_vnd: Number(row.tuition_paid_vnd || 0) };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'STUDENT_NAME_REQUIRED') {
      sendApiError(res, 422, 'STUDENT_NAME_REQUIRED', 'Vui lòng nhập họ tên Học viên hoặc chọn từ Hồ sơ CRM.');
      return;
    }
    const message = err instanceof Error ? err.message : 'Không thể ghi danh Học viên.';
    sendApiError(res, 500, 'CREATE_ENROLLMENT_FAILED', message);
  }
});

router.post('/enrollments/:id/postpone', requirePermission('education', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const enrollmentId = String(req.params.id || '').trim();
    const body = (req.body || {}) as Record<string, unknown>;

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const enrRes = await client.query(
        'SELECT * FROM tenant_edu_enrollments WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, enrollmentId]
      );
      const existing = enrRes.rows[0] as Record<string, unknown> | undefined;
      if (!existing) return { status: 'not_found' as const };

      const explicitUntil = normalizeIsoDateString(body.postpone_until);
      const ocrJson = extractPostponeOcrPayload({
        rawText: String(body.raw_document_text || ''),
        fallbackStudentName: String(existing.student_name || ''),
        explicitReason: body.postpone_reason ? String(body.postpone_reason) : undefined,
        explicitUntil,
        documentUrl: body.document_url ? String(body.document_url) : null,
        remindLeadDays: Number(body.remind_days_before || 14),
      });

      const resolvedReason =
        String(body.postpone_reason || '').trim() || ocrJson.extracted_reason || '';
      if (!resolvedReason) {
        return { status: 'reason_required' as const };
      }

      const resolvedUntil = explicitUntil || ocrJson.extracted_until_date || null;
      const canApprove = Boolean(
        rbac.userOrg?.is_tenant_owner ||
          rbac.effectivePermissions.education?.actions.approve ||
          rbac.effectivePermissions.education_addon?.actions.approve
      );
      const autoApproved = Boolean(body.auto_approve) && canApprove;
      const nextPostponeStatus = autoApproved ? 'approved' : 'requested';
      const nextStatus = autoApproved ? 'deferred' : String(existing.status || 'active');

      const prevMeta = parseJsonSafe<Record<string, unknown>>(existing.metadata_json, {});
      const prevHistory = Array.isArray(prevMeta.postpone_history)
        ? (prevMeta.postpone_history as Array<Record<string, unknown>>)
        : [];
      const historyEntry = {
        id: crypto.randomUUID(),
        action: autoApproved ? 'requested_and_approved' : 'requested',
        postpone_status: nextPostponeStatus,
        postpone_reason: resolvedReason,
        postpone_until: resolvedUntil,
        document_url: body.document_url ? String(body.document_url) : null,
        ocr_summary: ocrJson,
        actor_id: ctx.userId,
        created_at: new Date().toISOString(),
      };
      const nextMeta = {
        ...prevMeta,
        postpone_history: [historyEntry, ...prevHistory].slice(0, 50),
      };

      await client.query(
        `UPDATE tenant_edu_enrollments
         SET status = $3,
             postpone_status = $4,
             postpone_reason = $5,
             postpone_until = $6::date,
             postpone_ocr_json = $7::jsonb,
             metadata_json = $8::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          enrollmentId,
          nextStatus,
          nextPostponeStatus,
          resolvedReason,
          resolvedUntil,
          JSON.stringify(ocrJson),
          JSON.stringify(nextMeta),
        ]
      );

      const updatedRes = await client.query(
        'SELECT * FROM tenant_edu_enrollments WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, enrollmentId]
      );
      const updated = updatedRes.rows[0] as Record<string, unknown>;
      return {
        status: 'ok' as const,
        enrollment: {
          ...updated,
          tuition_paid_vnd: Number(updated.tuition_paid_vnd || 0),
          postpone_ocr_json: parseJsonSafe<Record<string, unknown>>(updated.postpone_ocr_json, {}),
          metadata_json: parseJsonSafe<Record<string, unknown>>(updated.metadata_json, {}),
        },
      };
    });

    if (outcome.status === 'not_found') {
      sendApiError(res, 404, 'ENROLLMENT_NOT_FOUND', 'Không tìm thấy hồ sơ ghi danh Học viên.');
      return;
    }
    if (outcome.status === 'reason_required') {
      sendApiError(res, 422, 'POSTPONE_REASON_REQUIRED', 'Vui lòng nhập lý do bảo lưu hoặc dán văn bản đơn xin bảo lưu.');
      return;
    }

    res.json({ success: true, data: outcome.enrollment });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể xử lý hồ sơ bảo lưu học tập.';
    sendApiError(res, 500, 'POSTPONE_REQUEST_FAILED', message);
  }
});

router.patch('/enrollments/:id/postpone-decision', requirePermission('education', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const enrollmentId = String(req.params.id || '').trim();
    const body = (req.body || {}) as Record<string, unknown>;
    const decision = String(body.decision || '').trim().toLowerCase();

    if (!['approved', 'rejected', 'resumed'].includes(decision)) {
      sendApiError(
        res,
        422,
        'INVALID_POSTPONE_DECISION',
        'Quyết định xử lý bảo lưu phải là approved, rejected hoặc resumed.'
      );
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const enrRes = await client.query(
        'SELECT * FROM tenant_edu_enrollments WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, enrollmentId]
      );
      const existing = enrRes.rows[0] as Record<string, unknown> | undefined;
      if (!existing) return null;

      const nextStatus =
        decision === 'approved'
          ? 'deferred'
          : decision === 'resumed'
          ? 'active'
          : existing.status === 'deferred'
          ? 'active'
          : String(existing.status || 'active');

      const prevOcr = parseJsonSafe<Record<string, unknown>>(existing.postpone_ocr_json, {});
      const nextOcr = {
        ...prevOcr,
        last_decision: decision,
        decision_note: body.note ? String(body.note).trim() : null,
        decided_by: ctx.userId,
        decided_at: new Date().toISOString(),
      };

      const prevMeta = parseJsonSafe<Record<string, unknown>>(existing.metadata_json, {});
      const prevHistory = Array.isArray(prevMeta.postpone_history)
        ? (prevMeta.postpone_history as Array<Record<string, unknown>>)
        : [];
      const historyEntry = {
        id: crypto.randomUUID(),
        action: decision,
        postpone_status: decision,
        postpone_reason: existing.postpone_reason ? String(existing.postpone_reason) : null,
        postpone_until: existing.postpone_until ? String(existing.postpone_until) : null,
        note: body.note ? String(body.note).trim() : null,
        actor_id: ctx.userId,
        created_at: new Date().toISOString(),
      };
      const nextMeta = {
        ...prevMeta,
        postpone_history: [historyEntry, ...prevHistory].slice(0, 50),
      };

      await client.query(
        `UPDATE tenant_edu_enrollments
         SET status = $3,
             postpone_status = $4,
             postpone_ocr_json = $5::jsonb,
             metadata_json = $6::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          enrollmentId,
          nextStatus,
          decision,
          JSON.stringify(nextOcr),
          JSON.stringify(nextMeta),
        ]
      );

      const r = await client.query(
        'SELECT * FROM tenant_edu_enrollments WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, enrollmentId]
      );
      const row = r.rows[0] as Record<string, unknown>;
      return {
        ...row,
        tuition_paid_vnd: Number(row.tuition_paid_vnd || 0),
        postpone_ocr_json: parseJsonSafe<Record<string, unknown>>(row.postpone_ocr_json, {}),
        metadata_json: parseJsonSafe<Record<string, unknown>>(row.metadata_json, {}),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'ENROLLMENT_NOT_FOUND', 'Không tìm thấy hồ sơ ghi danh Học viên.');
      return;
    }

    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể cập nhật quyết định bảo lưu.';
    sendApiError(res, 500, 'POSTPONE_DECISION_FAILED', message);
  }
});

// ============================================================================
// 5. Legacy & Standard Gradebook Endpoints (`GET|POST /gradebook`)
// ============================================================================
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
      return r.rows.map((row) => normalizeGradeRow(row as Record<string, unknown>));
    });

    res.json({ success: true, data: { items } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải Sổ điểm & Điểm danh.';
    sendApiError(res, 500, 'LIST_GRADEBOOK_FAILED', message);
  }
});

router.post('/gradebook', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;
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

    const ects6 = gpa !== null ? round2((gpa / 10) * 6) : null;
    const letter =
      gpa === null
        ? null
        : gpa >= 8.5
        ? 'A'
        : gpa >= 7.0
        ? 'B'
        : gpa >= 5.5
        ? 'C'
        : gpa >= 4.0
        ? 'D'
        : 'F';
    const passStatus = gpa === null || gpa >= 4.0 ? 'passed' : 'failed';

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
           attendance_status, subject_key, subject_name,
           attendance_score, assignment_score, midterm_score, final_score,
           gpa_score, ects_score_6, letter_grade, pass_status, feedback, recorded_by
         ) VALUES (
           $1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE),
           $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18
         )`,
        [
          id,
          ctx.tenantId,
          enrollmentId,
          enr.rows[0].class_id,
          body.session_date || null,
          ['present', 'late', 'excused', 'absent'].includes(String(body.attendance_status))
            ? String(body.attendance_status)
            : 'present',
          body.subject_key ? String(body.subject_key).trim() : 'GENERAL',
          body.subject_name ? String(body.subject_name).trim() : null,
          parseNullableScore(body.attendance_score, 10),
          parseNullableScore(body.assignment_score, 10),
          midterm,
          finalScore,
          gpa,
          ects6,
          letter,
          passStatus,
          body.feedback ? String(body.feedback) : null,
          ctx.userId,
        ]
      );

      const r = await client.query(
        'SELECT * FROM tenant_edu_attendance_grades WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      return normalizeGradeRow(r.rows[0] as Record<string, unknown>);
    });

    if (!created) {
      sendApiError(res, 404, 'ENROLLMENT_NOT_FOUND', 'Không tìm thấy hồ sơ ghi danh Học viên.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể lưu điểm danh & bảng điểm.';
    sendApiError(res, 500, 'RECORD_GRADEBOOK_FAILED', message);
  }
});

// ============================================================================
// 6. Batch Subject Announcement, Lecturer Invitation & Onboarding (`tenant_edu_announcements`)
// ============================================================================
router.get('/announcements', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const annType = typeof req.query.announcement_type === 'string' ? req.query.announcement_type.trim() : '';
    const classId = typeof req.query.class_id === 'string' ? req.query.class_id.trim() : '';
    const limit = clampLimit(req.query.limit, 50, 200);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      let sql = `
        SELECT a.*,
               cl.code AS class_code,
               cl.name AS class_name,
               c.code AS course_code,
               c.name AS course_name
        FROM tenant_edu_announcements a
        LEFT JOIN tenant_edu_classes cl ON cl.tenant_id = a.tenant_id AND cl.id = a.class_id
        LEFT JOIN tenant_edu_courses c ON c.tenant_id = a.tenant_id AND c.id = a.course_id
        WHERE a.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      if (annType && annType !== 'all') {
        params.push(annType);
        sql += ` AND a.announcement_type = $${params.length}`;
      }
      if (classId && classId !== 'all') {
        params.push(classId);
        sql += ` AND a.class_id = $${params.length}`;
      }
      params.push(limit);
      sql += ` ORDER BY a.created_at DESC LIMIT $${params.length}`;

      const r = await client.query(sql, params);
      return r.rows.map((row) => {
        const rec = row as Record<string, unknown>;
        const channels = parseJsonSafe<string[]>(rec.channels_json, ['email']);
        const recipients = parseJsonSafe<Array<Record<string, unknown>>>(rec.recipients_json, []);
        return {
          ...rec,
          channels,
          channels_json: channels,
          recipients,
          recipients_json: recipients,
          sent_count: Number(rec.sent_count || 0),
        };
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải lịch sử Thông báo Học vụ.';
    sendApiError(res, 500, 'LIST_ANNOUNCEMENTS_FAILED', message);
  }
});

router.post('/announcements', requirePermission('education', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = (req.body || {}) as Record<string, unknown>;

    const rawType = String(body.announcement_type || 'subject_announcement').trim();
    const announcementType = ['subject_announcement', 'lecturer_invitation', 'onboarding'].includes(rawType)
      ? rawType
      : 'subject_announcement';

    const title = String(body.title || '').trim();
    const contentHtml = String(body.content_html || '').trim();
    if (!title) {
      sendApiError(res, 422, 'ANNOUNCEMENT_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề thông báo / thư mời.');
      return;
    }
    if (!contentHtml) {
      sendApiError(res, 422, 'ANNOUNCEMENT_CONTENT_REQUIRED', 'Vui lòng nhập nội dung thông báo HTML.');
      return;
    }

    const rawChannels = Array.isArray(body.channels)
      ? body.channels
      : parseJsonSafe<unknown[]>(body.channels_json, ['email']);
    const allowedChannels = new Set(['email', 'zns', 'workchat']);
    const channels = rawChannels
      .map((c) => String(c || '').trim().toLowerCase())
      .filter((c) => allowedChannels.has(c));
    const effectiveChannels = channels.length > 0 ? Array.from(new Set(channels)) : ['email'];

    const classId = body.class_id ? String(body.class_id).trim() : null;
    let courseId = body.course_id ? String(body.course_id).trim() : null;
    const subjectKey = body.subject_key ? String(body.subject_key).trim() : null;
    const lecturerUserId = body.lecturer_user_id ? String(body.lecturer_user_id).trim() : null;
    const enrollmentId = body.enrollment_id ? String(body.enrollment_id).trim() : null;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const actorRes = await client.query<{ full_name: string }>(
        'SELECT full_name FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, ctx.userId]
      );
      const actorName = actorRes.rows[0]?.full_name || 'Ban Học vụ';

      let classInstructorId: string | null = null;
      let classInstructorName: string | null = null;
      if (classId) {
        const clsRes = await client.query<{
          course_id: string;
          instructor_user_id: string | null;
          instructor_name: string | null;
        }>(
          'SELECT course_id, instructor_user_id, instructor_name FROM tenant_edu_classes WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, classId]
        );
        if (clsRes.rows[0]) {
          courseId = courseId || clsRes.rows[0].course_id;
          classInstructorId = clsRes.rows[0].instructor_user_id;
          classInstructorName = clsRes.rows[0].instructor_name;
        }
      }

      const rawRecipients = Array.isArray(body.recipients)
        ? (body.recipients as Array<Record<string, unknown>>)
        : parseJsonSafe<Array<Record<string, unknown>>>(body.recipients_json, []);

      const resolvedRecipients: Array<{
        id?: string;
        name: string;
        email?: string | null;
        phone?: string | null;
        role: string;
      }> = [];

      if (rawRecipients.length > 0) {
        for (const r of rawRecipients) {
          if (!r || typeof r !== 'object') continue;
          const rName = String(r.name || r.student_name || r.full_name || '').trim();
          const rEmail = r.email ? String(r.email).trim() : null;
          const rPhone = r.phone ? String(r.phone).trim() : null;
          if (!rName && !rEmail && !rPhone) continue;
          resolvedRecipients.push({
            id: r.id ? String(r.id) : undefined,
            name: rName || rEmail || rPhone || 'Người nhận',
            email: rEmail,
            phone: rPhone,
            role: String(r.role || (announcementType === 'lecturer_invitation' ? 'lecturer' : 'student')),
          });
        }
      } else if (announcementType === 'lecturer_invitation') {
        const targetLecturerId = lecturerUserId || classInstructorId;
        if (targetLecturerId) {
          const uRes = await client.query<{ id: string; full_name: string; email: string | null }>(
            'SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [ctx.tenantId, targetLecturerId]
          );
          if (uRes.rows[0]) {
            resolvedRecipients.push({
              id: uRes.rows[0].id,
              name: uRes.rows[0].full_name,
              email: uRes.rows[0].email,
              phone: null,
              role: 'lecturer',
            });
          }
        } else if (classInstructorName) {
          resolvedRecipients.push({
            name: classInstructorName,
            email: null,
            phone: null,
            role: 'lecturer',
          });
        }
      } else if (enrollmentId) {
        const enRes = await client.query<{
          id: string;
          student_name: string;
          student_email: string | null;
          student_phone: string | null;
        }>(
          'SELECT id, student_name, student_email, student_phone FROM tenant_edu_enrollments WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, enrollmentId]
        );
        if (enRes.rows[0]) {
          resolvedRecipients.push({
            id: enRes.rows[0].id,
            name: enRes.rows[0].student_name,
            email: enRes.rows[0].student_email,
            phone: enRes.rows[0].student_phone,
            role: 'student',
          });
        }
      } else if (classId) {
        const enRes = await client.query<{
          id: string;
          student_name: string;
          student_email: string | null;
          student_phone: string | null;
        }>(
          `SELECT id, student_name, student_email, student_phone
           FROM tenant_edu_enrollments
           WHERE tenant_id = $1 AND class_id = $2 AND status <> 'dropped'
           ORDER BY student_name ASC`,
          [ctx.tenantId, classId]
        );
        for (const row of enRes.rows) {
          resolvedRecipients.push({
            id: row.id,
            name: row.student_name,
            email: row.student_email,
            phone: row.student_phone,
            role: 'student',
          });
        }
      } else if (courseId) {
        const enRes = await client.query<{
          id: string;
          student_name: string;
          student_email: string | null;
          student_phone: string | null;
        }>(
          `SELECT en.id, en.student_name, en.student_email, en.student_phone
           FROM tenant_edu_enrollments en
           INNER JOIN tenant_edu_classes cl ON cl.tenant_id = en.tenant_id AND cl.id = en.class_id
           WHERE en.tenant_id = $1 AND cl.course_id = $2 AND en.status <> 'dropped'
           ORDER BY en.student_name ASC`,
          [ctx.tenantId, courseId]
        );
        for (const row of enRes.rows) {
          resolvedRecipients.push({
            id: row.id,
            name: row.student_name,
            email: row.student_email,
            phone: row.student_phone,
            role: 'student',
          });
        }
      }

      const sentCount = resolvedRecipients.length;
      const id = crypto.randomUUID();

      await client.query(
        `INSERT INTO tenant_edu_announcements (
           id, tenant_id, announcement_type, course_id, class_id, subject_key,
           title, content_html, channels_json, recipients_json, sent_count, status,
           created_by, created_by_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, 'sent', $12, $13)`,
        [
          id,
          ctx.tenantId,
          announcementType,
          courseId,
          classId,
          subjectKey,
          title,
          contentHtml,
          JSON.stringify(effectiveChannels),
          JSON.stringify(resolvedRecipients),
          sentCount,
          ctx.userId,
          actorName,
        ]
      );

      // Optional WorkChat broadcast if 'workchat' channel is enabled and a channel exists
      if (effectiveChannels.includes('workchat')) {
        const wcRes = await client.query<{ id: string }>(
          `SELECT id FROM tenant_workchat_channels
           WHERE tenant_id = $1 AND is_archived = false
           ORDER BY CASE WHEN channel_type = 'announcement' THEN 0 ELSE 1 END, created_at ASC
           LIMIT 1`,
          [ctx.tenantId]
        );
        if (wcRes.rows[0]?.id) {
          const previewText = `[Học vụ] ${title} (${sentCount} người nhận)`;
          await client.query(
            `INSERT INTO tenant_workchat_messages (
               id, tenant_id, channel_id, sender_user_id, sender_name, message_type, content
             ) VALUES ($1, $2, $3, $4, $5, 'text', $6)`,
            [crypto.randomUUID(), ctx.tenantId, wcRes.rows[0].id, ctx.userId, actorName, previewText]
          );
          await client.query(
            `UPDATE tenant_workchat_channels
             SET last_message_at = clock_timestamp(),
                 last_message_preview = $3,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, wcRes.rows[0].id, previewText.slice(0, 250)]
          );
        }
      }

      const r = await client.query(
        'SELECT * FROM tenant_edu_announcements WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      const saved = r.rows[0] as Record<string, unknown>;
      return {
        ...saved,
        channels: effectiveChannels,
        channels_json: effectiveChannels,
        recipients: resolvedRecipients,
        recipients_json: resolvedRecipients,
        sent_count: Number(saved.sent_count || 0),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể gửi Thông báo Học vụ.';
    sendApiError(res, 500, 'CREATE_ANNOUNCEMENT_FAILED', message);
  }
});

// ============================================================================
// 7. Student Academic Workspace 360° (`GET /students/:enrollmentId/workspace`)
// ============================================================================
router.get('/students/:enrollmentId/workspace', requirePermission('education', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const enrollmentId = String(req.params.enrollmentId || '').trim();

    const workspace = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);

      const enrRes = await client.query(
        `SELECT en.*,
                cl.code AS class_code,
                cl.name AS class_name,
                cl.room_name,
                cl.instructor_name,
                cl.start_date AS class_start_date,
                cl.end_date AS class_end_date,
                cl.status AS class_status,
                c.id AS course_id,
                c.code AS course_code,
                c.name AS course_name,
                c.grading_scale,
                c.credits AS course_credits,
                c.duration_sessions,
                c.tuition_fee_vnd,
                c.subjects_json
         FROM tenant_edu_enrollments en
         INNER JOIN tenant_edu_classes cl ON cl.tenant_id = en.tenant_id AND cl.id = en.class_id
         INNER JOIN tenant_edu_courses c ON c.tenant_id = cl.tenant_id AND c.id = cl.course_id
         WHERE en.tenant_id = $1 AND en.id = $2
         LIMIT 1`,
        [ctx.tenantId, enrollmentId]
      );
      const enRow = enrRes.rows[0] as Record<string, unknown> | undefined;
      if (!enRow) return null;

      const masked = maskContactPiiIfDisallowed(
        {
          phone: enRow.student_phone ? String(enRow.student_phone) : null,
          email: enRow.student_email ? String(enRow.student_email) : null,
        },
        canUnmaskLeads,
        tenantSettings
      );

      const classId = String(enRow.class_id);
      const courseId = String(enRow.course_id);
      const gradingScale = normalizeGradingScale(enRow.grading_scale, 'scale_10');
      const baseSubjects = normalizeSubjectsJson(enRow.subjects_json);

      const [gradesRes, annRes] = await Promise.all([
        client.query(
          `SELECT * FROM tenant_edu_attendance_grades
           WHERE tenant_id = $1 AND enrollment_id = $2
           ORDER BY updated_at DESC, created_at DESC`,
          [ctx.tenantId, enrollmentId]
        ),
        client.query(
          `SELECT * FROM tenant_edu_announcements
           WHERE tenant_id = $1 AND (class_id = $2 OR course_id = $3)
           ORDER BY created_at DESC
           LIMIT 20`,
          [ctx.tenantId, classId, courseId]
        ),
      ]);

      const normalizedGrades = gradesRes.rows.map((g) => normalizeGradeRow(g as Record<string, unknown>));

      const curriculum: CourseSubjectSpec[] =
        baseSubjects.length > 0
          ? [...baseSubjects]
          : [
              {
                code: 'GENERAL',
                name: String(enRow.course_name || 'Tổng kết khóa học'),
                credits: Math.max(1, Math.round(Number(enRow.course_credits || 3))),
              },
            ];

      const knownCodes = new Set(curriculum.map((s) => s.code.toUpperCase()));
      for (const g of normalizedGrades) {
        const sk = String(g.subject_key || 'GENERAL').trim();
        if (sk && !knownCodes.has(sk.toUpperCase())) {
          knownCodes.add(sk.toUpperCase());
          curriculum.push({
            code: sk,
            name: String(g.subject_name || sk),
            credits: 3,
          });
        }
      }

      const latestBySubject = new Map<string, ReturnType<typeof normalizeGradeRow>>();
      for (const g of normalizedGrades) {
        const keyUpper = String(g.subject_key || 'GENERAL').toUpperCase();
        if (!latestBySubject.has(keyUpper)) {
          latestBySubject.set(keyUpper, g);
        }
      }

      let earnedCredits = 0;
      let totalCredits = 0;
      let weightedEctsSum = 0;
      let weightedScale10Sum = 0;
      let weightedGpa4Sum = 0;
      let gradedCredits = 0;

      const subjectTranscript = curriculum.map((sub) => {
        totalCredits += sub.credits;
        const g = latestBySubject.get(sub.code.toUpperCase());
        if (!g) {
          return {
            subject_code: sub.code,
            subject_name: sub.name,
            credits: sub.credits,
            status: enRow.status === 'deferred' ? ('deferred' as const) : ('pending' as const),
            attendance_score: null,
            assignment_score: null,
            midterm_score: null,
            final_score: null,
            gpa_score: null,
            ects_score_6: null,
            letter_grade: null,
            feedback: null,
            updated_at: null,
          };
        }

        const converted = computeConfigurableGrade({
          gradingScale,
          attendanceScore: g.attendance_score,
          assignmentScore: g.assignment_score,
          midtermScore: g.midterm_score,
          finalScore: g.final_score,
        });

        const ects6 = g.ects_score_6 ?? converted.ects_score_6;
        const scale10 =
          gradingScale === 'scale_10'
            ? g.gpa_score ?? converted.scale_10_score
            : converted.scale_10_score ?? (ects6 !== null ? round2((ects6 / 6) * 10) : null);
        const gpa4 =
          gradingScale === 'gpa_4'
            ? g.gpa_score ?? converted.gpa_4_score
            : converted.gpa_4_score ?? (ects6 !== null ? round2((ects6 / 6) * 4) : null);

        const isPassed = g.pass_status === 'passed';
        if (isPassed) {
          earnedCredits += sub.credits;
        }
        if (ects6 !== null && scale10 !== null && gpa4 !== null) {
          weightedEctsSum += ects6 * sub.credits;
          weightedScale10Sum += scale10 * sub.credits;
          weightedGpa4Sum += gpa4 * sub.credits;
          gradedCredits += sub.credits;
        }

        return {
          subject_code: sub.code,
          subject_name: sub.name,
          credits: sub.credits,
          status: isPassed ? ('passed' as const) : ('failed' as const),
          attendance_score: g.attendance_score,
          assignment_score: g.assignment_score,
          midterm_score: g.midterm_score,
          final_score: g.final_score,
          gpa_score: g.gpa_score,
          ects_score_6: ects6,
          letter_grade: g.letter_grade ?? converted.letter_grade,
          feedback: g.feedback ? String(g.feedback) : null,
          updated_at: g.updated_at ?? g.created_at ?? null,
        };
      });

      const completedSubjects = subjectTranscript.filter((s) => s.status === 'passed');
      const pendingSubjects = subjectTranscript.filter((s) => s.status !== 'passed');

      // Attendance breakdown
      let presentCount = 0;
      let lateCount = 0;
      let excusedCount = 0;
      let absentCount = 0;
      for (const g of normalizedGrades) {
        const st = String(g.attendance_status || 'present');
        if (st === 'present') presentCount += 1;
        else if (st === 'late') lateCount += 1;
        else if (st === 'excused') excusedCount += 1;
        else if (st === 'absent') absentCount += 1;
      }
      const totalAttendanceSessions = presentCount + lateCount + excusedCount + absentCount;
      const attendanceRate =
        totalAttendanceSessions > 0
          ? round2(
              ((presentCount * 1.0 + excusedCount * 0.85 + lateCount * 0.75) / totalAttendanceSessions) * 100
            )
          : 100;

      const cumulativeEcts6 = gradedCredits > 0 ? round2(weightedEctsSum / gradedCredits) : null;
      const cumulativeScale10 = gradedCredits > 0 ? round2(weightedScale10Sum / gradedCredits) : null;
      const cumulativeGpa4 = gradedCredits > 0 ? round2(weightedGpa4Sum / gradedCredits) : null;
      const cumulativeGpa =
        gradingScale === 'ects_6'
          ? cumulativeEcts6
          : gradingScale === 'gpa_4'
          ? cumulativeGpa4
          : cumulativeScale10;

      const metaObj = parseJsonSafe<Record<string, unknown>>(enRow.metadata_json, {});
      const postponeHistory = Array.isArray(metaObj.postpone_history)
        ? (metaObj.postpone_history as Array<Record<string, unknown>>)
        : [];
      const postponeOcr = parseJsonSafe<Record<string, unknown>>(enRow.postpone_ocr_json, {});

      const announcements = annRes.rows.map((a) => {
        const rec = a as Record<string, unknown>;
        return {
          ...rec,
          channels: parseJsonSafe<string[]>(rec.channels_json, ['email']),
          sent_count: Number(rec.sent_count || 0),
        };
      });

      return {
        enrollment: {
          id: String(enRow.id),
          class_id: classId,
          class_code: String(enRow.class_code),
          class_name: String(enRow.class_name),
          room_name: enRow.room_name ? String(enRow.room_name) : null,
          instructor_name: enRow.instructor_name ? String(enRow.instructor_name) : null,
          course_id: courseId,
          course_code: String(enRow.course_code),
          course_name: String(enRow.course_name),
          grading_scale: gradingScale,
          lead_id: enRow.lead_id ? String(enRow.lead_id) : null,
          student_name: String(enRow.student_name),
          student_phone: masked.phone,
          student_email: masked.email,
          status: String(enRow.status || 'active'),
          tuition_paid_vnd: Number(enRow.tuition_paid_vnd || 0),
          tuition_fee_vnd: Number(enRow.tuition_fee_vnd || 0),
          postpone_status: String(enRow.postpone_status || 'none'),
          postpone_reason: enRow.postpone_reason ? String(enRow.postpone_reason) : null,
          postpone_until: enRow.postpone_until ? String(enRow.postpone_until).slice(0, 10) : null,
          postpone_ocr_json: postponeOcr,
          enrolled_at: enRow.enrolled_at,
        },
        curriculum_progress: {
          grading_scale: gradingScale,
          total_subjects: curriculum.length,
          completed_subjects_count: completedSubjects.length,
          pending_subjects_count: pendingSubjects.length,
          earned_credits: earnedCredits,
          total_credits: totalCredits,
          progress_pct: totalCredits > 0 ? Math.round((earnedCredits / totalCredits) * 100) : 0,
          cumulative_gpa: cumulativeGpa,
          cumulative_scale_10: cumulativeScale10,
          cumulative_ects_6: cumulativeEcts6,
          cumulative_gpa_4: cumulativeGpa4,
        },
        attendance: {
          attendance_rate: attendanceRate,
          total_sessions: totalAttendanceSessions,
          present_count: presentCount,
          late_count: lateCount,
          excused_count: excusedCount,
          absent_count: absentCount,
        },
        subjects: subjectTranscript,
        completed_subjects: completedSubjects,
        pending_subjects: pendingSubjects,
        postpone_history: postponeHistory,
        announcements,
      };
    });

    if (!workspace) {
      sendApiError(res, 404, 'ENROLLMENT_NOT_FOUND', 'Không tìm thấy hồ sơ ghi danh Học viên.');
      return;
    }

    res.json({ success: true, data: workspace });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Không thể tải Không gian Học vụ 360° của Học viên.';
    sendApiError(res, 500, 'STUDENT_WORKSPACE_FAILED', message);
  }
});

export default router;
