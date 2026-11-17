import crypto from 'node:crypto';
import { Router } from 'express';
import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../../core/security/rbac.ts';
import { resolveTenantEntitlementSnapshot } from '../../core/security/entitlements.ts';
import { slugifyCode, slugifyKeyLower } from '../org-rbac/org-rbac.service.ts';
import {
  ensureHrmApprovalsSchemaMiddleware,
  parseJsonSafe,
  toBool,
  toNum,
} from './schema.ts';

interface AvailabilityRule {
  day_of_week: number; // 0 (Sun) .. 6 (Sat)
  start_time: string; // '09:00'
  end_time: string; // '17:00'
}

const DEFAULT_AVAILABILITY_RULES: AvailabilityRule[] = [
  { day_of_week: 1, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 2, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 3, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 4, start_time: '09:00', end_time: '17:00' },
  { day_of_week: 5, start_time: '09:00', end_time: '17:00' },
];

function parseHHMMToMinutes(hhmm: string): number {
  const m = String(hhmm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 540;
  return Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2])));
}

function formatMinutesToHHMM(mins: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(mins)));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function buildAvailableSlotsForLink(params: {
  rules: AvailabilityRule[];
  durationMinutes: number;
  bufferMinutes: number;
  bookedSet: Set<string>;
  fromDateIso?: string;
  daysAhead?: number;
}): Array<{ date: string; day_of_week: number; slots: Array<{ start_time: string; end_time: string; available: boolean }> }> {
  const duration = Math.max(15, Math.min(240, params.durationMinutes || 30));
  const buffer = Math.max(0, Math.min(120, params.bufferMinutes || 0));
  const step = duration + buffer;
  const daysAhead = Math.max(1, Math.min(21, params.daysAhead || 7));

  const baseDate = params.fromDateIso ? new Date(`${params.fromDateIso.slice(0, 10)}T00:00:00Z`) : new Date();
  if (Number.isNaN(baseDate.getTime())) {
    return [];
  }

  const rulesByDow = new Map<number, AvailabilityRule[]>();
  for (const r of params.rules) {
    const dow = Number(r.day_of_week);
    if (dow >= 0 && dow <= 6) {
      const arr = rulesByDow.get(dow) || [];
      arr.push(r);
      rulesByDow.set(dow, arr);
    }
  }

  const out: Array<{
    date: string;
    day_of_week: number;
    slots: Array<{ start_time: string; end_time: string; available: boolean }>;
  }> = [];

  for (let offset = 0; offset < daysAhead; offset++) {
    const d = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + offset));
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const dayRules = rulesByDow.get(dow) || [];
    if (dayRules.length === 0) continue;

    const slots: Array<{ start_time: string; end_time: string; available: boolean }> = [];
    for (const rule of dayRules) {
      const startMin = parseHHMMToMinutes(rule.start_time);
      const endMin = parseHHMMToMinutes(rule.end_time);
      for (let t = startMin; t + duration <= endMin; t += step) {
        const st = formatMinutesToHHMM(t);
        const et = formatMinutesToHHMM(t + duration);
        const key = `${dateStr}|${st}`;
        slots.push({
          start_time: st,
          end_time: et,
          available: !params.bookedSet.has(key),
        });
      }
    }
    if (slots.length > 0) {
      out.push({ date: dateStr, day_of_week: dow, slots });
    }
  }

  return out;
}

