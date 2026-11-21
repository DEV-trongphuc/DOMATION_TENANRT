/**
 * DOMATION Multi-Product SaaS Suite — Entitlement & Industry Terminology Engine
 * Supports 4 Commercial Packages on 1 Shared Multi-Tenant Core (Zero-Migration Instant Unlock):
 *   1. autodata_crm         — Auto Data & CRM (Fair-Share Routing, Pipelines, Gatekeeper, Tickets, CAPI)
 *   2. marketing_standalone — Marketing Automation Standalone (Audiences, Email/Form/Survey/Flow/Voucher/Tracking)
 *   3. growth_combo         — Growth Suite (Auto Data & CRM + Marketing Automation + Revenue Attribution)
 *   4. domation_promax      — DOMATION PROMAX (Full Suite ERP + CRM + Marketing + DOM Agent)
 * Plus optional vertical add-on: education_addon (default false) & enable_ideas_mascot (default false).
 */

export type SaasPackageCode =
  | 'autodata_crm'
  | 'marketing_standalone'
  | 'growth_combo'
  | 'domation_promax';

export type LegacyPlanTier = 'starter' | 'growth' | 'enterprise';
export type ExtendedPlanTier = LegacyPlanTier | SaasPackageCode;

export type IndustryKey =
  | 'general'
  | 'real_estate'
  | 'retail'
  | 'healthcare'
  | 'manufacturing'
  | 'agency'
  | 'fnb'
  | 'education';

export type SaasModuleKey =
  // Core Workspace & Governance
  | 'settings'
  | 'org_rbac'
  | 'users'
  | 'billing'
  | 'leads'
  // Package 1: Auto Data & CRM
  | 'dashboard_crm'
  | 'pipelines'
  | 'rounds'
  | 'routing_rules'
  | 'gatekeeper'
  | 'tickets_data'
  | 'ads_capi'
  | 'sale_portal'
  | 'appointments'
  | 'integrations_crm'
  | 'dom_sales_copilot'
  // Package 2: Marketing Automation
  | 'dashboard_marketing'
  | 'audiences'
  | 'mkt_templates'
  | 'mkt_forms'
  | 'mkt_surveys'
  | 'mkt_campaigns'
  | 'mkt_flows'
  | 'mkt_vouchers'
  | 'mkt_web_tracking'
  | 'mkt_social_bot'
  | 'mkt_ai_bot'
  | 'integrations_marketing'
  | 'dom_marketing_copilot'
  // Package 3: Growth Suite Cross-Module
  | 'dashboard_growth'
  | 'revenue_attribution'
  // Package 4: DOMATION PROMAX ERP Modules
  | 'hrm'
  | 'attendance'
  | 'payroll'
  | 'approvals'
  | 'workspace_personal'
  | 'projects'
  | 'workchat'
  | 'enterprise_feed'
  | 'helpdesk'
  | 'crm_b2b'
  | 'deals'
  | 'companies'
  | 'finance'
  | 'quotes_orders'
  | 'inventory_assets'
  | 'cloud_files_ocr'
  | 'reports_bi'
  | 'dom_agent'
  // Vertical Add-on
  | 'education';

export interface SaasModuleDescriptor {
  key: SaasModuleKey;
  name: string;
  group:
    | 'core'
    | 'crm_autodata'
    | 'marketing'
    | 'growth'
    | 'erp_hrm'
    | 'erp_work'
    | 'erp_finance'
    | 'ai_dom'
    | 'addon';
  always_enabled?: boolean;
}

