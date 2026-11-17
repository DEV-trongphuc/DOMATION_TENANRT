import crypto from 'node:crypto';
import { Router } from 'express';
import { APP_CONFIG } from '../config.ts';
import { hashPassword, verifyPassword } from '../core/crypto/password.ts';
import { withSystemPrivilege, withTenantTransaction } from '../core/database/transaction.ts';
import {
  signTenantAccessToken,
  signTenantRefreshToken,
  signAccountToken,
  verifyAccountToken,
  verifyTenantAccessToken,
} from '../core/crypto/jwt.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  requireTenantAuth,
  requireRoles,
  sendApiError,
  extractRequestedTenantSlug,
} from '../core/security/rbac.ts';
import { isOutboundSilentMode } from '../core/security/outbound-guard.ts';
import { validateAndNormalizePhone } from '../services/phone.service.ts';
import { seedTenantWorkspace, INDUSTRY_PRESETS } from '../services/preset.service.ts';
import {
  normalizeTenantSettings,
  DEFAULT_TENANT_SETTINGS,
} from '../core/settings/tenant-settings.ts';
import { getPlatformDefaultsCached } from '../core/settings/tenant-cache.ts';
import {
  getPlatformBillingCatalog,
  computeSubscriptionSnapshot,
} from '../services/billing.service.ts';
import {
  normalizeIndustryKey,
  resolveTenantEntitlementSnapshot,
  VALID_PACKAGE_CODES,
  buildModulesForPackage,
  SAAS_PACKAGES_CATALOG,
  type SaasPackageCode,
} from '../core/security/entitlements.ts';
import { notifyPlatformWorkspaceRegistered } from '../services/platform-appscript.service.ts';

export const authRouter = Router();

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function slugifyCompanyName(raw: string): string {
  const base = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  const rand = crypto.randomBytes(2).toString('hex');
  return `${base || 'workspace'}-${rand}`;
}

async function listWorkspacesForAccount(accountId: string | null, email: string) {
  const catalog = await getPlatformBillingCatalog();
  return withSystemPrivilege(async (client) => {
    const res = await client.query<{
      id: string;
      slug: string;
      name: string;
      industry: string;
      plan_tier: 'starter' | 'growth' | 'enterprise';
      status: string;
      trial_ends_at: string | null;
      subscription_expires_at: string | null;
      subscription_plan_code: string | null;
      billing_cycle: string | null;
      wallet_balance_vnd: string | number | null;
      crm_erp_upgrade_status: string | null;
      settings: Record<string, unknown>;
      created_at: string;
      role: string;
      is_external_agency: boolean;
      profile_status: string | null;
    }>(
      `SELECT t.id, t.slug, t.name, t.industry, t.plan_tier, t.status,
              t.trial_ends_at, t.subscription_expires_at, t.subscription_plan_code,
              t.billing_cycle, t.wallet_balance_vnd, t.crm_erp_upgrade_status,
              t.settings, t.created_at, u.role, u.is_external_agency, p.status AS profile_status
       FROM tenants t
       INNER JOIN users u ON u.tenant_id = t.id
       LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
       WHERE t.status IN ('active', 'trial')
         AND COALESCE(p.status, 'active') = 'active'
         AND (${accountId ? 'u.account_id = $1 OR ' : ''}LOWER(u.email) = ${accountId ? '$2' : '$1'})
       ORDER BY t.created_at DESC`,
      accountId ? [accountId, email.toLowerCase()] : [email.toLowerCase()]
    );

    return res.rows.map((r) => {
      const sub = computeSubscriptionSnapshot(r, catalog);
      const settingsObj = r.settings && typeof r.settings === 'object' ? r.settings : {};
      return {
        id: r.id,
        slug: r.slug,
        company_name: r.name,
        industry: r.industry,
        plan_tier: r.plan_tier,
        plan_name: sub.plan_name,
        role: r.role,
        days_remaining: sub.days_remaining,
        is_in_trial: sub.is_in_trial,
        is_expired: sub.is_expired,
        is_external_agency: Boolean(r.is_external_agency),
        selected_channels: Array.isArray((settingsObj as any).selected_channels)
          ? (settingsObj as any).selected_channels
          : [],
        created_at: r.created_at,
      };
    });
  });
}

function extractCallerIdentity(req: any): { email: string; accountId: string | null; name: string } | null {
  const authHeader = String(req.header?.('Authorization') || '');
  const bodyToken = String(req.body?.account_token || req.body?.google_provision_token || '').trim();
  const rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : bodyToken;
  if (!rawToken) return null;

  try {
    const acc = verifyAccountToken(rawToken);
    return { email: acc.email.toLowerCase(), accountId: acc.sub, name: acc.name };
  } catch {
    // Try Tenant JWT
  }
  try {
    const claims = verifyTenantAccessToken(rawToken);
    return { email: claims.email.toLowerCase(), accountId: null, name: claims.name };
  } catch {
    return null;
  }
}

