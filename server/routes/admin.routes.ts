import { Router } from 'express';
import { verifyPassword } from '../core/crypto/password.ts';
import { withSystemPrivilege } from '../core/database/transaction.ts';
import { signPlatformAccessToken, signTenantAccessToken } from '../core/crypto/jwt.ts';
import { getPlatformContext } from '../core/context/tenant-context.ts';
import { requirePlatformSuperAdmin, sendApiError } from '../core/security/rbac.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  normalizeTenantSettings,
  DEFAULT_TENANT_SETTINGS,
} from '../core/settings/tenant-settings.ts';
import {
  DEFAULT_PLATFORM_OPERATIONAL_CONFIG,
  invalidatePlatformOperationalConfigCache,
  normalizePlatformOperationalConfig,
} from '../core/settings/platform-config.ts';
import {
  DEFAULT_BILLING_CATALOG,
  normalizeBillingCatalog,
  getPlatformBillingCatalog,
  invalidateBillingCatalogCache,
  computeSubscriptionSnapshot,
  applySubscriptionActivationInTx,
  generateBillingReferenceCode,
} from '../services/billing.service.ts';
import {
  SAAS_PACKAGES_CATALOG,
  buildModulesForPackage,
  resolveCanonicalBillingIdentity,
} from '../core/security/entitlements.ts';
import {
  dispatchPlatformAppscriptEvent,
  fetchTenantPrimaryAdminContact,
  getMasterAppscriptConfig,
  isValidAppscriptWebhookUrl,
  notifyPlatformBillingEvent,
  saveMasterAppscriptConfig,
  type PlatformBillingEventType,
} from '../services/platform-appscript.service.ts';

export const adminRouter = Router();

// 2.4 Platform Super Admin Login (Segregated Administrative Gateway)
adminRouter.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const rawPassword = String(password || '');

    if (!cleanEmail || !rawPassword) {
      sendApiError(res, 422, 'MISSING_CREDENTIALS', 'Vui lòng nhập email và mật khẩu quản trị nền tảng.');
      return;
    }

    const admin = await withSystemPrivilege(async (client) => {
      const r = await client.query<{
        id: string;
        email: string;
        password_hash: string;
        full_name: string;
        role: string;
        is_active: boolean;
      }>('SELECT id, email, password_hash, full_name, role, is_active FROM platform_superadmins WHERE LOWER(email) = $1 LIMIT 1', [
        cleanEmail,
      ]);
      return r.rows[0] || null;
    });

    if (!admin) {
      sendApiError(res, 401, 'INVALID_PLATFORM_CREDENTIALS', 'Thông tin đăng nhập Platform Super Admin không chính xác.');
      return;
    }
    if (!admin.is_active) {
      sendApiError(res, 403, 'PLATFORM_ACCOUNT_INACTIVE', 'Tài khoản Super Admin đã bị khóa.');
      return;
    }

    const ok = await verifyPassword(rawPassword, admin.password_hash);
    if (!ok) {
      sendApiError(res, 401, 'INVALID_PLATFORM_CREDENTIALS', 'Thông tin đăng nhập Platform Super Admin không chính xác.');
      return;
    }

    await withSystemPrivilege(async (client) => {
      await client.query('UPDATE platform_superadmins SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [admin.id]);
    });

    const token = signPlatformAccessToken(
      {
        sub: admin.id,
        email: admin.email,
        name: admin.full_name,
      },
      1800
    );

    res.status(200).json({
      success: true,
      data: {
        admin: {
          id: admin.id,
          email: admin.email,
          full_name: admin.full_name,
          role: 'super_admin',
        },
        access_token: token,
        expires_in: 1800,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'PLATFORM_LOGIN_FAILED', err?.message || 'Lỗi xác thực Platform Admin.');
  }
});