export const SAAS_MODULES_CATALOG: SaasModuleDescriptor[] = [
  // Core
  { key: 'leads', name: 'Danh bạ Khách hàng 360° (Master Contact)', group: 'core', always_enabled: true },
  { key: 'org_rbac', name: 'Sơ đồ Tổ chức & Phân quyền RBAC', group: 'core', always_enabled: true },
  { key: 'users', name: 'Nhân sự Tài khoản & Phân quyền Người dùng', group: 'core', always_enabled: true },
  { key: 'settings', name: 'Cấu hình Hệ thống & Từ điển Đa ngành', group: 'core', always_enabled: true },
  { key: 'billing', name: 'Gói cước & Ví thanh toán', group: 'core', always_enabled: true },

  // Package 1: Auto Data & CRM
  { key: 'dashboard_crm', name: 'Dashboard Chia số & SLA Sale', group: 'crm_autodata' },
  { key: 'pipelines', name: 'Phễu Bán hàng (CRM Pipelines)', group: 'crm_autodata' },
  { key: 'rounds', name: 'Vòng chia Fair-Share (Round-Robin)', group: 'crm_autodata' },
  { key: 'routing_rules', name: 'Luật Định tuyến Tự động', group: 'crm_autodata' },
  { key: 'gatekeeper', name: 'AI Gatekeeper Lọc Rác Đầu Vào', group: 'crm_autodata' },
  { key: 'tickets_data', name: 'Ticket Báo Lỗi & Bù Số', group: 'crm_autodata' },
  { key: 'ads_capi', name: 'Hiệu quả Quảng cáo & Meta CAPI', group: 'crm_autodata' },
  { key: 'sale_portal', name: 'Cổng Trực Nhận Số Sale Portal', group: 'crm_autodata' },
  { key: 'appointments', name: 'Đặt Lịch Hẹn 1-1 Thông Minh', group: 'crm_autodata' },
  { key: 'integrations_crm', name: 'Cổng Kết Nối Webhook / ZaloBot / Sheets', group: 'crm_autodata' },
  { key: 'dom_sales_copilot', name: 'DOM Sales Copilot', group: 'ai_dom' },

  // Package 2: Marketing Automation
  { key: 'dashboard_marketing', name: 'Dashboard Marketing Automation', group: 'marketing' },
  { key: 'audiences', name: 'Tệp Data & Tệp Logic (Audience Segments)', group: 'marketing' },
  { key: 'mkt_templates', name: 'Trình Thiết Kế Email Kéo-Thả (Email Editor)', group: 'marketing' },
  { key: 'mkt_forms', name: 'Form Builder, Form Cards & OTP Triggers', group: 'marketing' },
  { key: 'mkt_surveys', name: 'Survey & Quiz Builder', group: 'marketing' },
  { key: 'mkt_campaigns', name: 'Chiến dịch Đa kênh (Email & Zalo ZNS)', group: 'marketing' },
  { key: 'mkt_flows', name: 'Kịch bản Tự động (Automation Flows)', group: 'marketing' },
  { key: 'mkt_vouchers', name: 'Voucher, Short Link & QR Designer', group: 'marketing' },
  { key: 'mkt_web_tracking', name: 'Web Tracking & Heatmap', group: 'marketing' },
  { key: 'mkt_social_bot', name: 'Social Inbox (Messenger & Zalo OA)', group: 'marketing' },
  { key: 'mkt_ai_bot', name: 'Customer-Facing AI Bot Studio', group: 'marketing' },
  { key: 'integrations_marketing', name: 'Cổng Kết Nối AWS SES / SMTP / DKIM / ZNS', group: 'marketing' },
  { key: 'dom_marketing_copilot', name: 'DOM Marketing Copilot', group: 'ai_dom' },

  // Package 3: Growth Combo
  { key: 'dashboard_growth', name: 'Unified Growth Cockpit', group: 'growth' },
  { key: 'revenue_attribution', name: 'Phân bổ Doanh thu & ROAS Đa Kênh', group: 'growth' },

  // Package 4: DOMATION PROMAX ERP
  { key: 'hrm', name: 'Nhân sự (HRM), Hồ sơ & Hợp đồng', group: 'erp_hrm' },
  { key: 'attendance', name: 'Chấm công GPS Đa tầng & Selfie Ca trực', group: 'erp_hrm' },
  { key: 'payroll', name: 'Bảng lương, Hoa hồng & Thuế TNCN', group: 'erp_hrm' },
  { key: 'approvals', name: 'Phê duyệt Đa cấp Động (Dynamic Approvals)', group: 'erp_work' },
  { key: 'workspace_personal', name: 'Bàn làm việc Cá nhân (Focus Workspace)', group: 'erp_work' },
  { key: 'projects', name: 'Quản lý Dự án & Công việc (Kanban / Gantt)', group: 'erp_work' },
  { key: 'workchat', name: 'Trò chuyện Nội bộ (WorkChat)', group: 'erp_work' },
  { key: 'enterprise_feed', name: 'Bảng tin Doanh nghiệp & Vinh danh', group: 'erp_work' },
  { key: 'helpdesk', name: 'Helpdesk CSKH & Hỗ trợ SLA', group: 'erp_work' },
  { key: 'crm_b2b', name: 'B2B Accounts & Multi-Deals', group: 'erp_finance' },
  { key: 'deals', name: 'Quản lý Cơ hội & Deals (Kanban)', group: 'erp_finance' },
  { key: 'companies', name: 'Doanh nghiệp Khách hàng B2B (Companies)', group: 'erp_finance' },
  { key: 'finance', name: 'Tài chính, Thu-Chi & Đặt cọc', group: 'erp_finance' },
  { key: 'quotes_orders', name: 'Báo giá, Đơn bán (SO) & Đơn mua (PO)', group: 'erp_finance' },
  { key: 'inventory_assets', name: 'Kho vận FIFO, Sản phẩm & Tài sản', group: 'erp_finance' },
  { key: 'cloud_files_ocr', name: 'Tài liệu Cloud & AI OCR Hợp đồng/CCCD', group: 'erp_finance' },
  { key: 'reports_bi', name: 'Báo cáo Điều hành Đa chiều (CEO BI)', group: 'erp_finance' },
  { key: 'dom_agent', name: 'Hội đồng Trợ lý AI Nội bộ (DOM Agent)', group: 'ai_dom' },

  // Vertical Add-on
  { key: 'education', name: 'Phân hệ Đào tạo & Học vụ (Education Add-on)', group: 'addon' },
];

const CORE_MODULES: SaasModuleKey[] = ['leads', 'org_rbac', 'users', 'settings', 'billing'];

/**
 * Bidirectional Module-Key Alias Registry (Backend `SAAS_MODULES_CATALOG` <-> Frontend UI Keys)
 */
export const BACKEND_TO_FRONTEND_MODULE_ALIASES: Partial<Record<SaasModuleKey, readonly string[]>> = {
  dashboard_crm: ['crm_dashboard'],
  rounds: ['fair_share', 'consultants'],
  integrations_crm: ['integrations_autodata'],
  dashboard_marketing: ['mkt_dashboard'],
  mkt_templates: ['email_templates'],
  mkt_forms: ['forms_triggers'],
  mkt_surveys: ['surveys_quiz'],
  mkt_campaigns: ['campaigns'],
  mkt_flows: ['automation_flows'],
  mkt_vouchers: ['vouchers_qr'],
  mkt_web_tracking: ['web_tracking'],
  mkt_social_bot: ['social_bot'],
  mkt_ai_bot: ['ai_bot_studio'],
  dashboard_growth: ['growth_dashboard', 'integrations_unified'],
  revenue_attribution: ['growth_attribution'],
  hrm: ['erp_hrm_org'],
  attendance: ['erp_attendance'],
  payroll: ['erp_payroll'],
  approvals: ['erp_approvals'],
  projects: ['erp_projects_tasks'],
  workchat: ['erp_workchat'],
  finance: ['erp_finance_inventory'],
  cloud_files_ocr: ['erp_cloud_ocr'],
  education: ['education_addon'],
};

