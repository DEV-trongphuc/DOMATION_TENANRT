import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { requireTenantAuth, requirePermission, sendApiError } from '../core/security/rbac.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  getPlatformBillingCatalog,
  computeSubscriptionSnapshot,
  switchTenantSaasPackageInTx,
} from '../services/billing.service.ts';
import {
  SAAS_PACKAGES_CATALOG,
  resolveTenantEntitlementSnapshot,
} from '../core/security/entitlements.ts';
import {
  fetchTenantPrimaryAdminContact,
  notifyPlatformBillingEvent,
} from '../services/platform-appscript.service.ts';

export const billingRouter = Router();

function buildRefCode(prefix: string, kind: string, slug: string): string {
  const cleanPrefix = (prefix || 'DOMDATA').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10);
  const cleanSlug = slug.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 10) || 'TENANT';
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${cleanPrefix}-${kind}-${cleanSlug}-${rand}`;
}

// Public endpoint: Dynamic Billing Catalog (1-month trial, 1.5M/month default, -15% annual, Step plans, Topup, CRM/ERP)
billingRouter.get('/catalog', async (_req, res) => {
  try {
    const catalog = await getPlatformBillingCatalog();
    res.json({ success: true, data: catalog });
  } catch (err: any) {
    sendApiError(res, 500, 'BILLING_CATALOG_FAILED', err?.message || 'Không thể tải danh mục gói cước.');
  }
});

// Public endpoint: Landing Page Bootstrap (Catalog + Google OAuth Config)
billingRouter.get('/bootstrap-public', async (_req, res) => {
  try {
    const catalog = await getPlatformBillingCatalog();
    const googleClientId = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim() || null;
    res.json({
      success: true,
      data: {
        catalog,
        google_oauth: {
          enabled: Boolean(googleClientId),
          client_id: googleClientId,
        },
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'BOOTSTRAP_PUBLIC_FAILED', err?.message || 'Không thể khởi tạo danh mục công khai.');
  }
});

// Authenticated Tenant Billing Overview (RLS-isolated)
billingRouter.get('/overview', requireTenantAuth, async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const catalog = await getPlatformBillingCatalog();

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tenantRes, txRes] = await Promise.all([
        client.query(
          `SELECT id, slug, name, industry, industry_key, package_code, plan_tier,
                  enabled_modules, entitlements, settings, status, created_at,
                  trial_ends_at, subscription_expires_at, subscription_plan_code,
                  billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status
           FROM tenants
           WHERE id = $1
           LIMIT 1`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, tx_type, plan_code, billing_cycle, months_added, amount_vnd,
                  discount_pct, payment_method, status, reference_code, note,
                  metadata, processed_by, processed_at, created_at
           FROM tenant_billing_transactions
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 50`,
          [ctx.tenantId]
        ),
      ]);

      const tRow = tenantRes.rows[0] || {};
      const subscription = computeSubscriptionSnapshot(tRow, catalog);
      const entSnap = resolveTenantEntitlementSnapshot(tRow);

      return {
        subscription,
        package_code: entSnap.package_code,
        package_info: entSnap.package_info,
        enabled_modules: entSnap.enabled_modules,
        entitlements: entSnap.entitlements,
        industry_key: entSnap.industry_key,
        terminology: entSnap.terminology,
        packages_catalog: SAAS_PACKAGES_CATALOG,
        catalog,
        transactions: txRes.rows.map((r) => ({
          ...r,
          amount_vnd: Number(r.amount_vnd || 0),
          discount_pct: Number(r.discount_pct || 0),
        })),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'BILLING_OVERVIEW_FAILED', err?.message || 'Không thể tải thông tin gói cước & ví Topup.');
  }
});

