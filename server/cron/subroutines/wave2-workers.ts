import crypto from 'node:crypto';
import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { domainEventBus } from '../../core/events/event-bus.ts';

async function cronTableExists(client: DbClient, tableName: string): Promise<boolean> {
  if (client.dialect === 'mariadb') {
    const res = await client.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = $1`,
      [tableName]
    );
    return Number(res.rows[0]?.cnt || 0) > 0;
  }
  const res = await client.query<{ exists: string | null }>(
    `SELECT to_regclass('public.' || $1)::text AS exists`,
    [tableName]
  );
  return Boolean(res.rows[0]?.exists);
}

/**
 * Resumes `waiting` automation flow enrollments whose `next_run_at` has elapsed.
 */
export async function runMarketingFlowsWorker(tenantIdFilter?: string): Promise<number> {
  const candidates = await withSystemPrivilege(async (client) => {
    if (!(await cronTableExists(client, 'mkt_flow_enrollments'))) return [];
    const now = new Date();
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id, flow_id, lead_id, current_step_id
         FROM mkt_flow_enrollments
         WHERE status = 'waiting' AND next_run_at IS NOT NULL AND next_run_at <= $1 AND tenant_id = $2
         ORDER BY next_run_at ASC
         LIMIT 50`
      : `SELECT id, tenant_id, flow_id, lead_id, current_step_id
         FROM mkt_flow_enrollments
         WHERE status = 'waiting' AND next_run_at IS NOT NULL AND next_run_at <= $1
         ORDER BY next_run_at ASC
         LIMIT 50`;
    const res = await client.query<{
      id: string;
      tenant_id: string;
      flow_id: string;
      lead_id: string;
      current_step_id: string | null;
    }>(sql, tenantIdFilter ? [now, tenantIdFilter] : [now]);
    return res.rows;
  });

  if (candidates.length === 0) return 0;

  let executeFlowFn:
    | ((
        tenantId: string,
        flowId: string,
        leadId: string,
        options?: { actorId?: string | null; skipWaitDelay?: boolean }
      ) => Promise<any>)
    | null = null;
  try {
    const mod = await import('../../modules/marketing/flow-engine.service.ts');
    if (typeof mod.executeFlowForLead === 'function') {
      executeFlowFn = mod.executeFlowForLead;
    }
  } catch {
    return 0;
  }

  let processed = 0;
  for (const row of candidates) {
    try {
      await withTenantTransaction(row.tenant_id, async (client) => {
        await client.query(
          `UPDATE mkt_flow_enrollments
           SET status = 'resumed', next_run_at = NULL
           WHERE tenant_id = $1 AND id = $2 AND status = 'waiting'`,
          [row.tenant_id, row.id]
        );
      });
      if (executeFlowFn) {
        await executeFlowFn(row.tenant_id, row.flow_id, row.lead_id, { skipWaitDelay: true });
      }
      processed++;
    } catch {
      await withTenantTransaction(row.tenant_id, async (client) => {
        await client.query(
          `UPDATE mkt_flow_enrollments
           SET status = 'failed'
           WHERE tenant_id = $1 AND id = $2 AND status IN ('waiting', 'resumed')`,
          [row.tenant_id, row.id]
        );
      }).catch(() => {});
    }
  }
  return processed;
}

/**
 * Transitions due `scheduled` marketing campaigns into active dispatch (`sent`) and records idempotent send claims.
 */
