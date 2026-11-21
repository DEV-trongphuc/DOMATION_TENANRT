import crypto from 'node:crypto';
import { APP_CONFIG } from '../config.ts';
import type { DbClient } from '../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../core/database/transaction.ts';
import { DEFAULT_TENANT_SETTINGS, normalizeTenantSettings } from '../core/settings/tenant-settings.ts';
import { getTenantBillingPolicyCached } from '../core/settings/tenant-cache.ts';
import {
  INDUSTRY_TERMINOLOGY_PRESETS,
  SAAS_PACKAGES_CATALOG,
  VALID_PACKAGE_CODES,
  buildModulesForPackage,
  normalizeIndustryKey,
  resolveCanonicalBillingIdentity,
  resolvePackageCodeFromTenant,
  resolveTenantEntitlementSnapshot,
  type CanonicalBillingIdentity,
  type ExtendedPlanTier,
  type SaasPackageCode,
  type SaasPackageDefinition,
} from '../core/security/entitlements.ts';
import { resolveUserEffectivePermissions } from '../core/security/rbac.ts';
import { getUtcMonthKey, tenantRedis, type CachedTenantBillingPolicy } from '../core/cache/tenant-redis.ts';
import {
  createPaymentSession,
  normalizePaymentProvider,
  type PaymentProvider,
  type PaymentSessionResult,
} from './payment-gateway.service.ts';

export interface BillingPlanConfig {
  code: string;
  package_code?: SaasPackageCode;
  aliases?: string[];
  step_order: number;
  name: string;
  tagline: string;
  badge?: string;
  plan_tier: 'starter' | 'growth' | 'enterprise';
  monthly_price_vnd: number;
  annual_discount_pct: number;
  annual_total_vnd: number;
  annual_monthly_equivalent_vnd: number;
  annual_saved_vnd: number;
  max_sales: number;
  max_managers: number;
  max_users: number;
  max_rounds: number;
  monthly_lead_quota: number;
  is_enterprise_upgrade?: boolean;
  features: string[];
}

export interface TopupPackageConfig {
  id: string;
  label: string;
  amount_vnd: number;
  bonus_vnd: number;
  equivalent_months_note: string;
  highlight?: boolean;
}

export interface BillingBankInfo {
  bank_name: string;
  account_number: string;
  account_holder: string;
  transfer_prefix: string;
}

export interface BillingCatalogConfig {
  currency: string;
  trial_duration_months: number;
  trial_duration_days: number;
  trial_warning_days: number;
  base_monthly_price_vnd: number;
  annual_discount_pct: number;
  min_topup_vnd: number;
  max_topup_vnd: number;
  post_trial_policy: 'step_renewal_or_upgrade' | 'strict_lock';
  crm_upgrade_url: string;
  erp_upgrade_url: string;
  payment_bank_info: BillingBankInfo;
  plans: BillingPlanConfig[];
  packages?: Record<SaasPackageCode, SaasPackageDefinition>;
  topup_packages: TopupPackageConfig[];
}

export interface TenantPlanLimits {
  max_sales: number;
  max_managers: number;
  max_users: number;
  max_rounds: number;
  monthly_lead_quota: number;
}

export interface TenantSubscriptionSnapshot {
  plan_code: string;
  plan_name: string;
  plan_tier: ExtendedPlanTier;
  package_code: SaasPackageCode;
  status: 'active' | 'trial' | 'grace' | 'suspended' | 'cancelled';
  billing_cycle: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  grace_ends_at: string | null;
  scheduled_plan_code: string | null;
  scheduled_billing_cycle: string | null;
  is_in_trial: boolean;
  trial_duration_months: number;
  trial_duration_days: number;
  trial_started_at: string;
  trial_ends_at: string;
  subscription_expires_at: string | null;
  subscription_ends_at: string;
  effective_expires_at: string;
  days_remaining: number;
  hours_remaining: number;
  is_expired: boolean;
  is_expiring_soon: boolean;
  wallet_balance_vnd: number;
  crm_erp_upgrade_status: string;
  limits: TenantPlanLimits;
  recommended_next_action: 'enjoy_trial' | 'renew_step_plan' | 'upgrade_crm_erp';
}