function buildIcsCalendarContent(opts: {
  uid: string;
  title: string;
  description: string;
  location: string;
  dateStr: string;
  startTime: string;
  endTime: string;
}): string {
  const dtClean = opts.dateStr.slice(0, 10).replace(/-/g, '');
  const stClean = `${opts.startTime.replace(':', '')}00`;
  const etClean = `${opts.endTime.replace(':', '')}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DOMATION//Smart 1-on-1 Booking//VI',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Asia/Ho_Chi_Minh:${dtClean}T${stClean}`,
    `DTEND;TZID=Asia/Ho_Chi_Minh:${dtClean}T${etClean}`,
    `SUMMARY:${esc(opts.title)}`,
    `DESCRIPTION:${esc(opts.description)}`,
    `LOCATION:${esc(opts.location)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

export const hrmRouter = Router();

hrmRouter.use(ensureHrmApprovalsSchemaMiddleware);

// ============================================================================
// PUBLIC UNAUTHENTICATED 1-ON-1 SMART BOOKING ENDPOINTS
// Placed STRICTLY BEFORE `hrmRouter.use(requireTenantAuth)`!
// ============================================================================
async function resolvePublicBookingTenant(slugOrToken: string): Promise<{ tenantId: string; linkId: string } | null> {
  const cleaned = String(slugOrToken || '').trim();
  if (!cleaned) return null;
  return withSystemPrivilege(async (client) => {
    const r = await client.query<{ tenant_id: string; id: string }>(
      `SELECT bl.tenant_id, bl.id
       FROM tenant_booking_links bl
       INNER JOIN tenants t ON t.id = bl.tenant_id
       WHERE (LOWER(bl.slug) = LOWER($1) OR bl.public_token = $1)
         AND bl.is_active = true
         AND t.status NOT IN ('suspended', 'cancelled')
       LIMIT 1`,
      [cleaned]
    );
    if (r.rows.length === 0) return null;
    return { tenantId: String(r.rows[0].tenant_id), linkId: String(r.rows[0].id) };
  });
}

hrmRouter.get('/public-booking/:slug', async (req, res) => {
  try {
    const resolved = await resolvePublicBookingTenant(req.params.slug);
    if (!resolved) {
      sendApiError(res, 404, 'BOOKING_LINK_NOT_FOUND', 'Liên kết đặt lịch 1-1 không tồn tại hoặc đã tạm đóng.');
      return;
    }

    const fromDate = req.query.from_date ? String(req.query.from_date).slice(0, 10) : undefined;
    const payload = await withTenantTransaction(resolved.tenantId, async (client) => {
      const [linkRes, tenantRes, bookedRes] = await Promise.all([
        client.query(
          `SELECT bl.*, u.full_name AS host_user_name, e.full_name AS host_emp_name
           FROM tenant_booking_links bl
           LEFT JOIN users u ON u.tenant_id = bl.tenant_id AND u.id = bl.host_user_id
           LEFT JOIN tenant_hr_employees e ON e.tenant_id = bl.tenant_id AND e.id = bl.host_employee_id
           WHERE bl.tenant_id = $1 AND bl.id = $2
           LIMIT 1`,
          [resolved.tenantId, resolved.linkId]
        ),
        client.query(
          `SELECT name, industry, industry_key, package_code, plan_tier, subscription_plan_code,
                  crm_erp_upgrade_status, enabled_modules, entitlements, settings
           FROM tenants WHERE id = $1 LIMIT 1`,
          [resolved.tenantId]
        ),
        client.query(
          `SELECT booking_date, start_time, end_time
           FROM tenant_booking_appointments
           WHERE tenant_id = $1 AND booking_link_id = $2 AND status = 'confirmed'`,
          [resolved.tenantId, resolved.linkId]
        ),
      ]);

      const link = linkRes.rows[0];
      const tRow = tenantRes.rows[0];
      const entSnap = tRow ? resolveTenantEntitlementSnapshot(tRow) : null;
      const rules = parseJsonSafe<AvailabilityRule[]>(
        link.availability_rules,
        DEFAULT_AVAILABILITY_RULES
      );

      const bookedSet = new Set<string>();
      const bookedSlots = bookedRes.rows.map((b) => {
        const dStr =
          b.booking_date instanceof Date
            ? b.booking_date.toISOString().slice(0, 10)
            : String(b.booking_date).slice(0, 10);
        bookedSet.add(`${dStr}|${String(b.start_time)}`);
        return {
          booking_date: dStr,
          start_time: String(b.start_time),
          end_time: String(b.end_time),
        };
      });

      const availableDays = buildAvailableSlotsForLink({
        rules: rules.length > 0 ? rules : DEFAULT_AVAILABILITY_RULES,
        durationMinutes: Number(link.duration_minutes || 30),
        bufferMinutes: Number(link.buffer_minutes || 10),
        bookedSet,
        fromDateIso: fromDate,
        daysAhead: 10,
      });

      return {
        booking_link: {
          id: link.id,
          slug: link.slug,
          title: link.title,
          subtitle: link.subtitle,
          description: link.description,
          meeting_purpose: link.meeting_purpose,
          duration_minutes: Number(link.duration_minutes || 30),
          buffer_minutes: Number(link.buffer_minutes || 10),
          timezone: link.timezone || 'Asia/Ho_Chi_Minh',
          location_type: link.location_type,
          location_value: link.location_value,
          host_name: link.host_emp_name || link.host_user_name || tRow?.name || 'Chuyên gia tư vấn',
          custom_questions: parseJsonSafe<any[]>(link.custom_questions, []),
        },
        organization: {
          name: tRow?.name || 'DOMATION Workspace',
          customer_label: entSnap?.terminology.customer_singular || 'Khách hàng',
        },
        booked_slots: bookedSlots,
        available_days: availableDays,
      };
    });

    res.json({ success: true, data: payload });
  } catch (err: any) {
    sendApiError(res, 500, 'PUBLIC_BOOKING_READ_FAILED', err?.message || 'Không thể tải lịch đặt hẹn 1-1.');
  }
});

const publicBookSlotHandler = async (req: any, res: any) => {
  try {
    const resolved = await resolvePublicBookingTenant(req.params.slug);
    if (!resolved) {
      sendApiError(res, 404, 'BOOKING_LINK_NOT_FOUND', 'Liên kết đặt lịch 1-1 không tồn tại hoặc đã tạm đóng.');
      return;
    }

    const b = req.body || {};
    const guestName = String(b.guest_name || b.name || '').trim();
    const bookingDate = String(b.booking_date || '').slice(0, 10);
    const startTime = String(b.start_time || '').trim();
    if (!guestName || !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate) || !/^\d{1,2}:\d{2}$/.test(startTime)) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng nhập họ tên, ngày hẹn và khung giờ hợp lệ.');
      return;
    }

    const guestEmail = b.guest_email || b.email ? String(b.guest_email || b.email).trim() : null;
    const guestPhone = b.guest_phone || b.phone ? String(b.guest_phone || b.phone).trim() : null;

    const booked = await withTenantTransaction(resolved.tenantId, async (client) => {
      const linkRes = await client.query(
        'SELECT * FROM tenant_booking_links WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [resolved.tenantId, resolved.linkId]
      );
      const link = linkRes.rows[0];
      if (!link || !toBool(link.is_active, true)) {
        throw new Error('BOOKING_LINK_INACTIVE');
      }

      const normStart = formatMinutesToHHMM(parseHHMMToMinutes(startTime));
      const duration = Math.max(15, Number(link.duration_minutes || 30));
      const endTime = b.end_time
        ? formatMinutesToHHMM(parseHHMMToMinutes(String(b.end_time)))
        : formatMinutesToHHMM(parseHHMMToMinutes(normStart) + duration);

      const conflictRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM tenant_booking_appointments
         WHERE tenant_id = $1
           AND booking_link_id = $2
           AND booking_date = $3
           AND start_time = $4
           AND status = 'confirmed'`,
        [resolved.tenantId, resolved.linkId, bookingDate, normStart]
      );
      if (Number(conflictRes.rows[0]?.cnt || 0) > 0) {
        throw new Error('SLOT_ALREADY_BOOKED');
      }

      // Match existing Master Contact if phone or email provided
      let matchedLeadId: string | null = null;
      if (guestPhone || guestEmail) {
        const leadLookup = await client.query<{ id: string }>(
          `SELECT id FROM leads
           WHERE tenant_id = $1 AND is_deleted = false
             AND (($2::varchar IS NOT NULL AND phone = $2) OR ($3::varchar IS NOT NULL AND LOWER(email) = LOWER($3)))
           LIMIT 1`,
          [resolved.tenantId, guestPhone, guestEmail]
        );
        matchedLeadId = leadLookup.rows[0]?.id ? String(leadLookup.rows[0].id) : null;
      }

      const apptId = crypto.randomUUID();
      const icsUid = `${apptId}@domation.booking`;
      await client.query(
        `INSERT INTO tenant_booking_appointments (
           id, tenant_id, booking_link_id, guest_name, guest_email, guest_phone,
           guest_company, topic, answers_json, booking_date, start_time, end_time,
           status, lead_id, ics_uid
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, 'confirmed', $13, $14)`,
        [
          apptId,
          resolved.tenantId,
          resolved.linkId,
          guestName,
          guestEmail,
          guestPhone,
          b.guest_company ? String(b.guest_company).trim() : null,
          b.topic ? String(b.topic).trim() : null,
          JSON.stringify(b.answers_json && typeof b.answers_json === 'object' ? b.answers_json : {}),
          bookingDate,
          normStart,
          endTime,
          matchedLeadId,
          icsUid,
        ]
      );

      const icsContent = buildIcsCalendarContent({
        uid: icsUid,
        title: `${link.title} — ${guestName}`,
        description: b.topic ? String(b.topic) : String(link.description || link.title),
        location: String(link.location_value || link.location_type || 'Online Video'),
        dateStr: bookingDate,
        startTime: normStart,
        endTime,
      });

      const createdRow = await client.query(
        'SELECT * FROM tenant_booking_appointments WHERE tenant_id = $1 AND id = $2',
        [resolved.tenantId, apptId]
      );
      return {
        appointment: createdRow.rows[0],
        ics_content: icsContent,
      };
    });

    res.status(201).json({ success: true, data: booked });
  } catch (err: any) {
    if (err?.message === 'SLOT_ALREADY_BOOKED') {
      sendApiError(res, 409, 'SLOT_ALREADY_BOOKED', 'Khung giờ này vừa được đặt trước. Vui lòng chọn khung giờ khác.');
      return;
    }
    if (err?.message === 'BOOKING_LINK_INACTIVE') {
      sendApiError(res, 404, 'BOOKING_LINK_INACTIVE', 'Liên kết đặt lịch hiện đang tạm ngưng nhận lịch mới.');
      return;
    }
    sendApiError(res, 500, 'PUBLIC_BOOKING_CREATE_FAILED', err?.message || 'Không thể hoàn tất đặt lịch hẹn 1-1.');
  }
};

hrmRouter.post('/public-booking/:slug/book', publicBookSlotHandler);
hrmRouter.post('/public-booking/:slug', publicBookSlotHandler);