// Platform-Wide Default Tenant Settings Governance
adminRouter.get('/platform-settings', requirePlatformSuperAdmin, async (_req, res) => {
  try {
    const data = await withSystemPrivilege(async (client) => {
      const [defRes, opsRes] = await Promise.all([
        client.query<{ setting_value: Record<string, unknown>; updated_at: string }>(
          "SELECT setting_value, updated_at FROM platform_settings WHERE setting_key = 'default_tenant_settings' LIMIT 1"
        ),
        client.query<{ setting_value: Record<string, unknown>; updated_at: string }>(
          "SELECT setting_value, updated_at FROM platform_settings WHERE setting_key = 'operational_limits' LIMIT 1"
        ),
      ]);
      return {
        default_tenant_settings: normalizeTenantSettings(
          defRes.rows[0]?.setting_value || {},
          DEFAULT_TENANT_SETTINGS
        ),
        operational_limits: normalizePlatformOperationalConfig(
          opsRes.rows[0]?.setting_value || DEFAULT_PLATFORM_OPERATIONAL_CONFIG
        ),
        updated_at: defRes.rows[0]?.updated_at || opsRes.rows[0]?.updated_at || null,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PLATFORM_SETTINGS_FETCH_FAILED', err?.message || 'Không thể tải cấu hình mặc định nền tảng.');
  }
});

adminRouter.patch('/platform-settings', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const { default_tenant_settings, operational_limits, reset_to_factory } = req.body || {};
    const saved = await withSystemPrivilege(async (client) => {
      const cur = await client.query<{ setting_value: Record<string, unknown> }>(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'default_tenant_settings' LIMIT 1"
      );
      const merged = reset_to_factory
        ? normalizeTenantSettings({}, DEFAULT_TENANT_SETTINGS)
        : normalizeTenantSettings(
            {
              ...(cur.rows[0]?.setting_value || {}),
              ...(default_tenant_settings && typeof default_tenant_settings === 'object'
                ? default_tenant_settings
                : {}),
            },
            DEFAULT_TENANT_SETTINGS
          );

      const r = await client.query<{ setting_value: Record<string, unknown>; updated_at: string }>(
        `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
         VALUES ('default_tenant_settings', $1::jsonb, clock_timestamp())
         ON CONFLICT (setting_key) DO UPDATE SET
           setting_value = EXCLUDED.setting_value,
           updated_at = clock_timestamp()
         RETURNING setting_value, updated_at`,
        [JSON.stringify(merged)]
      );

      let savedOps = DEFAULT_PLATFORM_OPERATIONAL_CONFIG;
      if (reset_to_factory || (operational_limits && typeof operational_limits === 'object')) {
        const curOps = await client.query<{ setting_value: Record<string, unknown> }>(
          "SELECT setting_value FROM platform_settings WHERE setting_key = 'operational_limits' LIMIT 1"
        );
        const curNormOps = normalizePlatformOperationalConfig(curOps.rows[0]?.setting_value || {});
        const nextOps = reset_to_factory
          ? DEFAULT_PLATFORM_OPERATIONAL_CONFIG
          : normalizePlatformOperationalConfig({
              ...curNormOps,
              ...(operational_limits && typeof operational_limits === 'object' ? operational_limits : {}),
              cron_limits: {
                ...curNormOps.cron_limits,
                ...(operational_limits?.cron_limits && typeof operational_limits.cron_limits === 'object'
                  ? operational_limits.cron_limits
                  : operational_limits && typeof operational_limits === 'object'
                    ? operational_limits
                    : {}),
              },
              industry_preset_overrides: {
                ...curNormOps.industry_preset_overrides,
                ...(operational_limits?.industry_preset_overrides &&
                typeof operational_limits.industry_preset_overrides === 'object'
                  ? operational_limits.industry_preset_overrides
                  : {}),
              },
            });
        const opsRes = await client.query<{ setting_value: Record<string, unknown> }>(
          `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
           VALUES ('operational_limits', $1::jsonb, clock_timestamp())
           ON CONFLICT (setting_key) DO UPDATE SET
             setting_value = EXCLUDED.setting_value,
             updated_at = clock_timestamp()
           RETURNING setting_value`,
          [JSON.stringify(nextOps)]
        );
        savedOps = normalizePlatformOperationalConfig(opsRes.rows[0]?.setting_value || nextOps);
      } else {
        const curOps = await client.query<{ setting_value: Record<string, unknown> }>(
          "SELECT setting_value FROM platform_settings WHERE setting_key = 'operational_limits' LIMIT 1"
        );
        savedOps = normalizePlatformOperationalConfig(curOps.rows[0]?.setting_value || {});
      }

      return {
        default_tenant_settings: r.rows[0].setting_value,
        operational_limits: savedOps,
        updated_at: r.rows[0].updated_at,
      };
    });

    tenantRedis.invalidatePlatformDefaultsCache();
    tenantRedis.setCachedPlatformDefaults(saved.default_tenant_settings as Record<string, unknown>);
    invalidatePlatformOperationalConfigCache();
    invalidateBillingCatalogCache();

    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'PLATFORM_SETTINGS_SAVE_FAILED', err?.message || 'Không thể lưu cấu hình mặc định nền tảng.');
  }
});