// 2.1 Check Tenant Slug Availability
authRouter.get('/check-slug', async (req, res) => {
  try {
    const rawSlug = String(req.query.slug || '').trim().toLowerCase();
    if (!rawSlug || !SLUG_REGEX.test(rawSlug)) {
      sendApiError(res, 422, 'INVALID_SLUG_FORMAT', 'Định danh doanh nghiệp chỉ gồm chữ thường, số và dấu gạch ngang (2-63 ký tự).');
      return;
    }

    const exists = await withSystemPrivilege(async (client) => {
      const r = await client.query('SELECT id FROM tenants WHERE slug = $1 LIMIT 1', [rawSlug]);
      return r.rows.length > 0;
    });

    if (exists) {
      sendApiError(res, 409, 'SLUG_ALREADY_TAKEN', `Định danh doanh nghiệp '${rawSlug}' đã được đăng ký trên hệ thống.`);
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        slug: rawSlug,
        is_available: true,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CHECK_SLUG_FAILED', err?.message || 'Không thể kiểm tra slug.');
  }
});

// Public list of industry presets for registration wizard
authRouter.get('/presets', (_req, res) => {
  const list = Object.values(INDUSTRY_PRESETS).map((p) => ({
    key: p.key,
    pipelineName: p.pipelineName,
    description: p.description,
    stages: p.stages.map((s) => ({
      stage_key: s.stage_key,
      stage_name: s.stage_name,
      color_hex: s.color_hex,
      capi_event_mapping: s.capi_event_mapping,
      sla_timeout_minutes: s.sla_timeout_minutes,
    })),
    customFields: p.customFields,
  }));
  res.json({ success: true, data: list });
});

// Public / Workspace endpoint returning canonical Tenant Settings defaults (merged with Platform Operator defaults)
authRouter.get('/default-settings', async (_req, res) => {
  try {
    const platformDefaults = await getPlatformDefaultsCached();
    res.json({
      success: true,
      data: normalizeTenantSettings(platformDefaults, DEFAULT_TENANT_SETTINGS),
    });
  } catch {
    res.json({ success: true, data: DEFAULT_TENANT_SETTINGS });
  }
});

// 2.2 Self-Service Tenant Registration (mounted at both `/register` and `/register-tenant`)
authRouter.post(['/register', '/register-tenant'], async (req, res) => {
  try {
    const {
      company_name,
      tenant_slug,
      admin_name,
      work_email,
      phone,
      password,
      industry = 'real_estate',
      team_scale = '1_20',
      seed_demo_leads = true,
      initial_sales,
      zalo_config,
      smtp_config,
      capi_config,
      custom_settings,
      custom_pipeline_name,
      custom_stages,
      custom_fields,
    } = req.body || {};

    const cleanName = String(company_name || '').trim();
    const rawSlugInput = String(tenant_slug || '').trim().toLowerCase();
    const cleanSlug = rawSlugInput || slugifyCompanyName(cleanName);
    const cleanAdminName = String(admin_name || '').trim();
    const cleanEmail = String(work_email || '').trim().toLowerCase();
    const rawPassword = String(password || '');

    if (!cleanName || cleanName.length < 2) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên doanh nghiệp phải có ít nhất 2 ký tự.');
      return;
    }
    if (!SLUG_REGEX.test(cleanSlug)) {
      sendApiError(res, 422, 'INVALID_SLUG', 'Định danh doanh nghiệp (slug) không hợp lệ.');
      return;
    }
    if (!cleanAdminName) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng nhập họ tên Quản trị viên.');
      return;
    }
    if (!EMAIL_REGEX.test(cleanEmail)) {
      sendApiError(res, 422, 'INVALID_EMAIL', 'Địa chỉ email doanh nghiệp không đúng chuẩn RFC.');
      return;
    }

    // Check slug uniqueness + fetch cached platform default settings
    const [slugTaken, platformDefaults] = await Promise.all([
      withSystemPrivilege(async (client) => {
        const r = await client.query('SELECT id FROM tenants WHERE slug = $1 LIMIT 1', [cleanSlug]);
        return r.rows.length > 0;
      }),
      getPlatformDefaultsCached(),
    ]);

    const baseTenantSettings = normalizeTenantSettings(
      {
        ...platformDefaults,
        dual_capi_enabled: Boolean(capi_config?.dual_send ?? platformDefaults.dual_capi_enabled),
        team_scale,
        ...(custom_settings && typeof custom_settings === 'object' ? custom_settings : {}),
      },
      DEFAULT_TENANT_SETTINGS
    );

    const phoneCheck = validateAndNormalizePhone(String(phone || ''), {
      default_dial_code: baseTenantSettings.default_dial_code,
      allow_international_phones: baseTenantSettings.allow_international_phones,
      allow_landline_phones: baseTenantSettings.allow_landline_phones,
      vn_mobile_prefixes: baseTenantSettings.vn_mobile_prefixes,
      custom_phone_regex: baseTenantSettings.custom_phone_regex,
      block_repeated_digits: baseTenantSettings.block_repeated_digits,
    });
    if (!phoneCheck.valid) {
      sendApiError(res, 422, 'INVALID_PHONE', phoneCheck.reason || 'Số điện thoại không hợp lệ.');
      return;
    }
    if (rawPassword.length < 8) {
      sendApiError(res, 422, 'WEAK_PASSWORD', 'Mật khẩu phải có tối thiểu 8 ký tự.');
      return;
    }

    if (slugTaken) {
      sendApiError(res, 409, 'SLUG_ALREADY_TAKEN', `Định danh doanh nghiệp '${cleanSlug}' đã được đăng ký.`);
      return;
    }

    const tenantId = crypto.randomUUID();
    const adminUserId = crypto.randomUUID();
    const passwordHash = await hashPassword(rawPassword, APP_CONFIG.bcryptRounds);
    const hasExplicitStaffPassword = Boolean(
      (custom_settings &&
        typeof custom_settings === 'object' &&
        typeof (custom_settings as Record<string, unknown>).default_staff_password === 'string' &&
        String((custom_settings as Record<string, unknown>).default_staff_password).trim().length >= 8) ||
        (platformDefaults &&
          typeof platformDefaults.default_staff_password === 'string' &&
          String(platformDefaults.default_staff_password).trim().length >= 8)
    );
    const initialStaffPasswordHash = hasExplicitStaffPassword
      ? await hashPassword(baseTenantSettings.default_staff_password, APP_CONFIG.bcryptRounds)
      : passwordHash;

    const billingCatalog = await getPlatformBillingCatalog();
    const trialDays = Math.max(0, Number(billingCatalog.trial_duration_days ?? baseTenantSettings.trial_duration_days ?? 30));
    const trialEndsIso = new Date(Date.now() + trialDays * 86_400_000).toISOString();

    const globalAccountId = await withSystemPrivilege(async (client) => {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1',
        [cleanEmail]
      );
      if (existing.rows[0]?.id) {
        await client.query(
          'UPDATE global_accounts SET last_login_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1',
          [existing.rows[0].id]
        );
        return existing.rows[0].id;
      }
      const newAccId = crypto.randomUUID();
      await client.query(
        `INSERT INTO global_accounts (id, email, password_hash, full_name, phone, is_active, last_login_at)
         VALUES ($1, $2, $3, $4, $5, true, clock_timestamp())`,
        [newAccId, cleanEmail, passwordHash, cleanAdminName, phoneCheck.normalizedE164]
      );
      return newAccId;
    });

    const provisioned = await withTenantTransaction(tenantId, async (client) => {
      const tenantSettings = baseTenantSettings;
      const reqPkgRaw = String(req.body?.package_code || '').trim().toLowerCase();
      const initialPkg: SaasPackageCode = VALID_PACKAGE_CODES.includes(reqPkgRaw as SaasPackageCode)
        ? (reqPkgRaw as SaasPackageCode)
        : 'autodata_crm';
      const indKey = normalizeIndustryKey(industry);
      const eduAddon = indKey === 'education';
      const initModules = buildModulesForPackage(initialPkg, { educationAddon: eduAddon });
      const initEnt = {
        package_code: initialPkg,
        package_name: SAAS_PACKAGES_CATALOG[initialPkg].name,
        package_badge: SAAS_PACKAGES_CATALOG[initialPkg].badge,
        education_addon: eduAddon,
        enable_ideas_mascot: false,
      };
      const initialTier = reqPkgRaw && VALID_PACKAGE_CODES.includes(reqPkgRaw as SaasPackageCode) ? initialPkg : 'starter';

      const tRes = await client.query<{
        id: string;
        slug: string;
        name: string;
        domain: string | null;
        industry: string;
        industry_key: string;
        package_code: string;
        plan_tier: any;
        enabled_modules: unknown;
        entitlements: Record<string, unknown>;
        status: string;
        trial_ends_at: string;
        subscription_expires_at: string | null;
        subscription_plan_code: string;
        billing_cycle: string;
        wallet_balance_vnd: string | number;
        crm_erp_upgrade_status: string;
        settings: Record<string, unknown>;
        created_at: string;
      }>(
        `INSERT INTO tenants (
           id, slug, name, industry, industry_key, package_code, plan_tier,
           enabled_modules, entitlements, status,
           trial_ends_at, subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status,
           settings
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'active', $10::timestamptz, 'trial_1m', 'trial', 0, 'none', $11::jsonb)
         RETURNING id, slug, name, domain, industry, industry_key, package_code, plan_tier,
                   enabled_modules, entitlements, status,
                   trial_ends_at, subscription_expires_at, subscription_plan_code,
                   billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status,
                   settings, created_at`,
        [
          tenantId,
          cleanSlug,
          cleanName,
          String(industry || 'real_estate'),
          indKey,
          initialPkg,
          initialTier,
          JSON.stringify(initModules),
          JSON.stringify(initEnt),
          trialEndsIso,
          JSON.stringify(tenantSettings),
        ]
      );

      const uRes = await client.query<{
        id: string;
        email: string;
        full_name: string;
        role: 'tenant_admin';
        is_tenant_owner: boolean;
      }>(
        `INSERT INTO users (id, account_id, tenant_id, email, password_hash, full_name, phone, role, is_tenant_owner, is_external_agency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'tenant_admin', true, false)
         RETURNING id, email, full_name, role, is_tenant_owner`,
        [adminUserId, globalAccountId, tenantId, cleanEmail, passwordHash, cleanAdminName, phoneCheck.normalizedE164]
      );

      const seedInfo = await seedTenantWorkspace(client, {
        tenantId,
        tenantSlug: cleanSlug,
        adminUserId,
        adminName: cleanAdminName,
        industry: String(industry || 'real_estate'),
        options: {
          seedDemoLeads: seed_demo_leads !== false,
          customPipelineName: typeof custom_pipeline_name === 'string' ? custom_pipeline_name : undefined,
          customStages: Array.isArray(custom_stages) ? custom_stages : undefined,
          customFields: Array.isArray(custom_fields) ? custom_fields : undefined,
          initialSales: Array.isArray(initial_sales) ? initial_sales : undefined,
          zaloConfig: zalo_config,
          smtpConfig: smtp_config,
          capiConfig: capi_config,
          defaultPasswordHash: initialStaffPasswordHash,
        },
      });

      return {
        tenant: {
          ...tRes.rows[0],
          wallet_balance_vnd: Number(tRes.rows[0].wallet_balance_vnd || 0),
          settings: normalizeTenantSettings(tRes.rows[0].settings),
          subscription: computeSubscriptionSnapshot(tRes.rows[0], billingCatalog),
        },
        user: uRes.rows[0],
        seedInfo,
      };
    });

    tenantRedis.setCachedTenantMeta(provisioned.tenant.id, {
      slug: provisioned.tenant.slug,
      status: provisioned.tenant.status,
      rawSettings: provisioned.tenant.settings as unknown as Record<string, unknown>,
      normalizedSettings: provisioned.tenant.settings,
    });
    tenantRedis.setCachedUserAuth(provisioned.tenant.id, provisioned.user.id, {
      role: 'tenant_admin',
      isExternalAgency: false,
    });

    const sessionTtlSec = Math.max(
      300,
      Math.round((provisioned.tenant.settings.session_ttl_minutes || 60) * 60)
    );
    const refreshTtlSec = Math.max(
      86_400,
      Math.round((provisioned.tenant.settings.refresh_token_ttl_days || 7) * 86_400)
    );

    const accessToken = signTenantAccessToken(
      {
        sub: provisioned.user.id,
        tenantId: provisioned.tenant.id,
        tenantSlug: provisioned.tenant.slug,
        email: provisioned.user.email,
        name: provisioned.user.full_name,
        role: 'tenant_admin',
        isExternalAgency: false,
        planTier: provisioned.tenant.plan_tier,
      },
      sessionTtlSec
    );
    const refreshToken = signTenantRefreshToken(provisioned.user.id, provisioned.tenant.id, refreshTtlSec);
    const accountToken = signAccountToken({
      sub: globalAccountId,
      email: provisioned.user.email,
      name: provisioned.user.full_name,
      authProvider: 'password',
    });
    const workspaces = await listWorkspacesForAccount(globalAccountId, provisioned.user.email);

    void notifyPlatformWorkspaceRegistered({
      tenant_id: provisioned.tenant.id,
      tenant_slug: provisioned.tenant.slug,
      tenant_name: provisioned.tenant.name,
      industry: provisioned.tenant.industry,
      admin_name: provisioned.user.full_name,
      email: provisioned.user.email,
      phone: phoneCheck.normalizedE164,
      plan_code: provisioned.tenant.subscription_plan_code || 'trial_1m',
      trial_days: trialDays,
      trial_ends_at: provisioned.tenant.trial_ends_at,
      auth_provider: 'password',
    }).catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        action: 'enter_workspace',
        tenant: provisioned.tenant,
        user: provisioned.user,
        workspace: provisioned.seedInfo,
        workspaces,
        account_token: accountToken,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: sessionTtlSec,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'REGISTRATION_FAILED', err?.message || 'Không thể khởi tạo hệ thống doanh nghiệp.');
  }
});