const CANONICAL_MODULE_SET = new Set<string>(SAAS_MODULES_CATALOG.map((m) => m.key));

export const FRONTEND_TO_BACKEND_MODULE_ALIASES: Record<string, SaasModuleKey> = (() => {
  const map: Record<string, SaasModuleKey> = {};
  for (const mod of SAAS_MODULES_CATALOG) {
    map[mod.key] = mod.key;
  }
  for (const [backendKey, uiKeys] of Object.entries(BACKEND_TO_FRONTEND_MODULE_ALIASES)) {
    if (!uiKeys) continue;
    for (const uiKey of uiKeys) {
      map[uiKey] = backendKey as SaasModuleKey;
    }
  }
  return map;
})();

export function normalizeCanonicalModuleKey(rawKey: unknown): SaasModuleKey | null {
  const cleaned = String(rawKey || '').trim().toLowerCase();
  if (!cleaned) return null;
  if (CANONICAL_MODULE_SET.has(cleaned)) {
    return cleaned as SaasModuleKey;
  }
  return FRONTEND_TO_BACKEND_MODULE_ALIASES[cleaned] || null;
}

export function getAliasesForModuleKey(moduleKey: SaasModuleKey): readonly string[] {
  return BACKEND_TO_FRONTEND_MODULE_ALIASES[moduleKey] || [];
}

export function expandEnabledModulesWithAliases(canonicalModules: Iterable<SaasModuleKey>): string[] {
  const expanded = new Set<string>();
  for (const modKey of canonicalModules) {
    expanded.add(modKey);
    const aliases = BACKEND_TO_FRONTEND_MODULE_ALIASES[modKey];
    if (aliases) {
      for (const alias of aliases) {
        expanded.add(alias);
      }
    }
  }
  return Array.from(expanded);
}

const AUTODATA_CRM_MODULES: SaasModuleKey[] = [
  ...CORE_MODULES,
  'dashboard_crm',
  'pipelines',
  'rounds',
  'routing_rules',
  'gatekeeper',
  'tickets_data',
  'ads_capi',
  'sale_portal',
  'appointments',
  'integrations_crm',
  'dom_sales_copilot',
];

const MARKETING_STANDALONE_MODULES: SaasModuleKey[] = [
  ...CORE_MODULES,
  'dashboard_marketing',
  'audiences',
  'mkt_templates',
  'mkt_forms',
  'mkt_surveys',
  'mkt_campaigns',
  'mkt_flows',
  'mkt_vouchers',
  'mkt_web_tracking',
  'mkt_social_bot',
  'mkt_ai_bot',
  'integrations_marketing',
  'dom_marketing_copilot',
];

const GROWTH_COMBO_MODULES: SaasModuleKey[] = Array.from(
  new Set<SaasModuleKey>([
    ...AUTODATA_CRM_MODULES,
    ...MARKETING_STANDALONE_MODULES,
    'dashboard_growth',
    'revenue_attribution',
  ])
);

const DOMATION_PROMAX_MODULES: SaasModuleKey[] = Array.from(
  new Set<SaasModuleKey>([
    ...GROWTH_COMBO_MODULES,
    'hrm',
    'attendance',
    'payroll',
    'approvals',
    'workspace_personal',
    'projects',
    'workchat',
    'enterprise_feed',
    'helpdesk',
    'crm_b2b',
    'deals',
    'companies',
    'finance',
    'quotes_orders',
    'inventory_assets',
    'cloud_files_ocr',
    'reports_bi',
    'dom_agent',
  ])
);

export interface PlanLimitsDefinition {
  max_sales: number;
  max_managers: number;
  max_users: number;
  max_rounds: number;
  monthly_lead_quota: number;
}

export interface SaasPackageDefinition {
  code: SaasPackageCode;
  plan_code: string;
  legacy_tier: LegacyPlanTier;
  order: number;
  name: string;
  short_name: string;
  badge: string;
  tagline: string;
  monthly_price_vnd: number;
  annual_discount_pct: number;
  limits: PlanLimitsDefinition;
  default_modules: SaasModuleKey[];
  tour_suite: 'autodata_crm_tour' | 'marketing_tour' | 'growth_combo_tour' | 'promax_enterprise_tour';
  connect_wizard_suite: 'crm_connectors' | 'marketing_connectors' | 'unified_growth_connectors' | 'enterprise_connectors';
  ai_capabilities: string[];
  highlights: string[];
}

