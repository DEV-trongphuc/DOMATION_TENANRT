import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { emitDomainEvent, onDomainEvent } from '../../core/events/event-bus.ts';
import { getTenantMetaCached, getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import {
  dispatchStageCapiEventDetached,
  isLiveMetaCapiCredential,
  resolveCapiEventForQualityOrStage,
} from '../../services/capi.service.ts';
import { runUnassignedLeadDrainer } from '../../cron/subroutines/lead-drainer.ts';
import { promoteLeadsToSaleRoundInTx, refreshAudienceCachedCount } from '../audiences/audiences.service.ts';
import { slugifyKeyLower } from '../org-rbac/org-rbac.service.ts';
import { ensureMarketingSchema } from './schema.ts';
import {
  buildSuppressionSet,
  compileEmailBlocksToHtml,
  generateShortCode,
  isRecipientSuppressed,
  parseJsonCol,
  readTenantChannelVault,
  renderMergeTags,
  resolvePublicRequestOrigin,
  signUnsubscribeHmac,
  stripHtmlTagsForPlainText,
  type EmailBlockDto,
  type EmailBodyStyleDto,
} from './utils.ts';
import {
  assertSafeOutboundWebhookUrl,
  dispatchFlowWebhook,
  dispatchMarketingEmail,
  dispatchZnsNotification,
  registerZnsDispatcher,
  setFlowWebhookTransportForTesting,
  setZnsDispatcherForTesting,
} from './dispatchers.ts';
import { ensureZnsDispatcherRegistered } from '../../services/zalo-zns.service.ts';

ensureZnsDispatcherRegistered();

export {
  registerZnsDispatcher,
  setFlowWebhookTransportForTesting,
  setZnsDispatcherForTesting,
};

// ============================================================================
// 15 Triggers × 11 Action/Condition Nodes Catalog
// ============================================================================
export const FLOW_15_TRIGGERS = [
  { key: 'form_submitted', label: 'Điền Form đăng ký (Form Submitted)' },
  { key: 'tag_added', label: 'Được gắn Nhãn phân loại (Tag Added)' },
  { key: 'audience_joined', label: 'Đi vào Tệp Data / Tệp Logic (Audience Joined)' },
  { key: 'stage_changed', label: 'Chuyển bước Pipeline CRM (Stage Changed)' },
  { key: 'email_opened', label: 'Mở Email chiến dịch (Email Opened)' },
  { key: 'link_clicked', label: 'Nhấn liên kết trong Email / Shortlink (Link Clicked)' },
  { key: 'survey_completed', label: 'Hoàn thành Khảo sát / Quiz (Survey Completed)' },
  { key: 'page_visited', label: 'Truy cập trang Web / Bảng giá (Page Visited)' },
  { key: 'voucher_redeemed', label: 'Nhận / Đổi mã Voucher (Voucher Redeemed)' },
  { key: 'purchase_event', label: 'Phát sinh giao dịch Mua hàng (Purchase Event)' },
  { key: 'score_threshold', label: 'Đạt ngưỡng Điểm nóng (Lead Score Threshold)' },
  { key: 'birthday', label: 'Đến ngày Sinh nhật / Kỷ niệm (Birthday)' },
  { key: 'inactivity', label: 'Ngủ đông không tương tác (Inactivity)' },
  { key: 'webhook_received', label: 'Nhận sự kiện Custom / Webhook (Webhook Received)' },
  { key: 'manual_enroll', label: 'Đưa vào kịch bản thủ công / 1 chạm (Manual Enroll)' },
] as const;

export const FLOW_EXTENDED_TRIGGER_KEYS = new Set<string>([
  ...FLOW_15_TRIGGERS.map((t) => t.key),
  'lead_created',
  'lead_assigned',
  'round_distributed',
  'lead_held_queue',
  'temperature_changed',
  'erp_event',
  'web_event',
  'web_cta_click',
  'web_scroll_depth',
  'web_pricing_intent',
  'web_engaged_session',
  'segment',
  'form',
  'survey',
  'tag',
  'purchase',
  'custom_event',
  'voucher',
  'voucher_redeem',
  'date',
  'campaign',
  'inbound_message',
  'zalo_follow',
  'ai_capture',
  'unsubscribe',
]);

export const FLOW_11_NODES = [
  { type: 'send_email', label: 'Gửi Email tự động (AWS SES / SMTP)', category: 'messaging' },
  { type: 'send_zns', label: 'Gửi tin nhắn Zalo ZNS', category: 'messaging' },
  { type: 'wait_delay', label: 'Chờ theo thời gian (Wait Delay)', category: 'control' },
  { type: 'if_else_condition', label: 'Rẽ nhánh Điều kiện (If / Else)', category: 'logic' },
  { type: 'ab_split', label: 'Phân tách ngẫu nhiên A/B (Split Test)', category: 'logic' },
  { type: 'add_remove_tag', label: 'Gắn hoặc Gỡ Nhãn (Tag)', category: 'crm' },
  { type: 'update_lead_score', label: 'Cộng / Trừ Điểm nóng (Lead Score)', category: 'crm' },
  { type: 'issue_voucher', label: 'Phát hành Mã ưu đãi Voucher cá nhân', category: 'marketing' },
  { type: 'webhook_http', label: 'Bắn Outbound HTTP Webhook', category: 'integration' },
  { type: 'notify_internal', label: 'Thông báo nội bộ cho Quản lý / Sale', category: 'internal' },
  {
    type: 'push_to_autodata_sale_round',
    label: 'Đẩy vào Vòng chia Sale Auto Data',
    category: 'cross_ecosystem',
  },
] as const;

export type FlowNodeType11 = (typeof FLOW_11_NODES)[number]['type'];

export interface FlowStepNodeDto {
  id: string;
  type: FlowNodeType11 | string;
  label?: string;
  config?: Record<string, unknown>;
  nextStepId?: string | null;
  yesStepId?: string | null;
  noStepId?: string | null;
  pathAStepId?: string | null;
  pathBStepId?: string | null;
  branches?: Array<Record<string, unknown>>;
}

export interface FlowTraceEntry {
  step_id: string;
  node_type: string;
  label: string;
  outcome: string;
  branch?: string;
  timestamp: string;
}

const STEP_TYPE_ALIASES: Record<string, string> = {
  action: 'send_email',
  send_email: 'send_email',
  wait: 'wait_delay',
  wait_delay: 'wait_delay',
  condition: 'if_else_condition',
  advanced_condition: 'if_else_condition',
  if_else_condition: 'if_else_condition',
  split_test: 'ab_split',
  ab_split: 'ab_split',
  update_tag: 'add_remove_tag',
  add_tag: 'add_remove_tag',
  add_remove_tag: 'add_remove_tag',
  list_action: 'add_remove_list',
  add_remove_list: 'add_remove_list',
  zalo_zns: 'send_zns',
  send_zns: 'send_zns',
  crm_action: 'push_to_autodata_sale_round',
  push_to_autodata_sale_round: 'push_to_autodata_sale_round',
};

export function normalizeFlowStepType(rawType: string): string {
  const cleaned = String(rawType || '').trim().toLowerCase();
  return STEP_TYPE_ALIASES[cleaned] || cleaned;
}

function normalizeFlowStepNode(raw: any): FlowStepNodeDto {
  const rawObj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const cfgPart = rawObj.cfg && typeof rawObj.cfg === 'object' ? rawObj.cfg : {};
  const configPart = rawObj.config && typeof rawObj.config === 'object' ? rawObj.config : {};
  const cfg = { ...cfgPart, ...configPart } as Record<string, unknown>;
  return {
    ...rawObj,
    id: String(rawObj.id || ''),
    type: normalizeFlowStepType(String(rawObj.type || '')),
    label: rawObj.label ? String(rawObj.label) : undefined,
    config: cfg,
    nextStepId: (rawObj.nextStepId ?? rawObj.next_step_id ?? cfg.nextStepId ?? cfg.next_step_id ?? null) as string | null,
    yesStepId: (rawObj.yesStepId ??
      rawObj.yes_step_id ??
      rawObj.trueNextStepId ??
      rawObj.true_next_step_id ??
      cfg.yesStepId ??
      cfg.yes_step_id ??
      cfg.trueNextStepId ??
      cfg.true_next_step_id ??
      null) as string | null,
    noStepId: (rawObj.noStepId ??
      rawObj.no_step_id ??
      rawObj.falseNextStepId ??
      rawObj.false_next_step_id ??
      cfg.noStepId ??
      cfg.no_step_id ??
      cfg.falseNextStepId ??
      cfg.false_next_step_id ??
      null) as string | null,
    pathAStepId: (rawObj.pathAStepId ?? rawObj.path_a_step_id ?? cfg.pathAStepId ?? cfg.path_a_step_id ?? null) as string | null,
    pathBStepId: (rawObj.pathBStepId ?? rawObj.path_b_step_id ?? cfg.pathBStepId ?? cfg.path_b_step_id ?? null) as string | null,
    branches: Array.isArray(rawObj.branches)
      ? rawObj.branches
      : Array.isArray(cfg.branches)
        ? (cfg.branches as Array<Record<string, unknown>>)
        : undefined,
  };
}

function collectReferencedStepIds(steps: FlowStepNodeDto[]): Set<string> {
  const referenced = new Set<string>();
  for (const s of steps) {
    const rawS = s as unknown as Record<string, unknown>;
    const cfg = (s.config || {}) as Record<string, unknown>;
    for (const ref of [
      s.nextStepId,
      s.yesStepId,
      s.noStepId,
      s.pathAStepId,
      s.pathBStepId,
      rawS.trueNextStepId,
      rawS.true_next_step_id,
      rawS.falseNextStepId,
      rawS.false_next_step_id,
      cfg.nextStepId,
      cfg.next_step_id,
      cfg.yesStepId,
      cfg.yes_step_id,
      cfg.noStepId,
      cfg.no_step_id,
      cfg.trueNextStepId,
      cfg.true_next_step_id,
      cfg.falseNextStepId,
      cfg.false_next_step_id,
      cfg.pathAStepId,
      cfg.path_a_step_id,
      cfg.pathBStepId,
      cfg.path_b_step_id,
    ]) {
      if (ref) referenced.add(String(ref));
    }
    if (cfg.defaultStepId) referenced.add(String(cfg.defaultStepId));
    if (cfg.default_step_id) referenced.add(String(cfg.default_step_id));
    const branches = Array.isArray(s.branches) ? s.branches : Array.isArray(cfg.branches) ? cfg.branches : [];
    for (const b of branches as Array<Record<string, unknown>>) {
      const target = b?.nextStepId ?? b?.next_step_id ?? b?.targetStepId ?? b?.stepId;
      if (target) referenced.add(String(target));
    }
  }
  return referenced;
}

const VN_TZ_OFFSET_MS = 7 * 3600_000;

function parseTimeHm(raw: unknown, fallbackH = 9, fallbackM = 0): { h: number; m: number; totalMinutes: number } {
  const parts = String(raw || '').trim().split(':');
  const h = Number.isFinite(Number(parts[0])) && parts[0] !== '' ? Math.min(23, Math.max(0, Math.floor(Number(parts[0])))) : fallbackH;
  const m = Number.isFinite(Number(parts[1])) && parts[1] !== '' ? Math.min(59, Math.max(0, Math.floor(Number(parts[1])))) : fallbackM;
  return { h, m, totalMinutes: h * 60 + m };
}

function parseDurationUnitMs(rawDuration: unknown, rawUnit: unknown, defaultDuration = 1): number {
  const hasDuration = rawDuration !== undefined && rawDuration !== null && String(rawDuration).trim() !== '';
  const parsedDur = hasDuration ? Number(rawDuration) : defaultDuration;
  const dur = Number.isFinite(parsedDur) && parsedDur >= 0 ? parsedDur : defaultDuration;
  const unit = String(rawUnit || 'hours').toLowerCase();
  if (unit === 'ms' || unit === 'millisecond' || unit === 'milliseconds') return Math.round(dur);
  if (unit === 'seconds' || unit === 'second' || unit === 'sec' || unit === 's') return Math.round(dur * 1000);
  if (unit === 'minutes' || unit === 'minute' || unit === 'min' || unit === 'm') return Math.round(dur * 60_000);
  if (unit === 'days' || unit === 'day' || unit === 'd') return Math.round(dur * 86_400_000);
  if (unit === 'weeks' || unit === 'week' || unit === 'w') return Math.round(dur * 7 * 86_400_000);
  return Math.round(dur * 3600_000);
}

/**
 * Computes exact wait delay in milliseconds supporting all 4 Flow Wait modes in Vietnam timezone (+07:00):
 * 1. Relative duration (`mode: 'duration'` — minutes/hours/days/weeks/seconds/ms)
 * 2. Exact date/time (`mode: 'until_date' | 'until_datetime'` in +07:00 VN)
 * 3. Allowed days of week + Golden hours window (`mode: 'until' | 'golden_hours' | 'window'` in +07:00 VN)
 * 4. Wait for event with timeout fallback (`mode: 'wait_event'`)
 */
export function computeWaitDelayMs(
  cfg: Record<string, unknown>,
  nowDate: Date = new Date(),
  lead?: Record<string, unknown>
): number {
  const nowMs = nowDate.getTime();
  const mode = String(cfg.mode || 'duration').toLowerCase();

  // Mode 4: Wait for event with timeout fallback
  if (mode === 'wait_event') {
    if (cfg.timeout_ms !== undefined && Number.isFinite(Number(cfg.timeout_ms))) {
      return Math.max(0, Math.round(Number(cfg.timeout_ms)));
    }
    const tDur = cfg.timeout_duration ?? cfg.timeoutDuration ?? cfg.duration ?? 24;
    const tUnit = cfg.timeout_unit ?? cfg.timeoutUnit ?? cfg.unit ?? 'hours';
    return parseDurationUnitMs(tDur, tUnit, 24);
  }

  // Mode 2: Wait until exact date/time in +07:00 VN
  if (mode === 'until_date' || mode === 'until_datetime') {
    const rawDt = String(cfg.until_datetime || cfg.untilDatetime || cfg.specificDate || cfg.specific_date || '').trim();
    if (rawDt) {
      const timePart = String(cfg.untilTime || cfg.until_time || '09:00').trim();
      let isoCandidate = rawDt;
      if (!isoCandidate.includes('T') && !isoCandidate.includes(' ')) {
        isoCandidate = `${isoCandidate}T${timePart.length === 5 ? `${timePart}:00` : timePart}`;
      } else {
        isoCandidate = isoCandidate.replace(' ', 'T');
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(isoCandidate)) {
          isoCandidate = `${isoCandidate}:00`;
        }
      }
      if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(isoCandidate)) {
        isoCandidate = `${isoCandidate}+07:00`;
      }
      const candidate = new Date(isoCandidate);
      if (Number.isFinite(candidate.getTime())) {
        return Math.max(0, candidate.getTime() - nowMs);
      }
    }
  }

  // Mode 3: Wait until allowed days of week + golden hours window (+07:00 VN)
  if (mode === 'until' || mode === 'golden_hours' || mode === 'window') {
    const rawAllowed = Array.isArray(cfg.allowed_days)
      ? cfg.allowed_days
      : Array.isArray(cfg.allowedDays)
        ? cfg.allowedDays
        : cfg.untilDay !== undefined && cfg.untilDay !== null && String(cfg.untilDay).trim() !== ''
          ? [cfg.untilDay]
          : [0, 1, 2, 3, 4, 5, 6];

    const allowedDays = new Set<number>();
    for (const d of rawAllowed) {
      const n = Number(d);
      if (Number.isInteger(n) && n >= 0 && n <= 6) allowedDays.add(n);
    }
    if (allowedDays.size === 0) {
      for (let d = 0; d <= 6; d++) allowedDays.add(d);
    }

    const rawStart = cfg.window_start ?? cfg.windowStart ?? cfg.untilTime ?? cfg.until_time ?? '08:30';
    const rawEnd = cfg.window_end ?? cfg.windowEnd ?? null;
    const startHm = parseTimeHm(rawStart, 8, 30);
    const endHm = rawEnd !== null && String(rawEnd).trim() !== '' ? parseTimeHm(rawEnd, 21, 0) : null;

    const vnNow = new Date(nowMs + VN_TZ_OFFSET_MS);
    const vnYear = vnNow.getUTCFullYear();
    const vnMonth = vnNow.getUTCMonth();
    const vnDate = vnNow.getUTCDate();
    const vnDow = vnNow.getUTCDay();
    const vnCurMinutes = vnNow.getUTCHours() * 60 + vnNow.getUTCMinutes();

    // If golden hours window (`window_start`..`window_end`) is set & currently inside allowed day + window -> 0ms!
    if (endHm && allowedDays.has(vnDow) && vnCurMinutes >= startHm.totalMinutes && vnCurMinutes <= endHm.totalMinutes) {
      return 0;
    }

    for (let offsetDays = 0; offsetDays <= 7; offsetDays++) {
      const candidateDow = (vnDow + offsetDays) % 7;
      if (!allowedDays.has(candidateDow)) continue;
      const targetUtcMs =
        Date.UTC(vnYear, vnMonth, vnDate + offsetDays, startHm.h, startHm.m, 0, 0) - VN_TZ_OFFSET_MS;
      if (targetUtcMs > nowMs) {
        return Math.max(0, targetUtcMs - nowMs);
      }
    }
  }

  // Legacy Mode: Wait until contact attribute date (birthday / anniversary / joined_at)
  if (mode === 'until_attribute' && lead) {
    const attrKey = String(cfg.attributeKey || cfg.attribute_key || 'date_of_birth');
    const rawVal = String(resolveLeadFieldValue(lead, attrKey) || '').trim();
    if (rawVal) {
      const vnNow = new Date(nowMs + VN_TZ_OFFSET_MS);
      const offsetType = String(cfg.offsetType || 'on');
      const offsetDays = Math.max(0, Math.min(365, Math.floor(Number(cfg.offsetValue || 0))));
      const mmDdMatch = rawVal.match(/(\d{2})-(\d{2})$/) || rawVal.match(/^\d{4}-(\d{2})-(\d{2})/);
      if (mmDdMatch) {
        const month = Number(mmDdMatch[1]) - 1;
        const day = Number(mmDdMatch[2]);
        const sign = offsetType === 'before' ? -1 : offsetType === 'after' ? 1 : 0;
        let targetUtcMs =
          Date.UTC(vnNow.getUTCFullYear(), month, day + sign * offsetDays, 9, 0, 0, 0) - VN_TZ_OFFSET_MS;
        if (targetUtcMs <= nowMs) {
          targetUtcMs =
            Date.UTC(vnNow.getUTCFullYear() + 1, month, day + sign * offsetDays, 9, 0, 0, 0) - VN_TZ_OFFSET_MS;
        }
        if (Number.isFinite(targetUtcMs)) {
          return Math.max(0, targetUtcMs - nowMs);
        }
      }
    }
  }

  // Mode 1: Relative duration
  return parseDurationUnitMs(cfg.duration, cfg.unit, 1);
}