// 2.3 Tenant Staff & User Login
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password, tenant_slug } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const rawPassword = String(password || '');
    const requestedSlug = String(tenant_slug || extractRequestedTenantSlug(req) || '').trim().toLowerCase();

    if (!cleanEmail || !rawPassword) {
      sendApiError(res, 422, 'MISSING_CREDENTIALS', 'Vui lòng nhập đầy đủ email và mật khẩu.');
      return;
    }

    // Resolve tenant UUID via audited pre-auth lookup
    const resolvedTenants = await withSystemPrivilege(async (client) => {
      if (requestedSlug) {
        const r = await client.query<{
          id: string;
          slug: string;
          name: string;
          domain: string | null;
          industry: string;
          plan_tier: 'starter' | 'growth' | 'enterprise';
          status: string;
          trial_ends_at: string | null;
          subscription_expires_at: string | null;
          subscription_plan_code: string | null;
          billing_cycle: string | null;
          wallet_balance_vnd: string | number | null;
          crm_erp_upgrade_status: string | null;
          settings: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT id, slug, obfuscated_slug, name, domain, industry, plan_tier, status,
                  trial_ends_at, subscription_expires_at, subscription_plan_code,
                  billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status,
                  settings, created_at
           FROM tenants WHERE obfuscated_slug = $1 OR slug = $1 LIMIT 1`,
          [requestedSlug]
        );
        return r.rows;
      }

      const r = await client.query<{
        id: string;
        slug: string;
        name: string;
        domain: string | null;
        industry: string;
        plan_tier: 'starter' | 'growth' | 'enterprise';
        status: string;
        trial_ends_at: string | null;
        subscription_expires_at: string | null;
        subscription_plan_code: string | null;
        billing_cycle: string | null;
        wallet_balance_vnd: string | number | null;
        crm_erp_upgrade_status: string | null;
        settings: Record<string, unknown>;
        created_at: string;
      }>(
        `SELECT t.id, t.slug, t.name, t.domain, t.industry, t.plan_tier, t.status,
                t.trial_ends_at, t.subscription_expires_at, t.subscription_plan_code,
                t.billing_cycle, t.wallet_balance_vnd, t.crm_erp_upgrade_status,
                t.settings, t.created_at
         FROM tenants t
         INNER JOIN users u ON u.tenant_id = t.id
         WHERE LOWER(u.email) = $1
         ORDER BY t.created_at DESC`,
        [cleanEmail]
      );
      return r.rows;
    });

    if (resolvedTenants.length === 0) {
      // Check if user has a Global Account with 0 workspaces yet -> onboarding flow
      if (!requestedSlug) {
        const ga = await withSystemPrivilege(async (client) => {
          const r = await client.query<{
            id: string;
            email: string;
            password_hash: string;
            full_name: string;
            is_active: boolean;
          }>(
            'SELECT id, email, password_hash, full_name, is_active FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1',
            [cleanEmail]
          );
          return r.rows[0] || null;
        });
        if (ga && ga.is_active && (await verifyPassword(rawPassword, ga.password_hash))) {
          const accountToken = signAccountToken({
            sub: ga.id,
            email: ga.email,
            name: ga.full_name,
            authProvider: 'password',
          });
          res.status(200).json({
            success: true,
            data: {
              action: 'create_workspace',
              account: { id: ga.id, email: ga.email, full_name: ga.full_name, auth_provider: 'password' },
              workspaces: [],
              account_token: accountToken,
            },
          });
          return;
        }
      }
      sendApiError(res, 401, 'INVALID_CREDENTIALS', 'Email, mã doanh nghiệp hoặc mật khẩu không chính xác.');
      return;
    }

    let matchedTenant: (typeof resolvedTenants)[number] | null = null;
    let matchedUser: {
      id: string;
      email: string;
      password_hash: string;
      full_name: string;
      phone: string | null;
      avatar_url: string | null;
      role: 'tenant_admin' | 'manager' | 'sale';
      is_external_agency: boolean;
      profile_status: string | null;
      is_available: boolean | null;
      vacation_mode: boolean | null;
      skipped_credit: number | null;
      work_schedule: Record<string, unknown> | null;
      zalo_chat_id: string | null;
      current_step: number | null;
      completed_steps: number[] | null;
      is_completed: boolean | null;
      dismissed_at: string | null;
    } | null = null;
    let sawSuspendedTenant = false;
    let sawDeactivatedAccount = false;

    for (const candidateTenant of resolvedTenants) {
      if (candidateTenant.status === 'suspended' || candidateTenant.status === 'cancelled') {
        sawSuspendedTenant = true;
        if (requestedSlug) break;
        continue;
      }

      // 1. Read user + profile + onboarding in a single query, releasing pooled DB connection BEFORE CPU-bound bcrypt verification
      const candidateUser = await withTenantTransaction(candidateTenant.id, async (client) => {
        const userRes = await client.query<{
          id: string;
          email: string;
          password_hash: string;
          full_name: string;
          phone: string | null;
          avatar_url: string | null;
          role: 'tenant_admin' | 'manager' | 'sale';
          is_external_agency: boolean;
          profile_status: string | null;
          is_available: boolean | null;
          vacation_mode: boolean | null;
          skipped_credit: number | null;
          work_schedule: Record<string, unknown> | null;
          zalo_chat_id: string | null;
          current_step: number | null;
          completed_steps: number[] | null;
          is_completed: boolean | null;
          dismissed_at: string | null;
        }>(
          `SELECT u.id, u.email, u.password_hash, u.full_name, u.phone, u.avatar_url, u.role, u.is_external_agency,
                  p.status AS profile_status, p.is_available, p.vacation_mode, p.skipped_credit, p.work_schedule, p.zalo_chat_id,
                  ob.current_step, ob.completed_steps, ob.is_completed, ob.dismissed_at
           FROM users u
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
           LEFT JOIN tenant_onboarding_progress ob ON ob.tenant_id = u.tenant_id
           WHERE u.tenant_id = $1 AND LOWER(u.email) = $2
           LIMIT 1`,
          [candidateTenant.id, cleanEmail]
        );
        return userRes.rows[0] || null;
      });

      if (!candidateUser) continue;

      // 2. Offload bcrypt verification to worker-thread pool with ZERO DB connections held open
      const ok = await verifyPassword(rawPassword, candidateUser.password_hash);
      if (!ok) continue;

      if (candidateUser.profile_status && candidateUser.profile_status !== 'active') {
        sawDeactivatedAccount = true;
        continue;
      }

      // 3. Record last_login_at in a brief single-statement transaction
      await withTenantTransaction(candidateTenant.id, async (client) => {
        await client.query('UPDATE users SET last_login_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2', [
          candidateTenant.id,
          candidateUser.id,
        ]);
      });

      matchedTenant = candidateTenant;
      matchedUser = candidateUser;
      break;
    }

    if (!matchedTenant || !matchedUser) {
      if (sawSuspendedTenant && (requestedSlug || resolvedTenants.length === 1)) {
        sendApiError(res, 403, 'TENANT_SUSPENDED', 'Doanh nghiệp này hiện đang bị tạm ngưng hoạt động.');
        return;
      }
      if (sawDeactivatedAccount) {
        sendApiError(
          res,
          401,
          'ACCOUNT_DEACTIVATED',
          'Tài khoản của bạn đang ở trạng thái ngừng nhận việc. Vui lòng liên hệ Quản trị viên.'
        );
        return;
      }
      sendApiError(res, 401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không chính xác.');
      return;
    }

    const targetTenant = matchedTenant;
    const user = matchedUser;
    const normalizedSettings = normalizeTenantSettings(targetTenant.settings);
    tenantRedis.setCachedTenantMeta(targetTenant.id, {
      slug: targetTenant.slug,
      status: targetTenant.status,
      rawSettings: targetTenant.settings,
      normalizedSettings,
    });
    await tenantRedis.unblacklistUser(targetTenant.id, user.id);
    tenantRedis.setCachedUserAuth(targetTenant.id, user.id, {
      role: user.role,
      isExternalAgency: Boolean(user.is_external_agency),
    });
    const sessionTtlSec = Math.max(300, Math.round((normalizedSettings.session_ttl_minutes || 60) * 60));
    const refreshTtlSec = Math.max(86_400, Math.round((normalizedSettings.refresh_token_ttl_days || 7) * 86_400));

    const accessToken = signTenantAccessToken(
      {
        sub: user.id,
        tenantId: targetTenant.id,
        tenantSlug: targetTenant.slug,
        email: user.email,
        name: user.full_name,
        role: user.role,
        isExternalAgency: Boolean(user.is_external_agency),
        planTier: targetTenant.plan_tier,
      },
      sessionTtlSec
    );
    const refreshToken = signTenantRefreshToken(user.id, targetTenant.id, refreshTtlSec);

    const billingCatalog = await getPlatformBillingCatalog();
    const gaRecord = await withSystemPrivilege(async (client) => {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1',
        [user.email.toLowerCase()]
      );
      if (existing.rows[0]?.id) return existing.rows[0].id;
      const ins = await client.query<{ id: string }>(
        `INSERT INTO global_accounts (email, password_hash, full_name, phone, is_active, last_login_at)
         VALUES ($1, $2, $3, $4, true, clock_timestamp())
         ON CONFLICT (email) DO UPDATE SET last_login_at = clock_timestamp()
         RETURNING id`,
        [user.email.toLowerCase(), user.password_hash, user.full_name, user.phone]
      );
      return ins.rows[0].id;
    });
    const workspaces = await listWorkspacesForAccount(gaRecord, user.email);
    const accountToken = signAccountToken({
      sub: gaRecord,
      email: user.email,
      name: user.full_name,
      authProvider: 'password',
    });
    const loginAction =
      requestedSlug || workspaces.length <= 1 ? 'enter_workspace' : 'select_workspace';

    res.status(200).json({
      success: true,
      data: {
        action: loginAction,
        account: {
          id: gaRecord,
          email: user.email,
          full_name: user.full_name,
          auth_provider: 'password',
        },
        workspaces,
        account_token: accountToken,
        tenant: {
          id: targetTenant.id,
          slug: targetTenant.slug,
          name: targetTenant.name,
          domain: targetTenant.domain,
          industry: targetTenant.industry,
          plan_tier: targetTenant.plan_tier,
          status: targetTenant.status,
          trial_ends_at: targetTenant.trial_ends_at,
          subscription_expires_at: targetTenant.subscription_expires_at,
          subscription_plan_code: targetTenant.subscription_plan_code || 'trial_1m',
          billing_cycle: targetTenant.billing_cycle || 'trial',
          wallet_balance_vnd: Number(targetTenant.wallet_balance_vnd || 0),
          crm_erp_upgrade_status: targetTenant.crm_erp_upgrade_status || 'none',
          subscription: computeSubscriptionSnapshot(targetTenant, billingCatalog),
          settings: normalizedSettings,
          created_at: targetTenant.created_at,
        },
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          phone: user.phone,
          avatar_url: user.avatar_url,
          role: user.role,
          is_external_agency: user.is_external_agency,
          tenant_id: targetTenant.id,
          status: user.profile_status || 'active',
          is_available: user.is_available ?? true,
          vacation_mode: user.vacation_mode ?? false,
          skipped_credit: user.skipped_credit ?? 0,
          work_schedule: user.work_schedule,
          zalo_chat_id: user.zalo_chat_id,
        },
        onboarding:
          user.current_step !== null
            ? {
                current_step: user.current_step,
                completed_steps: user.completed_steps || [],
                is_completed: Boolean(user.is_completed),
                dismissed_at: user.dismissed_at,
              }
            : { current_step: 1, completed_steps: [], is_completed: false, dismissed_at: null },
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: sessionTtlSec,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'LOGIN_FAILED', err?.message || 'Lỗi đăng nhập hệ thống.');
  }
});

// 2.3b Google OAuth Login (No Slug Required; 0 -> Create Workspace, 1 -> Enter Directly, >=2 -> Workspace Picker)
authRouter.post(['/google', '/google-login'], async (req, res) => {
  try {
    const { id_token, credential, email: rawEmail, full_name: rawName, avatar_url: rawAvatar } = req.body || {};
    const tokenInput = String(id_token || credential || '').trim();

    let googleEmail = '';
    let googleName = '';
    let googleAvatar: string | null = rawAvatar ? String(rawAvatar).trim() : null;

    if (tokenInput) {
      const parts = tokenInput.split('.');
      if (parts.length === 3) {
        if (!isOutboundSilentMode() && process.env.ALLOW_TEST_GOOGLE_LOGIN !== 'true') {
          const verifyResp = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenInput)}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!verifyResp.ok) {
            sendApiError(res, 401, 'INVALID_GOOGLE_TOKEN', 'Xác thực Google ID Token thất bại.');
            return;
          }
          const info = (await verifyResp.json()) as Record<string, any>;
          const expectedClientId = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim();
          if (expectedClientId && info.aud !== expectedClientId) {
            sendApiError(res, 401, 'GOOGLE_CLIENT_MISMATCH', 'Google Client ID không khớp với hệ thống.');
            return;
          }
          googleEmail = String(info.email || '').trim().toLowerCase();
          googleName = String(info.name || googleEmail.split('@')[0] || 'DOMATION User').trim();
          googleAvatar = info.picture ? String(info.picture) : googleAvatar;
        } else {
          try {
            let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4 !== 0) b64 += '=';
            const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, any>;
            googleEmail = String(decoded.email || rawEmail || '').trim().toLowerCase();
            googleName = String(decoded.name || rawName || googleEmail.split('@')[0] || 'DOMATION User').trim();
            googleAvatar = decoded.picture ? String(decoded.picture) : googleAvatar;
          } catch {
            sendApiError(res, 422, 'INVALID_GOOGLE_TOKEN', 'Token Google không hợp lệ.');
            return;
          }
        }
      }
    } else if ((isOutboundSilentMode() || process.env.ALLOW_TEST_GOOGLE_LOGIN === 'true') && rawEmail) {
      googleEmail = String(rawEmail).trim().toLowerCase();
      googleName = String(rawName || googleEmail.split('@')[0] || 'DOMATION User').trim();
    }

    if (!EMAIL_REGEX.test(googleEmail)) {
      sendApiError(res, 422, 'INVALID_GOOGLE_EMAIL', 'Không lấy được email hợp lệ từ Google.');
      return;
    }

    const gaRecord = await withSystemPrivilege(async (client) => {
      const existing = await client.query<{ id: string; full_name: string; is_active: boolean }>(
        'SELECT id, full_name, is_active FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1',
        [googleEmail]
      );
      if (existing.rows[0]) {
        await client.query(
          'UPDATE global_accounts SET last_login_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1',
          [existing.rows[0].id]
        );
        return existing.rows[0];
      }
      const randomPassHash = await hashPassword(crypto.randomBytes(24).toString('hex'), APP_CONFIG.bcryptRounds);
      const ins = await client.query<{ id: string; full_name: string; is_active: boolean }>(
        `INSERT INTO global_accounts (email, password_hash, full_name, is_active, last_login_at)
         VALUES ($1, $2, $3, true, clock_timestamp())
         RETURNING id, full_name, is_active`,
        [googleEmail, randomPassHash, googleName]
      );
      return ins.rows[0];
    });

    if (!gaRecord.is_active) {
      sendApiError(res, 403, 'ACCOUNT_DEACTIVATED', 'Tài khoản Google này đã bị tạm khóa.');
      return;
    }

    const workspaces = await listWorkspacesForAccount(gaRecord.id, googleEmail);
    const accountToken = signAccountToken({
      sub: gaRecord.id,
      email: googleEmail,
      name: googleName || gaRecord.full_name,
      authProvider: 'google',
    });

    if (workspaces.length === 0) {
      res.status(200).json({
        success: true,
        data: {
          action: 'create_workspace',
          google_provision_token: accountToken,
          account_token: accountToken,
          account: {
            id: gaRecord.id,
            email: googleEmail,
            full_name: googleName || gaRecord.full_name,
            avatar_url: googleAvatar,
            auth_provider: 'google',
          },
          workspaces: [],
        },
      });
      return;
    }

    const primaryWs = workspaces[0];
    const loginPayload = await issueWorkspaceSessionForAccount(primaryWs.slug, googleEmail, gaRecord.id);
    if (!loginPayload) {
      sendApiError(res, 500, 'WORKSPACE_SESSION_FAILED', 'Không thể khởi tạo phiên làm việc Workspace.');
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        action: workspaces.length === 1 ? 'enter_workspace' : 'select_workspace',
        account: {
          id: gaRecord.id,
          email: googleEmail,
          full_name: googleName || gaRecord.full_name,
          avatar_url: googleAvatar,
          auth_provider: 'google',
        },
        account_token: accountToken,
        workspaces,
        ...loginPayload,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'GOOGLE_LOGIN_FAILED', err?.message || 'Đăng nhập Google thất bại.');
  }
});

async function issueWorkspaceSessionForAccount(targetSlug: string, email: string, accountId?: string | null) {
  const billingCatalog = await getPlatformBillingCatalog();
  const tenantRow = await withSystemPrivilege(async (client) => {
    const r = await client.query<{
      id: string;
      slug: string;
      name: string;
      domain: string | null;
      industry: string;
      plan_tier: 'starter' | 'growth' | 'enterprise';
      status: string;
      trial_ends_at: string | null;
      subscription_expires_at: string | null;
      subscription_plan_code: string | null;
      billing_cycle: string | null;
      wallet_balance_vnd: string | number | null;
      crm_erp_upgrade_status: string | null;
      settings: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT id, slug, name, domain, industry, plan_tier, status,
              trial_ends_at, subscription_expires_at, subscription_plan_code,
              billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status,
              settings, created_at
       FROM tenants WHERE (slug = $1 OR obfuscated_slug = $1) LIMIT 1`,
      [targetSlug.toLowerCase()]
    );
    return r.rows[0] || null;
  });

  if (!tenantRow || (tenantRow.status !== 'active' && tenantRow.status !== 'trial')) {
    return null;
  }

  const userRow = await withTenantTransaction(tenantRow.id, async (client) => {
    const r = await client.query<any>(
      `SELECT u.id, u.email, u.full_name, u.phone, u.avatar_url, u.role, u.is_external_agency,
              p.status AS profile_status, p.is_available, p.vacation_mode, p.skipped_credit, p.work_schedule, p.zalo_chat_id,
              ob.current_step, ob.completed_steps, ob.screen_tours, ob.is_completed, ob.dismissed_at
       FROM users u
       LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
       LEFT JOIN tenant_onboarding_progress ob ON ob.tenant_id = u.tenant_id
       WHERE u.tenant_id = $1 AND (${accountId ? 'u.account_id = $2 OR ' : ''}LOWER(u.email) = ${accountId ? '$3' : '$2'})
       LIMIT 1`,
      accountId ? [tenantRow.id, accountId, email.toLowerCase()] : [tenantRow.id, email.toLowerCase()]
    );
    if (r.rows[0]) {
      await client.query('UPDATE users SET last_login_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2', [
        tenantRow.id,
        r.rows[0].id,
      ]);
    }
    return r.rows[0] || null;
  });

  if (!userRow || (userRow.profile_status && userRow.profile_status !== 'active')) {
    return null;
  }

  const normalizedSettings = normalizeTenantSettings(tenantRow.settings);
  tenantRedis.setCachedTenantMeta(tenantRow.id, {
    slug: tenantRow.slug,
    status: tenantRow.status,
    rawSettings: tenantRow.settings,
    normalizedSettings,
  });
  await tenantRedis.unblacklistUser(tenantRow.id, userRow.id);
  tenantRedis.setCachedUserAuth(tenantRow.id, userRow.id, {
    role: userRow.role,
    isExternalAgency: Boolean(userRow.is_external_agency),
  });

  const sessionTtlSec = Math.max(300, Math.round((normalizedSettings.session_ttl_minutes || 60) * 60));
  const refreshTtlSec = Math.max(86_400, Math.round((normalizedSettings.refresh_token_ttl_days || 7) * 86_400));

  const accessToken = signTenantAccessToken(
    {
      sub: userRow.id,
      tenantId: tenantRow.id,
      tenantSlug: tenantRow.slug,
      email: userRow.email,
      name: userRow.full_name,
      role: userRow.role,
      isExternalAgency: Boolean(userRow.is_external_agency),
      planTier: tenantRow.plan_tier,
    },
    sessionTtlSec
  );
  const refreshToken = signTenantRefreshToken(userRow.id, tenantRow.id, refreshTtlSec);

  return {
    tenant: {
      id: tenantRow.id,
      slug: tenantRow.slug,
      name: tenantRow.name,
      domain: tenantRow.domain,
      industry: tenantRow.industry,
      plan_tier: tenantRow.plan_tier,
      status: tenantRow.status,
      trial_ends_at: tenantRow.trial_ends_at,
      subscription_expires_at: tenantRow.subscription_expires_at,
      subscription_plan_code: tenantRow.subscription_plan_code || 'trial_1m',
      billing_cycle: tenantRow.billing_cycle || 'trial',
      wallet_balance_vnd: Number(tenantRow.wallet_balance_vnd || 0),
      crm_erp_upgrade_status: tenantRow.crm_erp_upgrade_status || 'none',
      subscription: computeSubscriptionSnapshot(tenantRow, billingCatalog),
      settings: normalizedSettings,
      created_at: tenantRow.created_at,
    },
    user: {
      id: userRow.id,
      email: userRow.email,
      full_name: userRow.full_name,
      phone: userRow.phone,
      avatar_url: userRow.avatar_url,
      role: userRow.role,
      is_external_agency: userRow.is_external_agency,
      tenant_id: tenantRow.id,
      status: userRow.profile_status || 'active',
      is_available: userRow.is_available ?? true,
      vacation_mode: userRow.vacation_mode ?? false,
      skipped_credit: userRow.skipped_credit ?? 0,
      work_schedule: userRow.work_schedule,
      zalo_chat_id: userRow.zalo_chat_id,
    },
    onboarding:
      userRow.current_step !== null && userRow.current_step !== undefined
        ? {
            current_step: userRow.current_step,
            completed_steps: userRow.completed_steps || [],
            screen_tours: userRow.screen_tours || {},
            is_completed: Boolean(userRow.is_completed),
            dismissed_at: userRow.dismissed_at,
          }
        : { current_step: 1, completed_steps: [], screen_tours: {}, is_completed: false, dismissed_at: null },
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: sessionTtlSec,
  };
}