// Op 02: View Global Platform Analytics & Tenant Registry (Single Hash-Aggregate Pass for Hundreds of Tenants)
adminRouter.get('/tenants', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : null;
    const rawLimit = req.query.limit ? Number(req.query.limit) : null;
    const page = Math.max(1, Number(req.query.page || 1));

    const billingCatalog = await getPlatformBillingCatalog();
    const data = await withSystemPrivilege(async (client) => {
      const params: unknown[] = [];
      let where = '1 = 1';
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (t.name ILIKE $1 OR t.slug ILIKE $1 OR COALESCE(t.domain, '') ILIKE $1)`;
      }

      let paginationSql = '';
      if (rawLimit && Number.isFinite(rawLimit) && rawLimit > 0) {
        const limit = Math.min(1000, Math.max(1, Math.round(rawLimit)));
        const offset = (page - 1) * limit;
        params.push(limit, offset);
        paginationSql = ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
      }

      const tenantsRes = await client.query(
        `WITH page_tenants AS (
           SELECT
             t.id, t.slug, t.name, t.domain, t.industry, t.package_code, t.plan_tier, t.status,
             t.trial_ends_at, t.subscription_expires_at, t.grace_ends_at,
             t.auto_renew, t.cancel_at_period_end, t.cancelled_at,
             t.scheduled_plan_code, t.scheduled_billing_cycle,
             t.subscription_plan_code, t.billing_cycle, t.wallet_balance_vnd, t.crm_erp_upgrade_status,
             t.settings, t.created_at
           FROM tenants t
           WHERE ${where}
           ORDER BY t.created_at DESC${paginationSql}
         ),
         user_counts AS (
           SELECT u.tenant_id, COUNT(*)::int AS cnt
           FROM users u
           WHERE u.tenant_id IN (SELECT id FROM page_tenants)
           GROUP BY u.tenant_id
         ),
         lead_counts AS (
           SELECT l.tenant_id, COUNT(*)::int AS cnt
           FROM leads l
           WHERE l.tenant_id IN (SELECT id FROM page_tenants)
           GROUP BY l.tenant_id
         )
         SELECT
           pt.id, pt.slug, pt.name, pt.domain, pt.industry, pt.package_code, pt.plan_tier, pt.status,
           pt.trial_ends_at, pt.subscription_expires_at, pt.grace_ends_at,
           pt.auto_renew, pt.cancel_at_period_end, pt.cancelled_at,
           pt.scheduled_plan_code, pt.scheduled_billing_cycle,
           pt.subscription_plan_code, pt.billing_cycle, pt.wallet_balance_vnd, pt.crm_erp_upgrade_status,
           pt.settings, pt.created_at,
           COALESCE(uc.cnt, 0) AS users_count,
           COALESCE(lc.cnt, 0) AS leads_count
         FROM page_tenants pt
         LEFT JOIN user_counts uc ON uc.tenant_id = pt.id
         LEFT JOIN lead_counts lc ON lc.tenant_id = pt.id
         ORDER BY pt.created_at DESC`,
        params
      );

      let totalTenants = tenantsRes.rows.length;
      let totalLeadsPlatform = tenantsRes.rows.reduce((acc, r) => acc + Number(r.leads_count || 0), 0);
      if (paginationSql || search) {
        const totalsRes = await client.query<{ t_cnt: number; l_cnt: number }>(
          `SELECT
             (SELECT COUNT(*)::int FROM tenants) AS t_cnt,
             (SELECT COUNT(*)::int FROM leads) AS l_cnt`
        );
        totalTenants = Number(totalsRes.rows[0]?.t_cnt || 0);
        totalLeadsPlatform = Number(totalsRes.rows[0]?.l_cnt || 0);
      }

      return {
        total_tenants: totalTenants,
        total_leads_platform: totalLeadsPlatform,
        items: tenantsRes.rows.map((r) => ({
          ...r,
          wallet_balance_vnd: Number(r.wallet_balance_vnd || 0),
          subscription: computeSubscriptionSnapshot(r, billingCatalog),
          settings: normalizeTenantSettings(r.settings),
        })),
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PLATFORM_LIST_TENANTS_FAILED', err?.message || 'Không thể tải danh sách doanh nghiệp.');
  }
});

// Op 01 & Op 04: Suspend / Activate Tenant, Plan Tier, Metadata & Custom Settings Override
adminRouter.patch('/tenants/:id', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const tenantId = req.params.id;
    const { status, plan_tier, name, domain, industry, settings } = req.body || {};

    const updated = await withSystemPrivilege(async (client) => {
      let nextSettingsJson: string | null = null;
      let nextPackageCode: string | null = null;
      let nextModulesJson: string | null = null;
      let nextEntitlementsJson: string | null = null;

      const cur = await client.query<{
        settings: Record<string, unknown>;
        entitlements: Record<string, unknown>;
      }>('SELECT settings, entitlements FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);

      if (cur.rows[0]) {
        if (settings && typeof settings === 'object') {
          const merged = normalizeTenantSettings({
            ...(cur.rows[0].settings || {}),
            ...(settings as Record<string, unknown>),
          });
          nextSettingsJson = JSON.stringify(merged);
        }
        if (plan_tier) {
          const id = resolveCanonicalBillingIdentity(plan_tier);
          if (id) {
            const pkgDef = SAAS_PACKAGES_CATALOG[id.package_code];
            const curEnt =
              cur.rows[0].entitlements && typeof cur.rows[0].entitlements === 'object'
                ? cur.rows[0].entitlements
                : {};
            const eduAddon = Boolean(curEnt.education_addon);
            nextPackageCode = id.package_code;
            nextModulesJson = JSON.stringify(buildModulesForPackage(id.package_code, { educationAddon: eduAddon }));
            nextEntitlementsJson = JSON.stringify({
              ...curEnt,
              package_code: id.package_code,
              package_name: pkgDef.name,
              package_badge: pkgDef.badge,
              tour_suite: pkgDef.tour_suite,
              connect_wizard_suite: pkgDef.connect_wizard_suite,
              ai_capabilities: pkgDef.ai_capabilities,
            });
          }
        }
      }

      const r = await client.query(
        `UPDATE tenants
         SET status = COALESCE($2, status),
             plan_tier = COALESCE($3, plan_tier),
             package_code = COALESCE($9, package_code),
             enabled_modules = COALESCE($10::jsonb, enabled_modules),
             entitlements = COALESCE($11::jsonb, entitlements),
             name = COALESCE($4, name),
             domain = CASE WHEN $5::boolean THEN $6 ELSE domain END,
             industry = COALESCE($7, industry),
             settings = COALESCE($8::jsonb, settings),
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING id, slug, name, domain, industry, package_code, plan_tier, status, settings`,
        [
          tenantId,
          status || null,
          plan_tier || null,
          name ? String(name).trim() : null,
          domain !== undefined,
          domain ? String(domain).trim().toLowerCase() : null,
          industry ? String(industry).trim() : null,
          nextSettingsJson,
          nextPackageCode,
          nextModulesJson,
          nextEntitlementsJson,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy tổ chức.');
      return;
    }

    tenantRedis.invalidateTenantCache(tenantId, updated.slug);
    await tenantRedis.del('meta:tenant_status', tenantId);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'PLATFORM_UPDATE_TENANT_FAILED', err?.message || 'Không thể cập nhật tổ chức.');
  }
});

// Op 03: Audited Support Impersonation Token (Configurable duration 1..240 min, default 15 minutes = 900s)
adminRouter.post('/tenants/:id/impersonate', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const platformAdmin = getPlatformContext();
    const tenantId = req.params.id;
    const rawDurationMinutes = req.body?.duration_minutes;
    const durationMinutes =
      rawDurationMinutes !== undefined && rawDurationMinutes !== null && Number.isFinite(Number(rawDurationMinutes))
        ? Math.min(240, Math.max(1, Math.round(Number(rawDurationMinutes))))
        : 15;
    const expiresInSeconds = durationMinutes * 60;

    const target = await withSystemPrivilege(async (client) => {
      const r = await client.query<{
        tenant_id: string;
        slug: string;
        plan_tier: 'starter' | 'growth' | 'enterprise';
        user_id: string;
        email: string;
        full_name: string;
      }>(
        `SELECT t.id AS tenant_id, t.slug, t.plan_tier, u.id AS user_id, u.email, u.full_name
         FROM tenants t
         INNER JOIN users u ON u.tenant_id = t.id AND u.role = 'tenant_admin'
         WHERE t.id = $1
         ORDER BY u.created_at ASC
         LIMIT 1`,
        [tenantId]
      );
      return r.rows[0] || null;
    });

    if (!target) {
      sendApiError(res, 404, 'TENANT_ADMIN_NOT_FOUND', 'Không tìm thấy tài khoản Tenant Admin của doanh nghiệp này.');
      return;
    }

    const supportToken = signTenantAccessToken(
      {
        sub: target.user_id,
        tenantId: target.tenant_id,
        tenantSlug: target.slug,
        email: target.email,
        name: `${target.full_name} (Support Audit)`,
        role: 'tenant_admin',
        isExternalAgency: false,
        planTier: target.plan_tier,
        impersonatedBy: platformAdmin.adminId,
      },
      expiresInSeconds
    );

    res.json({
      success: true,
      data: {
        tenant_slug: target.slug,
        impersonated_by: platformAdmin.email,
        access_token: supportToken,
        expires_in: expiresInSeconds,
        expires_in_seconds: expiresInSeconds,
        duration_minutes: durationMinutes,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'IMPERSONATION_FAILED', err?.message || 'Không thể tạo token hỗ trợ.');
  }
});

// ============================================================================
// Billing Catalog, Step Plans, Topup Approval & CRM/ERP Upgrade Governance
// ============================================================================
adminRouter.get('/billing-catalog', requirePlatformSuperAdmin, async (_req, res) => {
  try {
    const catalog = await getPlatformBillingCatalog();
    res.json({ success: true, data: catalog });
  } catch (err: any) {
    sendApiError(res, 500, 'ADMIN_BILLING_CATALOG_FAILED', err?.message || 'Không thể tải cấu hình gói cước nền tảng.');
  }
});

adminRouter.patch('/billing-catalog', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const { catalog, reset_to_factory } = req.body || {};
    const saved = await withSystemPrivilege(async (client) => {
      const cur = await client.query<{ setting_value: Record<string, unknown> }>(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'billing_catalog' LIMIT 1"
      );

      const rawPatch =
        catalog && typeof catalog === 'object' ? (catalog as Record<string, unknown>) : (req.body as Record<string, unknown>) || {};
      const curVal = cur.rows[0]?.setting_value || {};

      // If base_monthly_price_vnd or annual_discount_pct changed without explicit plans/topup_packages array,
      // drop stale cached plans/topup_packages so normalizeBillingCatalog recalculates default tiers dynamically.
      const priceOrDiscountChanged =
        rawPatch.base_monthly_price_vnd !== undefined || rawPatch.annual_discount_pct !== undefined;
      const mergedInput: Record<string, unknown> = reset_to_factory
        ? {}
        : {
            ...curVal,
            ...rawPatch,
          };
      if (priceOrDiscountChanged && !Array.isArray(rawPatch.plans)) {
        delete mergedInput.plans;
      }
      if (priceOrDiscountChanged && !Array.isArray(rawPatch.topup_packages)) {
        delete mergedInput.topup_packages;
      }

      const normalized = reset_to_factory
        ? normalizeBillingCatalog(DEFAULT_BILLING_CATALOG as unknown as Record<string, unknown>)
        : normalizeBillingCatalog(mergedInput);

      const r = await client.query<{ setting_value: Record<string, unknown>; updated_at: string }>(
        `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
         VALUES ('billing_catalog', $1::jsonb, clock_timestamp())
         ON CONFLICT (setting_key) DO UPDATE SET
           setting_value = EXCLUDED.setting_value,
           updated_at = clock_timestamp()
         RETURNING setting_value, updated_at`,
        [JSON.stringify(normalized)]
      );

      // Keep default_tenant_settings trial/price fields synchronized
      const defCur = await client.query<{ setting_value: Record<string, unknown> }>(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'default_tenant_settings' LIMIT 1"
      );
      const syncedDef = normalizeTenantSettings(
        {
          ...(defCur.rows[0]?.setting_value || {}),
          trial_duration_months: normalized.trial_duration_months,
          trial_duration_days: normalized.trial_duration_days,
          trial_warning_days: normalized.trial_warning_days,
          base_monthly_price_vnd: normalized.base_monthly_price_vnd,
          annual_discount_pct: normalized.annual_discount_pct,
          crm_upgrade_url: normalized.crm_upgrade_url,
          erp_upgrade_url: normalized.erp_upgrade_url,
        },
        DEFAULT_TENANT_SETTINGS
      );
      await client.query(
        `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
         VALUES ('default_tenant_settings', $1::jsonb, clock_timestamp())
         ON CONFLICT (setting_key) DO UPDATE SET
           setting_value = EXCLUDED.setting_value,
           updated_at = clock_timestamp()`,
        [JSON.stringify(syncedDef)]
      );

      tenantRedis.invalidatePlatformDefaultsCache();
      tenantRedis.setCachedPlatformDefaults(syncedDef as unknown as Record<string, unknown>);
      invalidateBillingCatalogCache();

      return {
        catalog: normalized,
        updated_at: r.rows[0].updated_at,
      };
    });

    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'ADMIN_BILLING_SAVE_FAILED', err?.message || 'Không thể lưu cấu hình gói cước nền tảng.');
  }
});

// List all Tenant Billing / Topup / Step Upgrade / CRM-ERP Requests across Platform
adminRouter.get('/billing/requests', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const statusFilter = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
    const data = await withSystemPrivilege(async (client) => {
      const params: unknown[] = [];
      let where = '1 = 1';
      if (statusFilter && ['pending', 'approved', 'completed', 'rejected'].includes(statusFilter)) {
        params.push(statusFilter);
        where += ` AND b.status = $1`;
      }
      const r = await client.query(
        `SELECT
           b.id, b.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name,
           b.tx_type, b.plan_code, b.billing_cycle, b.months_added,
           b.amount_vnd, b.discount_pct, b.payment_method, b.status,
           b.reference_code, b.note, b.metadata, b.processed_by, b.processed_at, b.created_at
         FROM tenant_billing_transactions b
         INNER JOIN tenants t ON t.id = b.tenant_id
         WHERE ${where}
         ORDER BY (CASE WHEN b.status = 'pending' THEN 0 ELSE 1 END) ASC, b.created_at DESC
         LIMIT 200`,
        params
      );
      return r.rows.map((row) => ({
        ...row,
        amount_vnd: Number(row.amount_vnd || 0),
        discount_pct: Number(row.discount_pct || 0),
      }));
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'ADMIN_LIST_BILLING_FAILED', err?.message || 'Không thể tải danh sách yêu cầu thanh toán.');
  }
});

// Approve or Reject a Pending Topup / Subscription / CRM-ERP Request
adminRouter.post('/billing/requests/:txId/resolve', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const platformAdmin = getPlatformContext();
    const txId = req.params.txId;
    const { decision, resolution_note } = req.body || {};
    if (decision !== 'approve' && decision !== 'reject') {
      sendApiError(res, 422, 'INVALID_DECISION', "Trường decision phải là 'approve' hoặc 'reject'.");
      return;
    }

    const catalog = await getPlatformBillingCatalog();

    const resolved = await withSystemPrivilege(async (client) => {
      const txLookup = await client.query(
        `SELECT b.*, t.slug AS tenant_slug, t.trial_ends_at, t.subscription_expires_at, t.plan_tier
         FROM tenant_billing_transactions b
         INNER JOIN tenants t ON t.id = b.tenant_id
         WHERE b.id = $1
         FOR UPDATE`,
        [txId]
      );
      const tx = txLookup.rows[0];
      if (!tx) return { notFound: true as const };
      if (tx.status !== 'pending') {
        return { alreadyProcessed: true as const, currentStatus: tx.status };
      }

      if (decision === 'reject') {
        const rejRes = await client.query(
          `UPDATE tenant_billing_transactions
           SET status = 'rejected',
               note = CASE WHEN $2::text IS NOT NULL THEN COALESCE(note, '') || ' | ' || $2::text ELSE note END,
               processed_by = $3,
               processed_at = clock_timestamp()
           WHERE id = $1
           RETURNING *`,
          [txId, resolution_note ? String(resolution_note).trim() : null, platformAdmin.email]
        );
        const contact = await fetchTenantPrimaryAdminContact(client, tx.tenant_id);
        return {
          ok: true as const,
          decision: 'reject' as const,
          tx: rejRes.rows[0],
          tenantId: tx.tenant_id,
          tenantSlug: tx.tenant_slug,
          contact,
          nextWalletBalance: undefined,
          nextExpiresAt: undefined,
        };
      }

      // Approve logic by tx_type
      const amountVnd = Number(tx.amount_vnd || 0);
      const bonusVnd = Number(tx.metadata?.bonus_vnd || 0);
      let nextWalletBalance: number | undefined;
      let nextExpiresAt: string | undefined;

      if (tx.tx_type === 'topup') {
        const creditTotal = Math.max(0, amountVnd) + Math.max(0, bonusVnd);
        const wUpd = await client.query<{ wallet_balance_vnd: string | number }>(
          `UPDATE tenants
           SET wallet_balance_vnd = wallet_balance_vnd + $2,
               updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING wallet_balance_vnd`,
          [tx.tenant_id, creditTotal]
        );
        nextWalletBalance = Number(wUpd.rows[0]?.wallet_balance_vnd || 0);
      } else if (
        tx.tx_type === 'subscription_purchase' ||
        tx.tx_type === 'renewal' ||
        tx.tx_type === 'plan_upgrade' ||
        tx.tx_type === 'plan_switch' ||
        tx.tx_type === 'package_switch' ||
        tx.tx_type === 'reactivation' ||
        tx.tx_type === 'crm_erp_upgrade'
      ) {
        const cycle: 'monthly' | 'annual' = tx.billing_cycle === 'annual' ? 'annual' : 'monthly';
        const months = Math.max(1, Number(tx.months_added || (cycle === 'annual' ? 12 : 1)));
        const txMeta = tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
        const nextUpgradeStatus =
          tx.tx_type === 'crm_erp_upgrade'
            ? `active_${String(txMeta.target_suite || 'crm_erp_bundle')}`
            : undefined;
        const activatedTenant = await applySubscriptionActivationInTx(client, {
          tenantId: tx.tenant_id,
          planCode: String(tx.plan_code || (tx.tx_type === 'crm_erp_upgrade' ? 'domation_crm_erp' : 'autodata_standard')),
          billingCycle: cycle,
          monthsAdded: months,
          useCurrentTimeBase: Boolean(txMeta.use_current_time_base),
          targetUpgradeStatus: nextUpgradeStatus,
          catalog,
        });
        nextExpiresAt = activatedTenant.subscription_expires_at
          ? new Date(activatedTenant.subscription_expires_at).toISOString()
          : undefined;
      }

      const existingMeta = tx.metadata && typeof tx.metadata === 'object' ? tx.metadata : {};
      const mergedTxMeta = { ...existingMeta, approved_bonus_vnd: bonusVnd };
      const appRes = await client.query(
        `UPDATE tenant_billing_transactions
         SET status = 'approved',
             note = CASE WHEN $2::text IS NOT NULL THEN COALESCE(note, '') || ' | ' || $2::text ELSE note END,
             metadata = $3::jsonb,
             processed_by = $4,
             processed_at = clock_timestamp()
         WHERE id = $1
         RETURNING *`,
        [
          txId,
          resolution_note ? String(resolution_note).trim() : null,
          JSON.stringify(mergedTxMeta),
          platformAdmin.email,
        ]
      );
      const contact = await fetchTenantPrimaryAdminContact(client, tx.tenant_id);

      return {
        ok: true as const,
        decision: 'approve' as const,
        tx: appRes.rows[0],
        tenantId: tx.tenant_id,
        tenantSlug: tx.tenant_slug,
        contact,
        nextWalletBalance,
        nextExpiresAt,
      };
    });

    if ('notFound' in resolved) {
      sendApiError(res, 404, 'BILLING_TX_NOT_FOUND', 'Không tìm thấy giao dịch cần duyệt.');
      return;
    }
    if ('alreadyProcessed' in resolved) {
      sendApiError(res, 409, 'BILLING_TX_ALREADY_PROCESSED', `Giao dịch này đã được xử lý (${resolved.currentStatus}).`);
      return;
    }

    tenantRedis.invalidateTenantCache(resolved.tenantId, resolved.tenantSlug);
    await tenantRedis.del('meta:tenant_status', resolved.tenantId);

    let eventType: PlatformBillingEventType;
    if (resolved.decision === 'reject') {
      eventType = 'topup_rejected';
    } else if (resolved.tx.tx_type === 'topup') {
      eventType = 'topup_approved';
    } else if (resolved.tx.tx_type === 'crm_erp_upgrade') {
      eventType = 'crm_erp_upgrade_approved';
    } else if (resolved.tx.tx_type === 'plan_upgrade') {
      eventType = 'plan_upgraded';
    } else if (resolved.tx.tx_type === 'renewal') {
      eventType = 'subscription_renewed';
    } else {
      eventType = 'subscription_activated';
    }

    void notifyPlatformBillingEvent({
      event_type: eventType,
      reference_code: resolved.tx.reference_code || txId,
      status: resolved.tx.status,
      tenant_id: resolved.tenantId,
      tenant_slug: resolved.contact.tenantSlug || resolved.tenantSlug,
      tenant_name: resolved.contact.tenantName,
      admin_name: resolved.contact.adminName,
      email: resolved.contact.adminEmail,
      phone: resolved.contact.adminPhone,
      plan_code: resolved.tx.plan_code,
      billing_cycle: resolved.tx.billing_cycle,
      months_added: Number(resolved.tx.months_added || 0),
      amount_vnd: Number(resolved.tx.amount_vnd || 0),
      bonus_vnd: Number(resolved.tx.metadata?.bonus_vnd || 0),
      discount_pct: Number(resolved.tx.discount_pct || 0),
      wallet_balance_vnd: resolved.nextWalletBalance,
      payment_method: resolved.tx.payment_method,
      effective_expires_at: resolved.nextExpiresAt || undefined,
      processed_by: platformAdmin.email,
      note: resolved.tx.note,
    }).catch(() => {});

    res.json({
      success: true,
      data: {
        ...resolved.tx,
        amount_vnd: Number(resolved.tx.amount_vnd || 0),
        discount_pct: Number(resolved.tx.discount_pct || 0),
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'ADMIN_RESOLVE_BILLING_FAILED', err?.message || 'Không thể duyệt giao dịch.');
  }
});

// Direct Super Admin Grant: Add Topup Balance, Extend Months/Days, or Upgrade Plan / CRM-ERP for a Tenant
adminRouter.post('/tenants/:id/billing-grant', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const platformAdmin = getPlatformContext();
    const tenantId = req.params.id;
    const {
      topup_amount_vnd = 0,
      extend_months = 0,
      extend_days = 0,
      plan_code,
      crm_erp_upgrade_status,
      note,
    } = req.body || {};

    const catalog = await getPlatformBillingCatalog();
    const cleanTopup = Math.round(Number(topup_amount_vnd) || 0);
    const cleanMonths = Math.max(0, Math.round(Number(extend_months) || 0));
    const cleanDays = Math.max(0, Math.round(Number(extend_days) || 0));
    const totalAddedDays = (cleanMonths === 12 ? 365 : cleanMonths * 30) + cleanDays;

    const updated = await withSystemPrivilege(async (client) => {
      const curRes = await client.query<Record<string, any>>(
        'SELECT * FROM tenants WHERE id = $1 FOR UPDATE',
        [tenantId]
      );
      const cur = curRes.rows[0];
      if (!cur) return null;

      const resolvedPlanId = plan_code ? resolveCanonicalBillingIdentity(plan_code) : null;
      const matchedPlan =
        (plan_code ? catalog.plans.find((p) => p.code === String(plan_code)) : undefined) ||
        (resolvedPlanId ? catalog.plans.find((p) => p.code === resolvedPlanId.plan_code) : undefined);

      const nextPlanCode = matchedPlan
        ? matchedPlan.code
        : plan_code
          ? String(plan_code)
          : cur.subscription_plan_code;
      const nextPlanTier = matchedPlan
        ? matchedPlan.plan_tier
        : resolvedPlanId
          ? resolvedPlanId.legacy_tier
          : cur.plan_tier;

      let nextPackageCode = cur.package_code;
      let nextModulesJson: string | null = null;
      let nextEntitlementsJson: string | null = null;
      const targetPkgId =
        resolvedPlanId ||
        (crm_erp_upgrade_status && String(crm_erp_upgrade_status).startsWith('active_erp')
          ? resolveCanonicalBillingIdentity('domation_promax')
          : null);
      if (targetPkgId) {
        const pkgDef = SAAS_PACKAGES_CATALOG[targetPkgId.package_code];
        const curEnt = cur.entitlements && typeof cur.entitlements === 'object' ? cur.entitlements : {};
        const eduAddon = Boolean(curEnt.education_addon);
        nextPackageCode = targetPkgId.package_code;
        nextModulesJson = JSON.stringify(buildModulesForPackage(targetPkgId.package_code, { educationAddon: eduAddon }));
        nextEntitlementsJson = JSON.stringify({
          ...curEnt,
          package_code: targetPkgId.package_code,
          package_name: pkgDef.name,
          package_badge: pkgDef.badge,
          tour_suite: pkgDef.tour_suite,
          connect_wizard_suite: pkgDef.connect_wizard_suite,
          ai_capabilities: pkgDef.ai_capabilities,
        });
      }

      let nextSubExpires = cur.subscription_expires_at;
      if (totalAddedDays > 0) {
        const baseMs = Math.max(
          Date.now(),
          cur.trial_ends_at ? new Date(cur.trial_ends_at).getTime() : 0,
          cur.subscription_expires_at ? new Date(cur.subscription_expires_at).getTime() : 0
        );
        nextSubExpires = new Date(baseMs + totalAddedDays * 86_400_000).toISOString();
      }

      const nextCycle =
        cleanMonths === 12 ? 'annual' : cleanMonths > 0 ? 'monthly' : cur.billing_cycle;
      const shouldReactivate = Boolean(totalAddedDays > 0 || plan_code || crm_erp_upgrade_status);

      const updRes = await client.query(
        `UPDATE tenants
         SET wallet_balance_vnd = GREATEST(0, wallet_balance_vnd + $2),
             subscription_expires_at = $3::timestamptz,
             subscription_plan_code = $4,
             plan_tier = $5,
             package_code = COALESCE($8, package_code),
             enabled_modules = COALESCE($9::jsonb, enabled_modules),
             entitlements = COALESCE($10::jsonb, entitlements),
             billing_cycle = $6,
             crm_erp_upgrade_status = COALESCE($7, crm_erp_upgrade_status),
             status = CASE WHEN $11::boolean AND status IN ('trial', 'grace', 'suspended', 'cancelled') THEN 'active' ELSE status END,
             grace_ends_at = CASE WHEN $11::boolean THEN NULL ELSE grace_ends_at END,
             cancel_at_period_end = CASE WHEN $11::boolean THEN false ELSE cancel_at_period_end END,
             cancelled_at = CASE WHEN $11::boolean THEN NULL ELSE cancelled_at END,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING *`,
        [
          tenantId,
          cleanTopup,
          nextSubExpires,
          nextPlanCode,
          nextPlanTier,
          nextCycle,
          crm_erp_upgrade_status ? String(crm_erp_upgrade_status) : null,
          nextPackageCode,
          nextModulesJson,
          nextEntitlementsJson,
          shouldReactivate,
        ]
      );

      const refCode = generateBillingReferenceCode('DOMGRANT', 'ADMIN', cur.slug);
      const grantNote = note
        ? String(note).trim()
        : `Admin cấp phát trực tiếp (+${cleanTopup.toLocaleString('vi-VN')}₫ ví, +${totalAddedDays} ngày)`;
      await client.query(
        `INSERT INTO tenant_billing_transactions (
           tenant_id, tx_type, plan_code, billing_cycle, months_added,
           amount_vnd, discount_pct, payment_method, provider, status, reference_code,
           note, metadata, processed_by, processed_at
         ) VALUES ($1, 'admin_grant', $2, $3, $4, $5, 0, 'admin_grant', 'manual_bank_transfer', 'completed', $6, $7, $8::jsonb, $9, clock_timestamp())`,
        [
          tenantId,
          nextPlanCode,
          nextCycle,
          cleanMonths,
          Math.max(0, cleanTopup),
          refCode,
          grantNote,
          JSON.stringify({ extend_days: cleanDays, extend_months: cleanMonths }),
          platformAdmin.email,
        ]
      );
      const contact = await fetchTenantPrimaryAdminContact(client, tenantId);

      return { row: updRes.rows[0], contact, refCode, grantNote };
    });

    if (!updated) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy tổ chức.');
      return;
    }

    tenantRedis.invalidateTenantCache(tenantId, updated.row.slug);
    await tenantRedis.del('meta:tenant_status', tenantId);
    const snap = computeSubscriptionSnapshot(updated.row, catalog);

    void notifyPlatformBillingEvent({
      event_type: 'admin_grant',
      reference_code: updated.refCode,
      status: 'completed',
      tenant_id: tenantId,
      tenant_slug: updated.contact.tenantSlug || updated.row.slug,
      tenant_name: updated.contact.tenantName || updated.row.name,
      admin_name: updated.contact.adminName,
      email: updated.contact.adminEmail,
      phone: updated.contact.adminPhone,
      plan_code: updated.row.subscription_plan_code,
      billing_cycle: updated.row.billing_cycle,
      months_added: cleanMonths,
      added_days: totalAddedDays,
      amount_vnd: Math.max(0, cleanTopup),
      wallet_balance_vnd: snap.wallet_balance_vnd,
      payment_method: 'admin_grant',
      effective_expires_at: snap.effective_expires_at,
      processed_by: platformAdmin.email,
      note: updated.grantNote,
    }).catch(() => {});

    res.json({
      success: true,
      data: {
        ...updated.row,
        wallet_balance_vnd: Number(updated.row.wallet_balance_vnd || 0),
        subscription: snap,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'ADMIN_BILLING_GRANT_FAILED', err?.message || 'Không thể cấp phát gói cước / Topup.');
  }
});

// Master DOMATION Google Sheet & Apps Script Hub Governance
adminRouter.get('/master-appscript', requirePlatformSuperAdmin, async (_req, res) => {
  try {
    const cfg = await getMasterAppscriptConfig();
    res.json({
      success: true,
      data: {
        ...cfg,
        secret: cfg.secret ? `${'*'.repeat(Math.min(12, cfg.secret.length))} (đã cấu hình)` : '',
        has_secret: Boolean(cfg.secret),
        spreadsheet_url: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheet_id}/edit`,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'MASTER_APPSCRIPT_READ_FAILED', err?.message || 'Không thể đọc cấu hình Master Apps Script.');
  }
});