function clamp(val: unknown, fallback: number, min: number, max: number): number {
  if (val === undefined || val === null || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function computeAnnualNumbers(monthlyVnd: number, discountPct: number) {
  const safeMonthly = Math.max(0, Math.round(monthlyVnd));
  const safeDiscount = Math.min(90, Math.max(0, Number(discountPct) || 0));
  const fullYear = safeMonthly * 12;
  const annualTotal = Math.round(fullYear * ((100 - safeDiscount) / 100));
  const annualMonthlyEq = Math.round(annualTotal / 12);
  const annualSaved = Math.max(0, fullYear - annualTotal);
  return {
    annual_discount_pct: safeDiscount,
    annual_total_vnd: annualTotal,
    annual_monthly_equivalent_vnd: annualMonthlyEq,
    annual_saved_vnd: annualSaved,
  };
}

export function generateBillingReferenceCode(prefix: string, kind: string, slug: string): string {
  const cleanPrefix = (prefix || 'DOMDATA').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8) || 'DOMDATA';
  const cleanKind = (kind || 'TX').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8) || 'TX';
  const cleanSlug = (slug || 'TENANT').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8) || 'TENANT';
  const now = new Date();
  const yymmdd =
    String(now.getUTCFullYear()).slice(-2) +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0');
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${cleanPrefix}-${cleanKind}-${cleanSlug}-${yymmdd}-${rand}`.slice(0, 64);
}

export function buildDefaultPlans(baseMonthlyVnd = 1_500_000, annualDiscountPct = 15): BillingPlanConfig[] {
  const stdAnnual = computeAnnualNumbers(baseMonthlyVnd, annualDiscountPct);
  const growthMonthly = baseMonthlyVnd * 2;
  const growthAnnual = computeAnnualNumbers(growthMonthly, annualDiscountPct);
  const entMonthly = baseMonthlyVnd * 4;
  const entAnnual = computeAnnualNumbers(entMonthly, annualDiscountPct);
  const mktMonthly = Math.round(baseMonthlyVnd * 1.2);
  const mktAnnual = computeAnnualNumbers(mktMonthly, annualDiscountPct);

  return [
    {
      code: 'autodata_standard',
      package_code: 'autodata_crm',
      aliases: ['starter', 'autodata_crm'],
      step_order: 1,
      name: 'Auto Data Standard',
      tagline: 'Gói mặc định sau 1 tháng dùng thử cho mọi doanh nghiệp vừa và nhỏ.',
      badge: 'Mặc Định • Phổ Biến Nhất',
      plan_tier: 'starter',
      monthly_price_vnd: baseMonthlyVnd,
      ...stdAnnual,
      max_sales: 20,
      max_managers: 5,
      max_users: 25,
      max_rounds: 5,
      monthly_lead_quota: 15_000,
      is_enterprise_upgrade: false,
      features: [
        'Tự động chia vòng Auto Data Router tức thì (Round-Robin / Trọng số)',
        'Kết nối Webhook đa kênh (Facebook Ads, Website, TikTok, Google Sheets)',
        'Bắn thông báo ZaloBot cá nhân & phản hồi Meta CAPI v21.0 (HTTP 200)',
        'Công tắc Online / Nghỉ phép & Che giấu SĐT bảo mật cho Cộng tác viên / F1',
        'Quản lý tới 25 nhân sự nhận số & 5 vòng định tuyến song song',
      ],
    },
    {
      code: 'autodata_growth',
      package_code: 'growth_combo',
      aliases: ['growth', 'growth_combo'],
      step_order: 2,
      name: 'Auto Data Scale Pro',
      tagline: 'Mở rộng đa phòng ban, đa chi nhánh & Dual-Send Meta CAPI nâng cao.',
      badge: 'Đội Sale Quy Mô Lớn',
      plan_tier: 'growth',
      monthly_price_vnd: growthMonthly,
      ...growthAnnual,
      max_sales: 85,
      max_managers: 15,
      max_users: 100,
      max_rounds: 30,
      monthly_lead_quota: 100_000,
      is_enterprise_upgrade: false,
      features: [
        'Toàn bộ tính năng gói Standard + Đa phễu Pipeline độc lập theo sản phẩm',
        'Routing Rules chuyên sâu theo UTM Source, Chiến dịch, Khu vực & Khung giờ',
        'Dual-Send Meta CAPI 2 Dataset song song + SLA Auto-Recall tự thu hồi số trễ',
        'Đền bù tự động 1-đổi-1 khi duyệt Ticket lỗi & Báo cáo đối soát Gini',
        'Quản lý tới 100 nhân sự / Đại lý liên kết & 100.000 Leads / tháng',
      ],
    },
    {
      code: 'domation_crm_erp',
      package_code: 'domation_promax',
      aliases: ['enterprise', 'domation_promax'],
      step_order: 3,
      name: 'Nâng Cấp DOMATION CRM 360° / ERP 5.0',
      tagline: 'Chuyển đổi liền mạch từ Auto Data lên Hệ sinh thái Quản trị Toàn diện DOMATION.',
      badge: 'Hệ Sinh Thái Enterprise',
      plan_tier: 'enterprise',
      monthly_price_vnd: entMonthly,
      ...entAnnual,
      max_sales: 9_999,
      max_managers: 9_999,
      max_users: 9_999,
      max_rounds: 999,
      monthly_lead_quota: 1_000_000,
      is_enterprise_upgrade: true,
      features: [
        'Giữ nguyên 100% dữ liệu Lead, lịch sử Timeline & cấu hình nhân sự hiện có',
        'DOMATION CRM 360°: Kanban 8 nấc, kịch bản CSKH tự động, hợp đồng & hóa đơn điện tử',
        'DOMATION ERP 5.0: 12 phân hệ HRM/Chấm công GPS, Lương KPI, Tài chính, Kho vận',
        'Hỗ trợ triển khai Private Cloud hoặc Server độc lập riêng của doanh nghiệp',
      ],
    },
    {
      code: 'marketing_standalone',
      package_code: 'marketing_standalone',
      aliases: ['marketing'],
      step_order: 4,
      name: 'Marketing Automation Standalone',
      tagline: 'Thu thập Lead qua Form Card, phân Tệp Data / Tệp Logic động, gửi Email/ZNS & Automation Flow.',
      badge: 'Nuôi Dưỡng Đa Kênh',
      plan_tier: 'starter',
      monthly_price_vnd: mktMonthly,
      ...mktAnnual,
      max_sales: 20,
      max_managers: 5,
      max_users: 25,
      max_rounds: 5,
      monthly_lead_quota: 50_000,
      is_enterprise_upgrade: false,
      features: [
        'Tệp Data & Tệp Logic động (4 tầng dữ liệu, tách tệp A/B)',
        'Email Editor kéo-thả 15 khối, Form Cards, Survey/Quiz & QR Voucher',
        'Automation Flow trực quan + Kết nối AWS SES, SMTP, DKIM, Zalo ZNS',
      ],
    },
  ];
}

export function buildDefaultTopupPackages(baseMonthlyVnd = 1_500_000, annualDiscountPct = 15): TopupPackageConfig[] {
  const stdAnnual = computeAnnualNumbers(baseMonthlyVnd, annualDiscountPct);
  const sixMonthBase = Math.round(baseMonthlyVnd * 6);
  const sixMonthBonus = Math.round(sixMonthBase * 0.05);
  return [
    {
      id: 'topup_1m',
      label: 'Gói Topup 1 Tháng',
      amount_vnd: baseMonthlyVnd,
      bonus_vnd: 0,
      equivalent_months_note: 'Đủ gia hạn ngay 1 tháng gói Standard',
      highlight: false,
    },
    {
      id: 'topup_3m',
      label: 'Gói Topup 3 Tháng',
      amount_vnd: baseMonthlyVnd * 3,
      bonus_vnd: 0,
      equivalent_months_note: 'Đủ gia hạn 1 quý (3 tháng) liên tục',
      highlight: false,
    },
    {
      id: 'topup_6m',
      label: 'Gói Topup 6 Tháng (+5% Bonus)',
      amount_vnd: sixMonthBase,
      bonus_vnd: sixMonthBonus,
      equivalent_months_note: `Tặng thêm ${sixMonthBonus.toLocaleString('vi-VN')}₫ vào ví gia hạn`,
      highlight: false,
    },
    {
      id: 'topup_12m',
      label: `Gói Topup Năm (Tiết kiệm ${annualDiscountPct}%)`,
      amount_vnd: stdAnnual.annual_total_vnd,
      bonus_vnd: 0,
      equivalent_months_note: `Đủ mua gói Năm (-${annualDiscountPct}%), chỉ ${stdAnnual.annual_monthly_equivalent_vnd.toLocaleString('vi-VN')}₫/tháng`,
      highlight: true,
    },
  ];
}

const defaultBasePrice = Number(process.env.BILLING_BASE_MONTHLY_PRICE_VND) || DEFAULT_TENANT_SETTINGS.base_monthly_price_vnd;
const defaultAnnualDiscount = Number(process.env.BILLING_ANNUAL_DISCOUNT_PCT) || DEFAULT_TENANT_SETTINGS.annual_discount_pct;

export const DEFAULT_BILLING_CATALOG: BillingCatalogConfig = {
  currency: process.env.BILLING_DEFAULT_CURRENCY || DEFAULT_TENANT_SETTINGS.default_currency || 'VND',
  trial_duration_months: Number(process.env.BILLING_TRIAL_DURATION_MONTHS) || DEFAULT_TENANT_SETTINGS.trial_duration_months,
  trial_duration_days: Number(process.env.BILLING_TRIAL_DURATION_DAYS) || DEFAULT_TENANT_SETTINGS.trial_duration_days,
  trial_warning_days: Number(process.env.BILLING_TRIAL_WARNING_DAYS) || DEFAULT_TENANT_SETTINGS.trial_warning_days,
  base_monthly_price_vnd: defaultBasePrice,
  annual_discount_pct: defaultAnnualDiscount,
  min_topup_vnd: Number(process.env.BILLING_MIN_TOPUP_VND) || 100_000,
  max_topup_vnd: Number(process.env.BILLING_MAX_TOPUP_VND) || 500_000_000,
  post_trial_policy: (process.env.BILLING_POST_TRIAL_POLICY as any) || 'step_renewal_or_upgrade',
  crm_upgrade_url: process.env.CRM_UPGRADE_URL || DEFAULT_TENANT_SETTINGS.crm_upgrade_url,
  erp_upgrade_url: process.env.ERP_UPGRADE_URL || DEFAULT_TENANT_SETTINGS.erp_upgrade_url,
  payment_bank_info: {
    bank_name: process.env.BILLING_BANK_NAME || 'Techcombank (TCB)',
    account_number: process.env.BILLING_ACCOUNT_NUMBER || '19038889996868',
    account_holder: process.env.BILLING_ACCOUNT_HOLDER || 'CONG TY GIAI PHAP CONG NGHE DOMATION',
    transfer_prefix: process.env.BILLING_TRANSFER_PREFIX || 'DOMDATA',
  },
  plans: buildDefaultPlans(defaultBasePrice, defaultAnnualDiscount),
  packages: SAAS_PACKAGES_CATALOG,
  topup_packages: buildDefaultTopupPackages(defaultBasePrice, defaultAnnualDiscount),
};

export function normalizeBillingCatalog(raw?: Record<string, unknown> | null): BillingCatalogConfig {
  const s = raw && typeof raw === 'object' ? raw : {};

  const hasExplicitMonths = s.trial_duration_months !== undefined && s.trial_duration_months !== null;
  const hasExplicitDays = s.trial_duration_days !== undefined && s.trial_duration_days !== null;

  const trialMonths = Math.round(
    clamp(s.trial_duration_months, DEFAULT_BILLING_CATALOG.trial_duration_months, 0, 36)
  );
  const trialDays = hasExplicitDays
    ? Math.round(clamp(s.trial_duration_days, DEFAULT_BILLING_CATALOG.trial_duration_days, 0, 1095))
    : hasExplicitMonths
      ? trialMonths * 30
      : DEFAULT_BILLING_CATALOG.trial_duration_days;

  const baseMonthly = Math.round(
    clamp(s.base_monthly_price_vnd, DEFAULT_BILLING_CATALOG.base_monthly_price_vnd, 0, 500_000_000)
  );
  const annualDiscount = clamp(s.annual_discount_pct, DEFAULT_BILLING_CATALOG.annual_discount_pct, 0, 90);
  const warningDays = Math.round(clamp(s.trial_warning_days, DEFAULT_BILLING_CATALOG.trial_warning_days, 1, 90));
  const minTopup = Math.round(clamp(s.min_topup_vnd, DEFAULT_BILLING_CATALOG.min_topup_vnd, 10_000, 100_000_000));
  const maxTopup = Math.round(
    clamp(s.max_topup_vnd, DEFAULT_BILLING_CATALOG.max_topup_vnd, minTopup, 5_000_000_000)
  );

  const rawBank =
    s.payment_bank_info && typeof s.payment_bank_info === 'object'
      ? (s.payment_bank_info as Record<string, unknown>)
      : {};

  const bankInfo: BillingBankInfo = {
    bank_name: String(rawBank.bank_name || DEFAULT_BILLING_CATALOG.payment_bank_info.bank_name).trim(),
    account_number: String(rawBank.account_number || DEFAULT_BILLING_CATALOG.payment_bank_info.account_number).trim(),
    account_holder: String(rawBank.account_holder || DEFAULT_BILLING_CATALOG.payment_bank_info.account_holder).trim(),
    transfer_prefix: String(rawBank.transfer_prefix || DEFAULT_BILLING_CATALOG.payment_bank_info.transfer_prefix)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, ''),
  };

  let plans = buildDefaultPlans(baseMonthly, annualDiscount);
  if (Array.isArray(s.plans) && s.plans.length > 0) {
    const normalizedPlans: BillingPlanConfig[] = [];
    for (let i = 0; i < s.plans.length; i++) {
      const item = s.plans[i];
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const code = String(obj.code || `plan_${i + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_');
      const identity = resolveCanonicalBillingIdentity(code);
      const name = String(obj.name || code).trim();
      const tierRaw = String(obj.plan_tier || identity?.legacy_tier || 'starter');
      const planTier: 'starter' | 'growth' | 'enterprise' =
        tierRaw === 'growth' || tierRaw === 'enterprise' ? tierRaw : 'starter';
      const monthly = Math.round(clamp(obj.monthly_price_vnd, baseMonthly, 0, 500_000_000));
      const disc = clamp(obj.annual_discount_pct, annualDiscount, 0, 90);
      const annualCalc = computeAnnualNumbers(monthly, disc);
      const features = Array.isArray(obj.features)
        ? obj.features.map((f) => String(f || '').trim()).filter(Boolean)
        : [];
      normalizedPlans.push({
        code,
        package_code: identity?.package_code,
        aliases: Array.isArray(obj.aliases) ? obj.aliases.map(String) : undefined,
        step_order: Math.round(clamp(obj.step_order, i + 1, 1, 99)),
        name,
        tagline: String(obj.tagline || '').trim(),
        badge: obj.badge ? String(obj.badge).trim() : undefined,
        plan_tier: planTier,
        monthly_price_vnd: monthly,
        ...annualCalc,
        max_sales: Math.round(clamp(obj.max_sales, Math.round(clamp(obj.max_users, 25, 1, 100_000) * 0.8), 1, 100_000)),
        max_managers: Math.round(clamp(obj.max_managers, Math.max(2, Math.round(clamp(obj.max_users, 25, 1, 100_000) * 0.2)), 1, 10_000)),
        max_users: Math.round(clamp(obj.max_users, 25, 1, 100_000)),
        max_rounds: Math.round(clamp(obj.max_rounds, 5, 1, 10_000)),
        monthly_lead_quota: Math.round(clamp(obj.monthly_lead_quota, 15_000, 100, 100_000_000)),
        is_enterprise_upgrade: Boolean(obj.is_enterprise_upgrade ?? planTier === 'enterprise'),
        features: features.length > 0 ? features : plans[Math.min(i, plans.length - 1)].features,
      });
    }
    if (normalizedPlans.length > 0) {
      plans = normalizedPlans.sort((a, b) => a.step_order - b.step_order);
    }
  }

  let topupPackages = buildDefaultTopupPackages(baseMonthly, annualDiscount);
  if (Array.isArray(s.topup_packages) && s.topup_packages.length > 0) {
    const cleanedTopups: TopupPackageConfig[] = [];
    for (let i = 0; i < s.topup_packages.length; i++) {
      const item = s.topup_packages[i];
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const amt = Math.round(clamp(obj.amount_vnd, baseMonthly, minTopup, maxTopup));
      cleanedTopups.push({
        id: String(obj.id || `topup_${i + 1}`).trim(),
        label: String(obj.label || `Topup ${amt.toLocaleString('vi-VN')}₫`).trim(),
        amount_vnd: amt,
        bonus_vnd: Math.round(clamp(obj.bonus_vnd, 0, 0, 100_000_000)),
        equivalent_months_note: String(obj.equivalent_months_note || '').trim(),
        highlight: Boolean(obj.highlight),
      });
    }
    if (cleanedTopups.length > 0) topupPackages = cleanedTopups;
  }

  return {
    currency: String(s.currency || DEFAULT_BILLING_CATALOG.currency).trim().toUpperCase() || 'VND',
    trial_duration_months: trialMonths,
    trial_duration_days: trialDays,
    trial_warning_days: warningDays,
    base_monthly_price_vnd: baseMonthly,
    annual_discount_pct: annualDiscount,
    min_topup_vnd: minTopup,
    max_topup_vnd: maxTopup,
    post_trial_policy: s.post_trial_policy === 'strict_lock' ? 'strict_lock' : 'step_renewal_or_upgrade',
    crm_upgrade_url: String(s.crm_upgrade_url || DEFAULT_BILLING_CATALOG.crm_upgrade_url).trim(),
    erp_upgrade_url: String(s.erp_upgrade_url || DEFAULT_BILLING_CATALOG.erp_upgrade_url).trim(),
    payment_bank_info: bankInfo,
    plans,
    packages: SAAS_PACKAGES_CATALOG,
    topup_packages: topupPackages,
  };
}