// ============================================================================
// PUBLIC UNAUTHENTICATED SCHEDULE PORTAL (`/public-schedule/:slug`)
// Placed STRICTLY BEFORE `hrmRouter.use(requireTenantAuth)`!
// ============================================================================
hrmRouter.get('/public-schedule/:slug', async (req, res) => {
  try {
    const rawSlug = String(req.params.slug || '').trim();
    if (!rawSlug) {
      sendApiError(res, 404, 'SCHEDULE_NOT_FOUND', 'Mã liên kết lịch không hợp lệ.');
      return;
    }

    const resolved = await withSystemPrivilege(async (client) => {
      // 1. Try matching a booking link slug/public_token
      const blRes = await client.query<{ tenant_id: string; id: string }>(
        `SELECT bl.tenant_id, bl.id
         FROM tenant_booking_links bl
         INNER JOIN tenants t ON t.id = bl.tenant_id
         WHERE (LOWER(bl.slug) = LOWER($1) OR bl.public_token = $1)
           AND bl.is_active = true
           AND t.status NOT IN ('suspended', 'cancelled')
         LIMIT 1`,
        [rawSlug]
      );
      if (blRes.rows[0]) {
        return {
          mode: 'booking_link' as const,
          tenantId: String(blRes.rows[0].tenant_id),
          targetId: String(blRes.rows[0].id),
        };
      }

      // 2. Try matching tenant slug directly
      const tRes = await client.query<{ id: string }>(
        `SELECT id FROM tenants
         WHERE LOWER(slug) = LOWER($1)
           AND status NOT IN ('suspended', 'cancelled')
         LIMIT 1`,
        [rawSlug]
      );
      if (tRes.rows[0]) {
        return {
          mode: 'tenant_schedule' as const,
          tenantId: String(tRes.rows[0].id),
          targetId: String(tRes.rows[0].id),
        };
      }

      return null;
    });

    if (!resolved) {
      sendApiError(res, 404, 'SCHEDULE_NOT_FOUND', 'Không tìm thấy lịch công khai tương ứng với liên kết này.');
      return;
    }

    const payload = await withTenantTransaction(resolved.tenantId, async (client) => {
      const [tenantRes, branchesRes, linksRes, apptsRes, shiftsRes] = await Promise.all([
        client.query(
          `SELECT name, slug, industry, industry_key, package_code, plan_tier,
                  subscription_plan_code, crm_erp_upgrade_status, enabled_modules, entitlements, settings
           FROM tenants WHERE id = $1 LIMIT 1`,
          [resolved.tenantId]
        ),
        client.query(
          'SELECT id, name, address, phone FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC LIMIT 5',
          [resolved.tenantId]
        ),
        resolved.mode === 'booking_link'
          ? client.query(
              `SELECT bl.*, u.full_name AS host_user_name, e.full_name AS host_emp_name
               FROM tenant_booking_links bl
               LEFT JOIN users u ON u.tenant_id = bl.tenant_id AND u.id = bl.host_user_id
               LEFT JOIN tenant_hr_employees e ON e.tenant_id = bl.tenant_id AND e.id = bl.host_employee_id
               WHERE bl.tenant_id = $1 AND bl.id = $2`,
              [resolved.tenantId, resolved.targetId]
            )
          : client.query(
              `SELECT bl.*, u.full_name AS host_user_name, e.full_name AS host_emp_name
               FROM tenant_booking_links bl
               LEFT JOIN users u ON u.tenant_id = bl.tenant_id AND u.id = bl.host_user_id
               LEFT JOIN tenant_hr_employees e ON e.tenant_id = bl.tenant_id AND e.id = bl.host_employee_id
               WHERE bl.tenant_id = $1 AND bl.is_active = true
               ORDER BY bl.created_at DESC LIMIT 20`,
              [resolved.tenantId]
            ),
        client.query(
          `SELECT a.id, a.booking_link_id, a.booking_date, a.start_time, a.end_time, a.topic, a.status,
                  bl.title AS session_title, bl.location_type, bl.location_value
           FROM tenant_booking_appointments a
           INNER JOIN tenant_booking_links bl ON bl.tenant_id = a.tenant_id AND bl.id = a.booking_link_id
           WHERE a.tenant_id = $1 AND a.status = 'confirmed'
           ORDER BY a.booking_date ASC, a.start_time ASC
           LIMIT 100`,
          [resolved.tenantId]
        ),
        client.query(
          'SELECT id, code, name, start_time, end_time, working_days FROM tenant_hr_shifts WHERE tenant_id = $1 AND is_active = true ORDER BY is_default DESC LIMIT 10',
          [resolved.tenantId]
        ),
      ]);

      const tRow = tenantRes.rows[0] || {};
      const entSnap = resolveTenantEntitlementSnapshot(tRow);
      const settings = parseJsonSafe<Record<string, unknown>>(tRow.settings, {});
      const hq = branchesRes.rows[0] || {};

      const events: Array<Record<string, unknown>> = [];
      for (const ap of apptsRes.rows) {
        if (resolved.mode === 'booking_link' && String(ap.booking_link_id) !== resolved.targetId) continue;
        const dStr =
          ap.booking_date instanceof Date
            ? ap.booking_date.toISOString().slice(0, 10)
            : String(ap.booking_date).slice(0, 10);
        events.push({
          id: ap.id,
          type: 'appointment',
          date: dStr,
          title: ap.session_title || 'Lịch hẹn xác nhận',
          subtitle: ap.topic || 'Phiên làm việc 1-1',
          start_time: ap.start_time,
          end_time: ap.end_time,
          time: `${ap.start_time} - ${ap.end_time}`,
          location: ap.location_value || ap.location_type || hq.address || 'Online',
          status: ap.status,
        });
      }

      // Also generate upcoming availability sessions from active booking links so public schedule calendar is rich immediately
      for (const bl of linksRes.rows) {
        const rules = parseJsonSafe<AvailabilityRule[]>(bl.availability_rules, DEFAULT_AVAILABILITY_RULES);
        const days = buildAvailableSlotsForLink({
          rules: rules.length > 0 ? rules : DEFAULT_AVAILABILITY_RULES,
          durationMinutes: Number(bl.duration_minutes || 30),
          bufferMinutes: Number(bl.buffer_minutes || 10),
          bookedSet: new Set<string>(),
          daysAhead: 14,
        });
        for (const day of days) {
          if (day.slots.length > 0) {
            const firstSlot = day.slots[0];
            const lastSlot = day.slots[day.slots.length - 1];
            events.push({
              id: `${bl.id}-${day.date}`,
              type: 'session',
              date: day.date,
              title: bl.title,
              subtitle: `${bl.host_emp_name || bl.host_user_name || 'Chuyên gia'} • ${day.slots.length} khung giờ trống`,
              start_time: firstSlot.start_time,
              end_time: lastSlot.end_time,
              time: `${firstSlot.start_time} - ${lastSlot.end_time}`,
              location: bl.location_value || bl.location_type || hq.address || 'Online',
              booking_slug: bl.slug,
              available_slots_count: day.slots.length,
            });
          }
        }
      }

      return {
        mode: resolved.mode,
        slug: rawSlug,
        organization: {
          name: String(tRow.name || 'DOMATION Workspace'),
          logo_url: typeof settings.brand_logo_url === 'string' && settings.brand_logo_url ? settings.brand_logo_url : '/imgs/autodata/ICON.png',
          address: String(hq.address || ''),
          phone: String(hq.phone || ''),
          industry_label: entSnap.terminology.industry_label,
          education_addon: Boolean(
            entSnap.enabled_modules.includes('education') ||
              (entSnap as unknown as Record<string, unknown>).education_addon
          ),
        },
        shifts: shiftsRes.rows.map((s) => ({
          ...s,
          working_days: parseJsonSafe<number[]>(s.working_days, [1, 2, 3, 4, 5]),
        })),
        booking_links: linksRes.rows.map((l) => ({
          id: l.id,
          slug: l.slug,
          title: l.title,
          subtitle: l.subtitle,
          host_name: l.host_emp_name || l.host_user_name || tRow.name || 'Chuyên gia',
          duration_minutes: Number(l.duration_minutes || 30),
          location_type: l.location_type,
          location_value: l.location_value,
        })),
        events,
      };
    });

    res.json({ success: true, data: payload });
  } catch (err: any) {
    sendApiError(res, 500, 'PUBLIC_SCHEDULE_READ_FAILED', err?.message || 'Không thể tải lịch trình công khai.');
  }
});

// ============================================================================
// AUTHENTICATED HRM 360° ROUTES (Protected by Tenant Auth + HRM Entitlement)
// ============================================================================
hrmRouter.use(requireTenantAuth);
hrmRouter.use(requireEntitlement('hrm'));

hrmRouter.get('/overview', requirePermission('hrm', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [empStats, ctStats, assetStats, bookingStats, branches, depts, teams, positions, users] =
        await Promise.all([
          client.query<{
            total: number;
            active_cnt: number;
            probation_cnt: number;
          }>(
            `SELECT
               COUNT(*)::int AS total,
               COALESCE(SUM(CASE WHEN employment_status = 'active' THEN 1 ELSE 0 END), 0) AS active_cnt,
               COALESCE(SUM(CASE WHEN employment_status = 'probation' THEN 1 ELSE 0 END), 0) AS probation_cnt
             FROM tenant_hr_employees WHERE tenant_id = $1`,
            [ctx.tenantId]
          ),
          client.query<{ active_contracts: number }>(
            `SELECT COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_contracts
             FROM tenant_hr_contracts WHERE tenant_id = $1`,
            [ctx.tenantId]
          ),
          client.query<{ assigned_assets: number }>(
            `SELECT COALESCE(SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END), 0) AS assigned_assets
             FROM tenant_hr_handover_assets WHERE tenant_id = $1`,
            [ctx.tenantId]
          ),
          client.query<{ links_cnt: number; appts_cnt: number }>(
            `SELECT
               (SELECT COUNT(*)::int FROM tenant_booking_links WHERE tenant_id = $1 AND is_active = true) AS links_cnt,
               (SELECT COUNT(*)::int FROM tenant_booking_appointments WHERE tenant_id = $1 AND status = 'confirmed') AS appts_cnt`,
            [ctx.tenantId]
          ),
          client.query('SELECT id, code, name, legal_entity_name, tax_code, gps_lat, gps_lng, gps_radius_meters FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC, name ASC', [ctx.tenantId]),
          client.query('SELECT id, code, name, branch_id, parent_department_id, manager_user_id FROM tenant_departments WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order ASC, name ASC', [ctx.tenantId]),
          client.query('SELECT id, code, name, department_id, leader_user_id FROM tenant_teams WHERE tenant_id = $1 AND is_active = true ORDER BY name ASC', [ctx.tenantId]),
          client.query('SELECT id, code, name, department_id, level_rank FROM tenant_positions WHERE tenant_id = $1 AND is_active = true ORDER BY level_rank DESC, name ASC', [ctx.tenantId]),
          client.query('SELECT id, full_name, email, phone, role, branch_id, department_id, team_id, position_id, reports_to_user_id FROM users WHERE tenant_id = $1 AND is_system_bot = false ORDER BY full_name ASC', [ctx.tenantId]),
        ]);

      const es = empStats.rows[0] || { total: 0, active_cnt: 0, probation_cnt: 0 };
      const bs = bookingStats.rows[0] || { links_cnt: 0, appts_cnt: 0 };
      return {
        summary: {
          total_employees: Number(es.total || 0),
          active_employees: Number(es.active_cnt || 0),
          probation_employees: Number(es.probation_cnt || 0),
          active_contracts: Number(ctStats.rows[0]?.active_contracts || 0),
          assigned_assets: Number(assetStats.rows[0]?.assigned_assets || 0),
          active_booking_links: Number(bs.links_cnt || 0),
          confirmed_appointments: Number(bs.appts_cnt || 0),
        },
        org: {
          branches: branches.rows,
          departments: depts.rows,
          teams: teams.rows,
          positions: positions.rows,
          users: users.rows,
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'HRM_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan Nhân sự 360°.');
  }
});