adminRouter.put('/master-appscript', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const {
      enabled,
      webhook_url,
      secret,
      spreadsheet_id,
      admin_notify_email,
      send_customer_emails,
      send_admin_emails,
    } = req.body || {};

    if (webhook_url !== undefined && String(webhook_url).trim() && !isValidAppscriptWebhookUrl(String(webhook_url))) {
      sendApiError(
        res,
        422,
        'INVALID_APPSCRIPT_URL',
        'URL Google Apps Script Web App phải có dạng https://script.google.com/macros/s/.../exec'
      );
      return;
    }

    const saved = await saveMasterAppscriptConfig({
      ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
      ...(webhook_url !== undefined ? { webhook_url: String(webhook_url).trim() } : {}),
      ...(secret !== undefined && !String(secret).includes('*') ? { secret: String(secret).trim() } : {}),
      ...(spreadsheet_id !== undefined ? { spreadsheet_id: String(spreadsheet_id).trim() } : {}),
      ...(admin_notify_email !== undefined ? { admin_notify_email: String(admin_notify_email).trim() } : {}),
      ...(send_customer_emails !== undefined ? { send_customer_emails: Boolean(send_customer_emails) } : {}),
      ...(send_admin_emails !== undefined ? { send_admin_emails: Boolean(send_admin_emails) } : {}),
    });

    res.json({
      success: true,
      data: {
        ...saved,
        secret: saved.secret ? `${'*'.repeat(Math.min(12, saved.secret.length))} (đã cấu hình)` : '',
        has_secret: Boolean(saved.secret),
        spreadsheet_url: `https://docs.google.com/spreadsheets/d/${saved.spreadsheet_id}/edit`,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'MASTER_APPSCRIPT_SAVE_FAILED', err?.message || 'Không thể lưu cấu hình Master Apps Script.');
  }
});