let cachedBillingCatalog: BillingCatalogConfig | null = null;
let cachedBillingCatalogExpiresAt = 0;
const BILLING_CATALOG_CACHE_TTL_MS = APP_CONFIG.tenantCacheTtlSeconds * 1000;

export function invalidateBillingCatalogCache(): void {
  cachedBillingCatalog = null;
  cachedBillingCatalogExpiresAt = 0;
  tenantRedis.invalidateTenantMonthlyLeadCount();
}

async function queryBillingCatalogFromClient(client: DbClient): Promise<BillingCatalogConfig> {
  const [catRes, defRes] = await Promise.all([
    client.query<{ setting_value: Record<string, unknown> }>(
      "SELECT setting_value FROM platform_settings WHERE setting_key = 'billing_catalog' LIMIT 1"
    ),
    client.query<{ setting_value: Record<string, unknown> }>(
      "SELECT setting_value FROM platform_settings WHERE setting_key = 'default_tenant_settings' LIMIT 1"
    ),
  ]);
  const defVal = defRes.rows[0]?.setting_value || {};
  const catVal = catRes.rows[0]?.setting_value || {};
  return normalizeBillingCatalog({
    currency: defVal.default_currency,
    trial_duration_months: defVal.trial_duration_months,
    trial_duration_days: defVal.trial_duration_days,
    trial_warning_days: defVal.trial_warning_days,
    base_monthly_price_vnd: defVal.base_monthly_price_vnd,
    annual_discount_pct: defVal.annual_discount_pct,
    crm_upgrade_url: defVal.crm_upgrade_url,
    erp_upgrade_url: defVal.erp_upgrade_url,
    ...catVal,
  });
}

export async function getPlatformBillingCatalog(existingClient?: DbClient): Promise<BillingCatalogConfig> {
  const now = Date.now();
  if (cachedBillingCatalog && now < cachedBillingCatalogExpiresAt) {
    return cachedBillingCatalog;
  }
  try {
    const resolved = existingClient
      ? await queryBillingCatalogFromClient(existingClient)
      : await withSystemPrivilege((client) => queryBillingCatalogFromClient(client));
    cachedBillingCatalog = resolved;
    cachedBillingCatalogExpiresAt = Date.now() + BILLING_CATALOG_CACHE_TTL_MS;
    return resolved;
  } catch {
    return DEFAULT_BILLING_CATALOG;
  }
}

export function matchPlanInCatalog(
  identity: CanonicalBillingIdentity | null | undefined,
  catalog: BillingCatalogConfig = DEFAULT_BILLING_CATALOG
): BillingPlanConfig | undefined {
  if (!identity) return undefined;
  return (
    catalog.plans.find((p) => p.code === identity.plan_code) ||
    catalog.plans.find((p) => p.package_code === identity.package_code) ||
    catalog.plans.find(
      (p) => p.plan_tier === identity.legacy_tier && identity.package_code !== 'marketing_standalone'
    )
  );
}

export function resolveTenantPlanLimits(
  subscription: Pick<TenantSubscriptionSnapshot, 'plan_code' | 'plan_tier'> & {
    package_code?: SaasPackageCode | string | null;
  },
  catalog: BillingCatalogConfig = DEFAULT_BILLING_CATALOG
): TenantPlanLimits {
  const rawPlanCode = String(subscription.plan_code || '').trim().toLowerCase();
  const isTrialCode = rawPlanCode === 'trial_1m' || rawPlanCode === 'trial_3m';
  const identity =
    (!isTrialCode ? resolveCanonicalBillingIdentity(rawPlanCode) : null) ||
    resolveCanonicalBillingIdentity(subscription.package_code) ||
    resolveCanonicalBillingIdentity(subscription.plan_tier);

  const byExactCode = catalog.plans.find((p) => p.code === rawPlanCode);
  const effectivePlan = byExactCode || matchPlanInCatalog(identity, catalog);

  if (effectivePlan) {
    const maxUsers = Math.max(1, Number(effectivePlan.max_users || identity?.default_limits.max_users || 25));
    return {
      max_sales: Math.max(
        1,
        Number(effectivePlan.max_sales || identity?.default_limits.max_sales || Math.round(maxUsers * 0.8) || 20)
      ),
      max_managers: Math.max(
        1,
        Number(
          effectivePlan.max_managers || identity?.default_limits.max_managers || Math.max(2, Math.round(maxUsers * 0.2)) || 5
        )
      ),
      max_users: maxUsers,
      max_rounds: Math.max(1, Number(effectivePlan.max_rounds || identity?.default_limits.max_rounds || 5)),
      monthly_lead_quota: Math.max(
        1,
        Number(effectivePlan.monthly_lead_quota || identity?.default_limits.monthly_lead_quota || 15_000)
      ),
    };
  }

  if (identity) {
    return { ...identity.default_limits };
  }

  const fallbackPlan = catalog.plans[0];
  if (!fallbackPlan) {
    return { max_sales: 20, max_managers: 5, max_users: 25, max_rounds: 5, monthly_lead_quota: 15_000 };
  }
  return {
    max_sales: Math.max(1, Number(fallbackPlan.max_sales || 20)),
    max_managers: Math.max(1, Number(fallbackPlan.max_managers || 5)),
    max_users: Math.max(1, Number(fallbackPlan.max_users || 25)),
    max_rounds: Math.max(1, Number(fallbackPlan.max_rounds || 5)),
    monthly_lead_quota: Math.max(1, Number(fallbackPlan.monthly_lead_quota || 15_000)),
  };
}