// Create Wallet Topup Order (Tenant Admin)
billingRouter.post('/topup', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const catalog = await getPlatformBillingCatalog();
    const { package_id, amount_vnd, note } = req.body || {};

    let resolvedAmount = Number(amount_vnd || 0);
    let bonusVnd = 0;
    let pkgLabel = '';

    if (package_id) {
      const matchedPkg = catalog.topup_packages.find((p) => p.id === String(package_id));
      if (!matchedPkg) {
        sendApiError(res, 422, 'INVALID_TOPUP_PACKAGE', 'Gói nạp Topup không tồn tại trong cấu hình hệ thống.');
        return;
      }
      resolvedAmount = matchedPkg.amount_vnd;
      bonusVnd = matchedPkg.bonus_vnd;
      pkgLabel = matchedPkg.label;
    }

    if (!Number.isFinite(resolvedAmount) || resolvedAmount < catalog.min_topup_vnd) {
      sendApiError(
        res,
        422,
        'INVALID_TOPUP_AMOUNT',
        `Số tiền nạp Topup tối thiểu là ${catalog.min_topup_vnd.toLocaleString('vi-VN')} ${catalog.currency}.`
      );
      return;
    }

    const cleanAmount = Math.round(resolvedAmount);
    const refCode = buildRefCode(catalog.payment_bank_info.transfer_prefix, 'TOPUP', ctx.tenantSlug);

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO tenant_billing_transactions (
           tenant_id, tx_type, plan_code, billing_cycle, months_added,
           amount_vnd, discount_pct, payment_method, status, reference_code,
           note, metadata, requested_by
         ) VALUES ($1, 'topup', NULL, 'topup', 0, $2, 0, 'bank_transfer', 'pending', $3, $4, $5::jsonb, $6)
         RETURNING *`,
        [
          ctx.tenantId,
          cleanAmount,
          refCode,
          note ? String(note).trim() : pkgLabel || `Nạp ví Topup ${cleanAmount.toLocaleString('vi-VN')}₫`,
          JSON.stringify({ package_id: package_id || null, bonus_vnd: bonusVnd }),
          ctx.userId,
        ]
      );
      const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
      return { tx: r.rows[0], contact };
    });
    const tx = result.tx;

    void notifyPlatformBillingEvent({
      event_type: 'topup_requested',
      reference_code: refCode,
      status: 'pending',
      tenant_id: ctx.tenantId,
      tenant_slug: result.contact.tenantSlug || ctx.tenantSlug,
      tenant_name: result.contact.tenantName,
      admin_name: result.contact.adminName,
      email: result.contact.adminEmail,
      phone: result.contact.adminPhone,
      billing_cycle: 'topup',
      amount_vnd: cleanAmount,
      bonus_vnd: bonusVnd,
      payment_method: 'bank_transfer',
      note: tx.note,
    }).catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        transaction: {
          ...tx,
          amount_vnd: Number(tx.amount_vnd || 0),
        },
        payment_bank_info: catalog.payment_bank_info,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'TOPUP_CREATE_FAILED', err?.message || 'Không thể tạo lệnh nạp Topup.');
  }
});

// Subscribe / Renew / Step Upgrade Plan (via instant Wallet Balance or Bank Transfer Request)
billingRouter.post('/subscribe', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const catalog = await getPlatformBillingCatalog();
    const {
      plan_code,
      billing_cycle = 'monthly',
      months = 1,
      payment_method = 'bank_transfer',
      note,
    } = req.body || {};

    const cleanCode = String(plan_code || '').trim().toLowerCase();
    const targetPlan = catalog.plans.find((p) => p.code === cleanCode);
    if (!targetPlan) {
      sendApiError(res, 422, 'INVALID_PLAN_CODE', `Mã gói cước '${cleanCode}' không hợp lệ.`);
      return;
    }

    const cycle: 'monthly' | 'annual' = billing_cycle === 'annual' ? 'annual' : 'monthly';
    const monthsAdded = cycle === 'annual' ? 12 : Math.min(36, Math.max(1, Math.round(Number(months) || 1)));
    const discountPct = cycle === 'annual' ? targetPlan.annual_discount_pct : 0;
    const totalAmountVnd =
      cycle === 'annual'
        ? targetPlan.annual_total_vnd
        : Math.round(targetPlan.monthly_price_vnd * monthsAdded);

    const method: 'wallet' | 'bank_transfer' = payment_method === 'wallet' ? 'wallet' : 'bank_transfer';

    if (method === 'wallet') {
      const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
        const curRes = await client.query(
          `SELECT id, slug, plan_tier, created_at, trial_ends_at, subscription_expires_at,
                  subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status
           FROM tenants
           WHERE id = $1
           FOR UPDATE`,
          [ctx.tenantId]
        );
        const cur = curRes.rows[0];
        if (!cur) {
          return { notFound: true as const };
        }

        const walletBalance = Number(cur.wallet_balance_vnd || 0);
        if (walletBalance < totalAmountVnd) {
          return {
            insufficient: true as const,
            walletBalance,
            required: totalAmountVnd,
            shortfall: totalAmountVnd - walletBalance,
          };
        }

        const nowMs = Date.now();
        const trialEndsMs = cur.trial_ends_at ? new Date(cur.trial_ends_at).getTime() : 0;
        const paidEndsMs = cur.subscription_expires_at ? new Date(cur.subscription_expires_at).getTime() : 0;
        // Preserve remaining trial or active subscription days when renewing early
        const baseStartMs = Math.max(nowMs, trialEndsMs, paidEndsMs);
        const addedDays = cycle === 'annual' ? 365 : monthsAdded * 30;
        const nextExpiresIso = new Date(baseStartMs + addedDays * 86_400_000).toISOString();

        const curPlanObj = catalog.plans.find((p) => p.code === cur.subscription_plan_code);
        const txType =
          !cur.subscription_plan_code || cur.subscription_plan_code === 'trial_1m' || cur.subscription_plan_code === 'trial_3m'
            ? 'subscription_purchase'
            : curPlanObj && targetPlan.step_order > curPlanObj.step_order
              ? 'plan_upgrade'
              : 'renewal';

        const refCode = buildRefCode(catalog.payment_bank_info.transfer_prefix, 'WALLET', ctx.tenantSlug);

        const updTenant = await client.query(
          `UPDATE tenants
           SET wallet_balance_vnd = wallet_balance_vnd - $2,
               subscription_expires_at = $3::timestamptz,
               subscription_plan_code = $4,
               plan_tier = $5,
               billing_cycle = $6,
               updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING id, slug, plan_tier, created_at, trial_ends_at, subscription_expires_at,
                     subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status`,
          [ctx.tenantId, totalAmountVnd, nextExpiresIso, targetPlan.code, targetPlan.plan_tier, cycle]
        );

        const txRes = await client.query(
          `INSERT INTO tenant_billing_transactions (
             tenant_id, tx_type, plan_code, billing_cycle, months_added,
             amount_vnd, discount_pct, payment_method, status, reference_code,
             note, metadata, requested_by, processed_by, processed_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, 'wallet', 'completed', $8,
             $9, $10::jsonb, $11, 'auto_wallet_engine', clock_timestamp()
           )
           RETURNING *`,
          [
            ctx.tenantId,
            txType,
            targetPlan.code,
            cycle,
            monthsAdded,
            totalAmountVnd,
            discountPct,
            refCode,
            note
              ? String(note).trim()
              : `Gia hạn tự động từ Ví Topup: ${targetPlan.name} (${monthsAdded} tháng)`,
            JSON.stringify({ added_days: addedDays }),
            ctx.userId,
          ]
        );

        const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);

        return {
          ok: true as const,
          tenant: updTenant.rows[0],
          tx: txRes.rows[0],
          txType,
          addedDays,
          contact,
        };
      });

      if ('notFound' in outcome && outcome.notFound) {
        sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
        return;
      }
      if ('insufficient' in outcome && outcome.insufficient) {
        sendApiError(
          res,
          402,
          'INSUFFICIENT_WALLET_BALANCE',
          `Số dư ví Topup hiện tại (${outcome.walletBalance.toLocaleString('vi-VN')}₫) chưa đủ thanh toán ${outcome.required.toLocaleString('vi-VN')}₫. Vui lòng nạp thêm tối thiểu ${outcome.shortfall.toLocaleString('vi-VN')}₫ hoặc chọn chuyển khoản.`
        );
        return;
      }
      if (!('ok' in outcome) || !outcome.ok) {
        sendApiError(res, 500, 'WALLET_RENEW_FAILED', 'Không thể hoàn tất thanh toán ví.');
        return;
      }

      tenantRedis.invalidateTenantCache(ctx.tenantId, ctx.tenantSlug);
      const subscription = computeSubscriptionSnapshot(outcome.tenant, catalog);

      const billingEventType =
        outcome.txType === 'plan_upgrade'
          ? 'plan_upgraded'
          : outcome.txType === 'renewal'
            ? 'subscription_renewed'
            : 'subscription_activated';
      void notifyPlatformBillingEvent({
        event_type: billingEventType,
        reference_code: outcome.tx.reference_code,
        status: 'completed',
        tenant_id: ctx.tenantId,
        tenant_slug: outcome.contact.tenantSlug || ctx.tenantSlug,
        tenant_name: outcome.contact.tenantName,
        admin_name: outcome.contact.adminName,
        email: outcome.contact.adminEmail,
        phone: outcome.contact.adminPhone,
        plan_code: targetPlan.code,
        plan_name: targetPlan.name,
        billing_cycle: cycle,
        months_added: monthsAdded,
        added_days: outcome.addedDays,
        amount_vnd: totalAmountVnd,
        discount_pct: discountPct,
        wallet_balance_vnd: subscription.wallet_balance_vnd,
        payment_method: 'wallet',
        effective_expires_at: subscription.effective_expires_at,
        note: outcome.tx.note,
      }).catch(() => {});

      res.status(200).json({
        success: true,
        data: {
          transaction: {
            ...outcome.tx,
            amount_vnd: Number(outcome.tx.amount_vnd || 0),
            discount_pct: Number(outcome.tx.discount_pct || 0),
          },
          subscription,
        },
      });
      return;
    }

    // Bank Transfer Order -> Pending Admin Approval
    const refCode = buildRefCode(catalog.payment_bank_info.transfer_prefix, 'PLAN', ctx.tenantSlug);
    const createdOutcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query<{ subscription_plan_code: string }>(
        'SELECT subscription_plan_code FROM tenants WHERE id = $1 LIMIT 1',
        [ctx.tenantId]
      );
      const curCode = curRes.rows[0]?.subscription_plan_code || 'trial_1m';
      const curPlanObj = catalog.plans.find((p) => p.code === curCode);
      const txType =
        curCode === 'trial_1m' || curCode === 'trial_3m'
          ? 'subscription_purchase'
          : curPlanObj && targetPlan.step_order > curPlanObj.step_order
            ? 'plan_upgrade'
            : 'renewal';

      const r = await client.query(
        `INSERT INTO tenant_billing_transactions (
           tenant_id, tx_type, plan_code, billing_cycle, months_added,
           amount_vnd, discount_pct, payment_method, status, reference_code,
           note, metadata, requested_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'bank_transfer', 'pending', $8, $9, $10::jsonb, $11)
         RETURNING *`,
        [
          ctx.tenantId,
          txType,
          targetPlan.code,
          cycle,
          monthsAdded,
          totalAmountVnd,
          discountPct,
          refCode,
          note
            ? String(note).trim()
            : `Đăng ký / Gia hạn ${targetPlan.name} (${cycle === 'annual' ? `12 tháng -${discountPct}%` : `${monthsAdded} tháng`})`,
          JSON.stringify({ plan_tier: targetPlan.plan_tier }),
          ctx.userId,
        ]
      );
      const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
      return { tx: r.rows[0], contact };
    });
    const created = createdOutcome.tx;

    void notifyPlatformBillingEvent({
      event_type: 'subscription_requested',
      reference_code: refCode,
      status: 'pending',
      tenant_id: ctx.tenantId,
      tenant_slug: createdOutcome.contact.tenantSlug || ctx.tenantSlug,
      tenant_name: createdOutcome.contact.tenantName,
      admin_name: createdOutcome.contact.adminName,
      email: createdOutcome.contact.adminEmail,
      phone: createdOutcome.contact.adminPhone,
      plan_code: targetPlan.code,
      plan_name: targetPlan.name,
      billing_cycle: cycle,
      months_added: monthsAdded,
      amount_vnd: totalAmountVnd,
      discount_pct: discountPct,
      payment_method: 'bank_transfer',
      note: created.note,
    }).catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        transaction: {
          ...created,
          amount_vnd: Number(created.amount_vnd || 0),
          discount_pct: Number(created.discount_pct || 0),
        },
        payment_bank_info: catalog.payment_bank_info,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'BILLING_SUBSCRIBE_FAILED', err?.message || 'Không thể xử lý yêu cầu nâng cấp / gia hạn gói.');
  }
});

// Request Seamless Ecosystem Upgrade to DOMATION CRM 360° or Enterprise ERP 5.0
billingRouter.post(
  ['/upgrade-crm-erp', '/upgrade-request'],
  requireTenantAuth,
  requirePermission('billing', 'manage_config'),
  async (req, res) => {
  try {
    const ctx = getTenantContext();
    const catalog = await getPlatformBillingCatalog();
    const {
      target_suite = 'crm_erp_bundle',
      billing_cycle = 'annual',
      contact_phone,
      note,
      keep_existing_data = true,
    } = req.body || {};

    const validSuites = ['crm', 'erp', 'crm_erp_bundle'] as const;
    const suite = validSuites.includes(target_suite) ? target_suite : 'crm_erp_bundle';
    const cycle: 'monthly' | 'annual' = billing_cycle === 'monthly' ? 'monthly' : 'annual';

    const enterprisePlan =
      catalog.plans.find((p) => p.is_enterprise_upgrade || p.plan_tier === 'enterprise') ||
      catalog.plans[catalog.plans.length - 1];
    const monthsAdded = cycle === 'annual' ? 12 : 1;
    const discountPct = cycle === 'annual' ? enterprisePlan.annual_discount_pct : 0;
    const estimatedAmount =
      cycle === 'annual' ? enterprisePlan.annual_total_vnd : enterprisePlan.monthly_price_vnd;

    const refCode = buildRefCode(catalog.payment_bank_info.transfer_prefix, suite.toUpperCase(), ctx.tenantSlug);
    const suiteLabel =
      suite === 'crm'
        ? 'DOMATION CRM 360°'
        : suite === 'erp'
          ? 'DOMATION Enterprise ERP 5.0'
          : 'Hệ Sinh Thái DOMATION CRM 360° + ERP 5.0';

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE tenants
         SET crm_erp_upgrade_status = $2,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [ctx.tenantId, `requested_${suite}`]
      );

      const txRes = await client.query(
        `INSERT INTO tenant_billing_transactions (
           tenant_id, tx_type, plan_code, billing_cycle, months_added,
           amount_vnd, discount_pct, payment_method, status, reference_code,
           note, metadata, requested_by
         ) VALUES ($1, 'crm_erp_upgrade', $2, $3, $4, $5, $6, 'bank_transfer', 'pending', $7, $8, $9::jsonb, $10)
         RETURNING *`,
        [
          ctx.tenantId,
          enterprisePlan.code,
          cycle,
          monthsAdded,
          estimatedAmount,
          discountPct,
          refCode,
          note ? String(note).trim() : `Yêu cầu nâng cấp lên ${suiteLabel} (Giữ nguyên dữ liệu Auto Data)`,
          JSON.stringify({
            target_suite: suite,
            keep_existing_data: Boolean(keep_existing_data),
            contact_phone: contact_phone ? String(contact_phone).trim() : null,
          }),
          ctx.userId,
        ]
      );
      const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
      return { tx: txRes.rows[0], contact };
    });

    void notifyPlatformBillingEvent({
      event_type: 'crm_erp_upgrade_requested',
      reference_code: refCode,
      status: 'pending',
      tenant_id: ctx.tenantId,
      tenant_slug: result.contact.tenantSlug || ctx.tenantSlug,
      tenant_name: result.contact.tenantName,
      admin_name: result.contact.adminName,
      email: result.contact.adminEmail,
      phone: contact_phone ? String(contact_phone).trim() : result.contact.adminPhone,
      plan_code: enterprisePlan.code,
      plan_name: enterprisePlan.name,
      target_suite_label: suiteLabel,
      billing_cycle: cycle,
      months_added: monthsAdded,
      amount_vnd: estimatedAmount,
      discount_pct: discountPct,
      payment_method: 'bank_transfer',
      note: result.tx.note,
    }).catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        transaction: {
          ...result.tx,
          amount_vnd: Number(result.tx.amount_vnd || 0),
          discount_pct: Number(result.tx.discount_pct || 0),
        },
        target_suite: suite,
        crm_upgrade_url: catalog.crm_upgrade_url,
        erp_upgrade_url: catalog.erp_upgrade_url,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CRM_ERP_UPGRADE_FAILED', err?.message || 'Không thể gửi yêu cầu nâng cấp CRM / ERP.');
  }
});


// 1-Click Instant Multi-Product SaaS Package Switch / Upgrade (0s Zero-Migration Unlock!)
billingRouter.post('/switch-package', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const targetCode = b.package_code || b.plan_tier || b.package;

    const switched = await withTenantTransaction(ctx.tenantId, (client) =>
      switchTenantSaasPackageInTx(client, ctx.tenantId, ctx.userId, {
        package_code: targetCode,
        education_addon: b.education_addon,
        industry_key: b.industry_key,
        note: b.note,
      })
    );

    tenantRedis.invalidateTenantCache(ctx.tenantId, switched.slug || ctx.tenantSlug);
    res.json({ success: true, data: switched });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INVALID_PACKAGE_CODE')) {
      sendApiError(res, 422, 'INVALID_PACKAGE_CODE', msg);
      return;
    }
    sendApiError(res, 500, 'SWITCH_PACKAGE_FAILED', msg || 'Không thể chuyển đổi gói sản phẩm.');
  }
});