export const SAAS_PACKAGES_CATALOG: Record<SaasPackageCode, SaasPackageDefinition> = {
  autodata_crm: {
    code: 'autodata_crm',
    plan_code: 'autodata_standard',
    legacy_tier: 'starter',
    order: 1,
    name: 'Auto Data & CRM',
    short_name: 'Auto Data & CRM',
    badge: 'Gói 1 • Chia Số & Phễu Sale',
    tagline: 'Chia lead công bằng theo giây, quản lý phễu CRM, chống trễ SLA, ZaloBot & Meta CAPI v21.0.',
    monthly_price_vnd: 1_500_000,
    annual_discount_pct: 15,
    limits: {
      max_sales: 20,
      max_managers: 5,
      max_users: 25,
      max_rounds: 5,
      monthly_lead_quota: 15_000,
    },
    default_modules: AUTODATA_CRM_MODULES,
    tour_suite: 'autodata_crm_tour',
    connect_wizard_suite: 'crm_connectors',
    ai_capabilities: ['dom_ai_screener', 'dom_sales_copilot'],
    highlights: [
      'Chia số Fair-Share tức thì & Thu hồi tự động khi trễ SLA',
      'Đa phễu CRM Pipeline động, Ticket báo lỗi bù số 1-đổi-1',
      'Kết nối Webhook, Google Sheets, ZaloBot, Telegram & Meta CAPI',
    ],
  },
  marketing_standalone: {
    code: 'marketing_standalone',
    plan_code: 'marketing_standalone',
    legacy_tier: 'starter',
    order: 2,
    name: 'Marketing Automation Standalone',
    short_name: 'Marketing Automation',
    badge: 'Gói 2 • Nuôi Dưỡng Đa Kênh',
    tagline: 'Thu thập Lead qua Form Card, phân Tệp Data / Tệp Logic động, gửi Email/ZNS & Automation Flow.',
    monthly_price_vnd: 1_800_000,
    annual_discount_pct: 15,
    limits: {
      max_sales: 20,
      max_managers: 5,
      max_users: 25,
      max_rounds: 5,
      monthly_lead_quota: 50_000,
    },
    default_modules: MARKETING_STANDALONE_MODULES,
    tour_suite: 'marketing_tour',
    connect_wizard_suite: 'marketing_connectors',
    ai_capabilities: ['dom_marketing_copilot', 'customer_ai_bot_studio'],
    highlights: [
      'Tệp Data & Tệp Logic động (4 tầng dữ liệu, tách tệp A/B)',
      'Email Editor kéo-thả 15 khối, Form Cards, Survey/Quiz & QR Voucher',
      'Automation Flow trực quan + Kết nối AWS SES, SMTP, DKIM, Zalo ZNS',
    ],
  },
  growth_combo: {
    code: 'growth_combo',
    plan_code: 'autodata_growth',
    legacy_tier: 'growth',
    order: 3,
    name: 'Growth Suite (CRM + Marketing)',
    short_name: 'Growth Suite',
    badge: 'Gói 3 • Khép Kín Doanh Thu',
    tagline: 'Hợp nhất 100% từ Quảng cáo/Form -> Tệp Logic nuôi dưỡng -> Chia vòng Sale -> Đo ROAS thực.',
    monthly_price_vnd: 3_000_000,
    annual_discount_pct: 15,
    limits: {
      max_sales: 85,
      max_managers: 15,
      max_users: 100,
      max_rounds: 30,
      monthly_lead_quota: 100_000,
    },
    default_modules: GROWTH_COMBO_MODULES,
    tour_suite: 'growth_combo_tour',
    connect_wizard_suite: 'unified_growth_connectors',
    ai_capabilities: ['dom_ai_screener', 'dom_sales_copilot', 'dom_marketing_copilot', 'customer_ai_bot_studio'],
    highlights: [
      'Mở khóa trọn bộ Auto Data & CRM + Marketing Automation trên 1 hồ sơ khách',
      'Tự động đẩy khách đủ điểm nóng từ Tệp Logic / Flow sang Vòng chia Sale',
      'Unified Growth & Revenue Attribution Dashboard đo ROAS từng Email/Form/Ads',
    ],
  },
  domation_promax: {
    code: 'domation_promax',
    plan_code: 'domation_crm_erp',
    legacy_tier: 'enterprise',
    order: 4,
    name: 'DOMATION PROMAX (Full Suite ERP)',
    short_name: 'DOMATION PROMAX',
    badge: 'Gói 4 • Quản Trị Toàn Diện + DOM Agent',
    tagline: 'Vận hành toàn doanh nghiệp: Nhân sự, Chấm công GPS, Lương, Phê duyệt động, Dự án, Tài chính, Kho & DOM Agent.',
    monthly_price_vnd: 6_000_000,
    annual_discount_pct: 15,
    limits: {
      max_sales: 9_999,
      max_managers: 9_999,
      max_users: 9_999,
      max_rounds: 999,
      monthly_lead_quota: 1_000_000,
    },
    default_modules: DOMATION_PROMAX_MODULES,
    tour_suite: 'promax_enterprise_tour',
    connect_wizard_suite: 'enterprise_connectors',
    ai_capabilities: [
      'dom_agent_council',
      'dom_ai_screener',
      'dom_sales_copilot',
      'dom_marketing_copilot',
      'customer_ai_bot_studio',
      'ocr_contract_id_extractor',
    ],
    highlights: [
      'Toàn bộ Growth Suite + 9 cụm phân hệ ERP vận hành nội bộ không hardcode',
      'Sơ đồ tổ chức đa cấp, Ma trận RBAC 7 tầng Data Scope & Luồng phê duyệt N bước',
      'Hội đồng trợ lý điều hành DOM Agent đa chuyên môn tuân thủ quyền RBAC',
    ],
  },
};

export interface CanonicalBillingIdentity {
  package_code: SaasPackageCode;
  plan_code: string;
  legacy_tier: LegacyPlanTier;
  step_order: number;
  default_monthly_price_vnd: number;
  default_limits: PlanLimitsDefinition;
}