export function computeSubscriptionSnapshot(
  tenantRow: {
    plan_tier?: string | null;
    package_code?: string | null;
    status?: string | null;
    auto_renew?: boolean | null;
    cancel_at_period_end?: boolean | null;
    cancelled_at?: string | Date | null;
    grace_ends_at?: string | Date | null;
    scheduled_plan_code?: string | null;
    scheduled_billing_cycle?: string | null;
    created_at?: string | Date | null;
    trial_ends_at?: string | Date | null;
    subscription_expires_at?: string | Date | null;
    subscription_plan_code?: string | null;
    billing_cycle?: string | null;
    wallet_balance_vnd?: number | string | null;
    crm_erp_upgrade_status?: string | null;
  },
  catalog: BillingCatalogConfig = DEFAULT_BILLING_CATALOG,
  nowMs: number = Date.now()
): TenantSubscriptionSnapshot {
  const createdMs = tenantRow.created_at ? new Date(tenantRow.created_at).getTime() : nowMs;
  const fallbackTrialEndMs = createdMs + catalog.trial_duration_days * 86_400_000;
  const trialEndsMs = tenantRow.trial_ends_at ? new Date(tenantRow.trial_ends_at).getTime() : fallbackTrialEndMs;
  const paidExpiresMs = tenantRow.subscription_expires_at
    ? new Date(tenantRow.subscription_expires_at).getTime()
    : null;
  const graceEndsMs = tenantRow.grace_ends_at ? new Date(tenantRow.grace_ends_at).getTime() : null;
  const cancelledAtIso = tenantRow.cancelled_at ? new Date(tenantRow.cancelled_at).toISOString() : null;

  const planCode = String(tenantRow.subscription_plan_code || 'trial_1m');
  const isTrialPlanCode = planCode === 'trial_1m' || planCode === 'trial_3m';
  const hasPaidSubscription = Boolean(paidExpiresMs && !isTrialPlanCode);
  const effectiveExpiresMs =
    paidExpiresMs !== null ? Math.max(paidExpiresMs, trialEndsMs) : trialEndsMs;

  const rawStatus = String(tenantRow.status || 'active').toLowerCase();
  const normalizedStatus: TenantSubscriptionSnapshot['status'] =
    rawStatus === 'grace' || rawStatus === 'suspended' || rawStatus === 'cancelled' || rawStatus === 'trial'
      ? rawStatus
      : 'active';

  const msRemaining = effectiveExpiresMs - nowMs;
  const isExpired = msRemaining <= 0 || normalizedStatus === 'suspended' || normalizedStatus === 'cancelled';
  const daysRemaining = isExpired ? 0 : Math.ceil(msRemaining / 86_400_000);
  const hoursRemaining = isExpired ? 0 : Math.ceil(msRemaining / 3_600_000);
  const isInTrial = !hasPaidSubscription && !isExpired;
  const isExpiringSoon = !isExpired && daysRemaining <= catalog.trial_warning_days;

  const packageCode = resolvePackageCodeFromTenant(tenantRow);
  const identity =
    (!isTrialPlanCode ? resolveCanonicalBillingIdentity(planCode) : null) ||
    resolveCanonicalBillingIdentity(packageCode) ||
    resolveCanonicalBillingIdentity(tenantRow.plan_tier);

  const matchedPlan = catalog.plans.find((p) => p.code === planCode) || matchPlanInCatalog(identity, catalog);
  const planName = isTrialPlanCode
    ? `Dùng Thử Miễn Phí ${catalog.trial_duration_months} Tháng`
    : matchedPlan?.name || SAAS_PACKAGES_CATALOG[packageCode]?.name || planCode;

  const tierRaw = String(tenantRow.plan_tier || matchedPlan?.plan_tier || identity?.legacy_tier || 'starter');
  const validTiers = new Set<string>([
    'starter',
    'growth',
    'enterprise',
    ...VALID_PACKAGE_CODES,
  ]);
  const planTier: ExtendedPlanTier = validTiers.has(tierRaw)
    ? (tierRaw as ExtendedPlanTier)
    : 'starter';

  let recommendedNextAction: 'enjoy_trial' | 'renew_step_plan' | 'upgrade_crm_erp' = 'enjoy_trial';
  if (isExpired || isExpiringSoon || normalizedStatus === 'grace') {
    recommendedNextAction = 'renew_step_plan';
  } else if (hasPaidSubscription && planTier !== 'enterprise' && planTier !== 'domation_promax' && packageCode !== 'domation_promax') {
    recommendedNextAction = 'upgrade_crm_erp';
  }

  const effectiveExpiresIso = new Date(effectiveExpiresMs).toISOString();
  const limits = resolveTenantPlanLimits(
    {
      plan_code: planCode,
      plan_tier: planTier,
      package_code: packageCode,
    },
    catalog
  );

  return {
    plan_code: planCode,
    plan_name: planName,
    plan_tier: planTier,
    package_code: packageCode,
    status: normalizedStatus,
    billing_cycle: String(tenantRow.billing_cycle || (isInTrial ? 'trial' : 'monthly')),
    auto_renew: tenantRow.auto_renew === undefined || tenantRow.auto_renew === null ? true : Boolean(tenantRow.auto_renew),
    cancel_at_period_end: Boolean(tenantRow.cancel_at_period_end),
    cancelled_at: cancelledAtIso,
    grace_ends_at: graceEndsMs ? new Date(graceEndsMs).toISOString() : null,
    scheduled_plan_code: tenantRow.scheduled_plan_code ? String(tenantRow.scheduled_plan_code) : null,
    scheduled_billing_cycle: tenantRow.scheduled_billing_cycle ? String(tenantRow.scheduled_billing_cycle) : null,
    is_in_trial: isInTrial,
    trial_duration_months: catalog.trial_duration_months,
    trial_duration_days: catalog.trial_duration_days,
    trial_started_at: new Date(createdMs).toISOString(),
    trial_ends_at: new Date(trialEndsMs).toISOString(),
    subscription_expires_at: paidExpiresMs ? new Date(paidExpiresMs).toISOString() : null,
    subscription_ends_at: effectiveExpiresIso,
    effective_expires_at: effectiveExpiresIso,
    days_remaining: daysRemaining,
    hours_remaining: hoursRemaining,
    is_expired: isExpired,
    is_expiring_soon: isExpiringSoon,
    wallet_balance_vnd: Math.max(0, Number(tenantRow.wallet_balance_vnd || 0)),
    crm_erp_upgrade_status: String(tenantRow.crm_erp_upgrade_status || 'none'),
    limits,
    recommended_next_action: recommendedNextAction,
  };
}

