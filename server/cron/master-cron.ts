import fs from 'node:fs';
import path from 'node:path';
import { APP_CONFIG } from '../config.ts';
import { getDatabasePool, type DbClient } from '../core/database/db-adapter.ts';
import { runMigrations } from '../core/database/migrate.ts';
import { runDirectDbSlaSweeper } from './subroutines/sla-sweeper.ts';
import { runUnassignedLeadDrainer } from './subroutines/lead-drainer.ts';
import { runZaloTokenRefresher } from './subroutines/zalo-refresher.ts';
import { runSubscriptionExpiryManager } from './subroutines/billing-manager.ts';
import { runWebhookDlqRetryWorker } from './subroutines/webhook-retry.ts';
import { runMetaCapiRetryWorker } from './subroutines/capi-retry.ts';
import { runDailyReportWorker } from './subroutines/daily-report.ts';
import {
  recordCronRunLog,
  runAttendanceConfirmWorker,
  runAudienceReevalWorker,
  runMarketingCampaignsWorker,
  runMarketingFlowsWorker,
  runOutboxEventsWorker,
  runRemindersWorker,
} from './subroutines/wave2-workers.ts';
import { ensureZnsDispatcherRegistered } from '../services/zalo-zns.service.ts';

const LOCK_KEY_PG = `hashtext('autodata_master_cron_lock')`;
const LOCK_KEY_MARIADB = `'autodata_master_cron_lock'`;

export const ALL_CRON_SUBROUTINES = [
  'sla',
  'drain',
  'zalo',
  'billing',
  'webhook',
  'capi',
  'marketing_flows',
  'marketing_campaigns',
  'audience_reeval',
  'attendance_confirm',
  'reminders',
  'outbox_events',
  'daily_report',
] as const;

export interface CronRunStats {
  durationMs: number;
  slaBreachedCount: number;
  leadsDrainedCount: number;
  zaloRefreshedCount: number;
  subscriptionsProcessed: number;
  webhooksReplayedCount: number;
  capiRetriedCount: number;
  marketingFlowsProcessed: number;
  marketingCampaignsProcessed: number;
  audiencesReevalCount: number;
  attendanceConfirmationsCount: number;
  remindersDispatchedCount: number;
  outboxEventsProcessed: number;
  dailyReportsDispatchedCount: number;
  errors: string[];
}