const CANONICAL_BILLING_ALIAS_MAP: Record<string, SaasPackageCode> = {
  autodata_standard: 'autodata_crm',
  starter: 'autodata_crm',
  autodata_crm: 'autodata_crm',
  autodata: 'autodata_crm',
  data: 'autodata_crm',
  crm: 'autodata_crm',
  marketing_standalone: 'marketing_standalone',
  marketing: 'marketing_standalone',
  autodata_growth: 'growth_combo',
  growth: 'growth_combo',
  growth_combo: 'growth_combo',
  domation_crm_erp: 'domation_promax',
  enterprise: 'domation_promax',
  domation_promax: 'domation_promax',
  dom_erp: 'domation_promax',
  'dom-erp': 'domation_promax',
  dom_erp_promax: 'domation_promax',
  promax: 'domation_promax',
  crm_erp_suite: 'domation_promax',
  crm_erp_bundle: 'domation_promax',
};

export function resolveCanonicalBillingIdentity(rawCode?: unknown): CanonicalBillingIdentity | null {
  const key = String(rawCode || '').trim().toLowerCase();
  if (!key) return null;
  const pkgCode = CANONICAL_BILLING_ALIAS_MAP[key];
  if (!pkgCode) return null;
  const def = SAAS_PACKAGES_CATALOG[pkgCode];
  return {
    package_code: pkgCode,
    plan_code: def.plan_code,
    legacy_tier: def.legacy_tier,
    step_order: def.order,
    default_monthly_price_vnd: def.monthly_price_vnd,
    default_limits: { ...def.limits },
  };
}

export interface TenantTerminology {
  industry_key: IndustryKey;
  industry_label: string;
  customer_singular: string;
  customer_plural: string;
  lead_singular: string;
  deal_singular: string;
  deal_plural: string;
  project_singular: string;
  project_plural: string;
  campaign_singular: string;
  campaign_plural: string;
  product_singular: string;
  quote_singular: string;
  order_singular: string;
  consultant_singular: string;
  revenue_label: string;
  // CamelCase aliases for frontend convenience
  customerLabel: string;
  customersLabel: string;
  leadLabel: string;
  dealLabel: string;
  dealsLabel: string;
  projectLabel: string;
  projectsLabel: string;
  campaignLabel: string;
  campaignsLabel: string;
  productLabel: string;
  quoteLabel: string;
  orderLabel: string;
  consultantLabel: string;
  revenueLabel: string;
}

interface BaseTerminologySeed {
  industry_key: IndustryKey;
  industry_label: string;
  customer_singular: string;
  customer_plural: string;
  lead_singular: string;
  deal_singular: string;
  deal_plural: string;
  project_singular: string;
  project_plural: string;
  campaign_singular: string;
  campaign_plural: string;
  product_singular: string;
  quote_singular: string;
  order_singular: string;
  consultant_singular: string;
  revenue_label: string;
}

