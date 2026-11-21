import { resolveDateBounds, bindDateParams, isValidIsoDateString } from '../workspace.routes.ts';
import type { TenantContext } from '../../core/context/tenant-context.ts';
import type { TenantSettings } from '../../core/settings/tenant-settings.ts';
import { maskEmailString, maskPhoneString, shouldMaskPiiForActor } from '../../core/security/pii-masker.ts';

export interface ParsedLegacyDateRange {
  preset: string;
  startDate?: string | null;
  endDate?: string | null;
  sinceIso?: string | null;
  untilIso?: string | null;
  isSingleDay: boolean;
  label: string;
  bindSql: (col: string, params: unknown[]) => string;
  bindPrevSql: (col: string, params: unknown[]) => string | null;
}

export function normalizeLegacyDatePreset(
  raw?: string | null,
  since?: string | null,
  until?: string | null
): {
  preset: string;
  startDate?: string | null;
  endDate?: string | null;
  isSingleDay: boolean;
} {
  const cleanSince = since ? String(since).trim() : '';
  const cleanUntil = until ? String(until).trim() : '';
  if (isValidIsoDateString(cleanSince) && isValidIsoDateString(cleanUntil)) {
    const [sIso, eIso] = cleanSince <= cleanUntil ? [cleanSince, cleanUntil] : [cleanUntil, cleanSince];
    return {
      preset: 'custom',
      startDate: sIso,
      endDate: eIso,
      isSingleDay: sIso === eIso,
    };
  }

  const trimmed = String(raw || 'Tháng này').trim();
  const lower = trimmed.toLowerCase();

  if (lower.includes('đến') || lower.includes(' - ') || lower.includes(' ~ ') || lower.includes('..')) {
    const parts = trimmed.split(/\s*(?:đến| - | ~ |\.\.)\s*/i).map((s) => s.trim());
    if (parts.length === 2 && isValidIsoDateString(parts[0]) && isValidIsoDateString(parts[1])) {
      const [sIso, eIso] = parts[0] <= parts[1] ? [parts[0], parts[1]] : [parts[1], parts[0]];
      return {
        preset: 'custom',
        startDate: sIso,
        endDate: eIso,
        isSingleDay: sIso === eIso,
      };
    }
  }

  const map: Record<string, { p: string; single: boolean }> = {
    'hôm nay': { p: 'today', single: true },
    today: { p: 'today', single: true },
    'hôm qua': { p: 'yesterday', single: true },
    yesterday: { p: 'yesterday', single: true },
    'hôm qua - hôm nay': { p: 'yesterday_to_today', single: false },
    'hôm qua – hôm nay': { p: 'yesterday_to_today', single: false },
    'yesterday - today': { p: 'yesterday_to_today', single: false },
    yesterday_to_today: { p: 'yesterday_to_today', single: false },
    'tuần này': { p: 'this_week', single: false },
    this_week: { p: 'this_week', single: false },
    'tuần trước': { p: 'last_week', single: false },
    last_week: { p: 'last_week', single: false },
    'tuần trước nữa': { p: '7_days', single: false },
    '7 ngày qua': { p: '7_days', single: false },
    '7 ngày gần nhất': { p: '7_days', single: false },
    'last 7 days': { p: '7_days', single: false },
    last_7days: { p: '7_days', single: false },
    last_7_days: { p: '7_days', single: false },
    '7_days': { p: '7_days', single: false },
    '7days': { p: '7_days', single: false },
    '30 ngày qua': { p: '30_days', single: false },
    '30 ngày gần nhất': { p: '30_days', single: false },
    'last 30 days': { p: '30_days', single: false },
    last_30days: { p: '30_days', single: false },
    last_30_days: { p: '30_days', single: false },
    '30_days': { p: '30_days', single: false },
    '30days': { p: '30_days', single: false },
    'tháng này': { p: 'this_month', single: false },
    this_month: { p: 'this_month', single: false },
    'tháng trước': { p: 'last_month', single: false },
    last_month: { p: 'last_month', single: false },
    'tất cả': { p: 'all', single: false },
    'tất cả thời gian': { p: 'all', single: false },
    'toàn bộ lịch sử': { p: 'all', single: false },
    all: { p: 'all', single: false },
  };

  const hit = map[lower] || { p: 'this_month', single: false };
  return {
    preset: hit.p,
    startDate: null,
    endDate: null,
    isSingleDay: hit.single,
  };
}

