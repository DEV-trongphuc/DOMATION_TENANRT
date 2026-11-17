import type { DbClient } from '../database/db-adapter.ts';
import { withSystemPrivilege } from '../database/transaction.ts';

export interface CronLimitsConfig {
  sla_batch_limit: number;
  drain_batch_limit: number;
  capi_retry_limit: number;
  webhook_retry_limit: number;
  billing_batch_limit: number;
  webhook_max_retries: number;
  webhook_backoff_seconds: number[];
}

export interface IndustryPresetOverride {
  label?: string;
  default_lead_source?: string;
}

export interface PlatformOperationalConfig {
  cron_limits: CronLimitsConfig;
  industry_preset_overrides: Record<string, IndustryPresetOverride>;
}

export const DEFAULT_PLATFORM_OPERATIONAL_CONFIG: PlatformOperationalConfig = {
  cron_limits: {
    sla_batch_limit: 100,
    drain_batch_limit: 100,
    capi_retry_limit: 15,
    webhook_retry_limit: 20,
    billing_batch_limit: 25,
    webhook_max_retries: 10,
    webhook_backoff_seconds: [120, 300, 900, 3600, 14400],
  },
  industry_preset_overrides: {},
};

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.min(max, Math.max(min, num)));
}

export function normalizePlatformOperationalConfig(raw: unknown): PlatformOperationalConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawCron =
    obj.cron_limits && typeof obj.cron_limits === 'object'
      ? (obj.cron_limits as Record<string, unknown>)
      : obj;

  let backoff = [...DEFAULT_PLATFORM_OPERATIONAL_CONFIG.cron_limits.webhook_backoff_seconds];
  if (Array.isArray(rawCron.webhook_backoff_seconds) && rawCron.webhook_backoff_seconds.length > 0) {
    const cleaned = rawCron.webhook_backoff_seconds
      .slice(0, 8)
      .map((v) => clampInt(v, 120, 30, 86400));
    if (cleaned.length > 0) backoff = cleaned;
  }

  const rawOverrides =
    obj.industry_preset_overrides && typeof obj.industry_preset_overrides === 'object'
      ? (obj.industry_preset_overrides as Record<string, unknown>)
      : {};
  const cleanedOverrides: Record<string, IndustryPresetOverride> = {};
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (!k || !v || typeof v !== 'object') continue;
    const item = v as Record<string, unknown>;
    const key = k.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    if (!key) continue;
    cleanedOverrides[key] = {
      ...(typeof item.label === 'string' && item.label.trim() ? { label: item.label.trim().slice(0, 80) } : {}),
      ...(typeof item.default_lead_source === 'string' && item.default_lead_source.trim()
        ? { default_lead_source: item.default_lead_source.trim().slice(0, 80) }
        : {}),
    };
  }

  return {
    cron_limits: {
      sla_batch_limit: clampInt(
        rawCron.sla_batch_limit,
        DEFAULT_PLATFORM_OPERATIONAL_CONFIG.cron_limits.sla_batch_limit,
        10,
        500
      ),
      drain_batch_limit: clampInt(
        rawCron.drain_batch_limit,
        DEFAULT_PLATFORM_OPERATIONAL_CONFIG.cron_limits.drain_batch_limit,
        10,
        500
      ),
      capi_retry_limit: clampInt(
        rawCron.capi_retry_limit,
        DEFAULT_PLATFORM_OPERATIONAL_CONFIG.cron_limits.capi_retry_limit,
        5,
        200
      ),
      webhook_retry_limit: clampInt(
        rawCron.webhook_retry_limit,
        DEFAULT_PLATFORM_OPERATIONAL_CONFIG.cron_limits.webhook_retry_limit,
        5,
        200
      ),
      billing_batch_limit: clampInt(
        rawCron.billing_batch_limit,
        DEFAULT_PLATFORM_OPERATIONAL_CONFIG.cron_limits.billing_batch_limit,
        5,
        500
      ),
      webhook_max_retries: clampInt(
        rawCron.webhook_max_retries,
        DEFAULT_PLATFORM_OPERATIONAL_CONFIG.cron_limits.webhook_max_retries,
        1,
        20
      ),
      webhook_backoff_seconds: backoff,
    },
    industry_preset_overrides: cleanedOverrides,
  };
}

let cachedOpsConfig: PlatformOperationalConfig | null = null;
let cachedOpsExpiresAt = 0;
const OPS_CACHE_TTL_MS = 5_000;

export function invalidatePlatformOperationalConfigCache(): void {
  cachedOpsConfig = null;
  cachedOpsExpiresAt = 0;
}

export async function getPlatformOperationalConfigCached(
  existingClient?: DbClient
): Promise<PlatformOperationalConfig> {
  const now = Date.now();
  if (cachedOpsConfig && now < cachedOpsExpiresAt) {
    return cachedOpsConfig;
  }
  try {
    const queryFn = async (client: DbClient) => {
      const r = await client.query<{ setting_value: Record<string, unknown> }>(
        "SELECT setting_value FROM platform_settings WHERE setting_key = 'operational_limits' LIMIT 1"
      );
      return r.rows[0]?.setting_value || {};
    };
    const raw = existingClient
      ? await queryFn(existingClient)
      : await withSystemPrivilege((client) => queryFn(client));
    cachedOpsConfig = normalizePlatformOperationalConfig(raw);
    cachedOpsExpiresAt = Date.now() + OPS_CACHE_TTL_MS;
    return cachedOpsConfig;
  } catch {
    return DEFAULT_PLATFORM_OPERATIONAL_CONFIG;
  }
}