export async function executeMasterCron(options?: {
  subroutines?: string[];
  tenantId?: string;
  forceLock?: boolean;
}): Promise<{ locked: boolean; stats: CronRunStats }> {
  ensureZnsDispatcherRegistered();
  const startTime = Date.now();
  const stats: CronRunStats = {
    durationMs: 0,
    slaBreachedCount: 0,
    leadsDrainedCount: 0,
    zaloRefreshedCount: 0,
    subscriptionsProcessed: 0,
    webhooksReplayedCount: 0,
    capiRetriedCount: 0,
    marketingFlowsProcessed: 0,
    marketingCampaignsProcessed: 0,
    audiencesReevalCount: 0,
    attendanceConfirmationsCount: 0,
    remindersDispatchedCount: 0,
    outboxEventsProcessed: 0,
    dailyReportsDispatchedCount: 0,
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

    const requestedSubroutines = options?.subroutines || [...ALL_CRON_SUBROUTINES];

    const runLoggedSubroutine = async (
      key: string,
      label: string,
      fn: () => Promise<number>,
      assign: (count: number) => void
    ) => {
      if (!requestedSubroutines.includes(key)) return;
      const subStart = Date.now();
      let processed = 0;
      let errCount = 0;
      let errMsg: string | undefined;
      try {
        processed = await fn();
        assign(processed);
      } catch (err: any) {
        errCount = 1;
        errMsg = `${label}: ${err?.message}`;
        stats.errors.push(errMsg);
        console.error(`[MasterCron] Error in ${label}:`, err);
      }
      await recordCronRunLog({
        tenantId: options?.tenantId,
        subroutine: key,
        status: errCount > 0 ? 'error' : 'success',
        processedCount: processed,
        errorCount: errCount,
        durationMs: Date.now() - subStart,
        details: errMsg ? { error: errMsg } : {},
      });
    };

    await runLoggedSubroutine('sla', 'Subroutine A (SLA)', () => runDirectDbSlaSweeper(options?.tenantId), (n) => {
      stats.slaBreachedCount = n;
    });
    await runLoggedSubroutine('drain', 'Subroutine B (Drain)', () => runUnassignedLeadDrainer(options?.tenantId), (n) => {
      stats.leadsDrainedCount = n;
    });
    await runLoggedSubroutine(
      'zalo',
      'Subroutine C (Zalo)',
      async () => (await runZaloTokenRefresher(options?.tenantId)).refreshedCount,
      (n) => {
        stats.zaloRefreshedCount = n;
      }
    );
    await runLoggedSubroutine(
      'billing',
      'Subroutine D (Billing)',
      () => runSubscriptionExpiryManager(options?.tenantId),
      (n) => {
        stats.subscriptionsProcessed = n;
      }
    );
    await runLoggedSubroutine(
      'webhook',
      'Subroutine E (Webhook)',
      () => runWebhookDlqRetryWorker(options?.tenantId),
      (n) => {
        stats.webhooksReplayedCount = n;
      }
    );
    await runLoggedSubroutine(
      'capi',
      'Subroutine F (CAPI)',
      () => runMetaCapiRetryWorker(options?.tenantId),
      (n) => {
        stats.capiRetriedCount = n;
      }
    );
    await runLoggedSubroutine(
      'marketing_flows',
      'Subroutine G (Marketing Flows)',
      () => runMarketingFlowsWorker(options?.tenantId),
      (n) => {
        stats.marketingFlowsProcessed = n;
      }
    );
    await runLoggedSubroutine(
      'marketing_campaigns',
      'Subroutine H (Marketing Campaigns)',
      () => runMarketingCampaignsWorker(options?.tenantId),
      (n) => {
        stats.marketingCampaignsProcessed = n;
      }
    );
    await runLoggedSubroutine(
      'audience_reeval',
      'Subroutine I (Audience Reeval)',
      () => runAudienceReevalWorker(options?.tenantId),
      (n) => {
        stats.audiencesReevalCount = n;
      }
    );
    await runLoggedSubroutine(
      'attendance_confirm',
      'Subroutine J (Attendance Confirm)',
      () => runAttendanceConfirmWorker(options?.tenantId),
      (n) => {
        stats.attendanceConfirmationsCount = n;
      }
    );
    await runLoggedSubroutine(
      'reminders',
      'Subroutine K (Reminders)',
      () => runRemindersWorker(options?.tenantId),
      (n) => {
        stats.remindersDispatchedCount = n;
      }
    );
    await runLoggedSubroutine(
      'outbox_events',
      'Subroutine L (Outbox Events)',
      () => runOutboxEventsWorker(options?.tenantId),
      (n) => {
        stats.outboxEventsProcessed = n;
      }
    );
    await runLoggedSubroutine(
      'daily_report',
      'Subroutine M (Daily Report)',
      () => runDailyReportWorker(options?.tenantId),
      (n) => {
        stats.dailyReportsDispatchedCount = n;
      }
    );
  } finally {
    if (pool.isEmbedded) {
      try {
        const unlockClient = await pool.connect();
        try {
          await unlockClient.query(`SELECT pg_advisory_unlock(${LOCK_KEY_PG}) AS lock_released`);
          if (unlockClient.exec) {
            await unlockClient.exec('CHECKPOINT;');
          } else {
            await unlockClient.query('CHECKPOINT;');
          }
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

export function shouldRefuseDirectCliPglite(options?: {
  pgliteDataDir?: string;
  databaseUrl?: string;
  allowOfflinePgliteCron?: string;
}): boolean {
  const dbUrl = (options?.databaseUrl ?? APP_CONFIG.databaseUrl ?? '').trim();
  if (dbUrl) return false;
  const allow = (options?.allowOfflinePgliteCron ?? process.env.ALLOW_OFFLINE_PGLITE_CRON ?? '').trim();
  if (allow === 'true') return false;
  const dataDir = path.resolve(options?.pgliteDataDir ?? APP_CONFIG.pgliteDataDir);
  return fs.existsSync(path.join(dataDir, 'postmaster.pid'));
}

// CLI Execution Guard
const isDirectCli =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('master-cron.ts') || process.argv[1].endsWith('master-cron.js') || process.env.CRON_CLI === 'true');

if (isDirectCli) {
  if (shouldRefuseDirectCliPglite()) {
    console.error(
      `[MasterCron] Refusing direct CLI execution against PGlite (${APP_CONFIG.pgliteDataDir}): postmaster.pid exists and ALLOW_OFFLINE_PGLITE_CRON !== 'true'.`
    );
    process.exit(1);
  }
  runMigrations()
    .then(() => executeMasterCron())
    .then(({ locked, stats }) => {
      if (locked) {
        process.exit(0);
      }
      console.log(
        `[MasterCron] Completed in ${stats.durationMs}ms. Results: SLA=${stats.slaBreachedCount}, Drain=${stats.leadsDrainedCount}, Zalo=${stats.zaloRefreshedCount}, Billing=${stats.subscriptionsProcessed}, Webhooks=${stats.webhooksReplayedCount}, CAPI=${stats.capiRetriedCount}, Flows=${stats.marketingFlowsProcessed}, Campaigns=${stats.marketingCampaignsProcessed}, Audiences=${stats.audiencesReevalCount}, AttConfirm=${stats.attendanceConfirmationsCount}, Reminders=${stats.remindersDispatchedCount}, Outbox=${stats.outboxEventsProcessed}, DailyReports=${stats.dailyReportsDispatchedCount}. Errors=${stats.errors.length}`
      );
      process.exit(stats.errors.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('[MasterCron] Fatal execution error:', err);
      process.exit(1);
    });
}
