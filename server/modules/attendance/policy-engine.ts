import type { Request } from 'express';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { computeHaversineMeters, parseJsonSafe, toBool, toNum } from '../hrm/schema.ts';

export type GeofenceMode = 'flexible' | 'warn_with_explanation' | 'strict_radius';

export interface AttendancePolicyConfig {
  id: string | null;
  geofence_mode: GeofenceMode;
  require_gps: boolean;
  require_selfie: boolean;
  max_gps_accuracy_meters: number;
  grace_late_minutes: number;
  grace_early_minutes: number;
  allow_any_branch_checkin: boolean;
  allow_remote_with_approved_leave: boolean;
  allow_ip_whitelist_bypass: boolean;
  require_checkout: boolean;
  enable_night_shift: boolean;
  enable_weekend_shift: boolean;
  holiday_schedules_json: Array<{ date: string; name: string; paid?: boolean }>;
}

export interface EffectiveExemptionSummary {
  exempt_checkin: boolean;
  exempt_gps: boolean;
  exempt_selfie: boolean;
  exclude_from_absent_report: boolean;
  custom_grace_late_minutes: number | null;
  matched_rule_ids: string[];
  matched_rule_names: string[];
}

export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicyConfig = {
  id: null,
  geofence_mode: 'flexible',
  require_gps: false,
  require_selfie: false,
  max_gps_accuracy_meters: 150,
  grace_late_minutes: 15,
  grace_early_minutes: 15,
  allow_any_branch_checkin: false,
  allow_remote_with_approved_leave: true,
  allow_ip_whitelist_bypass: true,
  require_checkout: true,
  enable_night_shift: true,
  enable_weekend_shift: true,
  holiday_schedules_json: [],
};

export function normalizeGeofenceMode(val: unknown): GeofenceMode {
  const s = String(val || 'flexible').trim().toLowerCase();
  if (s === 'strict_radius' || s === 'warn_with_explanation' || s === 'flexible') {
    return s;
  }
  return 'flexible';
}

export function normalizeAttendancePolicy(row: any): AttendancePolicyConfig {
  if (!row) return { ...DEFAULT_ATTENDANCE_POLICY };
  return {
    id: row.id ? String(row.id) : null,
    geofence_mode: normalizeGeofenceMode(row.geofence_mode),
    require_gps: toBool(row.require_gps, false),
    require_selfie: toBool(row.require_selfie, false),
    max_gps_accuracy_meters: Math.max(10, Math.min(50_000, Number(row.max_gps_accuracy_meters ?? 150))),
    grace_late_minutes: Math.max(0, Math.min(240, Number(row.grace_late_minutes ?? 15))),
    grace_early_minutes: Math.max(0, Math.min(240, Number(row.grace_early_minutes ?? 15))),
    allow_any_branch_checkin: toBool(row.allow_any_branch_checkin, false),
    allow_remote_with_approved_leave: toBool(row.allow_remote_with_approved_leave, true),
    allow_ip_whitelist_bypass: toBool(row.allow_ip_whitelist_bypass, true),
    require_checkout: toBool(row.require_checkout, true),
    enable_night_shift: toBool(row.enable_night_shift, true),
    enable_weekend_shift: toBool(row.enable_weekend_shift, true),
    holiday_schedules_json: parseJsonSafe<Array<{ date: string; name: string; paid?: boolean }>>(
      row.holiday_schedules_json,
      []
    ),
  };
}

export async function getAttendancePolicyInTx(
  client: DbClient,
  tenantId: string
): Promise<AttendancePolicyConfig> {
  const res = await client.query(
    'SELECT * FROM tenant_attendance_policies WHERE tenant_id = $1 LIMIT 1',
    [tenantId]
  );
  return normalizeAttendancePolicy(res.rows[0] || null);
}

export function normalizeIpString(raw: unknown): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (s.includes(',')) {
    s = s.split(',')[0].trim();
  }
  if (s.startsWith('::ffff:')) {
    s = s.slice(7);
  }
  // Strip port if IPv4:port
  const ipv4PortMatch = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4PortMatch) {
    s = ipv4PortMatch[1];
  }
  return s;
}

