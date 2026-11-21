import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_CONFIG } from '../server/config.ts';
import { createDatabasePool, setDatabasePool } from '../server/core/database/db-adapter.ts';
import { runDatabaseMigrations } from '../server/core/database/migrate.ts';
import { withSystemPrivilege, withTenantTransaction } from '../server/core/database/transaction.ts';
import { hashPassword } from '../server/core/crypto/password.ts';
import {
  buildModulesForPackage,
  normalizeIndustryKey,
  SAAS_PACKAGES_CATALOG,
} from '../server/core/security/entitlements.ts';
import { DEFAULT_TENANT_SETTINGS } from '../server/core/settings/tenant-settings.ts';
import { seedTenantWorkspace } from '../server/services/preset.service.ts';
import { normalizeAdAccountId, upsertMetaAdAccount } from '../server/services/meta-ads.service.ts';
import { saveDomMetaWorkspaceConfig } from '../server/services/dom-meta-report.service.ts';

interface LegacyTenantRow {
  id: number;
  slug: string;
  name: string;
  google_email: string;
  status: string;
  expires_at?: string | null;
  meta_token?: string | null;
  gemini_api_key?: string | null;
  ad_account_id?: string | null;
  ad_accounts?: string | null;
  brand_filter_enabled?: number | boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  is_public?: number | boolean | null;
}

interface LegacySettingRow {
  id: number;
  tenant_slug: string;
  account_id: string;
  setting_key: string;
  setting_value: string;
}

interface LegacyViewerRow {
  id: number;
  tenant_slug: string;
  email: string;
  name?: string | null;
  picture?: string | null;
  role: string;
  status: string;
}

interface LegacyAiReportRow {
  id: number;
  tenant_slug: string;
  account_id?: string | null;
  local_id?: string | null;
  timestamp?: string | null;
  label?: string | null;
  brand?: string | null;
  dateRange?: string | null;
  preview?: string | null;
  html?: string | null;
}

interface LegacyExportPayload {
  rows: {
    saas_tenants: LegacyTenantRow[];
    saas_tenant_settings: LegacySettingRow[];
    saas_tenant_viewers: LegacyViewerRow[];
    saas_ai_reports: LegacyAiReportRow[];
  };
}

function parseArgFile(): string {
  const arg = process.argv.find((a) => a.startsWith('--file='));
  const raw = arg ? arg.slice('--file='.length) : process.env.LEGACY_EXPORT_PATH || '';
  if (!raw) {
    throw new Error('Missing --file=<path-to-legacy_meta_export.json> argument.');
  }
  return path.resolve(raw);
}

function inferIndustryFromSlug(slug: string): string {
  if (slug.includes('ideas')) return 'education';
  if (slug.includes('flora')) return 'healthcare';
  if (slug.includes('duyen-mai') || slug.includes('crumb') || slug.includes('mercantile') || slug.includes('ampersand')) {
    return 'fnb';
  }
  if (slug.includes('ecolife')) return 'real_estate';
  if (slug.includes('baongan') || slug.includes('wisedoo')) return 'retail';
  return 'general';
}