export async function runMarketingCampaignsWorker(tenantIdFilter?: string): Promise<number> {
  const dueCampaigns = await withSystemPrivilege(async (client) => {
    if (!(await cronTableExists(client, 'mkt_campaigns'))) return [];
    const now = new Date();
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id, name, channel, audience_id, ab_split_ratio
         FROM mkt_campaigns
         WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= $1 AND tenant_id = $2
         ORDER BY scheduled_at ASC
         LIMIT 25`
      : `SELECT id, tenant_id, name, channel, audience_id, ab_split_ratio
         FROM mkt_campaigns
         WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= $1
         ORDER BY scheduled_at ASC
         LIMIT 25`;
    const res = await client.query<{
      id: string;
      tenant_id: string;
      name: string;
      channel: string;
      audience_id: string | null;
      ab_split_ratio: number;
    }>(sql, tenantIdFilter ? [now, tenantIdFilter] : [now]);
    return res.rows;
  });

  if (dueCampaigns.length === 0) return 0;

  let processed = 0;
  for (const camp of dueCampaigns) {
    const claimed = await withTenantTransaction(camp.tenant_id, async (client) => {
      let claimedTargets = 0;
      const hasMembers = camp.audience_id && (await cronTableExists(client, 'tenant_audience_members'));
      const hasClaims = await cronTableExists(client, 'mkt_send_claims');
      if (hasMembers && hasClaims && camp.audience_id) {
        const members = await client.query<{ lead_id: string }>(
          `SELECT lead_id FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 LIMIT 500`,
          [camp.tenant_id, camp.audience_id]
        );
        for (const m of members.rows) {
          const ins = await client.query(
            `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, variant, status, sent_at, metadata)
             VALUES ($1, $2, $3, $4, $5, 'A', 'sent', clock_timestamp(), $6::jsonb)
             ON CONFLICT (tenant_id, campaign_id, lead_id, channel) DO NOTHING`,
            [
              crypto.randomUUID(),
              camp.tenant_id,
              camp.id,
              m.lead_id,
              camp.channel || 'email',
              JSON.stringify({ source: 'cron_scheduler' }),
            ]
          );
          if ((ins.rowCount || 0) > 0) claimedTargets++;
        }
      }

      const upd = await client.query(
        `UPDATE mkt_campaigns
         SET status = 'sent',
             sent_at = COALESCE(sent_at, clock_timestamp()),
             sent_count = GREATEST(sent_count, $3),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'scheduled'`,
        [camp.tenant_id, camp.id, claimedTargets]
      );
      return (upd.rowCount || 0) > 0;
    });
    if (claimed) processed++;
  }

  return processed;
}

/**
 * Re-evaluates dynamic logic audiences across active tenants.
 */
export async function runAudienceReevalWorker(tenantIdFilter?: string): Promise<number> {
  const tenantIds = await withSystemPrivilege(async (client) => {
    if (!(await cronTableExists(client, 'tenant_audiences'))) return [];
    const sql = tenantIdFilter
      ? `SELECT DISTINCT tenant_id
         FROM tenant_audiences
         WHERE is_active = true AND audience_type = 'dynamic_logic' AND tenant_id = $1`
      : `SELECT DISTINCT tenant_id
         FROM tenant_audiences
         WHERE is_active = true AND audience_type = 'dynamic_logic'`;
    const res = await client.query<{ tenant_id: string }>(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows.map((r) => r.tenant_id);
  });

  if (tenantIds.length === 0) return 0;

  let evaluateAllFn: ((tenantId: string) => Promise<void>) | null = null;
  try {
    const mod = await import('../../modules/audiences/audiences.service.ts');
    if (typeof mod.evaluateAllDynamicAudiencesForTenant === 'function') {
      evaluateAllFn = mod.evaluateAllDynamicAudiencesForTenant;
    }
  } catch {
    return 0;
  }
  if (!evaluateAllFn) return 0;

  let reevaluated = 0;
  for (const tid of tenantIds) {
    await evaluateAllFn(tid);
    reevaluated++;
  }
  return reevaluated;
}

/**
 * Auto-confirms pending employee timesheet confirmations whose `deadline_at` deadline has passed
 * and closes their confirmation batch cleanly.
 */
export async function runAttendanceConfirmWorker(tenantIdFilter?: string): Promise<number> {
  const batches = await withSystemPrivilege(async (client) => {
    const hasBatches = await cronTableExists(client, 'tenant_attendance_confirmation_batches');
    const hasConfirmations = await cronTableExists(client, 'tenant_attendance_confirmations');
    if (!hasBatches || !hasConfirmations) return [];

    const now = new Date();
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id
         FROM tenant_attendance_confirmation_batches
         WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= $1 AND tenant_id = $2
         ORDER BY deadline_at ASC
         LIMIT 50`
      : `SELECT id, tenant_id
         FROM tenant_attendance_confirmation_batches
         WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= $1
         ORDER BY deadline_at ASC
         LIMIT 50`;
    const res = await client.query<{ id: string; tenant_id: string }>(
      sql,
      tenantIdFilter ? [now, tenantIdFilter] : [now]
    );
    return res.rows;
  });

  if (batches.length === 0) return 0;

  let totalUpdated = 0;
  for (const batch of batches) {
    const updatedInBatch = await withTenantTransaction(batch.tenant_id, async (client) => {
      const autoRes = await client.query(
        `UPDATE tenant_attendance_confirmations
         SET status = 'auto_confirmed',
             confirmed_at = COALESCE(confirmed_at, clock_timestamp()),
             confirmed_by_type = COALESCE(confirmed_by_type, 'cron'),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND batch_id = $2 AND status = 'pending'`,
        [batch.tenant_id, batch.id]
      );

      await client.query(
        `UPDATE tenant_attendance_confirmation_batches
         SET status = 'closed',
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'open'`,
        [batch.tenant_id, batch.id]
      );

      return Math.max(1, Number(autoRes.rowCount || 0));
    });
    totalUpdated += updatedInBatch;
  }

  return totalUpdated;
}