export function getClientIpFromRequest(req: Request): string {
  const xff = req.header('x-forwarded-for');
  if (xff) {
    const parsed = normalizeIpString(xff);
    if (parsed) return parsed;
  }
  const xReal = req.header('x-real-ip');
  if (xReal) {
    const parsed = normalizeIpString(xReal);
    if (parsed) return parsed;
  }
  return normalizeIpString(req.ip || req.socket?.remoteAddress || '');
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    num = ((num << 8) | n) >>> 0;
  }
  return num >>> 0;
}

export function isIpMatchingWhitelist(clientIp: string, whitelist: string[]): boolean {
  const cleanClient = normalizeIpString(clientIp);
  if (!cleanClient || !Array.isArray(whitelist) || whitelist.length === 0) {
    return false;
  }
  const clientV4 = ipv4ToUint32(cleanClient);

  for (const entryRaw of whitelist) {
    const entry = normalizeIpString(entryRaw);
    if (!entry) continue;
    if (entry === cleanClient) {
      return true;
    }
    if (entry.includes('/')) {
      const [netStr, prefixStr] = entry.split('/');
      const prefix = Number(prefixStr);
      const netV4 = ipv4ToUint32(netStr);
      if (clientV4 !== null && netV4 !== null && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        if ((clientV4 & mask) === (netV4 & mask)) {
          return true;
        }
      }
    }
  }
  return false;
}

export async function resolveEffectiveExemptionForUser(
  client: DbClient,
  tenantId: string,
  userInfo: {
    userId: string;
    role?: string | null;
    roleId?: string | null;
    departmentId?: string | null;
    teamId?: string | null;
    positionId?: string | null;
  },
  workDate: string
): Promise<EffectiveExemptionSummary> {
  const [rulesRes, deptsRes] = await Promise.all([
    client.query(
      'SELECT * FROM tenant_attendance_exemption_rules WHERE tenant_id = $1 AND is_active = true',
      [tenantId]
    ),
    userInfo.departmentId
      ? client.query<{ id: string; parent_department_id: string | null }>(
          'SELECT id, parent_department_id FROM tenant_departments WHERE tenant_id = $1',
          [tenantId]
        )
      : Promise.resolve({ rows: [] as Array<{ id: string; parent_department_id: string | null }> }),
  ]);

  const ancestorDeptIds = new Set<string>();
  if (userInfo.departmentId) {
    const parentMap = new Map(deptsRes.rows.map((d) => [String(d.id), d.parent_department_id ? String(d.parent_department_id) : null]));
    let cursor: string | null = String(userInfo.departmentId);
    let guard = 0;
    while (cursor && !ancestorDeptIds.has(cursor) && guard < 30) {
      ancestorDeptIds.add(cursor);
      cursor = parentMap.get(cursor) || null;
      guard++;
    }
  }

  const out: EffectiveExemptionSummary = {
    exempt_checkin: false,
    exempt_gps: false,
    exempt_selfie: false,
    exclude_from_absent_report: false,
    custom_grace_late_minutes: null,
    matched_rule_ids: [],
    matched_rule_names: [],
  };

  for (const rule of rulesRes.rows) {
    const effFrom = rule.effective_from ? String(rule.effective_from).slice(0, 10) : null;
    const effTo = rule.effective_to ? String(rule.effective_to).slice(0, 10) : null;
    if (effFrom && workDate < effFrom) continue;
    if (effTo && workDate > effTo) continue;

    const scopeType = String(rule.scope_type || '').trim().toLowerCase();
    const targetId = String(rule.target_id || '').trim();
    if (!targetId) continue;

    let matches = false;
    if (scopeType === 'user') {
      matches = targetId === userInfo.userId;
    } else if (scopeType === 'position') {
      matches = Boolean(userInfo.positionId && targetId === String(userInfo.positionId));
    } else if (scopeType === 'team') {
      matches = Boolean(userInfo.teamId && targetId === String(userInfo.teamId));
    } else if (scopeType === 'department') {
      matches = ancestorDeptIds.has(targetId);
    } else if (scopeType === 'role') {
      matches = Boolean(
        (userInfo.roleId && targetId === String(userInfo.roleId)) ||
          (userInfo.role && targetId.toLowerCase() === String(userInfo.role).toLowerCase())
      );
    }

    if (!matches) continue;

    out.matched_rule_ids.push(String(rule.id));
    out.matched_rule_names.push(String(rule.name || 'Exemption Rule'));
    if (toBool(rule.exempt_checkin, false)) out.exempt_checkin = true;
    if (toBool(rule.exempt_gps, false)) out.exempt_gps = true;
    if (toBool(rule.exempt_selfie, false)) out.exempt_selfie = true;
    if (toBool(rule.exclude_from_absent_report, false)) out.exclude_from_absent_report = true;
    if (rule.custom_grace_late_minutes !== null && rule.custom_grace_late_minutes !== undefined) {
      const n = Number(rule.custom_grace_late_minutes);
      if (Number.isFinite(n) && n >= 0) {
        out.custom_grace_late_minutes =
          out.custom_grace_late_minutes === null ? n : Math.max(out.custom_grace_late_minutes, n);
      }
    }
  }

  return out;
}