const BASE_INDUSTRY_TERMINOLOGY: Record<IndustryKey, BaseTerminologySeed> = {
  general: {
    industry_key: 'general',
    industry_label: 'Doanh nghiệp Đa ngành (Chuẩn B2B/B2C)',
    customer_singular: 'Khách hàng',
    customer_plural: 'Khách hàng',
    lead_singular: 'Khách tiềm năng',
    deal_singular: 'Cơ hội bán hàng',
    deal_plural: 'Cơ hội bán hàng',
    project_singular: 'Dự án',
    project_plural: 'Dự án',
    campaign_singular: 'Chiến dịch',
    campaign_plural: 'Chiến dịch',
    product_singular: 'Sản phẩm / Dịch vụ',
    quote_singular: 'Báo giá',
    order_singular: 'Đơn hàng',
    consultant_singular: 'Chuyên viên tư vấn',
    revenue_label: 'Doanh thu thực thu',
  },
  real_estate: {
    industry_key: 'real_estate',
    industry_label: 'Bất động sản & Sàn phân phối',
    customer_singular: 'Khách mua / Nhà đầu tư',
    customer_plural: 'Khách mua & Nhà đầu tư',
    lead_singular: 'Khách quan tâm dự án',
    deal_singular: 'Giao dịch / Booking',
    deal_plural: 'Giao dịch & Giữ chỗ',
    project_singular: 'Dự án BĐS',
    project_plural: 'Danh mục Dự án BĐS',
    campaign_singular: 'Giỏ hàng / Đợt mở bán',
    campaign_plural: 'Giỏ hàng & Đợt mở bán',
    product_singular: 'Sản phẩm / Mã căn',
    quote_singular: 'Phiếu tính giá',
    order_singular: 'Phiếu đặt cọc / HĐMB',
    consultant_singular: 'Chuyên viên Kinh doanh / Đại lý F1',
    revenue_label: 'Giá trị Giao dịch / Đặt cọc',
  },
  retail: {
    industry_key: 'retail',
    industry_label: 'Bán lẻ, Thương mại & E-Commerce',
    customer_singular: 'Khách mua hàng',
    customer_plural: 'Tệp Khách mua hàng',
    lead_singular: 'Khách để lại thông tin',
    deal_singular: 'Đơn tư vấn',
    deal_plural: 'Đơn tư vấn',
    project_singular: 'Dòng sản phẩm',
    project_plural: 'Dòng sản phẩm',
    campaign_singular: 'Chương trình Khuyến mãi',
    campaign_plural: 'Chương trình Khuyến mãi',
    product_singular: 'Sản phẩm (SKU)',
    quote_singular: 'Báo giá đơn hàng',
    order_singular: 'Đơn bán hàng',
    consultant_singular: 'Nhân viên Bán hàng',
    revenue_label: 'Doanh thu Đơn hàng',
  },
  healthcare: {
    industry_key: 'healthcare',
    industry_label: 'Y tế, Nha khoa, Thẩm mỹ & Clinic',
    customer_singular: 'Khách hàng / Bệnh nhân',
    customer_plural: 'Khách hàng & Bệnh nhân',
    lead_singular: 'Khách đặt lịch tư vấn',
    deal_singular: 'Hồ sơ liệu trình',
    deal_plural: 'Hồ sơ liệu trình',
    project_singular: 'Chuyên khoa / Dịch vụ',
    project_plural: 'Chuyên khoa & Dịch vụ',
    campaign_singular: 'Gói ưu đãi / Liệu trình',
    campaign_plural: 'Gói ưu đãi & Liệu trình',
    product_singular: 'Dịch vụ / Liệu trình',
    quote_singular: 'Phác đồ & Báo giá',
    order_singular: 'Phiếu thu dịch vụ',
    consultant_singular: 'Bác sĩ / Tư vấn viên',
    revenue_label: 'Doanh thu Dịch vụ',
  },
  manufacturing: {
    industry_key: 'manufacturing',
    industry_label: 'Sản xuất, Công nghiệp & Phân phối B2B',
    customer_singular: 'Đại lý / Đối tác',
    customer_plural: 'Hệ thống Đại lý & Đối tác',
    lead_singular: 'Đối tác tiềm năng',
    deal_singular: 'Thương vụ B2B',
    deal_plural: 'Thương vụ B2B',
    project_singular: 'Hợp đồng khung / Dự án',
    project_plural: 'Hợp đồng khung & Dự án',
    campaign_singular: 'Đợt chào hàng',
    campaign_plural: 'Đợt chào hàng',
    product_singular: 'Vật tư / Thành phẩm',
    quote_singular: 'Báo giá sỉ B2B',
    order_singular: 'Đơn đặt hàng sỉ (SO)',
    consultant_singular: 'Phụ trách Kinh doanh Khu vực',
    revenue_label: 'Giá trị Đơn hàng B2B',
  },
  agency: {
    industry_key: 'agency',
    industry_label: 'Agency, Công nghệ & Dịch vụ Chuyên nghiệp',
    customer_singular: 'Client',
    customer_plural: 'Danh sách Clients',
    lead_singular: 'Inbound Lead',
    deal_singular: 'Proposal / Retainer',
    deal_plural: 'Proposals & Retainers',
    project_singular: 'Dự án triển khai',
    project_plural: 'Dự án triển khai',
    campaign_singular: 'Chiến dịch tăng trưởng',
    campaign_plural: 'Chiến dịch tăng trưởng',
    product_singular: 'Gói dịch vụ / Giải pháp',
    quote_singular: 'Báo giá / Proposal',
    order_singular: 'Hợp đồng dịch vụ',
    consultant_singular: 'Account Manager / Consultant',
    revenue_label: 'Giá trị Hợp đồng (ACV)',
  },
  fnb: {
    industry_key: 'fnb',
    industry_label: 'F&B, Nhà hàng, Khách sạn & Chuỗi cửa hàng',
    customer_singular: 'Thực khách / Hội viên',
    customer_plural: 'Thực khách & Hội viên',
    lead_singular: 'Khách đặt bàn / Nhận ưu đãi',
    deal_singular: 'Đặt tiệc / Sự kiện',
    deal_plural: 'Đặt tiệc & Sự kiện',
    project_singular: 'Thương hiệu / Chi nhánh',
    project_plural: 'Thương hiệu & Chi nhánh',
    campaign_singular: 'Chiến dịch Voucher / Ưu đãi',
    campaign_plural: 'Chiến dịch Voucher & Ưu đãi',
    product_singular: 'Combo / Thực đơn',
    quote_singular: 'Báo giá tiệc / Sự kiện',
    order_singular: 'Hóa đơn / Phiếu đặt tiệc',
    consultant_singular: 'Chăm sóc Khách hàng / Quản lý Sảnh',
    revenue_label: 'Doanh thu Cửa hàng & Tiệc',
  },
  education: {
    industry_key: 'education',
    industry_label: 'Giáo dục, Đào tạo & Học viện (Education Add-on)',
    customer_singular: 'Học viên',
    customer_plural: 'Danh sách Học viên',
    lead_singular: 'Thí sinh / Học viên tiềm năng',
    deal_singular: 'Hồ sơ ghi danh',
    deal_plural: 'Hồ sơ ghi danh',
    project_singular: 'Chương trình đào tạo',
    project_plural: 'Chương trình đào tạo',
    campaign_singular: 'Khóa học / Đợt tuyển sinh',
    campaign_plural: 'Khóa học & Đợt tuyển sinh',
    product_singular: 'Khóa học / Học phần',
    quote_singular: 'Thông báo học phí',
    order_singular: 'Phiếu thu học phí',
    consultant_singular: 'Chuyên viên Tuyển sinh',
    revenue_label: 'Thực thu Học phí',
  },
};

export const VALID_INDUSTRY_KEYS: IndustryKey[] = [
  'general',
  'real_estate',
  'retail',
  'healthcare',
  'manufacturing',
  'agency',
  'fnb',
  'education',
];

export const VALID_PACKAGE_CODES: SaasPackageCode[] = [
  'autodata_crm',
  'marketing_standalone',
  'growth_combo',
  'domation_promax',
];