function parseSqlDateToIso(raw: string | null | undefined, fallbackDaysFromNow = 365): string {
  const clean = String(raw || '').trim();
  if (clean) {
    const isoCandidate = clean.includes('T') ? clean : `${clean.replace(' ', 'T')}Z`;
    const parsed = new Date(isoCandidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(Date.now() + fallbackDaysFromNow * 86_400_000).toISOString();
}

function parseJsonSafe<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface ParsedAccountTokenEntry {
  ad_account_id: string;
  name: string;
  access_token: string;
}

function extractAccountsFromLegacyTenant(t: LegacyTenantRow): ParsedAccountTokenEntry[] {
  const topToken = String(t.meta_token || '').trim();
  const parsed = parseJsonSafe<unknown[]>(t.ad_accounts);
  const out: ParsedAccountTokenEntry[] = [];
  const seen = new Set<string>();

  const pushUnique = (idRaw: unknown, nameRaw: unknown, tokRaw: unknown) => {
    const normId = normalizeAdAccountId(idRaw);
    const tok = String(tokRaw || '').trim();
    if (!normId || !tok || seen.has(normId)) return;
    seen.add(normId);
    out.push({
      ad_account_id: normId,
      name: String(nameRaw || normId).trim() || normId,
      access_token: tok,
    });
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, any>;
      if (Array.isArray(rec.accounts)) {
        const groupToken = String(rec.token || topToken || '').trim();
        for (const sub of rec.accounts) {
          if (sub && typeof sub === 'object') {
            pushUnique(sub.id || sub.account_id, sub.name, groupToken);
          }
        }
      } else {
        pushUnique(rec.id || rec.account_id, rec.name, topToken);
      }
    }
  }

  if (out.length === 0 && t.ad_account_id && topToken) {
    pushUnique(t.ad_account_id, t.name || t.slug, topToken);
  }

  return out;
}

async function ensureGlobalAccountId(email: string, fullName: string): Promise<string> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = fullName.trim() || cleanEmail.split('@')[0] || 'DOMATION User';
  return withSystemPrivilege(async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM global_accounts WHERE LOWER(email) = $1 LIMIT 1`,
      [cleanEmail]
    );
    if (existing.rows[0]?.id) return existing.rows[0].id;
    const passHash = await hashPassword(crypto.randomBytes(24).toString('hex'), APP_CONFIG.bcryptRounds);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO global_accounts (email, password_hash, full_name, is_active, last_login_at)
       VALUES ($1, $2, $3, true, clock_timestamp())
       RETURNING id`,
      [cleanEmail, passHash, cleanName]
    );
    return ins.rows[0].id;
  });
}

