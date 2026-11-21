import { Router } from 'express';
import { withSystemPrivilege, withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { requireTenantAuth, requirePermission, sendApiError } from '../core/security/rbac.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  applySubscriptionActivationInTx,
  assertIdempotencyFingerprintMatches,
  computeBillingIdempotencyFingerprint,
  computeSubscriptionSnapshot,
  executePlanOrPackageChangeInTx,
  findTransactionByIdempotencyKey,
  generateBillingReferenceCode,
  getPlatformBillingCatalog,
  isIdempotencyUniqueViolation,
  switchTenantSaasPackageInTx,
} from '../services/billing.service.ts';
import {
  SAAS_PACKAGES_CATALOG,
  resolvePackageCodeFromTenant,
  resolveTenantEntitlementSnapshot,
} from '../core/security/entitlements.ts';
import {
  fetchTenantPrimaryAdminContact,
  notifyPlatformBillingEvent,
} from '../services/platform-appscript.service.ts';
import {
  createPaymentSession,
  getSupportedPaymentGateways,
  isSupportedPaymentProvider,
  normalizePaymentProvider,
  parseWebhookEvent,
  settleGatewayWebhookInTx,
  verifyWebhookSignature,
  type PaymentProvider,
} from '../services/payment-gateway.service.ts';

export const billingRouter = Router();

function extractIdempotencyKey(req: any): string | null {
  const fromHeader = req.header?.('X-Idempotency-Key') || req.headers?.['x-idempotency-key'];
  const fromBody = req.body?.idempotency_key;
  const raw = String(fromHeader || fromBody || '').trim();
  return raw ? raw.slice(0, 120) : null;
}