function resolveLeadFieldValue(lead: Record<string, unknown>, rawField: string): unknown {
  const field = String(rawField || 'lead_score').trim();
  const fieldLower = field.toLowerCase();
  const cf = parseJsonCol<Record<string, unknown>>(lead.custom_fields, {});

  if (fieldLower.startsWith('custom_fields.') || fieldLower.startsWith('cf.') || fieldLower.startsWith('custom.')) {
    const cfKey = field.replace(/^(?:custom_fields|cf|custom)\./i, '').trim();
    if (['birthday', 'dob', 'dateofbirth', 'date_of_birth', 'ngay_sinh'].includes(cfKey.toLowerCase())) {
      return cf[cfKey] ?? cf.birthday ?? cf.dob ?? cf.dateOfBirth ?? cf.date_of_birth ?? cf.ngay_sinh ?? '';
    }
    return cf[cfKey];
  }
  if (['birthday', 'dob', 'dateofbirth', 'date_of_birth', 'anniversarydate', 'anniversary_date', 'ngay_sinh'].includes(fieldLower)) {
    return cf.birthday ?? cf.dob ?? cf.dateOfBirth ?? cf.date_of_birth ?? cf.anniversaryDate ?? cf.anniversary_date ?? cf.ngay_sinh ?? '';
  }
  if (fieldLower === 'joined_at' || fieldLower === 'joinedat') {
    return lead.created_at ?? '';
  }
  if (fieldLower === 'quiz_score' || fieldLower === 'survey_score') {
    return lead.quiz_score ?? lead.nps_score ?? cf.quiz_score ?? cf.score ?? 0;
  }
  if (fieldLower === 'nps_score') {
    return lead.nps_score ?? cf.nps_score ?? 0;
  }
  if (fieldLower === 'firstname' || fieldLower === 'first_name') {
    return cf.first_name ?? cf.firstName ?? lead.name ?? '';
  }
  if (fieldLower === 'lastname' || fieldLower === 'last_name') {
    return cf.last_name ?? cf.lastName ?? lead.name ?? '';
  }
  if (fieldLower === 'phonenumber' || fieldLower === 'phone_number' || fieldLower === 'phone') {
    return lead.phone ?? lead.phone_number ?? '';
  }
  if (fieldLower === 'crm_stage_id' || fieldLower === 'crm_stage_is' || fieldLower === 'stage_id') {
    return lead.stage_id ?? lead.stage_key ?? lead.stage_name ?? '';
  }
  if (fieldLower === 'crm_team_id' || fieldLower === 'round_id' || fieldLower === 'distribution_round_id') {
    return lead.distribution_round_id ?? lead.round_id ?? cf.team_id ?? '';
  }
  if (fieldLower === 'crm_lead_status' || fieldLower === 'status') {
    return lead.status ?? lead.lifecycle_stage ?? '';
  }
  if (fieldLower === 'crm_temperature' || fieldLower === 'crm_temperature_is') {
    return cf.temperature ?? lead.quality_status ?? (Number(lead.lead_score || 0) >= 70 ? 'hot' : Number(lead.lead_score || 0) >= 30 ? 'warm' : 'cold');
  }
  if (
    fieldLower === 'crm_owner_id' ||
    fieldLower === 'salesperson' ||
    fieldLower === 'crm_assigned_to' ||
    fieldLower === 'assigned_to' ||
    fieldLower === 'assigned_to_user_id'
  ) {
    return lead.assigned_to ?? '';
  }
  if (fieldLower === 'crm_sale_contacted') {
    return Boolean(lead.crm_sale_contacted ?? cf.sale_contacted);
  }
  if (fieldLower === 'crm_hours_uncontacted' || fieldLower === 'erp_sla_uncontacted_hours') {
    if (lead.crm_hours_uncontacted !== undefined) return Number(lead.crm_hours_uncontacted);
    const refTs = lead.last_engaged_at || lead.created_at;
    if (!refTs) return 0;
    const diffH = (Date.now() - new Date(String(refTs)).getTime()) / 3600_000;
    return Number.isFinite(diffH) ? Math.max(0, Math.round(diffH * 10) / 10) : 0;
  }
  if (fieldLower === 'crm_deposit_status') {
    if (lead.crm_deposit_status) return lead.crm_deposit_status;
    return Number(lead.total_revenue_vnd || 0) > 0 ? 'approved' : 'none';
  }
  if (fieldLower === 'crm_deposit_amount' || fieldLower === 'erp_deal_value' || fieldLower === 'crm_expected_revenue' || fieldLower === 'total_revenue_vnd') {
    return lead.total_revenue_vnd ?? cf.deal_value ?? 0;
  }
  if (fieldLower === 'leadscore' || fieldLower === 'lead_score' || fieldLower === 'score') {
    return lead.lead_score ?? 0;
  }
  if (fieldLower === 'lastactivitydays' || fieldLower === 'inactive_days' || fieldLower === 'days_since_engaged') {
    const refTs = lead.last_engaged_at || lead.updated_at || lead.created_at;
    if (!refTs) return 0;
    const diffMs = Date.now() - new Date(String(refTs)).getTime();
    return Number.isFinite(diffMs) ? Math.max(0, Math.floor(diffMs / 86_400_000)) : 0;
  }
  if (fieldLower === 'crm_program' || fieldLower === 'product_interest') {
    return lead.product_interest ?? '';
  }
  if (fieldLower === 'source' || fieldLower === 'lead_source') {
    return lead.source ?? '';
  }
  if (fieldLower === 'campaign' || fieldLower === 'utm_campaign') {
    return lead.campaign ?? lead.utm_campaign ?? cf.utm_campaign ?? '';
  }
  if (fieldLower === 'utm_source') {
    return lead.utm_source ?? cf.utm_source ?? '';
  }
  if (fieldLower === 'utm_medium') {
    return lead.utm_medium ?? cf.utm_medium ?? '';
  }
  if (fieldLower === 'has_email') {
    return Boolean(lead.email && String(lead.email).trim().length > 0 && lead.email_consent !== 'unsubscribed');
  }
  if (fieldLower === 'has_phone') {
    return Boolean(lead.phone && String(lead.phone).trim().length > 0);
  }
  if (fieldLower === 'tags' || fieldLower === 'tag') {
    return Array.isArray(lead.tags) ? lead.tags : [];
  }
  if (fieldLower === 'list_id' || fieldLower === 'audience_id' || fieldLower === 'segment_id' || fieldLower === 'audiences') {
    return Array.isArray(lead.audiences) ? lead.audiences : [];
  }
  if (fieldLower === 'web_page_visited' || fieldLower === 'url_contains') {
    return Array.isArray(lead.visited_urls) ? lead.visited_urls : [];
  }
  if (fieldLower === 'web_cta_clicked' || fieldLower === 'element_text_contains' || fieldLower === 'cta_text_contains') {
    return Array.isArray(lead.clicked_texts) ? lead.clicked_texts : [];
  }
  if (fieldLower === 'web_max_scroll_pct' || fieldLower === 'max_scroll_pct' || fieldLower === 'scroll_depth_pct') {
    return Number(lead.max_scroll_pct ?? 0);
  }
  if (fieldLower === 'web_active_duration_sec' || fieldLower === 'active_duration_seconds' || fieldLower === 'min_duration_sec') {
    return Number(lead.active_duration_seconds ?? 0);
  }
  if (fieldLower === 'web_pricing_intent' || fieldLower === 'pricing_intent') {
    return Boolean(lead.pricing_intent);
  }
  if (fieldLower === 'email_opened') {
    return Boolean(lead.email_opened);
  }
  if (fieldLower === 'email_clicked') {
    return Boolean(lead.email_clicked);
  }
  if (fieldLower === 'zns_delivered') {
    return Boolean(lead.zns_delivered);
  }
  if (fieldLower === 'voucher_claimed') {
    return Boolean(lead.voucher_claimed);
  }
  if (fieldLower === 'voucher_redeemed') {
    return Boolean(lead.voucher_redeemed);
  }
  return lead[field] !== undefined ? lead[field] : cf[field];
}