// Sync workspace users into HR profiles (1-click idempotent helper)
hrmRouter.post('/employees/sync-users', requirePermission('hrm', 'create'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const synced = await withTenantTransaction(ctx.tenantId, async (client) => {
      const usersRes = await client.query(
        `SELECT id, full_name, email, phone, branch_id, department_id, team_id, position_id, reports_to_user_id
         FROM users
         WHERE tenant_id = $1 AND is_system_bot = false`,
        [ctx.tenantId]
      );
      const existingRes = await client.query<{ user_id: string }>(
        'SELECT user_id FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id IS NOT NULL',
        [ctx.tenantId]
      );
      const linkedSet = new Set(existingRes.rows.map((r) => String(r.user_id)));

      let createdCount = 0;
      for (const u of usersRes.rows) {
        const uid = String(u.id);
        if (linkedSet.has(uid)) continue;
        const empId = crypto.randomUUID();
        const empCode = `EMP-${uid.slice(0, 6).toUpperCase()}`;
        await client.query(
          `INSERT INTO tenant_hr_employees (
             id, tenant_id, user_id, employee_code, full_name, work_email, phone,
             branch_id, department_id, team_id, position_id, manager_user_id,
             employment_status, employment_type, join_date, allowances_json, metadata
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12,
             'active', 'full_time', CURRENT_DATE, '{}'::jsonb, '{}'::jsonb
           )`,
          [
            empId,
            ctx.tenantId,
            uid,
            empCode,
            String(u.full_name || u.email || 'Nhân sự'),
            u.email || null,
            u.phone || null,
            u.branch_id || null,
            u.department_id || null,
            u.team_id || null,
            u.position_id || null,
            u.reports_to_user_id || null,
          ]
        );
        createdCount++;
      }
      return { synced_new_profiles: createdCount };
    });

    res.json({ success: true, data: synced });
  } catch (err: any) {
    sendApiError(res, 500, 'SYNC_USERS_TO_HRM_FAILED', err?.message || 'Không thể đồng bộ tài khoản sang hồ sơ nhân sự.');
  }
});

// ============================================================================
// Employees 360° Directory & Profile CRUD
// ============================================================================
hrmRouter.get('/employees', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = req.query.status ? String(req.query.status).trim() : null;
    const deptFilter = req.query.department_id ? String(req.query.department_id).trim() : null;
    const search = req.query.search ? String(req.query.search).trim() : null;

    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const hrmPerm = rbac.effectivePermissions.hrm;
      const canViewFinancials = Boolean(hrmPerm?.actions.view_financials || rbac.userOrg?.is_tenant_owner);

      const scopeSql = rbac.userOrg
        ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, hrmPerm?.scope || 'own', {
            tenantColumn: 'e.tenant_id',
            ownerColumn: 'e.user_id',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          })
        : { clause: 'e.tenant_id = $1', values: [ctx.tenantId], nextIndex: 2 };

      const params = [...scopeSql.values];
      let where = scopeSql.clause;

      if (statusFilter && statusFilter !== 'all') {
        params.push(statusFilter);
        where += ` AND e.employment_status = $${params.length}`;
      }
      if (deptFilter && deptFilter !== 'all') {
        params.push(deptFilter);
        where += ` AND e.department_id = $${params.length}`;
      }
      if (search) {
        params.push(`%${search}%`);
        const pIdx = `$${params.length}`;
        where += ` AND (e.full_name ILIKE ${pIdx} OR e.employee_code ILIKE ${pIdx} OR COALESCE(e.work_email, '') ILIKE ${pIdx} OR COALESCE(e.phone, '') ILIKE ${pIdx})`;
      }

      const r = await client.query(
        `SELECT e.*,
                b.name AS branch_name,
                d.name AS department_name,
                t.name AS team_name,
                p.name AS position_name,
                m.full_name AS manager_name
         FROM tenant_hr_employees e
         LEFT JOIN tenant_branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
         LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
         LEFT JOIN tenant_teams t ON t.tenant_id = e.tenant_id AND t.id = e.team_id
         LEFT JOIN tenant_positions p ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         LEFT JOIN users m ON m.tenant_id = e.tenant_id AND m.id = e.manager_user_id
         WHERE ${where}
         ORDER BY e.created_at DESC`,
        params
      );

      return r.rows.map((row) => {
        const isSelf = row.user_id && String(row.user_id) === ctx.userId;
        const showSalary = canViewFinancials || isSelf;
        return {
          ...row,
          base_salary_vnd: showSalary ? toNum(row.base_salary_vnd, 0) : 0,
          insurance_salary_vnd: showSalary ? toNum(row.insurance_salary_vnd, 0) : 0,
          allowances_json: showSalary ? parseJsonSafe<Record<string, number>>(row.allowances_json, {}) : {},
          annual_leave_quota: toNum(row.annual_leave_quota, 12),
          annual_leave_used: toNum(row.annual_leave_used, 0),
          compensatory_leave_balance: toNum(row.compensatory_leave_balance, 0),
          dependents_count: Number(row.dependents_count || 0),
          insurance_enrolled: toBool(row.insurance_enrolled, true),
          is_resident: toBool(row.is_resident, true),
          union_member: toBool(row.union_member, false),
          salary_masked: !showSalary,
        };
      });
    });

    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_EMPLOYEES_FAILED', err?.message || 'Không thể tải danh bạ nhân sự.');
  }
});

hrmRouter.get('/employees/:id', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);

    const detail = await withTenantTransaction(ctx.tenantId, async (client) => {
      const empRes = await client.query(
        `SELECT e.*, b.name AS branch_name, d.name AS department_name, t.name AS team_name, p.name AS position_name
         FROM tenant_hr_employees e
         LEFT JOIN tenant_branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
         LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
         LEFT JOIN tenant_teams t ON t.tenant_id = e.tenant_id AND t.id = e.team_id
         LEFT JOIN tenant_positions p ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         WHERE e.tenant_id = $1 AND e.id = $2
         LIMIT 1`,
        [ctx.tenantId, id]
      );
      if (empRes.rows.length === 0) return null;

      const [contractsRes, assetsRes] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_hr_contracts WHERE tenant_id = $1 AND employee_id = $2 ORDER BY start_date DESC',
          [ctx.tenantId, id]
        ),
        client.query(
          'SELECT * FROM tenant_hr_handover_assets WHERE tenant_id = $1 AND employee_id = $2 ORDER BY handed_over_at DESC',
          [ctx.tenantId, id]
        ),
      ]);

      const e = empRes.rows[0];
      return {
        ...e,
        base_salary_vnd: toNum(e.base_salary_vnd, 0),
        insurance_salary_vnd: toNum(e.insurance_salary_vnd, 0),
        allowances_json: parseJsonSafe<Record<string, number>>(e.allowances_json, {}),
        contracts: contractsRes.rows.map((c) => ({
          ...c,
          base_salary_vnd: toNum(c.base_salary_vnd, 0),
          insurance_salary_vnd: toNum(c.insurance_salary_vnd, 0),
          signed_by_employee: toBool(c.signed_by_employee, false),
          signed_by_employer: toBool(c.signed_by_employer, false),
        })),
        assets: assetsRes.rows.map((a) => ({
          ...a,
          asset_value_vnd: toNum(a.asset_value_vnd, 0),
          acknowledged_by_employee: toBool(a.acknowledged_by_employee, false),
        })),
      };
    });

    if (!detail) {
      sendApiError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Không tìm thấy hồ sơ nhân sự.');
      return;
    }
    res.json({ success: true, data: detail });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_EMPLOYEE_FAILED', err?.message || 'Không thể tải chi tiết hồ sơ nhân sự.');
  }
});