function toVnDateStr(d: Date): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function hasActiveApprovedRemoteLeave(
  client: DbClient,
  tenantId: string,
  userId: string,
  workDate: string
): Promise<boolean> {
  const res = await client.query<{
    id: string;
    category: string;
    title: string;
    start_date: string | Date | null;
    end_date: string | Date | null;
    form_data: unknown;
  }>(
     `SELECT id, category, title, start_date, end_date, form_data
     FROM tenant_approval_requests
     WHERE tenant_id = $1
       AND requester_user_id = $2
       AND status = 'approved'
       AND category IN ('leave', 'remote_work', 'business_trip', 'custom_form', 'attendance_explanation')
     ORDER BY completed_at DESC, created_at DESC
     LIMIT 30`,
    [tenantId, userId]
  );

  for (const row of res.rows) {
    const fd = parseJsonSafe<Record<string, any>>(row.form_data, {});
    const startStr = row.start_date
      ? toVnDateStr(new Date(row.start_date))
      : fd.start_date || fd.work_date
        ? String(fd.start_date || fd.work_date).slice(0, 10)
        : null;
    const endStr = row.end_date
      ? toVnDateStr(new Date(row.end_date))
      : fd.end_date || fd.work_date
        ? String(fd.end_date || fd.work_date).slice(0, 10)
        : startStr;

    if (startStr && workDate < startStr) continue;
    if (endStr && workDate > endStr) continue;
    if (!startStr && !endStr) continue;

    const cat = String(row.category || '').toLowerCase();
    const leaveMode = String(fd.leave_mode || fd.work_mode || fd.explanation_type || '').toLowerCase();
    if (
      cat === 'remote_work' ||
      cat === 'business_trip' ||
      fd.is_remote === true ||
      fd.allow_remote === true ||
      leaveMode === 'remote' ||
      leaveMode === 'wfh' ||
      leaveMode === 'business_trip' ||
      leaveMode === 'remote_checkin'
    ) {
      return true;
    }
  }
  return false;
}

export interface GeofenceEvaluationResult {
  distanceMeters: number | null;
  withinGeofence: boolean;
  geofenceMode: GeofenceMode;
  verificationMethod: string;
  ipWhitelisted: boolean;
  exemptionApplied: boolean;
  remoteBypass: boolean;
}