function evaluateSingleConditionRule(
  lead: Record<string, unknown>,
  rule: Record<string, unknown>
): boolean {
  // Handle simple `ConditionConfig.tsx` behavioral / CRM conditionType rules directly (1:1 mapping)
  const rawCondType = rule.conditionType ? String(rule.conditionType).trim().toLowerCase() : '';
  if (rawCondType && !rule.field) {
    if (rawCondType === 'crm_sale_contacted') {
      return Boolean(lead.crm_sale_contacted);
    }
    if (rawCondType === 'crm_assigned_to') {
      const mode = String(rule.assignMatchMode || (rule.targetOwnerId || rule.owner_id ? 'specific_owner' : rule.targetTeamId || rule.round_id ? 'specific_team' : 'any_assigned'));
      if (mode === 'any_assigned') return Boolean(lead.assigned_to);
      if (mode === 'specific_owner') {
        const target = String(rule.targetOwnerId || rule.owner_id || rule.assigned_to || '').trim().toLowerCase();
        return Boolean(target && String(lead.assigned_to || '').trim().toLowerCase() === target);
      }
      if (mode === 'specific_team') {
        const target = String(rule.targetTeamId || rule.round_id || rule.team_id || '').trim().toLowerCase();
        const leadRound = String(lead.distribution_round_id || lead.round_id || '').trim().toLowerCase();
        return Boolean(target && leadRound === target);
      }
      return Boolean(lead.assigned_to);
    }
    if (rawCondType === 'crm_stage_is') {
      const target = String(rule.targetStageId || rule.stageId || rule.stage_id || rule.value || '').trim().toLowerCase();
      if (!target) return Boolean(lead.stage_id);
      return [lead.stage_id, lead.stage_key, lead.stage_name]
        .filter(Boolean)
        .some((v) => String(v).trim().toLowerCase() === target);
    }
    if (rawCondType === 'crm_temperature_is') {
      const target = String(rule.targetTemperature || rule.temperature || rule.value || 'hot').trim().toLowerCase();
      const actualTemp = String(resolveLeadFieldValue(lead, 'crm_temperature') || '').trim().toLowerCase();
      return actualTemp === target;
    }
    if (rawCondType === 'deposit_paid') {
      return Boolean(lead.deposit_paid) || String(lead.crm_deposit_status || '') === 'approved' || Number(lead.total_revenue_vnd || 0) > 0;
    }
    if (rawCondType === 'channel_reachability') {
      const ch = String(rule.channelType || 'has_zalo').toLowerCase();
      if (ch === 'has_email') return Boolean(lead.email && String(lead.email).trim() && lead.email_consent !== 'unsubscribed');
      if (ch === 'has_phone') return Boolean(lead.phone && String(lead.phone).trim());
      return Boolean(lead.phone && String(lead.phone).trim() && lead.zns_consent !== 'opted_out');
    }
    if (rawCondType === 'opened' || rawCondType === 'opened_reminder') {
      const targetStepId = rule.targetStepId && !rule.any_campaign ? String(rule.targetStepId) : null;
      const openedSteps = Array.isArray(lead.email_opened_steps) ? lead.email_opened_steps.map(String) : [];
      if (targetStepId && openedSteps.length > 0) {
        return openedSteps.includes(targetStepId) || Boolean(lead.email_opened);
      }
      return Boolean(lead.email_opened);
    }
    if (rawCondType === 'clicked' || rawCondType === 'clicked_specific') {
      const targets: string[] = Array.isArray(rule.linkTargets)
        ? rule.linkTargets.map(String).filter(Boolean)
        : rule.linkTarget
          ? [String(rule.linkTarget)]
          : [];
      if (targets.length > 0) {
        const urls = Array.isArray(lead.clicked_urls) ? lead.clicked_urls.map((u) => String(u).toLowerCase()) : [];
        return targets.some((t) => urls.some((u) => u.includes(t.toLowerCase())));
      }
      return Boolean(lead.email_clicked);
    }
    if (rawCondType === 'delivered' || rawCondType === 'received_reminder') {
      return Boolean(lead.email_delivered || lead.email_opened || lead.email_clicked);
    }
    if (rawCondType === 'zalo_interacted') {
      return Boolean(lead.zns_delivered || lead.zns_clicked || lead.zns_sent);
    }
    if (rawCondType === 'zns_delivered') return Boolean(lead.zns_delivered || lead.zns_sent);
    if (rawCondType === 'zns_clicked' || rawCondType === 'zns_replied') return Boolean(lead.zns_clicked);
    if (rawCondType === 'zns_failed') return Boolean(lead.zns_failed);
    if (rawCondType === 'survey_completed') return Boolean(lead.survey_completed);
    if (rawCondType === 'survey_score') {
      const actualScore = Number(lead.quiz_score ?? lead.nps_score ?? 0);
      const expectedScore = Number(rule.scoreValue ?? rule.value ?? 0);
      const sop = String(rule.scoreOperator || '>=');
      if (sop === '>=') return actualScore >= expectedScore;
      if (sop === '<=') return actualScore <= expectedScore;
      if (sop === '>') return actualScore > expectedScore;
      if (sop === '<') return actualScore < expectedScore;
      return actualScore === expectedScore;
    }
    if (rawCondType === 'voucher_claimed') return Boolean(lead.voucher_claimed || lead.voucher_redeemed);
    if (rawCondType === 'unsubscribed') return String(lead.email_consent || '') === 'unsubscribed';
    if (rawCondType === 'web_page_visited') {
      const needle = String(rule.url_contains || rule.urlContains || rule.value || '').trim().toLowerCase();
      const urls = Array.isArray(lead.visited_urls) ? lead.visited_urls.map((u) => String(u).toLowerCase()) : [];
      return needle ? urls.some((u) => u.includes(needle)) : urls.length > 0;
    }
    if (rawCondType === 'web_cta_clicked') {
      const needle = String(rule.element_text_contains || rule.cta_text_contains || rule.value || '').trim().toLowerCase();
      const texts = Array.isArray(lead.clicked_texts) ? lead.clicked_texts.map((t) => String(t).toLowerCase()) : [];
      return needle ? texts.some((t) => t.includes(needle)) : texts.length > 0;
    }
    if (rawCondType === 'web_scroll_depth') {
      const minPct = Number(rule.min_scroll_pct ?? rule.value ?? 75);
      return Number(lead.max_scroll_pct ?? 0) >= minPct;
    }
    if (rawCondType === 'web_active_duration') {
      const minSec = Number(rule.min_duration_sec ?? rule.value ?? 30);
      return Number(lead.active_duration_seconds ?? 0) >= minSec;
    }
  }

  const field = String(rule.field || rule.conditionType || 'lead_score').trim();
  const fieldLower = field.toLowerCase();
  const op = String(rule.operator || rule.op || 'gte').trim().toLowerCase();
  const expected = rule.value !== undefined ? rule.value : rule.val;
  const actual = resolveLeadFieldValue(lead, field);

  if (fieldLower === 'crm_stage_id' || fieldLower === 'stage_id') {
    const expLower = String(expected ?? '').trim().toLowerCase();
    const candidates = [lead.stage_id, lead.stage_key, lead.stage_name]
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
      .map((v) => String(v).trim().toLowerCase());
    if (op === 'is_empty' || op === 'empty') return candidates.length === 0;
    if (op === 'is_not_empty' || op === 'not_empty') return candidates.length > 0;
    if (op === 'contains') return candidates.some((c) => c.includes(expLower));
    if (op === 'not_contains') return !candidates.some((c) => c.includes(expLower));
    const exactMatch = candidates.includes(expLower);
    if (op === 'neq' || op === '!=' || op === 'is_not' || op === 'not_equals') return !exactMatch;
    return exactMatch;
  }

  if (fieldLower === 'channel_available') {
    const expLower = String(expected ?? '').trim().toLowerCase();
    const matched =
      expLower === 'zalo_oa' || expLower === 'has_zalo'
        ? Boolean(lead.phone && String(lead.phone).trim() && lead.zns_consent !== 'opted_out')
        : expLower === 'email_valid' || expLower === 'has_email'
          ? Boolean(lead.email && String(lead.email).trim() && lead.email_consent !== 'unsubscribed')
          : expLower === 'phone_valid' || expLower === 'has_phone'
            ? Boolean(lead.phone && String(lead.phone).trim())
            : false;
    return op === 'neq' || op === '!=' || op === 'is_not' || op === 'not_equals' ? !matched : matched;
  }

  if (fieldLower === 'activity_history' || op === 'has_done' || op === 'not_has_done') {
    const expLower = String(expected ?? '').trim().toLowerCase();
    const done =
      expLower === 'opened_email' || expLower === 'email_opened'
        ? Boolean(lead.email_opened)
        : expLower === 'clicked_link' || expLower === 'email_clicked'
          ? Boolean(lead.email_clicked)
          : expLower === 'received_zns' || expLower === 'zns_delivered'
            ? Boolean(lead.zns_delivered || lead.zns_sent)
            : expLower === 'submitted_form' || expLower === 'form_submitted'
              ? Boolean(lead.form_submitted)
              : expLower === 'purchased' || expLower === 'purchase_event'
                ? Boolean(lead.purchased || Number(lead.total_revenue_vnd || 0) > 0)
                : expLower === 'visited_pricing' || expLower === 'pricing_intent'
                  ? Boolean(lead.pricing_intent)
                  : expLower === 'claimed_voucher' || expLower === 'voucher_claimed'
                    ? Boolean(lead.voucher_claimed || lead.voucher_redeemed)
                    : false;
    return op === 'not_has_done' || op === 'not_equals' || op === 'neq' ? !done : done;
  }

  if (op === 'has_tag' || op === 'not_has_tag') {
    const arr = Array.isArray(actual) ? actual.map((x) => String(x).trim().toLowerCase()) : [];
    const targetLower = String(expected || '').trim().toLowerCase();
    const hasIt = targetLower ? arr.some((x) => x === targetLower || x.includes(targetLower)) : arr.length > 0;
    return op === 'not_has_tag' ? !hasIt : hasIt;
  }

  if (fieldLower === 'crm_lead_status') {
    const normStatus = String(lead.status || '').toLowerCase();
    const expLower = String(expected || '').toLowerCase();
    const matched =
      expLower === 'active'
        ? normStatus === 'assigned' || normStatus === 'unassigned_pending'
        : expLower === 'nurture'
          ? normStatus === 'marketing_nurture'
          : expLower === 'lost'
            ? normStatus === 'archived' || normStatus === 'rejected' || normStatus === 'blacklisted'
            : normStatus === expLower;
    return op === 'is_not' || op === 'neq' || op === '!=' || op === 'not_equals' ? !matched : matched;
  }

  // Birthday / Anniversary operators (`is_today`, `is_this_month`, `before_days`, `on`, `before`, `after`)
  if (['is_today', 'is_this_month', 'before_days', 'on', 'before', 'after'].includes(op)) {
    const actualStr = String(actual || '').trim();
    if (!actualStr) return false;
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const actualMmDd = actualStr.length >= 10 ? actualStr.slice(5, 10) : actualStr.slice(0, 5);
    const actualMm = actualStr.length >= 7 ? actualStr.slice(5, 7) : actualStr.slice(0, 2);

    if (op === 'is_today') {
      const todayMmDd = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      return actualMmDd === todayMmDd;
    }
    if (op === 'is_this_month') {
      const todayMm = pad2(now.getMonth() + 1);
      return actualMm === todayMm;
    }
    if (op === 'before_days') {
      const days = Math.max(0, Math.min(365, Math.floor(Number(expected ?? 0))));
      for (let i = 0; i <= days; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        if (`${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` === actualMmDd) return true;
      }
      return false;
    }
    const expStr = String(expected || '').trim();
    if (!expStr) return false;
    if (op === 'before') return actualStr.slice(0, 10) < expStr.slice(0, 10);
    if (op === 'after') return actualStr.slice(0, 10) > expStr.slice(0, 10);
    return /^\d{2}-\d{2}$/.test(expStr) ? actualMmDd === expStr : actualStr.slice(0, 10) === expStr.slice(0, 10);
  }

  if (op === 'is_empty' || op === 'empty') {
    if (Array.isArray(actual)) return actual.length === 0;
    return actual === null || actual === undefined || String(actual).trim().length === 0;
  }
  if (op === 'is_not_empty' || op === 'not_empty') {
    if (Array.isArray(actual)) return actual.length > 0;
    return actual !== null && actual !== undefined && String(actual).trim().length > 0;
  }
  if (op === 'is_true' || op === 'true') return Boolean(actual) && String(actual).toLowerCase() !== 'false';
  if (op === 'is_false' || op === 'false') return !actual || String(actual).toLowerCase() === 'false';
  if (op === 'between') {
    const minV = Number(rule.min ?? (Array.isArray(expected) ? expected[0] : 0));
    const maxV = Number(rule.max ?? (Array.isArray(expected) ? expected[1] : 0));
    const n = Number(actual || 0);
    return Number.isFinite(n) && n >= minV && n <= maxV;
  }
  if (op === 'gte' || op === '>=') return Number(actual || 0) >= Number(expected || 0);
  if (op === 'gt' || op === '>' || op === 'greater_than') return Number(actual || 0) > Number(expected || 0);
  if (op === 'lte' || op === '<=') return Number(actual || 0) <= Number(expected || 0);
  if (op === 'lt' || op === '<' || op === 'less_than') return Number(actual || 0) < Number(expected || 0);
  if (op === 'contains') {
    if (Array.isArray(actual)) {
      const targetLower = String(expected || '').toLowerCase();
      return actual.some((x) => String(x).toLowerCase() === targetLower || String(x).toLowerCase().includes(targetLower));
    }
    return String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase());
  }
  if (op === 'not_contains') {
    if (Array.isArray(actual)) {
      const targetLower = String(expected || '').toLowerCase();
      return !actual.some((x) => String(x).toLowerCase() === targetLower || String(x).toLowerCase().includes(targetLower));
    }
    return !String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase());
  }
  if (op === 'starts_with') {
    if (Array.isArray(actual)) {
      const targetLower = String(expected || '').toLowerCase();
      return actual.some((x) => String(x).toLowerCase().startsWith(targetLower));
    }
    return String(actual || '').toLowerCase().startsWith(String(expected || '').toLowerCase());
  }
  if (op === 'ends_with') {
    if (Array.isArray(actual)) {
      const targetLower = String(expected || '').toLowerCase();
      return actual.some((x) => String(x).toLowerCase().endsWith(targetLower));
    }
    return String(actual || '').toLowerCase().endsWith(String(expected || '').toLowerCase());
  }
  if (op === 'in' || op === 'in_list') {
    const arr = Array.isArray(expected)
      ? expected.map((v) => String(v).trim().toLowerCase())
      : String(expected || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (Array.isArray(actual)) {
      return actual.some((a) => arr.includes(String(a ?? '').trim().toLowerCase()));
    }
    return arr.includes(String(actual ?? '').trim().toLowerCase());
  }
  if (op === 'not_in' || op === 'not_in_list') {
    const arr = Array.isArray(expected)
      ? expected.map((v) => String(v).trim().toLowerCase())
      : String(expected || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (Array.isArray(actual)) {
      return !actual.some((a) => arr.includes(String(a ?? '').trim().toLowerCase()));
    }
    return !arr.includes(String(actual ?? '').trim().toLowerCase());
  }
  if (op === 'neq' || op === '!=' || op === 'is_not' || op === 'not_equals') {
    if (Array.isArray(actual)) {
      const expLower = String(expected ?? '').trim().toLowerCase();
      return !actual.some((x) => String(x).trim().toLowerCase() === expLower);
    }
    return String(actual ?? '').toLowerCase() !== String(expected ?? '').toLowerCase();
  }
  if (Array.isArray(actual)) {
    const expLower = String(expected ?? '').trim().toLowerCase();
    return actual.some((x) => String(x).trim().toLowerCase() === expLower);
  }
  return String(actual ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
}

export function evaluateConditionOnLead(
  lead: Record<string, unknown>,
  config: Record<string, unknown>
): boolean {
  const groupObj =
    config.conditionGroup && typeof config.conditionGroup === 'object'
      ? (config.conditionGroup as Record<string, unknown>)
      : null;
  if (groupObj) {
    const conds = Array.isArray(groupObj.conditions)
      ? (groupObj.conditions as Array<Record<string, unknown>>)
      : Array.isArray(groupObj.rules)
        ? (groupObj.rules as Array<Record<string, unknown>>)
        : null;
    if (conds) {
      const logic = String(groupObj.logic || (groupObj.matchType === 'any' ? 'OR' : 'AND')).toUpperCase();
      if (conds.length === 0) return false;
      return logic === 'OR'
        ? conds.some((c) => evaluateConditionOnLead(lead, c))
        : conds.every((c) => evaluateConditionOnLead(lead, c));
    }
  }
  const directList = Array.isArray(config.conditions)
    ? (config.conditions as Array<Record<string, unknown>>)
    : Array.isArray(config.rules)
      ? (config.rules as Array<Record<string, unknown>>)
      : null;
  if (directList) {
    const logic = String(config.logic || (config.matchType === 'any' ? 'OR' : 'AND')).toUpperCase();
    if (directList.length === 0) return false;
    return logic === 'OR'
      ? directList.some((c) => evaluateConditionOnLead(lead, c))
      : directList.every((c) => evaluateConditionOnLead(lead, c));
  }
  return evaluateSingleConditionRule(lead, config);
}

export function resolveConditionNextStep(
  lead: Record<string, unknown>,
  step: FlowStepNodeDto
): { matched: boolean; branchLabel: string; nextId: string | null | undefined } {
  const cfg = (step.config || {}) as Record<string, unknown>;
  const branches = Array.isArray(step.branches)
    ? step.branches
    : Array.isArray(cfg.branches)
      ? (cfg.branches as Array<Record<string, unknown>>)
      : null;

  if (branches && branches.length > 0) {
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i];
      if (evaluateConditionOnLead(lead, b)) {
        const nextId = (b.nextStepId ?? b.next_step_id ?? b.targetStepId ?? b.stepId ?? step.yesStepId) as string | null | undefined;
        return { matched: true, branchLabel: String(b.label || b.name || `branch_${i + 1}`), nextId };
      }
    }
    const fallbackId = (cfg.defaultStepId ?? cfg.default_step_id ?? step.noStepId ?? step.nextStepId) as string | null | undefined;
    return { matched: false, branchLabel: 'default', nextId: fallbackId };
  }

  const matched = evaluateConditionOnLead(lead, cfg);
  return {
    matched,
    branchLabel: matched ? 'yes' : 'no',
    nextId: matched ? step.yesStepId : step.noStepId,
  };
}

/**
 * Dry-Run Path Simulator (`FlowSimulateModal`) — zero DB writes
 */
export function simulateFlowExecution(
  rawSteps: FlowStepNodeDto[],
  sampleLead: Record<string, unknown>
): {
  trace: FlowTraceEntry[];
  finalLeadState: Record<string, unknown>;
  wouldPushToSaleRound: boolean;
  targetSaleRoundId: string | null;
} {
  const steps = (Array.isArray(rawSteps) ? rawSteps : []).map(normalizeFlowStepNode);
  const stepMap = new Map<string, FlowStepNodeDto>();
  for (const s of steps) {
    if (s && s.id) stepMap.set(s.id, s);
  }

  const referencedTargets = collectReferencedStepIds(steps);
  const rootStep = steps.find((s) => !referencedTargets.has(s.id)) || steps[0];

  const simLead: Record<string, unknown> = {
    name: sampleLead.name || 'Nguyễn Văn Thử Nghiệm',
    phone: sampleLead.phone || '0909123456',
    email: sampleLead.email || 'demo@company.vn',
    status: sampleLead.status || 'marketing_nurture',
    lifecycle_stage: sampleLead.lifecycle_stage || 'subscriber',
    lead_score: Number(sampleLead.lead_score ?? 25),
    email_consent: sampleLead.email_consent || 'subscribed',
    total_revenue_vnd: Number(sampleLead.total_revenue_vnd ?? 0),
    tags: Array.isArray(sampleLead.tags) ? [...sampleLead.tags] : [],
    custom_fields:
      sampleLead.custom_fields && typeof sampleLead.custom_fields === 'object'
        ? { ...(sampleLead.custom_fields as Record<string, unknown>) }
        : {},
  };

  const trace: FlowTraceEntry[] = [];
  let wouldPushToSaleRound = false;
  let targetSaleRoundId: string | null = null;
  const visited = new Set<string>();
  let current: FlowStepNodeDto | undefined = rootStep;

  while (current && !visited.has(current.id) && trace.length < 40) {
    visited.add(current.id);
    const cfg = (current.config || {}) as Record<string, unknown>;
    const normType = normalizeFlowStepType(String(current.type));
    const label = current.label || normType;
    const nowIso = new Date().toISOString();

    if (normType === 'trigger') {
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: 'Kích hoạt quy trình',
        timestamp: nowIso,
      });
      current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
      continue;
    }

    if (normType === 'if_else_condition') {
      const condRes = resolveConditionNextStep(simLead, current);
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: condRes.matched
          ? `Thỏa điều kiện -> Nhánh ${condRes.branchLabel.toUpperCase()}`
          : `Không thỏa -> Nhánh ${condRes.branchLabel.toUpperCase()}`,
        branch: condRes.branchLabel,
        timestamp: nowIso,
      });
      current = condRes.nextId ? stepMap.get(condRes.nextId) : undefined;
      continue;
    }

    if (normType === 'ab_split') {
      const rawRatioA =
        cfg.ratio_a ??
        cfg.ratioA ??
        (cfg.ratio_b !== undefined
          ? 100 - Number(cfg.ratio_b)
          : cfg.ratioB !== undefined
            ? 100 - Number(cfg.ratioB)
            : 50);
      const ratioA = Math.min(95, Math.max(5, Number(rawRatioA)));
      const seedStr = `${simLead.email || simLead.phone || 'seed'}:${current.id}`;
      const hashByte = crypto.createHash('md5').update(seedStr).digest()[0];
      const bucket = Math.floor((hashByte / 256) * 100);
      const branch = bucket < ratioA ? 'A' : 'B';
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: `Phân luồng A/B (${ratioA}/${100 - ratioA}) -> Nhánh ${branch}`,
        branch,
        timestamp: nowIso,
      });
      const nextId: string | null | undefined = branch === 'A' ? current.pathAStepId : current.pathBStepId;
      current = nextId ? stepMap.get(nextId) : undefined;
      continue;
    }

    if (normType === 'update_lead_score') {
      const delta = Number(cfg.delta ?? cfg.points ?? 10);
      simLead.lead_score = Number(simLead.lead_score || 0) + delta;
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: `Cập nhật Lead Score (${delta >= 0 ? `+${delta}` : delta}) -> ${simLead.lead_score} điểm`,
        timestamp: nowIso,
      });
    } else if (normType === 'add_remove_tag') {
      const tagList = Array.isArray(cfg.tags)
        ? cfg.tags.map((t) => String(t).trim()).filter(Boolean)
        : [String(cfg.tag || 'VIP').trim()].filter(Boolean);
      const mode = (cfg.mode ?? cfg.action) === 'remove' ? 'remove' : 'add';
      let arr = Array.isArray(simLead.tags) ? ([...simLead.tags] as string[]) : [];
      for (const tag of tagList) {
        if (mode === 'add' && !arr.includes(tag)) arr.push(tag);
        if (mode === 'remove') arr = arr.filter((t) => t !== tag);
      }
      simLead.tags = arr;
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: `${mode === 'add' ? 'Gắn nhãn' : 'Gỡ nhãn'} "${tagList.join(', ')}"`,
        timestamp: nowIso,
      });
    } else if (normType === 'add_remove_list') {
      const audId = cfg.audience_id || cfg.audienceId || cfg.list_id || cfg.listId || '';
      const mode = (cfg.mode ?? cfg.action) === 'remove' ? 'remove' : 'add';
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: `${mode === 'add' ? 'Thêm vào' : 'Gỡ khỏi'} danh sách ${audId || '(chưa chọn)'}`,
        timestamp: nowIso,
      });
    } else if (normType === 'push_to_autodata_sale_round') {
      wouldPushToSaleRound = true;
      targetSaleRoundId = cfg.round_id || cfg.roundId || cfg.team_id ? String(cfg.round_id || cfg.roundId || cfg.team_id) : null;
      simLead.status = 'unassigned_pending';
      simLead.lifecycle_stage = 'mql';
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: `Chuyển trạng thái marketing_nurture -> unassigned_pending & đẩy sang Vòng chia Sale Auto Data`,
        timestamp: nowIso,
      });
    } else if (normType === 'wait_delay') {
      const dur = Number(cfg.duration || 1);
      const unit = String(cfg.unit || 'hours');
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: `Tạm chờ ${dur} ${unit} trước bước kế tiếp`,
        timestamp: nowIso,
      });
    } else {
      trace.push({
        step_id: current.id,
        node_type: normType,
        label,
        outcome: `Thực thi thành công node ${normType}`,
        timestamp: nowIso,
      });
    }

    current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
  }

  return { trace, finalLeadState: simLead, wouldPushToSaleRound, targetSaleRoundId };
}

/**
 * DOM Agent Flow Auditor (`FlowReviewModal`)
 */
