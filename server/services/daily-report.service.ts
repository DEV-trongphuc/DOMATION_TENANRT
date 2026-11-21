import type { DbClient } from '../core/database/db-adapter.ts';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { isOutboundSilentMode } from '../core/security/outbound-guard.ts';
import {
  renderTemplateString,
  resolveTenantBrandName,
  type TenantSettings,
} from '../core/settings/tenant-settings.ts';
import { getZonedDateParts, zonedWallClockToUtc } from '../routes/workspace.routes.ts';
import { executeDomMetaGraphBatch, resolveDomMetaAccessToken } from './dom-meta-report.service.ts';
import { getMetaAdsConfigSummary, normalizeAdAccountId } from './meta-ads.service.ts';
import { sendTelegramNotification } from './telegram.service.ts';
import {
  parseEmailRecipientList,
  renderEmailHtmlEnvelope,
  sendDiscordNotification,
  sendTenantEmailNotification,
  sendZaloBotNotification,
} from './zalo-mail.service.ts';

export type ReportPeriodType = 'daily' | 'weekly' | 'monthly';

export interface ReportWindow {
  period: ReportPeriodType;
  timeZone: string;
  ymd: string;
  sinceYmd: string;
  untilYmd: string;
  label: string;
  runKey: string;
  startUtc: Date;
  endUtc: Date;
}

export interface DailyReportAdminRecipient {
  id: string;
  fullName: string;
  email: string | null;
  zaloChatId: string | null;
}

export interface DailyReportSaleSummary {
  userId: string;
  name: string;
  totalLeads: number;
  acceptedLeads: number;
  slaBreached: number;
  qualifiedCount: number;
  closedCount: number;
  revenueVnd: number;
}

export interface CrmDailyReportMetrics {
  totalNewLeads: number;
  assignedLeads: number;
  unassignedPending: number;
  duplicateLeads: number;
  acceptedCount: number;
  slaBreachedCount: number;
  slaCompliancePct: number;
  avgResponseSeconds: number;
  qualifiedCount: number;
  bookedCount: number;
  bookingCount: number;
  depositedCount: number;
  closedCount: number;
  badtimingCount: number;
  noAnswerCount: number;
  notleadCount: number;
  unratedCount: number;
  pipelineRevenueVnd: number;
  conversionRatePct: number;
  ticketsPending: number;
  ticketsApproved: number;
  ticketsRejected: number;
  bySale: DailyReportSaleSummary[];
  adminRecipients: DailyReportAdminRecipient[];
}

export interface MetaAdsPeakHourItem {
  hour: string;
  leads: number;
  messages: number;
  results: number;
  spend: number;
}

export interface MetaAdsAccountSummaryItem {
  adAccountId: string;
  name: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
  messages: number;
  results: number;
}

export interface MetaAdsDailySummary {
  available: boolean;
  warning?: string;
  accountCount: number;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  leads: number;
  messages: number;
  results: number;
  peakHours: MetaAdsPeakHourItem[];
  byAccount: MetaAdsAccountSummaryItem[];
}

export interface CompiledDailyReportPayload {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  brandName: string;
  window: ReportWindow;
  crm: CrmDailyReportMetrics;
  metaAds: MetaAdsDailySummary | null;
}

export interface DailyReportDispatchSummary {
  channelsAttempted: string[];
  channelsDelivered: string[];
  errors: string[];
}