// 2.3c List Workspaces for Authenticated Account/User
authRouter.get('/workspaces', async (req, res) => {
  try {
    const caller = extractCallerIdentity(req);
    if (!caller) {
      sendApiError(res, 401, 'UNAUTHORIZED', 'Vui lòng đăng nhập để xem danh sách Workspace.');
      return;
    }
    const workspaces = await listWorkspacesForAccount(caller.accountId, caller.email);
    res.json({ success: true, data: { workspaces } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_WORKSPACES_FAILED', err?.message || 'Không thể tải danh sách Workspace.');
  }
});

// 2.3d Switch Active Workspace
authRouter.post('/switch-workspace', async (req, res) => {
  try {
    const caller = extractCallerIdentity(req);
    if (!caller) {
      sendApiError(res, 401, 'UNAUTHORIZED', 'Phiên đăng nhập không hợp lệ.');
      return;
    }
    const targetSlug = String(req.body?.tenant_slug || req.body?.slug || '').trim().toLowerCase();
    if (!targetSlug) {
      sendApiError(res, 422, 'MISSING_TENANT_SLUG', 'Vui lòng chọn Workspace cần truy cập.');
      return;
    }

    const sessionPayload = await issueWorkspaceSessionForAccount(targetSlug, caller.email, caller.accountId);
    if (!sessionPayload) {
      sendApiError(res, 403, 'WORKSPACE_ACCESS_DENIED', 'Bạn không có quyền truy cập Workspace này hoặc Workspace đã tạm khóa.');
      return;
    }
    const workspaces = await listWorkspacesForAccount(caller.accountId, caller.email);

    res.json({
      success: true,
      data: {
        action: 'enter_workspace',
        workspaces,
        ...sessionPayload,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'SWITCH_WORKSPACE_FAILED', err?.message || 'Không thể chuyển Workspace.');
  }
});

// 2.3e Create Additional Workspace (or First Workspace after 0-workspace Login / Google OAuth)
authRouter.post(['/create-workspace', '/google-create-workspace'], async (req, res) => {
  try {
    const caller = extractCallerIdentity(req);
    if (!caller) {
      sendApiError(res, 401, 'UNAUTHORIZED', 'Vui lòng đăng nhập trước khi tạo Workspace.');
      return;
    }

    const {
      company_name,
      tenant_slug,
      admin_name,
      phone,
      industry = 'real_estate',
      team_scale = '6_20',
      seed_demo_leads = true,
      initial_sales,
      custom_settings,
      custom_pipeline_name,
      custom_stages,
      custom_fields,
    } = req.body || {};

    const cleanName = String(company_name || '').trim();
    const cleanSlug = String(tenant_slug || '').trim().toLowerCase() || slugifyCompanyName(cleanName);
    const cleanAdminName = String(admin_name || caller.name || caller.email.split('@')[0]).trim();

    if (!cleanName || cleanName.length < 2) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên doanh nghiệp phải có ít nhất 2 ký tự.');
      return;
    }
    if (!SLUG_REGEX.test(cleanSlug)) {
      sendApiError(res, 422, 'INVALID_SLUG', 'Định danh Workspace (slug) không hợp lệ.');
      return;
    }

    const [slugTaken, platformDefaults, gaRow] = await Promise.all([
      withSystemPrivilege(async (client) => {
        const r = await client.query('SELECT id FROM tenants WHERE slug = $1 LIMIT 1', [cleanSlug]);
        return r.rows.length > 0;
      }),
      getPlatformDefaultsCached(),
      withSystemPrivilege(async (client) => {
        const r = await client.query<{ id: string; password_hash: string; phone: string | null }>(
          'SELECT id, password_hash, phone FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1',
          [caller.email]
        );
        return r.rows[0] || null;
      }),
    ]);

    if (slugTaken) {
      sendApiError(res, 409, 'SLUG_ALREADY_TAKEN', `Định danh doanh nghiệp '${cleanSlug}' đã tồn tại.`);
      return;
    }

    const baseTenantSettings = normalizeTenantSettings(
      {
        ...platformDefaults,
        team_scale,
        ...(custom_settings && typeof custom_settings === 'object' ? custom_settings : {}),
      },
      DEFAULT_TENANT_SETTINGS
    );

    const passwordHash =
      gaRow?.password_hash || (await hashPassword(crypto.randomBytes(24).toString('hex'), APP_CONFIG.bcryptRounds));
    const accountId =
      gaRow?.id ||
      (await withSystemPrivilege(async (client) => {
        const newId = crypto.randomUUID();
        await client.query(
          `INSERT INTO global_accounts (id, email, password_hash, full_name, is_active, last_login_at)
           VALUES ($1, $2, $3, $4, true, clock_timestamp())`,
          [newId, caller.email, passwordHash, cleanAdminName]
        );
        return newId;
      }));

    const billingCatalog = await getPlatformBillingCatalog();
    const trialDays = Math.max(0, Number(billingCatalog.trial_duration_days ?? 30));
    const trialEndsIso = new Date(Date.now() + trialDays * 86_400_000).toISOString();
    const tenantId = crypto.randomUUID();
    const adminUserId = crypto.randomUUID();
    const cleanPhone = phone ? String(phone).trim() : gaRow?.phone || null;

    const provisioned = await withTenantTransaction(tenantId, async (client) => {
      const tRes = await client.query<any>(
        `INSERT INTO tenants (
           id, slug, name, industry, plan_tier, status,
           trial_ends_at, subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status,
           settings
         )
         VALUES ($1, $2, $3, $4, 'starter', 'active', $5::timestamptz, 'trial_1m', 'trial', 0, 'none', $6::jsonb)
         RETURNING *`,
        [tenantId, cleanSlug, cleanName, String(industry || 'real_estate'), trialEndsIso, JSON.stringify(baseTenantSettings)]
      );

      await client.query(
        `INSERT INTO users (id, account_id, tenant_id, email, password_hash, full_name, phone, role, is_tenant_owner, is_external_agency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'tenant_admin', true, false)`,
        [adminUserId, accountId, tenantId, caller.email, passwordHash, cleanAdminName, cleanPhone]
      );

      const seedInfo = await seedTenantWorkspace(client, {
        tenantId,
        tenantSlug: cleanSlug,
        adminUserId,
        adminName: cleanAdminName,
        industry: String(industry || 'real_estate'),
        options: {
          seedDemoLeads: seed_demo_leads !== false,
          customPipelineName: typeof custom_pipeline_name === 'string' ? custom_pipeline_name : undefined,
          customStages: Array.isArray(custom_stages) ? custom_stages : undefined,
          customFields: Array.isArray(custom_fields) ? custom_fields : undefined,
          initialSales: Array.isArray(initial_sales) ? initial_sales : undefined,
          defaultPasswordHash: passwordHash,
        },
      });

      return { tenantRow: tRes.rows[0], seedInfo };
    });

    const sessionPayload = await issueWorkspaceSessionForAccount(cleanSlug, caller.email, accountId);
    const workspaces = await listWorkspacesForAccount(accountId, caller.email);

    void notifyPlatformWorkspaceRegistered({
      tenant_id: tenantId,
      tenant_slug: cleanSlug,
      tenant_name: cleanName,
      industry: String(industry || 'real_estate'),
      admin_name: cleanAdminName,
      email: caller.email,
      phone: cleanPhone,
      plan_code: 'trial_1m',
      trial_days: trialDays,
      trial_ends_at: trialEndsIso,
      auth_provider: req.path.includes('google') ? 'google' : 'account',
    }).catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        action: 'enter_workspace',
        workspace: provisioned.seedInfo,
        workspaces,
        account_token: signAccountToken({
          sub: accountId,
          email: caller.email,
          name: cleanAdminName,
          authProvider: 'password',
        }),
        ...sessionPayload,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_WORKSPACE_FAILED', err?.message || 'Không thể khởi tạo Workspace mới.');
  }
});

// Get Authenticated Tenant User & Onboarding Tour State (Single Joined Query — Zero Sequential Roundtrips)
authRouter.get('/me', requireTenantAuth, async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const billingCatalog = await getPlatformBillingCatalog();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const combined = await client.query(
        `SELECT
           t.id AS t_id, t.slug AS t_slug, t.name AS t_name, t.domain AS t_domain,
           t.industry AS t_industry, t.industry_key AS t_industry_key,
           t.package_code AS t_package_code, t.plan_tier AS t_plan_tier,
           t.enabled_modules AS t_enabled_modules, t.entitlements AS t_entitlements,
           t.status AS t_status,
           t.trial_ends_at AS t_trial_ends_at, t.subscription_expires_at AS t_subscription_expires_at,
           t.subscription_plan_code AS t_subscription_plan_code, t.billing_cycle AS t_billing_cycle,
           t.wallet_balance_vnd AS t_wallet_balance_vnd, t.crm_erp_upgrade_status AS t_crm_erp_upgrade_status,
           t.settings AS t_settings, t.created_at AS t_created_at,
           u.id AS u_id, u.email AS u_email, u.full_name AS u_full_name, u.phone AS u_phone,
           u.role AS u_role, u.is_tenant_owner AS u_is_tenant_owner, u.is_external_agency AS u_is_external_agency, u.avatar_url AS u_avatar_url,
           p.status AS p_status, p.is_available AS p_is_available, p.vacation_mode AS p_vacation_mode,
           p.skipped_credit AS p_skipped_credit, p.work_schedule AS p_work_schedule, p.zalo_chat_id AS p_zalo_chat_id,
           ob.current_step AS ob_current_step, ob.completed_steps AS ob_completed_steps,
           ob.screen_tours AS ob_screen_tours,
           ob.is_completed AS ob_is_completed, ob.dismissed_at AS ob_dismissed_at
         FROM tenants t
         LEFT JOIN users u ON u.tenant_id = t.id AND u.id = $2
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = t.id AND p.user_id = u.id
         LEFT JOIN tenant_onboarding_progress ob ON ob.tenant_id = t.id
         WHERE t.id = $1
         LIMIT 1`,
        [ctx.tenantId, ctx.userId]
      );
      const r = combined.rows[0];
      if (!r) {
        return {
          tenant: null,
          user: null,
          onboarding: { current_step: 1, completed_steps: [], is_completed: false },
        };
      }
      const entSnap = resolveTenantEntitlementSnapshot({
        package_code: r.t_package_code,
        plan_tier: r.t_plan_tier,
        subscription_plan_code: r.t_subscription_plan_code,
        crm_erp_upgrade_status: r.t_crm_erp_upgrade_status,
        industry: r.t_industry,
        industry_key: r.t_industry_key,
        enabled_modules: r.t_enabled_modules,
        entitlements: r.t_entitlements,
        settings: r.t_settings,
      });
      return {
        tenant: {
          id: r.t_id,
          slug: r.t_slug,
          name: r.t_name,
          domain: r.t_domain,
          industry: r.t_industry,
          industry_key: entSnap.industry_key,
          package_code: entSnap.package_code,
          plan_tier: r.t_plan_tier,
          enabled_modules: entSnap.enabled_modules,
          entitlements: entSnap.entitlements,
          terminology: entSnap.terminology,
          status: r.t_status,
          trial_ends_at: r.t_trial_ends_at,
          subscription_expires_at: r.t_subscription_expires_at,
          subscription_plan_code: r.t_subscription_plan_code || 'trial_1m',
          billing_cycle: r.t_billing_cycle || 'trial',
          wallet_balance_vnd: Number(r.t_wallet_balance_vnd || 0),
          crm_erp_upgrade_status: r.t_crm_erp_upgrade_status || 'none',
          subscription: computeSubscriptionSnapshot(
            {
              plan_tier: r.t_plan_tier,
              created_at: r.t_created_at,
              trial_ends_at: r.t_trial_ends_at,
              subscription_expires_at: r.t_subscription_expires_at,
              subscription_plan_code: r.t_subscription_plan_code,
              billing_cycle: r.t_billing_cycle,
              wallet_balance_vnd: r.t_wallet_balance_vnd,
              crm_erp_upgrade_status: r.t_crm_erp_upgrade_status,
            },
            billingCatalog
          ),
          settings: normalizeTenantSettings(r.t_settings),
          created_at: r.t_created_at,
        },
        user: r.u_id
          ? {
              id: r.u_id,
              email: r.u_email,
              full_name: r.u_full_name,
              phone: r.u_phone,
              role: r.u_role,
              is_tenant_owner: Boolean(r.u_is_tenant_owner),
              is_external_agency: r.u_is_external_agency,
              avatar_url: r.u_avatar_url,
              status: r.p_status,
              is_available: r.p_is_available,
              vacation_mode: r.p_vacation_mode,
              skipped_credit: r.p_skipped_credit,
              work_schedule: r.p_work_schedule,
              zalo_chat_id: r.p_zalo_chat_id,
            }
          : null,
        onboarding:
          r.ob_current_step !== null && r.ob_current_step !== undefined
            ? {
                current_step: r.ob_current_step,
                completed_steps: r.ob_completed_steps || [],
                screen_tours: r.ob_screen_tours || {},
                is_completed: Boolean(r.ob_is_completed),
                dismissed_at: r.ob_dismissed_at,
              }
            : { current_step: 1, completed_steps: [], screen_tours: {}, is_completed: false },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'FETCH_ME_FAILED', err?.message || 'Không thể tải thông tin phiên làm việc.');
  }
});

// Update Interactive Onboarding & Per-Screen Spotlight Tour Progress
authRouter.patch('/onboarding', requireTenantAuth, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { current_step, completed_steps, screen_tours, is_completed, dismissed } = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query<{ screen_tours: Record<string, unknown> }>(
        'SELECT screen_tours FROM tenant_onboarding_progress WHERE tenant_id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      const mergedScreenTours =
        screen_tours && typeof screen_tours === 'object'
          ? { ...(existing.rows[0]?.screen_tours || {}), ...(screen_tours as Record<string, unknown>) }
          : null;

      const r = await client.query(
        `INSERT INTO tenant_onboarding_progress (tenant_id, current_step, completed_steps, screen_tours, is_completed, dismissed_at)
         VALUES ($1, COALESCE($2::int, 1), COALESCE($3::jsonb, '[]'::jsonb), COALESCE($7::jsonb, '{}'::jsonb), COALESCE($4::boolean, false), $5::timestamptz)
         ON CONFLICT (tenant_id) DO UPDATE SET
           current_step = COALESCE($2::int, tenant_onboarding_progress.current_step),
           completed_steps = COALESCE($3::jsonb, tenant_onboarding_progress.completed_steps),
           screen_tours = COALESCE($7::jsonb, tenant_onboarding_progress.screen_tours),
           is_completed = COALESCE($4::boolean, tenant_onboarding_progress.is_completed),
           dismissed_at = CASE
             WHEN $6::boolean = true THEN clock_timestamp()
             WHEN $6::boolean = false THEN NULL
             ELSE tenant_onboarding_progress.dismissed_at
           END
         RETURNING current_step, completed_steps, screen_tours, is_completed, dismissed_at`,
        [
          ctx.tenantId,
          typeof current_step === 'number' ? current_step : null,
          Array.isArray(completed_steps) ? JSON.stringify(completed_steps) : null,
          typeof is_completed === 'boolean' ? is_completed : null,
          dismissed === true ? new Date().toISOString() : null,
          typeof dismissed === 'boolean' ? dismissed : null,
          mergedScreenTours ? JSON.stringify(mergedScreenTours) : null,
        ]
      );
      return r.rows[0];
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'ONBOARDING_UPDATE_FAILED', err?.message || 'Không thể lưu tiến độ hướng dẫn.');
  }
});

