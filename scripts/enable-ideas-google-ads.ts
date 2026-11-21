import { createDatabasePool, setDatabasePool } from '../server/core/database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../server/core/database/transaction.ts';
import {
  getDomMetaWorkspaceConfig,
  saveDomMetaWorkspaceConfig,
} from '../server/services/dom-meta-report.service.ts';

async function main() {
  const pool = createDatabasePool();
  setDatabasePool(pool);

  const targets: Array<{ slug: string; customerId: string; label: string }> = [
    { slug: 'ideas', customerId: '227-521-6666', label: 'IDEAS Google Ads' },
  ];

  for (const t of targets) {
    const found = await withSystemPrivilege(async (client) => {
      const res = await client.query<{ id: string; slug: string; name: string }>(
        `SELECT id, slug, name FROM tenants WHERE LOWER(slug) = $1 LIMIT 1`,
        [t.slug]
      );
      return res.rows[0] || null;
    });

    if (!found) {
      console.log(`[EnableGAds] Workspace slug "${t.slug}" not found — skipping.`);
      continue;
    }

    const updated = await withTenantTransaction(found.id, async (client) => {
      const existing = await getDomMetaWorkspaceConfig(client, found.id);
      const existingAccounts = existing.google_ads.accounts || [];
      const hasCid = existingAccounts.some((a) => a.customer_id === t.customerId);
      const nextAccounts = hasCid
        ? existingAccounts.map((a) =>
            a.customer_id === t.customerId
              ? {
                  ...a,
                  label: a.label || t.label,
                  status: 'connected' as const,
                  verified_via: a.verified_via || ('legacy_migrated' as const),
                  verified_at: a.verified_at || new Date().toISOString(),
                }
              : a
          )
        : [
            ...existingAccounts,
            {
              customer_id: t.customerId,
              label: t.label,
              status: 'connected' as const,
              verified_via: 'legacy_migrated' as const,
              verified_at: new Date().toISOString(),
            },
          ];

      await saveDomMetaWorkspaceConfig(
        client,
        found.id,
        {
          google_ads: {
            enabled: true,
            setup_mode: 'mcc_quick',
            customer_id: t.customerId,
            accounts: nextAccounts,
            mark_verified: true,
          },
        },
        { trustGoogleAdsAccounts: true }
      );
      return getDomMetaWorkspaceConfig(client, found.id);
    });

    console.log(
      `[EnableGAds] Updated "${found.slug}" (${found.name}):`,
      JSON.stringify(updated.google_ads)
    );
  }

  await pool.close();
}

main().catch((err) => {
  console.error('[EnableGAds] Error:', err);
  process.exit(1);
});