export async function enforceTenantOperationalPolicy(
  client: DbClient,
  tenantId: string,
  operation: 'ingest_lead' | 'create_user' | 'create_round'
): Promise<void> {
  const [tRow, catalog]: [
    (CachedTenantBillingPolicy & { wallet_balance_vnd?: number | string | null }) | null,
    BillingCatalogConfig,
  ] = await Promise.all([
    operation === 'ingest_lead'
      ? getTenantBillingPolicyCached(tenantId, client)
      : client
          .query<CachedTenantBillingPolicy & { wallet_balance_vnd: number | string | null }>(
            `SELECT plan_tier, package_code, status, auto_renew, cancel_at_period_end, grace_ends_at,
                    created_at, trial_ends_at, subscription_expires_at,
                    subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status
             FROM tenants
             WHERE id = $1
             LIMIT 1`,
            [tenantId]
          )
          .then((r) => r.rows[0] || null),
    getPlatformBillingCatalog(client),
  ]);

  if (!tRow) return;

  const subscription = computeSubscriptionSnapshot(tRow, catalog);
  const limits = subscription.limits;

  if (subscription.is_expired) {
    if (operation === 'ingest_lead') {
      if (catalog.post_trial_policy === 'strict_lock') {
        throw new Error(
          `SUBSCRIPTION_EXPIRED: Thời hạn dùng thử ${catalog.trial_duration_months} tháng hoặc gói Auto Data đã hết hạn (Chế độ khóa nghiêm ngặt). Vui lòng gia hạn gói cước, nạp Topup ví hoặc nâng cấp lên DOMATION CRM/ERP.`
        );
      }
    } else {
      throw new Error(
        `SUBSCRIPTION_EXPIRED: Thời hạn dùng thử ${catalog.trial_duration_months} tháng hoặc gói Auto Data đã hết hạn. Vui lòng gia hạn gói Step, nạp Topup ví hoặc nâng cấp lên DOMATION CRM/ERP để tạo thêm nhân sự / vòng chia.`
      );
    }
  }

  if (operation === 'create_user') {
    const uCntRes = await client.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM users WHERE tenant_id = $1',
      [tenantId]
    );
    const currentUsers = Number(uCntRes.rows[0]?.cnt || 0);
    if (currentUsers >= limits.max_users) {
      throw new Error(
        `PLAN_QUOTA_EXCEEDED: Gói hiện tại (${subscription.plan_name}) giới hạn tối đa ${limits.max_users} tài khoản nhân sự. Vui lòng nâng cấp gói Step cao hơn hoặc DOMATION CRM/ERP.`
      );
    }
  } else if (operation === 'create_round') {
    const rCntRes = await client.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM distribution_rounds WHERE tenant_id = $1',
      [tenantId]
    );
    const currentRounds = Number(rCntRes.rows[0]?.cnt || 0);
    if (currentRounds >= limits.max_rounds) {
      throw new Error(
        `PLAN_QUOTA_EXCEEDED: Gói hiện tại (${subscription.plan_name}) giới hạn tối đa ${limits.max_rounds} vòng chia số. Vui lòng nâng cấp gói Step cao hơn hoặc DOMATION CRM/ERP.`
      );
    }
  } else if (operation === 'ingest_lead') {
    const now = new Date();
    const monthKey = getUtcMonthKey(now);
    const safetyMargin = Math.max(200, Math.ceil(limits.monthly_lead_quota * 0.1));
    const fastSkipCeiling = limits.monthly_lead_quota - safetyMargin;
    const cachedCount = tenantRedis.getCachedTenantMonthlyLeadCount(tenantId, monthKey);
    let currentMonthLeads: number;
    if (cachedCount !== null && fastSkipCeiling > 0 && cachedCount < fastSkipCeiling) {
      currentMonthLeads = cachedCount;
    } else {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      const lCntRes = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
         FROM leads
         WHERE tenant_id = $1 AND created_at >= $2`,
        [tenantId, monthStart]
      );
      currentMonthLeads = Number(lCntRes.rows[0]?.cnt || 0);
      tenantRedis.setCachedTenantMonthlyLeadCount(tenantId, monthKey, currentMonthLeads);
    }
    if (currentMonthLeads >= limits.monthly_lead_quota) {
      throw new Error(
        `PLAN_QUOTA_EXCEEDED: Đã đạt hạn mức ${limits.monthly_lead_quota.toLocaleString('vi-VN')} Lead/tháng của gói ${subscription.plan_name}. Vui lòng nâng cấp gói Step cao hơn hoặc DOMATION CRM/ERP.`
      );
    }
  }
}

export function isIdempotencyUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, any>;
  const code = String(e.code || '');
  const errno = Number(e.errno || 0);
  const constraint = String(e.constraint || '').toLowerCase();
  const msg = String(e.message || '').toLowerCase();
  const isUniqueErr = code === '23505' || code === 'ER_DUP_ENTRY' || errno === 1062;
  if (!isUniqueErr) return false;
  return !constraint || constraint.includes('idempotency') || msg.includes('idempotency');
}

export function computeBillingIdempotencyFingerprint(params: {
  operation: 'topup' | 'plan_change';
  amount_vnd?: number | null;
  package_id?: string | null;
  plan_code?: string | null;
  package_code?: string | null;
  billing_cycle?: string | null;
  months?: number | null;
  schedule_at_period_end?: boolean;
}): string {
  const canonical =
    params.operation === 'topup'
      ? {
          operation: 'topup',
          amount_vnd: params.amount_vnd != null ? Math.round(Number(params.amount_vnd)) : null,
          package_id: params.package_id ? String(params.package_id).trim().toLowerCase() : null,
        }
      : {
          operation: 'plan_change',
          plan_code: params.plan_code ? String(params.plan_code).trim().toLowerCase() : null,
          package_code: params.package_code ? String(params.package_code).trim().toLowerCase() : null,
          billing_cycle: params.billing_cycle ? String(params.billing_cycle).trim().toLowerCase() : null,
          months: params.months != null ? Math.round(Number(params.months)) : null,
          schedule_at_period_end: Boolean(params.schedule_at_period_end),
        };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function assertIdempotencyFingerprintMatches(
  existingTx: Record<string, any>,
  expectedOperation: 'topup' | 'plan_change',
  expectedFingerprint: string
): void {
  const existingTxType = String(existingTx.tx_type || '').toLowerCase();
  const isTopupTx = existingTxType === 'topup';
  if ((expectedOperation === 'topup' && !isTopupTx) || (expectedOperation === 'plan_change' && isTopupTx)) {
    throw new Error(
      `IDEMPOTENCY_KEY_MISMATCH: Idempotency key đã được sử dụng cho loại giao dịch '${existingTxType}' khác với thao tác hiện tại.`
    );
  }
  const existingMeta =
    existingTx.metadata && typeof existingTx.metadata === 'object'
      ? (existingTx.metadata as Record<string, any>)
      : {};
  const existingFp =
    typeof existingMeta.idempotency_fingerprint === 'string'
      ? existingMeta.idempotency_fingerprint
      : '';
  if (existingFp && existingFp !== expectedFingerprint) {
    throw new Error(
      'IDEMPOTENCY_KEY_MISMATCH: Idempotency key đã được sử dụng với tham số thanh toán khác (số tiền, gói cước hoặc chu kỳ không khớp).'
    );
  }
}

export async function findTransactionByIdempotencyKey(
  client: DbClient,
  tenantId: string,
  idempotencyKey?: string | null
): Promise<Record<string, any> | null> {
  const cleanKey = String(idempotencyKey || '').trim().slice(0, 120);
  if (!cleanKey) return null;
  const r = await client.query(
    `SELECT * FROM tenant_billing_transactions
     WHERE tenant_id = $1 AND idempotency_key = $2
     LIMIT 1`,
    [tenantId, cleanKey]
  );
  return r.rows[0] || null;
}

export async function applySubscriptionActivationInTx(
  client: DbClient,
  params: {
    tenantId: string;
    planCode: string;
    billingCycle: 'monthly' | 'annual';
    monthsAdded: number;
    walletDebitVnd?: number;
    walletCreditVnd?: number;
    useCurrentTimeBase?: boolean;
    preserveExistingExpiry?: boolean;
    educationAddon?: boolean;
    industryKey?: unknown;
    targetUpgradeStatus?: string | null;
    catalog?: BillingCatalogConfig;
  }
): Promise<Record<string, any>> {
  const catalog = params.catalog || (await getPlatformBillingCatalog(client));
  const curRes = await client.query<Record<string, any>>(
    'SELECT * FROM tenants WHERE id = $1 FOR UPDATE',
    [params.tenantId]
  );
  const cur = curRes.rows[0];
  if (!cur) throw new Error('TENANT_NOT_FOUND');

  const identity =
    resolveCanonicalBillingIdentity(params.planCode) ||
    resolveCanonicalBillingIdentity(cur.package_code) ||
    resolveCanonicalBillingIdentity(cur.plan_tier) ||
    resolveCanonicalBillingIdentity('autodata_standard')!;
  const matchedPlan = matchPlanInCatalog(identity, catalog);
  const pkgDef = SAAS_PACKAGES_CATALOG[identity.package_code];

  const curSettings = cur.settings && typeof cur.settings === 'object' ? cur.settings : {};
  const curEnt = cur.entitlements && typeof cur.entitlements === 'object' ? cur.entitlements : {};

  const nextIndustryKey =
    params.industryKey !== undefined
      ? normalizeIndustryKey(params.industryKey)
      : normalizeIndustryKey(cur.industry_key || curSettings.industry_key || cur.industry);

  const nextEduAddon =
    params.educationAddon !== undefined
      ? Boolean(params.educationAddon)
      : Boolean(curEnt.education_addon ?? curSettings.education_addon ?? nextIndustryKey === 'education');

  const nextMascot = Boolean(curEnt.enable_ideas_mascot ?? curSettings.enable_ideas_mascot ?? false);

  const nextModules = buildModulesForPackage(identity.package_code, {
    educationAddon: nextEduAddon,
  });

  const nextEntitlements = {
    ...curEnt,
    package_code: identity.package_code,
    package_name: pkgDef.name,
    package_badge: pkgDef.badge,
    education_addon: nextEduAddon,
    enable_ideas_mascot: nextMascot,
    tour_suite: pkgDef.tour_suite,
    connect_wizard_suite: pkgDef.connect_wizard_suite,
    ai_capabilities: pkgDef.ai_capabilities,
    zero_migration_ready: true,
    activated_at: new Date().toISOString(),
  };

  const normalizedSettings = normalizeTenantSettings({
    ...curSettings,
    industry_key: nextIndustryKey,
    education_addon: nextEduAddon,
    enable_ideas_mascot: nextMascot,
  });
  const mergedSettings = {
    ...curSettings,
    ...normalizedSettings,
  };

  const nowMs = Date.now();
  const trialEndsMs = cur.trial_ends_at ? new Date(cur.trial_ends_at).getTime() : 0;
  const paidEndsMs = cur.subscription_expires_at ? new Date(cur.subscription_expires_at).getTime() : 0;
  const addedDays =
    params.billingCycle === 'annual' && params.monthsAdded === 12
      ? 365
      : Math.max(0, params.monthsAdded) * 30;

  let nextExpiresIso: string | null = cur.subscription_expires_at
    ? new Date(cur.subscription_expires_at).toISOString()
    : null;
  if (!params.preserveExistingExpiry && addedDays > 0) {
    const baseMs = params.useCurrentTimeBase
      ? nowMs
      : Math.max(nowMs, trialEndsMs, paidEndsMs);
    nextExpiresIso = new Date(baseMs + addedDays * 86_400_000).toISOString();
  }

  const nextUpgradeStatus =
    params.targetUpgradeStatus ||
    (identity.package_code === 'domation_promax'
      ? 'active_crm_erp_bundle'
      : identity.package_code === 'growth_combo'
        ? 'active_crm'
        : 'none');

  const debitVnd = Math.max(0, Math.round(Number(params.walletDebitVnd || 0)));
  const creditVnd = Math.max(0, Math.round(Number(params.walletCreditVnd || 0)));

  const updRes = await client.query(
    `UPDATE tenants
     SET wallet_balance_vnd = GREATEST(0, wallet_balance_vnd - $2 + $13),
         subscription_expires_at = COALESCE($3::timestamptz, subscription_expires_at),
         subscription_plan_code = $4,
         package_code = $5,
         plan_tier = $6,
         billing_cycle = $7,
         industry = $8,
         industry_key = $8,
         enabled_modules = $9::jsonb,
         entitlements = $10::jsonb,
         settings = $11::jsonb,
         crm_erp_upgrade_status = $12,
         status = 'active',
         grace_ends_at = NULL,
         cancel_at_period_end = false,
         cancelled_at = NULL,
         scheduled_plan_code = NULL,
         scheduled_billing_cycle = NULL,
         updated_at = clock_timestamp()
     WHERE id = $1
     RETURNING *`,
    [
      params.tenantId,
      debitVnd,
      nextExpiresIso,
      matchedPlan?.code || identity.plan_code,
      identity.package_code,
      identity.legacy_tier,
      params.billingCycle,
      nextIndustryKey,
      JSON.stringify(nextModules),
      JSON.stringify(nextEntitlements),
      JSON.stringify(mergedSettings),
      nextUpgradeStatus,
      creditVnd,
    ]
  );

  const updated = updRes.rows[0];
  tenantRedis.invalidateTenantCache(params.tenantId, updated.slug);
  await tenantRedis.del('meta:tenant_status', params.tenantId);
  return updated;
}

export interface PlanTransitionInput {
  target_code: unknown;
  billing_cycle?: unknown;
  months?: unknown;
  payment_method?: unknown;
  provider?: unknown;
  education_addon?: boolean;
  industry_key?: unknown;
  schedule_at_period_end?: boolean;
  idempotency_key?: string | null;
  note?: string;
  return_url?: string;
  cancel_url?: string;
  same_plan_early_renewal?: boolean;
}

export async function executePlanOrPackageChangeInTx(
  client: DbClient,
  tenantId: string,
  userId: string,
  input: PlanTransitionInput
): Promise<
  | {
      kind: 'idempotent_replay';
      is_pending?: boolean;
      tx: Record<string, any>;
      tenant: Record<string, any>;
      gateway_session?: PaymentSessionResult;
      catalog: BillingCatalogConfig;
    }
  | { kind: 'scheduled_downgrade'; tx: Record<string, any>; tenant: Record<string, any>; effective_at: string; catalog: BillingCatalogConfig }
  | {
      kind: 'pending_payment';
      tx: Record<string, any>;
      tenant: Record<string, any>;
      gateway_session: PaymentSessionResult;
      catalog: BillingCatalogConfig;
    }
  | {
      kind: 'activated';
      tx: Record<string, any>;
      tenant: Record<string, any>;
      txType: string;
      addedDays: number;
      prorationCreditVnd: number;
      excessCreditVnd: number;
      netDueVnd: number;
      catalog: BillingCatalogConfig;
    }
> {
  const catalog = await getPlatformBillingCatalog(client);
  const cleanIdempKey = String(input.idempotency_key || '').trim().slice(0, 120) || null;

  const curRes = await client.query<Record<string, any>>(
    'SELECT * FROM tenants WHERE id = $1 FOR UPDATE',
    [tenantId]
  );
  const cur = curRes.rows[0];
  if (!cur) throw new Error('TENANT_NOT_FOUND');

  const targetIdentity = resolveCanonicalBillingIdentity(input.target_code);
  if (!targetIdentity) {
    throw new Error(
      `INVALID_PACKAGE_CODE: Mã gói '${String(input.target_code || '').trim()}' không hợp lệ. Chọn 1 trong: ${VALID_PACKAGE_CODES.join(', ')}, autodata_standard, autodata_growth, domation_crm_erp.`
    );
  }
  const targetPlan = matchPlanInCatalog(targetIdentity, catalog);
  if (!targetPlan) {
    throw new Error(`INVALID_PLAN_CODE: Không tìm thấy cấu hình gói '${targetIdentity.plan_code}'.`);
  }

  const cycle: 'monthly' | 'annual' = input.billing_cycle === 'annual' ? 'annual' : 'monthly';
  const monthsAdded = cycle === 'annual' ? 12 : Math.min(36, Math.max(1, Math.round(Number(input.months) || 1)));
  const idempotencyFingerprint = computeBillingIdempotencyFingerprint({
    operation: 'plan_change',
    plan_code: targetPlan.code,
    package_code: targetIdentity.package_code,
    billing_cycle: cycle,
    months: monthsAdded,
    schedule_at_period_end: Boolean(input.schedule_at_period_end),
  });

  if (cleanIdempKey) {
    const existingTx = await findTransactionByIdempotencyKey(client, tenantId, cleanIdempKey);
    if (existingTx) {
      assertIdempotencyFingerprintMatches(existingTx, 'plan_change', idempotencyFingerprint);
      const isPending = String(existingTx.status || '').toLowerCase() === 'pending';
      const gatewaySession = isPending
        ? createPaymentSession({
            provider: normalizePaymentProvider(existingTx.provider || existingTx.payment_method),
            referenceCode: String(existingTx.reference_code || ''),
            amountVnd: Number(existingTx.amount_vnd || 0),
            description: `DOMATION ${targetPlan.code} (${cycle})`,
            bankInfo: catalog.payment_bank_info,
            returnUrl: input.return_url,
            cancelUrl: input.cancel_url,
          })
        : undefined;
      return {
        kind: 'idempotent_replay',
        is_pending: isPending,
        tx: existingTx,
        tenant: cur,
        gateway_session: gatewaySession,
        catalog,
      };
    }
  }

  const currentPackageCode = resolvePackageCodeFromTenant(cur);
  const rawCurPlanCode = String(cur.subscription_plan_code || '').trim().toLowerCase();
  const isTrialPlan = !rawCurPlanCode || rawCurPlanCode === 'trial_1m' || rawCurPlanCode === 'trial_3m';
  const currentIdentity =
    (!isTrialPlan ? resolveCanonicalBillingIdentity(rawCurPlanCode) : null) ||
    resolveCanonicalBillingIdentity(currentPackageCode) ||
    resolveCanonicalBillingIdentity(cur.plan_tier) ||
    resolveCanonicalBillingIdentity('autodata_standard')!;
  const currentPlan = matchPlanInCatalog(currentIdentity, catalog) || catalog.plans[0];

  const nowMs = Date.now();
  const paidEndsMs = cur.subscription_expires_at ? new Date(cur.subscription_expires_at).getTime() : 0;
  const trialEndsMs = cur.trial_ends_at ? new Date(cur.trial_ends_at).getTime() : 0;
  const curStatus = String(cur.status || 'active').toLowerCase();
  const hasActivePaid =
    !isTrialPlan && paidEndsMs > nowMs && curStatus !== 'suspended' && curStatus !== 'cancelled';

  const addedDays = cycle === 'annual' ? 365 : monthsAdded * 30;
  const discountPct = cycle === 'annual' ? targetPlan.annual_discount_pct : 0;
  const targetGrossVnd =
    cycle === 'annual'
      ? targetPlan.annual_total_vnd
      : Math.round(targetPlan.monthly_price_vnd * monthsAdded);

  const isSamePackage = targetIdentity.package_code === currentPackageCode;

  // Same-package metadata/addon/industry update via /switch-package (when no explicit billing_cycle/months purchase requested)
  if (
    isSamePackage &&
    !input.same_plan_early_renewal &&
    input.billing_cycle === undefined &&
    input.months === undefined &&
    curStatus !== 'suspended' &&
    curStatus !== 'cancelled' &&
    (hasActivePaid || (isTrialPlan && trialEndsMs > nowMs))
  ) {
    const curSettings = cur.settings && typeof cur.settings === 'object' ? cur.settings : {};
    const curEnt = cur.entitlements && typeof cur.entitlements === 'object' ? cur.entitlements : {};
    const nextIndustryKey =
      input.industry_key !== undefined
        ? normalizeIndustryKey(input.industry_key)
        : normalizeIndustryKey(cur.industry_key || curSettings.industry_key || cur.industry);
    const nextEduAddon =
      input.education_addon !== undefined
        ? Boolean(input.education_addon)
        : Boolean(curEnt.education_addon ?? curSettings.education_addon ?? nextIndustryKey === 'education');
    const nextMascot = Boolean(curEnt.enable_ideas_mascot ?? curSettings.enable_ideas_mascot ?? false);
    const nextModules = buildModulesForPackage(targetIdentity.package_code, { educationAddon: nextEduAddon });
    const pkgDef = SAAS_PACKAGES_CATALOG[targetIdentity.package_code];
    const nextEntitlements = {
      ...curEnt,
      package_code: targetIdentity.package_code,
      package_name: pkgDef.name,
      package_badge: pkgDef.badge,
      education_addon: nextEduAddon,
      enable_ideas_mascot: nextMascot,
      tour_suite: pkgDef.tour_suite,
      connect_wizard_suite: pkgDef.connect_wizard_suite,
      ai_capabilities: pkgDef.ai_capabilities,
      zero_migration_ready: true,
      switched_at: new Date().toISOString(),
    };
    const normalizedSettings = normalizeTenantSettings({
      ...curSettings,
      industry_key: nextIndustryKey,
      education_addon: nextEduAddon,
      enable_ideas_mascot: nextMascot,
    });
    const mergedSettings = { ...curSettings, ...normalizedSettings };

    const updSame = await client.query(
      `UPDATE tenants
       SET industry = $2,
           industry_key = $2,
           enabled_modules = $3::jsonb,
           entitlements = $4::jsonb,
           settings = $5::jsonb,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING *`,
      [
        tenantId,
        nextIndustryKey,
        JSON.stringify(nextModules),
        JSON.stringify(nextEntitlements),
        JSON.stringify(mergedSettings),
      ]
    );
    const updatedRow = updSame.rows[0];
    tenantRedis.invalidateTenantCache(tenantId, updatedRow.slug);
    const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'ADDON', updatedRow.slug);
    const txRes = await client.query(
      `INSERT INTO tenant_billing_transactions (
         id, tenant_id, tx_type, plan_code, billing_cycle, months_added,
         amount_vnd, proration_credit_vnd, discount_pct, payment_method, provider,
         idempotency_key, status, reference_code, note, metadata,
         requested_by, processed_by, processed_at
       ) VALUES (
         $1, $2, 'package_switch', $3, $4, 0,
         0, 0, 0, 'wallet', 'manual_bank_transfer',
         $5, 'completed', $6, $7, $8::jsonb,
         $9, 'entitlement_addon_engine', clock_timestamp()
       )
       RETURNING *`,
      [
        crypto.randomUUID(),
        tenantId,
        targetPlan.code,
        cur.billing_cycle || 'trial',
        cleanIdempKey,
        refCode,
        input.note ? String(input.note).trim() : `Cập nhật tùy chọn gói ${pkgDef.name}`,
        JSON.stringify({
          previous_package: currentPackageCode,
          new_package: targetIdentity.package_code,
          education_addon: nextEduAddon,
          idempotency_fingerprint: idempotencyFingerprint,
        }),
        userId,
      ]
    );
    return {
      kind: 'activated',
      tx: txRes.rows[0],
      tenant: updatedRow,
      txType: 'package_switch',
      addedDays: 0,
      prorationCreditVnd: 0,
      excessCreditVnd: 0,
      netDueVnd: 0,
      catalog,
    };
  }

  const targetLimits = resolveTenantPlanLimits(
    {
      plan_code: targetPlan.code,
      plan_tier: targetIdentity.legacy_tier,
      package_code: targetIdentity.package_code,
    },
    catalog
  );
  const currentLimits = resolveTenantPlanLimits(
    {
      plan_code: currentPlan.code,
      plan_tier: currentIdentity.legacy_tier,
      package_code: currentIdentity.package_code,
    },
    catalog
  );

  const isDowngrade =
    !isTrialPlan &&
    !isSamePackage &&
    (targetPlan.monthly_price_vnd < currentPlan.monthly_price_vnd ||
      targetLimits.max_users < currentLimits.max_users ||
      targetLimits.max_rounds < currentLimits.max_rounds);

  if (isDowngrade) {
    const [uCntRes, rCntRes] = await Promise.all([
      client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users WHERE tenant_id = $1', [tenantId]),
      client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM distribution_rounds WHERE tenant_id = $1', [tenantId]),
    ]);
    const activeUsers = Number(uCntRes.rows[0]?.cnt || 0);
    const activeRounds = Number(rCntRes.rows[0]?.cnt || 0);

    if (input.schedule_at_period_end && hasActivePaid) {
      await client.query(
        `UPDATE tenants
         SET scheduled_plan_code = $2,
             scheduled_billing_cycle = $3,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [tenantId, targetPlan.code, cycle]
      );
      const effectiveAtIso = new Date(paidEndsMs).toISOString();
      const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'DOWN', cur.slug);
      const txRes = await client.query(
        `INSERT INTO tenant_billing_transactions (
           id, tenant_id, tx_type, plan_code, billing_cycle, months_added,
           amount_vnd, proration_credit_vnd, discount_pct, payment_method, provider,
           idempotency_key, status, reference_code, note, metadata,
           requested_by, processed_by, processed_at
         ) VALUES (
           $1, $2, 'plan_downgrade', $3, $4, 0,
           0, 0, 0, 'wallet', 'manual_bank_transfer',
           $5, 'completed', $6, $7, $8::jsonb,
           $9, 'subscription_lifecycle_engine', clock_timestamp()
         )
         RETURNING *`,
        [
          crypto.randomUUID(),
          tenantId,
          targetPlan.code,
          cycle,
          cleanIdempKey,
          refCode,
          input.note ? String(input.note).trim() : `Đặt lịch hạ gói sang ${targetPlan.name} vào cuối kỳ`,
          JSON.stringify({
            scheduled_at_period_end: true,
            effective_at: effectiveAtIso,
            previous_package: currentPackageCode,
            new_package: targetIdentity.package_code,
            idempotency_fingerprint: idempotencyFingerprint,
          }),
          userId,
        ]
      );
      const tAfter = await client.query('SELECT * FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
      tenantRedis.invalidateTenantCache(tenantId, cur.slug);
      return {
        kind: 'scheduled_downgrade',
        tx: txRes.rows[0],
        tenant: tAfter.rows[0] || cur,
        effective_at: effectiveAtIso,
        catalog,
      };
    }

    if (activeUsers > targetLimits.max_users || activeRounds > targetLimits.max_rounds) {
      throw new Error(
        `DOWNGRADE_USAGE_EXCEEDED: Hiện có ${activeUsers}/${targetLimits.max_users} nhân sự và ${activeRounds}/${targetLimits.max_rounds} vòng chia vượt giới hạn gói ${targetPlan.name}. Vui lòng giảm nhân sự/vòng chia hoặc chọn schedule_at_period_end.`
      );
    }

    const isExplicitTermPurchase = cycle === 'annual' || monthsAdded > 1;
    if (hasActivePaid && !isExplicitTermPurchase) {
      const preservedCycle: 'monthly' | 'annual' = cur.billing_cycle === 'annual' ? 'annual' : 'monthly';
      const updatedTenant = await applySubscriptionActivationInTx(client, {
        tenantId,
        planCode: targetPlan.code,
        billingCycle: preservedCycle,
        monthsAdded: 0,
        preserveExistingExpiry: true,
        educationAddon: input.education_addon,
        industryKey: input.industry_key,
        catalog,
      });
      const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'DOWN', cur.slug);
      const txRes = await client.query(
        `INSERT INTO tenant_billing_transactions (
           id, tenant_id, tx_type, plan_code, billing_cycle, months_added,
           amount_vnd, proration_credit_vnd, discount_pct, payment_method, provider,
           idempotency_key, status, reference_code, note, metadata,
           requested_by, processed_by, processed_at
         ) VALUES (
           $1, $2, 'plan_downgrade', $3, $4, 0,
           0, 0, 0, 'wallet', 'manual_bank_transfer',
           $5, 'completed', $6, $7, $8::jsonb,
           $9, 'subscription_lifecycle_engine', clock_timestamp()
         )
         RETURNING *`,
        [
          crypto.randomUUID(),
          tenantId,
          targetPlan.code,
          preservedCycle,
          cleanIdempKey,
          refCode,
          input.note ? String(input.note).trim() : `Hạ gói sang ${targetPlan.name} (giữ hạn kỳ hiện tại)`,
          JSON.stringify({
            previous_package: currentPackageCode,
            new_package: targetIdentity.package_code,
            idempotency_fingerprint: idempotencyFingerprint,
          }),
          userId,
        ]
      );
      return {
        kind: 'activated',
        tx: txRes.rows[0],
        tenant: updatedTenant,
        txType: 'plan_downgrade',
        addedDays: 0,
        prorationCreditVnd: 0,
        excessCreditVnd: 0,
        netDueVnd: 0,
        catalog,
      };
    }
  }

  // Compute proration credit ONLY for mid-cycle paid upgrades/switches to a DIFFERENT package (never during trial, never on same-plan early renewal)
  let prorationCreditVnd = 0;
  const isCrossPlanSwitch = !isSamePackage && hasActivePaid;
  if (isCrossPlanSwitch) {
    const curPeriodDays = cur.billing_cycle === 'annual' ? 365 : 30;
    const curCyclePaidVnd =
      cur.billing_cycle === 'annual' ? currentPlan.annual_total_vnd : currentPlan.monthly_price_vnd;
    const remainingMs = Math.max(0, paidEndsMs - nowMs);
    const unusedRatio = Math.min(1, remainingMs / (curPeriodDays * 86_400_000));
    prorationCreditVnd = Math.round(curCyclePaidVnd * unusedRatio);
  }

  const netDueVnd = Math.max(0, targetGrossVnd - prorationCreditVnd);
  const excessCreditVnd = Math.max(0, prorationCreditVnd - targetGrossVnd);
  const useCurrentTimeBase = isCrossPlanSwitch; // Mid-cycle proration starts fresh cycle from now; same-plan renewal stacks remaining days!

  const txType =
    isTrialPlan
      ? 'subscription_purchase'
      : !isSamePackage
        ? targetPlan.monthly_price_vnd > currentPlan.monthly_price_vnd
          ? 'plan_upgrade'
          : 'package_switch'
        : curStatus === 'grace' || curStatus === 'suspended' || curStatus === 'cancelled'
          ? 'reactivation'
          : 'renewal';

  const rawPayMethod = String(input.payment_method || 'wallet').trim().toLowerCase();
  const isBankOrGateway =
    rawPayMethod === 'bank_transfer' ||
    rawPayMethod === 'manual_bank_transfer' ||
    rawPayMethod === 'vietqr' ||
    rawPayMethod === 'manual' ||
    rawPayMethod === 'payos' ||
    rawPayMethod === 'sepay' ||
    rawPayMethod === 'vnpay' ||
    rawPayMethod === 'momo' ||
    rawPayMethod === 'stripe';

  const provider: PaymentProvider = normalizePaymentProvider(input.provider || (isBankOrGateway ? rawPayMethod : 'manual_bank_transfer'));

  if (isBankOrGateway && netDueVnd > 0) {
    const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'PLAN', cur.slug);
    const txRes = await client.query(
      `INSERT INTO tenant_billing_transactions (
         tenant_id, tx_type, plan_code, billing_cycle, months_added,
         amount_vnd, proration_credit_vnd, discount_pct, payment_method, provider,
         idempotency_key, status, reference_code, note, metadata, requested_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13, $14::jsonb, $15)
       RETURNING *`,
      [
        tenantId,
        txType,
        targetPlan.code,
        cycle,
        monthsAdded,
        netDueVnd,
        prorationCreditVnd,
        discountPct,
        rawPayMethod === 'bank_transfer' ? 'bank_transfer' : provider,
        provider,
        cleanIdempKey,
        refCode,
        input.note
          ? String(input.note).trim()
          : `Đăng ký / Chuyển gói ${targetPlan.name} (${cycle === 'annual' ? `12 tháng -${discountPct}%` : `${monthsAdded} tháng`})`,
        JSON.stringify({
          plan_tier: targetIdentity.legacy_tier,
          package_code: targetIdentity.package_code,
          gross_amount_vnd: targetGrossVnd,
          proration_credit_vnd: prorationCreditVnd,
          use_current_time_base: useCurrentTimeBase,
          idempotency_fingerprint: idempotencyFingerprint,
        }),
        userId,
      ]
    );

    const gatewaySession = createPaymentSession({
      provider,
      referenceCode: refCode,
      amountVnd: netDueVnd,
      description: `DOMATION ${targetPlan.code} (${cycle})`,
      bankInfo: catalog.payment_bank_info,
      returnUrl: input.return_url,
      cancelUrl: input.cancel_url,
    });

    return {
      kind: 'pending_payment',
      tx: txRes.rows[0],
      tenant: cur,
      gateway_session: gatewaySession,
      catalog,
    };
  }

  // Wallet Settlement (atomic check inside FOR UPDATE lock)
  const walletBalance = Math.max(0, Number(cur.wallet_balance_vnd || 0));
  if (walletBalance < netDueVnd) {
    const shortfall = netDueVnd - walletBalance;
    const err = new Error(
      `INSUFFICIENT_WALLET_BALANCE: Số dư ví Topup hiện tại (${walletBalance.toLocaleString('vi-VN')}₫) chưa đủ thanh toán ${netDueVnd.toLocaleString('vi-VN')}₫. Vui lòng nạp thêm tối thiểu ${shortfall.toLocaleString('vi-VN')}₫ hoặc chọn chuyển khoản.`
    );
    (err as any).billingDetails = {
      walletBalance,
      required: netDueVnd,
      shortfall,
      prorationCreditVnd,
    };
    throw err;
  }

  const updatedTenant = await applySubscriptionActivationInTx(client, {
    tenantId,
    planCode: targetPlan.code,
    billingCycle: cycle,
    monthsAdded,
    walletDebitVnd: netDueVnd,
    walletCreditVnd: excessCreditVnd,
    useCurrentTimeBase,
    educationAddon: input.education_addon,
    industryKey: input.industry_key,
    catalog,
  });

  const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'WALLET', cur.slug);
  const txRes = await client.query(
    `INSERT INTO tenant_billing_transactions (
       tenant_id, tx_type, plan_code, billing_cycle, months_added,
       amount_vnd, proration_credit_vnd, discount_pct, payment_method, provider,
       idempotency_key, status, reference_code, note, metadata,
       requested_by, processed_by, processed_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, 'wallet', 'manual_bank_transfer',
       $9, 'completed', $10, $11, $12::jsonb,
       $13, 'auto_wallet_engine', clock_timestamp()
     )
     RETURNING *`,
    [
      tenantId,
      txType,
      targetPlan.code,
      cycle,
      monthsAdded,
      netDueVnd,
      prorationCreditVnd,
      discountPct,
      cleanIdempKey,
      refCode,
      input.note
        ? String(input.note).trim()
        : `Thanh toán từ Ví Topup: ${targetPlan.name} (${monthsAdded} tháng)`,
      JSON.stringify({
        added_days: addedDays,
        gross_amount_vnd: targetGrossVnd,
        proration_credit_vnd: prorationCreditVnd,
        excess_proration_credit_vnd: excessCreditVnd,
        wallet_credited_vnd: excessCreditVnd,
        previous_package: currentPackageCode,
        new_package: targetIdentity.package_code,
        idempotency_fingerprint: idempotencyFingerprint,
      }),
      userId,
    ]
  );

  if (excessCreditVnd > 0) {
    const creditRefCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'CRED', cur.slug);
    await client.query(
      `INSERT INTO tenant_billing_transactions (
         tenant_id, tx_type, plan_code, billing_cycle, months_added,
         amount_vnd, proration_credit_vnd, discount_pct, payment_method, provider,
         idempotency_key, status, reference_code, note, metadata,
         requested_by, processed_by, processed_at
       ) VALUES (
         $1, 'proration_credit', $2, $3, 0,
         $4, $4, 0, 'wallet', 'manual_bank_transfer',
         NULL, 'completed', $5, $6, $7::jsonb,
         $8, 'auto_wallet_engine', clock_timestamp()
       )`,
      [
        tenantId,
        targetPlan.code,
        cycle,
        excessCreditVnd,
        creditRefCode,
        `Hoàn tiền dư quy đổi gói vào Ví Topup (${excessCreditVnd.toLocaleString('vi-VN')}₫)`,
        JSON.stringify({
          parent_tx_id: txRes.rows[0]?.id || null,
          parent_reference_code: refCode,
          source_package: currentPackageCode,
          target_package: targetIdentity.package_code,
          proration_credit_vnd: prorationCreditVnd,
          target_gross_vnd: targetGrossVnd,
          excess_proration_credit_vnd: excessCreditVnd,
        }),
        userId,
      ]
    );
  }

  return {
    kind: 'activated',
    tx: txRes.rows[0],
    tenant: updatedTenant,
    txType,
    addedDays,
    prorationCreditVnd,
    excessCreditVnd,
    netDueVnd,
    catalog,
  };
}

