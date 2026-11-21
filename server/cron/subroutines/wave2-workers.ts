import crypto from 'node:crypto';
import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import type { DbClient } from '../../core/database/db-adapter.ts';
import { domainEventBus } from '../../core/events/event-bus.ts';
import { ensureZnsDispatcherRegistered } from '../../services/zalo-zns.service.ts';

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
 * Resumes `waiting` automation flow enrollments whose `next_run_at` has elapsed
 * and evaluates scheduled `birthday` / `inactivity` flow triggers.
 */
async function runScheduledFlowTriggers(tenantIdFilter?: string): Promise<number> {
  const scheduledFlows = await withSystemPrivilege(async (client) => {
    if (!(await cronTableExists(client, 'mkt_flows'))) return [];
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id, trigger_type, trigger_config
         FROM mkt_flows
         WHERE status = 'active' AND trigger_type IN ('birthday', 'inactivity') AND tenant_id = $1
         LIMIT 100`
      : `SELECT id, tenant_id, trigger_type, trigger_config
         FROM mkt_flows
         WHERE status = 'active' AND trigger_type IN ('birthday', 'inactivity')
         LIMIT 100`;
    const res = await client.query<{
      id: string;
      tenant_id: string;
      trigger_type: string;
      trigger_config: unknown;
    }>(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows;
  });

  if (scheduledFlows.length === 0) return 0;

  let executeFlowFn:
    | ((tenantId: string, flowId: string, leadId: string) => Promise<any>)
    | null = null;
  try {
    const mod = await import('../../modules/marketing/flow-engine.service.ts');
    if (typeof mod.executeFlowForLead === 'function') {
      executeFlowFn = mod.executeFlowForLead;
    }
  } catch {
    return 0;
  }
  if (!executeFlowFn) return 0;

  const now = new Date();
  const todayMonth = String(now.getUTCMonth() + 1).padStart(2, '0');
  const todayDay = String(now.getUTCDate()).padStart(2, '0');
  const mmDd = `${todayMonth}-${todayDay}`;
  let enrolled = 0;

  for (const flow of scheduledFlows) {
    let cfg: Record<string, unknown> = {};
    try {
      cfg =
        typeof flow.trigger_config === 'string'
          ? JSON.parse(flow.trigger_config || '{}')
          : ((flow.trigger_config as Record<string, unknown>) || {});
    } catch {
      cfg = {};
    }

    const matchingLeadIds = await withTenantTransaction(flow.tenant_id, async (client) => {
      if (flow.trigger_type === 'birthday') {
        const rows = await client.query<{ id: string; custom_fields: unknown }>(
          `SELECT l.id, l.custom_fields
           FROM leads l
           WHERE l.tenant_id = $1 AND l.is_deleted = false
             AND NOT EXISTS (
               SELECT 1 FROM mkt_flow_enrollments e
               WHERE e.tenant_id = l.tenant_id AND e.flow_id = $2 AND e.lead_id = l.id
                 AND e.enrolled_at >= clock_timestamp() - INTERVAL '300 days'
             )
           LIMIT 500`,
          [flow.tenant_id, flow.id]
        );
        const ids: string[] = [];
        for (const r of rows.rows) {
          const cf =
            typeof r.custom_fields === 'string'
              ? (() => {
                  try {
                    return JSON.parse(r.custom_fields || '{}');
                  } catch {
                    return {};
                  }
                })()
              : ((r.custom_fields as Record<string, unknown>) || {});
          const rawDob = String(cf.birthday || cf.dob || cf.birth_date || '').trim();
          if (rawDob && (rawDob.includes(mmDd) || rawDob.includes(`${todayDay}/${todayMonth}`))) {
            ids.push(r.id);
          }
        }
        return ids;
      }

      // `inactivity` trigger: contacts not engaged for >= N days (default 14)
      const parsedDays = Number(cfg.days ?? cfg.inactivity_days ?? cfg.inactive_days ?? 14);
      const safeDays = Number.isFinite(parsedDays) ? Math.max(1, Math.min(3650, Math.floor(parsedDays))) : 14;
      const rows = await client.query<{ id: string }>(
        `SELECT l.id
         FROM leads l
         WHERE l.tenant_id = $1 AND l.is_deleted = false
           AND COALESCE(l.last_engaged_at, l.updated_at, l.created_at) <= clock_timestamp() - INTERVAL '${safeDays} days'
           AND NOT EXISTS (
             SELECT 1 FROM mkt_flow_enrollments e
             WHERE e.tenant_id = l.tenant_id AND e.flow_id = $2 AND e.lead_id = l.id
           )
         LIMIT 50`,
        [flow.tenant_id, flow.id]
      );
      return rows.rows.map((r) => r.id);
    });

    for (const lid of matchingLeadIds) {
      await executeFlowFn(flow.tenant_id, flow.id, lid).catch(() => {});
      enrolled++;
    }
  }
  return enrolled;
}

export async function runMarketingFlowsWorker(tenantIdFilter?: string): Promise<number> {
  try {
    const mod = await import('../../modules/marketing/flow-engine.service.ts');
    if (typeof mod.registerFlowEventListeners === 'function') {
      mod.registerFlowEventListeners();
    }
  } catch {}

  const scheduledEnrolled = await runScheduledFlowTriggers(tenantIdFilter).catch(() => 0);

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

  if (candidates.length === 0) return scheduledEnrolled;

  let executeFlowFn:
    | ((
        tenantId: string,
        flowId: string,
        leadId: string,
        options?: {
          actorId?: string | null;
          skipWaitDelay?: boolean;
          enrollmentId?: string | null;
          resumeFromStepId?: string | null;
        }
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
      const claimed = await withTenantTransaction(row.tenant_id, async (client) => {
        const claimRes = await client.query(
          `UPDATE mkt_flow_enrollments
           SET status = 'resumed', next_run_at = NULL
           WHERE tenant_id = $1 AND id = $2 AND status = 'waiting'`,
          [row.tenant_id, row.id]
        );
        return (claimRes.rowCount || 0) > 0;
      });
      if (!claimed) continue;

      if (executeFlowFn) {
        await executeFlowFn(row.tenant_id, row.flow_id, row.lead_id, {
          enrollmentId: row.id,
          resumeFromStepId: row.current_step_id,
        });
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
  return processed + scheduledEnrolled;
}

/**
 * Atomically picks up due `scheduled` marketing campaigns (zero double-send) and dispatches
 * them through the 3-Phase High-Speed 14 mail/s Token-Bucket Engine (zero DB TX held during I/O).
 */
export async function runMarketingCampaignsWorker(tenantIdFilter?: string): Promise<number> {
  ensureZnsDispatcherRegistered();
  const dueCampaigns = await withSystemPrivilege(async (client) => {
    if (!(await cronTableExists(client, 'mkt_campaigns'))) return [];
    const now = new Date();
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id
         FROM mkt_campaigns
         WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= $1 AND tenant_id = $2
         ORDER BY scheduled_at ASC
         LIMIT 25`
      : `SELECT id, tenant_id
         FROM mkt_campaigns
         WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= $1
         ORDER BY scheduled_at ASC
         LIMIT 25`;
    const res = await client.query<{ id: string; tenant_id: string }>(
      sql,
      tenantIdFilter ? [now, tenantIdFilter] : [now]
    );
    return res.rows;
  });

  if (dueCampaigns.length === 0) return 0;

  const [utilsMod, dispMod] = await Promise.all([
    import('../../modules/marketing/utils.ts'),
    import('../../modules/marketing/dispatchers.ts'),
  ]);
  const publicOrigin = utilsMod.resolvePublicRequestOrigin();

  let processed = 0;
  for (const camp of dueCampaigns) {
    // Atomic pickup: only the worker that transitions 'scheduled' -> 'sending' dispatches
    const claimed = await withTenantTransaction(camp.tenant_id, async (client) => {
      const claimStatusUpd = await client.query(
        `UPDATE mkt_campaigns
         SET status = 'sending', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND status = 'scheduled'`,
        [camp.tenant_id, camp.id]
      );
      return (claimStatusUpd.rowCount || 0) > 0;
    });
    if (!claimed) continue;

    // 3-Phase High-Speed Concurrent Token-Bucket Dispatch (Phase 2 network I/O runs OUTSIDE any TX)
    await dispMod.dispatchCampaignBatchHighSpeed({
      tenantId: camp.tenant_id,
      campaignId: camp.id,
      publicOrigin,
      actorName: 'Cron Campaign Scheduler',
      source: 'cron_scheduler',
      enforceEmailProviderGate: true,
      enforceZnsWindow: true,
    });
    processed++;
  }

  return processed;
}