export function auditFlowWithDomAgent(
  triggerType: string,
  rawSteps: FlowStepNodeDto[]
): {
  score: number;
  grade: 'Xuất sắc' | 'Tốt' | 'Cần lưu ý';
  findings: Array<{ severity: 'error' | 'warning' | 'tip'; message: string; stepId?: string }>;
} {
  const steps = (Array.isArray(rawSteps) ? rawSteps : []).map(normalizeFlowStepNode);
  const findings: Array<{ severity: 'error' | 'warning' | 'tip'; message: string; stepId?: string }> = [];
  let score = 100;

  if (!FLOW_EXTENDED_TRIGGER_KEYS.has(triggerType)) {
    score -= 20;
    findings.push({ severity: 'error', message: `Trigger "${triggerType}" không thuộc danh mục Triggers chuẩn.` });
  }

  if (steps.length === 0) {
    score -= 40;
    findings.push({ severity: 'error', message: 'Kịch bản chưa có bất kỳ Node hành động nào.' });
  }

  const stepMap = new Map(steps.map((s) => [s.id, s]));
  let hasSaleHandoff = false;

  for (const step of steps) {
    const cfg = (step.config || {}) as Record<string, unknown>;
    const normType = normalizeFlowStepType(String(step.type));
    if (normType === 'push_to_autodata_sale_round') {
      hasSaleHandoff = true;
    }
    if (normType === 'send_email' && !cfg.template_id && !cfg.templateId && !cfg.subject && !cfg.customHtml && !cfg.contentBody) {
      score -= 15;
      findings.push({
        severity: 'warning',
        stepId: step.id,
        message: `Node gửi Email "${step.label || step.id}" chưa chọn mẫu Email hoặc tiêu đề.`,
      });
    }
    if (
      (normType === 'send_email' || normType === 'send_zns') &&
      step.nextStepId &&
      normalizeFlowStepType(String(stepMap.get(step.nextStepId)?.type || '')) === normType
    ) {
      score -= 15;
      findings.push({
        severity: 'warning',
        stepId: step.id,
        message: 'Hai bước gửi tin liên tiếp không có bước Chờ (wait_delay) ở giữa dễ gây phản cảm/Spam.',
      });
    }
    if (normType === 'if_else_condition' && !step.yesStepId && !step.noStepId && (!step.branches || step.branches.length === 0)) {
      score -= 12;
      findings.push({
        severity: 'warning',
        stepId: step.id,
        message: `Node điều kiện "${step.label || step.id}" chưa nối nhánh ĐÚNG hoặc SAI.`,
      });
    }
  }

  if (!hasSaleHandoff) {
    findings.push({
      severity: 'tip',
      message:
        'Gợi ý từ DOM Agent: Có thể gắn thêm node "Đẩy vào Vòng chia Sale Auto Data" ở nhánh khách hàng đạt điểm nóng (Lead Score >= 50) để chốt đơn nhanh hơn.',
    });
  }

  const clamped = Math.max(0, Math.min(100, score));
  const grade = clamped >= 85 ? 'Xuất sắc' : clamped >= 65 ? 'Tốt' : 'Cần lưu ý';
  return { score: clamped, grade, findings };
}

/**
 * Executes a real Automation Flow run (or resumes a paused enrollment) for a Lead inside `withTenantTransaction`
 */