// Interactive Hierarchical Org Chart Tree (`/org-chart`)
hrmRouter.get('/org-chart', requirePermission('hrm', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const tree = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tenantRes, branchesRes, deptsRes, empsRes] = await Promise.all([
        client.query('SELECT id, name, slug FROM tenants WHERE id = $1 LIMIT 1', [ctx.tenantId]),
        client.query(
          `SELECT b.*, u.full_name AS manager_name, u.email AS manager_email
           FROM tenant_branches b
           LEFT JOIN users u ON u.tenant_id = b.tenant_id AND u.id = b.manager_user_id
           WHERE b.tenant_id = $1 AND b.is_active = true
           ORDER BY b.is_headquarters DESC, b.name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT d.*, u.full_name AS manager_name, u.email AS manager_email
           FROM tenant_departments d
           LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.manager_user_id
           WHERE d.tenant_id = $1 AND d.is_active = true
           ORDER BY d.sort_order ASC, d.name ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT e.id, e.user_id, e.employee_code, e.full_name, e.work_email, e.phone,
                  e.branch_id, e.department_id, e.team_id, e.position_id, e.manager_user_id,
                  e.employment_type, e.employment_status,
                  p.name AS position_name,
                  (SELECT COUNT(*)::int FROM tenant_hr_contracts c WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.status = 'active') AS active_contracts_count
           FROM tenant_hr_employees e
           LEFT JOIN tenant_positions p ON p.tenant_id = e.tenant_id AND p.id = e.position_id
           WHERE e.tenant_id = $1
           ORDER BY e.full_name ASC`,
          [ctx.tenantId]
        ),
      ]);

      const empsByDept = new Map<string, any[]>();
      const unassignedEmps: any[] = [];
      for (const emp of empsRes.rows) {
        if (emp.department_id) {
          const k = String(emp.department_id);
          const list = empsByDept.get(k) || [];
          list.push(emp);
          empsByDept.set(k, list);
        } else {
          unassignedEmps.push(emp);
        }
      }

      const deptNodes = new Map<string, any>();
      for (const d of deptsRes.rows) {
        deptNodes.set(String(d.id), {
          ...d,
          employees: empsByDept.get(String(d.id)) || [],
          children: [],
        });
      }

      const rootDeptsByBranch = new Map<string, any[]>();
      const globalRootDepts: any[] = [];

      for (const d of deptsRes.rows) {
        const node = deptNodes.get(String(d.id));
        if (d.parent_department_id && deptNodes.has(String(d.parent_department_id))) {
          deptNodes.get(String(d.parent_department_id)).children.push(node);
        } else if (d.branch_id) {
          const bKey = String(d.branch_id);
          const arr = rootDeptsByBranch.get(bKey) || [];
          arr.push(node);
          rootDeptsByBranch.set(bKey, arr);
        } else {
          globalRootDepts.push(node);
        }
      }

      const branches = branchesRes.rows.map((b) => ({
        ...b,
        departments: rootDeptsByBranch.get(String(b.id)) || [],
      }));

      return {
        company: tenantRes.rows[0] || { id: ctx.tenantId, name: 'Doanh nghiệp' },
        total_employees: empsRes.rows.length,
        branches,
        unassigned_departments: globalRootDepts,
        unassigned_employees: unassignedEmps,
      };
    });

    res.json({ success: true, data: tree });
  } catch (err: any) {
    sendApiError(res, 500, 'ORG_CHART_FAILED', err?.message || 'Không thể tải sơ đồ tổ chức.');
  }
});

// Full 360° Account & HR Dossier for `AccountDetailDrawer` (`/employees/:id/dossier`)
hrmRouter.get('/employees/:id/dossier', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);

    const dossier = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const showSalary =
        Boolean(rbac.userOrg?.is_tenant_owner) ||
        Boolean(rbac.effectivePermissions.payroll?.actions.view) ||
        Boolean(rbac.effectivePermissions.hrm?.actions.view_financials);

      const empRes = await client.query(
        `SELECT e.*, b.name AS branch_name, b.tax_code AS branch_tax_code,
                d.name AS department_name, t.name AS team_name, p.name AS position_name,
                mu.full_name AS manager_name
         FROM tenant_hr_employees e
         LEFT JOIN tenant_branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
         LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
         LEFT JOIN tenant_teams t ON t.tenant_id = e.tenant_id AND t.id = e.team_id
         LEFT JOIN tenant_positions p ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         LEFT JOIN users mu ON mu.tenant_id = e.tenant_id AND mu.id = e.manager_user_id
         WHERE e.tenant_id = $1 AND (e.id::text = $2 OR e.user_id::text = $2)
         LIMIT 1`,
        [ctx.tenantId, id]
      );
      if (!empRes.rows[0]) return null;
      const emp = empRes.rows[0];

      const [userRes, contractsRes, assetsRes, attRes, shiftsRes] = await Promise.all([
        emp.user_id
          ? client.query(
              `SELECT id, full_name, email, phone, role, avatar_url, branch_id, department_id, team_id,
                      is_tenant_owner, last_login_at, created_at
               FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
              [ctx.tenantId, emp.user_id]
            )
          : Promise.resolve({ rows: [] as any[] }),
        client.query(
          'SELECT * FROM tenant_hr_contracts WHERE tenant_id = $1 AND employee_id = $2 ORDER BY start_date DESC',
          [ctx.tenantId, emp.id]
        ),
        client.query(
          'SELECT * FROM tenant_hr_handover_assets WHERE tenant_id = $1 AND employee_id = $2 ORDER BY handed_over_at DESC',
          [ctx.tenantId, emp.id]
        ),
        emp.user_id
          ? client.query(
              `SELECT work_date, attendance_code, check_in_at, check_out_at, late_minutes, work_units, status
               FROM tenant_hr_attendance_logs
               WHERE tenant_id = $1 AND user_id = $2
               ORDER BY work_date DESC LIMIT 20`,
              [ctx.tenantId, emp.user_id]
            )
          : Promise.resolve({ rows: [] as any[] }),
        client.query(
          'SELECT * FROM tenant_hr_shifts WHERE tenant_id = $1 AND is_active = true ORDER BY is_default DESC',
          [ctx.tenantId]
        ),
      ]);

      return {
        employee: {
          ...emp,
          base_salary_vnd: showSalary || emp.user_id === ctx.userId ? toNum(emp.base_salary_vnd, 0) : null,
          insurance_salary_vnd: showSalary || emp.user_id === ctx.userId ? toNum(emp.insurance_salary_vnd, 0) : null,
          allowances_json:
            showSalary || emp.user_id === ctx.userId
              ? parseJsonSafe<Record<string, number>>(emp.allowances_json, {})
              : {},
          salary_masked: !(showSalary || emp.user_id === ctx.userId),
        },
        user_account: userRes.rows[0] || null,
        contracts: contractsRes.rows.map((c) => ({
          ...c,
          base_salary_vnd: showSalary || emp.user_id === ctx.userId ? toNum(c.base_salary_vnd, 0) : null,
          insurance_salary_vnd: showSalary || emp.user_id === ctx.userId ? toNum(c.insurance_salary_vnd, 0) : null,
          signed_by_employee: toBool(c.signed_by_employee, false),
          signed_by_employer: toBool(c.signed_by_employer, false),
        })),
        assets: assetsRes.rows.map((a) => ({
          ...a,
          asset_value_vnd: toNum(a.asset_value_vnd, 0),
          acknowledged_by_employee: toBool(a.acknowledged_by_employee, false),
        })),
        recent_attendance: attRes.rows,
        available_shifts: shiftsRes.rows,
      };
    });

    if (!dossier) {
      sendApiError(res, 404, 'EMPLOYEE_DOSSIER_NOT_FOUND', 'Không tìm thấy hồ sơ nhân sự 360°.');
      return;
    }

    res.json({ success: true, data: dossier });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_EMPLOYEE_DOSSIER_FAILED', err?.message || 'Không thể tải hồ sơ nhân sự 360°.');
  }
});

hrmRouter.post('/employees', requirePermission('hrm', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const fullName = String(b.full_name || '').trim();
    if (!fullName) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Họ và tên nhân sự không được để trống.');
      return;
    }

    const id = crypto.randomUUID();
    const empCode = b.employee_code
      ? String(b.employee_code).trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_')
      : `NV-${id.slice(0, 6).toUpperCase()}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_hr_employees (
           id, tenant_id, user_id, employee_code, full_name, work_email, phone,
           gender, date_of_birth, nationality, id_card_number, address,
           branch_id, department_id, team_id, position_id, manager_user_id,
           employment_status, employment_type, join_date, resign_date,
           base_salary_vnd, insurance_salary_vnd, insurance_enrolled, social_insurance_number,
           is_resident, tax_code, dependents_count, union_member, allowances_json,
           bank_name, bank_account_number, bank_account_holder, bank_branch,
           annual_leave_quota, annual_leave_used, compensatory_leave_balance,
           digital_signature_data_url, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17,
           $18, $19, $20, $21,
           $22, $23, $24, $25,
           $26, $27, $28, $29, $30::jsonb,
           $31, $32, $33, $34,
           $35, $36, $37,
           $38, $39::jsonb
         )`,
        [
          id,
          ctx.tenantId,
          b.user_id || null,
          empCode,
          fullName,
          b.work_email ? String(b.work_email).trim() : null,
          b.phone ? String(b.phone).trim() : null,
          b.gender ? String(b.gender).trim() : null,
          b.date_of_birth || null,
          b.nationality ? String(b.nationality).trim() : 'Việt Nam',
          b.id_card_number ? String(b.id_card_number).trim() : null,
          b.address ? String(b.address).trim() : null,
          b.branch_id || null,
          b.department_id || null,
          b.team_id || null,
          b.position_id || null,
          b.manager_user_id || null,
          b.employment_status || 'active',
          b.employment_type || 'full_time',
          b.join_date || new Date().toISOString().slice(0, 10),
          b.resign_date || null,
          Math.max(0, toNum(b.base_salary_vnd, 0)),
          Math.max(0, toNum(b.insurance_salary_vnd, 0)),
          b.insurance_enrolled !== false,
          b.social_insurance_number ? String(b.social_insurance_number).trim() : null,
          b.is_resident !== false,
          b.tax_code ? String(b.tax_code).trim() : null,
          Math.max(0, Number(b.dependents_count || 0)),
          Boolean(b.union_member),
          JSON.stringify(b.allowances_json && typeof b.allowances_json === 'object' ? b.allowances_json : {}),
          b.bank_name ? String(b.bank_name).trim() : null,
          b.bank_account_number ? String(b.bank_account_number).trim() : null,
          b.bank_account_holder ? String(b.bank_account_holder).trim() : null,
          b.bank_branch ? String(b.bank_branch).trim() : null,
          Math.max(0, toNum(b.annual_leave_quota, 12)),
          Math.max(0, toNum(b.annual_leave_used, 0)),
          Math.max(0, toNum(b.compensatory_leave_balance, 0)),
          b.digital_signature_data_url || null,
          JSON.stringify(b.metadata && typeof b.metadata === 'object' ? b.metadata : {}),
        ]
      );

      if (b.user_id) {
        await client.query(
          `UPDATE users
           SET branch_id = COALESCE($3, branch_id),
               department_id = COALESCE($4, department_id),
               team_id = COALESCE($5, team_id),
               position_id = COALESCE($6, position_id),
               reports_to_user_id = COALESCE($7, reports_to_user_id)
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            b.user_id,
            b.branch_id || null,
            b.department_id || null,
            b.team_id || null,
            b.position_id || null,
            b.manager_user_id || null,
          ]
        );
      }

      const r = await client.query('SELECT * FROM tenant_hr_employees WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_EMPLOYEE_FAILED', err?.message || 'Không thể tạo hồ sơ nhân sự.');
  }
});

const updateEmployeeHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_hr_employees WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (curRes.rows.length === 0) return null;
      const cur = curRes.rows[0];

      const nextUserId = b.user_id !== undefined ? b.user_id || null : cur.user_id;
      const nextBranchId = b.branch_id !== undefined ? b.branch_id || null : cur.branch_id;
      const nextDeptId = b.department_id !== undefined ? b.department_id || null : cur.department_id;
      const nextTeamId = b.team_id !== undefined ? b.team_id || null : cur.team_id;
      const nextPosId = b.position_id !== undefined ? b.position_id || null : cur.position_id;
      const nextMgrId = b.manager_user_id !== undefined ? b.manager_user_id || null : cur.manager_user_id;

      await client.query(
        `UPDATE tenant_hr_employees
         SET user_id = $3,
             full_name = $4,
             work_email = $5,
             phone = $6,
             gender = $7,
             date_of_birth = $8,
             id_card_number = $9,
             address = $10,
             branch_id = $11,
             department_id = $12,
             team_id = $13,
             position_id = $14,
             manager_user_id = $15,
             employment_status = $16,
             employment_type = $17,
             join_date = $18,
             resign_date = $19,
             base_salary_vnd = $20,
             insurance_salary_vnd = $21,
             insurance_enrolled = $22,
             social_insurance_number = $23,
             is_resident = $24,
             tax_code = $25,
             dependents_count = $26,
             union_member = $27,
             allowances_json = $28::jsonb,
             bank_name = $29,
             bank_account_number = $30,
             bank_account_holder = $31,
             bank_branch = $32,
             annual_leave_quota = $33,
             annual_leave_used = $34,
             digital_signature_data_url = $35,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          id,
          nextUserId,
          b.full_name !== undefined ? String(b.full_name).trim() : cur.full_name,
          b.work_email !== undefined ? (b.work_email ? String(b.work_email).trim() : null) : cur.work_email,
          b.phone !== undefined ? (b.phone ? String(b.phone).trim() : null) : cur.phone,
          b.gender !== undefined ? (b.gender ? String(b.gender).trim() : null) : cur.gender,
          b.date_of_birth !== undefined ? b.date_of_birth || null : cur.date_of_birth,
          b.id_card_number !== undefined ? b.id_card_number || null : cur.id_card_number,
          b.address !== undefined ? b.address || null : cur.address,
          nextBranchId,
          nextDeptId,
          nextTeamId,
          nextPosId,
          nextMgrId,
          b.employment_status !== undefined ? String(b.employment_status) : cur.employment_status,
          b.employment_type !== undefined ? String(b.employment_type) : cur.employment_type,
          b.join_date !== undefined ? b.join_date || null : cur.join_date,
          b.resign_date !== undefined ? b.resign_date || null : cur.resign_date,
          b.base_salary_vnd !== undefined ? toNum(b.base_salary_vnd, 0) : toNum(cur.base_salary_vnd, 0),
          b.insurance_salary_vnd !== undefined ? toNum(b.insurance_salary_vnd, 0) : toNum(cur.insurance_salary_vnd, 0),
          b.insurance_enrolled !== undefined ? Boolean(b.insurance_enrolled) : toBool(cur.insurance_enrolled, true),
          b.social_insurance_number !== undefined ? b.social_insurance_number || null : cur.social_insurance_number,
          b.is_resident !== undefined ? Boolean(b.is_resident) : toBool(cur.is_resident, true),
          b.tax_code !== undefined ? b.tax_code || null : cur.tax_code,
          b.dependents_count !== undefined ? Number(b.dependents_count || 0) : Number(cur.dependents_count || 0),
          b.union_member !== undefined ? Boolean(b.union_member) : toBool(cur.union_member, false),
          b.allowances_json !== undefined
            ? JSON.stringify(b.allowances_json || {})
            : JSON.stringify(parseJsonSafe<Record<string, unknown>>(cur.allowances_json, {})),
          b.bank_name !== undefined ? b.bank_name || null : cur.bank_name,
          b.bank_account_number !== undefined ? b.bank_account_number || null : cur.bank_account_number,
          b.bank_account_holder !== undefined ? b.bank_account_holder || null : cur.bank_account_holder,
          b.bank_branch !== undefined ? b.bank_branch || null : cur.bank_branch,
          b.annual_leave_quota !== undefined ? toNum(b.annual_leave_quota, 12) : toNum(cur.annual_leave_quota, 12),
          b.annual_leave_used !== undefined ? toNum(b.annual_leave_used, 0) : toNum(cur.annual_leave_used, 0),
          b.digital_signature_data_url !== undefined
            ? b.digital_signature_data_url || null
            : cur.digital_signature_data_url,
        ]
      );

      if (nextUserId) {
        await client.query(
          `UPDATE users
           SET branch_id = $3, department_id = $4, team_id = $5, position_id = $6, reports_to_user_id = $7
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, nextUserId, nextBranchId, nextDeptId, nextTeamId, nextPosId, nextMgrId]
        );
      }

      const r = await client.query('SELECT * FROM tenant_hr_employees WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Không tìm thấy hồ sơ nhân sự.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_EMPLOYEE_FAILED', err?.message || 'Không thể cập nhật hồ sơ nhân sự.');
  }
};