export function normalizeIndustryKey(raw?: unknown): IndustryKey {
  const clean = String(raw || '').trim().toLowerCase();
  if (VALID_INDUSTRY_KEYS.includes(clean as IndustryKey)) {
    return clean as IndustryKey;
  }
  if (clean === 'clinic' || clean === 'medical' || clean === 'dental' || clean === 'spa') return 'healthcare';
  if (clean === 'ecommerce' || clean === 'commerce') return 'retail';
  if (clean === 'b2b' || clean === 'factory') return 'manufacturing';
  if (clean === 'restaurant' || clean === 'hospitality') return 'fnb';
  if (clean === 'academy' || clean === 'school') return 'education';
  return 'general';
}

export function hydrateTerminologyAliases(seed: BaseTerminologySeed): TenantTerminology {
  return {
    ...seed,
    customerLabel: seed.customer_singular,
    customersLabel: seed.customer_plural,
    leadLabel: seed.lead_singular,
    dealLabel: seed.deal_singular,
    dealsLabel: seed.deal_plural,
    projectLabel: seed.project_singular,
    projectsLabel: seed.project_plural,
    campaignLabel: seed.campaign_singular,
    campaignsLabel: seed.campaign_plural,
    productLabel: seed.product_singular,
    quoteLabel: seed.quote_singular,
    orderLabel: seed.order_singular,
    consultantLabel: seed.consultant_singular,
    revenueLabel: seed.revenue_label,
  };
}

export const INDUSTRY_TERMINOLOGY_PRESETS: Record<IndustryKey, TenantTerminology> = Object.fromEntries(
  VALID_INDUSTRY_KEYS.map((k) => [k, hydrateTerminologyAliases(BASE_INDUSTRY_TERMINOLOGY[k])])
) as Record<IndustryKey, TenantTerminology>;

export function resolveTenantTerminology(
  industryKeyInput?: unknown,
  customOverrides?: Record<string, unknown> | null
): TenantTerminology {
  const key = normalizeIndustryKey(industryKeyInput);
  const base = BASE_INDUSTRY_TERMINOLOGY[key] || BASE_INDUSTRY_TERMINOLOGY.general;
  const ov = customOverrides && typeof customOverrides === 'object' ? customOverrides : {};

  const pick = (snake: keyof BaseTerminologySeed, camel?: string): string => {
    const rawSnake = ov[snake];
    if (typeof rawSnake === 'string' && rawSnake.trim()) return rawSnake.trim().slice(0, 80);
    if (camel && typeof ov[camel] === 'string' && String(ov[camel]).trim()) {
      return String(ov[camel]).trim().slice(0, 80);
    }
    return String(base[snake]);
  };

  return hydrateTerminologyAliases({
    industry_key: key,
    industry_label: pick('industry_label', 'industryLabel'),
    customer_singular: pick('customer_singular', 'customerLabel'),
    customer_plural: pick('customer_plural', 'customersLabel'),
    lead_singular: pick('lead_singular', 'leadLabel'),
    deal_singular: pick('deal_singular', 'dealLabel'),
    deal_plural: pick('deal_plural', 'dealsLabel'),
    project_singular: pick('project_singular', 'projectLabel'),
    project_plural: pick('project_plural', 'projectsLabel'),
    campaign_singular: pick('campaign_singular', 'campaignLabel'),
    campaign_plural: pick('campaign_plural', 'campaignsLabel'),
    product_singular: pick('product_singular', 'productLabel'),
    quote_singular: pick('quote_singular', 'quoteLabel'),
    order_singular: pick('order_singular', 'orderLabel'),
    consultant_singular: pick('consultant_singular', 'consultantLabel'),
    revenue_label: pick('revenue_label', 'revenueLabel'),
  });
}

export function resolvePackageCodeFromTenant(tenantRow: {
  package_code?: unknown;
  plan_tier?: unknown;
  subscription_plan_code?: unknown;
  crm_erp_upgrade_status?: unknown;
}): SaasPackageCode {
  const pkgId = resolveCanonicalBillingIdentity(tenantRow.package_code);
  const rawPlanCode = String(tenantRow.subscription_plan_code || '').trim().toLowerCase();
  const planId =
    rawPlanCode && !rawPlanCode.startsWith('trial_')
      ? resolveCanonicalBillingIdentity(rawPlanCode)
      : null;
  const tierId = resolveCanonicalBillingIdentity(tenantRow.plan_tier);

  if (pkgId && pkgId.package_code !== 'autodata_crm') {
    return pkgId.package_code;
  }
  if (planId && planId.package_code !== 'autodata_crm') {
    return planId.package_code;
  }
  if (tierId && tierId.package_code !== 'autodata_crm') {
    return tierId.package_code;
  }

  const upgStatus = String(tenantRow.crm_erp_upgrade_status || '').trim().toLowerCase();
  if (upgStatus.startsWith('active_erp') || upgStatus.startsWith('active_crm_erp')) {
    return 'domation_promax';
  }
  if (upgStatus.startsWith('active_crm')) {
    return 'growth_combo';
  }

  return pkgId?.package_code || planId?.package_code || tierId?.package_code || 'autodata_crm';
}

