import crypto from 'node:crypto';
import type { DbClient } from '../core/database/db-adapter.ts';
import { withSystemPrivilege } from '../core/database/transaction.ts';
import { DEFAULT_TENANT_SETTINGS, normalizeTenantSettings } from '../core/settings/tenant-settings.ts';
import {
  INDUSTRY_TERMINOLOGY_PRESETS,
  SAAS_PACKAGES_CATALOG,
  VALID_PACKAGE_CODES,
  buildModulesForPackage,
  normalizeIndustryKey,
  resolveTenantEntitlementSnapshot,
  type ExtendedPlanTier,
  type SaasPackageCode,
  type SaasPackageDefinition,
} from '../core/security/entitlements.ts';
import { resolveUserEffectivePermissions } from '../core/security/rbac.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';

export interface BillingPlanConfig {
  code: string;
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
  post_trial_policy: 'step_renewal_or_upgrade' | 'strict_lock';
  crm_upgrade_url: string;
  erp_upgrade_url: string;
  payment_bank_info: BillingBankInfo;
  plans: BillingPlanConfig[];
  packages?: Record<SaasPackageCode, SaasPackageDefinition>;
  topup_packages: TopupPackageConfig[];
}

export interface TenantSubscriptionSnapshot {
  plan_code: string;
  plan_name: string;
  plan_tier: ExtendedPlanTier;
  package_code?: SaasPackageCode;
  billing_cycle: string;
  is_in_trial: boolean;
  trial_duration_months: number;
  trial_duration_days: number;
  trial_started_at: string;
  trial_ends_at: string;
  subscription_expires_at: string | null;
  effective_expires_at: string;
  days_remaining: number;
  hours_remaining: number;
  is_expired: boolean;
  is_expiring_soon: boolean;
  wallet_balance_vnd: number;
  crm_erp_upgrade_status: string;
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

export function buildDefaultPlans(baseMonthlyVnd = 1_500_000, annualDiscountPct = 15): BillingPlanConfig[] {
  const stdAnnual = computeAnnualNumbers(baseMonthlyVnd, annualDiscountPct);
  const growthMonthly = baseMonthlyVnd * 2;
  const growthAnnual = computeAnnualNumbers(growthMonthly, annualDiscountPct);
  const entMonthly = baseMonthlyVnd * 4;
  const entAnnual = computeAnnualNumbers(entMonthly, annualDiscountPct);

  return [
    {
      code: 'autodata_standard',
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
      step_order: 3,
      name: 'Nâng Cấp DOMATION CRM 360° / ERP 5.0',
      tagline: 'Chuyển đổi liền mạch từ Auto Data lên Hệ sinh thái Quản trị Toàn diện DOMATION.',
      badge: 'Hệ Sinh Thái Enterprise',
      plan_tier: 'enterprise',
      monthly_price_vnd: entMonthly,
      ...entAnnual,
      max_sales: 9_000,
      max_managers: 999,
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
      const name = String(obj.name || code).trim();
      const tierRaw = String(obj.plan_tier || 'starter');
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
      const amt = Math.round(clamp(obj.amount_vnd, baseMonthly, minTopup, 500_000_000));
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
const BILLING_CATALOG_CACHE_TTL_MS = 5_000;

export function invalidateBillingCatalogCache(): void {
  cachedBillingCatalog = null;
  cachedBillingCatalogExpiresAt = 0;
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

export function computeSubscriptionSnapshot(
  tenantRow: {
    plan_tier?: string | null;
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

  const planCode = String(tenantRow.subscription_plan_code || 'trial_1m');
  const isTrialPlanCode = planCode === 'trial_1m' || planCode === 'trial_3m';
  const hasPaidSubscription = Boolean(paidExpiresMs && !isTrialPlanCode);
  const effectiveExpiresMs =
    paidExpiresMs !== null ? Math.max(paidExpiresMs, trialEndsMs) : trialEndsMs;

  const msRemaining = effectiveExpiresMs - nowMs;
  const isExpired = msRemaining <= 0;
  const daysRemaining = isExpired ? 0 : Math.ceil(msRemaining / 86_400_000);
  const hoursRemaining = isExpired ? 0 : Math.ceil(msRemaining / 3_600_000);
  const isInTrial = !hasPaidSubscription && !isExpired;
  const isExpiringSoon = !isExpired && daysRemaining <= catalog.trial_warning_days;

  const matchedPlan = catalog.plans.find((p) => p.code === planCode);
  const planName = isTrialPlanCode
    ? `Dùng Thử Miễn Phí ${catalog.trial_duration_months} Tháng`
    : matchedPlan?.name || planCode;

  const tierRaw = String(tenantRow.plan_tier || matchedPlan?.plan_tier || 'starter');
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
  if (isExpired || isExpiringSoon) {
    recommendedNextAction = 'renew_step_plan';
  } else if (hasPaidSubscription && planTier !== 'enterprise' && planTier !== 'domation_promax') {
    recommendedNextAction = 'upgrade_crm_erp';
  }

  return {
    plan_code: planCode,
    plan_name: planName,
    plan_tier: planTier,
    billing_cycle: String(tenantRow.billing_cycle || (isInTrial ? 'trial' : 'monthly')),
    is_in_trial: isInTrial,
    trial_duration_months: catalog.trial_duration_months,
    trial_duration_days: catalog.trial_duration_days,
    trial_started_at: new Date(createdMs).toISOString(),
    trial_ends_at: new Date(trialEndsMs).toISOString(),
    subscription_expires_at: paidExpiresMs ? new Date(paidExpiresMs).toISOString() : null,
    effective_expires_at: new Date(effectiveExpiresMs).toISOString(),
    days_remaining: daysRemaining,
    hours_remaining: hoursRemaining,
    is_expired: isExpired,
    is_expiring_soon: isExpiringSoon,
    wallet_balance_vnd: Math.max(0, Number(tenantRow.wallet_balance_vnd || 0)),
    crm_erp_upgrade_status: String(tenantRow.crm_erp_upgrade_status || 'none'),
    recommended_next_action: recommendedNextAction,
  };
}

export function resolveTenantPlanLimits(
  subscription: TenantSubscriptionSnapshot,
  catalog: BillingCatalogConfig = DEFAULT_BILLING_CATALOG
): { max_sales: number; max_managers: number; max_users: number; max_rounds: number; monthly_lead_quota: number } {
  const byCode = catalog.plans.find((p) => p.code === subscription.plan_code);
  const byTier = catalog.plans.find((p) => p.plan_tier === subscription.plan_tier);
  const effectivePlan = byCode || byTier || catalog.plans[0];
  if (!effectivePlan) {
    return { max_sales: 20, max_managers: 5, max_users: 25, max_rounds: 5, monthly_lead_quota: 15_000 };
  }
  const maxUsers = Math.max(1, Number(effectivePlan.max_users || 25));
  return {
    max_sales: Math.max(1, Number(effectivePlan.max_sales || Math.round(maxUsers * 0.8) || 20)),
    max_managers: Math.max(1, Number(effectivePlan.max_managers || Math.max(2, Math.round(maxUsers * 0.2)) || 5)),
    max_users: maxUsers,
    max_rounds: Math.max(1, Number(effectivePlan.max_rounds || 5)),
    monthly_lead_quota: Math.max(1, Number(effectivePlan.monthly_lead_quota || 15_000)),
  };
}

export async function enforceTenantOperationalPolicy(
  client: DbClient,
  tenantId: string,
  operation: 'ingest_lead' | 'create_user' | 'create_round'
): Promise<void> {
  const [tenantRes, catalog] = await Promise.all([
    client.query<{
      plan_tier: string | null;
      created_at: string | Date | null;
      trial_ends_at: string | Date | null;
      subscription_expires_at: string | Date | null;
      subscription_plan_code: string | null;
      billing_cycle: string | null;
      wallet_balance_vnd: number | string | null;
      crm_erp_upgrade_status: string | null;
    }>(
      `SELECT plan_tier, created_at, trial_ends_at, subscription_expires_at,
              subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    ),
    getPlatformBillingCatalog(client),
  ]);

  const tRow = tenantRes.rows[0];
  if (!tRow) return;

  const subscription = computeSubscriptionSnapshot(tRow, catalog);
  const limits = resolveTenantPlanLimits(subscription, catalog);

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
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const lCntRes = await client.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM leads
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, monthStart]
    );
    const currentMonthLeads = Number(lCntRes.rows[0]?.cnt || 0);
    if (currentMonthLeads >= limits.monthly_lead_quota) {
      throw new Error(
        `PLAN_QUOTA_EXCEEDED: Đã đạt hạn mức ${limits.monthly_lead_quota.toLocaleString('vi-VN')} Lead/tháng của gói ${subscription.plan_name}. Vui lòng nâng cấp gói Step cao hơn hoặc DOMATION CRM/ERP.`
      );
    }
  }
}


/**
 * 0-Second Instant Multi-Product SaaS Package Switch / Upgrade (Zero Data Migration!)
 * Unlocks/separates menus, tours, connectors, and AI capabilities across the 4 packages
 * (`autodata_crm`, `marketing_standalone`, `growth_combo`, `domation_promax`) while preserving 100% of data.
 */
export async function switchTenantSaasPackageInTx(
  client: DbClient,
  tenantId: string,
  userId: string,
  input: {
    package_code: unknown;
    education_addon?: boolean;
    industry_key?: unknown;
    note?: string;
  }
) {
  const pkgRaw = String(input.package_code || '').trim().toLowerCase();
  if (!VALID_PACKAGE_CODES.includes(pkgRaw as SaasPackageCode)) {
    throw new Error(`INVALID_PACKAGE_CODE: Mã gói '${pkgRaw}' không hợp lệ. Chọn 1 trong: ${VALID_PACKAGE_CODES.join(', ')}.`);
  }
  const targetPkg = pkgRaw as SaasPackageCode;
  const pkgDef = SAAS_PACKAGES_CATALOG[targetPkg];

  const curRes = await client.query<{
    id: string;
    slug: string;
    name: string;
    domain: string | null;
    industry: string;
    industry_key: string;
    package_code: string;
    plan_tier: string;
    status: string;
    created_at: string;
    trial_ends_at: string | null;
    subscription_expires_at: string | null;
    subscription_plan_code: string | null;
    billing_cycle: string | null;
    wallet_balance_vnd: string | number;
    crm_erp_upgrade_status: string | null;
    enabled_modules: unknown;
    entitlements: Record<string, unknown>;
    settings: Record<string, unknown>;
  }>('SELECT * FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);

  const cur = curRes.rows[0];
  if (!cur) throw new Error('TENANT_NOT_FOUND');

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

  const nextModules = buildModulesForPackage(targetPkg, {
    educationAddon: nextEduAddon,
  });

  const nextEntitlements = {
    ...curEnt,
    package_code: targetPkg,
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

  const mergedSettings = normalizeTenantSettings({
    ...curSettings,
    industry_key: nextIndustryKey,
    education_addon: nextEduAddon,
    enable_ideas_mascot: nextMascot,
  });

  const nextUpgradeStatus =
    targetPkg === 'domation_promax'
      ? 'active_crm_erp_bundle'
      : targetPkg === 'growth_combo'
        ? 'active_crm'
        : cur.crm_erp_upgrade_status || 'none';

  const updRes = await client.query(
    `UPDATE tenants
     SET package_code = $2,
         plan_tier = $2,
         industry = $3,
         industry_key = $3,
         enabled_modules = $4::jsonb,
         entitlements = $5::jsonb,
         settings = $6::jsonb,
         crm_erp_upgrade_status = $7,
         updated_at = clock_timestamp()
     WHERE id = $1
     RETURNING *`,
    [
      tenantId,
      targetPkg,
      nextIndustryKey,
      JSON.stringify(nextModules),
      JSON.stringify(nextEntitlements),
      JSON.stringify(mergedSettings),
      nextUpgradeStatus,
    ]
  );

  const updatedRow = updRes.rows[0];
  tenantRedis.invalidateTenantCache(tenantId, updatedRow.slug);
  const refCode = `DOMPKG-${targetPkg.toUpperCase().slice(0, 8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  await client.query(
    `INSERT INTO tenant_billing_transactions (
       id, tenant_id, tx_type, plan_code, billing_cycle, months_added,
       amount_vnd, discount_pct, payment_method, status, reference_code,
       note, metadata, requested_by, processed_by, processed_at
     ) VALUES (
       $1, $2, 'plan_upgrade', $3, COALESCE($4, 'trial'), 0,
       0, 0, 'instant_switch', 'completed', $5,
       $6, $7::jsonb, $8, 'instant_entitlement_engine', clock_timestamp()
     )`,
    [
      crypto.randomUUID(),
      tenantId,
      targetPkg,
      cur.billing_cycle || 'trial',
      refCode,
      input.note ? String(input.note).trim() : `Chuyển đổi tức thì 0s sang gói ${pkgDef.name}`,
      JSON.stringify({
        previous_package: cur.package_code || cur.plan_tier,
        new_package: targetPkg,
        education_addon: nextEduAddon,
      }),
      userId,
    ]
  );

  const catalog = await getPlatformBillingCatalog(client);
  const subscription = computeSubscriptionSnapshot(updatedRow, catalog);
  const entSnap = resolveTenantEntitlementSnapshot(updatedRow);
  const rbac = await resolveUserEffectivePermissions(client, tenantId, userId);

  return {
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
      settings: mergedSettings,
    },
  };
}