async function main() {
  const filePath = parseArgFile();
  const exportData = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegacyExportPayload;

  const pool = createDatabasePool();
  setDatabasePool(pool);
  await runDatabaseMigrations({ seedSuperAdmin: true });

  const tenants = exportData.rows.saas_tenants || [];
  const allSettings = exportData.rows.saas_tenant_settings || [];
  const allViewers = exportData.rows.saas_tenant_viewers || [];
  const allAiReports = exportData.rows.saas_ai_reports || [];

  console.log(`[Migrate] Starting migration for ${tenants.length} legacy meta.domation.net tenants...`);
  const summary: Array<{
    slug: string;
    tenantId: string;
    existed: boolean;
    accountsLinked: number;
    viewersSynced: number;
    publicView: boolean;
  }> = [];

  for (const t of tenants) {
    const slug = String(t.slug || '').trim().toLowerCase();
    const ownerEmail = String(t.google_email || '').trim().toLowerCase();
    if (!slug || !ownerEmail) continue;

    const rawOwnerName = String(t.name || slug).trim();
    const ownerName =
      slug === 'ecolifesignature' && rawOwnerName.toLowerCase() === 'ecolifesignature'
        ? 'Ecolife Signature'
        : rawOwnerName;
    const ownerGaId = await ensureGlobalAccountId(ownerEmail, ownerName);
    const isPublic = Number(t.is_public) === 1;
    const tenantStatus = String(t.status || '').toLowerCase() === 'trial' ? 'trial' : 'active';
    const expiresAtIso = parseSqlDateToIso(t.expires_at, tenantStatus === 'trial' ? 30 : 365);
    const industryRaw = inferIndustryFromSlug(slug);
    const indKey = normalizeIndustryKey(industryRaw);

    const existingTenant = await withSystemPrivilege(async (client) => {
      const r = await client.query<{ id: string; slug: string; package_code: string | null }>(
        `SELECT id, slug, package_code FROM tenants WHERE LOWER(slug) = $1 LIMIT 1`,
        [slug]
      );
      return r.rows[0] || null;
    });

    let tenantId: string;
    let existed = false;

    if (existingTenant) {
      existed = true;
      tenantId = existingTenant.id;
      await withTenantTransaction(tenantId, async (client) => {
        const curRes = await client.query<{ settings: Record<string, unknown> | null }>(
          `SELECT settings FROM tenants WHERE id = $1 LIMIT 1`,
          [tenantId]
        );
        const curSettings =
          curRes.rows[0]?.settings && typeof curRes.rows[0].settings === 'object'
            ? curRes.rows[0].settings
            : {};
        const nextSettings = {
          ...curSettings,
          dom_meta_public_view: isPublic,
        };
        await client.query(
          `UPDATE tenants
           SET status = $2,
               settings = $3::jsonb,
               updated_at = clock_timestamp()
           WHERE id = $1`,
          [tenantId, tenantStatus, JSON.stringify(nextSettings)]
        );

        const ownerUserRes = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
          [tenantId, ownerEmail]
        );
        if (!ownerUserRes.rows[0]) {
          const newOwnerId = crypto.randomUUID();
          const passHash = await hashPassword(crypto.randomBytes(24).toString('hex'), APP_CONFIG.bcryptRounds);
          await client.query(
            `INSERT INTO users (id, account_id, tenant_id, email, password_hash, full_name, role, is_tenant_owner, is_external_agency)
             VALUES ($1, $2, $3, $4, $5, $6, 'tenant_admin', true, false)`,
            [newOwnerId, ownerGaId, tenantId, ownerEmail, passHash, ownerName]
          );
          await client.query(
            `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
             VALUES ($1, $2, 'active', false, false)
             ON CONFLICT DO NOTHING`,
            [tenantId, newOwnerId]
          );
        } else {
          await client.query(
            `UPDATE users
             SET account_id = COALESCE(account_id, $3),
                 role = 'tenant_admin',
                 is_tenant_owner = true
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, ownerUserRes.rows[0].id, ownerGaId]
          );
        }
      });
    } else {
      tenantId = crypto.randomUUID();
      const adminUserId = crypto.randomUUID();
      const pkgCode = 'growth_combo' as const;
      const eduAddon = indKey === 'education';
      const initModules = buildModulesForPackage(pkgCode, { educationAddon: eduAddon });
      const initEnt = {
        package_code: pkgCode,
        package_name: SAAS_PACKAGES_CATALOG[pkgCode].name,
        package_badge: SAAS_PACKAGES_CATALOG[pkgCode].badge,
        education_addon: eduAddon,
        enable_ideas_mascot: slug.startsWith('ideas'),
      };
      const tenantSettings = {
        ...DEFAULT_TENANT_SETTINGS,
        dom_meta_public_view: isPublic,
      };
      const passHash = await hashPassword(crypto.randomBytes(24).toString('hex'), APP_CONFIG.bcryptRounds);
      const isTrial = tenantStatus === 'trial';

      await withTenantTransaction(tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenants (
             id, slug, name, industry, industry_key, package_code, plan_tier,
             enabled_modules, entitlements, status,
             trial_ends_at, subscription_expires_at, subscription_plan_code, billing_cycle,
             wallet_balance_vnd, crm_erp_upgrade_status, settings
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8::jsonb, $9::jsonb, $10,
             $11::timestamptz, $12::timestamptz, $13, $14,
             0, 'none', $15::jsonb
           )`,
          [
            tenantId,
            slug,
            ownerName,
            industryRaw,
            indKey,
            pkgCode,
            pkgCode,
            JSON.stringify(initModules),
            JSON.stringify(initEnt),
            tenantStatus,
            expiresAtIso,
            isTrial ? null : expiresAtIso,
            isTrial ? 'trial_1m' : 'pro_growth',
            isTrial ? 'trial' : 'yearly',
            JSON.stringify(tenantSettings),
          ]
        );

        await client.query(
          `INSERT INTO users (id, account_id, tenant_id, email, password_hash, full_name, role, is_tenant_owner, is_external_agency)
           VALUES ($1, $2, $3, $4, $5, $6, 'tenant_admin', true, false)`,
          [adminUserId, ownerGaId, tenantId, ownerEmail, passHash, ownerName]
        );

        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
           VALUES ($1, $2, 'active', false, false)
           ON CONFLICT DO NOTHING`,
          [tenantId, adminUserId]
        );

        await seedTenantWorkspace(client, {
          tenantId,
          tenantSlug: slug,
          adminUserId,
          adminName: ownerName,
          industry: industryRaw,
          options: { seedDemoLeads: false },
        });
      });
    }

    // Migrate viewers & admins from saas_tenant_viewers
    const viewersForTenant = allViewers.filter(
      (v) => String(v.tenant_slug || '').trim().toLowerCase() === slug && String(v.status || '').toLowerCase() === 'active'
    );
    let viewersSynced = 0;
    for (const v of viewersForTenant) {
      const vEmail = String(v.email || '').trim().toLowerCase();
      if (!vEmail || !vEmail.includes('@')) continue;
      const vName = String(v.name || vEmail.split('@')[0] || 'Viewer').trim();
      const vRole = String(v.role || '').toLowerCase() === 'admin' ? 'tenant_admin' : 'viewer';
      const vGaId = await ensureGlobalAccountId(vEmail, vName);

      await withTenantTransaction(tenantId, async (client) => {
        const uRes = await client.query<{ id: string; is_tenant_owner: boolean }>(
          `SELECT id, is_tenant_owner FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1`,
          [tenantId, vEmail]
        );
        if (uRes.rows[0]) {
          if (!uRes.rows[0].is_tenant_owner) {
            await client.query(
              `UPDATE users
               SET account_id = COALESCE(account_id, $3),
                   role = $4,
                   full_name = COALESCE(NULLIF($5, ''), full_name)
               WHERE tenant_id = $1 AND id = $2`,
              [tenantId, uRes.rows[0].id, vGaId, vRole, v.name ? vName : '']
            );
          } else {
            await client.query(
              `UPDATE users SET account_id = COALESCE(account_id, $3) WHERE tenant_id = $1 AND id = $2`,
              [tenantId, uRes.rows[0].id, vGaId]
            );
          }
          await client.query(
            `UPDATE tenant_user_profiles SET status = 'active' WHERE tenant_id = $1 AND user_id = $2`,
            [tenantId, uRes.rows[0].id]
          );
        } else {
          const vUserId = crypto.randomUUID();
          const vPassHash = await hashPassword(crypto.randomBytes(24).toString('hex'), APP_CONFIG.bcryptRounds);
          await client.query(
            `INSERT INTO users (id, account_id, tenant_id, email, password_hash, full_name, role, is_tenant_owner, is_external_agency)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, false)`,
            [vUserId, vGaId, tenantId, vEmail, vPassHash, vName, vRole]
          );
          await client.query(
            `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
             VALUES ($1, $2, 'active', false, false)
             ON CONFLICT DO NOTHING`,
            [tenantId, vUserId]
          );
        }
      });
      viewersSynced += 1;
    }

    // Migrate Meta Ad Accounts + DOM Meta Workspace Config
    const parsedAccounts = extractAccountsFromLegacyTenant(t);
    const primaryNorm = normalizeAdAccountId(t.ad_account_id) || parsedAccounts[0]?.ad_account_id || '';
    const tenantSettingRows = allSettings.filter(
      (s) => String(s.tenant_slug || '').trim().toLowerCase() === slug
    );

    const pickSetting = (key: string): string | null => {
      const matchingPrimary = tenantSettingRows.find(
        (s) => s.setting_key === key && normalizeAdAccountId(s.account_id) === primaryNorm
      );
      if (matchingPrimary) return matchingPrimary.setting_value;
      const fallback = tenantSettingRows.find((s) => s.setting_key === key);
      return fallback ? fallback.setting_value : null;
    };

    const configPatch: Record<string, unknown> = {
      primary_ad_account_id: primaryNorm,
      public_view: isPublic,
    };

    const rawBrands = parseJsonSafe<any[]>(pickSetting('dom_brand_filters'));
    if (Array.isArray(rawBrands)) {
      configPatch.brand_filters = rawBrands.map((b, idx) => ({
        id: String(b?.id || `brand_${idx + 1}`),
        name: String(b?.name || '').trim(),
        filter: String(b?.filter || '').trim(),
        avatar: String(b?.avatar || b?.img || '').trim(),
      }));
    }

    const rawGoalKeywords = parseJsonSafe<string[]>(pickSetting('goal_keywords'));
    if (Array.isArray(rawGoalKeywords)) {
      configPatch.goal_keywords = rawGoalKeywords;
    }

    const rawGoalMode = parseJsonSafe<string>(pickSetting('goal_chart_mode')) || pickSetting('goal_chart_mode');
    if (rawGoalMode === 'goal' || rawGoalMode === 'brand' || rawGoalMode === 'keyword') {
      configPatch.goal_chart_mode = rawGoalMode;
    }

    const rawSummary = parseJsonSafe<string[]>(pickSetting('dom_summary_metrics'));
    if (Array.isArray(rawSummary) && rawSummary.length === 3) {
      configPatch.summary_metrics = rawSummary;
    }

    const rawColumns = parseJsonSafe<Record<string, unknown>>(pickSetting('dom_column_config'));
    if (rawColumns && typeof rawColumns === 'object') {
      configPatch.column_config = rawColumns;
    }

    const rawPresets = parseJsonSafe<any[]>(pickSetting('dom_view_presets'));
    if (Array.isArray(rawPresets)) {
      configPatch.view_presets = rawPresets;
    }

    const aiReportsForTenant = allAiReports
      .filter((r) => String(r.tenant_slug || '').trim().toLowerCase() === slug)
      .map((r) => ({
        id: String(r.local_id || `legacy_air_${r.id}`),
        timestamp: String(r.timestamp || ''),
        label: String(r.label || 'Báo cáo AI'),
        brand: String(r.brand || 'Tất cả'),
        date_range: String(r.dateRange || ''),
        preview: String(r.preview || ''),
        html: String(r.html || ''),
        plain_text: '',
      }));
    if (aiReportsForTenant.length > 0) {
      configPatch.ai_reports = aiReportsForTenant;
    }

    const rawGadsCid =
      parseJsonSafe<string>(pickSetting('google_ads_customer_id')) ||
      pickSetting('google_ads_customer_id') ||
      (slug === 'ecolifesignature' ? '295-339-0933' : '');
    const rawGadsDevTok =
      parseJsonSafe<string>(pickSetting('google_ads_developer_token')) ||
      pickSetting('google_ads_developer_token') ||
      (slug === 'ecolifesignature' ? 'oBqM_GUwxCs4t-leZtW6pQ' : '');
    const rawGadsApiUrl =
      parseJsonSafe<string>(pickSetting('google_ads_api_url')) ||
      pickSetting('google_ads_api_url') ||
      (slug === 'ecolifesignature'
        ? 'https://script.google.com/macros/s/AKfycby0BDtgLxuC8xN-grb9lXZk4ISK9C0NN77muj48YQ6GmpfsAF7RzfRa7uyrMjBonHs3/exec'
        : '');
    const rawGadsEnabledSetting = pickSetting('dom_google_ads_enabled');
    const gadsEnabled =
      rawGadsEnabledSetting !== null
        ? rawGadsEnabledSetting === 'true' || rawGadsEnabledSetting === '1'
        : Boolean(rawGadsCid && rawGadsApiUrl);

    if (rawGadsCid || rawGadsApiUrl) {
      configPatch.google_ads = {
        enabled: gadsEnabled,
        customer_id: String(rawGadsCid || '').trim(),
        apps_script_url: String(rawGadsApiUrl || '').trim(),
        developer_token: String(rawGadsDevTok || '').trim(),
      };
    }

    if (slug === 'ecolifesignature') {
      if (!configPatch.goal_keywords) {
        configPatch.goal_keywords = ['Reach', 'Engagement', 'View', 'Message', 'Traffic', 'Lead'];
      }
      if (!configPatch.goal_chart_mode) {
        configPatch.goal_chart_mode = 'keyword';
      }
    }

    await withTenantTransaction(tenantId, async (client) => {
      for (const acc of parsedAccounts) {
        await upsertMetaAdAccount(client, tenantId, {
          ad_account_id: acc.ad_account_id,
          name: acc.name,
          access_token: acc.access_token,
          is_active: true,
        });
      }
      await saveDomMetaWorkspaceConfig(client, tenantId, configPatch);
    });

    summary.push({
      slug,
      tenantId,
      existed,
      accountsLinked: parsedAccounts.length,
      viewersSynced,
      publicView: isPublic,
    });
    console.log(
      `  ✓ ${slug} (${existed ? 'updated' : 'created'}): ${parsedAccounts.length} Meta accounts, ${viewersSynced} viewers, public=${isPublic}`
    );
  }

  if (pool.isEmbedded) {
    const conn = await pool.connect();
    try {
      await conn.query('CHECKPOINT;');
    } finally {
      conn.release();
    }
  }
  await pool.close();

  console.log(`[Migrate] Done! Total processed: ${summary.length} workspaces.`);
}

main().catch((err) => {
  console.error('[Migrate] FATAL:', err);
  process.exit(1);
});