function safeFiniteNumber(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function formatInt(val: unknown): string {
  return Math.round(safeFiniteNumber(val, 0)).toLocaleString('en-US');
}

function formatCurrencyVnd(val: unknown): string {
  return `${Math.round(safeFiniteNumber(val, 0)).toLocaleString('en-US')}₫`;
}

function formatPct(val: unknown): string {
  return `${safeFiniteNumber(val, 0).toFixed(1)}%`;
}

function escapeTelegramHtml(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function computeIsoWeekKey(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function resolveReportWindow(
  period: ReportPeriodType,
  timeZone = 'Asia/Ho_Chi_Minh',
  now = new Date()
): ReportWindow {
  const tz = (timeZone || 'Asia/Ho_Chi_Minh').trim() || 'Asia/Ho_Chi_Minh';
  const zp = getZonedDateParts(now, tz) || {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    isoDow: now.getUTCDay() === 0 ? 7 : now.getUTCDay(),
    ymd: now.toISOString().slice(0, 10),
    ddmm: `${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
  };

  if (period === 'weekly') {
    const startOffsetDays = zp.isoDow === 1 ? 7 : zp.isoDow - 1;
    const endOffsetDays = zp.isoDow === 1 ? 1 : 0;
    const mondayAnchor = new Date(Date.UTC(zp.year, zp.month - 1, zp.day - startOffsetDays, 12, 0, 0));
    const endAnchor = new Date(Date.UTC(zp.year, zp.month - 1, zp.day - endOffsetDays, 12, 0, 0));

    const startYear = mondayAnchor.getUTCFullYear();
    const startMonth = mondayAnchor.getUTCMonth() + 1;
    const startDay = mondayAnchor.getUTCDate();
    const startMm = String(startMonth).padStart(2, '0');
    const startDd = String(startDay).padStart(2, '0');

    const endYear = endAnchor.getUTCFullYear();
    const endMonth = endAnchor.getUTCMonth() + 1;
    const endDay = endAnchor.getUTCDate();
    const endMm = String(endMonth).padStart(2, '0');
    const endDd = String(endDay).padStart(2, '0');

    const startUtc = zonedWallClockToUtc(startYear, startMonth, startDay, 0, 0, 0, tz);
    const endUtc = new Date(zonedWallClockToUtc(endYear, endMonth, endDay, 23, 59, 59, tz).getTime() + 999);
    const weekKey = computeIsoWeekKey(endYear, endMonth, endDay);
    return {
      period,
      timeZone: tz,
      ymd: zp.ymd,
      sinceYmd: `${startYear}-${startMm}-${startDd}`,
      untilYmd: `${endYear}-${endMm}-${endDd}`,
      label: `${startDd}/${startMm} - ${endDd}/${endMm}/${endYear}`,
      runKey: `weekly:${weekKey}`,
      startUtc,
      endUtc,
    };
  }

  if (period === 'monthly') {
    let targetYear = zp.year;
    let targetMonth = zp.month;
    let endDay = zp.day;
    if (zp.day === 1) {
      targetMonth = zp.month === 1 ? 12 : zp.month - 1;
      targetYear = zp.month === 1 ? zp.year - 1 : zp.year;
      endDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    }
    const mm = String(targetMonth).padStart(2, '0');
    const ddEnd = String(endDay).padStart(2, '0');
    const startUtc = zonedWallClockToUtc(targetYear, targetMonth, 1, 0, 0, 0, tz);
    const endUtc = new Date(zonedWallClockToUtc(targetYear, targetMonth, endDay, 23, 59, 59, tz).getTime() + 999);
    return {
      period,
      timeZone: tz,
      ymd: zp.ymd,
      sinceYmd: `${targetYear}-${mm}-01`,
      untilYmd: `${targetYear}-${mm}-${ddEnd}`,
      label: `Tháng ${mm}/${targetYear}`,
      runKey: `monthly:${targetYear}-${mm}`,
      startUtc,
      endUtc,
    };
  }

  const startUtc = zonedWallClockToUtc(zp.year, zp.month, zp.day, 0, 0, 0, tz);
  const endUtc = new Date(zonedWallClockToUtc(zp.year, zp.month, zp.day, 23, 59, 59, tz).getTime() + 999);
  return {
    period: 'daily',
    timeZone: tz,
    ymd: zp.ymd,
    sinceYmd: zp.ymd,
    untilYmd: zp.ymd,
    label: `${zp.ddmm}/${zp.year}`,
    runKey: `daily:${zp.ymd}`,
    startUtc,
    endUtc,
  };
}

function classifyLeadStageForReport(
  rawCandidates: Array<unknown>,
  isWon?: boolean | null,
  isLost?: boolean | null,
  cfg?: TenantSettings
): string {
  const activeStages = Array.isArray(cfg?.pipeline_capi_stages) ? cfg.pipeline_capi_stages : [];
  for (const rawVal of rawCandidates) {
    const s = String(rawVal || '').normalize('NFC').toLowerCase().trim();
    if (!s || s === 'pending' || s === 'new' || s === 'unrated' || s.includes('chưa đánh giá') || s.includes('mới tiếp nhận')) {
      continue;
    }
    for (const st of activeStages) {
      const k = st.key.normalize('NFC').toLowerCase();
      const l = st.label.normalize('NFC').toLowerCase();
      const sh = st.short_label ? st.short_label.normalize('NFC').toLowerCase() : '';
      if (k === s || l === s || (sh && sh === s)) {
        return st.key;
      }
    }
    if (
      s === 'good' ||
      s === 'hot' ||
      s === 'mql' ||
      s === 'sql' ||
      s.includes('qualified') ||
      s.includes('thiện chí') ||
      s.includes('tiềm năng') ||
      s.includes('quan tâm') ||
      s.includes('nhu cầu') ||
      s.includes('đủ điều kiện')
    ) {
      return 'Qualified';
    }
    if (
      s === 'scheduled' ||
      s.includes('booked') ||
      s.includes('hẹn gặp') ||
      s.includes('xem mẫu') ||
      s.includes('lịch hẹn') ||
      s.includes('tư vấn trực tiếp') ||
      s.includes('tham quan')
    ) {
      return 'Booked';
    }
    if (s.includes('booking') || s.includes('giữ chỗ')) return 'Booking';
    if (s.includes('deposit') || s.includes('đặt cọc') || s === 'cọc') return 'Deposited';
    if (
      s === 'won' ||
      s === 'customer' ||
      s.includes('closed') ||
      s.includes('chốt') ||
      s.includes('ký hđ') ||
      s.includes('hợp đồng') ||
      s.includes('thanh toán') ||
      s.includes('thu tiền') ||
      s.includes('nhập học') ||
      s.includes('thành công')
    ) {
      return 'Closed';
    }
    if (
      s === 'bad_timing' ||
      s.includes('badtiming') ||
      s.includes('bad timing') ||
      s.includes('hẹn gọi') ||
      s.includes('liên hệ lại') ||
      s.includes('chưa có nhu cầu') ||
      s.includes('suy nghĩ thêm')
    ) {
      return 'Badtiming';
    }
    if (
      s === 'no_answer' ||
      s.includes('noanswer') ||
      s.includes('no answer') ||
      s.includes('liên lạc') ||
      s.includes('không nghe') ||
      s.includes('thuê bao') ||
      s.includes('tắt máy')
    ) {
      return 'NoAnswer';
    }
    if (
      s === 'disqualified' ||
      s === 'junk' ||
      s === 'lost' ||
      s.includes('notlead') ||
      s.includes('not lead') ||
      s.includes('không đúng') ||
      s.includes('không phù hợp') ||
      s.includes('sai số') ||
      s.includes('rác') ||
      s.includes('spam') ||
      s.includes('blacklist') ||
      s.includes('từ chối')
    ) {
      return 'Notlead';
    }
  }
  if (isWon) return 'Closed';
  if (isLost) return 'Notlead';
  return 'unrated';
}

function parseCustomFieldsObj(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, any>;
    } catch {}
  }
  return {};
}

export async function compileTenantCrmReportMetrics(
  client: DbClient,
  tenantId: string,
  window: ReportWindow,
  cfg: TenantSettings
): Promise<CrmDailyReportMetrics> {
  const [leadsRes, ticketsRes] = await Promise.all([
    client.query<{
      id: string;
      status: string;
      assigned_to: string | null;
      is_accepted: boolean | number | null;
      accepted_at: Date | string | null;
      sla_breached: boolean | number | null;
      is_duplicate_reminder: boolean | number | null;
      is_duplicated: boolean | number | null;
      quality_status: string | null;
      total_revenue_vnd: number | string | null;
      custom_fields: unknown;
      created_at: Date | string;
      stage_key: string | null;
      stage_name: string | null;
      is_won_stage: boolean | number | null;
      is_lost_stage: boolean | number | null;
      sale_name: string | null;
    }>(
      `SELECT l.id, l.status, l.assigned_to, l.is_accepted, l.accepted_at, l.sla_breached,
              l.is_duplicate_reminder, l.is_duplicated, l.quality_status, l.total_revenue_vnd,
              l.custom_fields, l.created_at,
              tps.stage_key, tps.stage_name, tps.is_won_stage, tps.is_lost_stage,
              u.full_name AS sale_name
       FROM leads l
       LEFT JOIN tenant_pipeline_stages tps ON tps.tenant_id = l.tenant_id AND tps.id = l.stage_id
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       WHERE l.tenant_id = $1
         AND l.is_deleted = false
         AND l.status != 'archived'
         AND l.created_at >= $2
         AND l.created_at <= $3`,
      [tenantId, window.startUtc, window.endUtc]
    ),
    client.query<{ status: string; cnt: number | string }>(
      `SELECT status, COUNT(*) AS cnt
       FROM data_reports
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3
       GROUP BY status`,
      [tenantId, window.startUtc, window.endUtc]
    ),
  ]);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let adminRecipients: DailyReportAdminRecipient[] = [];
  const adminIds = Array.isArray(cfg.daily_report_admins)
    ? cfg.daily_report_admins
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => UUID_RE.test(id))
    : [];

  if (adminIds.length > 0) {
    const adminRes = await client.query<{
      id: string;
      full_name: string | null;
      email: string | null;
      zalo_chat_id: string | null;
    }>(
      `SELECT u.id, u.full_name, u.email, tup.zalo_chat_id
       FROM users u
       LEFT JOIN tenant_user_profiles tup ON tup.tenant_id = u.tenant_id AND tup.user_id = u.id
       WHERE u.tenant_id = $1 AND u.id = ANY($2)`,
      [tenantId, adminIds]
    );
    adminRecipients = adminRes.rows.map((r) => ({
      id: String(r.id),
      fullName: String(r.full_name || 'Admin').trim(),
      email: r.email ? String(r.email).trim() : null,
      zaloChatId: r.zalo_chat_id ? String(r.zalo_chat_id).trim() : null,
    }));
  }

  let totalNewLeads = 0;
  let assignedLeads = 0;
  let unassignedPending = 0;
  let duplicateLeads = 0;
  let acceptedCount = 0;
  let slaBreachedCount = 0;
  let responseSumSec = 0;
  let responseSamples = 0;
  let qualifiedCount = 0;
  let bookedCount = 0;
  let bookingCount = 0;
  let depositedCount = 0;
  let closedCount = 0;
  let badtimingCount = 0;
  let noAnswerCount = 0;
  let notleadCount = 0;
  let unratedCount = 0;
  let pipelineRevenueVnd = 0;

  const saleMap = new Map<string, DailyReportSaleSummary>();

  for (const row of leadsRes.rows) {
    totalNewLeads += 1;
    const isAssigned = row.status === 'assigned' || Boolean(row.assigned_to);
    if (row.assigned_to) {
      assignedLeads += 1;
    } else if (row.status === 'unassigned_pending' || !isAssigned) {
      unassignedPending += 1;
    }
    if (Boolean(row.is_duplicate_reminder) || Boolean(row.is_duplicated)) {
      duplicateLeads += 1;
    }
    const isAccepted = Boolean(row.is_accepted);
    if (isAccepted) acceptedCount += 1;
    const isSlaBreached = Boolean(row.sla_breached);
    if (isSlaBreached) slaBreachedCount += 1;

    if (isAccepted && row.accepted_at && row.created_at) {
      const createdMs = new Date(row.created_at).getTime();
      const acceptedMs = new Date(row.accepted_at).getTime();
      if (Number.isFinite(createdMs) && Number.isFinite(acceptedMs) && acceptedMs >= createdMs) {
        responseSumSec += (acceptedMs - createdMs) / 1000;
        responseSamples += 1;
      }
    }

    const rev = Math.max(0, safeFiniteNumber(row.total_revenue_vnd, 0));
    pipelineRevenueVnd += rev;

    const cf = parseCustomFieldsObj(row.custom_fields);
    const stageKey = classifyLeadStageForReport(
      [row.quality_status, cf.sale_status, row.stage_name, row.stage_key],
      Boolean(row.is_won_stage),
      Boolean(row.is_lost_stage),
      cfg
    );

    if (stageKey === 'Qualified') qualifiedCount += 1;
    else if (stageKey === 'Booked') bookedCount += 1;
    else if (stageKey === 'Booking') bookingCount += 1;
    else if (stageKey === 'Deposited') depositedCount += 1;
    else if (stageKey === 'Closed') closedCount += 1;
    else if (stageKey === 'Badtiming') badtimingCount += 1;
    else if (stageKey === 'NoAnswer') noAnswerCount += 1;
    else if (stageKey === 'Notlead') notleadCount += 1;
    else unratedCount += 1;

    if (row.assigned_to) {
      const uid = String(row.assigned_to);
      const cur = saleMap.get(uid) || {
        userId: uid,
        name: String(row.sale_name || 'Sale').trim(),
        totalLeads: 0,
        acceptedLeads: 0,
        slaBreached: 0,
        qualifiedCount: 0,
        closedCount: 0,
        revenueVnd: 0,
      };
      cur.totalLeads += 1;
      if (isAccepted) cur.acceptedLeads += 1;
      if (isSlaBreached) cur.slaBreached += 1;
      if (
        stageKey === 'Qualified' ||
        stageKey === 'Booked' ||
        stageKey === 'Booking' ||
        stageKey === 'Deposited' ||
        stageKey === 'Closed'
      ) {
        cur.qualifiedCount += 1;
      }
      if (stageKey === 'Closed') cur.closedCount += 1;
      cur.revenueVnd += rev;
      saleMap.set(uid, cur);
    }
  }

  let ticketsPending = 0;
  let ticketsApproved = 0;
  let ticketsRejected = 0;
  for (const tRow of ticketsRes.rows) {
    const cnt = Math.max(0, Math.round(safeFiniteNumber(tRow.cnt, 0)));
    if (tRow.status === 'pending') ticketsPending += cnt;
    else if (tRow.status === 'approved') ticketsApproved += cnt;
    else if (tRow.status === 'rejected') ticketsRejected += cnt;
  }

  const slaCompliancePct =
    totalNewLeads > 0 ? Math.max(0, Math.min(100, ((totalNewLeads - slaBreachedCount) / totalNewLeads) * 100)) : 100;
  const avgResponseSeconds = responseSamples > 0 ? Math.round(responseSumSec / responseSamples) : 0;
  const conversionRatePct = totalNewLeads > 0 ? (closedCount / totalNewLeads) * 100 : 0;
  const bySale = Array.from(saleMap.values()).sort((a, b) => b.totalLeads - a.totalLeads);

  return {
    totalNewLeads,
    assignedLeads,
    unassignedPending,
    duplicateLeads,
    acceptedCount,
    slaBreachedCount,
    slaCompliancePct,
    avgResponseSeconds,
    qualifiedCount,
    bookedCount,
    bookingCount,
    depositedCount,
    closedCount,
    badtimingCount,
    noAnswerCount,
    notleadCount,
    unratedCount,
    pipelineRevenueVnd,
    conversionRatePct,
    ticketsPending,
    ticketsApproved,
    ticketsRejected,
    bySale,
    adminRecipients,
  };
}

function extractMetaActionSums(actionsRaw: unknown): { leads: number; messages: number; primaryResults: number } {
  if (!Array.isArray(actionsRaw)) return { leads: 0, messages: 0, primaryResults: 0 };
  let leads = 0;
  let messages = 0;
  let primaryResults = 0;
  const leadTypes = new Set([
    'lead',
    'onsite_conversion.lead_grouped',
    'offsite_conversion.fb_pixel_lead',
    'leadgen_grouped',
  ]);
  const msgTypes = new Set([
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion.messaging_first_reply',
    'messaging_conversation_started_7d',
  ]);
  const secondaryResultTypes = new Set(['purchase', 'omni_purchase', 'complete_registration']);

  for (const act of actionsRaw) {
    if (!act || typeof act !== 'object') continue;
    const type = String((act as any).action_type || '').trim();
    const val = Math.max(0, safeFiniteNumber((act as any).value, 0));
    if (leadTypes.has(type)) leads += val;
    else if (msgTypes.has(type)) messages += val;
    else if (secondaryResultTypes.has(type)) primaryResults += val;
  }

  return { leads, messages, primaryResults };
}

function parseMetaHourLabel(rawHour: unknown): string {
  const s = String(rawHour || '').trim();
  const match = s.match(/^(\d{2}:\d{2})/);
  if (match) return match[1];
  const digits = s.match(/^(\d{1,2})/);
  if (digits) return `${digits[1].padStart(2, '0')}:00`;
  return s || '00:00';
}

export async function fetchTenantMetaAdsDailySummary(
  tenantId: string,
  window: ReportWindow,
  cfg: TenantSettings,
  options?: {
    allowGraphInSilentMode?: boolean;
    skipCache?: boolean;
  }
): Promise<MetaAdsDailySummary | null> {
  // STRICT GATE: Never read Meta tokens or call Graph API when toggle is OFF
  if (cfg.daily_report_include_meta_ads !== true) {
    return null;
  }

  const eligibleAccounts: Array<{ adAccountId: string; name: string; accessToken: string }> = [];

  try {
    await withTenantTransaction(tenantId, async (client) => {
      const summary = await getMetaAdsConfigSummary(client, tenantId);
      let candidates = (summary.accounts || []).filter((a) => a.is_active && a.has_token);

      if (Array.isArray(cfg.daily_report_meta_account_ids) && cfg.daily_report_meta_account_ids.length > 0) {
        const allowedSet = new Set(
          cfg.daily_report_meta_account_ids.map((id) => normalizeAdAccountId(id)).filter(Boolean)
        );
        candidates = candidates.filter((a) => allowedSet.has(normalizeAdAccountId(a.ad_account_id)));
      }

      for (const acc of candidates) {
        const normId = normalizeAdAccountId(acc.ad_account_id);
        if (!normId) continue;
        const tokRes = await resolveDomMetaAccessToken(client, tenantId, acc.ad_account_id);
        if (tokRes.success && tokRes.accessToken) {
          eligibleAccounts.push({
            adAccountId: normId,
            name: acc.name || `act_${normId}`,
            accessToken: tokRes.accessToken,
          });
        }
      }
    });
  } catch (err: any) {
    console.warn(`[DailyReport] Failed to load Meta Ads accounts for tenant ${tenantId}:`, err?.message || err);
    return {
      available: false,
      warning: err?.message || 'meta_account_load_failed',
      accountCount: 0,
      spend: 0,
      impressions: 0,
      reach: 0,
      clicks: 0,
      leads: 0,
      messages: 0,
      results: 0,
      peakHours: [],
      byAccount: [],
    };
  }

  if (eligibleAccounts.length === 0) {
    console.warn(`[DailyReport] Meta Ads report enabled for tenant ${tenantId}, but no active Meta token/account matched.`);
    return {
      available: false,
      warning: 'missing_token_or_account',
      accountCount: 0,
      spend: 0,
      impressions: 0,
      reach: 0,
      clicks: 0,
      leads: 0,
      messages: 0,
      results: 0,
      peakHours: [],
      byAccount: [],
    };
  }

  if (isOutboundSilentMode() && !options?.allowGraphInSilentMode) {
    return {
      available: false,
      warning: 'silent_mode_skipped_graph',
      accountCount: eligibleAccounts.length,
      spend: 0,
      impressions: 0,
      reach: 0,
      clicks: 0,
      leads: 0,
      messages: 0,
      results: 0,
      peakHours: [],
      byAccount: [],
    };
  }

  const selectedMetrics = new Set(
    (Array.isArray(cfg.daily_report_meta_ads_metrics) ? cfg.daily_report_meta_ads_metrics : []).map((m) =>
      String(m).trim().toLowerCase()
    )
  );
  const includePeakHours = selectedMetrics.size === 0 || selectedMetrics.has('peak_hours');
  const timeRangeStr = JSON.stringify({ since: window.sinceYmd, until: window.untilYmd });

  let spend = 0;
  let impressions = 0;
  let reach = 0;
  let clicks = 0;
  let leads = 0;
  let messages = 0;
  let secondaryResults = 0;
  let anyGraphSuccess = false;
  let lastWarning: string | undefined;
  const hourlyMap = new Map<string, MetaAdsPeakHourItem>();
  const byAccount: MetaAdsAccountSummaryItem[] = [];

  for (const acc of eligibleAccounts) {
    try {
      const requests: Array<{
        key: string;
        graph_path: string;
        params?: Record<string, string | number | boolean | undefined>;
      }> = [
        {
          key: 'summary',
          graph_path: `act_${acc.adAccountId}/insights`,
          params: {
            time_range: timeRangeStr,
            level: 'account',
            fields: 'spend,impressions,reach,clicks,actions',
          },
        },
      ];
      if (includePeakHours) {
        requests.push({
          key: 'hourly',
          graph_path: `act_${acc.adAccountId}/insights`,
          params: {
            time_range: timeRangeStr,
            breakdowns: 'hourly_stats_aggregated_by_audience_time_zone',
            fields: 'spend,impressions,reach,clicks,actions',
          },
        });
      }

      const batchRes = await executeDomMetaGraphBatch(tenantId, acc.accessToken, {
        ad_account_id: acc.adAccountId,
        requests,
        skip_cache: options?.skipCache ?? false,
      });

      if (!batchRes.success) {
        lastWarning = batchRes.message || `Meta Graph HTTP ${batchRes.status}`;
        console.warn(`[DailyReport] Meta Graph degraded for tenant ${tenantId}, act_${acc.adAccountId}: ${lastWarning}`);
        continue;
      }

      const batchErrors = (batchRes as any).errors as Record<string, any> | undefined;
      if (!batchRes.data?.summary && batchErrors && Object.keys(batchErrors).length > 0) {
        const firstErr = batchErrors.summary || batchErrors.hourly || Object.values(batchErrors)[0];
        const extractedMsg =
          typeof firstErr === 'string'
            ? firstErr
            : firstErr?.message || (firstErr?.code ? `Meta Graph error ${firstErr.code}` : 'Meta Graph batch error');
        lastWarning = extractedMsg;
        console.warn(`[DailyReport] Meta Graph batch error for tenant ${tenantId}, act_${acc.adAccountId}: ${lastWarning}`);
      }

      const summaryRows = Array.isArray(batchRes.data?.summary?.data) ? batchRes.data.summary.data : [];
      const hourlyRows = Array.isArray(batchRes.data?.hourly?.data) ? batchRes.data.hourly.data : [];
      if (batchRes.data?.summary) anyGraphSuccess = true;

      let accSpend = 0;
      let accImpressions = 0;
      let accReach = 0;
      let accClicks = 0;
      let accLeads = 0;
      let accMessages = 0;
      let accSecondary = 0;

      for (const row of summaryRows) {
        accSpend += safeFiniteNumber(row?.spend, 0);
        accImpressions += safeFiniteNumber(row?.impressions, 0);
        accReach += safeFiniteNumber(row?.reach, 0);
        accClicks += safeFiniteNumber(row?.clicks, 0);
        const acts = extractMetaActionSums(row?.actions);
        accLeads += acts.leads;
        accMessages += acts.messages;
        accSecondary += acts.primaryResults;
      }

      spend += accSpend;
      impressions += accImpressions;
      reach += accReach;
      clicks += accClicks;
      leads += accLeads;
      messages += accMessages;
      secondaryResults += accSecondary;

      if (summaryRows.length > 0) {
        byAccount.push({
          adAccountId: acc.adAccountId,
          name: acc.name,
          spend: accSpend,
          impressions: accImpressions,
          reach: accReach,
          clicks: accClicks,
          leads: accLeads,
          messages: accMessages,
          results: accLeads + accMessages > 0 ? accLeads + accMessages : accSecondary,
        });
      }

      for (const hRow of hourlyRows) {
        const hourLabel = parseMetaHourLabel(hRow?.hourly_stats_aggregated_by_audience_time_zone);
        const hSpend = safeFiniteNumber(hRow?.spend, 0);
        const acts = extractMetaActionSums(hRow?.actions);
        const hResults = acts.leads + acts.messages > 0 ? acts.leads + acts.messages : acts.primaryResults;
        const cur = hourlyMap.get(hourLabel) || {
          hour: hourLabel,
          leads: 0,
          messages: 0,
          results: 0,
          spend: 0,
        };
        cur.leads += acts.leads;
        cur.messages += acts.messages;
        cur.results += hResults;
        cur.spend += hSpend;
        hourlyMap.set(hourLabel, cur);
      }
    } catch (err: any) {
      lastWarning = err?.message || 'Meta Graph fetch exception';
      console.warn(`[DailyReport] Meta Ads exception for tenant ${tenantId}, act_${acc.adAccountId}: ${lastWarning}`);
    }
  }

  // Passive DB cache fallback if Graph failed completely
  if (!anyGraphSuccess) {
    try {
      const dbFallback = await withTenantTransaction(tenantId, async (client) => {
        const ids = eligibleAccounts.map((a) => a.adAccountId);
        const r = await client.query<{
          spend: string | number;
          impressions: string | number;
          reach: string | number;
          clicks: string | number;
          meta_leads: string | number;
        }>(
          `SELECT COALESCE(SUM(spend), 0) AS spend,
                  COALESCE(SUM(impressions), 0) AS impressions,
                  COALESCE(SUM(reach), 0) AS reach,
                  COALESCE(SUM(clicks), 0) AS clicks,
                  COALESCE(SUM(meta_leads), 0) AS meta_leads
           FROM meta_ads_insights
           WHERE tenant_id = $1
             AND date_start >= $2
             AND date_stop <= $3
             AND (ad_account_id = ANY($4) OR ad_account_id IS NULL)`,
          [tenantId, window.sinceYmd, window.untilYmd, ids]
        );
        return r.rows[0] || null;
      });
      if (dbFallback && (safeFiniteNumber(dbFallback.spend) > 0 || safeFiniteNumber(dbFallback.impressions) > 0)) {
        spend = safeFiniteNumber(dbFallback.spend);
        impressions = safeFiniteNumber(dbFallback.impressions);
        reach = safeFiniteNumber(dbFallback.reach);
        clicks = safeFiniteNumber(dbFallback.clicks);
        leads = safeFiniteNumber(dbFallback.meta_leads);
        anyGraphSuccess = true;
      }
    } catch {
      // Passive fallback must never throw
    }
  }

  const results = leads + messages > 0 ? leads + messages : secondaryResults;
  const peakHours = Array.from(hourlyMap.values())
    .sort((a, b) => b.results - a.results || b.spend - a.spend)
    .slice(0, 3);

  return {
    available: anyGraphSuccess,
    ...(lastWarning ? { warning: lastWarning } : {}),
    accountCount: eligibleAccounts.length,
    spend,
    impressions,
    reach,
    clicks,
    leads,
    messages,
    results,
    peakHours,
    byAccount,
  };
}

export function formatDailyReportBotMessages(
  payload: CompiledDailyReportPayload,
  cfg: TenantSettings
): { telegramHtml: string; plainText: string } {
  const { crm, metaAds, window, brandName } = payload;
  const periodTitle =
    window.period === 'weekly'
      ? 'BÁO CÁO TUẦN CRM'
      : window.period === 'monthly'
        ? 'BÁO CÁO THÁNG CRM'
        : 'BÁO CÁO CUỐI NGÀY CRM';

  const crmLinesHtml = [
    `📊 <b>${escapeTelegramHtml(periodTitle)} — ${escapeTelegramHtml(brandName)}</b>`,
    `📅 Kỳ: <b>${escapeTelegramHtml(window.label)}</b>`,
    '',
    `📥 <b>Tổng Lead mới:</b> ${formatInt(crm.totalNewLeads)} (Đã chia: ${formatInt(crm.assignedLeads)} • Chờ chia: ${formatInt(crm.unassignedPending)} • Trùng: ${formatInt(crm.duplicateLeads)})`,
    `⚡ <b>SLA Tiếp nhận:</b> ${formatInt(crm.acceptedCount)} đã nhận • Quá hạn: ${formatInt(crm.slaBreachedCount)} (${formatPct(crm.slaCompliancePct)} đạt SLA) • TB: ${formatInt(crm.avgResponseSeconds)}s`,
    `🎯 <b>Chất lượng Pipeline:</b> Thiện chí ${formatInt(crm.qualifiedCount)} • Hẹn gặp ${formatInt(crm.bookedCount)} • Booking ${formatInt(crm.bookingCount)} • Cọc ${formatInt(crm.depositedCount)} • Chốt HĐ ${formatInt(crm.closedCount)}`,
    `📉 <b>Chưa chuyển đổi:</b> Sai số/KNC ${formatInt(crm.notleadCount)} • KBM ${formatInt(crm.noAnswerCount)} • Sai TĐ ${formatInt(crm.badtimingCount)} • Chưa ĐG ${formatInt(crm.unratedCount)}`,
    `💰 <b>Doanh thu Pipeline:</b> ${formatCurrencyVnd(crm.pipelineRevenueVnd)} (Tỷ lệ chốt: ${formatPct(crm.conversionRatePct)})`,
    `🎫 <b>Ticket báo lỗi:</b> Chờ duyệt ${formatInt(crm.ticketsPending)} • Đã duyệt ${formatInt(crm.ticketsApproved)} • Từ chối ${formatInt(crm.ticketsRejected)}`,
  ];

  if (crm.bySale.length > 0) {
    crmLinesHtml.push('');
    crmLinesHtml.push('👥 <b>Hiệu suất theo Sale (Top 5):</b>');
    for (const s of crm.bySale.slice(0, 5)) {
      crmLinesHtml.push(
        `• ${escapeTelegramHtml(s.name)}: ${formatInt(s.totalLeads)} lead • TC/Chốt ${formatInt(s.qualifiedCount)}/${formatInt(s.closedCount)} • ${formatCurrencyVnd(s.revenueVnd)}`
      );
    }
  }

  if (cfg.daily_report_include_meta_ads === true && metaAds) {
    const metricsSet = new Set(
      (cfg.daily_report_meta_ads_metrics || []).map((m) => String(m).trim().toLowerCase())
    );
    const showAll = metricsSet.size === 0;
    crmLinesHtml.push('');
    if (metaAds.available) {
      crmLinesHtml.push(`📣 <b>META ADS (${formatInt(metaAds.accountCount)} TK):</b>`);
      const parts: string[] = [];
      if (showAll || metricsSet.has('results')) parts.push(`Kết quả: <b>${formatInt(metaAds.results)}</b>`);
      if (showAll || metricsSet.has('leads')) parts.push(`Leads: <b>${formatInt(metaAds.leads)}</b>`);
      if (showAll || metricsSet.has('messages')) parts.push(`Tin nhắn: <b>${formatInt(metaAds.messages)}</b>`);
      if (showAll || metricsSet.has('reach')) parts.push(`Reach: <b>${formatInt(metaAds.reach)}</b>`);
      if (showAll || metricsSet.has('spend')) parts.push(`Chi tiêu: <b>${formatCurrencyVnd(metaAds.spend)}</b>`);
      if (parts.length > 0) {
        crmLinesHtml.push(`• ${parts.join(' • ')}`);
      }
      if (Array.isArray(metaAds.byAccount) && metaAds.byAccount.length > 1) {
        for (const acc of metaAds.byAccount.slice(0, 5)) {
          const accParts: string[] = [];
          if (showAll || metricsSet.has('results')) accParts.push(`KQ ${formatInt(acc.results)}`);
          if (showAll || metricsSet.has('leads')) accParts.push(`Leads ${formatInt(acc.leads)}`);
          if (showAll || metricsSet.has('messages')) accParts.push(`Tin nhắn ${formatInt(acc.messages)}`);
          if (showAll || metricsSet.has('reach')) accParts.push(`Reach ${formatInt(acc.reach)}`);
          if (showAll || metricsSet.has('spend')) accParts.push(`Chi tiêu ${formatCurrencyVnd(acc.spend)}`);
          crmLinesHtml.push(`  ↳ ${escapeTelegramHtml(acc.name)}: ${accParts.join(' • ')}`);
        }
      }
      if ((showAll || metricsSet.has('peak_hours')) && metaAds.peakHours.length > 0) {
        const peakSummary = metaAds.peakHours
          .map((p) => `${p.hour} (${formatInt(p.results)} KQ)`)
          .join(', ');
        crmLinesHtml.push(`⏰ <b>Giờ cao điểm:</b> ${escapeTelegramHtml(peakSummary)}`);
      }
    } else {
      crmLinesHtml.push(
        `📣 <b>META ADS:</b> Chưa có dữ liệu quảng cáo khả dụng (${escapeTelegramHtml(metaAds.warning || 'chưa kết nối')}).`
      );
    }
  }

  const telegramHtml = crmLinesHtml.join('\n');
  const plainText = telegramHtml
    .replace(/<\/?b>/gi, '')
    .replace(/<\/?code>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  return { telegramHtml, plainText };
}

export function formatDailyReportEmail(
  payload: CompiledDailyReportPayload,
  cfg: TenantSettings,
  frontendUrl = 'https://domation.net/data'
): { subject: string; text: string; html: string } {
  const { crm, metaAds, window, brandName, tenantSlug } = payload;
  const tplSubject = cfg.notification_templates?.daily_report_subject || '[{{brand_name}}] Báo cáo hiệu suất Data {{report_date}}';
  const subject = renderTemplateString(tplSubject, {
    brand_name: brandName,
    report_date: window.label,
  });

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Kỳ báo cáo', value: `${window.label} (${window.period.toUpperCase()})` },
    {
      label: 'Tổng Lead CRM mới',
      value: `${formatInt(crm.totalNewLeads)} Lead (Đã chia: ${formatInt(crm.assignedLeads)} • Chờ chia: ${formatInt(crm.unassignedPending)} • Trùng: ${formatInt(crm.duplicateLeads)})`,
    },
    {
      label: 'Tuân thủ SLA',
      value: `${formatInt(crm.acceptedCount)} đã nhận • Quá hạn: ${formatInt(crm.slaBreachedCount)} (${formatPct(crm.slaCompliancePct)}) • TB: ${formatInt(crm.avgResponseSeconds)}s`,
    },
    {
      label: 'Chất lượng Pipeline',
      value: `Thiện chí ${formatInt(crm.qualifiedCount)} • Hẹn gặp ${formatInt(crm.bookedCount)} • Booking ${formatInt(crm.bookingCount)} • Cọc ${formatInt(crm.depositedCount)} • Chốt HĐ ${formatInt(crm.closedCount)}`,
    },
    {
      label: 'Doanh thu Pipeline',
      value: `${formatCurrencyVnd(crm.pipelineRevenueVnd)} (Tỷ lệ chốt ${formatPct(crm.conversionRatePct)})`,
    },
    {
      label: 'Ticket báo lỗi',
      value: `Chờ duyệt ${formatInt(crm.ticketsPending)} • Đã duyệt ${formatInt(crm.ticketsApproved)} • Từ chối ${formatInt(crm.ticketsRejected)}`,
    },
  ];

  if (crm.bySale.length > 0) {
    rows.push({
      label: 'Top Sale',
      value: crm.bySale
        .slice(0, 3)
        .map((s) => `${s.name} (${formatInt(s.totalLeads)} lead, ${formatInt(s.closedCount)} chốt)`)
        .join(' | '),
    });
  }

  if (cfg.daily_report_include_meta_ads === true && metaAds) {
    if (metaAds.available) {
      const peakStr =
        metaAds.peakHours.length > 0
          ? ` • Cao điểm: ${metaAds.peakHours.map((p) => `${p.hour} (${formatInt(p.results)} KQ)`).join(', ')}`
          : '';
      rows.push({
        label: 'Hiệu quả Meta Ads',
        value: `Kết quả ${formatInt(metaAds.results)} • Leads ${formatInt(metaAds.leads)} • Tin nhắn ${formatInt(metaAds.messages)} • Reach ${formatInt(metaAds.reach)} • Chi tiêu ${formatCurrencyVnd(metaAds.spend)}${peakStr}`,
      });
    } else {
      rows.push({
        label: 'Hiệu quả Meta Ads',
        value: `Chưa có dữ liệu khả dụng (${metaAds.warning || 'chưa kết nối'})`,
      });
    }
  }

  const { plainText } = formatDailyReportBotMessages(payload, cfg);
  const portalUrl = `${frontendUrl.replace(/\/+$/, '')}/${tenantSlug}`;
  const html = renderEmailHtmlEnvelope({
    title: subject,
    badge: window.period === 'weekly' ? 'BÁO CÁO TUẦN' : window.period === 'monthly' ? 'BÁO CÁO THÁNG' : 'BÁO CÁO HÀNG NGÀY',
    accentColor: cfg.brand_email_accent_color || cfg.brand_primary_color || '#1E40FF',
    summaryText: `Tổng hợp hiệu suất Lead CRM${cfg.daily_report_include_meta_ads ? ' & Meta Ads' : ''} kỳ ${window.label} của ${brandName}.`,
    rows,
    ctaLabel: 'Mở Workspace CRM',
    ctaUrl: portalUrl,
    tenantName: brandName,
    footerText: cfg.brand_email_footer_text,
  });

  return { subject, text: plainText, html };
}

export async function dispatchTenantDailyReportChannels(params: {
  payload: CompiledDailyReportPayload;
  cfg: TenantSettings;
  rawSettings: Record<string, any>;
}): Promise<DailyReportDispatchSummary> {
  const { payload, cfg, rawSettings } = params;
  const channels = cfg.daily_report_channels || { zalo: false, telegram: false, email: false, discord: false };
  const { telegramHtml, plainText } = formatDailyReportBotMessages(payload, cfg);
  const frontendUrl = String(rawSettings.frontend_url || 'https://domation.net/data').trim();
  const emailContent = formatDailyReportEmail(payload, cfg, frontendUrl);

  const channelsAttempted: string[] = [];
  const channelsDelivered: string[] = [];
  const errors: string[] = [];

  // 1. Telegram Bot
  if (channels.telegram) {
    channelsAttempted.push('telegram');
    try {
      const tgRes = await sendTelegramNotification(payload.tenantId, telegramHtml, { parseMode: 'HTML' });
      if (tgRes.success && !tgRes.silent) {
        channelsDelivered.push('telegram');
      } else if (!tgRes.success) {
        errors.push(`telegram: ${tgRes.error || 'failed'}`);
      }
    } catch (err: any) {
      errors.push(`telegram: ${err?.message || 'exception'}`);
    }
  }

  // 2. Zalo Bot
  if (channels.zalo) {
    channelsAttempted.push('zalo');
    const groupChatId = String(cfg.zalo_admin_group_chat_id || '').trim();
    const targetIds = new Set<string>();
    if (groupChatId) targetIds.add(groupChatId);
    if (!cfg.zalo_notify_only_group) {
      for (const adm of payload.crm.adminRecipients) {
        if (adm.zaloChatId) targetIds.add(adm.zaloChatId);
      }
    }
    if (targetIds.size === 0) {
      // Try Vault default chat_id via single send
      const zRes = await sendZaloBotNotification(payload.tenantId, plainText);
      if (zRes.success && !zRes.silent) channelsDelivered.push('zalo');
      else if (!zRes.success) errors.push(`zalo: ${zRes.error || 'failed'}`);
    } else {
      let zaloDeliveredAny = false;
      for (const chatId of targetIds) {
        const zRes = await sendZaloBotNotification(payload.tenantId, plainText, { chatId });
        if (zRes.success && !zRes.silent) zaloDeliveredAny = true;
        else if (!zRes.success) errors.push(`zalo(${chatId}): ${zRes.error || 'failed'}`);
      }
      if (zaloDeliveredAny) channelsDelivered.push('zalo');
    }
  }

  // 3. Discord Webhook / Bot
  if (channels.discord) {
    channelsAttempted.push('discord');
    try {
      const dRes = await sendDiscordNotification(payload.tenantId, plainText);
      if (dRes.success && !dRes.silent) {
        channelsDelivered.push('discord');
      } else if (!dRes.success) {
        errors.push(`discord: ${dRes.error || 'failed'}`);
      }
    } catch (err: any) {
      errors.push(`discord: ${err?.message || 'exception'}`);
    }
  }

  // 4. Email (Admin recipients + fallback_cc_email)
  if (channels.email) {
    channelsAttempted.push('email');
    const combinedRawEmails: string[] = [];
    for (const adm of payload.crm.adminRecipients) {
      if (adm.email) combinedRawEmails.push(adm.email);
    }
    const fallbackCc = String(cfg.fallback_cc_email || rawSettings.fallback_cc_email || '').trim();
    if (fallbackCc) {
      combinedRawEmails.push(fallbackCc);
    }
    const emailList = parseEmailRecipientList(combinedRawEmails.join(',')).filter((e) => e.includes('@'));

    if (emailList.length === 0) {
      const eRes = await sendTenantEmailNotification({
        tenantId: payload.tenantId,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
        category: 'daily_report',
        meta: { period: payload.window.period, run_key: payload.window.runKey },
      });
      if (eRes?.sent && eRes.provider !== 'silent_guard') channelsDelivered.push('email');
      else if (eRes && !eRes.sent) errors.push(`email: ${eRes.error || 'failed'}`);
    } else {
      const primaryTo = emailList[0];
      const eRes = await sendTenantEmailNotification({
        tenantId: payload.tenantId,
        to: primaryTo,
        cc: emailList.length > 1 ? emailList.slice(1).join(',') : undefined,
        subject: emailContent.subject,
        text: emailContent.text,
        html: emailContent.html,
        category: 'daily_report',
        meta: { period: payload.window.period, run_key: payload.window.runKey },
      });
      if (eRes?.sent && eRes.provider !== 'silent_guard') channelsDelivered.push('email');
      else if (eRes && !eRes.sent) errors.push(`email: ${eRes.error || 'failed'}`);
    }
  }

  return {
    channelsAttempted,
    channelsDelivered,
    errors,
  };
}

export function buildTenantBrandForReport(
  cfg: TenantSettings,
  tenantRow: { name?: string; slug?: string; settings?: Record<string, any> }
): string {
  return resolveTenantBrandName(cfg, {
    name: tenantRow.name,
    slug: tenantRow.slug,
    rawSettings: tenantRow.settings,
  });
}