hrmRouter.put('/employees/:id', requirePermission('hrm', 'edit'), updateEmployeeHandler);
hrmRouter.patch('/employees/:id', requirePermission('hrm', 'edit'), updateEmployeeHandler);

hrmRouter.post('/employees/:id/signature', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const sigUrl = req.body?.digital_signature_data_url ? String(req.body.digital_signature_data_url) : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const empRes = await client.query(
        'SELECT id, user_id FROM tenant_hr_employees WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (empRes.rows.length === 0) return null;
      const emp = empRes.rows[0];
      if (String(emp.user_id || '') !== ctx.userId) {
        const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
        if (!rbac.effectivePermissions.hrm?.actions.edit) {
          throw new Error('FORBIDDEN_SIGNATURE_EDIT');
        }
      }

      await client.query(
        `UPDATE tenant_hr_employees
         SET digital_signature_data_url = $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id, sigUrl]
      );
      const r = await client.query('SELECT * FROM tenant_hr_employees WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Không tìm thấy hồ sơ nhân sự.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_SIGNATURE_EDIT') {
      sendApiError(res, 403, 'FORBIDDEN_RBAC_PERMISSION', 'Không có quyền thay đổi chữ ký số của nhân sự khác.');
      return;
    }
    sendApiError(res, 500, 'SAVE_SIGNATURE_FAILED', err?.message || 'Không thể lưu chữ ký số.');
  }
});

hrmRouter.delete('/employees/:id', requirePermission('hrm', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_hr_employees WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_EMPLOYEE_FAILED', err?.message || 'Không thể xóa hồ sơ nhân sự.');
  }
});

// ============================================================================
// Labor Contracts Lifecycle Manager (`/contracts`)
// ============================================================================
hrmRouter.get('/contracts', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const empId = req.query.employee_id ? String(req.query.employee_id).trim() : null;

    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'c.tenant_id = $1';
      if (empId) {
        params.push(empId);
        where += ` AND c.employee_id = $${params.length}`;
      }
      const r = await client.query(
        `SELECT c.*, e.full_name AS employee_name, e.employee_code
         FROM tenant_hr_contracts c
         INNER JOIN tenant_hr_employees e ON e.tenant_id = c.tenant_id AND e.id = c.employee_id
         WHERE ${where}
         ORDER BY c.start_date DESC, c.created_at DESC`,
        params
      );
      return r.rows.map((x) => ({
        ...x,
        base_salary_vnd: toNum(x.base_salary_vnd, 0),
        insurance_salary_vnd: toNum(x.insurance_salary_vnd, 0),
        signed_by_employee: toBool(x.signed_by_employee, false),
        signed_by_employer: toBool(x.signed_by_employer, false),
      }));
    });

    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CONTRACTS_FAILED', err?.message || 'Không thể tải danh sách hợp đồng lao động.');
  }
});

hrmRouter.post('/contracts', requirePermission('hrm', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const employeeId = String(b.employee_id || '').trim();
    const startDate = String(b.start_date || '').slice(0, 10);
    if (!employeeId || !startDate) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng chọn nhân sự và ngày bắt đầu hợp đồng.');
      return;
    }

    const id = crypto.randomUUID();
    const contractNumber = b.contract_number
      ? String(b.contract_number).trim()
      : `HDLD-${new Date().getFullYear()}-${id.slice(0, 5).toUpperCase()}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_hr_contracts (
           id, tenant_id, employee_id, contract_number, contract_type, status,
           start_date, end_date, base_salary_vnd, insurance_salary_vnd,
           allowances_json, working_schedule_note, employer_signer_name, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)`,
        [
          id,
          ctx.tenantId,
          employeeId,
          contractNumber,
          b.contract_type || 'fixed_term',
          b.status || 'active',
          startDate,
          b.contract_type === 'indefinite' ? null : b.end_date || null,
          Math.max(0, toNum(b.base_salary_vnd, 0)),
          Math.max(0, toNum(b.insurance_salary_vnd, 0)),
          JSON.stringify(b.allowances_json && typeof b.allowances_json === 'object' ? b.allowances_json : {}),
          b.working_schedule_note ? String(b.working_schedule_note).trim() : null,
          b.employer_signer_name ? String(b.employer_signer_name).trim() : null,
          b.notes ? String(b.notes).trim() : null,
        ]
      );

      // Sync active contract base salary back to HR profile if > 0
      const newSal = toNum(b.base_salary_vnd, 0);
      if (newSal > 0 && (b.status || 'active') === 'active') {
        await client.query(
          `UPDATE tenant_hr_employees
           SET base_salary_vnd = $3,
               insurance_salary_vnd = CASE WHEN $4 > 0 THEN $4 ELSE insurance_salary_vnd END,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, employeeId, newSal, toNum(b.insurance_salary_vnd, 0)]
        );
      }

      const r = await client.query(
        `SELECT c.*, e.full_name AS employee_name
         FROM tenant_hr_contracts c
         LEFT JOIN tenant_hr_employees e ON e.tenant_id = c.tenant_id AND e.id = c.employee_id
         WHERE c.tenant_id = $1 AND c.id = $2`,
        [ctx.tenantId, id]
      );
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CONTRACT_FAILED', err?.message || 'Không thể tạo hợp đồng lao động.');
  }
});

hrmRouter.post('/contracts/:id/sign', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const sigUrl = req.body?.signature_data_url ? String(req.body.signature_data_url) : null;
    const roleSide = String(req.body?.party || 'employee');

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const check = await client.query(
        'SELECT * FROM tenant_hr_contracts WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (check.rows.length === 0) return null;

      if (roleSide === 'employer') {
        await client.query(
          `UPDATE tenant_hr_contracts
           SET signed_by_employer = true,
               employer_signer_name = COALESCE($3, employer_signer_name),
               signed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, id, ctx.userName]
        );
      } else {
        await client.query(
          `UPDATE tenant_hr_contracts
           SET signed_by_employee = true,
               employee_signature_url = COALESCE($3, employee_signature_url),
               signed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, id, sigUrl]
        );
      }
      const r = await client.query('SELECT * FROM tenant_hr_contracts WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng lao động.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'SIGN_CONTRACT_FAILED', err?.message || 'Không thể ký số hợp đồng.');
  }
});

hrmRouter.delete('/contracts/:id', requirePermission('hrm', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_hr_contracts WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_CONTRACT_FAILED', err?.message || 'Không thể xóa hợp đồng lao động.');
  }
});

// ============================================================================
// Asset Handover Checklist (`/assets`)
// ============================================================================
hrmRouter.get('/assets', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const empId = req.query.employee_id ? String(req.query.employee_id).trim() : null;
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'a.tenant_id = $1';
      if (empId) {
        params.push(empId);
        where += ` AND a.employee_id = $${params.length}`;
      }
      const r = await client.query(
        `SELECT a.*, e.full_name AS employee_name, e.employee_code
         FROM tenant_hr_handover_assets a
         INNER JOIN tenant_hr_employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
         WHERE ${where}
         ORDER BY a.handed_over_at DESC, a.created_at DESC`,
        params
      );
      return r.rows.map((x) => ({
        ...x,
        asset_value_vnd: toNum(x.asset_value_vnd, 0),
        acknowledged_by_employee: toBool(x.acknowledged_by_employee, false),
      }));
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ASSETS_FAILED', err?.message || 'Không thể tải danh sách tài sản bàn giao.');
  }
});