export async function executeFlowForLead(
  tenantId: string,
  flowId: string,
  leadId: string,
  options?: {
    actorId?: string | null;
    skipWaitDelay?: boolean;
    enrollmentId?: string | null;
    resumeFromStepId?: string | null;
    eventMatched?: boolean;
    matchedEventLabel?: string | null;
    _recursionDepth?: number;
  }
): Promise<{
  enrollmentId: string;
  status: string;
  trace: FlowTraceEntry[];
  promotedToSaleRound: boolean;
}> {
  const recursionDepth = Number(options?._recursionDepth || 0);
  if (recursionDepth >= 3) {
    return {
      enrollmentId: options?.enrollmentId || '',
      status: 'skipped_recursion_limit',
      trace: [],
      promotedToSaleRound: false,
    };
  }

  let drainAfterCommit = false;
  const postCommitTasks: Array<() => Promise<void>> = [];
  const publicOrigin = resolvePublicRequestOrigin();

  const result = await withTenantTransaction(tenantId, async (client: DbClient) => {
    const [flowRes, leadRes, tenantRes, suppressionRes] = await Promise.all([
      client.query('SELECT * FROM mkt_flows WHERE tenant_id = $1 AND id = $2 LIMIT 1', [tenantId, flowId]),
      client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1', [
        tenantId,
        leadId,
      ]),
      client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [tenantId]),
      client.query<{ channel: string; recipient: string }>(
        'SELECT channel, LOWER(recipient) AS recipient FROM mkt_suppression_list WHERE tenant_id = $1',
        [tenantId]
      ),
    ]);

    const flow = flowRes.rows[0];
    const lead = leadRes.rows[0];
    if (!flow || !lead) {
      throw new Error('FLOW_OR_LEAD_NOT_FOUND');
    }

    const suppressedSet = buildSuppressionSet(suppressionRes.rows);

    let existingEnrollment: Record<string, any> | null = null;
    let rawStepsJson: unknown = flow.steps_json;

    if (options?.enrollmentId) {
      const enRes = await client.query(
        'SELECT * FROM mkt_flow_enrollments WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [tenantId, options.enrollmentId]
      );
      existingEnrollment = enRes.rows[0] || null;
      if (!existingEnrollment) {
        return {
          enrollmentId: options.enrollmentId,
          status: 'failed',
          trace: [] as FlowTraceEntry[],
          promotedToSaleRound: false,
        };
      }
      if (String(existingEnrollment.status) === 'completed') {
        return {
          enrollmentId: String(existingEnrollment.id),
          status: 'completed',
          trace: parseJsonCol<FlowTraceEntry[]>(existingEnrollment.execution_trace, []),
          promotedToSaleRound: false,
        };
      }

      if (existingEnrollment.snapshot_version !== undefined && existingEnrollment.snapshot_version !== null) {
        const snapRes = await client.query<{ steps_json: unknown }>(
          'SELECT steps_json FROM mkt_flow_snapshots WHERE tenant_id = $1 AND flow_id = $2 AND version = $3 ORDER BY created_at DESC LIMIT 1',
          [tenantId, flowId, Number(existingEnrollment.snapshot_version)]
        );
        if (snapRes.rows[0]?.steps_json) {
          rawStepsJson = snapRes.rows[0].steps_json;
        }
      }
    }

    const steps = parseJsonCol<FlowStepNodeDto[]>(rawStepsJson, []).map(normalizeFlowStepNode);
    const stepMap = new Map(steps.map((s) => [s.id, s]));
    const referenced = collectReferencedStepIds(steps);

    let current: FlowStepNodeDto | undefined;
    let resumedWaitTraceEntry: FlowTraceEntry | null = null;
    if (existingEnrollment) {
      const resumeId =
        options?.resumeFromStepId ||
        (existingEnrollment.current_step_id ? String(existingEnrollment.current_step_id) : null);
      const pausedNode = resumeId ? stepMap.get(String(resumeId)) : undefined;
      if (pausedNode) {
        const pausedType = normalizeFlowStepType(String(pausedNode.type));
        const pausedCfg = (pausedNode.config || {}) as Record<string, unknown>;
        if (pausedType === 'wait_delay' && String(pausedCfg.mode || '').toLowerCase() === 'wait_event') {
          const matched = Boolean(options?.eventMatched);
          const nextId = matched
            ? (pausedNode.yesStepId ?? pausedNode.nextStepId)
            : (pausedNode.noStepId ?? (pausedCfg.timeoutStepId as string | undefined) ?? pausedNode.nextStepId);
          resumedWaitTraceEntry = {
            step_id: pausedNode.id,
            node_type: pausedType,
            label: pausedNode.label || pausedType,
            outcome: matched
              ? `Sự kiện chờ đã xảy ra (${options?.matchedEventLabel || String(pausedCfg.wait_event || 'event')}) -> Nhánh YES`
              : `Hết thời gian chờ sự kiện (Timeout) -> Nhánh FALLBACK`,
            branch: matched ? 'yes' : 'no',
            timestamp: new Date().toISOString(),
          };
          current = nextId ? stepMap.get(String(nextId)) : undefined;
        } else {
          current =
            pausedType === 'wait_delay'
              ? pausedNode.nextStepId
                ? stepMap.get(pausedNode.nextStepId)
                : undefined
              : pausedNode;
        }
      } else {
        current = undefined;
      }
    } else {
      current = steps.find((s) => !referenced.has(s.id)) || steps[0];
    }

    const [
      tagsRes,
      audsRes,
      stageRes,
      claimsRes,
      webSessRes,
      webEventsRes,
      surveyRes,
      voucherRes,
      timelineRes,
    ] = await Promise.all([
      client.query<{ id: string; name: string; slug: string }>(
        `SELECT tt.id, tt.name, tt.slug
         FROM lead_tags lt
         INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
         WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
        [tenantId, leadId]
      ),
      client.query<{ id: string; name: string; audience_type: string }>(
        `SELECT ta.id, ta.name, ta.audience_type
         FROM tenant_audience_members tam
         INNER JOIN tenant_audiences ta ON ta.tenant_id = tam.tenant_id AND ta.id = tam.audience_id
         WHERE tam.tenant_id = $1 AND tam.lead_id = $2`,
        [tenantId, leadId]
      ),
      lead.stage_id
        ? client.query<{ stage_key: string | null; stage_name: string | null; is_won_stage: boolean | null }>(
            'SELECT stage_key, stage_name, is_won_stage FROM tenant_pipeline_stages WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [tenantId, lead.stage_id]
          )
        : Promise.resolve({ rows: [] as Array<{ stage_key: string | null; stage_name: string | null; is_won_stage: boolean | null }> }),
      client.query<{ campaign_id: string; status: string; opened_at: string | null; clicked_at: string | null; channel: string }>(
        `SELECT campaign_id, status, opened_at, clicked_at, channel
         FROM mkt_send_claims
         WHERE tenant_id = $1 AND lead_id = $2
         ORDER BY claimed_at DESC LIMIT 100`,
        [tenantId, leadId]
      ),
      client.query<{ duration_seconds: number; pricing_intent_detected: boolean }>(
        `SELECT COALESCE(duration_seconds, 0)::int AS duration_seconds, pricing_intent_detected
         FROM mkt_web_sessions
         WHERE tenant_id = $1 AND lead_id = $2
         ORDER BY last_seen_at DESC LIMIT 50`,
        [tenantId, leadId]
      ),
      client.query<{ event_type: string; page_url: string; element_selector: string | null; scroll_depth_pct: number | null; metadata: unknown }>(
        `SELECT event_type, page_url, element_selector, scroll_depth_pct, metadata
         FROM mkt_web_events
         WHERE tenant_id = $1 AND lead_id = $2
         ORDER BY created_at DESC LIMIT 200`,
        [tenantId, leadId]
      ),
      client.query<{ quiz_score: number; nps_score: number | null }>(
        `SELECT quiz_score, nps_score
         FROM mkt_survey_responses
         WHERE tenant_id = $1 AND lead_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, leadId]
      ),
      client.query<{ status: string }>(
        `SELECT status FROM mkt_voucher_codes
         WHERE tenant_id = $1 AND lead_id = $2
         ORDER BY claimed_at DESC LIMIT 20`,
        [tenantId, leadId]
      ),
      client.query<{ event_type: string; event_category: string | null; actor_role: string | null; metadata: unknown }>(
        `SELECT event_type, event_category, actor_role, metadata
         FROM lead_timeline_events
         WHERE tenant_id = $1 AND lead_id = $2
         ORDER BY created_at DESC LIMIT 120`,
        [tenantId, leadId]
      ),
    ]);

    const liveTags = new Set<string>();
    for (const t of tagsRes.rows) {
      if (t.id) liveTags.add(String(t.id));
      if (t.slug) liveTags.add(String(t.slug));
      if (t.name) liveTags.add(String(t.name));
    }

    const liveAudiences = new Set<string>();
    for (const a of audsRes.rows) {
      if (a.id) liveAudiences.add(String(a.id));
      if (a.name) liveAudiences.add(String(a.name));
    }

    let emailOpened = false;
    let emailClicked = false;
    let emailDelivered = false;
    const emailOpenedSteps = new Set<string>();
    const clickedUrls = new Set<string>();
    for (const cl of claimsRes.rows) {
      if (cl.status === 'sent' || cl.status === 'delivered') emailDelivered = true;
      if (cl.opened_at) {
        emailOpened = true;
        emailDelivered = true;
      }
      if (cl.clicked_at) {
        emailClicked = true;
        emailOpened = true;
        emailDelivered = true;
      }
    }

    let znsDelivered = false;
    let znsSent = false;
    let znsClicked = false;
    let znsFailed = false;
    let crmSaleContacted = false;
    let formSubmitted = false;
    let purchased = Boolean(stageRes.rows[0]?.is_won_stage) || Number(lead.total_revenue_vnd || 0) > 0;
    let latestQuizScore: number | undefined =
      surveyRes.rows[0]?.quiz_score !== undefined ? Number(surveyRes.rows[0].quiz_score) : undefined;
    const latestNpsScore: number | undefined =
      surveyRes.rows[0]?.nps_score !== null && surveyRes.rows[0]?.nps_score !== undefined
        ? Number(surveyRes.rows[0].nps_score)
        : undefined;

    for (const ev of timelineRes.rows) {
      const et = String(ev.event_type || '').toLowerCase();
      const meta = parseJsonCol<Record<string, unknown>>(ev.metadata, {});
      if (et === 'mkt_email_sent' || et === 'email_sent' || et === 'email_delivered') emailDelivered = true;
      if (et === 'email_opened' || et === 'mkt_email_opened') {
        emailOpened = true;
        emailDelivered = true;
        if (meta.step_id) emailOpenedSteps.add(String(meta.step_id));
      }
      if (et === 'email_clicked' || et === 'link_clicked' || et === 'mkt_email_clicked') {
        emailClicked = true;
        emailOpened = true;
        emailDelivered = true;
        if (meta.url || meta.target_url) clickedUrls.add(String(meta.url || meta.target_url));
      }
      if (et === 'zns_sent' || et === 'zns_delivered') {
        znsSent = true;
        znsDelivered = true;
      }
      if (et === 'zns_clicked') znsClicked = true;
      if (et === 'zns_failed') znsFailed = true;
      if (et === 'form_submitted') formSubmitted = true;
      if (et === 'purchase_event' || et === 'deal_won') purchased = true;
      if (
        et === 'call_logged' ||
        et === 'call' ||
        et === 'note_added' ||
        et === 'sale_note' ||
        et === 'lead_accepted' ||
        (ev.actor_role === 'sale' && ev.event_category === 'communication')
      ) {
        crmSaleContacted = true;
      }
      if ((et === 'survey_completed' || et === 'quiz_completed') && latestQuizScore === undefined) {
        const rawQ = meta.quiz_score ?? meta.score;
        if (rawQ !== undefined && rawQ !== null && Number.isFinite(Number(rawQ))) {
          latestQuizScore = Number(rawQ);
        }
      }
    }

    const visitedUrls = new Set<string>();
    const clickedTexts = new Set<string>();
    let maxScrollPct = 0;
    let totalActiveDurationSec = 0;
    let pricingIntent = false;
    for (const s of webSessRes.rows) {
      totalActiveDurationSec += Math.max(0, Number(s.duration_seconds || 0));
      if (s.pricing_intent_detected) pricingIntent = true;
    }
    let eventDurationSum = 0;
    for (const we of webEventsRes.rows) {
      const meta = parseJsonCol<Record<string, unknown>>(we.metadata, {});
      if (we.page_url) visitedUrls.add(String(we.page_url));
      if (we.event_type === 'pricing_intent') pricingIntent = true;
      if (we.event_type === 'click' || we.event_type === 'outbound_click') {
        const txt = String(meta.element_text || meta.text || '').trim();
        if (txt) clickedTexts.add(txt);
        if (we.element_selector) clickedTexts.add(String(we.element_selector));
        if (meta.href) clickedUrls.add(String(meta.href));
      }
      const sd = we.scroll_depth_pct !== null && we.scroll_depth_pct !== undefined
        ? Number(we.scroll_depth_pct)
        : Number(meta.max_scroll_pct || meta.percent || 0);
      if (Number.isFinite(sd) && sd > maxScrollPct) maxScrollPct = Math.min(100, Math.round(sd));
      const evDur = Number(meta.active_duration_seconds || meta.duration_seconds || 0);
      if (Number.isFinite(evDur) && evDur > 0) eventDurationSum += Math.min(1800, evDur);
    }
    const effectiveActiveDurationSec = Math.max(totalActiveDurationSec, eventDurationSum);

    const voucherClaimed = voucherRes.rows.length > 0;
    const voucherRedeemed = voucherRes.rows.some((v) => String(v.status).toLowerCase() === 'redeemed');

    const buildEnrichedLeadContext = (): Record<string, unknown> => ({
      ...lead,
      stage_key: stageRes.rows[0]?.stage_key || undefined,
      stage_name: stageRes.rows[0]?.stage_name || undefined,
      ...(latestQuizScore !== undefined ? { quiz_score: latestQuizScore } : {}),
      ...(latestNpsScore !== undefined ? { nps_score: latestNpsScore } : {}),
      survey_completed: surveyRes.rows.length > 0 || latestQuizScore !== undefined,
      tags: Array.from(liveTags),
      audiences: Array.from(liveAudiences),
      email_opened: emailOpened,
      email_clicked: emailClicked,
      email_delivered: emailDelivered,
      email_opened_steps: Array.from(emailOpenedSteps),
      clicked_urls: Array.from(clickedUrls),
      zns_delivered: znsDelivered,
      zns_sent: znsSent,
      zns_clicked: znsClicked,
      zns_failed: znsFailed,
      crm_sale_contacted: crmSaleContacted,
      form_submitted: formSubmitted,
      purchased,
      visited_urls: Array.from(visitedUrls),
      clicked_texts: Array.from(clickedTexts),
      max_scroll_pct: maxScrollPct,
      active_duration_seconds: effectiveActiveDurationSec,
      pricing_intent: pricingIntent,
      voucher_claimed: voucherClaimed,
      voucher_redeemed: voucherRedeemed,
    });

    const trace: FlowTraceEntry[] = existingEnrollment
      ? parseJsonCol<FlowTraceEntry[]>(existingEnrollment.execution_trace, [])
      : [];
    if (resumedWaitTraceEntry) {
      trace.push(resumedWaitTraceEntry);
    }
    const visited = new Set<string>();
    let promotedToSaleRound = false;
    let finalStatus = 'completed';
    let pausedStepId: string | null = null;
    let nextRunAtIso: string | null = null;
    let loopCount = 0;

    while (current && !visited.has(current.id) && loopCount < 40) {
      loopCount++;
      visited.add(current.id);
      const cfg = (current.config || {}) as Record<string, unknown>;
      const normType = normalizeFlowStepType(String(current.type));
      const nowIso = new Date().toISOString();
      const label = current.label || normType;

      if (normType === 'trigger') {
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: 'Kích hoạt quy trình',
          timestamp: nowIso,
        });
        current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
        continue;
      }

      if (normType === 'wait_delay' && cfg.pause_execution !== false && !options?.skipWaitDelay) {
        const waitMode = String(cfg.mode || 'duration').toLowerCase();
        const delayMs = computeWaitDelayMs(cfg, new Date(), buildEnrichedLeadContext());
        if (delayMs === 0 && (waitMode === 'golden_hours' || waitMode === 'window' || waitMode === 'until_date' || waitMode === 'until_datetime')) {
          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: 'Đã ở trong khung giờ vàng / thời điểm cho phép -> đi tiếp ngay',
            timestamp: nowIso,
          });
          current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
          continue;
        }
        nextRunAtIso = new Date(Date.now() + delayMs).toISOString();
        pausedStepId = current.id;
        finalStatus = 'waiting';
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome:
            waitMode === 'wait_event'
              ? `Đang chờ sự kiện "${String(cfg.wait_event || 'email_opened')}" (Timeout: ${nextRunAtIso})`
              : `Đặt lịch chờ đến ${nextRunAtIso}`,
          timestamp: nowIso,
        });
        break;
      }

      if (normType === 'if_else_condition') {
        const condRes = resolveConditionNextStep(buildEnrichedLeadContext(), current);
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: condRes.matched
            ? `Nhánh ${condRes.branchLabel.toUpperCase()}`
            : `Nhánh ${condRes.branchLabel.toUpperCase()}`,
          branch: condRes.branchLabel,
          timestamp: nowIso,
        });
        current = condRes.nextId ? stepMap.get(condRes.nextId) : undefined;
        continue;
      }

      if (normType === 'ab_split') {
        const rawRatioA =
          cfg.ratio_a ??
          cfg.ratioA ??
          (cfg.ratio_b !== undefined
            ? 100 - Number(cfg.ratio_b)
            : cfg.ratioB !== undefined
              ? 100 - Number(cfg.ratioB)
              : 50);
        const ratioA = Math.min(95, Math.max(5, Number(rawRatioA)));
        const hashByte = crypto.createHash('md5').update(`${leadId}:${current.id}`).digest()[0];
        const branch = Math.floor((hashByte / 256) * 100) < ratioA ? 'A' : 'B';
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: `Rẽ nhánh A/B -> ${branch}`,
          branch,
          timestamp: nowIso,
        });
        const nextId: string | null | undefined = branch === 'A' ? current.pathAStepId : current.pathBStepId;
        current = nextId ? stepMap.get(nextId) : undefined;
        continue;
      }

      if (normType === 'update_lead_score') {
        const delta = Math.round(Number(cfg.delta ?? cfg.points ?? 10));
        lead.lead_score = Number(lead.lead_score || 0) + delta;
        await client.query(
          `UPDATE leads
           SET lead_score = lead_score + $3,
               last_engaged_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, leadId, delta]
        );
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: `Điểm nóng hiện tại: ${lead.lead_score}`,
          timestamp: nowIso,
        });
      } else if (normType === 'add_remove_tag') {
        const mode = (cfg.mode ?? cfg.action) === 'remove' ? 'remove' : 'add';
        const appliedTagLabels: string[] = [];
        const addedTagIds: string[] = [];
        const addedTagNames: string[] = [];

        if (cfg.tag_id) {
          const explicitTagId = String(cfg.tag_id).trim();
          const tById = await client.query<{ id: string; name: string; slug: string }>(
            'SELECT id, name, slug FROM tenant_tags WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [tenantId, explicitTagId]
          );
          if (tById.rows[0]) {
            const tRow = tById.rows[0];
            if (mode === 'add') {
              const ins = await client.query(
                `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
                [crypto.randomUUID(), tenantId, leadId, tRow.id]
              );
              liveTags.add(tRow.slug);
              liveTags.add(tRow.name);
              if ((ins.rowCount || 0) > 0) {
                addedTagIds.push(tRow.id);
                addedTagNames.push(tRow.name);
              }
            } else {
              await client.query(
                'DELETE FROM lead_tags WHERE tenant_id = $1 AND lead_id = $2 AND tag_id = $3',
                [tenantId, leadId, tRow.id]
              );
              liveTags.delete(tRow.slug);
              liveTags.delete(tRow.name);
            }
            appliedTagLabels.push(tRow.name || tRow.slug);
          }
        } else {
          const rawTags: string[] = Array.isArray(cfg.tags)
            ? cfg.tags.map((t) => String(t).trim()).filter(Boolean)
            : [String(cfg.tag || 'flow-engaged').trim()].filter(Boolean);

          for (const rawTag of rawTags) {
            const tagSlug = slugifyKeyLower(rawTag, 'tag');
            if (mode === 'add') {
              const tagId = crypto.randomUUID();
              await client.query(
                `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category)
                 VALUES ($1, $2, $3, $4, '#1E40FF', 'automation')
                 ON CONFLICT (tenant_id, slug) DO NOTHING`,
                [tagId, tenantId, rawTag, tagSlug]
              );
              const tLookup = await client.query<{ id: string; name: string; slug: string }>(
                'SELECT id, name, slug FROM tenant_tags WHERE tenant_id = $1 AND slug = $2 LIMIT 1',
                [tenantId, tagSlug]
              );
              if (tLookup.rows[0]?.id) {
                const ins = await client.query(
                  `INSERT INTO lead_tags (id, tenant_id, lead_id, tag_id)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (tenant_id, lead_id, tag_id) DO NOTHING`,
                  [crypto.randomUUID(), tenantId, leadId, tLookup.rows[0].id]
                );
                liveTags.add(tLookup.rows[0].slug);
                liveTags.add(tLookup.rows[0].name);
                if ((ins.rowCount || 0) > 0) {
                  addedTagIds.push(tLookup.rows[0].id);
                  addedTagNames.push(tLookup.rows[0].name);
                }
              }
            } else {
              const tLookup = await client.query<{ id: string; name: string; slug: string }>(
                'SELECT id, name, slug FROM tenant_tags WHERE tenant_id = $1 AND (slug = $2 OR LOWER(name) = LOWER($3))',
                [tenantId, tagSlug, rawTag]
              );
              for (const tr of tLookup.rows) {
                await client.query('DELETE FROM lead_tags WHERE tenant_id = $1 AND lead_id = $2 AND tag_id = $3', [
                  tenantId,
                  leadId,
                  tr.id,
                ]);
                liveTags.delete(tr.slug);
                liveTags.delete(tr.name);
              }
            }
            appliedTagLabels.push(rawTag);
          }
        }

        if (addedTagIds.length > 0) {
          postCommitTasks.push(async () => {
            await emitDomainEvent('marketing.engaged', {
              tenantId,
              leadId,
              engagementType: 'tag_added',
              scoreDelta: 0,
              metadata: {
                tagIds: addedTagIds,
                tagNames: addedTagNames,
                _fromFlowId: flowId,
                _recursionDepth: recursionDepth + 1,
              },
            });
          });
        }

        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: `${mode === 'add' ? 'Đã gắn' : 'Đã gỡ'} nhãn "${appliedTagLabels.join(', ')}"`,
          timestamp: nowIso,
        });
      } else if (normType === 'add_remove_list') {
        const audienceId = String(cfg.audience_id || cfg.audienceId || cfg.list_id || cfg.listId || '').trim();
        const mode = (cfg.mode ?? cfg.action) === 'remove' ? 'remove' : 'add';
        let outcomeMsg = 'Thiếu audience_id/list_id';

        if (audienceId) {
          const audRes = await client.query<{ id: string; name: string; audience_type: string }>(
            'SELECT id, name, audience_type FROM tenant_audiences WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [tenantId, audienceId]
          );
          if (audRes.rows[0]) {
            if (mode === 'add') {
              const insAud = await client.query(
                `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
                 VALUES ($1, $2, $3, $4, 'automation_flow', $5::jsonb)
                 ON CONFLICT (tenant_id, audience_id, lead_id) DO NOTHING`,
                [
                  crypto.randomUUID(),
                  tenantId,
                  audienceId,
                  leadId,
                  JSON.stringify({ flow_id: flowId, step_id: current.id }),
                ]
              );
              if ((insAud.rowCount || 0) > 0) {
                const audRow = audRes.rows[0];
                postCommitTasks.push(async () => {
                  await emitDomainEvent('audience.entered', {
                    tenantId,
                    audienceId: audRow.id,
                    audienceName: audRow.name,
                    audienceType: audRow.audience_type,
                    leadId,
                  });
                });
              }
            } else {
              await client.query(
                'DELETE FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id = $3',
                [tenantId, audienceId, leadId]
              );
            }
            await refreshAudienceCachedCount(client, tenantId, audienceId);
            outcomeMsg = `${mode === 'add' ? 'Đã thêm vào' : 'Đã gỡ khỏi'} danh sách "${audRes.rows[0].name}"`;
          } else {
            outcomeMsg = `Không tìm thấy danh sách ${audienceId}`;
          }
        }

        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: outcomeMsg,
          timestamp: nowIso,
        });
      } else if (normType === 'issue_voucher') {
        const vcId = cfg.voucher_campaign_id || cfg.voucherCampaignId ? String(cfg.voucher_campaign_id || cfg.voucherCampaignId) : null;
        let issuedCode = '';
        if (vcId) {
          const vcRes = await client.query<{ id: string; code_prefix: string }>(
            'SELECT id, code_prefix FROM mkt_voucher_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [tenantId, vcId]
          );
          if (vcRes.rows[0]) {
            issuedCode = `${vcRes.rows[0].code_prefix || 'DOM'}-${generateShortCode(6).toUpperCase()}`;
            await client.query(
              `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status, lead_id, claimed_at)
               VALUES ($1, $2, $3, $4, 'claimed', $5, clock_timestamp())
               ON CONFLICT (tenant_id, code) DO NOTHING`,
              [crypto.randomUUID(), tenantId, vcId, issuedCode, leadId]
            );
            await client.query(
              `UPDATE mkt_voucher_campaigns
               SET total_codes = total_codes + 1,
                   claimed_codes = claimed_codes + 1,
                   updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [tenantId, vcId]
            );
          }
        }
        if (!issuedCode) {
          issuedCode = `DOM-${generateShortCode(6).toUpperCase()}`;
        }
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'voucher_claimed', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
          [
            crypto.randomUUID(),
            tenantId,
            leadId,
            `Flow: ${flow.name}`,
            `Cấp mã ưu đãi tự động: ${issuedCode}`,
            `Phát hành từ kịch bản "${flow.name}"`,
            JSON.stringify({ flow_id: flowId, code: issuedCode }),
          ]
        );
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: `Đã cấp mã Voucher: ${issuedCode}`,
          timestamp: nowIso,
        });
      } else if (normType === 'send_email') {
        const emailLower = String(lead.email || '').trim().toLowerCase();
        if (!emailLower || lead.email_consent !== 'subscribed' || suppressedSet.has(`email:${emailLower}`)) {
          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: 'Bỏ qua gửi Email (thiếu email / đã hủy đăng ký / trong danh sách chặn)',
            timestamp: nowIso,
          });
        } else {
          const emailVault = await readTenantChannelVault(client, tenantId, ['aws_ses', 'smtp', 'appscript', 'resend']);
          const tenantName = tenantRes.rows[0]?.name || 'DOMATION';
          const templateId = cfg.template_id || cfg.templateId ? String(cfg.template_id || cfg.templateId) : null;
          let tplSubject = '';
          let tplHtml = String(cfg.customHtml || cfg.custom_html || cfg.contentBody || cfg.content_body || '').trim();

          if (templateId) {
            const tRes = await client.query<{ subject: string; compiled_html: string; blocks_json: unknown; body_style: unknown }>(
              'SELECT subject, compiled_html, blocks_json, body_style FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
              [tenantId, templateId]
            );
            const tRow = tRes.rows[0];
            if (tRow) {
              tplSubject = String(tRow.subject || '');
              if (!tplHtml) {
                tplHtml = String(tRow.compiled_html || '').trim();
                if (!tplHtml) {
                  const blocks = parseJsonCol<EmailBlockDto[]>(tRow.blocks_json, []);
                  const bodyStyle = parseJsonCol<EmailBodyStyleDto>(tRow.body_style, {});
                  if (blocks.length > 0) tplHtml = compileEmailBlocksToHtml(blocks, bodyStyle, tplSubject || label);
                }
              }
            }
          }

          const unsubSig = signUnsubscribeHmac(tenantId, leadId, 'email');
          const unsubUrl = `${publicOrigin}/api/v1/public/marketing/unsubscribe?tenant_id=${tenantId}&lead_id=${leadId}&channel=email&sig=${unsubSig}`;
          const mergeCtx = {
            lead: { ...lead, custom_fields: parseJsonCol(lead.custom_fields, {}) },
            tenant: { name: tenantName },
            unsubscribe_url: unsubUrl,
          };
          const subj = renderMergeTags(String(cfg.subject || tplSubject || label), mergeCtx);
          const renderedHtml = renderMergeTags(
            tplHtml || `<div><p>${subj}</p><p><a href="${unsubUrl}">Hủy đăng ký</a></p></div>`,
            mergeCtx
          );

          const emailRes = await dispatchMarketingEmail({
            tenantId,
            client,
            to: emailLower,
            subject: subj,
            text: stripHtmlTagsForPlainText(renderedHtml) || subj,
            html: renderedHtml,
            category: 'system_alert',
            meta: { flow_id: flowId, step_id: current.id, lead_id: leadId },
            emailVaultConfigured: emailVault.configured,
            emailVaultType: emailVault.integrationType,
          });

          if (emailRes.sent) {
            await client.query(
              `INSERT INTO lead_timeline_events (
                 id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
               ) VALUES ($1, $2, $3, 'mkt_email_sent', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
              [
                crypto.randomUUID(),
                tenantId,
                leadId,
                `Flow: ${flow.name}`,
                `Gửi Email tự động: ${subj}`,
                `Kênh gửi: ${emailRes.provider}`,
                JSON.stringify({
                  flow_id: flowId,
                  step_id: current.id,
                  provider: emailRes.provider,
                  message_id: emailRes.messageId,
                  ...(emailRes.headerMessageId && emailRes.headerMessageId !== emailRes.messageId
                    ? { header_message_id: emailRes.headerMessageId }
                    : {}),
                }),
              ]
            );
          }

          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: emailRes.sent
              ? `Đã gửi qua ${emailRes.provider}: ${subj}`
              : `Gửi Email thất bại: ${emailRes.error || 'unknown'}`,
            timestamp: nowIso,
          });
        }
      } else if (normType === 'send_zns') {
        const phoneClean = String(lead.phone || '').trim();
        if (!phoneClean || lead.zns_consent === 'opted_out' || isRecipientSuppressed(suppressedSet, 'zns', phoneClean)) {
          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: 'Bỏ qua gửi Zalo ZNS (thiếu SĐT / đã từ chối ZNS / trong danh sách chặn)',
            timestamp: nowIso,
          });
        } else {
          const tenantName = tenantRes.rows[0]?.name || 'DOMATION';
          const subj = renderMergeTags(String(cfg.subject || label), {
            lead: { ...lead, custom_fields: parseJsonCol(lead.custom_fields, {}) },
            tenant: { name: tenantName },
          });
          const rawTemplateData =
            cfg.template_data && typeof cfg.template_data === 'object'
              ? (cfg.template_data as Record<string, unknown>)
              : {};
          const renderedTemplateData: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rawTemplateData)) {
            renderedTemplateData[k] = typeof v === 'string'
              ? renderMergeTags(v, { lead: { ...lead, custom_fields: parseJsonCol(lead.custom_fields, {}) }, tenant: { name: tenantName } })
              : v;
          }

          const znsRes = await dispatchZnsNotification({
            tenantId,
            client,
            phone: phoneClean,
            templateId: cfg.template_id || cfg.templateId ? String(cfg.template_id || cfg.templateId) : null,
            templateData: renderedTemplateData,
            message: subj,
            flowId,
            stepId: current.id,
            leadId,
          });

          const isRealZnsSend =
            znsRes.sent && !znsRes.queued && !znsRes.silent && znsRes.provider !== 'zns_vault_queued';

          if (isRealZnsSend) {
            await client.query(
              `INSERT INTO lead_timeline_events (
                 id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
               ) VALUES ($1, $2, $3, 'zns_sent', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
              [
                crypto.randomUUID(),
                tenantId,
                leadId,
                `Flow: ${flow.name}`,
                `Gửi Zalo ZNS tự động`,
                `Kênh gửi: ${znsRes.provider}`,
                JSON.stringify({ flow_id: flowId, step_id: current.id, provider: znsRes.provider, message_id: znsRes.messageId }),
              ]
            );
          }

          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: !znsRes.sent
              ? `Gửi Zalo ZNS thất bại: ${znsRes.error || 'unknown'}`
              : znsRes.queued || znsRes.provider === 'zns_vault_queued'
                ? 'Bỏ qua gửi Zalo ZNS (chưa cấu hình Zalo OA/ZNS trong Vault)'
                : znsRes.silent
                  ? `Đã mô phỏng Zalo ZNS (${znsRes.provider}): ${subj}`
                  : `Đã gửi Zalo ZNS qua ${znsRes.provider}: ${subj}`,
            timestamp: nowIso,
          });
        }
      } else if (normType === 'webhook_http') {
        const rawUrl = String(cfg.url || cfg.webhook_url || '').trim();
        let outcomeMsg = '';
        if (!rawUrl) {
          outcomeMsg = 'Thiếu URL webhook';
        } else {
          try {
            assertSafeOutboundWebhookUrl(rawUrl);
            const customPayload =
              cfg.payload && typeof cfg.payload === 'object'
                ? (cfg.payload as Record<string, unknown>)
                : cfg.body && typeof cfg.body === 'object'
                  ? (cfg.body as Record<string, unknown>)
                  : null;
            const webhookRes = await dispatchFlowWebhook({
              url: rawUrl,
              method: String(cfg.method || 'POST'),
              headers: cfg.headers && typeof cfg.headers === 'object' ? (cfg.headers as Record<string, string>) : undefined,
              secret: cfg.secret ? String(cfg.secret) : null,
              payload: customPayload || {
                event: 'marketing.flow_webhook',
                tenant_id: tenantId,
                flow_id: flowId,
                step_id: current.id,
                lead: {
                  id: lead.id,
                  name: lead.name,
                  phone: lead.phone,
                  email: lead.email,
                  lead_score: lead.lead_score,
                  status: lead.status,
                },
              },
            });
            outcomeMsg = webhookRes.ok
              ? `Webhook HTTP ${webhookRes.status} thành công`
              : `Webhook HTTP lỗi (${webhookRes.status}): ${webhookRes.error || 'failed'}`;
            await client.query(
              `INSERT INTO lead_timeline_events (
                 id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
               ) VALUES ($1, $2, $3, 'flow_webhook_http', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
              [
                crypto.randomUUID(),
                tenantId,
                leadId,
                `Flow: ${flow.name}`,
                `Gọi Outbound Webhook (${webhookRes.status})`,
                rawUrl,
                JSON.stringify({ flow_id: flowId, step_id: current.id, ok: webhookRes.ok, status: webhookRes.status }),
              ]
            );
          } catch (ssrfErr: any) {
            outcomeMsg = String(ssrfErr?.message || 'SSRF_BLOCKED');
            await client.query(
              `INSERT INTO lead_timeline_events (
                 id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
               ) VALUES ($1, $2, $3, 'flow_webhook_blocked', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
              [
                crypto.randomUUID(),
                tenantId,
                leadId,
                `Flow: ${flow.name}`,
                `Từ chối Webhook không an toàn`,
                outcomeMsg,
                JSON.stringify({ flow_id: flowId, step_id: current.id, blocked: true, url: rawUrl }),
              ]
            );
          }
        }
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: outcomeMsg,
          timestamp: nowIso,
        });
      } else if (normType === 'notify_internal') {
        const tenantName = tenantRes.rows[0]?.name || 'DOMATION';
        const notifyTitle = renderMergeTags(String(cfg.title || label || 'Thông báo nội bộ từ Automation'), {
          lead: { ...lead, custom_fields: parseJsonCol(lead.custom_fields, {}) },
          tenant: { name: tenantName },
        });
        const notifyMessage = renderMergeTags(
          String(cfg.message || cfg.note || `Khách hàng ${lead.name || lead.phone || lead.email || leadId} vừa đi qua bước "${label}".`),
          {
            lead: { ...lead, custom_fields: parseJsonCol(lead.custom_fields, {}) },
            tenant: { name: tenantName },
          }
        );

        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'internal_notification', 'communication', 'tenant_admin', $4, $5, $6, $7::jsonb)`,
          [
            crypto.randomUUID(),
            tenantId,
            leadId,
            `Flow: ${flow.name}`,
            notifyTitle,
            notifyMessage,
            JSON.stringify({ flow_id: flowId, step_id: current.id, target_user_id: cfg.user_id || cfg.owner_id || null }),
          ]
        );

        await client.query(
          `INSERT INTO admin_audit_logs (
             id, tenant_id, actor_id, actor_name, action, entity_type, entity_id, before_snapshot, after_snapshot, details
           ) VALUES ($1, $2, $3, $4, 'flow_notify_internal', 'lead', $5, '{}'::jsonb, '{}'::jsonb, $6::jsonb)`,
          [
            crypto.randomUUID(),
            tenantId,
            options?.actorId || null,
            `Flow: ${flow.name}`,
            leadId,
            JSON.stringify({ flow_id: flowId, step_id: current.id, title: notifyTitle, message: notifyMessage }),
          ]
        );

        const notifyEmail = String(cfg.notify_email || cfg.to_email || '').trim().toLowerCase();
        if (notifyEmail && notifyEmail.includes('@')) {
          const emailVault = await readTenantChannelVault(client, tenantId, ['aws_ses', 'smtp', 'appscript', 'resend']);
          await dispatchMarketingEmail({
            tenantId,
            client,
            to: notifyEmail,
            subject: `[${tenantName}] ${notifyTitle}`,
            text: notifyMessage,
            html: `<p>${notifyMessage}</p>`,
            category: 'system_alert',
            meta: { flow_id: flowId, step_id: current.id, internal_notification: true },
            emailVaultConfigured: emailVault.configured,
            emailVaultType: emailVault.integrationType,
          }).catch(() => {});
        }

        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: `Đã gửi thông báo nội bộ: ${notifyTitle}`,
          timestamp: nowIso,
        });
      } else if (normType === 'push_to_autodata_sale_round') {
        const actionType = String(cfg.actionType || 'assign_round_robin').toLowerCase();
        if (actionType === 'update_stage' && (cfg.stage_id || cfg.stageId)) {
          const stageId = String(cfg.stage_id || cfg.stageId);
          const previousStageId = lead.stage_id ? String(lead.stage_id) : null;
          await client.query(
            `UPDATE leads SET stage_id = $3, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, leadId, stageId]
          );
          lead.stage_id = stageId;

          const stageRes = await client.query<{
            id: string;
            pipeline_id: string | null;
            stage_key: string | null;
            stage_name: string | null;
            is_won_stage: boolean | null;
            capi_event_mapping: string | null;
          }>(
            `SELECT id, pipeline_id, stage_key, stage_name, is_won_stage, capi_event_mapping
             FROM tenant_pipeline_stages WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
            [tenantId, stageId]
          );
          const stageRow = stageRes.rows[0];
          const leadSnap = { ...lead, custom_fields: parseJsonCol<Record<string, unknown>>(lead.custom_fields, {}) };

          postCommitTasks.push(async () => {
            const [tMeta, tSettings] = await Promise.all([
              getTenantMetaCached(tenantId),
              getTenantSettingsCached(tenantId),
            ]);
            const isWon = Boolean(stageRow?.is_won_stage);
            const capiEvt = resolveCapiEventForQualityOrStage({
              stageCapiMapping: stageRow?.capi_event_mapping,
              tenantSettings: tSettings,
            });
            if (capiEvt) {
              await dispatchStageCapiEventDetached({
                tenantId,
                tenantSlug: tMeta?.slug || 'tenant',
                eventName: capiEvt,
                tenantSettings: tSettings,
                lead: {
                  leadId,
                  name: leadSnap.name,
                  phone: leadSnap.phone,
                  email: leadSnap.email,
                  fbc: leadSnap.fbc,
                  fbp: leadSnap.fbp,
                  fbclid: leadSnap.fbclid,
                  metaLeadId: leadSnap.meta_lead_id,
                  dealValue: Number(leadSnap.total_revenue_vnd || 0) || undefined,
                  customFields: leadSnap.custom_fields,
                },
                timelineAudit: {
                  actorId: options?.actorId || null,
                  actorRole: 'automation_flow',
                  stageName: stageRow?.stage_name || stageRow?.stage_key || stageId,
                },
              }).catch(() => {});
            }

            await emitDomainEvent('lead.stage_changed', {
              tenantId,
              leadId,
              pipelineId: stageRow?.pipeline_id || leadSnap.pipeline_id || null,
              previousStageId,
              currentStageId: stageId,
              currentStageKey: stageRow?.stage_key || undefined,
              isWonStage: isWon,
              willEmitDealWon: isWon,
              dealValueVnd: Number(leadSnap.total_revenue_vnd || 0) || null,
              actorId: options?.actorId || null,
            });
            if (isWon) {
              await emitDomainEvent('deal.won', {
                tenantId,
                leadId,
                amountVnd: Number(leadSnap.total_revenue_vnd || 0),
                sourceEntity: 'lead_stage',
                actorId: options?.actorId || null,
              });
            }
          });

          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: `Đã cập nhật Stage CRM (${stageId})`,
            timestamp: nowIso,
          });
        } else if (actionType === 'update_temperature' && (cfg.temperature || cfg.lead_status)) {
          const temp = String(cfg.temperature || 'hot');
          await client.query(
            `UPDATE leads SET quality_status = $3, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, leadId, temp]
          );
          lead.quality_status = temp;
          const leadSnap = { ...lead, custom_fields: parseJsonCol<Record<string, unknown>>(lead.custom_fields, {}) };

          postCommitTasks.push(async () => {
            const [tMeta, tSettings] = await Promise.all([
              getTenantMetaCached(tenantId),
              getTenantSettingsCached(tenantId),
            ]);
            const capiEvt = resolveCapiEventForQualityOrStage({
              qualityStatus: temp,
              tenantSettings: tSettings,
            });
            if (capiEvt) {
              await dispatchStageCapiEventDetached({
                tenantId,
                tenantSlug: tMeta?.slug || 'tenant',
                eventName: capiEvt,
                tenantSettings: tSettings,
                lead: {
                  leadId,
                  name: leadSnap.name,
                  phone: leadSnap.phone,
                  email: leadSnap.email,
                  fbc: leadSnap.fbc,
                  fbp: leadSnap.fbp,
                  fbclid: leadSnap.fbclid,
                  metaLeadId: leadSnap.meta_lead_id,
                  dealValue: Number(leadSnap.total_revenue_vnd || 0) || undefined,
                  customFields: leadSnap.custom_fields,
                },
                timelineAudit: {
                  actorId: options?.actorId || null,
                  actorRole: 'automation_flow',
                  stageName: temp,
                },
              }).catch(() => {});
            }
            await emitDomainEvent('lead.updated', {
              tenantId,
              leadId,
              changedFields: ['quality_status'],
              actorId: options?.actorId || null,
            });
          });

          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: `Đã cập nhật độ nóng Lead: ${temp}`,
            timestamp: nowIso,
          });
        } else if (actionType === 'assign_owner' && (cfg.owner_id || cfg.assigned_to)) {
          const ownerId = String(cfg.owner_id || cfg.assigned_to);
          const onlyIfUnassigned = Boolean(cfg.only_if_unassigned ?? cfg.onlyIfUnassigned);
          if (onlyIfUnassigned && lead.assigned_to) {
            trace.push({
              step_id: current.id,
              node_type: normType,
              label,
              outcome: `Giữ nguyên Sale hiện tại (${lead.assigned_to}) theo cấu hình không ghi đè`,
              timestamp: nowIso,
            });
          } else {
            await client.query(
              `UPDATE leads SET assigned_to = $3, status = 'assigned', updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [tenantId, leadId, ownerId]
            );
            promotedToSaleRound = true;
            lead.assigned_to = ownerId;
            lead.status = 'assigned';

            postCommitTasks.push(async () => {
              await emitDomainEvent('lead.updated', {
                tenantId,
                leadId,
                changedFields: ['assigned_to', 'status'],
                actorId: options?.actorId || null,
              });
              await emitDomainEvent('marketing.engaged', {
                tenantId,
                leadId,
                engagementType: 'lead.assigned',
                scoreDelta: 0,
                metadata: {
                  assigned_to: ownerId,
                  assignmentType: 'reassigned',
                  _fromFlowId: flowId,
                  _recursionDepth: recursionDepth + 1,
                },
              });
            });

            trace.push({
              step_id: current.id,
              node_type: normType,
              label,
              outcome: `Đã gán trực tiếp Sale phụ trách (${ownerId})`,
              timestamp: nowIso,
            });
          }
        } else if (actionType === 'create_task' || actionType === 'create_support_ticket' || actionType === 'notify_owner') {
          const tenantName = tenantRes.rows[0]?.name || 'DOMATION';
          const mergeCtx = {
            lead: { ...lead, full_name: lead.name, custom_fields: parseJsonCol(lead.custom_fields, {}) },
            tenant: { name: tenantName },
          };
          const title = renderMergeTags(
            String(
              cfg.subject ||
                cfg.ticket_subject ||
                (actionType === 'notify_owner' ? 'Thông báo khẩn cho Sale phụ trách' : label)
            ),
            mergeCtx
          );
          const content = renderMergeTags(
            String(cfg.body || cfg.message || cfg.ticket_description || cfg.description || `Thực thi tác vụ ${actionType}`),
            mergeCtx
          );
          const evtType =
            actionType === 'create_task'
              ? 'crm_task_created'
              : actionType === 'create_support_ticket'
                ? 'support_ticket_created'
                : 'owner_notified';
          await client.query(
            `INSERT INTO lead_timeline_events (
               id, tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
             ) VALUES ($1, $2, $3, $4, 'communication', $5, 'tenant_admin', $6, $7, $8, $9::jsonb)`,
            [
              crypto.randomUUID(),
              tenantId,
              leadId,
              evtType,
              cfg.assignee_id || lead.assigned_to || null,
              `Flow: ${flow.name}`,
              title,
              content,
              JSON.stringify({
                flow_id: flowId,
                step_id: current.id,
                action_type: actionType,
                task_type: cfg.task_type || 'call',
                due_in_hours: Number(cfg.due_in_hours || 24),
                priority: cfg.priority || 'medium',
              }),
            ]
          );
          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome: `Đã thực thi tác vụ CRM (${actionType}): ${title}`,
            timestamp: nowIso,
          });
        } else {
          const roundId = cfg.round_id || cfg.roundId || cfg.team_id ? String(cfg.round_id || cfg.roundId || cfg.team_id) : null;
          const pipelineId = cfg.pipeline_id || cfg.pipelineId ? String(cfg.pipeline_id || cfg.pipelineId) : null;
          if (actionType === 'reassign_if_uncontacted' && lead.assigned_to) {
            await client.query(
              `UPDATE leads SET assigned_to = NULL, status = 'unassigned_pending', updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [tenantId, leadId]
            );
            lead.assigned_to = null;
            lead.status = 'unassigned_pending';
          }
          const promotedIds = await promoteLeadsToSaleRoundInTx(client, tenantId, [leadId], {
            roundId,
            pipelineId,
            actorId: options?.actorId || null,
            actorName: `Automation Flow: ${flow.name}`,
            reasonTitle:
              actionType === 'reassign_if_uncontacted' && cfg.note
                ? String(cfg.note)
                : `Chuyển giao tự động từ Flow "${flow.name}" sang Vòng chia Sale Auto Data`,
          });
          if (promotedIds.length > 0) {
            promotedToSaleRound = true;
            drainAfterCommit = true;
            lead.status = 'unassigned_pending';
          }
          trace.push({
            step_id: current.id,
            node_type: normType,
            label,
            outcome:
              promotedIds.length > 0
                ? 'Đã chuyển trạng thái sang unassigned_pending & đưa vào hàng đợi Vòng chia Sale Auto Data!'
                : 'Hồ sơ đã thuộc đội Sale (bỏ qua ghi đè).',
            timestamp: nowIso,
          });
        }
      } else {
        trace.push({
          step_id: current.id,
          node_type: normType,
          label,
          outcome: `Hoàn thành bước ${normType}`,
          timestamp: nowIso,
        });
      }

      current = current.nextStepId ? stepMap.get(current.nextStepId) : undefined;
    }

    const completedAtIso = finalStatus === 'completed' ? new Date().toISOString() : null;
    const completedDelta = finalStatus === 'completed' ? 1 : 0;
    const pushedDelta = promotedToSaleRound ? 1 : 0;

    if (existingEnrollment) {
      await client.query(
        `UPDATE mkt_flow_enrollments
         SET current_step_id = $3,
             status = $4,
             next_run_at = $5,
             execution_trace = $6::jsonb,
             completed_at = COALESCE($7, completed_at)
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          existingEnrollment.id,
          pausedStepId,
          finalStatus,
          nextRunAtIso,
          JSON.stringify(trace),
          completedAtIso,
        ]
      );

      await client.query(
        `UPDATE mkt_flows
         SET completed_count = completed_count + $3,
             pushed_to_sale_count = pushed_to_sale_count + $4,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, flowId, completedDelta, pushedDelta]
      );

      return {
        enrollmentId: String(existingEnrollment.id),
        status: finalStatus,
        trace,
        promotedToSaleRound,
      };
    }

    const enrollmentId = crypto.randomUUID();
    await client.query(
      `INSERT INTO mkt_flow_enrollments (
         id, tenant_id, flow_id, snapshot_version, lead_id, current_step_id,
         status, next_run_at, execution_trace, completed_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9::jsonb, $10
       )`,
      [
        enrollmentId,
        tenantId,
        flowId,
        Number(flow.version || 1),
        leadId,
        pausedStepId,
        finalStatus,
        nextRunAtIso,
        JSON.stringify(trace),
        completedAtIso,
      ]
    );

    await client.query(
      `UPDATE mkt_flows
       SET enrolled_count = enrolled_count + 1,
           completed_count = completed_count + $3,
           pushed_to_sale_count = pushed_to_sale_count + $4,
           updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, flowId, completedDelta, pushedDelta]
    );

    return {
      enrollmentId,
      status: finalStatus,
      trace,
      promotedToSaleRound,
    };
  });

  if (drainAfterCommit) {
    await runUnassignedLeadDrainer(tenantId).catch(() => {});
  }
  for (const task of postCommitTasks) {
    await task().catch(() => {});
  }

  return result;
}