/**
 * Dispatches eligible marketing campaign follow-up reminders and marks overdue deposit milestones.
 */
export async function runRemindersWorker(tenantIdFilter?: string): Promise<number> {
  let processed = 0;

  // 1. Marketing Campaign Follow-up Reminders
  const reminderRules = await withSystemPrivilege(async (client) => {
    const hasReminders = await cronTableExists(client, 'mkt_campaign_reminders');
    const hasClaims = await cronTableExists(client, 'mkt_send_claims');
    if (!hasReminders || !hasClaims) return [];
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id, campaign_id, trigger_condition, wait_hours
         FROM mkt_campaign_reminders
         WHERE is_active = true AND tenant_id = $1
         ORDER BY step_order ASC
         LIMIT 50`
      : `SELECT id, tenant_id, campaign_id, trigger_condition, wait_hours
         FROM mkt_campaign_reminders
         WHERE is_active = true
         ORDER BY step_order ASC
         LIMIT 50`;
    const res = await client.query<{
      id: string;
      tenant_id: string;
      campaign_id: string;
      trigger_condition: string;
      wait_hours: number;
    }>(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows;
  });

  for (const rem of reminderRules) {
    const cutoff = new Date(Date.now() - Math.max(1, Number(rem.wait_hours || 24)) * 3600_000);
    const cond =
      rem.trigger_condition === 'no_click'
        ? 'clicked_at IS NULL'
        : rem.trigger_condition === 'all'
          ? '1=1'
          : 'opened_at IS NULL';
    const dispatched = await withTenantTransaction(rem.tenant_id, async (client) => {
      const upd = await client.query(
        `UPDATE mkt_send_claims
         SET reminder_sent = true
         WHERE tenant_id = $1
           AND campaign_id = $2
           AND status = 'sent'
           AND reminder_sent = false
           AND sent_at IS NOT NULL
           AND sent_at <= $3
           AND ${cond}`,
        [rem.tenant_id, rem.campaign_id, cutoff]
      );
      const count = Number(upd.rowCount || 0);
      if (count > 0) {
        await client.query(
          `UPDATE mkt_campaign_reminders
           SET dispatched_count = dispatched_count + $3,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [rem.tenant_id, rem.id, count]
        );
      }
      return count;
    });
    processed += dispatched;
  }

  // 2. Deposit Milestones Due/Overdue Sweep
  const dueMilestones = await withSystemPrivilege(async (client) => {
    if (!(await cronTableExists(client, 'tenant_deposit_milestones'))) return [];
    const todayIso = new Date().toISOString().slice(0, 10);
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id
         FROM tenant_deposit_milestones
         WHERE status = 'pending' AND expected_pay_date IS NOT NULL AND expected_pay_date < $1 AND tenant_id = $2
         LIMIT 100`
      : `SELECT id, tenant_id
         FROM tenant_deposit_milestones
         WHERE status = 'pending' AND expected_pay_date IS NOT NULL AND expected_pay_date < $1
         LIMIT 100`;
    const res = await client.query<{ id: string; tenant_id: string }>(
      sql,
      tenantIdFilter ? [todayIso, tenantIdFilter] : [todayIso]
    );
    return res.rows;
  });

  for (const ms of dueMilestones) {
    await withTenantTransaction(ms.tenant_id, async (client) => {
      const upd = await client.query(
        `UPDATE tenant_deposit_milestones
         SET status = 'overdue', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
        [ms.tenant_id, ms.id]
      );
      processed += Number(upd.rowCount || 0);
    });
  }

  return processed;
}