// Update Tenant Organization Settings
authRouter.patch('/tenant-settings', requireTenantAuth, requireRoles('tenant_admin'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { name, domain, industry, settings, reset_to_defaults } = req.body || {};

    const platformBase = reset_to_defaults
      ? normalizeTenantSettings(await getPlatformDefaultsCached(), DEFAULT_TENANT_SETTINGS)
      : DEFAULT_TENANT_SETTINGS;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query<{ settings: Record<string, unknown> }>(
        'SELECT settings FROM tenants WHERE id = $1',
        [ctx.tenantId]
      );
      const rawMerged = reset_to_defaults
        ? { ...(settings && typeof settings === 'object' ? settings : {}) }
        : {
            ...(cur.rows[0]?.settings || {}),
            ...(settings && typeof settings === 'object' ? settings : {}),
          };
      const normalized = normalizeTenantSettings(rawMerged, platformBase);

      const hasDomainUpdate = domain !== undefined;
      const nextDomain = hasDomainUpdate ? (domain ? String(domain).trim().toLowerCase() : null) : null;

      const r = await client.query(
        `UPDATE tenants
         SET name = COALESCE($2, name),
             domain = CASE WHEN $3::boolean THEN $4 ELSE domain END,
             industry = COALESCE($5, industry),
             settings = $6::jsonb,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING id, slug, name, domain, industry, plan_tier, status, settings`,
        [
          ctx.tenantId,
          name ? String(name).trim() : null,
          hasDomainUpdate,
          nextDomain,
          industry ? String(industry).trim() : null,
          JSON.stringify(normalized),
        ]
      );
      await client.query(
        `INSERT INTO admin_audit_logs (
           tenant_id, actor_id, actor_name, action, entity_type, entity_id,
           before_snapshot, after_snapshot, details
         ) VALUES ($1, $2, $3, 'update_tenant_settings', 'tenant_settings', $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
        [
          ctx.tenantId,
          ctx.userId,
          ctx.userName || 'Admin',
          ctx.tenantId,
          JSON.stringify(cur.rows[0]?.settings || {}),
          JSON.stringify(normalized),
          JSON.stringify({ reset_to_defaults: Boolean(reset_to_defaults) }),
        ]
      );
      return r.rows[0];
    });

    tenantRedis.invalidateTenantCache(ctx.tenantId, ctx.tenantSlug);
    if (updated) {
      const norm = normalizeTenantSettings(updated.settings);
      tenantRedis.setCachedTenantMeta(ctx.tenantId, {
        slug: updated.slug,
        status: updated.status,
        rawSettings: updated.settings,
        normalizedSettings: norm,
      });
    }

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'TENANT_SETTINGS_UPDATE_FAILED', err?.message || 'Không thể cập nhật cấu hình doanh nghiệp.');
  }
});