export function buildModulesForPackage(
  packageCode: SaasPackageCode,
  options?: { educationAddon?: boolean; extraModules?: string[]; disabledModules?: string[] }
): string[] {
  const pkgDef = SAAS_PACKAGES_CATALOG[packageCode] || SAAS_PACKAGES_CATALOG.autodata_crm;
  const allowedInPkg = new Set<SaasModuleKey>(pkgDef.default_modules);
  const set = new Set<SaasModuleKey>(pkgDef.default_modules);

  for (const coreMod of CORE_MODULES) {
    set.add(coreMod);
    allowedInPkg.add(coreMod);
  }

  if (options?.extraModules && Array.isArray(options.extraModules)) {
    for (const m of options.extraModules) {
      const canonical = normalizeCanonicalModuleKey(m);
      // Never leak Marketing/ERP modules onto Gói 1 (`autodata_crm`) from stale persisted arrays
      if (canonical && canonical !== 'education' && allowedInPkg.has(canonical)) {
        set.add(canonical);
      }
    }
  }

  if (options?.disabledModules && Array.isArray(options.disabledModules)) {
    for (const dm of options.disabledModules) {
      const canonical = normalizeCanonicalModuleKey(dm);
      if (canonical && !CORE_MODULES.includes(canonical)) {
        set.delete(canonical);
      }
    }
  }

  if (options?.educationAddon) {
    set.add('education');
  } else {
    set.delete('education');
  }

  // Strictly guarantee Gói 1 (`autodata_crm`) never includes `audiences`
  if (packageCode === 'autodata_crm') {
    set.delete('audiences');
  }

  return expandEnabledModulesWithAliases(set);
}

export interface TenantEntitlementsPayload {
  package_code: SaasPackageCode;
  package_name: string;
  package_badge: string;
  education_addon: boolean;
  enable_ideas_mascot: boolean;
  tour_suite: SaasPackageDefinition['tour_suite'];
  connect_wizard_suite: SaasPackageDefinition['connect_wizard_suite'];
  ai_capabilities: string[];
  zero_migration_ready: true;
  [key: string]: unknown;
}

export interface ResolvedTenantEntitlementSnapshot {
  package_code: SaasPackageCode;
  package_info: SaasPackageDefinition;
  enabled_modules: string[];
  entitlements: TenantEntitlementsPayload;
  industry_key: IndustryKey;
  terminology: TenantTerminology;
}

export function resolveTenantEntitlementSnapshot(
  tenantRow: {
    package_code?: unknown;
    plan_tier?: unknown;
    subscription_plan_code?: unknown;
    crm_erp_upgrade_status?: unknown;
    industry?: unknown;
    industry_key?: unknown;
    enabled_modules?: unknown;
    entitlements?: unknown;
    settings?: unknown;
  }
): ResolvedTenantEntitlementSnapshot {
  const settingsObj =
    tenantRow.settings && typeof tenantRow.settings === 'object'
      ? (tenantRow.settings as Record<string, unknown>)
      : {};
  const rawEnt =
    tenantRow.entitlements && typeof tenantRow.entitlements === 'object'
      ? (tenantRow.entitlements as Record<string, unknown>)
      : {};

  const packageCode = resolvePackageCodeFromTenant({
    package_code: tenantRow.package_code ?? rawEnt.package_code ?? settingsObj.package_code,
    plan_tier: tenantRow.plan_tier,
    subscription_plan_code: tenantRow.subscription_plan_code,
    crm_erp_upgrade_status: tenantRow.crm_erp_upgrade_status,
  });

  const pkgDef = SAAS_PACKAGES_CATALOG[packageCode] || SAAS_PACKAGES_CATALOG.autodata_crm;
  const industryKey = normalizeIndustryKey(
    tenantRow.industry_key || settingsObj.industry_key || tenantRow.industry || 'general'
  );

  // Education add-on: explicit boolean wins; otherwise true ONLY when industry_key === 'education'
  const explicitEdu =
    rawEnt.education_addon !== undefined
      ? rawEnt.education_addon
      : settingsObj.education_addon;
  const educationAddon =
    typeof explicitEdu === 'boolean'
      ? explicitEdu
      : explicitEdu === 'true'
        ? true
        : explicitEdu === 'false'
          ? false
          : industryKey === 'education';

  // Mascot IDEAS strictly disabled by default across all SaaS workspaces
  const rawMascot =
    rawEnt.enable_ideas_mascot !== undefined
      ? rawEnt.enable_ideas_mascot
      : settingsObj.enable_ideas_mascot;
  const enableIdeasMascot = rawMascot === true || rawMascot === 'true';

  // Enabled modules: union package defaults + any valid explicitly persisted extra modules when matching package
  const persistedModules = Array.isArray(tenantRow.enabled_modules)
    ? tenantRow.enabled_modules.map((m) => String(m))
    : [];
  const persistedMatchesPkg =
    persistedModules.length > 0 && rawEnt.package_code === packageCode;

  const enabledModules = buildModulesForPackage(packageCode, {
    educationAddon,
    extraModules: persistedMatchesPkg ? persistedModules : undefined,
  });

  const rawTermOverrides =
    settingsObj.terminology && typeof settingsObj.terminology === 'object'
      ? (settingsObj.terminology as Record<string, unknown>)
      : null;
  const terminology = resolveTenantTerminology(industryKey, rawTermOverrides);

  const entitlements: TenantEntitlementsPayload = {
    ...rawEnt,
    package_code: packageCode,
    package_name: pkgDef.name,
    package_badge: pkgDef.badge,
    education_addon: educationAddon,
    enable_ideas_mascot: enableIdeasMascot,
    tour_suite: pkgDef.tour_suite,
    connect_wizard_suite: pkgDef.connect_wizard_suite,
    ai_capabilities: pkgDef.ai_capabilities,
    zero_migration_ready: true,
  };

  return {
    package_code: packageCode,
    package_info: pkgDef,
    enabled_modules: enabledModules,
    entitlements,
    industry_key: industryKey,
    terminology,
  };
}
