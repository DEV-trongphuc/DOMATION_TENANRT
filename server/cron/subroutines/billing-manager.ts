import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { getPlatformBillingCatalog, computeSubscriptionSnapshot, buildDefaultPlans } from '../../services/billing.service.ts';
import { getPlatformOperationalConfigCached } from '../../core/settings/platform-config.ts';
import { fetchTenantPrimaryAdminContact, notifyPlatformBillingEvent } from '../../services/platform-appscript.service.ts';

export async function runSubscriptionExpiryManager(tenantIdFilter?: string): Promise<number> {
  const opsCfg = await getPlatformOperationalConfigCached();
  const billingBatchLimit = opsCfg.cron_limits.billing_batch_limit;
  const catalog = await getPlatformBillingCatalog();
  const nowIso = new Date().toISOString();

  const expiredTenants = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT id, slug, name, plan_tier, status, created_at, trial_ends_at,
             subscription_expires_at, subscription_plan_code, billing_cycle,
             wallet_balance_vnd, crm_erp_upgrade_status
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
      const txCatalog = await getPlatformBillingCatalog(client);
      const snap = computeSubscriptionSnapshot(tRow, txCatalog);
      if (!snap.is_expired) return;

      const matchedPlan = txCatalog.plans.find((p) => p.code === snap.plan_code) || buildDefaultPlans()[0];
      const renewalCost = matchedPlan?.monthly_price_vnd || 1_500_000;
      const currentWallet = Number(tRow.wallet_balance_vnd || 0);
      const contact = await fetchTenantPrimaryAdminContact(client, tRow.id);

      if (currentWallet >= renewalCost) {
        const nextExpiry = new Date(Date.now() + 30 * 86_400_000).toISOString();
        const remainingWallet = currentWallet - renewalCost;
        const refCode = `RENEW_AUTO_${String(tRow.slug || 'TENANT').toUpperCase()}_${Date.now()}`;
        const note = 'Tự động gia hạn từ số dư ví Topup qua Master Cron';

        await client.query(
          `UPDATE tenants
           SET wallet_balance_vnd = wallet_balance_vnd - $1,
               subscription_expires_at = $2,
               status = 'active',
               updated_at = clock_timestamp()
           WHERE id = $3`,
          [renewalCost, nextExpiry, tRow.id]
        );
        await client.query(
          `INSERT INTO tenant_billing_transactions (
             tenant_id, tx_type, plan_code, billing_cycle, months_added, amount_vnd,
             payment_method, status, reference_code, note, metadata, processed_by, processed_at
           ) VALUES (
             $1, 'renewal', $2, 'monthly', 1, $3,
             'wallet', 'completed', $4, $5,
             '{}'::jsonb, 'master_cron_auto_renew', clock_timestamp()
           )`,
          [tRow.id, matchedPlan.code, renewalCost, refCode, note]
        );

        pendingNotify = {
          event_type: 'auto_renewal_success',
          reference_code: refCode,
          status: 'completed',
          tenant_id: tRow.id,
          tenant_slug: contact.tenantSlug || tRow.slug,
          tenant_name: contact.tenantName || tRow.name,
          admin_name: contact.adminName,
          email: contact.adminEmail,
          phone: contact.adminPhone,
          plan_code: matchedPlan.code,
          plan_name: matchedPlan.name,
          billing_cycle: 'monthly',
          months_added: 1,
          added_days: 30,
          amount_vnd: renewalCost,
          wallet_balance_vnd: remainingWallet,
          payment_method: 'wallet',
          effective_expires_at: nextExpiry,
          processed_by: 'master_cron_auto_renew',
          note,
        };
      } else {
        await client.query(
          `UPDATE tenants SET status = 'suspended', updated_at = clock_timestamp() WHERE id = $1`,
          [tRow.id]
        );

        pendingNotify = {
          event_type: 'subscription_expired_suspended',
          reference_code: `SUSP-${String(tRow.slug || 'TENANT').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`,
          status: 'suspended',
          tenant_id: tRow.id,
          tenant_slug: contact.tenantSlug || tRow.slug,
          tenant_name: contact.tenantName || tRow.name,
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
          processed_by: 'master_cron_expiry',
          note: `Tạm ngưng do hết hạn gói & số dư ví (${currentWallet.toLocaleString('vi-VN')}₫ < ${renewalCost.toLocaleString('vi-VN')}₫)`,
        };
      }
      processedCount += 1;
    });

    if (pendingNotify) {
      await notifyPlatformBillingEvent(pendingNotify).catch(() => {});
    }
  }

  // Proactive Upcoming Expiry Reminder Sweep (default 3 days & 1 day before expiration, idempotent per period)
  const warnDays = Math.max(1, Number(catalog.trial_warning_days || 3));
  const warnUpperIso = new Date(Date.now() + warnDays * 86_400_000).toISOString();
  const soonTenants = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT id, slug, name, plan_tier, status, created_at, trial_ends_at,
             subscription_expires_at, subscription_plan_code, billing_cycle,
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
      const renewalCost = matchedPlan?.monthly_price_vnd || 1_500_000;
      const currentWallet = Number(tRow.wallet_balance_vnd || 0);
      const contact = await fetchTenantPrimaryAdminContact(client, tRow.id);

      const nextMarkers = [...sentMarkers.slice(-9), markerKey];
      rawSettings._billing_warning_markers = nextMarkers;
      await client.query(
        `UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
        [tRow.id, JSON.stringify(rawSettings)]
      );

      warnNotify = {
        event_type: 'expiry_warning',
        reference_code: `WARN-${milestone.toUpperCase()}-${String(tRow.slug || 'TENANT').toUpperCase()}`,
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
