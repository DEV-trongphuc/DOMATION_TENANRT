export type DistributionMode =
  | 'weighted_round_robin'
  | 'strict_round_robin'
  | 'least_loaded'
  | 'manual_only';

export type DuplicateLeadAction =
  | 'route_to_previous_sale'
  | 'round_robin'
  | 'reject_duplicate'
  | 'update_existing';

export type CapiActionSource =
  | 'system_generated'
  | 'website'
  | 'app'
  | 'phone_call'
  | 'chat'
  | 'email'
  | 'physical_store'
  | 'other';

export interface TenantNoteTypeConfig {
  value: string;
  label: string;
  cat: 'call' | 'zalo' | 'note';
  internal_only?: boolean;
}

export interface TenantTicketReasonConfig {
  value: string;
  label: string;
  auto_disqualify: boolean;
}

export interface TenantRolePermissions {
  allow_manager_export_csv: boolean;
  allow_manager_manage_pipelines: boolean;
  allow_sale_create_lead: boolean;
  allow_sale_reassign_lead: boolean;
}

export type PipelineStageGroup = 'positive' | 'neutral' | 'negative';

export interface PipelineStageConfig {
  key: string;
  label: string;
  short_label: string;
  color: string;
  group: PipelineStageGroup;
  is_qualified: boolean;
  capi_event: string;
  enabled: boolean;
  order: number;
}

export interface CapiRulesConfig {
  fire_on_assign: boolean;
  dual_send: boolean;
  require_phone: boolean;
}

export interface NotificationTemplatesConfig {
  assign_email_subject: string;
  assign_email_body: string;
  assign_bot_message: string;
  sla_warning_message: string;
  ticket_admin_subject: string;
  ticket_approved_subject: string;
  ticket_rejected_subject: string;
  bot_chatid_reply: string;
  bot_help_reply: string;
  daily_report_subject: string;
}

export interface TenantSettings {
  // 1. Distribution, Duplicate & Queue Rules
  distribution_mode: DistributionMode;
  duplicate_threshold_days: number;
  duplicate_action: DuplicateLeadAction;
  enforce_work_schedule: boolean;
  work_schedule_start: string;
  work_schedule_end: string;
  work_schedule_saturday_end: string;
  work_schedule_sunday_enabled: boolean;
  timezone_offset_hours: number;
  timezone_name: string;
  enable_vacation_credits: boolean;
  vacation_credit_cap: number;
  enable_compensation_credits: boolean;
  compensation_credits_per_ticket: number;
  auto_disqualify_on_ticket_approve: boolean;
  auto_drain_on_online: boolean;
  queue_drain_batch_limit: number;
  drain_recalled_leads: boolean;
  starvation_prevention_enabled: boolean;
  starvation_max_leads_per_hour: number;
  auto_accept_on_assign: boolean;
  fallback_type: 'round' | 'admin';
  fallback_round_id: string | null;
  fallback_admin_id: string | null;
  fallback_cc_email: string;
  ticket_auto_approve_enabled: boolean;
  ticket_auto_approve_rules: Array<Record<string, unknown>>;

  // 2. SLA & Escalation Rules
  default_sla_minutes: number;
  use_default_sla_fallback: boolean;
  sla_target_seconds: number;
  sla_auto_recall_enabled: boolean;
  sla_email_subject_template: string;
  sla_email_body_template: string;

  // 3. PII Masking & RBAC Overrides
  pii_masking_enabled: boolean;
  pii_mask_phone_prefix: number;
  pii_mask_phone_suffix: number;
  pii_mask_char: string;
  pii_mask_email: boolean;
  pii_hide_internal_notes: boolean;
  pii_mask_all_sales: boolean;
  pii_mask_before_accept: boolean;
  role_permissions: TenantRolePermissions;
  default_staff_password: string;
  session_ttl_minutes: number;
  refresh_token_ttl_days: number;
  max_export_rows: number;
  max_page_size: number;

  // 4. Phone Validation & Regional Defaults
  default_country_code: string;
  default_dial_code: string;
  default_currency: string;
  allow_international_phones: boolean;
  allow_landline_phones: boolean;
  vn_mobile_prefixes: string[];
  custom_phone_regex: string;
  block_repeated_digits: boolean;
  default_lead_source: string;
  default_lead_name_prefix: string;

  // 5. Meta CAPI, Webhooks & ZaloBot Operational Settings
  dual_capi_enabled: boolean;
  capi_action_source: CapiActionSource;
  capi_api_version: string;
  capi_value_custom_field_key: string;
  capi_timeout_ms: number;
  capi_event_source_name: string;
  webhook_idempotency_ttl_hours: number;
  outbound_webhook_max_retries: number;
  outbound_webhook_timeout_ms: number;
  zalo_rate_limit_per_sec: number;
  zalo_token_ttl_hours: number;
  zalo_token_refresh_window_hours: number;
  zalo_accept_command: string;
  zalo_report_command: string;
  zalo_approve_command: string;
  zalo_reject_command: string;
  telegram_accept_command: string;
  telegram_report_command: string;
  default_smtp_host: string;
  default_smtp_port: number;

  // 6. CRM Workflow Metadata (Timeline Notes, Ticket Reasons, Onboarding)
  note_types: TenantNoteTypeConfig[];
  ticket_reasons: TenantTicketReasonConfig[];
  onboarding_tour_enabled: boolean;
  team_scale: string;

  // 7. Trial, Subscription Step & Ecosystem Upgrade Policy Defaults
  trial_duration_months: number;
  trial_duration_days: number;
  trial_warning_days: number;
  base_monthly_price_vnd: number;
  annual_discount_pct: number;
  crm_upgrade_url: string;
  erp_upgrade_url: string;

