import type { DbClient } from '../../core/database/db-adapter.ts';
import type { TenantContext } from '../../core/context/tenant-context.ts';
import {
  DEFAULT_PIPELINE_CAPI_STAGES,
  type TenantSettings,
} from '../../core/settings/tenant-settings.ts';
import {
  buildLegacyDateFilterFromParams,
  DOMATION_PALETTE,
  formatDateTimeVnSql,
  formatPctDelta,
  mapPgLeadRowToLegacy,
} from './legacy-helpers.ts';
import { maskPhoneString, shouldMaskPiiForActor } from '../../core/security/pii-masker.ts';
import { getZonedDateParts, zonedWallClockToUtc } from '../workspace.routes.ts';
import {
  getMetaAdsConfigSummary,
  getMetaCapiDashboardConfig,
  normalizeAdAccountId,
} from '../../services/meta-ads.service.ts';

function pickCleanSourceLabel(rawSource?: string | null): string {
  const s = String(rawSource || '').trim();
  if (!s) return 'Webhook';
  if (s.includes('\n') || s.length > 60) {
    return s.split('\n')[0].slice(0, 48).trim() || 'Webhook';
  }
  return s;
}

function resolveSafeTimezone(rawTz?: string): string {
  const cand = String(rawTz || 'Asia/Ho_Chi_Minh').trim();
  if (!/^[A-Za-z0-9_+/:-]{1,64}$/.test(cand)) return 'Asia/Ho_Chi_Minh';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cand });
    return cand;
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

