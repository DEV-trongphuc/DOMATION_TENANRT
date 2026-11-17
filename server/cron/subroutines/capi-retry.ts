import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantIntegrationCached } from '../../core/settings/tenant-cache.ts';
import { decryptTenantSecret } from '../../core/crypto/vault.ts';
import { isOutboundSilentMode } from '../../core/security/outbound-guard.ts';
import { getPlatformOperationalConfigCached } from '../../core/settings/platform-config.ts';
import type { MetaCapiConfig } from '../../services/capi.service.ts';

type CapiRetryFetcherFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
let customCapiRetryFetcher: CapiRetryFetcherFn | null = null;

export function setCapiRetryFetcherForTesting(fn: CapiRetryFetcherFn | null): void {
  customCapiRetryFetcher = fn;
}

export async function runMetaCapiRetryWorker(tenantIdFilter?: string): Promise<number> {
  const opsCfg = await getPlatformOperationalConfigCached();
  const capiRetryLimit = opsCfg.cron_limits.capi_retry_limit;
  const failedLogs = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT c.id, c.tenant_id, c.lead_id, c.dataset_id, c.event_name, c.event_id,
             c.sent_payload, c.response_status
      FROM capi_logs c
      WHERE c.response_status IN (429, 500, 502, 503, 504)
        AND c.sent_at >= clock_timestamp() - INTERVAL '24 hours'
        AND c.sent_at <= clock_timestamp() - INTERVAL '3 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM capi_logs c2
          WHERE c2.tenant_id = c.tenant_id
            AND c2.lead_id = c.lead_id
            AND c2.event_name = c.event_name
            AND c2.response_status = 200
        )
        ${tenantIdFilter ? 'AND c.tenant_id = $1' : ''}
      ORDER BY c.sent_at ASC
      LIMIT ${capiRetryLimit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows;
  });

  if (failedLogs.length === 0) return 0;

  let retriedSuccess = 0;
  for (const log of failedLogs) {
    // 1. Retrieve cached integration metadata with ZERO long-held transactions
    const integRow = await getTenantIntegrationCached(log.tenant_id, 'meta_capi');
    if (!integRow || integRow.status !== 'active') continue;

    let cfg: MetaCapiConfig;
    try {
      cfg = decryptTenantSecret<MetaCapiConfig>(
        log.tenant_id,
        integRow.config_encrypted,
        integRow.iv,
        integRow.auth_tag
      );
    } catch {
      continue;
    }

    const payload = typeof log.sent_payload === 'string'
      ? JSON.parse(log.sent_payload)
      : (log.sent_payload || {});
    const cleanVersion = cfg.api_version || 'v21.0';
    const url = `https://graph.facebook.com/${cleanVersion}/${encodeURIComponent(cfg.dataset_id)}/events?access_token=${encodeURIComponent(cfg.access_token)}`;

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
          signal: AbortSignal.timeout(cfg.timeout_ms || 8000),
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
          signal: AbortSignal.timeout(cfg.timeout_ms || 8000),
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

    // 3. Open a brief transaction ONLY to record retry results and update status
    await withTenantTransaction(log.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO capi_logs (
           tenant_id, lead_id, dataset_id, event_name, event_id, action_source,
           match_keys, sent_payload, response_status, response_body, sent_at
         ) VALUES ($1, $2, $3, $4, $5, 'system_cron_retry', '{}'::jsonb, $6::jsonb, $7, $8::jsonb, clock_timestamp())`,
        [
          log.tenant_id,
          log.lead_id,
          cfg.dataset_id,
          log.event_name,
          log.event_id,
          JSON.stringify(payload),
          responseStatus,
          JSON.stringify(responseBody),
        ]
      );
    });

    if (isSuccess) {
      retriedSuccess += 1;
    }
  }

  return retriedSuccess;
}
