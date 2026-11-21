import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import { getPlatformOperationalConfigCached } from '../../core/settings/platform-config.ts';
import {
  isLiveMetaCapiCredential,
  resolveEffectiveMetaCapiConfig,
} from '../../services/capi.service.ts';

type CapiRetryFetcherFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
let customCapiRetryFetcher: CapiRetryFetcherFn | null = null;

export function setCapiRetryFetcherForTesting(fn: CapiRetryFetcherFn | null): void {
  customCapiRetryFetcher = fn;
}

export const MAX_CAPI_RETRIES = 5;

export async function runMetaCapiRetryWorker(tenantIdFilter?: string): Promise<number> {
  const opsCfg = await getPlatformOperationalConfigCached();
  const capiRetryLimit = opsCfg.cron_limits.capi_retry_limit;
  const failedLogs = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT c.id, c.tenant_id, c.lead_id, c.dataset_id, c.event_name, c.event_id,
             c.sent_payload, c.response_status, COALESCE(c.retry_count, 0) AS retry_count
      FROM capi_logs c
      WHERE c.response_status IN (429, 500, 502, 503, 504)
        AND c.sent_at >= clock_timestamp() - INTERVAL '24 hours'
        AND c.sent_at <= clock_timestamp() - INTERVAL '3 minutes'
        AND (c.next_retry_at IS NULL OR c.next_retry_at <= clock_timestamp())
        AND COALESCE(c.retry_count, 0) < ${MAX_CAPI_RETRIES}
        AND COALESCE(c.action_source, '') <> 'system_cron_retry'
        AND NOT EXISTS (
          SELECT 1 FROM capi_logs c2
          WHERE c2.tenant_id = c.tenant_id
            AND c2.lead_id = c.lead_id
            AND c2.event_name = c.event_name
            AND c2.dataset_id = c.dataset_id
            AND (
              c2.response_status = 200
              OR COALESCE(c2.retry_count, 0) >= ${MAX_CAPI_RETRIES}
            )
        )
        ${tenantIdFilter ? 'AND c.tenant_id = $1' : ''}
      ORDER BY c.sent_at ASC
      LIMIT ${capiRetryLimit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows;
  });

  if (failedLogs.length === 0) return 0;

  // Deduplicate in-flight rows per (tenant_id, lead_id, event_name, dataset_id) in one tick
  const seenEventKeys = new Set<string>();
  const dedupedLogs: typeof failedLogs = [];
  for (const log of failedLogs) {
    const key = `${log.tenant_id}:${log.lead_id}:${log.event_name}:${log.dataset_id}`;
    if (seenEventKeys.has(key)) continue;
    seenEventKeys.add(key);
    dedupedLogs.push(log);
  }

  let retriedSuccess = 0;
  for (const log of dedupedLogs) {
    // 1. Resolve effective CAPI config (meta_capi OR facebook_ads Vault fallback) with ZERO long-held transactions
    const cfg = await resolveEffectiveMetaCapiConfig(log.tenant_id);
    const secondaryDatasetId = (cfg.agency_dataset_id || cfg.secondary_dataset_id || '').trim();
    const secondaryAccessToken = (cfg.agency_access_token || cfg.secondary_access_token || '').trim();
    const isSecondaryLog = Boolean(secondaryDatasetId && log.dataset_id === secondaryDatasetId);
    const targetDatasetId = isSecondaryLog ? secondaryDatasetId : (cfg.dataset_id || '').trim();
    const targetAccessToken = isSecondaryLog
      ? secondaryAccessToken || (cfg.access_token || '').trim()
      : (cfg.access_token || '').trim();

    if (!targetDatasetId || targetDatasetId === 'DEMO_DATASET_PIXEL' || !targetAccessToken) {
      continue;
    }

    const payload =
      typeof log.sent_payload === 'string'
        ? JSON.parse(log.sent_payload)
        : log.sent_payload || {};
    const cleanVersion = (cfg.api_version || 'v21.0').trim().replace(/^\/+/, '');
    const boundedTimeoutMs = Math.min(30_000, Math.max(1_000, Math.round(Number(cfg.timeout_ms || 8000))));
    const url = `https://graph.facebook.com/${encodeURIComponent(cleanVersion)}/${encodeURIComponent(
      targetDatasetId
    )}/events?access_token=${encodeURIComponent(targetAccessToken)}`;

    let responseStatus = 200;
    let responseBody: any = { mode: 'outbound_silent_guard', events_received: 1 };
    let isSuccess = false;

    // 2. Execute external HTTPS Graph API call with ZERO DB connections held
    if (customCapiRetryFetcher) {
      try {
        const resp = await customCapiRetryFetcher(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(boundedTimeoutMs),
        });
        responseStatus = resp.status;
        responseBody = await resp.json().catch(() => ({}));
        if (resp.status >= 200 && resp.status < 300) {
          isSuccess = true;
        }
      } catch (err: any) {
        responseStatus = 502;
        responseBody = { error: err?.message || String(err) };
      }
    } else if (
      cfg.live_http_enabled === false ||
      !isLiveMetaCapiCredential(targetDatasetId, targetAccessToken)
    ) {
      responseStatus = 200;
      responseBody = { mode: 'verified_sandbox', events_received: 1 };
      isSuccess = true;
    } else if (isOutboundSilentMode()) {
      responseStatus = 200;
      responseBody = { mode: 'outbound_silent_guard', events_received: 1 };
      isSuccess = true;
    } else {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(boundedTimeoutMs),
        });
        responseStatus = resp.status;
        responseBody = await resp.json().catch(() => ({}));
        if (resp.status >= 200 && resp.status < 300) {
          isSuccess = true;
        }
      } catch (err: any) {
        responseStatus = 502;
        responseBody = { error: err?.message || String(err) };
      }
    }

    const nextRetryCount = Number(log.retry_count || 0) + 1;
    const backoffMinutes = Math.min(60, 3 * Math.pow(2, Math.min(4, nextRetryCount)));
    const reachedRetryCap = nextRetryCount >= MAX_CAPI_RETRIES;
    const nextRetryAtIso =
      isSuccess || reachedRetryCap ? null : new Date(Date.now() + backoffMinutes * 60_000).toISOString();

    // 3. Open a brief transaction ONLY to record retry results and update retry backoff
    await withTenantTransaction(log.tenant_id, async (client) => {
      await client.query(
        `UPDATE capi_logs
         SET retry_count = $3,
             next_retry_at = $4::timestamptz
         WHERE tenant_id = $1 AND id = $2`,
        [log.tenant_id, log.id, nextRetryCount, nextRetryAtIso]
      );
      await client.query(
        `INSERT INTO capi_logs (
           tenant_id, lead_id, dataset_id, event_name, event_id, action_source,
           match_keys, sent_payload, response_status, response_body, retry_count, next_retry_at, sent_at
         ) VALUES ($1, $2, $3, $4, $5, 'system_cron_retry', '{}'::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10::timestamptz, clock_timestamp())`,
        [
          log.tenant_id,
          log.lead_id,
          targetDatasetId,
          log.event_name,
          log.event_id,
          JSON.stringify(payload),
          responseStatus,
          JSON.stringify(responseBody),
          nextRetryCount,
          nextRetryAtIso,
        ]
      );
    });

    if (isSuccess) {
      retriedSuccess += 1;
    }
  }

  return retriedSuccess;
}
