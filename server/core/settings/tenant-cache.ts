import type { DbClient } from '../database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../database/transaction.ts';
import {
  tenantRedis,
  type CachedOutboundWebhookItem,
  type CachedTenantIntegrationRecord,
} from '../cache/tenant-redis.ts';
import {
  normalizeTenantSettings,
  DEFAULT_TENANT_SETTINGS,
  type TenantSettings,
} from './tenant-settings.ts';

export interface ResolvedTenantMeta {
  slug: string;
  name?: string;
  status: string;
  rawSettings: Record<string, unknown>;
  settings: TenantSettings;
}

/**
 * Loads tenant metadata (`slug`, `name`, `status`, and normalized `TenantSettings`) from
 * tenant-isolated memory cache first, falling back to PostgreSQL on cache miss.
 * Eliminates repeated `SELECT settings FROM tenants` roundtrips + normalization CPU
 * across thousands of concurrent API & webhook calls per second.
 */
export async function getTenantMetaCached(
  tenantId: string,
  existingClient?: DbClient
): Promise<ResolvedTenantMeta | null> {
  if (!tenantId) return null;

  const cached = tenantRedis.getCachedTenantMeta(tenantId);
  if (cached) {
    const normalized: TenantSettings =
      cached.normalizedSettings || normalizeTenantSettings(cached.rawSettings);
    return {
      slug: cached.slug,
      name: cached.name,
      status: cached.status,
      rawSettings: cached.rawSettings,
      settings: normalized,
    };
  }

  const queryRow = async (client: DbClient) => {
    const r = await client.query<{
      slug: string;
      name: string | null;
      status: string;
      settings: Record<string, unknown>;
    }>('SELECT slug, name, status, settings FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
    return r.rows[0] || null;
  };

  const row = existingClient
    ? await queryRow(existingClient)
    : await withSystemPrivilege((client) => queryRow(client));

  if (!row) {
    return null;
  }

  const rawSettings = (row.settings && typeof row.settings === 'object' ? row.settings : {}) as Record<
    string,
    unknown
  >;
  const normalized = normalizeTenantSettings(rawSettings);

  tenantRedis.setCachedTenantMeta(tenantId, {
    slug: row.slug,
    name: row.name || undefined,
    status: row.status,
    rawSettings,
    normalizedSettings: normalized,
  });

  return {
    slug: row.slug,
    name: row.name || undefined,
    status: row.status,
    rawSettings,
    settings: normalized,
  };
}

export async function getTenantSettingsCached(
  tenantId: string,
  existingClient?: DbClient
): Promise<TenantSettings> {
  const meta = await getTenantMetaCached(tenantId, existingClient);
  return meta ? meta.settings : DEFAULT_TENANT_SETTINGS;
}

export async function getPlatformDefaultsCached(
  existingClient?: DbClient
): Promise<Record<string, unknown>> {
  const cached = tenantRedis.getCachedPlatformDefaults();
  if (cached) return cached;

  const queryDefaults = async (client: DbClient) => {
    const r = await client
      .query<{ setting_value: Record<string, unknown> }>(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'default_tenant_settings' LIMIT 1"
      )
      .catch(() => ({ rows: [] }));
    return (r.rows[0]?.setting_value || {}) as Record<string, unknown>;
  };

  const raw = existingClient
    ? await queryDefaults(existingClient)
    : await withSystemPrivilege((client) => queryDefaults(client));

  tenantRedis.setCachedPlatformDefaults(raw);
  return raw;
}

export async function getOutboundWebhooksCached(
  tenantId: string
): Promise<CachedOutboundWebhookItem[]> {
  const cached = tenantRedis.getCachedOutboundWebhooks(tenantId);
  if (cached) return cached;

  const rows = await withTenantTransaction(tenantId, async (client) => {
    const res = await client.query<CachedOutboundWebhookItem>(
      `SELECT id, url, signing_secret, subscribed_events, field_mappings
       FROM tenant_webhooks
       WHERE tenant_id = $1 AND webhook_type = 'outbound' AND is_active = true`,
      [tenantId]
    );
    return res.rows;
  });

  tenantRedis.setCachedOutboundWebhooks(tenantId, rows);
  return rows;
}

export async function getTenantBySlugCached(
  slug: string
): Promise<{ id: string; slug: string; obfuscated_slug?: string; status: string } | null> {
  const clean = slug.trim().toLowerCase();
  if (!clean) return null;

  const cached = tenantRedis.getCachedTenantBySlug(clean);
  if (cached) return cached;

  const row = await withSystemPrivilege(async (client) => {
    const r = await client.query<{ id: string; slug: string; obfuscated_slug?: string; status: string }>(
      'SELECT id, slug, obfuscated_slug, status FROM tenants WHERE obfuscated_slug = $1 OR slug = $1 LIMIT 1',
      [clean]
    );
    return r.rows[0] || null;
  });

  if (row) {
    tenantRedis.setCachedTenantBySlug(clean, row);
    if (row.obfuscated_slug && row.obfuscated_slug.toLowerCase() !== clean) {
      tenantRedis.setCachedTenantBySlug(row.obfuscated_slug.toLowerCase(), row);
    }
    if (row.slug && row.slug.toLowerCase() !== clean) {
      tenantRedis.setCachedTenantBySlug(row.slug.toLowerCase(), row);
    }
  }
  return row;
}

export async function getTenantIntegrationCached(
  tenantId: string,
  integrationType: string,
  existingClient?: DbClient
): Promise<CachedTenantIntegrationRecord | null> {
  if (!tenantId || !integrationType) return null;

  const cached = tenantRedis.getCachedTenantIntegration(tenantId, integrationType);
  if (cached.hit) {
    return cached.record;
  }

  const queryRecord = async (client: DbClient) => {
    const r = await client.query<CachedTenantIntegrationRecord>(
      `SELECT status, config_encrypted, iv, auth_tag, token_expires_at
       FROM tenant_integrations
       WHERE tenant_id = $1 AND integration_type = $2
       LIMIT 1`,
      [tenantId, integrationType]
    );
    return r.rows[0] || null;
  };

  const row = existingClient
    ? await queryRecord(existingClient)
    : await withTenantTransaction(tenantId, queryRecord);

  tenantRedis.setCachedTenantIntegration(tenantId, integrationType, row);
  return row;
}
