import type { DbClient } from '../database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../database/transaction.ts';
import {
  tenantRedis,
  type CachedBlacklistEntry,
  type CachedBlacklistSnapshot,
  type CachedDistributionCustomFieldDef,
  type CachedDistributionPipelineStage,
  type CachedDistributionRoutingRule,
  type CachedDistributionSnapshot,
  type CachedGatekeeperConfig,
  type CachedGatekeeperPreflight,
  type CachedGatekeeperSharedAi,
  type CachedOutboundWebhookItem,
  type CachedTenantBillingPolicy,
  type CachedTenantIntegrationRecord,
} from '../cache/tenant-redis.ts';
import {
  normalizeTenantSettings,
  DEFAULT_TENANT_SETTINGS,
  type TenantSettings,
} from './tenant-settings.ts';
import { validateAndNormalizePhone } from '../../services/phone.service.ts';

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

export async function getGatekeeperPreflightCached(
  tenantId: string,
  resolveSharedAi: (client: DbClient, tenantId: string) => Promise<CachedGatekeeperSharedAi>
): Promise<CachedGatekeeperPreflight> {
  if (!tenantId) return { gk: null, sharedAi: null };
  const cached = tenantRedis.getCachedGatekeeperPreflight(tenantId);
  if (cached) return cached;

  const preflight = await withTenantTransaction(tenantId, async (client) => {
    const gkRes = await client.query<CachedGatekeeperConfig>(
      `SELECT is_enabled, mode, model_name, manual_action, manual_rules, prompt_rules,
              target_round_ids, fallback_enabled, fallback_round_id
       FROM ai_screener_configs
       WHERE tenant_id = $1 AND is_enabled = true
       LIMIT 1`,
      [tenantId]
    );
    const gk = gkRes.rows[0] || null;
    if (!gk || !gk.is_enabled) {
      return { gk: null, sharedAi: null };
    }
    const modeLower = String(gk.mode || 'ai').trim().toLowerCase();
    if (modeLower !== 'ai' && modeLower !== 'hybrid') {
      return { gk, sharedAi: null };
    }
    const sharedAi = await resolveSharedAi(client, tenantId);
    return { gk, sharedAi };
  });

  tenantRedis.setCachedGatekeeperPreflight(tenantId, preflight);
  return preflight;
}