// ============================================================================
// Event-Bus Real-Time Listener Registration + Multi-Trigger & Wait-Event Engine
// ============================================================================
let flowListenersRegistered = false;
const recentFlowDispatchCache = new Map<string, number>();

function isDuplicateRecentDispatch(key: string, ttlMs = 2500): boolean {
  const now = Date.now();
  const prev = recentFlowDispatchCache.get(key);
  if (prev && now - prev < ttlMs) return true;
  recentFlowDispatchCache.set(key, now);
  if (recentFlowDispatchCache.size > 2000) {
    for (const [k, ts] of recentFlowDispatchCache.entries()) {
      if (now - ts >= ttlMs) recentFlowDispatchCache.delete(k);
    }
  }
  return false;
}

function normalizeTriggerCanonicalKeys(triggerType: string, cfg: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  const raw = String(triggerType || cfg.type || '').trim().toLowerCase();
  if (raw) keys.add(raw);

  // Map UI aliases -> canonical event keys
  if (raw === 'segment') keys.add('audience_joined');
  if (raw === 'form') keys.add('form_submitted');
  if (raw === 'survey') keys.add('survey_completed');
  if (raw === 'tag') keys.add('tag_added');
  if (raw === 'purchase') keys.add('purchase_event');
  if (raw === 'custom_event') keys.add('webhook_received');
  if (raw === 'voucher' || raw === 'voucher_redeem') keys.add('voucher_redeemed');
  if (raw === 'erp_event') {
    const target = String(cfg.targetId || cfg.event || '').trim().toLowerCase();
    if (target) keys.add(target);
    if (target === 'round_distributed') keys.add('lead_assigned');
  }
  if (raw === 'web_event') {
    const sub = String(cfg.web_event_type || cfg.event || cfg.targetId || 'page_visited').trim().toLowerCase();
    keys.add(sub);
    if (sub === 'any') {
      keys.add('page_visited');
      keys.add('web_cta_click');
      keys.add('web_scroll_depth');
      keys.add('web_pricing_intent');
      keys.add('web_engaged_session');
    }
  }
  return Array.from(keys);
}