  // 10. White-Label Branding, Pipeline, UX Limits, Templates & Analytics KPIs
  brand_display_name: string;
  brand_logo_url: string;
  brand_primary_color: string;
  brand_email_accent_color: string;
  brand_email_footer_text: string;
  support_email: string;
  pipeline_capi_stages: PipelineStageConfig[];
  capi_rules: CapiRulesConfig;
  max_co_managers_per_consultant: number;
  default_table_page_size: number;
  default_date_filter: 'today' | '7d' | '30d' | 'all';
  blocked_phone_sequences: string[];
  notification_templates: NotificationTemplatesConfig;
  default_closed_deal_value_vnd: number;
  ads_target_cpl_vnd: number;
  ads_min_positive_rate_pct: number;
  ads_max_frequency_fatigue: number;
  fairness_warning_threshold_pct: number;

  // 11. Multi-Product SaaS Ecosystem Settings (Terminology, Mascot, Revenue Source & DOM Agent)
  industry_key: string;
  terminology: Record<string, string>;
  enable_ideas_mascot: boolean;
  education_addon: boolean;
  revenue_source: 'deals_won' | 'sales_orders' | 'deposits' | 'invoices';
  ai_agent_name: string;
  ai_avatar_url: string;
  pipeline_tabs: Array<Record<string, unknown>>;
}

export const DEFAULT_NOTE_TYPES: TenantNoteTypeConfig[] = [
  { value: 'CALL_CONNECTED', label: 'Gọi nghe máy • Trao đổi thành công', cat: 'call', internal_only: false },
  { value: 'CALL_BUSY_NO_ANSWER', label: 'Không nghe máy / Thuê bao / Máy bận', cat: 'call', internal_only: false },
  { value: 'ZALO_CHATTING', label: 'Đang nhắn tin chăm sóc qua Zalo', cat: 'zalo', internal_only: false },
  { value: 'APPOINTMENT_SCHEDULED', label: 'Đã chốt lịch hẹn gặp trực tiếp', cat: 'note', internal_only: false },
  { value: 'INTERNAL_NOTE', label: 'Ghi chú nội bộ (Ẩn với Đại lý F1)', cat: 'note', internal_only: true },
];

export const DEFAULT_TICKET_REASONS: TenantTicketReasonConfig[] = [
  { value: 'WRONG_NUMBER', label: 'Sai số / Thuê bao không liên lạc được', auto_disqualify: true },
  { value: 'DUPLICATE_INTERNAL', label: 'Trùng khách nội bộ dự án khác', auto_disqualify: false },
  { value: 'SPAM_JUNK', label: 'Spam / Trẻ em nháy máy', auto_disqualify: true },
  { value: 'WRONG_SEGMENT', label: 'Khách không đúng phân khúc / khu vực', auto_disqualify: false },
];

export const DEFAULT_PIPELINE_CAPI_STAGES: PipelineStageConfig[] = [
  { key: 'Qualified', label: 'Đủ ĐK / Thiện chí', short_label: 'Đủ ĐK', color: '#22c55e', group: 'positive', is_qualified: true, capi_event: 'Lead', enabled: true, order: 1 },
  { key: 'Booked', label: 'Khách hẹn gặp', short_label: 'Hẹn gặp', color: '#3b82f6', group: 'positive', is_qualified: true, capi_event: 'Schedule', enabled: true, order: 2 },
  { key: 'Booking', label: 'Khách Booking', short_label: 'Booking', color: '#6366f1', group: 'positive', is_qualified: true, capi_event: 'AddToCart', enabled: true, order: 3 },
  { key: 'Deposited', label: 'Khách đặt cọc', short_label: 'Đặt cọc', color: '#a855f7', group: 'positive', is_qualified: true, capi_event: 'InitiateCheckout', enabled: true, order: 4 },
  { key: 'Closed', label: 'Khách chốt HĐ', short_label: 'Chốt HĐ', color: '#10b981', group: 'positive', is_qualified: true, capi_event: 'Purchase', enabled: true, order: 5 },
  { key: 'Badtiming', label: 'Sai thời điểm / Cân nhắc', short_label: 'Sai TĐ', color: '#f59e0b', group: 'neutral', is_qualified: false, capi_event: '', enabled: true, order: 6 },
  { key: 'NoAnswer', label: 'Thuê bao / KBM', short_label: 'KBM', color: '#94a3b8', group: 'neutral', is_qualified: false, capi_event: '', enabled: true, order: 7 },
  { key: 'Notlead', label: 'Sai số / Không nhu cầu', short_label: 'Sai số', color: '#ef4444', group: 'negative', is_qualified: false, capi_event: '', enabled: true, order: 8 },
];

export const DEFAULT_CAPI_RULES: CapiRulesConfig = {
  fire_on_assign: true,
  dual_send: true,
  require_phone: true,
};

export const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplatesConfig = {
  assign_email_subject: '[{{brand_name}}] Lead mới: {{customer_name}} ({{phone}})',
  assign_email_body:
    'Chào {{sale_name}}, bạn vừa được phân bổ Lead mới: {{customer_name}} - SĐT: {{phone}} - Nguồn: {{source}}.',
  assign_bot_message:
    '🎯 <b>Khách hàng mới được phân bổ!</b>\n👤 Tên: <b>{{customer_name}}</b>\n📞 SĐT: <b>{{phone}}</b>\n📌 Nguồn: {{source}}\n🔄 Vòng: {{round_name}}\n⏱️ SLA: {{sla_minutes}} phút\n🔑 Mã: <code>{{lead_id}}</code>\n⚡ Tiếp nhận: <code>{{accept_cmd}} {{lead_id}}</code>',
  sla_warning_message:
    '⚠️ Cảnh báo SLA: Lead {{customer_name}} ({{phone}}) sắp quá hạn tiếp nhận {{sla_minutes}} phút!',
  ticket_admin_subject: '[Ticket mới] Yêu cầu báo lỗi Lead #{{lead_short_id}}',
  ticket_approved_subject: '[Đã duyệt Ticket] Hoàn lượt phân bổ Lead #{{lead_short_id}}',
  ticket_rejected_subject: '[Từ chối Ticket] Phiếu báo lỗi Lead #{{lead_short_id}}',
  bot_chatid_reply: '✅ Chat ID của bạn/nhóm là: <code>{{chat_id}}</code>',
  bot_help_reply:
    'ℹ️ Lệnh không được nhận diện. Các lệnh hỗ trợ: /chatid, {{accept_cmd}} <mã_lead>, {{report_cmd}} <mã_lead> <lý_do>',
  daily_report_subject: '[{{brand_name}}] Báo cáo hiệu suất Data {{report_date}}',
};