/**
 * Drains `tenant_domain_events_outbox` pending events via the in-process CrossModuleEventBus.
 */
export async function runOutboxEventsWorker(tenantIdFilter?: string): Promise<number> {
  const pendingEvents = await withSystemPrivilege(async (client) => {
    if (!(await cronTableExists(client, 'tenant_domain_events_outbox'))) return [];
    const now = new Date();
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id, event_type, payload_json, retry_count, max_retries
         FROM tenant_domain_events_outbox
         WHERE status IN ('pending', 'failed') AND retry_count < max_retries AND next_retry_at <= $1 AND tenant_id = $2
         ORDER BY created_at ASC
         LIMIT 50`
      : `SELECT id, tenant_id, event_type, payload_json, retry_count, max_retries
         FROM tenant_domain_events_outbox
         WHERE status IN ('pending', 'failed') AND retry_count < max_retries AND next_retry_at <= $1
         ORDER BY created_at ASC
         LIMIT 50`;
    const res = await client.query<{
      id: string;
      tenant_id: string;
      event_type: string;
      payload_json: Record<string, any>;
      retry_count: number;
      max_retries: number;
    }>(sql, tenantIdFilter ? [now, tenantIdFilter] : [now]);
    return res.rows;
  });

  if (pendingEvents.length === 0) return 0;

  let processed = 0;
  for (const evt of pendingEvents) {
    try {
      const payload =
        evt.payload_json && typeof evt.payload_json === 'object' ? evt.payload_json : {};
      await domainEventBus.emit(evt.event_type as any, {
        ...payload,
        tenantId: evt.tenant_id,
      } as any);
      await withTenantTransaction(evt.tenant_id, async (client) => {
        await client.query(
          `UPDATE tenant_domain_events_outbox
           SET status = 'processed',
               processed_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [evt.tenant_id, evt.id]
        );
      });
      processed++;
    } catch (err: any) {
      const nextRetry = new Date(Date.now() + 5 * 60_000);
      await withTenantTransaction(evt.tenant_id, async (client) => {
        await client.query(
          `UPDATE tenant_domain_events_outbox
           SET retry_count = retry_count + 1,
               status = CASE WHEN retry_count + 1 >= max_retries THEN 'dead_letter' ELSE 'failed' END,
               next_retry_at = $3,
               last_error = $4,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [evt.tenant_id, evt.id, nextRetry, String(err?.message || 'outbox_dispatch_error').slice(0, 500)]
        );
      }).catch(() => {});
    }
  }

  return processed;
}

/**
 * Records a cron subroutine execution entry in `tenant_cron_runs` if present.
 */
export async function recordCronRunLog(entry: {
  tenantId?: string;
  subroutine: string;
  status: 'success' | 'partial' | 'error' | 'skipped';
  processedCount: number;
  errorCount: number;
  durationMs: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const errMsg = entry.details?.error ? String(entry.details.error).slice(0, 500) : null;
    const writeRun = async (client: DbClient) => {
      if (!(await cronTableExists(client, 'tenant_cron_runs'))) return;
      await client.query(
        `INSERT INTO tenant_cron_runs (
           tenant_id, subroutine_key, status, items_processed, duration_ms, error_message, details_json, triggered_by, started_at, finished_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'scheduler', clock_timestamp(), clock_timestamp())`,
        [
          entry.tenantId || null,
          entry.subroutine,
          entry.status,
          entry.processedCount,
          Math.max(0, Math.round(entry.durationMs)),
          errMsg,
          JSON.stringify({ ...(entry.details || {}), error_count: entry.errorCount }),
        ]
      );
    };

    if (entry.tenantId) {
      await withTenantTransaction(entry.tenantId, writeRun);
    } else {
      await withSystemPrivilege(writeRun);
    }
  } catch {
    // Logging cron history must never abort the master cron runner
  }
}