adminRouter.post('/master-appscript/test', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const platformAdmin = getPlatformContext();
    const cfg = await getMasterAppscriptConfig();
    const to = String(req.body?.to || cfg.admin_notify_email || platformAdmin.email || '').trim();
    const result = await dispatchPlatformAppscriptEvent({
      event_type: 'test_connection',
      to,
      email: to,
    });
    if (!result.success && !result.skippedReason) {
      sendApiError(res, 502, 'MASTER_APPSCRIPT_TEST_FAILED', result.error || 'Không thể kết nối Master Apps Script.');
      return;
    }
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'MASTER_APPSCRIPT_TEST_ERROR', err?.message || 'Lỗi kiểm tra Master Apps Script.');
  }
});

adminRouter.get('/consultations', requirePlatformSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await withSystemPrivilege(async (client) => {
      const r = await client.query(
        `SELECT id, lead_code, source_form, page_path, page_url, name, email, phone,
                company, service, budget_or_scale, message, utm_source, utm_medium, utm_campaign,
                appscript_status, created_at
         FROM platform_consultations
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items: rows } });
  } catch (err: any) {
    sendApiError(res, 500, 'ADMIN_CONSULTATIONS_FAILED', err?.message || 'Không thể tải danh sách form tư vấn.');
  }
});