export async function getTenantBillingPolicyCached(
  tenantId: string,
  existingClient?: DbClient
): Promise<CachedTenantBillingPolicy | null> {
  if (!tenantId) return null;

  const cached = tenantRedis.getCachedTenantBillingPolicy(tenantId);
  if (cached) return cached;

  const queryPolicy = async (client: DbClient) => {
    const r = await client.query<CachedTenantBillingPolicy>(
      `SELECT plan_tier, package_code, status, auto_renew, cancel_at_period_end, grace_ends_at,
              created_at, trial_ends_at, subscription_expires_at,
              subscription_plan_code, billing_cycle, crm_erp_upgrade_status
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    );
    return r.rows[0] || null;
  };

  const row = existingClient
    ? await queryPolicy(existingClient)
    : await withSystemPrivilege((client) => queryPolicy(client));

  if (!row) return null;

  tenantRedis.setCachedTenantBillingPolicy(tenantId, row);
  return row;
}

export async function getTenantIntegrationsBatchCached(
  tenantId: string,
  integrationTypes: string[],
  existingClient?: DbClient
): Promise<Record<string, CachedTenantIntegrationRecord | null>> {
  const result: Record<string, CachedTenantIntegrationRecord | null> = {};
  if (!tenantId || integrationTypes.length === 0) return result;

  const missingTypes: string[] = [];
  for (const t of integrationTypes) {
    const cached = tenantRedis.getCachedTenantIntegration(tenantId, t);
    if (cached.hit) {
      result[t] = cached.record;
    } else {
      missingTypes.push(t);
    }
  }

  if (missingTypes.length === 0) {
    return result;
  }

  const queryBatch = async (client: DbClient) => {
    const r = await client.query<CachedTenantIntegrationRecord & { integration_type: string }>(
      `SELECT integration_type, status, config_encrypted, iv, auth_tag, token_expires_at
       FROM tenant_integrations
       WHERE tenant_id = $1 AND integration_type = ANY($2::varchar[])`,
      [tenantId, missingTypes]
    );
    return r.rows;
  };

  const rows = existingClient
    ? await queryBatch(existingClient)
    : await withTenantTransaction(tenantId, queryBatch);

  const byType = new Map<string, CachedTenantIntegrationRecord>();
  for (const row of rows) {
    byType.set(row.integration_type, {
      status: row.status,
      config_encrypted: row.config_encrypted,
      iv: row.iv,
      auth_tag: row.auth_tag,
      token_expires_at: row.token_expires_at,
    });
  }

  for (const t of missingTypes) {
    const rec = byType.get(t) || null;
    tenantRedis.setCachedTenantIntegration(tenantId, t, rec);
    result[t] = rec;
  }

  return result;
}

export async function getTenantDistributionSnapshotCached(
  tenantId: string,
  client: DbClient
): Promise<CachedDistributionSnapshot | null> {
  if (!tenantId) return null;

  const cached = tenantRedis.getCachedDistributionSnapshot(tenantId);
  if (cached) return cached;

  const pipeRes = await client.query<{ id: string }>(
    'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC',
    [tenantId]
  );
  const defaultPipelineId = pipeRes.rows[0]?.id;
  if (!defaultPipelineId) {
    return null;
  }

  const stageRes = await client.query<CachedDistributionPipelineStage & { pipeline_id: string }>(
    `SELECT pipeline_id, id, stage_name, sla_timeout_minutes, capi_event_mapping, is_won_stage, is_lost_stage
     FROM tenant_pipeline_stages
     WHERE tenant_id = $1
     ORDER BY stage_order ASC`,
    [tenantId]
  );
  const firstStagesByPipeline: Record<string, CachedDistributionPipelineStage> = {};
  for (const st of stageRes.rows) {
    if (!firstStagesByPipeline[st.pipeline_id]) {
      firstStagesByPipeline[st.pipeline_id] = {
        id: st.id,
        stage_name: st.stage_name,
        sla_timeout_minutes: st.sla_timeout_minutes,
        capi_event_mapping: st.capi_event_mapping,
        is_won_stage: st.is_won_stage,
        is_lost_stage: st.is_lost_stage,
      };
    }
  }

  const cfRes = await client.query<CachedDistributionCustomFieldDef & { pipeline_id: string }>(
    `SELECT pipeline_id, field_key, field_label, field_type, is_required, options_json, config_json
     FROM tenant_pipeline_custom_fields
     WHERE tenant_id = $1`,
    [tenantId]
  );
  const customFieldsByPipeline: Record<string, CachedDistributionCustomFieldDef[]> = {};
  for (const cf of cfRes.rows) {
    if (!customFieldsByPipeline[cf.pipeline_id]) {
      customFieldsByPipeline[cf.pipeline_id] = [];
    }
    customFieldsByPipeline[cf.pipeline_id].push({
      field_key: cf.field_key,
      field_label: cf.field_label,
      field_type: cf.field_type,
      is_required: cf.is_required,
      options_json: cf.options_json,
      config_json: cf.config_json,
    });
  }

  const roundRes = await client.query<{ id: string; pipeline_id: string }>(
    `SELECT id, pipeline_id
     FROM distribution_rounds
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY priority ASC, created_at ASC`,
    [tenantId]
  );
  const activeRoundIds: string[] = [];
  const defaultActiveRoundByPipeline: Record<string, string | null> = {};
  for (const r of roundRes.rows) {
    activeRoundIds.push(r.id);
    if (defaultActiveRoundByPipeline[r.pipeline_id] === undefined) {
      defaultActiveRoundByPipeline[r.pipeline_id] = r.id;
    }
  }

  const rulesRes = await client.query<CachedDistributionRoutingRule>(
    `SELECT r.round_id, dr.pipeline_id, r.conditions_json, r.condition_branches, r.connection_scopes, r.inject_fields
     FROM routing_rules r
     INNER JOIN distribution_rounds dr ON dr.tenant_id = r.tenant_id AND dr.id = r.round_id
     WHERE r.tenant_id = $1 AND r.is_active = true AND dr.is_active = true
     ORDER BY r.priority ASC`,
    [tenantId]
  );

  const snapshot: CachedDistributionSnapshot = {
    defaultPipelineId,
    firstStagesByPipeline,
    customFieldsByPipeline,
    defaultActiveRoundByPipeline,
    activeRoundIds,
    activeRoutingRules: rulesRes.rows,
  };

  if (firstStagesByPipeline[defaultPipelineId]) {
    tenantRedis.setCachedDistributionSnapshot(tenantId, snapshot);
  }
  return snapshot;
}

export async function getTenantBlacklistCached(
  tenantId: string,
  client: DbClient
): Promise<CachedBlacklistSnapshot> {
  const cached = tenantRedis.getCachedBlacklist(tenantId);
  if (cached) return cached;

  const blRes = await client.query<CachedBlacklistEntry>(
    `SELECT id, entry_type, value, reason
     FROM blacklist_entries
     WHERE tenant_id = $1
     LIMIT 2001`,
    [tenantId]
  );

  if (blRes.rows.length > 2000) {
    const overflowSnapshot: CachedBlacklistSnapshot = {
      overflow: true,
      phoneMap: new Map(),
      emailMap: new Map(),
      keywordsAndIps: [],
    };
    tenantRedis.setCachedBlacklist(tenantId, overflowSnapshot);
    return overflowSnapshot;
  }

  const phoneMap = new Map<string, CachedBlacklistEntry>();
  const emailMap = new Map<string, CachedBlacklistEntry>();
  const keywordsAndIps: Array<{ entry: CachedBlacklistEntry; needle: string }> = [];

  for (const row of blRes.rows) {
    if (row.entry_type === 'phone') {
      const rawPhone = String(row.value || '').trim();
      if (rawPhone) phoneMap.set(rawPhone, row);
      const parsedPhone = validateAndNormalizePhone(rawPhone);
      if (parsedPhone.valid && parsedPhone.normalizedE164) {
        phoneMap.set(parsedPhone.normalizedE164, row);
      }
    } else if (row.entry_type === 'email') {
      const emailKey = String(row.value || '').trim().toLowerCase();
      if (emailKey) emailMap.set(emailKey, row);
    } else if (row.entry_type === 'keyword' || row.entry_type === 'ip') {
      const needle = String(row.value || '').trim().toLowerCase();
      if (needle.length > 0) {
        keywordsAndIps.push({ entry: row, needle });
      }
    }
  }

  const snapshot: CachedBlacklistSnapshot = {
    overflow: false,
    phoneMap,
    emailMap,
    keywordsAndIps,
  };
  tenantRedis.setCachedBlacklist(tenantId, snapshot);
  return snapshot;
}