export const DEFAULT_BLOCKED_PHONE_SEQUENCES: string[] = [
  '0123456789',
  '0987654321',
  '1234567890',
  '0912345678',
  '0901234567',
];

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  distribution_mode: 'weighted_round_robin',
  duplicate_threshold_days: 90,
  duplicate_action: 'route_to_previous_sale',
  enforce_work_schedule: false,
  work_schedule_start: '08:30',
  work_schedule_end: '18:00',
  work_schedule_saturday_end: '12:00',
  work_schedule_sunday_enabled: false,
  timezone_offset_hours: 7,
  timezone_name: 'Asia/Ho_Chi_Minh',
  enable_vacation_credits: true,
  vacation_credit_cap: 20,
  enable_compensation_credits: true,
  compensation_credits_per_ticket: 1,
  auto_disqualify_on_ticket_approve: true,
  auto_drain_on_online: true,
  queue_drain_batch_limit: 25,
  drain_recalled_leads: false,
  starvation_prevention_enabled: false,
  starvation_max_leads_per_hour: 3,
  auto_accept_on_assign: false,
  fallback_type: 'round',
  fallback_round_id: null,
  fallback_admin_id: null,
  fallback_cc_email: '',
  ticket_auto_approve_enabled: false,
  ticket_auto_approve_rules: [],

  default_sla_minutes: 15,
  use_default_sla_fallback: false,
  sla_target_seconds: 4.0,
  sla_auto_recall_enabled: false,
  sla_email_subject_template: '[CẢNH BÁO SLA] Khách hàng {{customer_name}} quá hạn tiếp nhận',
  sla_email_body_template:
    'Lead {{customer_name}} ({{phone}}) giao cho {{sale_name}} đã quá hạn {{sla_minutes}} phút tại bước {{stage_name}}.',

  pii_masking_enabled: true,
  pii_mask_phone_prefix: 4,
  pii_mask_phone_suffix: 3,
  pii_mask_char: '*',
  pii_mask_email: true,
  pii_hide_internal_notes: true,
  pii_mask_all_sales: false,
  pii_mask_before_accept: false,
  role_permissions: {
    allow_manager_export_csv: false,
    allow_manager_manage_pipelines: false,
    allow_sale_create_lead: false,
    allow_sale_reassign_lead: false,
  },
  default_staff_password: 'Sale@123456',
  session_ttl_minutes: 60,
  refresh_token_ttl_days: 7,
  max_export_rows: 5000,
  max_page_size: 200,

  default_country_code: 'vn',
  default_dial_code: '84',
  default_currency: 'VND',
  allow_international_phones: true,
  allow_landline_phones: true,
  vn_mobile_prefixes: ['03', '05', '07', '08', '09'],
  custom_phone_regex: '',
  block_repeated_digits: true,
  default_lead_source: 'Webhook',
  default_lead_name_prefix: 'Khách hàng',

  dual_capi_enabled: false,
  capi_action_source: 'system_generated',
  capi_api_version: 'v21.0',
  capi_value_custom_field_key: '',
  capi_timeout_ms: 8000,
  capi_event_source_name: 'AutoData Multi-Tenant CRM',
  webhook_idempotency_ttl_hours: 24,
  outbound_webhook_max_retries: 5,
  outbound_webhook_timeout_ms: 8000,
  zalo_rate_limit_per_sec: 30,
  zalo_token_ttl_hours: 25,
  zalo_token_refresh_window_hours: 4,
  zalo_accept_command: '/tiepnhan',
  zalo_report_command: '/baoloi',
  zalo_approve_command: '/duyet',
  zalo_reject_command: '/tuchoi',
  telegram_accept_command: '/tiepnhan',
  telegram_report_command: '/baoloi',
  default_smtp_host: 'smtp.gmail.com',
  default_smtp_port: 587,

  note_types: DEFAULT_NOTE_TYPES,
  ticket_reasons: DEFAULT_TICKET_REASONS,
  onboarding_tour_enabled: true,
  team_scale: '6_20',

  trial_duration_months: 1,
  trial_duration_days: 30,
  trial_warning_days: 14,
  base_monthly_price_vnd: 1500000,
  annual_discount_pct: 15,
  crm_upgrade_url: 'https://domation.net/crm',
  erp_upgrade_url: 'https://domation.net/erp',
  brand_display_name: '',
  brand_logo_url: '/imgs/autodata/domation_ai_icon.svg',
  brand_primary_color: '#1E40FF',
  brand_email_accent_color: '#1E40FF',
  brand_email_footer_text: 'Hệ thống phân phối Lead tự động',
  support_email: '',
  pipeline_capi_stages: DEFAULT_PIPELINE_CAPI_STAGES,
  capi_rules: DEFAULT_CAPI_RULES,
  max_co_managers_per_consultant: 3,
  default_table_page_size: 20,
  default_date_filter: 'today',
  blocked_phone_sequences: DEFAULT_BLOCKED_PHONE_SEQUENCES,
  notification_templates: DEFAULT_NOTIFICATION_TEMPLATES,
  default_closed_deal_value_vnd: 50_000_000,
  ads_target_cpl_vnd: 300_000,
  ads_min_positive_rate_pct: 25,
  ads_max_frequency_fatigue: 3.5,
  fairness_warning_threshold_pct: 75,

  industry_key: 'general',
  terminology: {},
  enable_ideas_mascot: false,
  education_addon: false,
  revenue_source: 'deals_won',
  ai_agent_name: 'DOM Agent',
  ai_avatar_url: '/imgs/autodata/ICON.png',
  pipeline_tabs: [],
};