function handleBillingTransitionError(
  res: any,
  err: any,
  defaultCode: string,
  defaultMsg: string,
  invalidCodeOverride?: string
): boolean {
  const msg = String(err?.message || '');
  if (msg.startsWith('INVALID_PACKAGE_CODE') || msg.startsWith('INVALID_PLAN_CODE')) {
    sendApiError(res, 422, invalidCodeOverride || msg.split(':')[0], msg);
    return true;
  }
  if (msg.startsWith('DOWNGRADE_USAGE_EXCEEDED')) {
    sendApiError(res, 409, 'DOWNGRADE_USAGE_EXCEEDED', msg);
    return true;
  }
  if (msg.startsWith('IDEMPOTENCY_KEY_MISMATCH')) {
    sendApiError(res, 409, 'IDEMPOTENCY_KEY_MISMATCH', msg);
    return true;
  }
  if (msg.startsWith('INSUFFICIENT_WALLET_BALANCE')) {
    sendApiError(res, 402, 'INSUFFICIENT_WALLET_BALANCE', msg);
    return true;
  }
  if (msg === 'TENANT_NOT_FOUND') {
    sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
    return true;
  }
  sendApiError(res, 500, defaultCode, msg || defaultMsg);
  return true;
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
        supported_gateways: getSupportedPaymentGateways(),
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

// Public Payment Gateway Webhook Adapter (MUST be mounted BEFORE requireTenantAuth)
billingRouter.post('/webhooks/:provider', async (req: any, res) => {
  try {
    const rawProvider = String(req.params.provider || '').trim().toLowerCase();
    if (!isSupportedPaymentProvider(rawProvider)) {
      sendApiError(res, 400, 'UNSUPPORTED_GATEWAY_PROVIDER', `Cổng thanh toán '${rawProvider}' chưa được hỗ trợ.`);
      return;
    }
    const provider: PaymentProvider = normalizePaymentProvider(rawProvider);

    const sigCheck = verifyWebhookSignature(provider, {
      headers: req.headers || {},
      rawBody: req.rawBody,
      body: req.body || {},
      query: req.query || {},
    });
    if (!sigCheck.ok) {
      sendApiError(res, sigCheck.statusCode, sigCheck.code, sigCheck.message);
      return;
    }

    const event = parseWebhookEvent(provider, req.body || {}, req.query || {});
    if (!event.reference_code && !event.external_tx_id) {
      sendApiError(res, 422, 'INVALID_WEBHOOK_PAYLOAD', 'Thiếu reference_code hoặc external_tx_id trong payload webhook.');
      return;
    }

    const tenantLookup = await withSystemPrivilege(async (client) => {
      if (event.external_tx_id) {
        const byExt = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM tenant_billing_transactions
           WHERE provider = $1 AND external_tx_id = $2
           LIMIT 1`,
          [event.provider, event.external_tx_id]
        );
        if (byExt.rows[0]?.tenant_id) return byExt.rows[0].tenant_id;
      }
      if (event.reference_code) {
        const byRef = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM tenant_billing_transactions
           WHERE reference_code = $1
           LIMIT 1`,
          [event.reference_code]
        );
        if (byRef.rows[0]?.tenant_id) return byRef.rows[0].tenant_id;
      }
      return null;
    });

    if (!tenantLookup) {
      sendApiError(res, 404, 'BILLING_TX_NOT_FOUND', 'Không tìm thấy giao dịch tương ứng với webhook.');
      return;
    }

    const catalog = await getPlatformBillingCatalog();
    const settled = await withTenantTransaction(tenantLookup, async (client) => {
      return settleGatewayWebhookInTx(client, event, catalog, applySubscriptionActivationInTx);
    });

    if (settled.not_found) {
      sendApiError(res, 404, 'BILLING_TX_NOT_FOUND', 'Không tìm thấy giao dịch cần đối soát.');
      return;
    }
    if (settled.terminal_status) {
      sendApiError(
        res,
        409,
        'BILLING_TX_TERMINAL_STATUS',
        `Giao dịch ${settled.tx?.reference_code || ''} đã ở trạng thái '${settled.tx?.status}', không thể đối soát.`
      );
      return;
    }
    if (settled.amount_mismatch) {
      sendApiError(res, 422, 'WEBHOOK_AMOUNT_MISMATCH', 'Số tiền thanh toán không đủ để hoàn tất giao dịch.', [
        { field: 'amount_vnd', issue: `Số tiền không đủ cho giao dịch ${settled.tx?.reference_code || ''}` },
      ]);
      return;
    }

    if (settled.tenant?.slug) {
      tenantRedis.invalidateTenantCache(tenantLookup, settled.tenant.slug);
    }

    res.json({
      success: true,
      data: {
        provider,
        idempotent_replay: settled.already_settled,
        transaction: settled.tx
          ? {
              ...settled.tx,
              amount_vnd: Number(settled.tx.amount_vnd || 0),
            }
          : null,
        subscription: settled.tenant ? computeSubscriptionSnapshot(settled.tenant, catalog) : undefined,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'BILLING_WEBHOOK_FAILED', err?.message || 'Lỗi xử lý webhook thanh toán.');
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
                  trial_ends_at, subscription_expires_at, grace_ends_at,
                  auto_renew, cancel_at_period_end, cancelled_at,
                  scheduled_plan_code, scheduled_billing_cycle,
                  subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status
           FROM tenants
           WHERE id = $1
           LIMIT 1`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, tx_type, plan_code, billing_cycle, months_added, amount_vnd,
                  proration_credit_vnd, discount_pct, payment_method, provider,
                  external_tx_id, idempotency_key, status, reference_code, note,
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
        plan_tier: subscription.plan_tier,
        package_code: entSnap.package_code,
        billing_cycle: subscription.billing_cycle,
        status: subscription.status,
        auto_renew: subscription.auto_renew,
        cancel_at_period_end: subscription.cancel_at_period_end,
        cancelled_at: subscription.cancelled_at,
        grace_ends_at: subscription.grace_ends_at,
        subscription_expires_at: subscription.subscription_expires_at,
        subscription_ends_at: subscription.subscription_ends_at,
        scheduled_plan_code: subscription.scheduled_plan_code,
        scheduled_billing_cycle: subscription.scheduled_billing_cycle,
        wallet_balance_vnd: subscription.wallet_balance_vnd,
        limits: subscription.limits,
        payment_bank_info: catalog.payment_bank_info,
        supported_gateways: getSupportedPaymentGateways(),
        subscription,
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
          proration_credit_vnd: Number(r.proration_credit_vnd || 0),
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
    const { package_id, amount_vnd, note, provider: rawProvider, return_url, cancel_url } = req.body || {};
    const idempotencyKey = extractIdempotencyKey(req);
    const provider = normalizePaymentProvider(rawProvider);

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

    const maxTopupVnd = catalog.max_topup_vnd || 500_000_000;
    if (!Number.isFinite(resolvedAmount) || resolvedAmount < catalog.min_topup_vnd || resolvedAmount > maxTopupVnd) {
      sendApiError(
        res,
        422,
        'INVALID_TOPUP_AMOUNT',
        `Số tiền nạp Topup phải nằm trong khoảng ${catalog.min_topup_vnd.toLocaleString('vi-VN')} - ${maxTopupVnd.toLocaleString('vi-VN')} ${catalog.currency}.`
      );
      return;
    }

    const cleanAmount = Math.round(resolvedAmount);
    const topupFingerprint = computeBillingIdempotencyFingerprint({
      operation: 'topup',
      amount_vnd: cleanAmount,
      package_id: package_id ? String(package_id).trim() : null,
    });

    let result: { tx: Record<string, any>; contact: any; idempotentReplay: boolean };
    try {
      result = await withTenantTransaction(ctx.tenantId, async (client) => {
        if (idempotencyKey) {
          await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [ctx.tenantId]);
          const existingTx = await findTransactionByIdempotencyKey(client, ctx.tenantId, idempotencyKey);
          if (existingTx) {
            assertIdempotencyFingerprintMatches(existingTx, 'topup', topupFingerprint);
            if (Number(existingTx.amount_vnd || 0) !== cleanAmount) {
              throw new Error(
                'IDEMPOTENCY_KEY_MISMATCH: Idempotency key đã được sử dụng với số tiền nạp Topup khác.'
              );
            }
            const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
            return { tx: existingTx, contact, idempotentReplay: true };
          }
        }

        const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'TOPUP', ctx.tenantSlug);
        const r = await client.query(
          `INSERT INTO tenant_billing_transactions (
             tenant_id, tx_type, plan_code, billing_cycle, months_added,
             amount_vnd, proration_credit_vnd, discount_pct, payment_method, provider,
             idempotency_key, status, reference_code, note, metadata, requested_by
           ) VALUES ($1, 'topup', NULL, 'topup', 0, $2, 0, 0, $3, $4, $5, 'pending', $6, $7, $8::jsonb, $9)
           RETURNING *`,
          [
            ctx.tenantId,
            cleanAmount,
            provider === 'manual_bank_transfer' ? 'bank_transfer' : provider,
            provider,
            idempotencyKey,
            refCode,
            note ? String(note).trim() : pkgLabel || `Nạp ví Topup ${cleanAmount.toLocaleString('vi-VN')}₫`,
            JSON.stringify({
              package_id: package_id || null,
              bonus_vnd: bonusVnd,
              idempotency_fingerprint: topupFingerprint,
            }),
            ctx.userId,
          ]
        );
        const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
        return { tx: r.rows[0], contact, idempotentReplay: false };
      });
    } catch (txErr: any) {
      if (idempotencyKey && isIdempotencyUniqueViolation(txErr)) {
        const replayed = await withTenantTransaction(ctx.tenantId, async (client) => {
          const existingTx = await findTransactionByIdempotencyKey(client, ctx.tenantId, idempotencyKey);
          if (!existingTx) return null;
          assertIdempotencyFingerprintMatches(existingTx, 'topup', topupFingerprint);
          if (Number(existingTx.amount_vnd || 0) !== cleanAmount) {
            throw new Error(
              'IDEMPOTENCY_KEY_MISMATCH: Idempotency key đã được sử dụng với số tiền nạp Topup khác.'
            );
          }
          const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
          return { tx: existingTx, contact, idempotentReplay: true };
        });
        if (!replayed) throw txErr;
        result = replayed;
      } else {
        throw txErr;
      }
    }

    const tx = result.tx;
    const refCode = String(tx.reference_code || '');
    const gatewaySession = createPaymentSession({
      provider,
      referenceCode: refCode,
      amountVnd: Number(tx.amount_vnd || cleanAmount),
      description: `TOPUP ${refCode}`,
      bankInfo: catalog.payment_bank_info,
      returnUrl: typeof return_url === 'string' ? return_url : undefined,
      cancelUrl: typeof cancel_url === 'string' ? cancel_url : undefined,
    });

    if (!result.idempotentReplay) {
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
        payment_method: provider === 'manual_bank_transfer' ? 'bank_transfer' : provider,
        note: tx.note,
      }).catch(() => {});
    }

    res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      data: {
        idempotent_replay: result.idempotentReplay,
        transaction: {
          ...tx,
          amount_vnd: Number(tx.amount_vnd || 0),
        },
        payment_bank_info: catalog.payment_bank_info,
        gateway_session: gatewaySession,
      },
    });
  } catch (err: any) {
    handleBillingTransitionError(res, err, 'TOPUP_CREATE_FAILED', 'Không thể tạo lệnh nạp Topup.');
  }
});

// Subscribe / Renew / Step Upgrade Plan (via instant Wallet Balance, Bank Transfer or Gateway)
billingRouter.post('/subscribe', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const idempotencyKey = extractIdempotencyKey(req);

    let outcome: {
      transition: Awaited<ReturnType<typeof executePlanOrPackageChangeInTx>>;
      contact: Awaited<ReturnType<typeof fetchTenantPrimaryAdminContact>>;
    };
    try {
      outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
        const transition = await executePlanOrPackageChangeInTx(client, ctx.tenantId, ctx.userId, {
          target_code: b.plan_code || b.package_code || b.plan_tier,
          billing_cycle: b.billing_cycle || 'monthly',
          months: b.months || 1,
          payment_method: b.payment_method || 'bank_transfer',
          provider: b.provider,
          schedule_at_period_end: Boolean(b.schedule_at_period_end),
          idempotency_key: idempotencyKey,
          education_addon: b.education_addon,
          industry_key: b.industry_key,
          note: b.note,
          return_url: typeof b.return_url === 'string' ? b.return_url : undefined,
          cancel_url: typeof b.cancel_url === 'string' ? b.cancel_url : undefined,
          same_plan_early_renewal: true,
        });
        const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
        return { transition, contact };
      });
    } catch (txErr: any) {
      if (idempotencyKey && isIdempotencyUniqueViolation(txErr)) {
        outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
          const transition = await executePlanOrPackageChangeInTx(client, ctx.tenantId, ctx.userId, {
            target_code: b.plan_code || b.package_code || b.plan_tier,
            billing_cycle: b.billing_cycle || 'monthly',
            months: b.months || 1,
            payment_method: b.payment_method || 'bank_transfer',
            provider: b.provider,
            schedule_at_period_end: Boolean(b.schedule_at_period_end),
            idempotency_key: idempotencyKey,
            education_addon: b.education_addon,
            industry_key: b.industry_key,
            note: b.note,
            return_url: typeof b.return_url === 'string' ? b.return_url : undefined,
            cancel_url: typeof b.cancel_url === 'string' ? b.cancel_url : undefined,
            same_plan_early_renewal: true,
          });
          if (transition.kind !== 'idempotent_replay') throw txErr;
          const contact = await fetchTenantPrimaryAdminContact(client, ctx.tenantId);
          return { transition, contact };
        });
      } else {
        throw txErr;
      }
    }

    const { transition, contact } = outcome;
    const subscription = computeSubscriptionSnapshot(transition.tenant, transition.catalog);

    if (transition.kind === 'idempotent_replay') {
      res.status(200).json({
        success: true,
        data: {
          requires_payment: Boolean(transition.is_pending),
          idempotent_replay: true,
          transaction: {
            ...transition.tx,
            amount_vnd: Number(transition.tx.amount_vnd || 0),
            proration_credit_vnd: Number(transition.tx.proration_credit_vnd || 0),
            discount_pct: Number(transition.tx.discount_pct || 0),
          },
          subscription,
          payment_bank_info: transition.catalog.payment_bank_info,
          ...(transition.is_pending && transition.gateway_session ? { gateway_session: transition.gateway_session } : {}),
        },
      });
      return;
    }

    if (transition.kind === 'scheduled_downgrade') {
      res.status(200).json({
        success: true,
        data: {
          scheduled_downgrade: true,
          effective_at: transition.effective_at,
          transaction: {
            ...transition.tx,
            amount_vnd: Number(transition.tx.amount_vnd || 0),
          },
          subscription,
        },
      });
      return;
    }

    if (transition.kind === 'pending_payment') {
      void notifyPlatformBillingEvent({
        event_type: 'subscription_requested',
        reference_code: transition.tx.reference_code,
        status: 'pending',
        tenant_id: ctx.tenantId,
        tenant_slug: contact.tenantSlug || ctx.tenantSlug,
        tenant_name: contact.tenantName,
        admin_name: contact.adminName,
        email: contact.adminEmail,
        phone: contact.adminPhone,
        plan_code: transition.tx.plan_code,
        billing_cycle: transition.tx.billing_cycle,
        months_added: Number(transition.tx.months_added || 1),
        amount_vnd: Number(transition.tx.amount_vnd || 0),
        discount_pct: Number(transition.tx.discount_pct || 0),
        payment_method: transition.tx.payment_method,
        note: transition.tx.note,
      }).catch(() => {});

      res.status(201).json({
        success: true,
        data: {
          requires_payment: true,
          transaction: {
            ...transition.tx,
            amount_vnd: Number(transition.tx.amount_vnd || 0),
            proration_credit_vnd: Number(transition.tx.proration_credit_vnd || 0),
            discount_pct: Number(transition.tx.discount_pct || 0),
          },
          payment_bank_info: transition.catalog.payment_bank_info,
          gateway_session: transition.gateway_session,
          subscription,
        },
      });
      return;
    }

    // Activated immediately via wallet (or valid immediate zero-cost downgrade)
    tenantRedis.invalidateTenantCache(ctx.tenantId, ctx.tenantSlug);
    const billingEventType =
      transition.txType === 'plan_upgrade'
        ? 'plan_upgraded'
        : transition.txType === 'renewal' || transition.txType === 'reactivation'
          ? 'subscription_renewed'
          : 'subscription_activated';
    void notifyPlatformBillingEvent({
      event_type: billingEventType,
      reference_code: transition.tx.reference_code,
      status: 'completed',
      tenant_id: ctx.tenantId,
      tenant_slug: contact.tenantSlug || ctx.tenantSlug,
      tenant_name: contact.tenantName,
      admin_name: contact.adminName,
      email: contact.adminEmail,
      phone: contact.adminPhone,
      plan_code: transition.tx.plan_code,
      plan_name: subscription.plan_name,
      billing_cycle: transition.tx.billing_cycle,
      months_added: Number(transition.tx.months_added || 0),
      added_days: transition.addedDays,
      amount_vnd: transition.netDueVnd,
      discount_pct: Number(transition.tx.discount_pct || 0),
      wallet_balance_vnd: subscription.wallet_balance_vnd,
      payment_method: 'wallet',
      effective_expires_at: subscription.effective_expires_at,
      note: transition.tx.note,
    }).catch(() => {});

    res.status(200).json({
      success: true,
      data: {
        proration_credit_vnd: transition.prorationCreditVnd,
        excess_proration_credit_vnd: transition.excessCreditVnd,
        wallet_credited_vnd: transition.excessCreditVnd,
        transaction: {
          ...transition.tx,
          amount_vnd: Number(transition.tx.amount_vnd || 0),
          proration_credit_vnd: Number(transition.tx.proration_credit_vnd || 0),
          discount_pct: Number(transition.tx.discount_pct || 0),
        },
        subscription,
      },
    });
  } catch (err: any) {
    handleBillingTransitionError(res, err, 'BILLING_SUBSCRIBE_FAILED', 'Không thể xử lý yêu cầu nâng cấp / gia hạn gói.', 'INVALID_PLAN_CODE');
  }
});

// Explicit Renew / Reactivate Current Plan (supports monthly 30d or annual 365d)
billingRouter.post('/renew', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const idempotencyKey = extractIdempotencyKey(req);

    const runRenew = () =>
      withTenantTransaction(ctx.tenantId, async (client) => {
        const tCur = await client.query<{
          status: string | null;
          subscription_expires_at: string | null;
          subscription_plan_code: string | null;
          package_code: string | null;
          plan_tier: string | null;
          billing_cycle: string | null;
          scheduled_plan_code: string | null;
          scheduled_billing_cycle: string | null;
        }>(
          `SELECT status, subscription_expires_at, subscription_plan_code, package_code, plan_tier,
                  billing_cycle, scheduled_plan_code, scheduled_billing_cycle
           FROM tenants WHERE id = $1 LIMIT 1`,
          [ctx.tenantId]
        );
        const curRow = tCur.rows[0] || {};
        const curStatus = String(curRow.status || '').toLowerCase();
        const paidEndsMs = curRow.subscription_expires_at ? new Date(curRow.subscription_expires_at).getTime() : 0;
        const periodEndedOrRecovery =
          curStatus === 'grace' ||
          curStatus === 'suspended' ||
          curStatus === 'cancelled' ||
          (Boolean(paidEndsMs) && paidEndsMs <= Date.now());
        const useScheduledPlan =
          !b.plan_code && !b.package_code && Boolean(curRow.scheduled_plan_code) && periodEndedOrRecovery;

        const fallbackCode =
          useScheduledPlan && curRow.scheduled_plan_code
            ? String(curRow.scheduled_plan_code).trim()
            : curRow.subscription_plan_code && !curRow.subscription_plan_code.startsWith('trial_')
              ? curRow.subscription_plan_code
              : resolvePackageCodeFromTenant(curRow);
        const targetCode = b.plan_code || b.package_code || fallbackCode || 'autodata_standard';
        const cycleSource = useScheduledPlan
          ? curRow.scheduled_billing_cycle || curRow.billing_cycle
          : curRow.billing_cycle;
        const targetCycle = b.billing_cycle || (cycleSource === 'annual' ? 'annual' : 'monthly');

        const transition = await executePlanOrPackageChangeInTx(client, ctx.tenantId, ctx.userId, {
          target_code: targetCode,
          billing_cycle: targetCycle,
          months: b.months || (targetCycle === 'annual' ? 12 : 1),
          payment_method: b.payment_method || 'wallet',
          provider: b.provider,
          idempotency_key: idempotencyKey,
          note: b.note || 'Gia hạn / Kích hoạt lại gói cước',
          same_plan_early_renewal: true,
        });
        return transition;
      });

    let outcome: Awaited<ReturnType<typeof executePlanOrPackageChangeInTx>>;
    try {
      outcome = await runRenew();
    } catch (txErr: any) {
      if (idempotencyKey && isIdempotencyUniqueViolation(txErr)) {
        const replayed = await runRenew();
        if (replayed.kind !== 'idempotent_replay') throw txErr;
        outcome = replayed;
      } else {
        throw txErr;
      }
    }

    const subscription = computeSubscriptionSnapshot(outcome.tenant, outcome.catalog);
    if (outcome.kind === 'pending_payment' || (outcome.kind === 'idempotent_replay' && outcome.is_pending)) {
      res.status(outcome.kind === 'idempotent_replay' ? 200 : 201).json({
        success: true,
        data: {
          requires_payment: true,
          idempotent_replay: outcome.kind === 'idempotent_replay',
          transaction: {
            ...outcome.tx,
            amount_vnd: Number(outcome.tx.amount_vnd || 0),
          },
          payment_bank_info: outcome.catalog.payment_bank_info,
          gateway_session: outcome.gateway_session,
          subscription,
        },
      });
      return;
    }

    tenantRedis.invalidateTenantCache(ctx.tenantId, ctx.tenantSlug);
    res.json({
      success: true,
      data: {
        idempotent_replay: outcome.kind === 'idempotent_replay',
        transaction: {
          ...outcome.tx,
          amount_vnd: Number(outcome.tx.amount_vnd || 0),
        },
        subscription,
      },
    });
  } catch (err: any) {
    handleBillingTransitionError(res, err, 'BILLING_RENEW_FAILED', 'Không thể gia hạn gói cước.');
  }
});

// Cancel Subscription (`immediate: false` -> `cancel_at_period_end = true, auto_renew = false`, or `immediate: true` -> `status = 'cancelled'`)
billingRouter.post('/cancel', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const catalog = await getPlatformBillingCatalog();
    const immediate = Boolean(req.body?.immediate);
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 300) : null;

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query<Record<string, any>>(
        'SELECT * FROM tenants WHERE id = $1 FOR UPDATE',
        [ctx.tenantId]
      );
      const cur = curRes.rows[0];
      if (!cur) throw new Error('TENANT_NOT_FOUND');

      const updRes = await client.query(
        immediate
          ? `UPDATE tenants
             SET status = 'cancelled',
                 auto_renew = false,
                 cancel_at_period_end = false,
                 cancelled_at = clock_timestamp(),
                 grace_ends_at = NULL,
                 scheduled_plan_code = NULL,
                 scheduled_billing_cycle = NULL,
                 updated_at = clock_timestamp()
             WHERE id = $1
             RETURNING *`
          : `UPDATE tenants
             SET auto_renew = false,
                 cancel_at_period_end = true,
                 cancelled_at = COALESCE(cancelled_at, clock_timestamp()),
                 updated_at = clock_timestamp()
             WHERE id = $1
             RETURNING *`,
        [ctx.tenantId]
      );
      const updated = updRes.rows[0];
      const snap = computeSubscriptionSnapshot(updated, catalog);
      const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, 'CANCEL', updated.slug);
      const txRes = await client.query(
        `INSERT INTO tenant_billing_transactions (
           tenant_id, tx_type, plan_code, billing_cycle, months_added,
           amount_vnd, discount_pct, payment_method, provider, status, reference_code,
           note, metadata, requested_by, processed_by, processed_at
         ) VALUES (
           $1, 'cancellation', $2, $3, 0,
           0, 0, 'wallet', 'manual_bank_transfer', 'completed', $4,
           $5, $6::jsonb, $7, 'subscription_lifecycle_engine', clock_timestamp()
         )
         RETURNING *`,
        [
          ctx.tenantId,
          updated.subscription_plan_code || snap.plan_code,
          updated.billing_cycle || snap.billing_cycle,
          refCode,
          reason || (immediate ? 'Hủy gói ngay lập tức' : 'Hủy gia hạn tự động vào cuối chu kỳ'),
          JSON.stringify({
            immediate,
            reason,
            effective_at: immediate ? new Date().toISOString() : snap.effective_expires_at,
          }),
          ctx.userId,
        ]
      );
      return { tenant: updated, tx: txRes.rows[0], subscription: snap };
    });

    tenantRedis.invalidateTenantCache(ctx.tenantId, ctx.tenantSlug);
    await tenantRedis.del('meta:tenant_status', ctx.tenantId);

    res.json({
      success: true,
      data: {
        immediate,
        transaction: {
          ...outcome.tx,
          amount_vnd: Number(outcome.tx.amount_vnd || 0),
        },
        subscription: outcome.subscription,
      },
    });
  } catch (err: any) {
    handleBillingTransitionError(res, err, 'BILLING_CANCEL_FAILED', 'Không thể hủy đăng ký gói.');
  }
});

// Toggle Auto-Renew (`auto_renew: boolean`)
billingRouter.patch('/auto-renew', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const catalog = await getPlatformBillingCatalog();
    if (typeof req.body?.auto_renew !== 'boolean') {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Trường auto_renew phải là kiểu boolean.');
      return;
    }
    const autoRenew = Boolean(req.body.auto_renew);

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenants
         SET auto_renew = $2,
             cancel_at_period_end = CASE WHEN $2 = true THEN false ELSE cancel_at_period_end END,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING *`,
        [ctx.tenantId, autoRenew]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy doanh nghiệp.');
      return;
    }

    tenantRedis.invalidateTenantCache(ctx.tenantId, ctx.tenantSlug);
    const subscription = computeSubscriptionSnapshot(updated, catalog);
    res.json({
      success: true,
      data: {
        auto_renew: subscription.auto_renew,
        cancel_at_period_end: subscription.cancel_at_period_end,
        subscription,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'AUTO_RENEW_UPDATE_FAILED', err?.message || 'Không thể cập nhật trạng thái tự động gia hạn.');
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

    const rawSuite = String(target_suite || 'crm_erp_bundle').trim().toLowerCase();
    const suiteMap: Record<string, 'crm' | 'erp' | 'crm_erp_bundle'> = {
      crm: 'crm',
      erp: 'erp',
      crm_erp_bundle: 'crm_erp_bundle',
      domation_crm_erp: 'crm_erp_bundle',
      domation_promax: 'crm_erp_bundle',
      enterprise: 'crm_erp_bundle',
    };
    const suite = suiteMap[rawSuite];
    if (!suite) {
      sendApiError(res, 422, 'INVALID_TARGET_SUITE', `target_suite '${rawSuite}' không hợp lệ.`);
      return;
    }
    const cycle: 'monthly' | 'annual' = billing_cycle === 'monthly' ? 'monthly' : 'annual';

    const enterprisePlan =
      catalog.plans.find((p) => p.is_enterprise_upgrade || p.plan_tier === 'enterprise') ||
      catalog.plans[catalog.plans.length - 1];
    const monthsAdded = cycle === 'annual' ? 12 : 1;
    const discountPct = cycle === 'annual' ? enterprisePlan.annual_discount_pct : 0;
    const estimatedAmount =
      cycle === 'annual' ? enterprisePlan.annual_total_vnd : enterprisePlan.monthly_price_vnd;

    const refCode = generateBillingReferenceCode(catalog.payment_bank_info.transfer_prefix, suite.toUpperCase(), ctx.tenantSlug);
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
           amount_vnd, discount_pct, payment_method, provider, status, reference_code,
           note, metadata, requested_by
         ) VALUES ($1, 'crm_erp_upgrade', $2, $3, $4, $5, $6, 'bank_transfer', 'manual_bank_transfer', 'pending', $7, $8, $9::jsonb, $10)
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

    tenantRedis.invalidateTenantCache(ctx.tenantId, ctx.tenantSlug);

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

// Multi-Product SaaS Package Switch / Upgrade (Zero Data Migration, Enforces Wallet/Proration/Pending Order!)
billingRouter.post('/switch-package', requireTenantAuth, requirePermission('billing', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const targetCode = b.package_code || b.plan_tier || b.package;
    const idempotencyKey = extractIdempotencyKey(req);

    const runSwitch = () =>
      withTenantTransaction(ctx.tenantId, (client) =>
        switchTenantSaasPackageInTx(client, ctx.tenantId, ctx.userId, {
          package_code: targetCode,
          billing_cycle: b.billing_cycle,
          months: b.months,
          payment_method: b.payment_method,
          provider: b.provider,
          schedule_at_period_end: Boolean(b.schedule_at_period_end),
          idempotency_key: idempotencyKey,
          education_addon: b.education_addon,
          industry_key: b.industry_key,
          note: b.note,
        })
      );

    let switched: Awaited<ReturnType<typeof switchTenantSaasPackageInTx>>;
    try {
      switched = await runSwitch();
    } catch (txErr: any) {
      if (idempotencyKey && isIdempotencyUniqueViolation(txErr)) {
        const replayed = await runSwitch();
        if (!replayed.idempotent_replay) throw txErr;
        switched = replayed;
      } else {
        throw txErr;
      }
    }

    if (switched.requires_payment) {
      res.status(switched.idempotent_replay ? 200 : 201).json({ success: true, data: switched });
      return;
    }

    tenantRedis.invalidateTenantCache(ctx.tenantId, switched.slug || ctx.tenantSlug);
    res.json({ success: true, data: switched });
  } catch (err: any) {
    handleBillingTransitionError(res, err, 'SWITCH_PACKAGE_FAILED', 'Không thể chuyển đổi gói sản phẩm.');
  }
});