export function evaluateGeofenceAgainstPolicy(params: {
  policy: AttendancePolicyConfig;
  exemption: EffectiveExemptionSummary;
  approvedRemoteLeave: boolean;
  branch: {
    id: string;
    gps_lat: number | null;
    gps_lng: number | null;
    gps_radius_meters: number;
    branch_ip_whitelist?: string[];
  } | null;
  clientIp: string;
  lat: number | null;
  lng: number | null;
  accuracyMeters: number | null;
  hasSelfie: boolean;
  isCheckOut?: boolean;
  note?: string | null;
}): GeofenceEvaluationResult {
  const {
    policy,
    exemption,
    approvedRemoteLeave,
    branch,
    clientIp,
    lat,
    lng,
    accuracyMeters,
    hasSelfie,
    isCheckOut,
    note,
  } = params;

  const whitelist = Array.isArray(branch?.branch_ip_whitelist) ? branch!.branch_ip_whitelist! : [];
  const ipWhitelisted = Boolean(
    policy.allow_ip_whitelist_bypass && clientIp && isIpMatchingWhitelist(clientIp, whitelist)
  );
  const exemptionApplied = Boolean(exemption.exempt_gps || exemption.exempt_checkin);
  const remoteBypass = Boolean(policy.allow_remote_with_approved_leave && approvedRemoteLeave);
  const hasBypass = exemptionApplied || remoteBypass || ipWhitelisted;

  const hasValidClientCoords =
    lat !== null &&
    lng !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  const hasBranchCoords =
    Boolean(branch) &&
    branch!.gps_lat !== null &&
    branch!.gps_lng !== null &&
    Number.isFinite(branch!.gps_lat) &&
    Number.isFinite(branch!.gps_lng);

  let distanceMeters: number | null = null;
  let withinRadius = false;
  if (hasValidClientCoords && hasBranchCoords) {
    distanceMeters = computeHaversineMeters(lat!, lng!, branch!.gps_lat!, branch!.gps_lng!);
    withinRadius = distanceMeters <= Math.max(10, toNum(branch!.gps_radius_meters, 150));
  }

  const accuracyOk =
    accuracyMeters !== null &&
    Number.isFinite(accuracyMeters) &&
    accuracyMeters >= 0 &&
    accuracyMeters <= policy.max_gps_accuracy_meters;

  if (!isCheckOut && policy.require_selfie && !exemption.exempt_selfie && !hasSelfie) {
    throw new Error('SELFIE_REQUIRED');
  }

  const verificationMethod = ipWhitelisted
    ? 'ip_whitelist'
    : exemptionApplied
      ? 'exempt_gps'
      : remoteBypass
        ? 'remote_approved'
        : policy.geofence_mode;

  if (policy.geofence_mode === 'strict_radius') {
    if (!hasBypass) {
      if (!hasValidClientCoords || !accuracyOk || !hasBranchCoords || !withinRadius) {
        throw new Error('OUT_OF_GEOFENCE_STRICT_BLOCK');
      }
      return {
        distanceMeters,
        withinGeofence: true,
        geofenceMode: 'strict_radius',
        verificationMethod: 'strict_gps',
        ipWhitelisted,
        exemptionApplied,
        remoteBypass,
      };
    }
    return {
      distanceMeters,
      withinGeofence: true,
      geofenceMode: 'strict_radius',
      verificationMethod,
      ipWhitelisted,
      exemptionApplied,
      remoteBypass,
    };
  }

  if (policy.geofence_mode === 'warn_with_explanation') {
    if (hasBypass) {
      return {
        distanceMeters,
        withinGeofence: true,
        geofenceMode: 'warn_with_explanation',
        verificationMethod,
        ipWhitelisted,
        exemptionApplied,
        remoteBypass,
      };
    }
    const gpsOk = hasValidClientCoords && (!hasBranchCoords || withinRadius) && (accuracyMeters === null || accuracyOk);
    if (!gpsOk && !String(note || '').trim()) {
      throw new Error('EXPLANATION_REQUIRED');
    }
    return {
      distanceMeters,
      withinGeofence: gpsOk,
      geofenceMode: 'warn_with_explanation',
      verificationMethod: gpsOk ? 'gps_verified' : 'warn_with_explanation',
      ipWhitelisted,
      exemptionApplied,
      remoteBypass,
    };
  }

  // Default: 'flexible' ("mặc định thoải mái") — NEVER blocks check-in or check-out while recording telemetry accurately
  const telemetryWithin =
    hasBypass ||
    (hasValidClientCoords && hasBranchCoords ? withinRadius : !hasBranchCoords);

  return {
    distanceMeters,
    withinGeofence: telemetryWithin,
    geofenceMode: 'flexible',
    verificationMethod: hasBypass ? verificationMethod : hasValidClientCoords ? 'flexible_gps' : 'flexible',
    ipWhitelisted,
    exemptionApplied,
    remoteBypass,
  };
}