function clampNum(val: unknown, fallback: number, min: number, max: number): number {
  if (val === undefined || val === null || val === '') return fallback;
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function asBool(val: unknown, fallback: boolean): boolean {
  if (typeof val === 'boolean') return val;
  if (val === 'true' || val === 1) return true;
  if (val === 'false' || val === 0) return false;
  return fallback;
}

function asStr(val: unknown, fallback: string): string {
  if (typeof val === 'string') return val.trim() || fallback;
  return fallback;
}

function asTimeHm(val: unknown, fallback: string): string {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) return trimmed;
  }
  return fallback;
}

const VALID_DISTRIBUTION_MODES: DistributionMode[] = [
  'weighted_round_robin',
  'strict_round_robin',
  'least_loaded',
  'manual_only',
];

const VALID_DUPLICATE_ACTIONS: DuplicateLeadAction[] = [
  'route_to_previous_sale',
  'round_robin',
  'reject_duplicate',
  'update_existing',
];

const VALID_CAPI_SOURCES: CapiActionSource[] = [
  'system_generated',
  'website',
  'app',
  'phone_call',
  'chat',
  'email',
  'physical_store',
  'other',
];

function parseMaybeJson(val: unknown): unknown {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }
  }
  return val;
}

function normalizeHexColor(val: unknown, fallback: string): string {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : fallback;
}

function normalizeBrandLogoUrl(val: unknown, fallback: string): string {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed.slice(0, 500);
  if (/^https?:\/\//i.test(trimmed)) return trimmed.slice(0, 500);
  return fallback;
}

function inferPipelineGroup(key: string, isQualified: boolean): PipelineStageGroup {
  const k = key.toLowerCase();
  if (k === 'notlead' || k === 'junk' || k === 'spam' || k === 'invalid') return 'negative';
  if (k === 'badtiming' || k === 'noanswer' || k === 'pending') return 'neutral';
  if (isQualified || k === 'qualified' || k === 'booked' || k === 'booking' || k === 'deposited' || k === 'closed') {
    return 'positive';
  }
  return 'neutral';
}

function normalizePipelineStages(
  raw: unknown,
  fallback: PipelineStageConfig[]
): PipelineStageConfig[] {
  const parsed = parseMaybeJson(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return fallback.map((st) => ({ ...st }));
  }

  const fallbackByKey = new Map(fallback.map((st) => [st.key.toLowerCase(), st]));
  const seenKeys = new Set<string>();
  const cleaned: PipelineStageConfig[] = [];

  for (let i = 0; i < parsed.length && cleaned.length < 30; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const rawKey = String(obj.key || obj.stage || '')
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 40);
    if (!rawKey) continue;
    const lowerKey = rawKey.toLowerCase();
    if (seenKeys.has(lowerKey)) continue;
    seenKeys.add(lowerKey);

    const defStage = fallbackByKey.get(lowerKey);
    const label = String(obj.label || defStage?.label || rawKey).trim().slice(0, 80) || rawKey;
    const shortLabel =
      String(obj.short_label || obj.shortLabel || defStage?.short_label || label.slice(0, 14))
        .trim()
        .slice(0, 32) || label.slice(0, 14);
    const isQualified =
      obj.is_qualified !== undefined
        ? Boolean(obj.is_qualified)
        : defStage?.is_qualified ?? false;
    const rawGroup = String(obj.group || '').trim().toLowerCase();
    const group: PipelineStageGroup =
      rawGroup === 'positive' || rawGroup === 'neutral' || rawGroup === 'negative'
        ? rawGroup
        : defStage?.group ?? inferPipelineGroup(rawKey, isQualified);

    cleaned.push({
      key: defStage?.key || rawKey,
      label,
      short_label: shortLabel,
      color: normalizeHexColor(obj.color, defStage?.color || '#64748b'),
      group,
      is_qualified: isQualified,
      capi_event: String(obj.capi_event ?? defStage?.capi_event ?? '').trim().slice(0, 64),
      enabled: obj.enabled !== undefined ? Boolean(obj.enabled) : defStage?.enabled ?? true,
      order: Math.round(clampNum(obj.order, defStage?.order ?? i + 1, 1, 999)),
    });
  }

  return cleaned.length > 0
    ? cleaned.sort((a, b) => a.order - b.order)
    : fallback.map((st) => ({ ...st }));
}

function normalizeCapiRules(raw: unknown, fallback: CapiRulesConfig): CapiRulesConfig {
  const parsed = parseMaybeJson(raw);
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  return {
    fire_on_assign: asBool(obj.fire_on_assign, fallback.fire_on_assign),
    dual_send: asBool(obj.dual_send, fallback.dual_send),
    require_phone: asBool(obj.require_phone, fallback.require_phone),
  };
}

function normalizeNotificationTemplates(
  raw: unknown,
  fallback: NotificationTemplatesConfig
): NotificationTemplatesConfig {
  const parsed = parseMaybeJson(raw);
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const pickTpl = (val: unknown, fb: string): string => {
    if (typeof val !== 'string') return fb;
    const trimmed = val.trim();
    return trimmed ? trimmed.slice(0, 4000) : fb;
  };
  return {
    assign_email_subject: pickTpl(obj.assign_email_subject, fallback.assign_email_subject),
    assign_email_body: pickTpl(obj.assign_email_body, fallback.assign_email_body),
    assign_bot_message: pickTpl(obj.assign_bot_message, fallback.assign_bot_message),
    sla_warning_message: pickTpl(obj.sla_warning_message, fallback.sla_warning_message),
    ticket_admin_subject: pickTpl(obj.ticket_admin_subject, fallback.ticket_admin_subject),
    ticket_approved_subject: pickTpl(obj.ticket_approved_subject, fallback.ticket_approved_subject),
    ticket_rejected_subject: pickTpl(obj.ticket_rejected_subject, fallback.ticket_rejected_subject),
    bot_chatid_reply: pickTpl(obj.bot_chatid_reply, fallback.bot_chatid_reply),
    bot_help_reply: pickTpl(obj.bot_help_reply, fallback.bot_help_reply),
    daily_report_subject: pickTpl(obj.daily_report_subject, fallback.daily_report_subject),
  };
}