function shiftIsoDate(iso: string, deltaDays: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

export function buildLegacyDateFilter(
  raw?: string | null,
  opts?: { since?: string | null; until?: string | null; nowRef?: Date }
): ParsedLegacyDateRange {
  const { preset, startDate, endDate, isSingleDay } = normalizeLegacyDatePreset(raw, opts?.since, opts?.until);
  const resolved = resolveDateBounds(preset, startDate, endDate, opts?.nowRef);

  const prevPresetMap: Record<string, string | null> = {
    today: 'yesterday',
    this_week: 'last_week',
    this_month: 'last_month',
    all: null,
  };
  let prevResolved: { clause: string; params: unknown[] } | null = null;
  if (preset in prevPresetMap) {
    const pp = prevPresetMap[preset];
    prevResolved = pp ? resolveDateBounds(pp, null, null, opts?.nowRef) : null;
  } else if (resolved.sinceIso && resolved.untilIso) {
    const startMs = Date.parse(`${resolved.sinceIso}T00:00:00Z`);
    const endMs = Date.parse(`${resolved.untilIso}T00:00:00Z`);
    const spanDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
    const prevUntil = shiftIsoDate(resolved.sinceIso, -1);
    const prevSince = shiftIsoDate(prevUntil, -(spanDays - 1));
    prevResolved = resolveDateBounds('custom', prevSince, prevUntil, opts?.nowRef);
  }

  return {
    preset,
    startDate: startDate ?? resolved.sinceIso ?? null,
    endDate: endDate ?? resolved.untilIso ?? null,
    sinceIso: resolved.sinceIso ?? null,
    untilIso: resolved.untilIso ?? null,
    isSingleDay,
    label:
      opts?.since && opts?.until && isValidIsoDateString(opts.since) && isValidIsoDateString(opts.until)
        ? `${resolved.sinceIso} - ${resolved.untilIso}`
        : String(raw || 'Tháng này'),
    bindSql: (col: string, params: unknown[]) =>
      bindDateParams(resolved.clause, params, resolved).replace(/\bcreated_at\b/g, col),
    bindPrevSql: (col: string, params: unknown[]) => {
      if (!prevResolved) return null;
      return bindDateParams(prevResolved.clause, params, prevResolved).replace(/\bcreated_at\b/g, col);
    },
  };
}

export function buildLegacyDateFilterFromParams(
  params: URLSearchParams,
  fallbackDate = 'Tháng này',
  dateParamKey = 'date'
): ParsedLegacyDateRange {
  const since = params.get('since') || params.get('start_date');
  const until = params.get('until') || params.get('end_date');
  const rawDate = params.get(dateParamKey) || params.get('date') || fallbackDate;
  return buildLegacyDateFilter(rawDate, { since, until });
}

export function formatPctDelta(curr: number, prev: number): string {
  if (prev === 0) return curr > 0 ? '+100%' : '+0%';
  const pct = Math.round(((curr - prev) / prev) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

export function formatDateTimeVnSql(isoOrDate?: string | Date | null): string {
  if (!isoOrDate) return '';
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  const shifted = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ${p(
    shifted.getUTCHours()
  )}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
}

export function mapPgRoleToLegacy(role?: string | null): 'superadmin' | 'admin' | 'assistant' | 'viewer' | 'sale' {
  if (role === 'tenant_admin' || role === 'superadmin') return 'superadmin';
  if (role === 'manager' || role === 'admin') return 'admin';
  if (role === 'assistant' || role === 'viewer') return role;
  return 'sale';
}

export function mapPgLeadStatusToLegacy(row: {
  status?: string | null;
  is_duplicate_reminder?: boolean | null;
  is_duplicated?: boolean | null;
  custom_fields?: Record<string, any> | null;
}): string {
  const st = String(row.status || 'assigned');
  const orig = String(row.custom_fields?.original_status || '').toLowerCase();
  if (st === 'archived' || orig === 'silent') return 'silent';
  if (st === 'blacklisted') return 'blacklisted';
  if (st === 'pending_approval') return 'pending_approval';
  if (st === 'rejected') return 'rejected';
  if (row.is_duplicate_reminder || row.is_duplicated || orig === 'duplicate') return 'duplicate';
  if (st === 'unassigned_pending') return orig === 'pending_work_hours' ? 'pending_work_hours' : 'pending';
  if (orig === 'compensation' || orig === 'compensated' || row.custom_fields?.is_compensated === true) {
    return 'compensation';
  }
  return 'assigned';
}

export function mapPgLeadRowToLegacy(
  row: Record<string, any>,
  ctx: TenantContext,
  cfg: TenantSettings
): Record<string, any> {
  const cf: Record<string, any> =
    row.custom_fields && typeof row.custom_fields === 'object' ? row.custom_fields : {};
  const masked = shouldMaskPiiForActor(ctx, cfg, { is_accepted: Boolean(row.is_accepted) });
  const phone = masked ? maskPhoneString(row.phone || '', cfg) : row.phone || '';
  const email =
    masked && cfg.pii_mask_email && row.email ? maskEmailString(row.email, cfg) : row.email || '';

  const legacyStatus = mapPgLeadStatusToLegacy({
    status: row.status,
    is_duplicate_reminder: row.is_duplicate_reminder,
    is_duplicated: row.is_duplicated,
    custom_fields: cf,
  });

  // Deduplicate redundant ad & campaign metadata from custom_fields to minimize payload overhead
  const prunedCf: Record<string, any> = { ...cf };
  const redundantAdKeys = [
    'ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name',
    'ad_platform', 'ad_thumbnail_url', 'ad_image_url', 'ad_creative_title', 'ad_creative_body', 'ad_story_id'
  ];
  for (const k of redundantAdKeys) {
    if (k in prunedCf) {
      delete prunedCf[k];
    }
  }

  const baseId = row.id;
  return {
    id: baseId,
    lead_id: baseId,
    lead_name: row.name || row.lead_name || 'Khách hàng',
    name: row.name || row.lead_name || 'Khách hàng',
    phone,
    email,
    source: row.source || 'Webhook',
    type: cf.type || row.round_name || row.source || 'Manual',
    note: cf.note || row.quality_note || '',
    status: legacyStatus,
    raw_status: row.status,
    is_accepted: Boolean(row.is_accepted),
    sla_breached: Boolean(row.sla_breached),
    assigned_to_id: row.assigned_to || null,
    assigned_to_name: pickCleanName(row.assigned_to_name, row.assigned_sale_name, cf.assigned_to_name, cf.assigned_sale_name, cf.consultant_name, cf.sale_name) || '-',
    assigned_to_avatar: row.assigned_to_avatar || null,
    round_id: row.round_id || null,
    round_name: pickCleanName(row.round_name, cf.round_name) || '',
    stage_id: row.stage_id || null,
    stage_name: row.stage_name || null,
    created_at: formatDateTimeVnSql(row.created_at),
    report_status: row.report_status || null,
    last_activity_at: formatDateTimeVnSql(row.updated_at || row.created_at),
    ai_screener_status: row.ai_screener_status || 'not_screened',
    ai_evaluation: row.ai_evaluation || null,
    quality_status: row.quality_status || 'Pending',
    quality_note: row.quality_note || null,
    quality_updated_at: row.quality_updated_at ? formatDateTimeVnSql(row.quality_updated_at) : null,
    ad_id: row.ad_id || cf.ad_id || null,
    ad_name: row.ad_name || cf.ad_name || null,
    adset_id: row.adset_id || cf.adset_id || null,
    adset_name: row.adset_name || cf.adset_name || null,
    campaign_id: row.campaign_id || cf.campaign_id || null,
    campaign_name: row.campaign_name || row.campaign || cf.campaign_name || null,
    ad_platform: cf.ad_platform || (row.fbclid || row.ad_id ? 'facebook' : 'web'),
    ad_thumbnail_url: row.ad_thumbnail_url || cf.ad_thumbnail_url || null,
    ad_image_url: row.ad_image_url || cf.ad_image_url || null,
    ad_creative_title: row.ad_creative_title || cf.ad_creative_title || null,
    ad_creative_body: row.ad_creative_body || cf.ad_creative_body || null,
    ad_story_id: row.ad_story_id || cf.ad_story_id || null,
    custom_fields: prunedCf,
  };
}

export const DOMATION_PALETTE = [
  '#1E40FF',
  '#0284C7',
  '#06B6D4',
  '#3B82F6',
  '#6366F1',
  '#10B981',
  '#8B5CF6',
  '#F59E0B',
];

export function cleanQueryAction(rawAction: unknown): { action: string; inlineParams: URLSearchParams } {
  const s = String(rawAction || '').trim();
  const ampIdx = s.indexOf('&');
  if (ampIdx === -1) {
    return { action: s, inlineParams: new URLSearchParams() };
  }
  return {
    action: s.slice(0, ampIdx),
    inlineParams: new URLSearchParams(s.slice(ampIdx + 1)),
  };
}

/** Returns the first non-empty display name that is not a placeholder (`-`, `—`, `N/A`). */
export function pickCleanName(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (!s || s === '-' || s === '—' || s === '--' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'null') continue;
    return s;
  }
  return '';
}

const LEGACY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `assigned_to_name` / `assigned_to_avatar` / `round_name` for raw lead rows whose SQL joins
 * came back empty (orphaned round_id, round never stamped on the lead, renamed user, imported leads that only
 * carry names inside `custom_fields`). Batch-loads in at most 3 tenant-scoped queries:
 *   1. users by `assigned_to` (+ the user's avatar),
 *   2. rounds by `round_id` / `custom_fields.round_id|preferred_round_id`,
 *   3. the assignee's primary distribution round (`round_consultants`, active first, by round priority).
 * Mutates and returns the same rows so callers can keep passing them to `mapPgLeadRowToLegacy`.
 */
import type { DbClient } from '../../core/database/db-adapter.ts';

export async function enrichLeadAssigneeAndRound<T extends Record<string, any>>(
  client: DbClient,
  tenantId: string,
  rows: T[]
): Promise<T[]> {
  if (!rows.length) return rows;
  const cfOf = (r: Record<string, any>): Record<string, any> =>
    r.custom_fields && typeof r.custom_fields === 'object' ? r.custom_fields : {};

  const needUser = new Set<string>();
  const needRoundById = new Set<string>();
  const needRoundByUser = new Set<string>();

  for (const r of rows) {
    const cf = cfOf(r);
    const assignee = LEGACY_UUID_RE.test(String(r.assigned_to || '')) ? String(r.assigned_to) : '';
    if (assignee && (!pickCleanName(r.assigned_to_name) || !r.assigned_to_avatar)) needUser.add(assignee);
    if (!pickCleanName(r.round_name)) {
      const rid = [r.round_id, cf.round_id, cf.preferred_round_id].map((v) => String(v || '')).find((v) => LEGACY_UUID_RE.test(v));
      if (rid) needRoundById.add(rid);
      if (assignee) needRoundByUser.add(assignee);
    }
  }

  const ph = (arr: string[], offset = 2) => arr.map((_, i) => `$${i + offset}`).join(', ');
  const userMap = new Map<string, { full_name: string; email: string; avatar_url: string | null }>();
  const roundMap = new Map<string, string>();
  const userRoundMap = new Map<string, string>();

  try {
    if (needUser.size) {
      const ids = [...needUser];
      const res = await client.query<{ id: string; full_name: string; email: string; avatar_url: string | null }>(
        `SELECT id, full_name, email, avatar_url FROM users WHERE tenant_id = $1 AND id IN (${ph(ids)})`,
        [tenantId, ...ids]
      );
      for (const u of res.rows) userMap.set(String(u.id), u);
    }
    if (needRoundById.size) {
      const ids = [...needRoundById];
      const res = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM distribution_rounds WHERE tenant_id = $1 AND id IN (${ph(ids)})`,
        [tenantId, ...ids]
      );
      for (const rr of res.rows) roundMap.set(String(rr.id), String(rr.name || ''));
    }
    if (needRoundByUser.size) {
      const ids = [...needRoundByUser];
      const res = await client.query<{ user_id: string; name: string }>(
        `SELECT rc.user_id, dr.name
         FROM round_consultants rc
         INNER JOIN distribution_rounds dr ON dr.tenant_id = rc.tenant_id AND dr.id = rc.round_id
         WHERE rc.tenant_id = $1 AND rc.user_id IN (${ph(ids)})
         ORDER BY rc.is_active DESC, dr.is_active DESC, dr.priority ASC, dr.created_at ASC`,
        [tenantId, ...ids]
      );
      for (const rr of res.rows) {
        const key = String(rr.user_id);
        if (!userRoundMap.has(key) && pickCleanName(rr.name)) userRoundMap.set(key, String(rr.name));
      }
    }
  } catch {
    // Enrichment is best-effort telemetry polish; never fail the parent request.
  }

  for (const r of rows as Array<Record<string, any>>) {
    const cf = cfOf(r);
    const assignee = String(r.assigned_to || '');
    const u = userMap.get(assignee);
    r.assigned_to_name =
      pickCleanName(r.assigned_to_name, u?.full_name, cf.assigned_to_name, cf.assigned_sale_name, cf.consultant_name, cf.sale_name, u?.email ? String(u.email).split('@')[0] : '') ||
      null;
    if (!r.assigned_to_avatar && u?.avatar_url) r.assigned_to_avatar = u.avatar_url;
    if (!pickCleanName(r.round_name)) {
      const rid = [r.round_id, cf.round_id, cf.preferred_round_id].map((v) => String(v || '')).find((v) => roundMap.has(v));
      r.round_name = pickCleanName(rid ? roundMap.get(rid) : '', cf.round_name, userRoundMap.get(assignee)) || null;
    }
  }
  return rows;
}