/**
 * Multi-Product SaaS Package Switch / Upgrade (Zero Data Migration!)
 * Enforces wallet balance / proration / pending payment order — zero 0₫ paid-module bypass!
 */
export async function switchTenantSaasPackageInTx(
  client: DbClient,
  tenantId: string,
  userId: string,
  input: {
    package_code: unknown;
    billing_cycle?: unknown;
    months?: unknown;
    payment_method?: unknown;
    provider?: unknown;
    schedule_at_period_end?: boolean;
    idempotency_key?: string | null;
    education_addon?: boolean;
    industry_key?: unknown;
    note?: string;
  }
) {
  const transition = await executePlanOrPackageChangeInTx(client, tenantId, userId, {
    target_code: input.package_code,
    billing_cycle: input.billing_cycle,
    months: input.months,
    payment_method: input.payment_method || 'wallet',
    provider: input.provider,
    schedule_at_period_end: input.schedule_at_period_end,
    idempotency_key: input.idempotency_key,
    education_addon: input.education_addon,
    industry_key: input.industry_key,
    note: input.note,
  });

  if (transition.kind === 'pending_payment' || (transition.kind === 'idempotent_replay' && transition.is_pending)) {
    const subscription = computeSubscriptionSnapshot(transition.tenant, transition.catalog);
    return {
      requires_payment: true,
      idempotent_replay: transition.kind === 'idempotent_replay',
      transaction: {
        ...transition.tx,
        amount_vnd: Number(transition.tx.amount_vnd || 0),
        proration_credit_vnd: Number(transition.tx.proration_credit_vnd || 0),
        discount_pct: Number(transition.tx.discount_pct || 0),
      },
      payment_bank_info: transition.catalog.payment_bank_info,
      gateway_session: transition.gateway_session,
      subscription,
    };
  }

  const updatedRow = transition.tenant;
  const subscription = computeSubscriptionSnapshot(updatedRow, transition.catalog);
  const entSnap = resolveTenantEntitlementSnapshot(updatedRow);
  const rbac = await resolveUserEffectivePermissions(client, tenantId, userId);

  return {
    requires_payment: false,
    idempotent_replay: transition.kind === 'idempotent_replay',
    scheduled_downgrade: transition.kind === 'scheduled_downgrade',
    effective_at: transition.kind === 'scheduled_downgrade' ? transition.effective_at : undefined,
    proration_credit_vnd: transition.kind === 'activated' ? transition.prorationCreditVnd : 0,
    excess_proration_credit_vnd: transition.kind === 'activated' ? transition.excessCreditVnd : 0,
    wallet_credited_vnd: transition.kind === 'activated' ? transition.excessCreditVnd : 0,
    amount_charged_vnd: transition.kind === 'activated' ? transition.netDueVnd : 0,
    transaction: {
      ...transition.tx,
      amount_vnd: Number(transition.tx.amount_vnd || 0),
      proration_credit_vnd: Number(transition.tx.proration_credit_vnd || 0),
    },
    slug: updatedRow.slug,
    package_code: entSnap.package_code,
    package_info: entSnap.package_info,
    plan_tier: updatedRow.plan_tier,
    enabled_modules: entSnap.enabled_modules,
    entitlements: entSnap.entitlements,
    industry_key: entSnap.industry_key,
    terminology: entSnap.terminology,
    effective_permissions: rbac.effectivePermissions,
    subscription,
    packages_catalog: SAAS_PACKAGES_CATALOG,
    industry_presets: INDUSTRY_TERMINOLOGY_PRESETS,
    tenant: {
      id: updatedRow.id,
      slug: updatedRow.slug,
      name: updatedRow.name,
      domain: updatedRow.domain,
      industry: updatedRow.industry,
      industry_key: entSnap.industry_key,
      package_code: entSnap.package_code,
      plan_tier: updatedRow.plan_tier,
      enabled_modules: entSnap.enabled_modules,
      entitlements: entSnap.entitlements,
      terminology: entSnap.terminology,
      status: updatedRow.status,
      wallet_balance_vnd: Number(updatedRow.wallet_balance_vnd || 0),
      crm_erp_upgrade_status: updatedRow.crm_erp_upgrade_status,
      subscription,
      settings: updatedRow.settings,
    },
  };
}
