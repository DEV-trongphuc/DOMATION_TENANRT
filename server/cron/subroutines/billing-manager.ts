import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import {
  applySubscriptionActivationInTx,
  buildDefaultPlans,
  computeSubscriptionSnapshot,
  generateBillingReferenceCode,
  getPlatformBillingCatalog,
  matchPlanInCatalog,
} from '../../services/billing.service.ts';
import { resolveCanonicalBillingIdentity } from '../../core/security/entitlements.ts';
import { getPlatformOperationalConfigCached } from '../../core/settings/platform-config.ts';
import { fetchTenantPrimaryAdminContact, notifyPlatformBillingEvent } from '../../services/platform-appscript.service.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';

function getGracePeriodDays(): number {
  const n = Number(process.env.BILLING_GRACE_PERIOD_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 7;
}

export async function runSubscriptionExpiryManager(tenantIdFilter?: string): Promise<number> {
  const opsCfg = await getPlatformOperationalConfigCached();
  const billingBatchLimit = opsCfg.cron_limits.billing_batch_limit;
  const catalog = await getPlatformBillingCatalog();
  const nowIso = new Date().toISOString();
  const gracePeriodDays = getGracePeriodDays();

  // Pass 1: Expired 'active' | 'trial' tenants -> cancel_at_period_end / auto_renew (365d vs 30d + scheduled downgrade) / grace
  const expiredTenants = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT id, slug, name, package_code, plan_tier, status, created_at, trial_ends_at,
             subscription_expires_at, grace_ends_at, auto_renew, cancel_at_period_end,
             scheduled_plan_code, scheduled_billing_cycle,
             subscription_plan_code, billing_cycle, wallet_balance_vnd, crm_erp_upgrade_status
      FROM tenants
      WHERE status IN ('active', 'trial')
        AND (
          (subscription_expires_at IS NOT NULL AND subscription_expires_at <= $1)
          OR (subscription_expires_at IS NULL AND trial_ends_at <= $1)
        )
        ${tenantIdFilter ? 'AND id = $2' : ''}
      LIMIT ${billingBatchLimit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [nowIso, tenantIdFilter] : [nowIso]);
    return res.rows;
  });

  let processedCount = 0;
  for (const tRow of expiredTenants) {
    let pendingNotify: Parameters<typeof notifyPlatformBillingEvent>[0] | null = null;

    await withTenantTransaction(tRow.id, async (client) => {
      const lockedRes = await client.query<Record<string, any>>(
        'SELECT * FROM tenants WHERE id = $1 FOR UPDATE',
        [tRow.id]
      );
      const locked = lockedRes.rows[0];
      if (!locked || (locked.status !== 'active' && locked.status !== 'trial')) return;

      const txCatalog = await getPlatformBillingCatalog(client);
      const snap = computeSubscriptionSnapshot(locked, txCatalog);
      if (!snap.is_expired) return;

      const contact = await fetchTenantPrimaryAdminContact(client, locked.id);

      // Case A: Scheduled period-end cancellation
      if (locked.cancel_at_period_end) {
        await client.query(
          `UPDATE tenants
           SET status = 'cancelled',
               auto_renew = false,
               cancel_at_period_end = false,
               cancelled_at = COALESCE(cancelled_at, clock_timestamp()),
               grace_ends_at = NULL,
               scheduled_plan_code = NULL,
               scheduled_billing_cycle = NULL,
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [locked.id]
        );
        tenantRedis.invalidateTenantCache(locked.id, locked.slug);
        await tenantRedis.del('meta:tenant_status', locked.id);
        pendingNotify = {
          event_type: 'subscription_expired_suspended',
          reference_code: generateBillingReferenceCode('CANC', 'CRON', locked.slug),
          status: 'cancelled',
          tenant_id: locked.id,
          tenant_slug: contact.tenantSlug || locked.slug,
          tenant_name: contact.tenantName || locked.name,
          admin_name: contact.adminName,
          email: contact.adminEmail,
          phone: contact.adminPhone,
          plan_code: snap.plan_code,
          plan_name: snap.plan_name,
          billing_cycle: snap.billing_cycle,
          amount_vnd: 0,
          wallet_balance_vnd: Number(locked.wallet_balance_vnd || 0),
          payment_method: 'cron',
          effective_expires_at: snap.effective_expires_at,
          processed_by: 'master_cron_cancel_at_period_end',
          note: 'Kết thúc chu kỳ và hủy theo yêu cầu cancel_at_period_end',
        };
        processedCount += 1;
        return;
      }

      // Resolve target plan (honoring scheduled_plan_code if set!)
      const effectivePlanCode = locked.scheduled_plan_code || snap.plan_code;
      const effectiveCycle: 'monthly' | 'annual' =
        (locked.scheduled_billing_cycle || locked.billing_cycle) === 'annual' ? 'annual' : 'monthly';
      const targetIdentity =
        resolveCanonicalBillingIdentity(
          effectivePlanCode && !String(effectivePlanCode).startsWith('trial_') ? effectivePlanCode : undefined
        ) ||
        resolveCanonicalBillingIdentity(locked.package_code) ||
        resolveCanonicalBillingIdentity(locked.plan_tier) ||
        resolveCanonicalBillingIdentity('autodata_standard')!;
      const matchedPlan = matchPlanInCatalog(targetIdentity, txCatalog) || buildDefaultPlans()[0];
      const renewalCost =
        effectiveCycle === 'annual' ? matchedPlan.annual_total_vnd : matchedPlan.monthly_price_vnd;
      const addedDays = effectiveCycle === 'annual' ? 365 : 30;
      const monthsAdded = effectiveCycle === 'annual' ? 12 : 1;
      const currentWallet = Number(locked.wallet_balance_vnd || 0);
      const autoRenewEnabled =
        locked.auto_renew === undefined || locked.auto_renew === null ? true : Boolean(locked.auto_renew);

      // Case B: Auto-renew enabled and wallet covers renewalCost
      if (autoRenewEnabled && currentWallet >= renewalCost) {
        const updatedTenant = await applySubscriptionActivationInTx(client, {
          tenantId: locked.id,
          planCode: matchedPlan.code,
          billingCycle: effectiveCycle,
          monthsAdded,
          walletDebitVnd: renewalCost,
          useCurrentTimeBase: true,
          catalog: txCatalog,
        });
        const nextExpiry = updatedTenant.subscription_expires_at
          ? new Date(updatedTenant.subscription_expires_at).toISOString()
          : new Date(Date.now() + addedDays * 86_400_000).toISOString();
        const remainingWallet = Number(updatedTenant.wallet_balance_vnd || 0);
        const refCode = generateBillingReferenceCode('RENEW', 'AUTO', locked.slug);
        const note = locked.scheduled_plan_code
          ? `Tự động chuyển sang gói ${matchedPlan.name} (${effectiveCycle}) và gia hạn từ Ví Topup`
          : `Tự động gia hạn ${effectiveCycle === 'annual' ? '1 năm (365 ngày)' : '1 tháng (30 ngày)'} từ số dư ví Topup qua Master Cron`;

        await client.query(
          `INSERT INTO tenant_billing_transactions (
             tenant_id, tx_type, plan_code, billing_cycle, months_added, amount_vnd,
             payment_method, provider, status, reference_code, note, metadata, processed_by, processed_at
           ) VALUES (
             $1, 'renewal', $2, $3, $4, $5,
             'wallet', 'manual_bank_transfer', 'completed', $6, $7,
             $8::jsonb, 'master_cron_auto_renew', clock_timestamp()
           )`,
          [
            locked.id,
            matchedPlan.code,
            effectiveCycle,
            monthsAdded,
            renewalCost,
            refCode,
            note,
            JSON.stringify({ added_days: addedDays, applied_scheduled_plan: Boolean(locked.scheduled_plan_code) }),
          ]
        );

        pendingNotify = {
          event_type: 'auto_renewal_success',
          reference_code: refCode,
          status: 'completed',
          tenant_id: locked.id,
          tenant_slug: contact.tenantSlug || locked.slug,
          tenant_name: contact.tenantName || locked.name,
          admin_name: contact.adminName,
          email: contact.adminEmail,
          phone: contact.adminPhone,
          plan_code: matchedPlan.code,
          plan_name: matchedPlan.name,
          billing_cycle: effectiveCycle,
          months_added: monthsAdded,
          added_days: addedDays,
          amount_vnd: renewalCost,
          wallet_balance_vnd: remainingWallet,
          payment_method: 'wallet',
          effective_expires_at: nextExpiry,
          processed_by: 'master_cron_auto_renew',
          note,
        };
      } else {
        // Case C: Enter Grace Period (`active|trial -> grace`)
        const graceEndsIso =
          locked.grace_ends_at && new Date(locked.grace_ends_at).getTime() > Date.now()
            ? new Date(locked.grace_ends_at).toISOString()
            : new Date(Date.now() + gracePeriodDays * 86_400_000).toISOString();

        await client.query(
          `UPDATE tenants
           SET status = 'grace',
               grace_ends_at = $2::timestamptz,
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [locked.id, graceEndsIso]
        );
        tenantRedis.invalidateTenantCache(locked.id, locked.slug);
        await tenantRedis.del('meta:tenant_status', locked.id);

        pendingNotify = {
          event_type: 'expiry_warning',
          reference_code: generateBillingReferenceCode('GRACE', 'CRON', locked.slug),
          status: 'grace',
          tenant_id: locked.id,
          tenant_slug: contact.tenantSlug || locked.slug,
          tenant_name: contact.tenantName || locked.name,
          admin_name: contact.adminName,
          email: contact.adminEmail,
          phone: contact.adminPhone,
          plan_code: matchedPlan.code,
          plan_name: matchedPlan.name,
          billing_cycle: effectiveCycle,
          amount_vnd: 0,
          wallet_balance_vnd: currentWallet,
          required_amount_vnd: renewalCost,
          shortfall_vnd: Math.max(0, renewalCost - currentWallet),
          payment_method: 'cron',
          effective_expires_at: graceEndsIso,
          processed_by: 'master_cron_grace_start',
          note: !autoRenewEnabled
            ? `Bắt đầu thời gian ân hạn ${gracePeriodDays} ngày (auto_renew đã tắt)`
            : `Bắt đầu thời gian ân hạn ${gracePeriodDays} ngày do số dư ví (${currentWallet.toLocaleString('vi-VN')}₫ < ${renewalCost.toLocaleString('vi-VN')}₫)`,
        };
      }
      processedCount += 1;
    });

    tenantRedis.invalidateTenantCache(tRow.id, tRow.slug);

    if (pendingNotify) {
      await notifyPlatformBillingEvent(pendingNotify).catch(() => {});
    }
  }

  // Pass 2: Expired 'grace' tenants (`grace_ends_at <= now`) -> 'suspended'
  const expiredGraceTenants = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT id, slug, name, package_code, plan_tier, status, grace_ends_at,
             subscription_plan_code, billing_cycle, wallet_balance_vnd
      FROM tenants
      WHERE status = 'grace'
        AND grace_ends_at IS NOT NULL
        AND grace_ends_at <= $1
        ${tenantIdFilter ? 'AND id = $2' : ''}
      LIMIT ${billingBatchLimit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [nowIso, tenantIdFilter] : [nowIso]);
    return res.rows;
  });

  for (const gRow of expiredGraceTenants) {
    let suspendNotify: Parameters<typeof notifyPlatformBillingEvent>[0] | null = null;

    await withTenantTransaction(gRow.id, async (client) => {
      const lockedRes = await client.query<Record<string, any>>(
        'SELECT * FROM tenants WHERE id = $1 FOR UPDATE',
        [gRow.id]
      );
      const locked = lockedRes.rows[0];
      if (!locked || locked.status !== 'grace') return;
      if (!locked.grace_ends_at || new Date(locked.grace_ends_at).getTime() > Date.now()) return;

      const txCatalog = await getPlatformBillingCatalog(client);
      const snap = computeSubscriptionSnapshot(locked, txCatalog);
      const contact = await fetchTenantPrimaryAdminContact(client, locked.id);

      await client.query(
        `UPDATE tenants SET status = 'suspended', updated_at = clock_timestamp() WHERE id = $1`,
        [locked.id]
      );
      tenantRedis.invalidateTenantCache(locked.id, locked.slug);
      await tenantRedis.del('meta:tenant_status', locked.id);

      const matchedPlan = txCatalog.plans.find((p) => p.code === snap.plan_code) || buildDefaultPlans()[0];
      const renewalCost =
        snap.billing_cycle === 'annual' ? matchedPlan.annual_total_vnd : matchedPlan.monthly_price_vnd;
      const currentWallet = Number(locked.wallet_balance_vnd || 0);

      suspendNotify = {
        event_type: 'subscription_expired_suspended',
        reference_code: generateBillingReferenceCode('SUSP', 'CRON', locked.slug),
        status: 'suspended',
        tenant_id: locked.id,
        tenant_slug: contact.tenantSlug || locked.slug,
        tenant_name: contact.tenantName || locked.name,
        admin_name: contact.adminName,
        email: contact.adminEmail,
        phone: contact.adminPhone,
        plan_code: matchedPlan.code,
        plan_name: matchedPlan.name,
        billing_cycle: snap.billing_cycle,
        amount_vnd: 0,
        wallet_balance_vnd: currentWallet,
        required_amount_vnd: renewalCost,
        shortfall_vnd: Math.max(0, renewalCost - currentWallet),
        payment_method: 'cron',
        effective_expires_at: snap.effective_expires_at,
        processed_by: 'master_cron_grace_expired',
        note: `Tạm ngưng sau khi hết hạn thời gian ân hạn (${gracePeriodDays} ngày)`,
      };
      processedCount += 1;
    });

    tenantRedis.invalidateTenantCache(gRow.id, gRow.slug);

    if (suspendNotify) {
      await notifyPlatformBillingEvent(suspendNotify).catch(() => {});
    }
  }

  // Pass 3: Proactive Upcoming Expiry Reminder Sweep (default 3 days & 1 day before expiration, idempotent per period)
  const warnDays = Math.max(1, Number(catalog.trial_warning_days || 3));
  const warnUpperIso = new Date(Date.now() + warnDays * 86_400_000).toISOString();
  const soonTenants = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT id, slug, name, package_code, plan_tier, status, created_at, trial_ends_at,
             subscription_expires_at, grace_ends_at, auto_renew, cancel_at_period_end,
             subscription_plan_code, billing_cycle,
             wallet_balance_vnd, crm_erp_upgrade_status, settings
      FROM tenants
      WHERE status IN ('active', 'trial')
        AND (
          (subscription_expires_at IS NOT NULL AND subscription_expires_at > $1 AND subscription_expires_at <= $2)
          OR (subscription_expires_at IS NULL AND trial_ends_at > $1 AND trial_ends_at <= $2)
        )
        ${tenantIdFilter ? 'AND id = $3' : ''}
      LIMIT ${billingBatchLimit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [nowIso, warnUpperIso, tenantIdFilter] : [nowIso, warnUpperIso]);
    return res.rows;
  });

  for (const tRow of soonTenants) {
    let warnNotify: Parameters<typeof notifyPlatformBillingEvent>[0] | null = null;

    await withTenantTransaction(tRow.id, async (client) => {
      const txCatalog = await getPlatformBillingCatalog(client);
      const snap = computeSubscriptionSnapshot(tRow, txCatalog);
      if (snap.is_expired || !snap.is_expiring_soon) return;

      const milestone = snap.days_remaining <= 1 ? '1d' : `${warnDays}d`;
      const markerKey = `${snap.effective_expires_at}|${milestone}`;
      let parsedSettings: Record<string, unknown> = {};
      if (tRow.settings && typeof tRow.settings === 'object') {
        parsedSettings = { ...tRow.settings };
      } else if (typeof tRow.settings === 'string') {
        try {
          parsedSettings = JSON.parse(tRow.settings) || {};
        } catch {
          parsedSettings = {};
        }
      }
      const rawSettings = parsedSettings;
      const sentMarkers: string[] = Array.isArray(rawSettings._billing_warning_markers)
        ? rawSettings._billing_warning_markers.map(String)
        : [];

      if (sentMarkers.includes(markerKey)) return;

      const matchedPlan = txCatalog.plans.find((p) => p.code === snap.plan_code) || buildDefaultPlans()[0];
      const renewalCost =
        snap.billing_cycle === 'annual' ? matchedPlan.annual_total_vnd : matchedPlan.monthly_price_vnd;
      const currentWallet = Number(tRow.wallet_balance_vnd || 0);
      const contact = await fetchTenantPrimaryAdminContact(client, tRow.id);

      const nextMarkers = [...sentMarkers.slice(-9), markerKey];
      rawSettings._billing_warning_markers = nextMarkers;
      await client.query(
        `UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
        [tRow.id, JSON.stringify(rawSettings)]
      );
      tenantRedis.invalidateTenantCache(tRow.id, tRow.slug);

      warnNotify = {
        event_type: 'expiry_warning',
        reference_code: generateBillingReferenceCode('WARN', milestone.toUpperCase(), tRow.slug),
        status: 'warning',
        tenant_id: tRow.id,
        tenant_slug: contact.tenantSlug || tRow.slug,
        tenant_name: contact.tenantName || tRow.name,
        admin_name: contact.adminName,
        email: contact.adminEmail,
        phone: contact.adminPhone,
        plan_code: matchedPlan.code,
        plan_name: matchedPlan.name,
        billing_cycle: snap.billing_cycle,
        days_remaining: snap.days_remaining,
        amount_vnd: 0,
        wallet_balance_vnd: currentWallet,
        required_amount_vnd: renewalCost,
        shortfall_vnd: Math.max(0, renewalCost - currentWallet),
        payment_method: 'cron',
        effective_expires_at: snap.effective_expires_at,
        processed_by: 'master_cron_expiry_warning',
        note: `Cảnh báo trước hạn (${snap.days_remaining} ngày còn lại • Mốc ${milestone})`,
      };
    });

    if (warnNotify) {
      await notifyPlatformBillingEvent(warnNotify).catch(() => {});
    }
  }

  return processedCount;
}