function hmToMinutes(hm: string | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isWithinWorkSchedule(createdAt: Date | string, tz: string, cfg: TenantSettings): boolean {
  const zp = getZonedDateParts(createdAt, tz);
  if (!zp) return false;
  const mins = zp.hour * 60 + zp.minute;
  const startMin = hmToMinutes(cfg.work_schedule_start, 510);
  const endMin = hmToMinutes(cfg.work_schedule_end, 1080);
  const satEndMin = hmToMinutes(cfg.work_schedule_saturday_end, endMin);
  if (zp.isoDow >= 1 && zp.isoDow <= 5) {
    return mins >= startMin && mins <= endMin;
  }
  if (zp.isoDow === 6 && satEndMin > startMin) {
    return mins >= startMin && mins <= satEndMin;
  }
  if (zp.isoDow === 7 && cfg.work_schedule_sunday_enabled) {
    return mins >= startMin && mins <= endMin;
  }
  return false;
}

export async function handleLegacyAnalytics(
  action: string,
  params: URLSearchParams,
  client: DbClient,
  ctx: TenantContext,
  cfg: TenantSettings
): Promise<Record<string, any> | null> {
  const tenantTz = resolveSafeTimezone(cfg.timezone_name);

  if (action === 'get_dashboard_stats') {
    const chartMode = String(params.get('chart_mode') || 'day');
    const chartMetric = String(params.get('chart_metric') || 'lead');
    const dateFilter = buildLegacyDateFilterFromParams(params, 'Tháng này');

    const leadParams: unknown[] = [ctx.tenantId];
    const currDateCond = dateFilter.bindSql('l.created_at', leadParams);
    const baseWhere = `l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived' AND (${currDateCond})${
      ctx.userRole === 'sale' ? ` AND l.assigned_to = '${ctx.userId}'` : ''
    }`;

    const [
      kpiRes,
      heldRes,
      ticketRes,
      aiGateRes,
      topConsRes,
      roundRes,
      sourceRes,
      pipelineRes,
      errorStatsRes,
      leadEventsRes,
    ] = await Promise.all([
      client.query(
        `SELECT
           COUNT(*) AS total_leads,
           COALESCE(SUM(CASE WHEN l.status = 'assigned' AND COALESCE(l.custom_fields->>'original_status', '') NOT IN ('compensated', 'compensation') THEN 1 ELSE 0 END), 0) AS distributed_assigned,
           COALESCE(SUM(CASE WHEN l.status = 'assigned' AND COALESCE(l.custom_fields->>'original_status', '') IN ('compensated', 'compensation') THEN 1 ELSE 0 END), 0) AS distributed_compensation,
           COALESCE(SUM(CASE WHEN l.status = 'assigned' THEN 1 ELSE 0 END), 0) AS distributed_total,
           COALESCE(SUM(CASE WHEN l.is_duplicate_reminder = true OR l.is_duplicated = true THEN 1 ELSE 0 END), 0) AS duplicates,
           COALESCE(SUM(CASE WHEN l.status = 'unassigned_pending' THEN 1 ELSE 0 END), 0) AS pending_work_hours_count,
           COALESCE(SUM(CASE WHEN l.status = 'rejected' THEN 1 ELSE 0 END), 0) AS under_standard,
           COALESCE(SUM(CASE WHEN l.status = 'blacklisted' THEN 1 ELSE 0 END), 0) AS blacklisted_leads,
           COALESCE(SUM(CASE WHEN l.ai_screener_status = 'passed' THEN 1 ELSE 0 END), 0) AS ai_passed_count,
           COALESCE(SUM(CASE WHEN l.ai_screener_status IN ('failed', 'rejected', 'held') THEN 1 ELSE 0 END), 0) AS ai_failed_count,
           COALESCE(SUM(l.ai_prompt_tokens), 0) AS total_prompt_tokens_used,
           COALESCE(SUM(l.ai_completion_tokens), 0) AS total_completion_tokens_used,
           COALESCE(SUM(l.ai_prompt_tokens + l.ai_completion_tokens), 0) AS total_tokens_used,
           COALESCE(SUM(CASE WHEN l.zalo_notify_status = 'sent' THEN 1 ELSE 0 END), 0) AS total_zalo_sent,
           COALESCE(SUM(CASE WHEN l.email_notify_status = 'sent' THEN 1 ELSE 0 END), 0) AS total_emails_sent
         FROM leads l
         WHERE ${baseWhere}`,
        leadParams
      ),
      client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END), 0) AS held_cnt,
           COALESCE(SUM(CASE WHEN status = 'blacklisted' THEN 1 ELSE 0 END), 0) AS blacklisted_cnt
         FROM held_leads
         WHERE tenant_id = $1`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT
           COUNT(*) AS total_tickets,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_tickets
         FROM data_reports
         WHERE tenant_id = $1`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT is_enabled FROM ai_screener_configs WHERE tenant_id = $1 LIMIT 1`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT u.id, u.full_name AS name, u.avatar_url AS avatar,
                p.status, p.vacation_mode,
                COUNT(l.id)::int AS lead_count
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         INNER JOIN leads l ON l.tenant_id = u.tenant_id AND l.assigned_to = u.id
           AND l.is_deleted = false AND l.status != 'archived' AND (${currDateCond})
         WHERE u.tenant_id = $1 AND u.role = 'sale'
         GROUP BY u.id, u.full_name, u.avatar_url, p.status, p.vacation_mode
         ORDER BY lead_count DESC
         LIMIT 12`,
        leadParams
      ),
      client.query(
        `SELECT COALESCE(r.name, 'Chưa gắn vòng') AS round_name, COUNT(*)::int AS count
         FROM leads l
         LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
         WHERE ${baseWhere}
         GROUP BY r.name
         ORDER BY count DESC`,
        leadParams
      ),
      client.query(
        `SELECT COALESCE(NULLIF(trim(l.source), ''), 'Webhook') AS src, COUNT(*)::int AS count
         FROM leads l
         WHERE ${baseWhere}
         GROUP BY src
         ORDER BY count DESC
         LIMIT 10`,
        leadParams
      ),
      client.query(
        `SELECT l.assigned_to,
                COALESCE(u.full_name, '') AS consultant_name,
                COALESCE(
                  NULLIF(trim(l.quality_status), ''),
                  NULLIF(trim(l.custom_fields->>'sale_status'), ''),
                  NULLIF(trim(tps.stage_name), ''),
                  'unrated'
                ) AS stage,
                COUNT(*)::int AS count
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         LEFT JOIN tenant_pipeline_stages tps ON tps.tenant_id = l.tenant_id AND tps.id = l.stage_id
         WHERE ${baseWhere}
         GROUP BY l.assigned_to, u.full_name, stage`,
        leadParams
      ),
      client.query(
        `SELECT u.full_name AS name, COUNT(dr.id) AS errors
         FROM data_reports dr
         LEFT JOIN users u ON u.tenant_id = dr.tenant_id AND u.id = dr.reporter_id
         WHERE dr.tenant_id = $1
         GROUP BY u.full_name
         ORDER BY errors DESC
         LIMIT 10`,
        [ctx.tenantId]
      ),
      client.query<{
        created_at: Date | string;
        zalo_notify_status: string | null;
        email_notify_status: string | null;
        ai_prompt_tokens: number | null;
        ai_completion_tokens: number | null;
      }>(
        `SELECT l.created_at, l.zalo_notify_status, l.email_notify_status, l.ai_prompt_tokens, l.ai_completion_tokens
         FROM leads l
         WHERE ${baseWhere}`,
        leadParams
      ),
    ]);

    const prevParams: unknown[] = [ctx.tenantId];
    const prevDateCond = dateFilter.bindPrevSql('l.created_at', prevParams);
    let prevTotal = 0;
    let prevDist = 0;
    let prevDup = 0;
    if (prevDateCond) {
      const pRes = await client.query(
        `SELECT
           COUNT(*) AS total_leads,
           COALESCE(SUM(CASE WHEN l.status = 'assigned' THEN 1 ELSE 0 END), 0) AS dist_leads,
           COALESCE(SUM(CASE WHEN l.is_duplicate_reminder = true OR l.is_duplicated = true THEN 1 ELSE 0 END), 0) AS dup_leads
         FROM leads l
         WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived' AND (${prevDateCond})`,
        prevParams
      );
      prevTotal = Number(pRes.rows[0]?.total_leads || 0);
      prevDist = Number(pRes.rows[0]?.dist_leads || 0);
      prevDup = Number(pRes.rows[0]?.dup_leads || 0);
    }

    let inHoursCount = 0;
    const eventMetricValue = (row: (typeof leadEventsRes.rows)[number]): number => {
      if (chartMetric === 'zalo') return row.zalo_notify_status === 'sent' ? 1 : 0;
      if (chartMetric === 'email') return row.email_notify_status === 'sent' ? 1 : 0;
      if (chartMetric === 'token') return Number(row.ai_prompt_tokens || 0) + Number(row.ai_completion_tokens || 0);
      return 1;
    };

    let chartData: Array<Record<string, any>> = [];
    const hmMap = new Map<string, { wday: number; hour: number; volume: number }>();
    const hrMap = new Map<number, number>();
    const dayMap = new Map<string, { time: string; date: string; volume: number }>();

    for (const row of leadEventsRes.rows) {
      if (isWithinWorkSchedule(row.created_at, tenantTz, cfg)) {
        inHoursCount++;
      }
      const zp = getZonedDateParts(row.created_at, tenantTz);
      if (!zp) continue;
      const val = eventMetricValue(row);
      if (chartMode === 'heatmap') {
        const wday = zp.isoDow - 1;
        const key = `${wday}:${zp.hour}`;
        const cur = hmMap.get(key) || { wday, hour: zp.hour, volume: 0 };
        cur.volume += val;
        hmMap.set(key, cur);
      } else if (chartMode === 'hour' || dateFilter.isSingleDay) {
        hrMap.set(zp.hour, (hrMap.get(zp.hour) || 0) + val);
      } else {
        const cur = dayMap.get(zp.ymd) || { time: zp.ddmm, date: zp.ymd, volume: 0 };
        cur.volume += val;
        dayMap.set(zp.ymd, cur);
      }
    }

    if (chartMode === 'heatmap') {
      chartData = [...hmMap.values()];
    } else if (chartMode === 'hour' || dateFilter.isSingleDay) {
      chartData = Array.from({ length: 24 }, (_, h) => ({
        time: `${String(h).padStart(2, '0')}h`,
        volume: hrMap.get(h) || 0,
      }));
    } else {
      chartData = [...dayMap.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 31);
    }

    const k = kpiRes.rows[0] || {};
    const total = Number(k.total_leads || 0);
    const heldCnt = Number(heldRes.rows[0]?.held_cnt || 0);
    const blacklistedTotal = Number(k.blacklisted_leads || 0) + Number(heldRes.rows[0]?.blacklisted_cnt || 0);
    const ticketErrors = Number(ticketRes.rows[0]?.total_tickets || 0);
    const underStandard = Number(k.under_standard || 0);
    const distributedToday = Number(k.distributed_total || 0);
    const duplicates = Number(k.duplicates || 0);
    const maxCons = Math.max(1, ...topConsRes.rows.map((c) => Number(c.lead_count || 0)));
    const totalRoundLeads = Math.max(1, roundRes.rows.reduce((s, r) => s + Number(r.count || 0), 0));

    const activePipelineStages = (
      Array.isArray(cfg.pipeline_capi_stages) && cfg.pipeline_capi_stages.length > 0
        ? cfg.pipeline_capi_stages
        : DEFAULT_PIPELINE_CAPI_STAGES
    ).filter((st) => st.enabled !== false);

    const mapStageKey = (raw: string): string => {
      const s = String(raw || '').toLowerCase().trim();
      if (!s || s === 'pending' || s === 'new' || s === 'unrated' || s.includes('chưa đánh giá') || s.includes('mới tiếp nhận')) {
        return 'unrated';
      }
      for (const st of activePipelineStages) {
        if (
          st.key.toLowerCase() === s ||
          st.label.toLowerCase() === s ||
          (st.short_label && st.short_label.toLowerCase() === s)
        ) {
          return st.key;
        }
      }
      if (s.includes('notlead') || s.includes('not lead') || s.includes('không đúng') || s.includes('sai số') || s.includes('rác') || s.includes('blacklist')) return 'Notlead';
      if (s.includes('noanswer') || s.includes('no answer') || s.includes('liên lạc') || s.includes('không nghe')) return 'NoAnswer';
      if (s.includes('badtiming') || s.includes('bad timing') || s.includes('hẹn gọi') || s.includes('liên hệ lại')) return 'Badtiming';
      if (s.includes('closed') || s.includes('chốt') || s.includes('won')) return 'Closed';
      if (s.includes('deposit') || s.includes('đặt cọc') || s === 'cọc') return 'Deposited';
      if (s.includes('booking') || s.includes('giữ chỗ')) return 'Booking';
      if (s.includes('booked') || s.includes('hẹn gặp') || s.includes('xem mẫu') || s.includes('lịch hẹn')) return 'Booked';
      if (s.includes('qualified') || s.includes('thiện chí')) return 'Qualified';
      return 'unrated';
    };

    const emptyStages = (): Record<string, number> => {
      const base: Record<string, number> = {
        Qualified: 0,
        Booked: 0,
        Booking: 0,
        Deposited: 0,
        Closed: 0,
        Badtiming: 0,
        NoAnswer: 0,
        Notlead: 0,
        unrated: 0,
        total: 0,
      };
      for (const st of activePipelineStages) {
        if (!(st.key in base)) base[st.key] = 0;
      }
      return base;
    };

    const overallPipeline = emptyStages();
    const byConsultantMap = new Map<string, { id: string; name: string; total: number; stages: Record<string, number> }>();

    for (const pr of pipelineRes.rows) {
      const cnt = Number(pr.count || 0);
      const key = mapStageKey(String(pr.stage || ''));
      overallPipeline[key] = (overallPipeline[key] || 0) + cnt;
      overallPipeline.total += cnt;

      if (pr.assigned_to) {
        const cid = String(pr.assigned_to);
        if (!byConsultantMap.has(cid)) {
          byConsultantMap.set(cid, {
            id: cid,
            name: String(pr.consultant_name || 'Sale'),
            total: 0,
            stages: emptyStages(),
          });
        }
        const entry = byConsultantMap.get(cid)!;
        entry.stages[key] += cnt;
        entry.stages.total += cnt;
        entry.total += cnt;
      }
    }

    const pipelineStats = {
      overall: overallPipeline,
      by_consultant: Array.from(byConsultantMap.values()).sort((a, b) => b.total - a.total),
    };

    const countsArr = topConsRes.rows.map((c) => Number(c.lead_count || 0));
    const meanCons = countsArr.length ? countsArr.reduce((a, b) => a + b, 0) / countsArr.length : 0;
    const variance =
      countsArr.length > 0
        ? countsArr.reduce((acc, v) => acc + Math.pow(v - meanCons, 2), 0) / countsArr.length
        : 0;
    const sd = Number(Math.sqrt(variance).toFixed(1));
    const inHours = inHoursCount;
    const outHoursRatio = total > 0 ? Math.round(((total - inHours) / total) * 100) : 0;

    return {
      success: true,
      data: {
        total_today: total,
        total,
        distributed_today: distributedToday,
        distributed_assigned: Number(k.distributed_assigned || 0),
        distributed_compensation: Number(k.distributed_compensation || 0),
        duplicates,
        errors: ticketErrors + underStandard + blacklistedTotal,
        ticket_errors: ticketErrors,
        under_standard: underStandard,
        blacklists: blacklistedTotal,
        held_count: heldCnt,
        pending_work_hours_count: Number(k.pending_work_hours_count || 0),
        total_change: formatPctDelta(total, prevTotal),
        distributed_change: formatPctDelta(distributedToday, prevDist),
        duplicates_change: formatPctDelta(duplicates, prevDup),
        errors_change: '+0%',
        ai_screener_enabled: aiGateRes.rows[0]?.is_enabled ? 1 : 0,
        ai_passed_count: Number(k.ai_passed_count || 0),
        ai_failed_count: Number(k.ai_failed_count || 0),
        total_prompt_tokens_used: Number(k.total_prompt_tokens_used || 0),
        total_completion_tokens_used: Number(k.total_completion_tokens_used || 0),
        total_tokens_used: Number(k.total_tokens_used || 0),
        total_zalo_sent: Number(k.total_zalo_sent || 0),
        total_emails_sent: Number(k.total_emails_sent || 0),
        out_of_hours_ratio: outHoursRatio,
        out_of_hours_change: '+0%',
        fair_share_equity: meanCons > 0 ? Math.max(0, Math.round(100 - (sd / meanCons) * 100)) : 100,
        fair_share_sd: sd,
        fair_share_equity_change: '+0%',
        chartData,
        topConsultants: topConsRes.rows.map((c, idx) => ({
          id: c.id,
          name: c.name,
          avatar: c.avatar,
          data: Number(c.lead_count || 0),
          percent: Math.round((Number(c.lead_count || 0) / maxCons) * 100),
          color: DOMATION_PALETTE[idx % DOMATION_PALETTE.length],
          status: c.status || 'active',
          vacation_mode: c.vacation_mode ? 1 : 0,
        })),
        roundRatio: roundRes.rows.map((r, idx) => ({
          round: r.round_name,
          count: Number(r.count || 0),
          percent: Math.round((Number(r.count || 0) / totalRoundLeads) * 100),
          color: DOMATION_PALETTE[idx % DOMATION_PALETTE.length],
        })),
        sourceStats: sourceRes.rows.map((s, idx) => {
          const label = pickCleanSourceLabel(s.src);
          const val = Number(s.count || 0);
          return {
            name: label,
            source: label,
            value: val,
            count: val,
            color: DOMATION_PALETTE[idx % DOMATION_PALETTE.length],
          };
        }),
        leadSourceStats: sourceRes.rows.map((s, idx) => {
          const label = pickCleanSourceLabel(s.src);
          const val = Number(s.count || 0);
          return {
            name: label,
            source: label,
            value: val,
            count: val,
            color: DOMATION_PALETTE[idx % DOMATION_PALETTE.length],
          };
        }),
        errorStats: errorStatsRes.rows.map((e) => ({
          name: e.name || 'Đại lý',
          errors: Number(e.errors || 0),
        })),
        pipeline_stats: pipelineStats,
      },
    };
  }

  if (action === 'get_fair_share_stats') {
    const dateFilter = buildLegacyDateFilterFromParams(params, 'Tháng này');
    const requestedRoundId = params.get('round_id') || '';

    const roundsRes = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM distribution_rounds WHERE tenant_id = $1 ORDER BY priority ASC, created_at ASC',
      [ctx.tenantId]
    );
    const targetRoundId = requestedRoundId || roundsRes.rows[0]?.id || '';

    const qParams: unknown[] = [ctx.tenantId];
    const dCond = dateFilter.bindSql('l.created_at', qParams);
    let rClause = '';
    if (targetRoundId) {
      qParams.push(targetRoundId);
      rClause = `AND rc.round_id = $${qParams.length}`;
    }

    const [consRes, ticketRes, compRes] = await Promise.all([
      client.query(
        `SELECT rc.user_id AS id, rc.round_id, dr.name AS round_name,
                u.full_name AS name, u.email, u.avatar_url AS avatar, u.is_external_agency,
                rc.receive_ratio, rc.data_per_turn, rc.compensation_count, rc.skip_count, rc.current_turn_remaining,
                COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND (${dCond}) THEN 1 ELSE 0 END), 0) AS assigned_count,
                COALESCE(SUM(CASE WHEN l.is_duplicate_reminder = true AND (${dCond}) THEN 1 ELSE 0 END), 0) AS duplicate_count,
                COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND (${dCond}) AND (l.source ILIKE '%meta%' OR l.source ILIKE '%facebook%') THEN 1 ELSE 0 END), 0) AS meta_count,
                COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND (${dCond}) AND (l.source IS NULL OR (l.source NOT ILIKE '%meta%' AND l.source NOT ILIKE '%facebook%')) THEN 1 ELSE 0 END), 0) AS web_count
         FROM round_consultants rc
         INNER JOIN distribution_rounds dr ON dr.tenant_id = rc.tenant_id AND dr.id = rc.round_id
         INNER JOIN users u ON u.tenant_id = rc.tenant_id AND u.id = rc.user_id
         LEFT JOIN leads l ON l.tenant_id = rc.tenant_id AND l.assigned_to = rc.user_id AND l.is_deleted = false AND l.status != 'archived'
           ${targetRoundId ? 'AND l.round_id = rc.round_id' : ''}
         WHERE rc.tenant_id = $1 ${rClause}
         GROUP BY rc.user_id, rc.round_id, dr.name, u.full_name, u.email, u.avatar_url, u.is_external_agency,
                  rc.receive_ratio, rc.data_per_turn, rc.compensation_count, rc.skip_count, rc.current_turn_remaining
         ORDER BY assigned_count DESC, u.full_name ASC`,
        qParams
      ),
      client.query(
        `SELECT reporter_id,
                COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_cnt,
                COUNT(*) AS total_cnt
         FROM data_reports
         WHERE tenant_id = $1
         GROUP BY reporter_id`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT consultant_user_id, COALESCE(SUM(amount), 0)::int AS total_comp
         FROM active_compensation_logs
         WHERE tenant_id = $1
         GROUP BY consultant_user_id`,
        [ctx.tenantId]
      ),
    ]);

    const tMap = new Map<string, { approved: number; total: number }>();
    for (const t of ticketRes.rows) tMap.set(t.reporter_id, { approved: Number(t.approved_cnt), total: Number(t.total_cnt) });
    const cMap = new Map<string, number>();
    for (const c of compRes.rows) cMap.set(c.consultant_user_id, Number(c.total_comp));

    const consultants = consRes.rows.map((r) => {
      const tk = tMap.get(r.id) || { approved: 0, total: 0 };
      const assigned = Number(r.assigned_count || 0);
      return {
        id: r.id,
        round_id: r.round_id,
        round_name: r.round_name,
        name: r.name,
        email: r.email,
        avatar: r.avatar,
        receive_ratio: Number(r.receive_ratio || 1),
        data_per_turn: Number(r.data_per_turn || 1),
        assigned_count: assigned,
        sources: { Meta: Number(r.meta_count || 0), Website: Number(r.web_count || 0) },
        ticket_count: tk.approved,
        total_ticket_count: tk.total,
        duplicate_count: Number(r.duplicate_count || 0),
        compensation_count: cMap.get(r.id) ?? Number(r.compensation_count || 0),
        pending_compensation: Number(r.compensation_count || 0),
        skip_count: Number(r.skip_count || 0),
        current_turn_remaining: Number(r.current_turn_remaining || 0),
      };
    });

    const totalLeads = consultants.reduce((s, c) => s + c.assigned_count, 0);
    const counts = consultants.map((c) => c.assigned_count);
    const mean = counts.length ? Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)) : 0;
    const variance = counts.length ? counts.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / counts.length : 0;
    const standardDeviation = Number(Math.sqrt(variance).toFixed(1));
    const fairnessIndex = mean > 0 ? Math.max(0, Math.min(100, Math.round(100 - (standardDeviation / mean) * 100))) : 100;

    return {
      success: true,
      data: {
        consultants,
        totalLeads,
        mean,
        standardDeviation,
        fairnessIndex,
        fairness_warning_threshold_pct: cfg.fairness_warning_threshold_pct,
        is_fairness_warning: fairnessIndex < cfg.fairness_warning_threshold_pct,
        sources: ['Meta', 'Website'],
      },
    };
  }

  if (action === 'get_consultant_compensation_details') {
    const consultantId = params.get('consultant_id') || '';
    const [ticketsRes, activeRes] = await Promise.all([
      client.query(
        `SELECT dr.id, dr.lead_id, l.name AS lead_name, l.phone, dr.reason, dr.status,
                dr.compensation_granted, dr.created_at
         FROM data_reports dr
         LEFT JOIN leads l ON l.tenant_id = dr.tenant_id AND l.id = dr.lead_id
         WHERE dr.tenant_id = $1 AND dr.reporter_id = $2
         ORDER BY dr.created_at DESC
         LIMIT 50`,
        [ctx.tenantId, consultantId]
      ),
      client.query(
        `SELECT id, round_id, amount, reason, source_type, created_at
         FROM active_compensation_logs
         WHERE tenant_id = $1 AND consultant_user_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [ctx.tenantId, consultantId]
      ),
    ]);
    return {
      success: true,
      data: {
        ticket_logs: ticketsRes.rows.map((r) => ({
          ...r,
          created_at: formatDateTimeVnSql(r.created_at),
        })),
        blacklist_logs: [],
        reassign_logs: [],
        active_logs: activeRes.rows.map((r) => ({
          ...r,
          created_at: formatDateTimeVnSql(r.created_at),
        })),
      },
    };
  }

  if (action === 'get_gatekeeper_stats') {
    const dateFilter = buildLegacyDateFilterFromParams(params, 'Tháng này');
    const qParams: unknown[] = [ctx.tenantId];
    const cond = dateFilter.bindSql('created_at', qParams);
    const roundParams: unknown[] = [ctx.tenantId];
    const roundCond = dateFilter.bindSql('h.created_at', roundParams);

    const [heldStats, blacklistRes, roundsRes] = await Promise.all([
      client.query(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END), 0) AS held,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
           COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
           COALESCE(SUM(CASE WHEN status = 'blacklisted' THEN 1 ELSE 0 END), 0) AS blacklisted
         FROM held_leads
         WHERE tenant_id = $1 AND (${cond})`,
        qParams
      ),
      client.query(
        `SELECT id, entry_type, value, reason, created_at
         FROM blacklist_entries
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT COALESCE(r.name, 'Chưa phân vòng') AS round_name, COUNT(h.id)::int AS count
         FROM held_leads h
         LEFT JOIN distribution_rounds r ON r.tenant_id = h.tenant_id AND r.id = h.round_id
         WHERE h.tenant_id = $1 AND (${roundCond})
         GROUP BY r.name`,
        roundParams
      ),
    ]);

    return {
      success: true,
      stats: heldStats.rows[0] || { total: 0, held: 0, approved: 0, rejected: 0, blacklisted: 0 },
      rounds_breakdown: roundsRes.rows,
      sources_breakdown: [],
      recent_below_standard: blacklistRes.rows.map((b) => ({
        ...b,
        created_at: formatDateTimeVnSql(b.created_at),
      })),
    };
  }

  if (action === 'get_ai_token_stats') {
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize') || 20)));
    const offset = (page - 1) * pageSize;

    const [sumRes, listRes] = await Promise.all([
      client.query(
        `SELECT
           COALESCE(SUM(ai_prompt_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(ai_completion_tokens), 0) AS completion_tokens,
           COALESCE(SUM(ai_prompt_tokens + ai_completion_tokens), 0) AS total_tokens,
           COALESCE(SUM(CASE WHEN ai_screener_status != 'not_screened' THEN 1 ELSE 0 END), 0) AS screened_count
         FROM leads
         WHERE tenant_id = $1`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT id, name AS lead_name, source, ai_screener_status, ai_evaluation,
                ai_prompt_tokens, ai_completion_tokens, created_at
         FROM leads
         WHERE tenant_id = $1 AND ai_screener_status != 'not_screened'
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.tenantId, pageSize, offset]
      ),
    ]);

    return {
      success: true,
      stats: sumRes.rows[0] || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, screened_count: 0 },
      recent_leads: listRes.rows.map((r) => ({ ...r, created_at: formatDateTimeVnSql(r.created_at) })),
      total_recent_leads: Number(sumRes.rows[0]?.screened_count || 0),
    };
  }

  if (action === 'get_ads_performance_dashboard' || action === 'get_ads_analytics_breakdowns') {
    const hasExplicitDate = Boolean(
      params.get('since') || params.get('until') || params.get('start_date') || params.get('end_date') || params.get('date')
    );
    const adsDateFilter = hasExplicitDate ? buildLegacyDateFilterFromParams(params, 'all') : null;
    const rawAcctFilter = String(params.get('ad_account_id') || '').trim();
    const acctFilter = rawAcctFilter && rawAcctFilter !== 'all' ? normalizeAdAccountId(rawAcctFilter) : '';
    const insParams: unknown[] = [ctx.tenantId];
    let acctWhere = '';
    if (acctFilter) {
      insParams.push(acctFilter);
      acctWhere = `AND ad_account_id = $${insParams.length}`;
    }
    let insDateWhere = '';
    if (adsDateFilter && adsDateFilter.preset !== 'all' && adsDateFilter.sinceIso && adsDateFilter.untilIso) {
      insParams.push(adsDateFilter.sinceIso, adsDateFilter.untilIso);
      insDateWhere = `AND date_start >= $${insParams.length - 1} AND date_start <= $${insParams.length}`;
    }
    const leadQueryParams: unknown[] = [ctx.tenantId];
    const leadDateWhere =
      adsDateFilter && adsDateFilter.preset !== 'all'
        ? `AND (${adsDateFilter.bindSql('created_at', leadQueryParams)})`
        : '';

    const adsStages = (
      Array.isArray(cfg.pipeline_capi_stages) && cfg.pipeline_capi_stages.length > 0
        ? cfg.pipeline_capi_stages
        : DEFAULT_PIPELINE_CAPI_STAGES
    ).filter((st) => st.enabled !== false);

    const positiveKeySet = new Set<string>(['good', 'hot', 'scheduled', 'won']);
    const negativeKeySet = new Set<string>(['disqualified', 'junk']);
    const neutralKeySet = new Set<string>(['bad_timing', 'no_answer']);
    const stageLookup = new Map<string, string>();
    for (const st of adsStages) {
      const kLower = st.key.toLowerCase();
      stageLookup.set(kLower, st.key);
      if (st.label) stageLookup.set(st.label.toLowerCase(), st.key);
      if (st.group === 'positive' || st.is_qualified) positiveKeySet.add(kLower);
      else if (st.group === 'negative') negativeKeySet.add(kLower);
      else neutralKeySet.add(kLower);
    }
    stageLookup.set('good', 'Qualified');
    stageLookup.set('hot', 'Qualified');
    stageLookup.set('scheduled', 'Booked');
    stageLookup.set('won', 'Closed');
    stageLookup.set('bad_timing', 'Badtiming');
    stageLookup.set('no_answer', 'NoAnswer');
    stageLookup.set('disqualified', 'Notlead');
    stageLookup.set('junk', 'Notlead');

    const [insRes, leadRes, metaSummary] = await Promise.all([
      client.query(
        `SELECT ad_id, MAX(ad_account_id) AS ad_account_id, MAX(ad_name) AS ad_name, MAX(adset_id) AS adset_id, MAX(adset_name) AS adset_name,
                MAX(campaign_id) AS campaign_id, MAX(campaign_name) AS campaign_name,
                SUM(spend)::numeric AS spend, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks,
                SUM(reach)::int AS reach, SUM(meta_leads)::int AS meta_leads,
                MAX(thumbnail_url) AS thumbnail_url, MAX(image_url) AS image_url,
                MAX(creative_title) AS creative_title, MAX(creative_body) AS creative_body,
                MAX(story_id) AS story_id, MAX(optimization_goal) AS optimization_goal
         FROM meta_ads_insights
         WHERE tenant_id = $1 ${acctWhere} ${insDateWhere}
         GROUP BY ad_id
         ORDER BY spend DESC`,
        insParams
      ),
      client.query(
        `SELECT COALESCE(ad_id, 'unattributed') AS ad_id,
                LOWER(COALESCE(quality_status, 'unrated')) AS qstatus,
                COUNT(*)::int AS cnt
         FROM leads
         WHERE tenant_id = $1 AND is_deleted = false ${leadDateWhere}
         GROUP BY COALESCE(ad_id, 'unattributed'), LOWER(COALESCE(quality_status, 'unrated'))`,
        leadQueryParams
      ),
      getMetaAdsConfigSummary(client, ctx.tenantId),
    ]);

    const lMap = new Map<
      string,
      {
        total_leads: number;
        pos: number;
        neg: number;
        mid: number;
        counts: Record<string, number>;
      }
    >();
    for (const r of leadRes.rows) {
      const adId = String(r.ad_id || 'unattributed');
      const qs = String(r.qstatus || 'unrated').toLowerCase().trim();
      const cnt = Number(r.cnt || 0);
      if (!lMap.has(adId)) {
        lMap.set(adId, { total_leads: 0, pos: 0, neg: 0, mid: 0, counts: {} });
      }
      const bucket = lMap.get(adId)!;
      bucket.total_leads += cnt;
      if (positiveKeySet.has(qs)) bucket.pos += cnt;
      else if (negativeKeySet.has(qs)) bucket.neg += cnt;
      else if (neutralKeySet.has(qs)) bucket.mid += cnt;
      const mappedKey = stageLookup.get(qs);
      if (mappedKey) {
        bucket.counts[mappedKey] = (bucket.counts[mappedKey] || 0) + cnt;
      }
    }

    const ads = insRes.rows.map((ins) => {
      const lm = lMap.get(ins.ad_id);
      const spend = Number(ins.spend || 0);
      const totalLeads = Number(lm?.total_leads || ins.meta_leads || 0);
      const pos = Number(lm?.pos || 0);
      const neg = Number(lm?.neg || 0);
      const mid = Number(lm?.mid || 0);
      const counts = lm?.counts || {};
      const dynamicPipeline: Record<string, number> = {
        Qualified: Number(counts.Qualified || 0),
        Booked: Number(counts.Booked || 0),
        Booking: Number(counts.Booking || 0),
        Deposited: Number(counts.Deposited || 0),
        Closed: Number(counts.Closed || 0),
        Badtiming: Number(counts.Badtiming || 0),
        NoAnswer: Number(counts.NoAnswer || 0),
        Notlead: neg,
        unrated: Math.max(0, totalLeads - pos - neg - mid),
      };
      for (const st of adsStages) {
        if (!(st.key in dynamicPipeline)) {
          dynamicPipeline[st.key] = Number(counts[st.key] || 0);
        }
      }
      return {
        ad_id: ins.ad_id,
        ad_account_id: ins.ad_account_id || '',
        ad_name: ins.ad_name || `Ad ${ins.ad_id}`,
        adset_id: ins.adset_id || '',
        adset_name: ins.adset_name || '',
        campaign_id: ins.campaign_id || '',
        campaign_name: ins.campaign_name || 'Meta Campaign',
        thumbnail_url: ins.thumbnail_url || '',
        image_url: ins.image_url || '',
        creative_title: ins.creative_title || '',
        creative_body: ins.creative_body || '',
        story_id: ins.story_id || '',
        optimization_goal: ins.optimization_goal || 'LEAD_GENERATION',
        spend,
        impressions: Number(ins.impressions || 0),
        clicks: Number(ins.clicks || 0),
        reach: Number(ins.reach || 0),
        total_leads: totalLeads,
        positive_leads: pos,
        negative_leads: neg,
        positive_rate: totalLeads > 0 ? Math.round((pos / totalLeads) * 100) : 0,
        cpl: totalLeads > 0 ? Math.round(spend / totalLeads) : 0,
        cpql: pos > 0 ? Math.round(spend / pos) : 0,
        pipeline: dynamicPipeline,
      };
    });

    const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
    const totalAdLeads = ads.reduce((s, a) => s + a.total_leads, 0);
    const totalPos = ads.reduce((s, a) => s + a.positive_leads, 0);

    const pipelineTotals: Record<string, number> = {
      Qualified: ads.reduce((s, a) => s + (a.pipeline?.Qualified || 0), 0),
      Booked: ads.reduce((s, a) => s + (a.pipeline?.Booked || 0), 0),
      Booking: ads.reduce((s, a) => s + (a.pipeline?.Booking || 0), 0),
      Deposited: ads.reduce((s, a) => s + (a.pipeline?.Deposited || 0), 0),
      Closed: ads.reduce((s, a) => s + (a.pipeline?.Closed || 0), 0),
      Badtiming: ads.reduce((s, a) => s + (a.pipeline?.Badtiming || 0), 0),
      NoAnswer: ads.reduce((s, a) => s + (a.pipeline?.NoAnswer || 0), 0),
      Notlead: ads.reduce((s, a) => s + (a.pipeline?.Notlead || 0), 0),
      unrated: ads.reduce((s, a) => s + (a.pipeline?.unrated || 0), 0),
    };
    for (const st of adsStages) {
      if (!(st.key in pipelineTotals)) {
        pipelineTotals[st.key] = ads.reduce((s, a) => s + (a.pipeline?.[st.key] || 0), 0);
      }
    }

    const summary = {
      total_ads_tracked: ads.length,
      ads_with_leads: ads.filter((a) => a.total_leads > 0).length,
      total_ad_leads: totalAdLeads,
      total_positive_leads: totalPos,
      total_negative_leads: ads.reduce((s, a) => s + a.negative_leads, 0),
      overall_positive_rate: totalAdLeads > 0 ? Math.round((totalPos / totalAdLeads) * 100) : 0,
      total_spend: totalSpend,
      avg_cpl: totalAdLeads > 0 ? Math.round(totalSpend / totalAdLeads) : 0,
      avg_cpql: totalPos > 0 ? Math.round(totalSpend / totalPos) : 0,
      pipeline_totals: pipelineTotals,
    };

    const adsBenchmarks = {
      target_cpl_vnd: cfg.ads_target_cpl_vnd,
      min_positive_rate_pct: cfg.ads_min_positive_rate_pct,
      max_frequency_fatigue: cfg.ads_max_frequency_fatigue,
      default_closed_deal_value_vnd: cfg.default_closed_deal_value_vnd,
    };

    if (action === 'get_ads_analytics_breakdowns') {
      const bdParams: unknown[] = [ctx.tenantId];
      const bdDateWhere =
        adsDateFilter && adsDateFilter.preset !== 'all'
          ? `AND (${adsDateFilter.bindSql('created_at', bdParams)})`
          : '';
      const leadRowsRes = await client.query<{ created_at: Date | string; quality_status: string | null }>(
        `SELECT created_at, quality_status
         FROM leads
         WHERE tenant_id = $1 AND is_deleted = false AND status != 'archived' ${bdDateWhere}`,
        bdParams
      );
      const dailyMap = new Map<string, { date: string; total_leads: number; positive_leads: number }>();
      for (const row of leadRowsRes.rows) {
        const zp = getZonedDateParts(row.created_at, tenantTz);
        if (!zp) continue;
        const cur = dailyMap.get(zp.ymd) || { date: zp.ymd, total_leads: 0, positive_leads: 0 };
        cur.total_leads++;
        if (positiveKeySet.has(String(row.quality_status || '').toLowerCase())) {
          cur.positive_leads++;
        }
        dailyMap.set(zp.ymd, cur);
      }
      const dailyTrend = [...dailyMap.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 31);
      return {
        success: true,
        summary,
        ads,
        meta_config: metaSummary,
        ads_benchmarks: adsBenchmarks,
        daily_trend: dailyTrend,
        goal_breakdown: [],
      };
    }

    return {
      success: true,
      summary,
      ads,
      meta_config: metaSummary,
      ads_benchmarks: adsBenchmarks,
    };
  }

  if (action === 'get_capi_dashboard') {
    const [logsRes, capiStatsRes, leadMetaCoverageRes, pendingBackfillRes, capiDashboard] = await Promise.all([
      client.query(
        `SELECT cl.id, cl.lead_id, l.name AS lead_name, l.phone AS lead_phone,
                l.quality_status, l.meta_lead_id AS lead_meta_id, l.ad_id,
                l.campaign AS lead_campaign_name, l.custom_fields->>'ad_name' AS lead_ad_name,
                cl.dataset_id, cl.event_name, cl.event_id, cl.action_source,
                cl.match_keys, cl.sent_payload, cl.response_status, cl.response_body, cl.sent_at
         FROM capi_logs cl
         LEFT JOIN leads l ON l.tenant_id = cl.tenant_id AND l.id = cl.lead_id
         WHERE cl.tenant_id = $1
         ORDER BY cl.sent_at DESC
         LIMIT 200`,
        [ctx.tenantId]
      ),
      client.query<{
        total_sent_ok: number;
        positive_sent_ok: number;
        spam_sent_ok: number;
        failed_count: number;
        total_logs: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN cl.response_status >= 200 AND cl.response_status < 300 THEN 1 ELSE 0 END), 0)::int AS total_sent_ok,
           COALESCE(SUM(CASE
             WHEN cl.response_status >= 200 AND cl.response_status < 300 AND (
               LOWER(COALESCE(l.quality_status, '')) IN ('qualified', 'booked', 'booking', 'deposited', 'closed', 'good')
               OR (COALESCE(l.quality_status, '') = '' AND cl.event_name IN ('Lead', 'Schedule', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase'))
             ) THEN 1 ELSE 0 END), 0)::int AS positive_sent_ok,
           COALESCE(SUM(CASE
             WHEN cl.response_status >= 200 AND cl.response_status < 300 AND (
               LOWER(COALESCE(l.quality_status, '')) IN ('notlead', 'spam')
               OR cl.event_name = 'DisqualifiedLead'
             ) THEN 1 ELSE 0 END), 0)::int AS spam_sent_ok,
           COALESCE(SUM(CASE WHEN cl.response_status < 200 OR cl.response_status >= 300 THEN 1 ELSE 0 END), 0)::int AS failed_count,
           COUNT(*)::int AS total_logs
         FROM capi_logs cl
         LEFT JOIN leads l ON l.tenant_id = cl.tenant_id AND l.id = cl.lead_id
         WHERE cl.tenant_id = $1`,
        [ctx.tenantId]
      ),
      client.query<{
        leads_with_meta_id: number;
        leads_with_fbclid: number;
        leads_with_ad_id: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN NULLIF(TRIM(meta_lead_id), '') IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS leads_with_meta_id,
           COALESCE(SUM(CASE WHEN NULLIF(TRIM(fbclid), '') IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS leads_with_fbclid,
           COALESCE(SUM(CASE WHEN NULLIF(TRIM(ad_id), '') IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS leads_with_ad_id
         FROM leads
         WHERE tenant_id = $1 AND is_deleted = false AND status != 'archived'`,
        [ctx.tenantId]
      ),
      client.query<{
        pending_positive: number;
        pending_spam: number;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN LOWER(COALESCE(l.quality_status, '')) IN ('qualified', 'booked', 'booking', 'deposited', 'closed', 'good') THEN 1 ELSE 0 END), 0)::int AS pending_positive,
           COALESCE(SUM(CASE WHEN LOWER(COALESCE(l.quality_status, '')) IN ('notlead', 'spam') THEN 1 ELSE 0 END), 0)::int AS pending_spam
         FROM leads l
         WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived'
           AND LOWER(COALESCE(l.quality_status, '')) IN ('qualified', 'booked', 'booking', 'deposited', 'closed', 'good', 'notlead', 'spam')
           AND NOT EXISTS (
             SELECT 1 FROM capi_logs cl
             WHERE cl.tenant_id = l.tenant_id AND cl.lead_id = l.id
               AND cl.response_status >= 200 AND cl.response_status < 300
           )`,
        [ctx.tenantId]
      ),
      getMetaCapiDashboardConfig(client, ctx.tenantId, cfg.dual_capi_enabled),
    ]);

    const sRow = capiStatsRes.rows[0] || {
      total_sent_ok: 0,
      positive_sent_ok: 0,
      spam_sent_ok: 0,
      failed_count: 0,
      total_logs: 0,
    };
    const mRow = leadMetaCoverageRes.rows[0] || {
      leads_with_meta_id: 0,
      leads_with_fbclid: 0,
      leads_with_ad_id: 0,
    };
    const pRow = pendingBackfillRes.rows[0] || { pending_positive: 0, pending_spam: 0 };

    return {
      success: true,
      config: capiDashboard.config,
      available_pixels: capiDashboard.available_pixels,
      capi_enabled: capiDashboard.config.capi_enabled,
      pixel_id: capiDashboard.config.capi_pixel_id,
      only_meta_leads: capiDashboard.config.capi_only_meta_leads,
      closed_value_vnd: capiDashboard.config.capi_closed_value_vnd,
      event_triggers: capiDashboard.config.capi_event_triggers,
      custom_events: capiDashboard.config.capi_custom_events,
      logs: logsRes.rows.map((r) => {
        const matchKeysStr =
          typeof r.match_keys === 'string'
            ? r.match_keys
            : r.match_keys && typeof r.match_keys === 'object'
              ? Object.keys(r.match_keys).join(', ')
              : '';
        const payloadObj =
          r.sent_payload && typeof r.sent_payload === 'object' ? r.sent_payload : null;
        const derivedTrigger =
          payloadObj?.trigger_source ||
          (['Notlead', 'Spam'].includes(String(r.quality_status || '')) ||
          r.event_name === 'DisqualifiedLead'
            ? 'gatekeeper_spam'
            : 'sale_portal');
        return {
          ...r,
          lead_phone:
            ctx.isExternalAgency && r.lead_phone ? maskPhoneString(r.lead_phone, cfg) : r.lead_phone,
          trigger_source: derivedTrigger,
          match_keys: matchKeysStr,
          sent_payload:
            typeof r.sent_payload === 'string'
              ? r.sent_payload
              : JSON.stringify(r.sent_payload || {}),
          response_body:
            typeof r.response_body === 'string'
              ? r.response_body
              : JSON.stringify(r.response_body || {}),
          sent_at: formatDateTimeVnSql(r.sent_at),
        };
      }),
      stats: {
        total_sent: Number(sRow.total_logs || logsRes.rows.length),
        success_count: Number(sRow.total_sent_ok || 0),
        total_sent_ok: Number(sRow.total_sent_ok || 0),
        positive_sent_ok: Number(sRow.positive_sent_ok || 0),
        spam_sent_ok: Number(sRow.spam_sent_ok || 0),
        pending_backfill_total: Number(pRow.pending_positive || 0) + Number(pRow.pending_spam || 0),
        pending_backfill_positive: Number(pRow.pending_positive || 0),
        pending_backfill_spam: Number(pRow.pending_spam || 0),
        leads_with_meta_id: Number(mRow.leads_with_meta_id || 0),
        leads_with_fbclid: Number(mRow.leads_with_fbclid || 0),
        leads_with_ad_id: Number(mRow.leads_with_ad_id || 0),
        failed_count: Number(sRow.failed_count || 0),
      },
    };
  }

  if (action === 'get_calendar_stats') {
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const year = Number(params.get('year') || new Date().getFullYear());
    const month = Number(params.get('month') || new Date().getMonth() + 1);
    const consultant = String(params.get('consultant') || 'all').trim();
    const userIdParam = String(params.get('user_id') || '').trim();
    const monthStart = zonedWallClockToUtc(year, month, 1, 0, 0, 0, tenantTz);
    const nextMonthStart = zonedWallClockToUtc(year, month + 1, 1, 0, 0, 0, tenantTz);
    const qParams: unknown[] = [ctx.tenantId, monthStart, nextMonthStart];
    let cClause = '';
    const filterUid = isUuid(userIdParam) ? userIdParam : (isUuid(consultant) ? consultant : '');
    if (filterUid && consultant !== 'all') {
      qParams.push(filterUid);
      cClause = `AND assigned_to = $${qParams.length}`;
    } else if (ctx.userRole === 'sale') {
      qParams.push(ctx.userId);
      cClause = `AND assigned_to = $${qParams.length}`;
    }
    const r = await client.query<{ created_at: Date | string; status: string | null; quality_status: string | null }>(
      `SELECT created_at, status, quality_status
       FROM leads
       WHERE tenant_id = $1 AND is_deleted = false AND status != 'archived'
         AND created_at >= $2 AND created_at < $3
         ${cClause}`,
      qParams
    );
    const daysMap: Record<string, { total: number; distributed: number; blacklist: number; reminder: number; error: number; ticket_total: number; assigned: number; booked: number }> = {};
    for (const row of r.rows) {
      const zp = getZonedDateParts(row.created_at, tenantTz);
      if (!zp) continue;
      if (!daysMap[zp.ymd]) {
        daysMap[zp.ymd] = { total: 0, distributed: 0, blacklist: 0, reminder: 0, error: 0, ticket_total: 0, assigned: 0, booked: 0 };
      }
      daysMap[zp.ymd].total++;
      daysMap[zp.ymd].distributed++;
      if (row.status === 'assigned') daysMap[zp.ymd].assigned++;
      if (row.quality_status === 'Booked') daysMap[zp.ymd].booked++;
    }
    return { success: true, data: daysMap, days: daysMap };
  }

  if (action === 'get_calendar_day_details') {
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const dateStr = params.get('date') || '';
    const consultant = String(params.get('consultant') || 'all').trim();
    const userIdParam = String(params.get('user_id') || '').trim();
    const dMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
    if (!dMatch) return { success: true, data: { sales: [], tickets: [], items: [] } };
    const dayStart = zonedWallClockToUtc(Number(dMatch[1]), Number(dMatch[2]), Number(dMatch[3]), 0, 0, 0, tenantTz);
    const dayEnd = zonedWallClockToUtc(Number(dMatch[1]), Number(dMatch[2]), Number(dMatch[3]) + 1, 0, 0, 0, tenantTz);
    const qParams: unknown[] = [ctx.tenantId, dayStart, dayEnd];
    let cClause = '';
    const filterUid = isUuid(userIdParam) ? userIdParam : (isUuid(consultant) ? consultant : '');
    if (filterUid && consultant !== 'all') {
      qParams.push(filterUid);
      cClause = `AND l.assigned_to = $${qParams.length}`;
    } else if (ctx.userRole === 'sale') {
      qParams.push(ctx.userId);
      cClause = `AND l.assigned_to = $${qParams.length}`;
    }
    const r = await client.query(
      `SELECT l.*, u.full_name AS assigned_to_name, u.avatar_url AS assigned_to_avatar,
              r.name AS round_name
       FROM leads l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
       WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived'
         AND l.created_at >= $2 AND l.created_at < $3
         ${cClause}
       ORDER BY l.created_at DESC
       LIMIT 100`,
      qParams
    );
    const mapped = r.rows.map((row) => mapPgLeadRowToLegacy(row, ctx, cfg));
    return {
      success: true,
      data: {
        sales: mapped,
        tickets: [],
        items: mapped,
      },
    };
  }

  if (action === 'get_active_compensation_logs') {
    const roundId = params.get('round_id') || '';
    const qParams: unknown[] = [ctx.tenantId];
    let rClause = '';
    if (roundId) {
      qParams.push(roundId);
      rClause = `AND acl.round_id = $${qParams.length}`;
    }
    const r = await client.query(
      `SELECT acl.id, acl.round_id, acl.consultant_user_id, u.full_name AS consultant_name,
              a.full_name AS admin_name, acl.amount, acl.reason, acl.source_type, acl.created_at
       FROM active_compensation_logs acl
       LEFT JOIN users u ON u.tenant_id = acl.tenant_id AND u.id = acl.consultant_user_id
       LEFT JOIN users a ON a.tenant_id = acl.tenant_id AND a.id = acl.admin_user_id
       WHERE acl.tenant_id = $1 ${rClause}
       ORDER BY acl.created_at DESC
       LIMIT 100`,
      qParams
    );
    return {
      success: true,
      data: r.rows.map((row) => ({ ...row, created_at: formatDateTimeVnSql(row.created_at) })),
    };
  }

  if (action === 'get_system_activity_feed') {
    const [distRes, adminRes, ticketRes] = await Promise.all([
      client.query(
        `SELECT l.id, l.name AS lead_name, l.phone, l.status, l.source, l.is_accepted,
                l.is_duplicate_reminder, l.is_duplicated, l.custom_fields, l.created_at,
                u.full_name AS consultant_name, u.avatar_url AS consultant_avatar
         FROM leads l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
         WHERE l.tenant_id = $1 AND l.is_deleted = false AND l.status != 'archived'
         ORDER BY l.created_at DESC
         LIMIT 25`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT id, actor_name AS admin_name, action, details, created_at
         FROM admin_audit_logs
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 15`,
        [ctx.tenantId]
      ),
      client.query(
        `SELECT dr.id, dr.reason, dr.status, dr.created_at, u.full_name AS consultant_name, l.name AS lead_name
         FROM data_reports dr
         LEFT JOIN users u ON u.tenant_id = dr.tenant_id AND u.id = dr.reporter_id
         LEFT JOIN leads l ON l.tenant_id = dr.tenant_id AND l.id = dr.lead_id
         WHERE dr.tenant_id = $1
         ORDER BY dr.created_at DESC
         LIMIT 10`,
        [ctx.tenantId]
      ),
    ]);

    const feed: Array<Record<string, any>> = [
      ...distRes.rows.map((r) => {
        const masked = shouldMaskPiiForActor(ctx, cfg, { is_accepted: Boolean(r.is_accepted) });
        const phone = masked ? maskPhoneString(r.phone || '', cfg) : r.phone || '';
        return {
          id: `dist-${r.id}`,
          type: 'distribution',
          status: r.status === 'assigned' ? 'assigned' : r.is_duplicate_reminder ? 'duplicate' : r.status,
          title: `Phân bổ Lead: ${r.lead_name}`,
          description: `${r.consultant_name || 'Hệ thống'} • ${phone} • ${pickCleanSourceLabel(r.source)}`,
          consultant_name: r.consultant_name,
          consultant_avatar: r.consultant_avatar,
          timestamp: formatDateTimeVnSql(r.created_at),
          created_at: r.created_at,
        };
      }),
      ...adminRes.rows.map((r) => ({
        id: `adm-${r.id}`,
        type: 'admin',
        action: r.action,
        title: `${r.admin_name || 'Admin'} • ${r.action}`,
        description: r.details || r.action,
        admin_name: r.admin_name,
        timestamp: formatDateTimeVnSql(r.created_at),
        created_at: r.created_at,
      })),
      ...ticketRes.rows.map((r) => ({
        id: `tk-${r.id}`,
        type: 'ticket',
        status: r.status,
        title: `Ticket báo lỗi: ${r.lead_name || r.id}`,
        description: `${r.consultant_name || 'Sale'} • ${r.reason}`,
        timestamp: formatDateTimeVnSql(r.created_at),
        created_at: r.created_at,
      })),
    ];

    feed.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return { success: true, data: feed.slice(0, 40) };
  }

  if (action === 'get_notification_logs') {
    const page = Math.max(1, Number(params.get('page') || 1));
    const pageSize = Math.min(50, Math.max(1, Number(params.get('pageSize') || 10)));
    const channel = params.get('channel') || 'all';
    const search = (params.get('search') || '').trim();
    const offset = (page - 1) * pageSize;

    const qParams: unknown[] = [ctx.tenantId];
    let extraWhere = '';
    if (channel === 'zalo') {
      extraWhere += ` AND l.zalo_notify_status != 'none'`;
    } else if (channel === 'email') {
      extraWhere += ` AND l.email_notify_status != 'none'`;
    }
    if (search) {
      qParams.push(`%${search}%`);
      extraWhere += ` AND (l.name ILIKE $${qParams.length} OR l.phone ILIKE $${qParams.length} OR u.full_name ILIKE $${qParams.length})`;
    }

    const r = await client.query(
      `SELECT l.id, l.name AS lead_name, l.phone, l.source,
              l.zalo_notify_status, l.email_notify_status, l.created_at,
              u.full_name AS target_name, u.email AS target_email
       FROM leads l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       WHERE l.tenant_id = $1 AND l.is_deleted = false
         AND (l.zalo_notify_status != 'none' OR l.email_notify_status != 'none')
         ${extraWhere}
       ORDER BY l.created_at DESC
       LIMIT $${qParams.length + 1} OFFSET $${qParams.length + 2}`,
      [...qParams, pageSize, offset]
    );

    const cntRes = await client.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM leads l
       LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
       WHERE l.tenant_id = $1 AND l.is_deleted = false
         AND (l.zalo_notify_status != 'none' OR l.email_notify_status != 'none')
         ${extraWhere}`,
      qParams
    );

    return {
      success: true,
      data: r.rows.map((row) => ({
        id: row.id,
        channel: row.zalo_notify_status !== 'none' ? 'zalo' : 'email',
        status: row.zalo_notify_status !== 'none' ? row.zalo_notify_status : row.email_notify_status,
        target: row.target_name || row.target_email || '-',
        subject: `Thông báo giao Lead mới: ${row.lead_name}`,
        body: `Khách hàng ${row.lead_name} từ nguồn ${pickCleanSourceLabel(row.source)} đã được điều phối.`,
        timestamp: formatDateTimeVnSql(row.created_at),
      })),
      total_count: Number(cntRes.rows[0]?.total || 0),
    };
  }

  if (action === 'get_admin_logs' || action === 'get_my_activity_logs') {
    const qParams: unknown[] = [ctx.tenantId];
    let actorClause = '';
    if (action === 'get_my_activity_logs') {
      qParams.push(ctx.userId);
      actorClause = `AND actor_id = $2`;
    }
    const r = await client.query(
      `SELECT id, actor_id, actor_name, action, entity_type, entity_id, details,
              is_rolled_back, created_at
       FROM admin_audit_logs
       WHERE tenant_id = $1 ${actorClause}
       ORDER BY created_at DESC
       LIMIT 60`,
      qParams
    );
    return {
      success: true,
      data: r.rows.map((row) => ({
        ...row,
        created_at: formatDateTimeVnSql(row.created_at),
      })),
    };
  }

  return null;
}