export const runScheduledMarketingCampaigns = runMarketingCampaignsWorker;

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
  ensureZnsDispatcherRegistered();
  let processed = 0;

  // 1. Marketing Campaign Follow-up Reminders
  const reminderRules = await withSystemPrivilege(async (client) => {
    const hasReminders = await cronTableExists(client, 'mkt_campaign_reminders');
    const hasClaims = await cronTableExists(client, 'mkt_send_claims');
    if (!hasReminders || !hasClaims) return [];
    const sql = tenantIdFilter
      ? `SELECT id, tenant_id, campaign_id, trigger_condition, wait_hours, subject, template_id, channel
         FROM mkt_campaign_reminders
         WHERE is_active = true AND tenant_id = $1
         ORDER BY step_order ASC
         LIMIT 50`
      : `SELECT id, tenant_id, campaign_id, trigger_condition, wait_hours, subject, template_id, channel
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
      subject: string | null;
      template_id: string | null;
      channel: string | null;
    }>(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows;
  });

  if (reminderRules.length > 0) {
    const [utilsMod, dispMod] = await Promise.all([
      import('../../modules/marketing/utils.ts'),
      import('../../modules/marketing/dispatchers.ts'),
    ]);
    const publicOrigin = utilsMod.resolvePublicRequestOrigin();

    for (const rem of reminderRules) {
      const cutoff = new Date(Date.now() - Math.max(1, Number(rem.wait_hours || 24)) * 3600_000);
      const cond =
        rem.trigger_condition === 'no_click'
          ? 'sc.clicked_at IS NULL'
          : rem.trigger_condition === 'all'
            ? '1=1'
            : 'sc.opened_at IS NULL';

      const mailMod = await import('../../services/zalo-mail.service.ts');
      const guardMod = await import('../../core/security/outbound-guard.ts');

      // Phase 1 (Short TX): Resolve pending reminder claims, suppressions, pre-render & claim reminder_sent
      const prep = await withTenantTransaction(rem.tenant_id, async (client) => {
        const [tenantRes, campRes, emailReadiness, suppressionRes, preloadedEmailState] = await Promise.all([
          client.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1 LIMIT 1', [rem.tenant_id]),
          client.query(
            'SELECT id, name, subject_a, template_id, zns_template_id, fallback_vars_json FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [rem.tenant_id, rem.campaign_id]
          ),
          dispMod.readAutomationEmailReadiness(client, rem.tenant_id),
          (await cronTableExists(client, 'mkt_suppression_list'))
            ? client.query<{ channel: string; recipient: string }>(
                'SELECT channel, LOWER(recipient) AS recipient FROM mkt_suppression_list WHERE tenant_id = $1',
                [rem.tenant_id]
              )
            : Promise.resolve({ rows: [] as Array<{ channel: string; recipient: string }> }),
          mailMod.loadEmailTenantStateForCampaign(client, rem.tenant_id),
        ]);

        const tenantName = tenantRes.rows[0]?.name || 'DOMATION';
        const camp = campRes.rows[0] || {};
        const suppressedSet = utilsMod.buildSuppressionSet(suppressionRes.rows);

        const remChannel = rem.channel === 'email' || rem.channel === 'zns' ? rem.channel : null;
        const pendingParams: unknown[] = [rem.tenant_id, rem.campaign_id, cutoff];
        const channelFilterSql = remChannel ? `AND sc.channel = $${pendingParams.push(remChannel)}` : '';

        const pendingRes = await client.query<{
          id: string;
          lead_id: string;
          channel: string;
          lead_name: string | null;
          email: string | null;
          phone: string | null;
          email_consent: string | null;
          zns_consent: string | null;
          custom_fields: unknown;
        }>(
          `SELECT sc.id, sc.lead_id, sc.channel,
                  l.name AS lead_name, l.email, l.phone, l.email_consent, l.zns_consent, l.custom_fields
           FROM mkt_send_claims sc
           INNER JOIN leads l ON l.tenant_id = sc.tenant_id AND l.id = sc.lead_id AND l.is_deleted = false
           WHERE sc.tenant_id = $1
             AND sc.campaign_id = $2
             AND sc.status IN ('sent', 'delivered', 'opened')
             AND sc.reminder_sent = false
             AND sc.sent_at IS NOT NULL
             AND sc.sent_at <= $3
             ${channelFilterSql}
             AND ${cond}
           LIMIT 200`,
          pendingParams
        );

        let tplHtml = '';
        const effectiveTplId = rem.template_id || camp.template_id || null;
        if (effectiveTplId && (await cronTableExists(client, 'mkt_email_templates'))) {
          const tRes = await client.query<{ compiled_html: string; blocks_json: unknown; body_style: unknown }>(
            'SELECT compiled_html, blocks_json, body_style FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [rem.tenant_id, effectiveTplId]
          );
          const tplRow = tRes.rows[0];
          if (tplRow) {
            tplHtml = String(tplRow.compiled_html || '').trim();
            if (!tplHtml) {
              const blocks = utilsMod.parseJsonCol(tplRow.blocks_json, []);
              const bodyStyle = utilsMod.parseJsonCol(tplRow.body_style, {});
              if (Array.isArray(blocks) && blocks.length > 0) {
                tplHtml = utilsMod.compileEmailBlocksToHtml(blocks as any, bodyStyle as any, String(rem.subject || camp.subject_a || camp.name || 'Nhắc lại'));
              }
            }
          }
        }
        if (!tplHtml) {
          tplHtml = `<!DOCTYPE html><html lang="vi"><body><div style="font-family:Inter,Arial,sans-serif;padding:24px;color:#0F172A;"><p>Xin chào {{lead.name}},</p><p>Nhắc lại thông tin chiến dịch <strong>{{campaign.name}}</strong> từ {{tenant.name}}.</p><p><a href="{{unsubscribe_url}}">Hủy đăng ký</a></p></div></body></html>`;
        }

        const rawSubject = String(rem.subject || camp.subject_a || `[Nhắc lại] ${camp.name || 'Chiến dịch'}`);
        const campFallbacks = utilsMod.parseJsonCol<Record<string, string>>(camp.fallback_vars_json, {});

        const jobs: Array<{
          claimId: string;
          leadId: string;
          leadName: string;
          channel: 'email' | 'zns';
          toEmail: string;
          toPhone: string;
          subject: string;
          text: string;
          html: string;
        }> = [];

        for (const claim of pendingRes.rows) {
          const ch = (rem.channel && rem.channel !== 'multi' ? rem.channel : claim.channel) === 'zns' ? 'zns' : 'email';
          if (ch === 'email') {
            if (!emailReadiness.email_provider_ready && !dispMod.isCampaignOutboundSilent() && !emailReadiness.sandbox_mode) {
              continue;
            }
            const emailLower = String(claim.email || '').trim().toLowerCase();
            if (
              !emailLower ||
              claim.email_consent !== 'subscribed' ||
              utilsMod.isRecipientSuppressed(suppressedSet, 'email', emailLower)
            ) {
              await client.query(
                'UPDATE mkt_send_claims SET reminder_sent = true WHERE tenant_id = $1 AND id = $2 AND reminder_sent = false',
                [rem.tenant_id, claim.id]
              );
              continue;
            }
          } else {
            const phoneClean = String(claim.phone || '').trim();
            if (
              !phoneClean ||
              claim.zns_consent === 'opted_out' ||
              utilsMod.isRecipientSuppressed(suppressedSet, 'zns', phoneClean)
            ) {
              await client.query(
                'UPDATE mkt_send_claims SET reminder_sent = true WHERE tenant_id = $1 AND id = $2 AND reminder_sent = false',
                [rem.tenant_id, claim.id]
              );
              continue;
            }
          }

          const claimUpd = await client.query(
            `UPDATE mkt_send_claims
             SET reminder_sent = true
             WHERE tenant_id = $1 AND id = $2 AND reminder_sent = false`,
            [rem.tenant_id, claim.id]
          );
          if ((claimUpd.rowCount || 0) === 0) continue;

          const unsubSig = utilsMod.signUnsubscribeHmac(rem.tenant_id, String(claim.lead_id), ch);
          const unsubUrl = `${publicOrigin}/api/v1/public/marketing/unsubscribe?tenant_id=${rem.tenant_id}&lead_id=${claim.lead_id}&channel=${ch}&sig=${unsubSig}&claim_id=${claim.id}`;
          const mergeCtx = dispMod.buildCampaignMergeContext({
            lead: {
              id: claim.lead_id,
              name: claim.lead_name || '',
              email: claim.email || '',
              phone: claim.phone || '',
              custom_fields: claim.custom_fields,
            },
            tenantName,
            campaignName: String(camp.name || ''),
            campaignSubject: rawSubject,
            unsubscribeUrl: unsubUrl,
          });
          const renderedSubject = utilsMod.renderMergeTags(rawSubject, mergeCtx, campFallbacks);
          const renderedHtml = utilsMod.renderMergeTags(tplHtml, mergeCtx, campFallbacks);
          const trackedHtml =
            ch === 'email'
              ? utilsMod.injectEmailOpenAndClickTracking(renderedHtml, {
                  baseUrl: publicOrigin,
                  claimId: claim.id,
                  unsubscribeUrl: unsubUrl,
                })
              : renderedHtml;

          jobs.push({
            claimId: claim.id,
            leadId: claim.lead_id,
            leadName: claim.lead_name || '',
            channel: ch,
            toEmail: String(claim.email || '').trim().toLowerCase(),
            toPhone: String(claim.phone || '').trim(),
            subject: renderedSubject,
            text: utilsMod.stripHtmlTagsForPlainText(trackedHtml) || renderedSubject,
            html: trackedHtml,
          });
        }

        return { camp, emailReadiness, preloadedEmailState, jobs };
      });

      // Phase 2 (Outside TX): Dispatch reminders without holding DB locks
      const sentItems: Array<{ job: (typeof prep.jobs)[number]; providerUsed: string }> = [];
      for (const job of prep.jobs) {
        let ok = false;
        let providerUsed = 'vault_queued';
        if (job.channel === 'email') {
          const mailRes = await dispMod.dispatchMarketingEmail({
            tenantId: rem.tenant_id,
            to: job.toEmail,
            subject: job.subject,
            text: job.text,
            html: job.html,
            category: 'system_alert',
            meta: { campaign_id: rem.campaign_id, claim_id: job.claimId, reminder_id: rem.id },
            emailVaultConfigured: prep.emailReadiness.email_provider_ready,
            emailVaultType: prep.emailReadiness.active_provider,
            sandboxMode: prep.emailReadiness.sandbox_mode,
            pooled: true,
            preloadedState: prep.preloadedEmailState,
          });
          ok = mailRes.sent;
          providerUsed = mailRes.provider;
        } else {
          const znsRes = await dispMod.dispatchZnsNotification({
            tenantId: rem.tenant_id,
            phone: job.toPhone,
            templateId: prep.camp.zns_template_id ? String(prep.camp.zns_template_id) : null,
            templateData: { customer_name: job.leadName, subject: job.subject },
            message: job.subject,
            campaignId: rem.campaign_id,
            claimId: job.claimId,
            leadId: job.leadId,
          });
          ok = znsRes.sent && !znsRes.queued && !znsRes.silent && znsRes.provider !== 'zns_vault_queued';
          providerUsed = znsRes.provider;
        }
        if (ok) sentItems.push({ job, providerUsed });
      }

      // Phase 3 (Short TX): Persist timeline events & dispatched_count
      if (sentItems.length > 0) {
        await withTenantTransaction(rem.tenant_id, async (client) => {
          for (const item of sentItems) {
            await client.query(
              `INSERT INTO lead_timeline_events (
                 id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
               ) VALUES ($1, $2, $3, $4, 'communication', 'tenant_admin', 'Cron Campaign Reminder', $5, $6, $7::jsonb)`,
              [
                crypto.randomUUID(),
                rem.tenant_id,
                item.job.leadId,
                item.job.channel === 'zns' ? 'zns_sent' : 'mkt_email_sent',
                `Gửi nhắc tự động (${rem.trigger_condition}): ${prep.camp.name || rem.campaign_id}`,
                item.job.subject,
                JSON.stringify({ campaign_id: rem.campaign_id, claim_id: item.job.claimId, reminder_id: rem.id, provider: item.providerUsed }),
              ]
            );
          }
          await client.query(
            `UPDATE mkt_campaign_reminders
             SET dispatched_count = dispatched_count + $3,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [rem.tenant_id, rem.id, sentItems.length]
          );
        });
      }
      processed += sentItems.length;
    }
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
  try {
    const mod = await import('../../modules/marketing/flow-engine.service.ts');
    if (typeof mod.registerFlowEventListeners === 'function') {
      mod.registerFlowEventListeners();
    }
  } catch {}
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
