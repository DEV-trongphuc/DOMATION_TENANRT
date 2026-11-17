import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { getPlatformOperationalConfigCached } from '../../core/settings/platform-config.ts';
import { isWithinWorkSchedule } from '../../services/distribution.service.ts';
import { sendTenantEmailNotification } from '../../services/zalo-mail.service.ts';
import { renderTemplateString } from '../../core/settings/tenant-settings.ts';

export async function runDirectDbSlaSweeper(tenantIdFilter?: string): Promise<number> {
  const opsCfg = await getPlatformOperationalConfigCached();
  const slaBatchLimit = opsCfg.cron_limits.sla_batch_limit;
  const expiredCandidates = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT 
        l.id AS lead_id,
        l.tenant_id,
        l.name AS lead_name,
        l.phone,
        l.assigned_to,
        l.stage_id,
        l.created_at,
        COALESCE(s.sla_timeout_minutes, 0) AS stage_sla_minutes,
        s.stage_name,
        s.stage_order,
        s.is_won_stage,
        s.is_lost_stage,
        u.full_name AS sale_name
      FROM leads l
      INNER JOIN tenants t ON t.id = l.tenant_id
      LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
      LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
      WHERE l.status = 'assigned'
        AND l.is_deleted = false
        AND l.is_accepted = false
        AND l.sla_breached = false
        AND COALESCE(s.is_won_stage, false) = false
        AND COALESCE(s.is_lost_stage, false) = false
        AND t.status IN ('active', 'trial')
        ${tenantIdFilter ? 'AND l.tenant_id = $1' : ''}
      ORDER BY l.created_at ASC
      LIMIT ${slaBatchLimit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows;
  });

  if (expiredCandidates.length === 0) return 0;

  let totalBreached = 0;
  const nowMs = Date.now();

  for (const cand of expiredCandidates) {
    const cachedSettings = await getTenantSettingsCached(cand.tenant_id);
    const stageSla = Number(cand.stage_sla_minutes || 0);
    const defaultSla = Number(cachedSettings.default_sla_minutes || 15);
    const effectiveSlaMinutes =
      stageSla > 0 ? stageSla : cachedSettings.use_default_sla_fallback !== false ? defaultSla : 0;
    if (effectiveSlaMinutes <= 0) continue;
    const createdAtMs = new Date(cand.created_at).getTime();

    // Verify if SLA has actually expired
    if (createdAtMs + effectiveSlaMinutes * 60 * 1000 > nowMs) {
      continue;
    }

    // Process single lead inside tenant transaction with FOR UPDATE lock
    await withTenantTransaction(cand.tenant_id, async (client) => {
      const cur = await client.query(
        `SELECT id, is_accepted, sla_breached, assigned_to FROM leads WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [cand.tenant_id, cand.lead_id]
      );
      const row = cur.rows[0];
      if (!row || row.is_accepted || row.sla_breached) return;

      const cfg = await getTenantSettingsCached(cand.tenant_id, client);
      let autoRecalled = false;
      let reassignedTo: string | null = row.assigned_to;

      if (cfg.sla_auto_recall_enabled) {
        autoRecalled = true;
        const priorRecalls = await client.query<{ prev_id: string | null }>(
          `SELECT metadata->>'previous_assignee' AS prev_id
           FROM lead_timeline_events
           WHERE tenant_id = $1 AND lead_id = $2 AND event_type = 'auto_recall'`,
          [cand.tenant_id, cand.lead_id]
        );
        const excludedUserIds = Array.from(
          new Set([row.assigned_to, ...priorRecalls.rows.map((r) => r.prev_id)].filter(Boolean))
        );

        let chosenPeer: { id: string; full_name: string } | undefined;
        if (cfg.distribution_mode !== 'manual_only') {
          const peerRes = await client.query<{ id: string; full_name: string; work_schedule: any }>(
            `SELECT u.id, u.full_name, p.work_schedule
             FROM users u
             INNER JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
             WHERE u.tenant_id = $1
               AND u.role = 'sale'
               AND p.status = 'active'
               AND p.is_available = true
               AND p.vacation_mode = false
               ${excludedUserIds.length > 0 ? 'AND NOT (u.id = ANY($2::uuid[]))' : ''}
             ORDER BY u.created_at ASC`,
            excludedUserIds.length > 0 ? [cand.tenant_id, excludedUserIds] : [cand.tenant_id]
          );

          const now = new Date();
          const eligible = cfg.enforce_work_schedule
            ? peerRes.rows.filter((p) => isWithinWorkSchedule(p.work_schedule, now, cfg.timezone_offset_hours))
            : peerRes.rows;
          chosenPeer = eligible[0];
        }

        if (chosenPeer) {
          reassignedTo = chosenPeer.id;
          await client.query(
            `UPDATE leads SET sla_breached = true, assigned_to = $3, status = 'assigned', updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
            [cand.tenant_id, cand.lead_id, reassignedTo]
          );
          await client.query(
            `INSERT INTO lead_timeline_events (tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata)
             VALUES ($1, $2, 'auto_recall', 'system', $3, 'tenant_admin', 'SLA Auto-Recall', $4, $5, $6::jsonb)`,
            [
              cand.tenant_id,
              cand.lead_id,
              reassignedTo,
              `SLA_AUTO_RECALL: Tự động thu hồi do quá hạn & chuyển cho ${chosenPeer.full_name}`,
              `Sale cũ (${cand.sale_name || 'N/A'}) không tiếp nhận đúng hạn SLA.`,
              JSON.stringify({ previous_assignee: row.assigned_to, new_assignee: reassignedTo }),
            ]
          );
        } else {
          reassignedTo = null;
          await client.query(
            `UPDATE leads SET sla_breached = true, assigned_to = NULL, status = 'recalled', updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
            [cand.tenant_id, cand.lead_id]
          );
          await client.query(
            `INSERT INTO lead_timeline_events (tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata)
             VALUES ($1, $2, 'auto_recall', 'system', 'tenant_admin', 'SLA Auto-Recall', $3, $4, $5::jsonb)`,
            [
              cand.tenant_id,
              cand.lead_id,
              'SLA_AUTO_RECALL: Thu hồi lead quá hạn về hàng chờ (không còn Sale trực tuyến)',
              `Sale cũ (${cand.sale_name || 'N/A'}) quá hạn SLA tiếp nhận.`,
              JSON.stringify({ previous_assignee: row.assigned_to, new_assignee: null }),
            ]
          );
        }
      } else {
        await client.query(
          `UPDATE leads SET sla_breached = true, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2`,
          [cand.tenant_id, cand.lead_id]
        );
      }

      await client.query(
        `INSERT INTO lead_timeline_events (tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata)
         VALUES ($1, $2, 'sla_breach', 'system', 'tenant_admin', 'SLA Monitor', $3, $4, $5::jsonb)`,
        [
          cand.tenant_id,
          cand.lead_id,
          `SLA_BREACH: Quá hạn cam kết tại bước "${cand.stage_name || 'Mới'}"`,
          autoRecalled ? 'Đã tự động thu hồi Lead theo chính sách SLA Auto-Recall.' : 'Cảnh báo đã được gửi tới Quản lý trực ca.',
          JSON.stringify({ stage_id: cand.stage_id, auto_recalled: autoRecalled }),
        ]
      );

      // Trigger email alert
      const templateVars = {
        customer_name: cand.lead_name || cand.lead_id.slice(0, 8),
        lead_name: cand.lead_name || cand.lead_id.slice(0, 8),
        phone: cand.phone,
        sale_name: cand.sale_name || 'Chưa nhận',
        stage_name: cand.stage_name || 'Mới',
        sla_minutes: effectiveSlaMinutes,
      };
      void sendTenantEmailNotification({
        tenantId: cand.tenant_id,
        category: 'sla_alert',
        subject: renderTemplateString(cfg.sla_email_subject_template, templateVars),
        text: renderTemplateString(cfg.sla_email_body_template, templateVars),
      }).catch(() => {});

      totalBreached += 1;
    });
  }

  return totalBreached;
}
