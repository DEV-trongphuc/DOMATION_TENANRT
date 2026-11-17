import { withSystemPrivilege } from '../../core/database/transaction.ts';
import { getPlatformOperationalConfigCached } from '../../core/settings/platform-config.ts';
import { replayWebhookDlqItem } from '../../services/webhook.service.ts';

export async function runWebhookDlqRetryWorker(tenantIdFilter?: string): Promise<number> {
  const opsCfg = await getPlatformOperationalConfigCached();
  const limits = opsCfg.cron_limits;
  const toMin = (idx: number, defMin: number) => {
    const sec = limits.webhook_backoff_seconds[idx];
    return Number.isFinite(sec) ? Math.max(1, Math.round(sec / 60)) : defMin;
  };
  const candidates = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT id, tenant_id, retry_count, last_attempt_at
      FROM tenant_webhook_dlq
      WHERE retry_count < ${limits.webhook_max_retries}
        AND last_attempt_at <= clock_timestamp() - (
          CASE 
            WHEN retry_count <= 5 THEN INTERVAL '${toMin(0, 2)} minutes'
            WHEN retry_count = 6 THEN INTERVAL '${toMin(1, 5)} minutes'
            WHEN retry_count = 7 THEN INTERVAL '${toMin(2, 15)} minutes'
            WHEN retry_count = 8 THEN INTERVAL '${toMin(3, 60)} minutes'
            ELSE INTERVAL '${toMin(4, 240)} minutes'
          END
        )
        ${tenantIdFilter ? 'AND tenant_id = $1' : ''}
      ORDER BY last_attempt_at ASC
      LIMIT ${limits.webhook_retry_limit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows;
  });

  let replayedCount = 0;
  for (const item of candidates) {
    try {
      const outcome = await replayWebhookDlqItem(item.tenant_id, item.id);
      if (outcome.replayed) {
        replayedCount += 1;
      }
    } catch {
      // Handled inside replayWebhookDlqItem
    }
  }

  return replayedCount;
}
