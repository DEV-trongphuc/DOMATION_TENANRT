import { getDatabasePool, type DbClient } from '../core/database/db-adapter.ts';
import { runMigrations } from '../core/database/migrate.ts';
import { runDirectDbSlaSweeper } from './subroutines/sla-sweeper.ts';
import { runUnassignedLeadDrainer } from './subroutines/lead-drainer.ts';
import { runZaloTokenRefresher } from './subroutines/zalo-refresher.ts';
import { runSubscriptionExpiryManager } from './subroutines/billing-manager.ts';
import { runWebhookDlqRetryWorker } from './subroutines/webhook-retry.ts';
import { runMetaCapiRetryWorker } from './subroutines/capi-retry.ts';

const LOCK_KEY_PG = `hashtext('autodata_master_cron_lock')`;
const LOCK_KEY_MARIADB = `'autodata_master_cron_lock'`;

export interface CronRunStats {
  durationMs: number;
  slaBreachedCount: number;
  leadsDrainedCount: number;
  zaloRefreshedCount: number;
  subscriptionsProcessed: number;
  webhooksReplayedCount: number;
  capiRetriedCount: number;
  errors: string[];
}

export async function executeMasterCron(options?: {
  subroutines?: string[];
  tenantId?: string;
  forceLock?: boolean;
}): Promise<{ locked: boolean; stats: CronRunStats }> {
  const startTime = Date.now();
  const stats: CronRunStats = {
    durationMs: 0,
    slaBreachedCount: 0,
    leadsDrainedCount: 0,
    zaloRefreshedCount: 0,
    subscriptionsProcessed: 0,
    webhooksReplayedCount: 0,
    capiRetriedCount: 0,
    errors: [],
  };

  const pool = getDatabasePool();
  let lockClient: DbClient | null = null;
  let lockAcquired = false;
  const isMariaDb = pool.dialect === 'mariadb' || process.env.DB_DIALECT === 'mariadb';

  try {
    if (options?.forceLock) {
      console.log('[MasterCron] Advisory lock already held by another active run. Exiting cleanly (zero overlap).');
      return { locked: true, stats };
    }

    if (pool.isEmbedded) {
      // In embedded PGlite single-connection mutex, test advisory lock and release checkout
      const checkClient = await pool.connect();
      try {
        const res = await checkClient.query<{ lock_acquired: boolean }>(
          `SELECT pg_try_advisory_lock(${LOCK_KEY_PG}) AS lock_acquired`
        );
        lockAcquired = Boolean(res.rows[0]?.lock_acquired);
      } finally {
        checkClient.release();
      }
    } else {
      lockClient = await pool.connect();
      if (isMariaDb) {
        const res = await lockClient.query<{ lock_acquired: number | null }>(
          `SELECT GET_LOCK(${LOCK_KEY_MARIADB}, 0) AS lock_acquired`
        );
        lockAcquired = Number(res.rows[0]?.lock_acquired) === 1;
      } else {
        const res = await lockClient.query<{ lock_acquired: boolean }>(
          `SELECT pg_try_advisory_lock(${LOCK_KEY_PG}) AS lock_acquired`
        );
        lockAcquired = Boolean(res.rows[0]?.lock_acquired);
      }
    }

    if (!lockAcquired) {
      console.log('[MasterCron] Advisory lock already held by another active run. Exiting cleanly (zero overlap).');
      return { locked: true, stats };
    }

    console.log(
      `[MasterCron] Lock acquired (${isMariaDb ? 'MariaDB GET_LOCK' : 'PostgreSQL pg_try_advisory_lock'}). Starting consolidated subroutines...`
    );

    const requestedSubroutines = options?.subroutines || ['sla', 'drain', 'zalo', 'billing', 'webhook', 'capi'];

    // Subroutine A: Direct DB SLA Sweeper
    if (requestedSubroutines.includes('sla')) {
      try {
        stats.slaBreachedCount = await runDirectDbSlaSweeper(options?.tenantId);
      } catch (err: any) {
        stats.errors.push(`Subroutine A (SLA): ${err?.message}`);
        console.error('[MasterCron] Error in Subroutine A (SLA):', err);
      }
    }

    // Subroutine B: Unassigned Lead Drainer
    if (requestedSubroutines.includes('drain')) {
      try {
        stats.leadsDrainedCount = await runUnassignedLeadDrainer(options?.tenantId);
      } catch (err: any) {
        stats.errors.push(`Subroutine B (Drain): ${err?.message}`);
        console.error('[MasterCron] Error in Subroutine B (Drain):', err);
      }
    }

    // Subroutine C: Zalo Token Refresher
    if (requestedSubroutines.includes('zalo')) {
      try {
        const res = await runZaloTokenRefresher(options?.tenantId);
        stats.zaloRefreshedCount = res.refreshedCount;
      } catch (err: any) {
        stats.errors.push(`Subroutine C (Zalo): ${err?.message}`);
        console.error('[MasterCron] Error in Subroutine C (Zalo):', err);
      }
    }

    // Subroutine D: Subscription & Trial Expiry Manager
    if (requestedSubroutines.includes('billing')) {
      try {
        stats.subscriptionsProcessed = await runSubscriptionExpiryManager(options?.tenantId);
      } catch (err: any) {
        stats.errors.push(`Subroutine D (Billing): ${err?.message}`);
        console.error('[MasterCron] Error in Subroutine D (Billing):', err);
      }
    }

    // Subroutine E: Outbound Webhook DLQ Retry Worker
    if (requestedSubroutines.includes('webhook')) {
      try {
        stats.webhooksReplayedCount = await runWebhookDlqRetryWorker(options?.tenantId);
      } catch (err: any) {
        stats.errors.push(`Subroutine E (Webhook): ${err?.message}`);
        console.error('[MasterCron] Error in Subroutine E (Webhook):', err);
      }
    }

    // Subroutine F: Meta CAPI Transient Error Retry Worker
    if (requestedSubroutines.includes('capi')) {
      try {
        stats.capiRetriedCount = await runMetaCapiRetryWorker(options?.tenantId);
      } catch (err: any) {
        stats.errors.push(`Subroutine F (CAPI): ${err?.message}`);
        console.error('[MasterCron] Error in Subroutine F (CAPI):', err);
      }
    }
  } finally {
    if (pool.isEmbedded) {
      try {
        const unlockClient = await pool.connect();
        try {
          await unlockClient.query(`SELECT pg_advisory_unlock(${LOCK_KEY_PG}) AS lock_released`);
        } finally {
          unlockClient.release();
        }
      } catch {}
    } else if (lockClient && lockAcquired) {
      try {
        if (isMariaDb) {
          await lockClient.query(`SELECT RELEASE_LOCK(${LOCK_KEY_MARIADB}) AS lock_released`);
        } else {
          await lockClient.query(`SELECT pg_advisory_unlock(${LOCK_KEY_PG}) AS lock_released`);
        }
        console.log('[MasterCron] Advisory lock released cleanly.');
      } catch (err) {
        console.error('[MasterCron] Warning: Failed to release advisory lock:', err);
      } finally {
        lockClient.release();
      }
    }
    stats.durationMs = Date.now() - startTime;
  }

  return { locked: false, stats };
}

// CLI Execution Guard
const isDirectCli =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('master-cron.ts') || process.argv[1].endsWith('master-cron.js') || process.env.CRON_CLI === 'true');

if (isDirectCli) {
  runMigrations()
    .then(() => executeMasterCron())
    .then(({ locked, stats }) => {
      if (locked) {
        process.exit(0);
      }
      console.log(
        `[MasterCron] Completed in ${stats.durationMs}ms. Results: SLA breached=${stats.slaBreachedCount}, Leads drained=${stats.leadsDrainedCount}, Zalo refreshed=${stats.zaloRefreshedCount}, Subs processed=${stats.subscriptionsProcessed}, Webhooks=${stats.webhooksReplayedCount}, CAPI=${stats.capiRetriedCount}. Errors=${stats.errors.length}`
      );
      process.exit(stats.errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('[MasterCron] Fatal execution error:', err);
      process.exit(1);
    });
}