function inferLeadIntegrationType(lead: Record<string, unknown>, meta?: Record<string, unknown>): string {
  const explicit = String(meta?.integration_type || meta?.integrationType || '').trim().toLowerCase();
  if (explicit) return explicit;
  const src = String(meta?.source || lead.source || '').toLowerCase();
  if (lead.meta_lead_id || /meta|facebook|fb_lead|lead_ads/.test(src)) return 'meta_lead_ads';
  if (/sheet|google_sheet|gsheet/.test(src)) return 'google_sheets';
  if (/ladipage|landing/.test(src)) return 'ladipage';
  if (/form|website|web/.test(src)) return 'form';
  if (/webhook|api|zapier|make/.test(src) || lead.connection_id) return 'webhook';
  return 'manual';
}

export function evaluateTriggerEntryFilters(
  triggerType: string,
  cfg: Record<string, unknown>,
  lead: Record<string, unknown>,
  leadExtra: {
    tagIds: string[];
    tagNames: string[];
    audienceIds: string[];
    maxScrollPct: number;
    activeDurationSec: number;
    visitedUrls: string[];
    clickedTexts: string[];
  },
  contextMeta?: Record<string, unknown>
): boolean {
  const erpFilters =
    cfg.erpFilters && typeof cfg.erpFilters === 'object' ? (cfg.erpFilters as Record<string, unknown>) : {};
  const filters =
    cfg.filters && typeof cfg.filters === 'object' ? (cfg.filters as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...erpFilters, ...filters, ...cfg };

  const expectedFormId = merged.form_id || (cfg.type === 'form' ? cfg.targetId : null);
  if (expectedFormId && String(expectedFormId) !== String(contextMeta?.formId || '')) return false;

  const expectedAudId = merged.audience_id || merged.list_id || merged.segment_id || (cfg.type === 'audience' || cfg.type === 'segment' ? cfg.targetId : null);
  if (expectedAudId) {
    const expStr = String(expectedAudId);
    const incomingAud = String(contextMeta?.audienceId || '');
    if (incomingAud !== expStr && !leadExtra.audienceIds.includes(expStr)) return false;
  }

  const expectedSurveyId = merged.survey_id || (cfg.type === 'survey' ? cfg.targetId : null);
  if (expectedSurveyId && String(expectedSurveyId) !== String(contextMeta?.surveyId || '')) return false;

  // Source / Campaign / UTM / Integration filters
  const sourceContains = String(merged.source_contains || merged.source || '').trim().toLowerCase();
  if (sourceContains) {
    const actualSource = String(contextMeta?.source || lead.source || '').toLowerCase();
    if (!actualSource.includes(sourceContains)) return false;
  }
  const campaignContains = String(merged.campaign_contains || merged.campaign || '').trim().toLowerCase();
  if (campaignContains) {
    const actualCamp = String(contextMeta?.campaign || lead.campaign || '').toLowerCase();
    if (!actualCamp.includes(campaignContains)) return false;
  }
  const expectedIntegration = String(merged.integration_type || merged.integrationType || '').trim().toLowerCase();
  if (expectedIntegration && expectedIntegration !== 'all') {
    const actualIntegration = inferLeadIntegrationType(lead, contextMeta);
    if (actualIntegration !== expectedIntegration) return false;
  }
  const expectedUtmSource = String(merged.utm_source || '').trim().toLowerCase();
  if (expectedUtmSource) {
    const actualUtm = String(contextMeta?.utm_source || contextMeta?.utmSource || lead.utm_source || '').toLowerCase();
    if (!actualUtm.includes(expectedUtmSource)) return false;
  }

  // Assigned Sale / Owner filters
  const expectedOwnerId = String(merged.assigned_to_user_id || merged.owner_id || merged.assigned_to || '').trim();
  const actualOwnerId = String(contextMeta?.assigned_to || contextMeta?.assignedTo || lead.assigned_to || '').trim();
  if (expectedOwnerId && actualOwnerId !== expectedOwnerId) return false;

  const expectedOwnerIds = Array.isArray(merged.owner_ids) ? merged.owner_ids.map(String).filter(Boolean) : [];
  if (expectedOwnerIds.length > 0 && !expectedOwnerIds.includes(actualOwnerId)) return false;

  // Round / Team filter
  const expectedRoundId = String(merged.round_id || merged.roundId || merged.team_id || '').trim();
  if (expectedRoundId) {
    const actualRoundId = String(contextMeta?.round_id || contextMeta?.roundId || lead.distribution_round_id || '').trim();
    if (actualRoundId !== expectedRoundId) return false;
  }

  // Stage / Pipeline filter
  const expectedStageId = String(merged.to_stage_id || merged.stage_id || merged.stageId || (cfg.type === 'stage' ? cfg.targetId : '')).trim();
  if (expectedStageId) {
    const actualStageId = String(contextMeta?.stageId || contextMeta?.stage_id || lead.stage_id || '').trim();
    if (actualStageId !== expectedStageId) return false;
  }
  const expectedFromStageId = String(merged.from_stage_id || '').trim();
  if (expectedFromStageId) {
    const actualPrevStageId = String(contextMeta?.previousStageId || '').trim();
    if (actualPrevStageId !== expectedFromStageId) return false;
  }
  const expectedStageKey = String(merged.stage_key || merged.stageKey || '').trim();
  if (expectedStageKey && String(contextMeta?.stageKey || '').trim() !== expectedStageKey) return false;
  const expectedPipelineId = String(merged.pipeline_id || merged.pipelineId || '').trim();
  if (expectedPipelineId && String(contextMeta?.pipelineId || lead.pipeline_id || '').trim() !== expectedPipelineId) return false;

  // Tag filters
  const expectedTagId = merged.tag_id || merged.tagId || null;
  const expectedTagName = merged.tag || merged.tag_name || merged.tagName || (cfg.type === 'tag' ? cfg.targetId : null);
  const incomingTagIds = Array.isArray(contextMeta?.tagIds) ? contextMeta!.tagIds.map(String) : [];
  const incomingTagNames = Array.isArray(contextMeta?.tagNames)
    ? contextMeta!.tagNames.map((n) => String(n).toLowerCase())
    : [];
  if (expectedTagId && !incomingTagIds.includes(String(expectedTagId)) && !leadExtra.tagIds.includes(String(expectedTagId))) {
    return false;
  }
  if (expectedTagName) {
    const expLower = String(expectedTagName).trim().toLowerCase();
    if (!incomingTagNames.includes(expLower) && !leadExtra.tagNames.includes(expLower)) return false;
  }

  // Web behavior filters (`url_contains`, `cta_text_contains`, `min_scroll_pct`, `min_duration_sec`)
  const urlContains = String(merged.url_contains || merged.page_url_contains || '').trim().toLowerCase();
  if (urlContains) {
    const curUrl = String(contextMeta?.pageUrl || contextMeta?.url || '').toLowerCase();
    const matchedUrl = curUrl.includes(urlContains) || leadExtra.visitedUrls.some((u) => u.toLowerCase().includes(urlContains));
    if (!matchedUrl) return false;
  }
  const ctaContains = String(merged.cta_text_contains || merged.element_text_contains || '').trim().toLowerCase();
  if (ctaContains) {
    const curCta = `${String(contextMeta?.elementText || '')} ${String(contextMeta?.elementSelector || '')} ${String(contextMeta?.dataCta || '')}`.toLowerCase();
    const matchedCta = curCta.includes(ctaContains) || leadExtra.clickedTexts.some((t) => t.toLowerCase().includes(ctaContains));
    if (!matchedCta) return false;
  }
  if (merged.min_scroll_pct !== undefined && merged.min_scroll_pct !== '' && Number.isFinite(Number(merged.min_scroll_pct))) {
    const curScroll = Math.max(Number(contextMeta?.scrollDepthPct || 0), leadExtra.maxScrollPct);
    if (curScroll < Number(merged.min_scroll_pct)) return false;
  }
  if (merged.min_duration_sec !== undefined && merged.min_duration_sec !== '' && Number.isFinite(Number(merged.min_duration_sec))) {
    const curDur = Math.max(
      Number(contextMeta?.sessionDurationSeconds || 0),
      Number(contextMeta?.activeDurationSeconds || 0),
      leadExtra.activeDurationSec
    );
    if (curDur < Number(merged.min_duration_sec)) return false;
  }

  // Score threshold filter
  if (triggerType === 'score_threshold' || merged.threshold !== undefined || merged.min_score !== undefined) {
    const threshold = Number(merged.threshold ?? merged.min_score ?? merged.score ?? 50);
    if (triggerType === 'score_threshold' && (!Number.isFinite(threshold) || Number(lead.lead_score || 0) < threshold)) {
      return false;
    }
    if (triggerType !== 'score_threshold' && (merged.threshold !== undefined || merged.min_score !== undefined)) {
      if (Number.isFinite(threshold) && Number(lead.lead_score || 0) < threshold) return false;
    }
  }

  return true;
}

async function dispatchMatchingActiveFlows(
  tenantId: string,
  leadId: string,
  triggerCandidates: string[],
  contextMeta?: Record<string, unknown>
): Promise<void> {
  if (!tenantId || !leadId || triggerCandidates.length === 0) return;
  const recursionDepth = Number(contextMeta?._recursionDepth || 0);
  if (recursionDepth >= 3) return;
  const fromFlowId = contextMeta?._fromFlowId ? String(contextMeta._fromFlowId) : null;

  await ensureMarketingSchema();

  const candidateSet = new Set(triggerCandidates.map((c) => String(c).toLowerCase()));

  const { activeFlows, lead, leadExtra } = await withTenantTransaction(tenantId, async (client) => {
    const [fRes, lRes] = await Promise.all([
      client.query<{ id: string; trigger_type: string; trigger_config: unknown; settings_json: unknown }>(
        `SELECT id, trigger_type, trigger_config, settings_json
         FROM mkt_flows
         WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId]
      ),
      client.query('SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1', [
        tenantId,
        leadId,
      ]),
    ]);
    const leadRow = lRes.rows[0] || null;
    if (!leadRow || fRes.rows.length === 0) {
      return {
        activeFlows: fRes.rows,
        lead: leadRow,
        leadExtra: {
          tagIds: [] as string[],
          tagNames: [] as string[],
          audienceIds: [] as string[],
          maxScrollPct: 0,
          activeDurationSec: 0,
          visitedUrls: [] as string[],
          clickedTexts: [] as string[],
        },
      };
    }

    const [tRes, aRes, wSessRes, wEvRes] = await Promise.all([
      client.query<{ id: string; name: string; slug: string }>(
        `SELECT tt.id, tt.name, tt.slug
         FROM lead_tags lt
         INNER JOIN tenant_tags tt ON tt.tenant_id = lt.tenant_id AND tt.id = lt.tag_id
         WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
        [tenantId, leadId]
      ),
      client.query<{ audience_id: string }>(
        'SELECT audience_id FROM tenant_audience_members WHERE tenant_id = $1 AND lead_id = $2',
        [tenantId, leadId]
      ),
      client.query<{ duration_seconds: number }>(
        'SELECT COALESCE(duration_seconds, 0)::int AS duration_seconds FROM mkt_web_sessions WHERE tenant_id = $1 AND lead_id = $2',
        [tenantId, leadId]
      ),
      client.query<{ event_type: string; page_url: string; element_selector: string | null; scroll_depth_pct: number | null; metadata: unknown }>(
        `SELECT event_type, page_url, element_selector, scroll_depth_pct, metadata
         FROM mkt_web_events
         WHERE tenant_id = $1 AND lead_id = $2
         ORDER BY created_at DESC LIMIT 60`,
        [tenantId, leadId]
      ),
    ]);

    const visitedUrls: string[] = [];
    const clickedTexts: string[] = [];
    let maxScrollPct = 0;
    for (const we of wEvRes.rows) {
      if (we.page_url) visitedUrls.push(String(we.page_url));
      const meta = parseJsonCol<Record<string, unknown>>(we.metadata, {});
      if (we.event_type === 'click' || we.event_type === 'outbound_click') {
        const txt = String(meta.element_text || meta.text || '').trim();
        if (txt) clickedTexts.push(txt);
        if (we.element_selector) clickedTexts.push(String(we.element_selector));
      }
      const sd = we.scroll_depth_pct !== null && we.scroll_depth_pct !== undefined ? Number(we.scroll_depth_pct) : 0;
      if (sd > maxScrollPct) maxScrollPct = sd;
    }

    return {
      activeFlows: fRes.rows,
      lead: leadRow,
      leadExtra: {
        tagIds: tRes.rows.map((r) => String(r.id)),
        tagNames: tRes.rows.flatMap((r) => [String(r.name).toLowerCase(), String(r.slug).toLowerCase()]),
        audienceIds: aRes.rows.map((r) => String(r.audience_id)),
        maxScrollPct,
        activeDurationSec: wSessRes.rows.reduce((sum, s) => sum + Number(s.duration_seconds || 0), 0),
        visitedUrls,
        clickedTexts,
      },
    };
  });

  if (!lead || activeFlows.length === 0) return;

  for (const flow of activeFlows) {
    if (fromFlowId && flow.id === fromFlowId) continue;

    const cfg = parseJsonCol<Record<string, unknown>>(flow.trigger_config, {});
    const settings = parseJsonCol<Record<string, unknown>>(flow.settings_json, {});

    if (flow.trigger_type === 'manual_enroll' && contextMeta?.flowId && String(contextMeta.flowId) !== flow.id) {
      continue;
    }

    // Build trigger list: primary trigger + optional `additional_triggers` (Multi-Trigger OR / AND coordination)
    const primaryDef = { trigger_type: flow.trigger_type, config: cfg };
    const extraRaw = Array.isArray(cfg.additional_triggers)
      ? cfg.additional_triggers
      : Array.isArray(settings.additional_triggers)
        ? settings.additional_triggers
        : [];
    const allTriggerDefs: Array<{ trigger_type: string; config: Record<string, unknown> }> = [
      primaryDef,
      ...extraRaw
        .filter((x: unknown) => x && typeof x === 'object')
        .map((x: any) => ({
          trigger_type: String(x.trigger_type || x.type || ''),
          config: (x.config && typeof x.config === 'object' ? x.config : x) as Record<string, unknown>,
        }))
        .filter((x) => Boolean(x.trigger_type)),
    ];

    const matchLogic = String(cfg.trigger_match_logic || settings.trigger_match_logic || 'OR').toUpperCase();

    // Check which triggers match the incoming event + filters
    let anyTriggerMatchedCurrentEvent = false;
    let allTriggersSatisfied = true;

    for (const tDef of allTriggerDefs) {
      const canonicalKeys = normalizeTriggerCanonicalKeys(tDef.trigger_type, tDef.config);
      const matchesIncomingType = canonicalKeys.some((k) => candidateSet.has(k));
      const filtersPass = evaluateTriggerEntryFilters(tDef.trigger_type, tDef.config, lead, leadExtra, contextMeta);

      if (matchesIncomingType && filtersPass) {
        anyTriggerMatchedCurrentEvent = true;
      } else if (matchLogic === 'AND') {
        // In AND mode, non-current triggers still must satisfy their state filters on the lead
        if (!filtersPass) {
          allTriggersSatisfied = false;
        }
      }
    }

    const flowMatched = matchLogic === 'AND' ? anyTriggerMatchedCurrentEvent && allTriggersSatisfied : anyTriggerMatchedCurrentEvent;
    if (!flowMatched) continue;

    // Short-window dedup guard prevents duplicate enrollment when multiple integration/distribution events fire simultaneously
    const dedupKey = `${tenantId}:${flow.id}:${leadId}`;
    if (isDuplicateRecentDispatch(dedupKey, 2500)) {
      continue;
    }

    // Re-entry policy guard (`once` | `after_exit` | `always` | `cooldown_days`)
    const reEntryPolicy = String(
      settings.re_entry_policy ||
        cfg.re_entry_policy ||
        settings.re_entry_mode ||
        (flow.trigger_type === 'score_threshold' ? 'once' : 'after_exit')
    ).toLowerCase();

    if (reEntryPolicy !== 'always') {
      const blockedByPolicy = await withTenantTransaction(tenantId, async (client) => {
        if (reEntryPolicy === 'once') {
          const chk = await client.query(
            'SELECT 1 FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2 AND lead_id = $3 LIMIT 1',
            [tenantId, flow.id, leadId]
          );
          return chk.rows.length > 0;
        }
        if (reEntryPolicy === 'after_exit') {
          const chk = await client.query(
            `SELECT 1 FROM mkt_flow_enrollments
             WHERE tenant_id = $1 AND flow_id = $2 AND lead_id = $3 AND status IN ('active', 'waiting', 'resumed')
             LIMIT 1`,
            [tenantId, flow.id, leadId]
          );
          return chk.rows.length > 0;
        }
        if (reEntryPolicy === 'cooldown_days') {
          const coolDays = Math.max(
            1,
            Math.min(365, Math.floor(Number(settings.re_entry_cooldown_days ?? cfg.re_entry_cooldown_days ?? 7)))
          );
          const chk = await client.query<{ enrolled_at: string }>(
            `SELECT enrolled_at FROM mkt_flow_enrollments
             WHERE tenant_id = $1 AND flow_id = $2 AND lead_id = $3
             ORDER BY enrolled_at DESC LIMIT 1`,
            [tenantId, flow.id, leadId]
          );
          if (!chk.rows[0]?.enrolled_at) return false;
          const elapsedMs = Date.now() - new Date(String(chk.rows[0].enrolled_at)).getTime();
          return elapsedMs < coolDays * 86_400_000;
        }
        return false;
      });
      if (blockedByPolicy) continue;
    }

    await executeFlowForLead(tenantId, flow.id, leadId, { _recursionDepth: recursionDepth }).catch(() => {});
  }
}