function normalizeBlockedPhoneSequences(raw: unknown, fallback: string[]): string[] {
  const parsed = parseMaybeJson(raw);
  const items = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'string'
      ? parsed.split(/[\r\n,;|\s]+/)
      : null;
  if (!items) return [...fallback];
  // Distinguish explicitly cleared empty array vs invalid input
  if (Array.isArray(parsed) && parsed.length === 0) return [];
  const cleaned = items
    .map((item) => String(item || '').replace(/\D/g, '').slice(0, 20))
    .filter((digits) => digits.length >= 5);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)).slice(0, 100) : [...fallback];
}

export function normalizeTenantSettings(
  raw?: Record<string, unknown> | null,
  baseDefaults: TenantSettings = DEFAULT_TENANT_SETTINGS
): TenantSettings {
  const s = raw && typeof raw === 'object' ? raw : {};
  const rawRolePerms =
    s.role_permissions && typeof s.role_permissions === 'object'
      ? (s.role_permissions as Record<string, unknown>)
      : {};

  const distMode = VALID_DISTRIBUTION_MODES.includes(s.distribution_mode as DistributionMode)
    ? (s.distribution_mode as DistributionMode)
    : baseDefaults.distribution_mode;

  const rawDupInput = String(
    s.duplicate_action !== undefined ? s.duplicate_action : s.duplicate_lead_action ?? ''
  ).trim();
  const mappedDupInput =
    rawDupInput === 'route_to_existing_owner'
      ? 'route_to_previous_sale'
      : rawDupInput === 'create_new_round_robin'
        ? 'round_robin'
        : rawDupInput;
  const dupAction = VALID_DUPLICATE_ACTIONS.includes(mappedDupInput as DuplicateLeadAction)
    ? (mappedDupInput as DuplicateLeadAction)
    : baseDefaults.duplicate_action;

  const capiSource = VALID_CAPI_SOURCES.includes(s.capi_action_source as CapiActionSource)
    ? (s.capi_action_source as CapiActionSource)
    : baseDefaults.capi_action_source;

  let vnMobilePrefixes = baseDefaults.vn_mobile_prefixes;
  if (Array.isArray(s.vn_mobile_prefixes) || typeof s.vn_mobile_prefixes === 'string') {
    const rawTokens = Array.isArray(s.vn_mobile_prefixes)
      ? s.vn_mobile_prefixes
      : s.vn_mobile_prefixes.split(/[,\s;]+/);
    const cleaned = rawTokens
      .map((p) => {
        const digits = String(p || '').trim().replace(/\D/g, '');
        if (/^[1-9]$/.test(digits)) return `0${digits}`;
        if (/^0\d{1,2}$/.test(digits)) return digits;
        return '';
      })
      .filter(Boolean);
    if (cleaned.length > 0) vnMobilePrefixes = Array.from(new Set(cleaned));
  }

  let noteTypes = baseDefaults.note_types;
  if (Array.isArray(s.note_types) && s.note_types.length > 0) {
    const cleanedNotes: TenantNoteTypeConfig[] = [];
    for (const item of s.note_types) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const value = String(obj.value || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_');
      const label = String(obj.label || '').trim();
      const catRaw = String(obj.cat || 'note');
      const cat: 'call' | 'zalo' | 'note' =
        catRaw === 'call' || catRaw === 'zalo' ? catRaw : 'note';
      if (value && label) {
        cleanedNotes.push({
          value,
          label,
          cat,
          internal_only: Boolean(obj.internal_only ?? value === 'INTERNAL_NOTE'),
        });
      }
    }
    if (cleanedNotes.length > 0) noteTypes = cleanedNotes;
  }

  let ticketReasons = baseDefaults.ticket_reasons;
  if (Array.isArray(s.ticket_reasons) && s.ticket_reasons.length > 0) {
    const cleanedReasons: TenantTicketReasonConfig[] = [];
    for (let idx = 0; idx < s.ticket_reasons.length; idx++) {
      const item = s.ticket_reasons[idx];
      if (typeof item === 'string') {
        const label = item.trim();
        if (label) {
          const slugVal =
            label
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .replace(/đ/gi, 'd')
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '')
              .slice(0, 32) || `REASON_${idx + 1}`;
          cleanedReasons.push({ value: slugVal, label, auto_disqualify: true });
        }
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const label = String(obj.label || obj.value || '').trim();
        const value =
          String(obj.value || label)
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_]/g, '_')
            .slice(0, 40) || `REASON_${idx + 1}`;
        if (label) {
          cleanedReasons.push({
            value,
            label,
            auto_disqualify: obj.auto_disqualify !== undefined ? Boolean(obj.auto_disqualify) : true,
          });
        }
      }
    }
    if (cleanedReasons.length > 0) ticketReasons = cleanedReasons;
  }

  const rawMaskChar = typeof s.pii_mask_char === 'string' && s.pii_mask_char.length > 0
    ? s.pii_mask_char[0]
    : baseDefaults.pii_mask_char;

  const rawCustomPhoneRegex =
    typeof s.custom_phone_regex === 'string' ? s.custom_phone_regex.trim() : baseDefaults.custom_phone_regex;
  const customPhoneRegex =
    rawCustomPhoneRegex && isSafeRegexPattern(rawCustomPhoneRegex) ? rawCustomPhoneRegex : '';

  const capiValueKey =
    typeof s.capi_value_custom_field_key === 'string'
      ? s.capi_value_custom_field_key.trim()
      : baseDefaults.capi_value_custom_field_key;

  return {
    ...baseDefaults,
    ...(s as Record<string, unknown>),
    distribution_mode: distMode,
    duplicate_threshold_days: Math.round(
      clampNum(s.duplicate_threshold_days, baseDefaults.duplicate_threshold_days, 0, 3650)
    ),
    duplicate_action: dupAction,
    enforce_work_schedule: asBool(s.enforce_work_schedule, baseDefaults.enforce_work_schedule),
    work_schedule_start: asTimeHm(s.work_schedule_start, baseDefaults.work_schedule_start),
    work_schedule_end: asTimeHm(s.work_schedule_end, baseDefaults.work_schedule_end),
    work_schedule_saturday_end: asTimeHm(s.work_schedule_saturday_end, baseDefaults.work_schedule_saturday_end),
    work_schedule_sunday_enabled: asBool(s.work_schedule_sunday_enabled, baseDefaults.work_schedule_sunday_enabled),
    timezone_offset_hours: clampNum(s.timezone_offset_hours, baseDefaults.timezone_offset_hours, -12, 14),
    timezone_name: asStr(s.timezone_name, baseDefaults.timezone_name),
    enable_vacation_credits: asBool(s.enable_vacation_credits, baseDefaults.enable_vacation_credits),
    vacation_credit_cap: Math.round(clampNum(s.vacation_credit_cap, baseDefaults.vacation_credit_cap, 0, 500)),
    enable_compensation_credits: asBool(s.enable_compensation_credits, baseDefaults.enable_compensation_credits),
    compensation_credits_per_ticket: Math.round(
      clampNum(s.compensation_credits_per_ticket, baseDefaults.compensation_credits_per_ticket, 0, 50)
    ),
    auto_disqualify_on_ticket_approve: asBool(
      s.auto_disqualify_on_ticket_approve,
      baseDefaults.auto_disqualify_on_ticket_approve
    ),
    auto_drain_on_online: asBool(s.auto_drain_on_online, baseDefaults.auto_drain_on_online),
    queue_drain_batch_limit: Math.round(
      clampNum(s.queue_drain_batch_limit, baseDefaults.queue_drain_batch_limit, 1, 500)
    ),
    drain_recalled_leads: asBool(s.drain_recalled_leads, baseDefaults.drain_recalled_leads),
    starvation_prevention_enabled: asBool(
      s.starvation_prevention_enabled,
      baseDefaults.starvation_prevention_enabled
    ),
    starvation_max_leads_per_hour: Math.round(
      clampNum(s.starvation_max_leads_per_hour, baseDefaults.starvation_max_leads_per_hour, 1, 1000)
    ),
    auto_accept_on_assign: asBool(s.auto_accept_on_assign, baseDefaults.auto_accept_on_assign),
    fallback_type: s.fallback_type === 'admin' ? 'admin' : 'round',
    fallback_round_id: typeof s.fallback_round_id === 'string' && s.fallback_round_id.trim() ? s.fallback_round_id.trim() : null,
    fallback_admin_id: typeof s.fallback_admin_id === 'string' && s.fallback_admin_id.trim() ? s.fallback_admin_id.trim() : null,
    fallback_cc_email: typeof s.fallback_cc_email === 'string' ? s.fallback_cc_email.trim() : baseDefaults.fallback_cc_email,
    ticket_auto_approve_enabled: asBool(
      s.ticket_auto_approve_enabled,
      baseDefaults.ticket_auto_approve_enabled
    ),
    ticket_auto_approve_rules: Array.isArray(s.ticket_auto_approve_rules)
      ? (s.ticket_auto_approve_rules as Array<Record<string, unknown>>)
      : baseDefaults.ticket_auto_approve_rules,

    default_sla_minutes: Math.round(clampNum(s.default_sla_minutes, baseDefaults.default_sla_minutes, 0, 10080)),
    use_default_sla_fallback: asBool(s.use_default_sla_fallback, baseDefaults.use_default_sla_fallback),
    sla_target_seconds: clampNum(s.sla_target_seconds, baseDefaults.sla_target_seconds, 0.1, 3600),
    sla_auto_recall_enabled: asBool(s.sla_auto_recall_enabled, baseDefaults.sla_auto_recall_enabled),
    sla_email_subject_template: asStr(s.sla_email_subject_template, baseDefaults.sla_email_subject_template),
    sla_email_body_template: asStr(s.sla_email_body_template, baseDefaults.sla_email_body_template),

    pii_masking_enabled: asBool(
      s.pii_masking_enabled !== undefined ? s.pii_masking_enabled : s.mask_pii_for_external,
      baseDefaults.pii_masking_enabled
    ),
    pii_mask_phone_prefix: Math.round(clampNum(s.pii_mask_phone_prefix, baseDefaults.pii_mask_phone_prefix, 0, 8)),
    pii_mask_phone_suffix: Math.round(clampNum(s.pii_mask_phone_suffix, baseDefaults.pii_mask_phone_suffix, 0, 6)),
    pii_mask_char: rawMaskChar,
    pii_mask_email: asBool(s.pii_mask_email, baseDefaults.pii_mask_email),
    pii_hide_internal_notes: asBool(s.pii_hide_internal_notes, baseDefaults.pii_hide_internal_notes),
    pii_mask_all_sales: asBool(s.pii_mask_all_sales, baseDefaults.pii_mask_all_sales),
    pii_mask_before_accept: asBool(s.pii_mask_before_accept, baseDefaults.pii_mask_before_accept),
    role_permissions: {
      allow_manager_export_csv: asBool(
        rawRolePerms.allow_manager_export_csv,
        baseDefaults.role_permissions.allow_manager_export_csv
      ),
      allow_manager_manage_pipelines: asBool(
        rawRolePerms.allow_manager_manage_pipelines,
        baseDefaults.role_permissions.allow_manager_manage_pipelines
      ),
      allow_sale_create_lead: asBool(
        rawRolePerms.allow_sale_create_lead,
        baseDefaults.role_permissions.allow_sale_create_lead
      ),
      allow_sale_reassign_lead: asBool(
        rawRolePerms.allow_sale_reassign_lead,
        baseDefaults.role_permissions.allow_sale_reassign_lead
      ),
    },
    default_staff_password:
      typeof s.default_staff_password === 'string' && s.default_staff_password.trim().length >= 8
        ? s.default_staff_password.trim()
        : baseDefaults.default_staff_password,
    session_ttl_minutes: Math.round(
      clampNum(s.session_ttl_minutes, baseDefaults.session_ttl_minutes, 5, 10080)
    ),
    refresh_token_ttl_days: Math.round(
      clampNum(s.refresh_token_ttl_days, baseDefaults.refresh_token_ttl_days, 1, 90)
    ),
    max_export_rows: Math.round(
      clampNum(s.max_export_rows, baseDefaults.max_export_rows, 10, 50000)
    ),
    max_page_size: Math.round(
      clampNum(s.max_page_size, baseDefaults.max_page_size, 10, 1000)
    ),

    default_country_code: asStr(s.default_country_code, baseDefaults.default_country_code).toLowerCase(),
    default_dial_code: asStr(s.default_dial_code, baseDefaults.default_dial_code).replace(/^\+/, ''),
    default_currency: asStr(s.default_currency, baseDefaults.default_currency).toUpperCase(),
    allow_international_phones: asBool(s.allow_international_phones, baseDefaults.allow_international_phones),
    allow_landline_phones: asBool(s.allow_landline_phones, baseDefaults.allow_landline_phones),
    vn_mobile_prefixes: vnMobilePrefixes,
    custom_phone_regex: customPhoneRegex,
    block_repeated_digits: asBool(s.block_repeated_digits, baseDefaults.block_repeated_digits),
    default_lead_source: asStr(s.default_lead_source, baseDefaults.default_lead_source),
    default_lead_name_prefix: asStr(s.default_lead_name_prefix, baseDefaults.default_lead_name_prefix),

    dual_capi_enabled: asBool(s.dual_capi_enabled, baseDefaults.dual_capi_enabled),
    capi_action_source: capiSource,
    capi_api_version: asStr(s.capi_api_version, baseDefaults.capi_api_version),
    capi_value_custom_field_key: capiValueKey,
    capi_timeout_ms: Math.round(
      clampNum(s.capi_timeout_ms, baseDefaults.capi_timeout_ms, 1000, 30000)
    ),
    capi_event_source_name: asStr(s.capi_event_source_name, baseDefaults.capi_event_source_name),
    webhook_idempotency_ttl_hours: clampNum(
      s.webhook_idempotency_ttl_hours,
      baseDefaults.webhook_idempotency_ttl_hours,
      0,
      720
    ),
    outbound_webhook_max_retries: Math.round(
      clampNum(s.outbound_webhook_max_retries, baseDefaults.outbound_webhook_max_retries, 0, 20)
    ),
    outbound_webhook_timeout_ms: Math.round(
      clampNum(s.outbound_webhook_timeout_ms, baseDefaults.outbound_webhook_timeout_ms, 1000, 30000)
    ),
    zalo_rate_limit_per_sec: Math.round(
      clampNum(s.zalo_rate_limit_per_sec, baseDefaults.zalo_rate_limit_per_sec, 1, 200)
    ),
    zalo_token_ttl_hours: clampNum(
      s.zalo_token_ttl_hours,
      baseDefaults.zalo_token_ttl_hours,
      1,
      720
    ),
    zalo_token_refresh_window_hours: clampNum(
      s.zalo_token_refresh_window_hours,
      baseDefaults.zalo_token_refresh_window_hours,
      1,
      48
    ),
    zalo_accept_command: asStr(s.zalo_accept_command, baseDefaults.zalo_accept_command),
    zalo_report_command: asStr(s.zalo_report_command, baseDefaults.zalo_report_command),
    zalo_approve_command: asStr(s.zalo_approve_command, baseDefaults.zalo_approve_command),
    zalo_reject_command: asStr(s.zalo_reject_command, baseDefaults.zalo_reject_command),
    telegram_accept_command: asStr(s.telegram_accept_command, baseDefaults.telegram_accept_command),
    telegram_report_command: asStr(s.telegram_report_command, baseDefaults.telegram_report_command),
    default_smtp_host: asStr(s.default_smtp_host, baseDefaults.default_smtp_host),
    default_smtp_port: Math.round(clampNum(s.default_smtp_port, baseDefaults.default_smtp_port, 1, 65535)),

    note_types: noteTypes,
    ticket_reasons: ticketReasons,
    onboarding_tour_enabled: asBool(s.onboarding_tour_enabled, baseDefaults.onboarding_tour_enabled),
    team_scale: asStr(s.team_scale, baseDefaults.team_scale),

    trial_duration_months: Math.round(
      clampNum(s.trial_duration_months, baseDefaults.trial_duration_months, 0, 36)
    ),
    trial_duration_days: Math.round(
      clampNum(s.trial_duration_days, baseDefaults.trial_duration_days, 0, 1095)
    ),
    trial_warning_days: Math.round(
      clampNum(s.trial_warning_days, baseDefaults.trial_warning_days, 1, 90)
    ),
    base_monthly_price_vnd: Math.round(
      clampNum(s.base_monthly_price_vnd, baseDefaults.base_monthly_price_vnd, 0, 500_000_000)
    ),
    annual_discount_pct: clampNum(s.annual_discount_pct, baseDefaults.annual_discount_pct, 0, 90),
    crm_upgrade_url: asStr(s.crm_upgrade_url, baseDefaults.crm_upgrade_url),
    erp_upgrade_url: asStr(s.erp_upgrade_url, baseDefaults.erp_upgrade_url),
    brand_display_name: asStr(s.brand_display_name, baseDefaults.brand_display_name).slice(0, 120),
    brand_logo_url: normalizeBrandLogoUrl(s.brand_logo_url, baseDefaults.brand_logo_url),
    brand_primary_color: normalizeHexColor(s.brand_primary_color, baseDefaults.brand_primary_color),
    brand_email_accent_color: normalizeHexColor(
      s.brand_email_accent_color,
      baseDefaults.brand_email_accent_color
    ),
    brand_email_footer_text: asStr(
      s.brand_email_footer_text,
      baseDefaults.brand_email_footer_text
    ).slice(0, 240),
    support_email: asStr(s.support_email, baseDefaults.support_email).slice(0, 160),
    pipeline_capi_stages: normalizePipelineStages(
      s.pipeline_capi_stages,
      baseDefaults.pipeline_capi_stages
    ),
    capi_rules: normalizeCapiRules(s.capi_rules, baseDefaults.capi_rules),
    max_co_managers_per_consultant: Math.round(
      clampNum(
        s.max_co_managers_per_consultant,
        baseDefaults.max_co_managers_per_consultant,
        0,
        20
      )
    ),
    default_table_page_size: Math.round(
      clampNum(s.default_table_page_size, baseDefaults.default_table_page_size, 10, 200)
    ),
    default_date_filter:
      s.default_date_filter === '7d' ||
      s.default_date_filter === '30d' ||
      s.default_date_filter === 'all' ||
      s.default_date_filter === 'today'
        ? s.default_date_filter
        : baseDefaults.default_date_filter,
    blocked_phone_sequences: normalizeBlockedPhoneSequences(
      s.blocked_phone_sequences,
      baseDefaults.blocked_phone_sequences
    ),
    notification_templates: normalizeNotificationTemplates(
      s.notification_templates,
      baseDefaults.notification_templates
    ),
    default_closed_deal_value_vnd: Math.round(
      clampNum(
        s.default_closed_deal_value_vnd,
        baseDefaults.default_closed_deal_value_vnd,
        0,
        100_000_000_000
      )
    ),
    ads_target_cpl_vnd: Math.round(
      clampNum(s.ads_target_cpl_vnd, baseDefaults.ads_target_cpl_vnd, 1_000, 100_000_000)
    ),
    ads_min_positive_rate_pct: clampNum(
      s.ads_min_positive_rate_pct,
      baseDefaults.ads_min_positive_rate_pct,
      1,
      100
    ),
    ads_max_frequency_fatigue: clampNum(
      s.ads_max_frequency_fatigue,
      baseDefaults.ads_max_frequency_fatigue,
      1,
      20
    ),
    fairness_warning_threshold_pct: Math.round(
      clampNum(
        s.fairness_warning_threshold_pct,
        baseDefaults.fairness_warning_threshold_pct,
        10,
        100
      )
    ),
    industry_key: asStr(s.industry_key, baseDefaults.industry_key).toLowerCase(),
    terminology:
      s.terminology && typeof s.terminology === 'object' && !Array.isArray(s.terminology)
        ? Object.fromEntries(
            Object.entries(s.terminology as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
              .map(([k, v]) => [k.trim().slice(0, 64), String(v).trim().slice(0, 120)])
          )
        : baseDefaults.terminology,
    enable_ideas_mascot: asBool(s.enable_ideas_mascot, baseDefaults.enable_ideas_mascot),
    education_addon: asBool(s.education_addon, baseDefaults.education_addon),
    revenue_source:
      s.revenue_source === 'sales_orders' ||
      s.revenue_source === 'deposits' ||
      s.revenue_source === 'invoices' ||
      s.revenue_source === 'deals_won'
        ? s.revenue_source
        : baseDefaults.revenue_source,
    ai_agent_name: asStr(s.ai_agent_name, baseDefaults.ai_agent_name).slice(0, 80),
    ai_avatar_url: normalizeBrandLogoUrl(s.ai_avatar_url, baseDefaults.ai_avatar_url),
    pipeline_tabs: Array.isArray(s.pipeline_tabs)
      ? (s.pipeline_tabs as Array<Record<string, unknown>>).slice(0, 24)
      : baseDefaults.pipeline_tabs,
  };
}