hrmRouter.post('/assets', requirePermission('hrm', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const employeeId = String(b.employee_id || '').trim();
    const assetName = String(b.asset_name || '').trim();
    if (!employeeId || !assetName) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng chọn nhân sự và tên tài sản bàn giao.');
      return;
    }

    const id = crypto.randomUUID();
    const assetCode = b.asset_code
      ? slugifyCode(b.asset_code, 'AST')
      : `AST-${id.slice(0, 6).toUpperCase()}`;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_hr_handover_assets (
           id, tenant_id, employee_id, asset_code, asset_name, category,
           serial_number, asset_value_vnd, condition_on_handover, status,
           handed_over_at, acknowledged_by_employee, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'assigned', $10, $11, $12)`,
        [
          id,
          ctx.tenantId,
          employeeId,
          assetCode,
          assetName,
          b.category ? String(b.category).trim() : 'laptop',
          b.serial_number ? String(b.serial_number).trim() : null,
          Math.max(0, toNum(b.asset_value_vnd, 0)),
          b.condition_on_handover ? String(b.condition_on_handover).trim() : 'Tốt / Mới',
          b.handed_over_at || new Date().toISOString().slice(0, 10),
          Boolean(b.acknowledged_by_employee),
          b.notes ? String(b.notes).trim() : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_hr_handover_assets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_ASSET_FAILED', err?.message || 'Không thể ghi nhận tài sản bàn giao.');
  }
});

hrmRouter.patch('/assets/:id', requirePermission('hrm', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_hr_handover_assets WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (curRes.rows.length === 0) return null;
      const cur = curRes.rows[0];
      const nextStatus = b.status ? String(b.status) : cur.status;
      const returnedAt =
        nextStatus === 'returned' && !cur.returned_at
          ? new Date().toISOString().slice(0, 10)
          : b.returned_at !== undefined
            ? b.returned_at
            : cur.returned_at;

      await client.query(
        `UPDATE tenant_hr_handover_assets
         SET status = $3,
             returned_at = $4,
             acknowledged_by_employee = $5,
             notes = $6,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          id,
          nextStatus,
          returnedAt || null,
          b.acknowledged_by_employee !== undefined
            ? Boolean(b.acknowledged_by_employee)
            : toBool(cur.acknowledged_by_employee, false),
          b.notes !== undefined ? b.notes : cur.notes,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_hr_handover_assets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'ASSET_NOT_FOUND', 'Không tìm thấy bản ghi tài sản.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ASSET_FAILED', err?.message || 'Không thể cập nhật trạng thái tài sản.');
  }
});

// ============================================================================
// Smart 1-on-1 Booking Manager (`/booking-links`, `/booking-appointments`)
// ============================================================================
hrmRouter.get('/booking-links', requirePermission('hrm', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT bl.*, u.full_name AS host_user_name,
                (SELECT COUNT(*)::int FROM tenant_booking_appointments ap
                 WHERE ap.tenant_id = bl.tenant_id AND ap.booking_link_id = bl.id AND ap.status = 'confirmed') AS confirmed_count
         FROM tenant_booking_links bl
         LEFT JOIN users u ON u.tenant_id = bl.tenant_id AND u.id = bl.host_user_id
         WHERE bl.tenant_id = $1
         ORDER BY bl.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows.map((x) => ({
        ...x,
        duration_minutes: Number(x.duration_minutes || 30),
        buffer_minutes: Number(x.buffer_minutes || 10),
        is_active: toBool(x.is_active, true),
        availability_rules: parseJsonSafe<AvailabilityRule[]>(
          x.availability_rules,
          DEFAULT_AVAILABILITY_RULES
        ),
        custom_questions: parseJsonSafe<any[]>(x.custom_questions, []),
      }));
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_BOOKING_LINKS_FAILED', err?.message || 'Không thể tải danh sách trang đặt lịch 1-1.');
  }
});

hrmRouter.post('/booking-links', requirePermission('hrm', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tiêu đề lịch hẹn 1-1 không được để trống.');
      return;
    }

    const id = crypto.randomUUID();
    const randomSuffix = crypto.randomBytes(3).toString('hex');
    const baseSlug = slugifyKeyLower(b.slug || `${ctx.tenantSlug}-${title}`).replace(/_/g, '-');
    const slug = b.slug ? baseSlug : `${baseSlug}-${randomSuffix}`;
    const publicToken = `bk_${crypto.randomBytes(12).toString('hex')}`;
    const rules =
      Array.isArray(b.availability_rules) && b.availability_rules.length > 0
        ? b.availability_rules
        : DEFAULT_AVAILABILITY_RULES;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_booking_links (
           id, tenant_id, host_user_id, host_employee_id, slug, public_token,
           title, subtitle, description, meeting_purpose, duration_minutes, buffer_minutes,
           timezone, location_type, location_value, availability_rules, custom_questions, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, true)`,
        [
          id,
          ctx.tenantId,
          b.host_user_id || ctx.userId,
          b.host_employee_id || null,
          slug,
          publicToken,
          title,
          b.subtitle ? String(b.subtitle).trim() : null,
          b.description ? String(b.description).trim() : null,
          b.meeting_purpose ? String(b.meeting_purpose).trim() : 'consultation',
          Math.max(15, Math.min(240, Number(b.duration_minutes || 30))),
          Math.max(0, Math.min(120, Number(b.buffer_minutes ?? 10))),
          b.timezone ? String(b.timezone).trim() : 'Asia/Ho_Chi_Minh',
          b.location_type ? String(b.location_type).trim() : 'video_link',
          b.location_value ? String(b.location_value).trim() : 'Google Meet / Zoom tự động',
          JSON.stringify(rules),
          JSON.stringify(Array.isArray(b.custom_questions) ? b.custom_questions : []),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_booking_links WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        availability_rules: parseJsonSafe<AvailabilityRule[]>(
          r.rows[0]?.availability_rules,
          DEFAULT_AVAILABILITY_RULES
        ),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_BOOKING_LINK_FAILED', err?.message || 'Không thể tạo liên kết đặt lịch 1-1.');
  }
});

hrmRouter.patch('/booking-links/:id', requirePermission('hrm', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query(
        'SELECT * FROM tenant_booking_links WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (curRes.rows.length === 0) return null;
      const cur = curRes.rows[0];

      await client.query(
        `UPDATE tenant_booking_links
         SET title = $3,
             duration_minutes = $4,
             buffer_minutes = $5,
             location_value = $6,
             availability_rules = $7::jsonb,
             is_active = $8,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          id,
          b.title !== undefined ? String(b.title).trim() : cur.title,
          b.duration_minutes !== undefined ? Number(b.duration_minutes) : Number(cur.duration_minutes),
          b.buffer_minutes !== undefined ? Number(b.buffer_minutes) : Number(cur.buffer_minutes),
          b.location_value !== undefined ? String(b.location_value) : cur.location_value,
          b.availability_rules !== undefined
            ? JSON.stringify(b.availability_rules)
            : JSON.stringify(parseJsonSafe<AvailabilityRule[]>(cur.availability_rules, DEFAULT_AVAILABILITY_RULES)),
          b.is_active !== undefined ? Boolean(b.is_active) : toBool(cur.is_active, true),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_booking_links WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'BOOKING_LINK_NOT_FOUND', 'Không tìm thấy trang đặt lịch.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_BOOKING_LINK_FAILED', err?.message || 'Không thể cập nhật trang đặt lịch.');
  }
});

hrmRouter.delete('/booking-links/:id', requirePermission('hrm', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_booking_links WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_BOOKING_LINK_FAILED', err?.message || 'Không thể xóa trang đặt lịch.');
  }
});

hrmRouter.get('/booking-appointments', requirePermission('hrm', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT ap.*, bl.title AS booking_link_title, bl.slug AS booking_link_slug, bl.location_value
         FROM tenant_booking_appointments ap
         INNER JOIN tenant_booking_links bl ON bl.tenant_id = ap.tenant_id AND bl.id = ap.booking_link_id
         WHERE ap.tenant_id = $1
         ORDER BY ap.booking_date DESC, ap.start_time ASC`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_APPOINTMENTS_FAILED', err?.message || 'Không thể tải danh sách lịch hẹn đã đặt.');
  }
});

hrmRouter.patch('/booking-appointments/:id', requirePermission('hrm', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const status = String(req.body?.status || 'confirmed');
    const cancelReason = req.body?.cancel_reason ? String(req.body.cancel_reason) : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE tenant_booking_appointments
         SET status = $3, cancel_reason = $4, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, id, status, cancelReason]
      );
      const r = await client.query(
        'SELECT * FROM tenant_booking_appointments WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'APPOINTMENT_NOT_FOUND', 'Không tìm thấy lịch hẹn.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_APPOINTMENT_FAILED', err?.message || 'Không thể cập nhật lịch hẹn.');
  }
});