/**
 * Resumes waiting enrollments whose paused `wait_delay` step has `mode: 'wait_event'` matching the incoming event.
 */
async function resumeEnrollmentsWaitingForEvent(
  tenantId: string,
  leadId: string,
  eventKeys: string[],
  meta?: Record<string, unknown>
): Promise<void> {
  if (!tenantId || !leadId || eventKeys.length === 0) return;
  await ensureMarketingSchema();
  const keySet = new Set(eventKeys.map((k) => k.toLowerCase()));

  const candidates = await withTenantTransaction(tenantId, async (client) => {
    const r = await client.query<{
      id: string;
      flow_id: string;
      current_step_id: string | null;
      steps_json: unknown;
    }>(
      `SELECT e.id, e.flow_id, e.current_step_id, f.steps_json
       FROM mkt_flow_enrollments e
       INNER JOIN mkt_flows f ON f.tenant_id = e.tenant_id AND f.id = e.flow_id
       WHERE e.tenant_id = $1 AND e.lead_id = $2 AND e.status = 'waiting' AND e.current_step_id IS NOT NULL
       LIMIT 20`,
      [tenantId, leadId]
    );
    return r.rows;
  });

  for (const row of candidates) {
    const steps = parseJsonCol<FlowStepNodeDto[]>(row.steps_json, []).map(normalizeFlowStepNode);
    const pausedStep = steps.find((s) => s.id === String(row.current_step_id));
    if (!pausedStep) continue;
    if (normalizeFlowStepType(String(pausedStep.type)) !== 'wait_delay') continue;
    const cfg = (pausedStep.config || {}) as Record<string, unknown>;
    if (String(cfg.mode || '').toLowerCase() !== 'wait_event') continue;

    const targetEvent = String(cfg.wait_event || cfg.waitEvent || '').trim().toLowerCase();
    if (!targetEvent || !keySet.has(targetEvent)) continue;

    // Optional wait_event filters
    const urlFilter = String(cfg.event_url_contains || cfg.url_contains || '').trim().toLowerCase();
    if (urlFilter && !String(meta?.pageUrl || meta?.url || '').toLowerCase().includes(urlFilter)) continue;
    const ctaFilter = String(cfg.event_cta_contains || cfg.cta_text_contains || '').trim().toLowerCase();
    if (ctaFilter && !String(meta?.elementText || '').toLowerCase().includes(ctaFilter)) continue;
    const stageFilter = String(cfg.event_stage_id || cfg.stage_id || '').trim();
    if (stageFilter && String(meta?.stageId || '') !== stageFilter) continue;

    const claimed = await withTenantTransaction(tenantId, async (client) => {
      const upd = await client.query(
        `UPDATE mkt_flow_enrollments
         SET status = 'resumed', next_run_at = NULL
         WHERE tenant_id = $1 AND id = $2 AND status = 'waiting'`,
        [tenantId, row.id]
      );
      return (upd.rowCount || 0) > 0;
    });
    if (!claimed) continue;

    await executeFlowForLead(tenantId, row.flow_id, leadId, {
      enrollmentId: row.id,
      resumeFromStepId: row.current_step_id,
      eventMatched: true,
      matchedEventLabel: targetEvent,
    }).catch(() => {});
  }
}

/**
 * Evaluates flow-level Exit Conditions (`exitConditions` & `advancedExitTriggers`) for active/waiting enrollments.
 */
async function evaluateExitConditionsForLead(
  tenantId: string,
  leadId: string,
  exitSignal: 'opened' | 'clicked' | 'unsubscribed' | 'form_submitted' | 'purchase_event' | 'custom_event' | 'stage_changed',
  meta?: Record<string, unknown>
): Promise<void> {
  if (!tenantId || !leadId) return;
  await ensureMarketingSchema();

  await withTenantTransaction(tenantId, async (client) => {
    const r = await client.query<{ id: string; flow_id: string; settings_json: unknown; execution_trace: unknown }>(
      `SELECT e.id, e.flow_id, f.settings_json, e.execution_trace
       FROM mkt_flow_enrollments e
       INNER JOIN mkt_flows f ON f.tenant_id = e.tenant_id AND f.id = e.flow_id
       WHERE e.tenant_id = $1 AND e.lead_id = $2 AND e.status IN ('active', 'waiting')`,
      [tenantId, leadId]
    );
    for (const row of r.rows) {
      const settings = parseJsonCol<Record<string, unknown>>(row.settings_json, {});
      const exitList = Array.isArray(settings.exitConditions) ? settings.exitConditions.map(String) : [];
      const advExit =
        settings.advancedExitTriggers && typeof settings.advancedExitTriggers === 'object'
          ? (settings.advancedExitTriggers as Record<string, any>)
          : {};

      let shouldExit = false;
      if (exitSignal === 'unsubscribed') shouldExit = true;
      else if (exitSignal === 'opened' && exitList.includes('opened')) shouldExit = true;
      else if (exitSignal === 'clicked' && exitList.includes('clicked')) shouldExit = true;
      else if (exitSignal === 'stage_changed' && exitList.includes('stage_changed')) shouldExit = true;
      else if (exitSignal === 'form_submitted' && advExit.forms?.enabled) {
        const ids = Array.isArray(advExit.forms.ids) ? advExit.forms.ids.map(String) : [];
        shouldExit = Boolean(advExit.forms.all) || ids.length === 0 || ids.includes(String(meta?.formId || ''));
      } else if (exitSignal === 'purchase_event' && advExit.purchases?.enabled) {
        shouldExit = true;
      } else if (exitSignal === 'custom_event' && advExit.customEvents?.enabled) {
        shouldExit = true;
      }

      if (shouldExit) {
        const trace = parseJsonCol<FlowTraceEntry[]>(row.execution_trace, []);
        trace.push({
          step_id: 'exit_condition',
          node_type: 'exit',
          label: 'Điều kiện thoát luồng',
          outcome: `Thoát luồng tự động do sự kiện: ${exitSignal}`,
          timestamp: new Date().toISOString(),
        });
        await client.query(
          `UPDATE mkt_flow_enrollments
           SET status = 'exited', next_run_at = NULL, execution_trace = $3::jsonb, completed_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2 AND status IN ('active', 'waiting')`,
          [tenantId, row.id, JSON.stringify(trace)]
        );
      }
    }
  }).catch(() => {});
}

async function dispatchAttributedConversionCapi(params: {
  tenantId: string;
  leadId: string;
  eventName: string;
  dealValue?: number;
  requireMetaAttribution?: boolean;
  stageLabel?: string;
}): Promise<void> {
  const [tMeta, tSettings, leadCtx] = await Promise.all([
    getTenantMetaCached(params.tenantId),
    getTenantSettingsCached(params.tenantId),
    withTenantTransaction(params.tenantId, async (client) => {
      const [lRes, capiRes] = await Promise.all([
        client.query(
          `SELECT id, name, phone, email, fbc, fbp, fbclid, meta_lead_id, total_revenue_vnd, custom_fields
           FROM leads WHERE tenant_id = $1 AND id = $2 AND is_deleted = false LIMIT 1`,
          [params.tenantId, params.leadId]
        ),
        client.query<{ config_encrypted: string; iv: string; auth_tag: string }>(
          `SELECT config_encrypted, iv, auth_tag FROM tenant_integrations
           WHERE tenant_id = $1 AND integration_type = 'meta_capi' AND status = 'active' LIMIT 1`,
          [params.tenantId]
        ),
      ]);
      return {
        lead: lRes.rows[0] || null,
        hasCapiVault: Boolean(capiRes.rows[0]),
      };
    }),
  ]);

  const lead = leadCtx.lead;
  if (!lead || !leadCtx.hasCapiVault) return;

  const hasAttribution = Boolean(lead.fbc || lead.fbp || lead.fbclid || lead.meta_lead_id);
  if (params.requireMetaAttribution && !hasAttribution) return;

  await dispatchStageCapiEventDetached({
    tenantId: params.tenantId,
    tenantSlug: tMeta?.slug || 'tenant',
    eventName: params.eventName,
    tenantSettings: tSettings,
    lead: {
      leadId: String(lead.id),
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      fbc: lead.fbc,
      fbp: lead.fbp,
      fbclid: lead.fbclid,
      metaLeadId: lead.meta_lead_id,
      dealValue: params.dealValue !== undefined ? params.dealValue : Number(lead.total_revenue_vnd || 0) || undefined,
      customFields: parseJsonCol<Record<string, unknown>>(lead.custom_fields, {}),
    },
    timelineAudit: {
      actorId: null,
      actorRole: 'marketing_automation',
      stageName: params.stageLabel || params.eventName,
    },
  }).catch(() => {});
}

export function registerFlowEventListeners(): void {
  if (flowListenersRegistered) return;
  flowListenersRegistered = true;

  onDomainEvent('lead.created', async (evt) => {
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['lead_created'], {
      source: evt.payload.source,
      status: evt.payload.status,
    });
  });

  onDomainEvent('marketing.engaged', async (evt) => {
    const rawType = String(evt.payload.engagementType || '').trim().toLowerCase();
    const meta = evt.payload.metadata || {};
    const candidates: string[] = [];
    const waitEventKeys: string[] = [];

    if (rawType === 'form.submitted' || rawType === 'form_submitted') {
      candidates.push('form_submitted');
      waitEventKeys.push('form_submitted');
      await evaluateExitConditionsForLead(evt.tenantId, evt.payload.leadId, 'form_submitted', meta);
    } else if (rawType === 'email_opened') {
      candidates.push('email_opened');
      waitEventKeys.push('email_opened');
      await evaluateExitConditionsForLead(evt.tenantId, evt.payload.leadId, 'opened', meta);
    } else if (rawType === 'email_clicked' || rawType === 'link_clicked') {
      candidates.push('link_clicked');
      waitEventKeys.push('email_clicked', 'link_clicked');
      await evaluateExitConditionsForLead(evt.tenantId, evt.payload.leadId, 'clicked', meta);
    } else if (rawType === 'survey_completed') {
      candidates.push('survey_completed');
    } else if (rawType === 'web.pageview' || rawType === 'page_visited') {
      candidates.push('page_visited', 'web_event');
      waitEventKeys.push('web_pageview', 'page_visited');
    } else if (rawType === 'web.cta_click' || rawType === 'web_cta_click') {
      candidates.push('web_cta_click', 'page_visited', 'web_event');
      waitEventKeys.push('web_cta_click');
    } else if (rawType === 'web.scroll_depth' || rawType === 'web_scroll_depth') {
      candidates.push('web_scroll_depth', 'page_visited', 'web_event');
      waitEventKeys.push('web_scroll_depth');
    } else if (rawType === 'web.pricing_intent' || rawType === 'pricing_intent' || rawType === 'web_pricing_intent') {
      candidates.push('web_pricing_intent', 'page_visited', 'web_event');
      waitEventKeys.push('web_pricing_intent', 'web_pageview');
    } else if (rawType === 'web.engaged_session' || rawType === 'web_engaged_session') {
      candidates.push('web_engaged_session', 'page_visited', 'web_event');
    } else if (rawType === 'lead.assigned' || rawType === 'lead_assigned') {
      candidates.push('lead_assigned', 'round_distributed');
    } else if (rawType === 'voucher_redeemed' || rawType === 'voucher_claimed') {
      candidates.push('voucher_redeemed');
    } else if (rawType === 'purchase_event') {
      candidates.push('purchase_event');
      await evaluateExitConditionsForLead(evt.tenantId, evt.payload.leadId, 'purchase_event', meta);
    } else if (rawType === 'tag_added') {
      candidates.push('tag_added');
    } else if (rawType === 'webhook_received') {
      candidates.push('webhook_received');
      await evaluateExitConditionsForLead(evt.tenantId, evt.payload.leadId, 'custom_event', meta);
    } else if (rawType === 'flow_manual_enroll' || rawType === 'manual_enroll') {
      candidates.push('manual_enroll');
    }

    if (Number(evt.payload.scoreDelta || 0) > 0) {
      candidates.push('score_threshold');
    }

    if (waitEventKeys.length > 0) {
      await resumeEnrollmentsWaitingForEvent(evt.tenantId, evt.payload.leadId, waitEventKeys, meta);
    }

    if (candidates.length > 0) {
      await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, candidates, meta);
    }

    // Conversion -> Meta CAPI feedback loop for attributed Marketing engagements
    if ((rawType === 'form.submitted' || rawType === 'form_submitted') && meta.routingMode !== 'sale_round') {
      await dispatchAttributedConversionCapi({
        tenantId: evt.tenantId,
        leadId: evt.payload.leadId,
        eventName: 'Lead',
        requireMetaAttribution: true,
        stageLabel: String(meta.formName || 'Form Submitted'),
      }).catch(() => {});
    } else if (rawType === 'survey_completed') {
      await dispatchAttributedConversionCapi({
        tenantId: evt.tenantId,
        leadId: evt.payload.leadId,
        eventName: 'CompleteRegistration',
        requireMetaAttribution: true,
        stageLabel: 'Survey Completed',
      }).catch(() => {});
    }
  });

  onDomainEvent('lead.updated', async (evt) => {
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['score_threshold'], {
      changedFields: evt.payload.changedFields,
    });
  });

  onDomainEvent('audience.entered', async (evt) => {
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['audience_joined'], {
      audienceId: evt.payload.audienceId,
    });
  });

  onDomainEvent('lead.stage_changed', async (evt) => {
    const stageMeta = {
      stageId: evt.payload.currentStageId,
      previousStageId: evt.payload.previousStageId,
      stageKey: evt.payload.currentStageKey,
      pipelineId: evt.payload.pipelineId,
    };
    await resumeEnrollmentsWaitingForEvent(evt.tenantId, evt.payload.leadId, ['lead_stage_changed', 'stage_changed'], stageMeta);
    await evaluateExitConditionsForLead(evt.tenantId, evt.payload.leadId, 'stage_changed', stageMeta);
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['stage_changed'], stageMeta);
  });

  onDomainEvent('deal.won', async (evt) => {
    await evaluateExitConditionsForLead(evt.tenantId, evt.payload.leadId, 'purchase_event', {
      amountVnd: evt.payload.amountVnd,
    });
    await dispatchMatchingActiveFlows(evt.tenantId, evt.payload.leadId, ['purchase_event'], {
      amountVnd: evt.payload.amountVnd,
    });

    if (evt.payload.sourceEntity !== 'lead_stage') {
      await dispatchAttributedConversionCapi({
        tenantId: evt.tenantId,
        leadId: evt.payload.leadId,
        eventName: 'Purchase',
        dealValue: evt.payload.amountVnd,
        requireMetaAttribution: false,
        stageLabel: `Deal Won (${evt.payload.sourceEntity || 'deal'})`,
      }).catch(() => {});
    }
  });
}