export function isSafeRegexPattern(pattern: string, maxLength = 250): boolean {
  if (typeof pattern !== 'string') return false;
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.length > maxLength) return false;

  // Scan for nested quantifiers on groups (e.g. `(a+)+`, `([0-9]+)*`, `(\d{1,5})+`) to prevent ReDoS
  let inCharClass = false;
  const groupHasQuantifier: boolean[] = [];

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\') {
      const next = trimmed[i + 1];
      // Disallow backreferences (\1..\9) in user-supplied validation patterns
      if (!inCharClass && next && next >= '1' && next <= '9') {
        return false;
      }
      i += 1;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === '(') {
      groupHasQuantifier.push(false);
      continue;
    }
    if (ch === ')') {
      const hadInnerQuantifier = groupHasQuantifier.pop() || false;
      const next = trimmed[i + 1];
      const groupIsQuantified = next === '+' || next === '*' || next === '?' || next === '{';
      if (hadInnerQuantifier && groupIsQuantified) {
        return false;
      }
      if ((hadInnerQuantifier || groupIsQuantified) && groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }
    if (ch === '+' || ch === '*' || ch === '{') {
      if (groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
    }
  }

  try {
    new RegExp(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function safeRegexTest(pattern: string, input: string, flags?: string): boolean {
  if (!isSafeRegexPattern(pattern)) return false;
  try {
    const boundedInput = String(input ?? '').slice(0, 512);
    return new RegExp(pattern.trim(), flags).test(boundedInput);
  } catch {
    return false;
  }
}

export function resolveTenantBrandName(
  cfg: Pick<TenantSettings, 'brand_display_name'>,
  meta?: { name?: string | null; slug?: string | null; rawSettings?: Record<string, unknown> } | null
): string {
  const customBrand = String(cfg?.brand_display_name || '').trim();
  if (customBrand) return customBrand;
  const rawCompany = String(meta?.rawSettings?.company_name || '').trim();
  if (rawCompany) return rawCompany;
  const tenantName = String(meta?.name || '').trim();
  if (tenantName) return tenantName;
  const slug = String(meta?.slug || '').trim();
  if (slug) return slug;
  return 'DOMATION AutoData';
}

export function flattenCustomFieldVars(
  customFields: Record<string, unknown> | null | undefined
): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!customFields || typeof customFields !== 'object') return vars;
  for (const [k, v] of Object.entries(customFields)) {
    const safeKey = String(k || '').trim();
    if (!safeKey || v === undefined || v === null) continue;
    const strVal = typeof v === 'object' ? JSON.stringify(v) : String(v);
    vars[`custom_fields.${safeKey}`] = strVal;
    vars[`cf_${safeKey}`] = strVal;
  }
  return vars;
}

export function renderTemplateString(
  template: string,
  vars: Record<string, string | number | undefined | null>
): string {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const val = vars[key];
    return val === undefined || val === null ? '' : String(val);
  });
}
