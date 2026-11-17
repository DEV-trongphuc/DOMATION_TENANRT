import { Router } from 'express';
import { withTenantTransaction, withSystemPrivilege } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import {
  requireTenantAuth,
  requirePermission,
  requireAnyPermission,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../core/security/rbac.ts';
import { buildScopedLeadWhereClause } from '../core/repository/tenant-query-decorator.ts';
import { normalizeTenantSettings } from '../core/settings/tenant-settings.ts';
import {
  getPlatformBillingCatalog,
  computeSubscriptionSnapshot,
  switchTenantSaasPackageInTx,
} from '../services/billing.service.ts';
import {
  INDUSTRY_TERMINOLOGY_PRESETS,
  SAAS_MODULES_CATALOG,
  SAAS_PACKAGES_CATALOG,
  resolveTenantEntitlementSnapshot,
} from '../core/security/entitlements.ts';
import { maskPhoneString, shouldMaskPiiForActor } from '../core/security/pii-masker.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';

export const workspaceRouter = Router();
export const analyticsRouter = Router();

workspaceRouter.use(requireTenantAuth);
analyticsRouter.use(requireTenantAuth);

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function vnMidnightUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - VN_OFFSET_MS);
}

/**
 * Converts a wall-clock date/time in an IANA timezone to a UTC Date instance cleanly across dialects.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  timeZone = 'Asia/Ho_Chi_Minh'
): Date {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const zp = getZonedDateParts(new Date(guessMs), timeZone);
  if (!zp) return new Date(guessMs - VN_OFFSET_MS);
  const zonedAsUtc = Date.UTC(zp.year, zp.month - 1, zp.day, zp.hour, zp.minute, second, 0);
  return new Date(guessMs - (zonedAsUtc - guessMs));
}

/**
 * Extracts wall-clock date/time components in any IANA timezone using standard Intl APIs
 * so analytics grouping runs identically on PostgreSQL 16, PGlite, and MariaDB 10.6.
 */
export function getZonedDateParts(
  input: Date | string | number,
  timeZone = 'Asia/Ho_Chi_Minh'
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  isoDow: number;
  ymd: string;
  ddmm: string;
} | null {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;

  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(d);
    const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '';
    const year = Number(getPart('year'));
    const month = Number(getPart('month'));
    const day = Number(getPart('day'));
    const hourRaw = Number(getPart('hour'));
    const hour = hourRaw === 24 ? 0 : hourRaw;
    const minute = Number(getPart('minute'));
    const wd = getPart('weekday');
    const isoDow = weekdayMap[wd] ?? 1;
    const mmStr = String(month).padStart(2, '0');
    const ddStr = String(day).padStart(2, '0');
    return {
      year,
      month,
      day,
      hour,
      minute,
      isoDow,
      ymd: `${year}-${mmStr}-${ddStr}`,
      ddmm: `${ddStr}/${mmStr}`,
    };
  } catch {
    const shifted = new Date(d.getTime() + VN_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    const hour = shifted.getUTCHours();
    const minute = shifted.getUTCMinutes();
    const utcDay = shifted.getUTCDay();
    const isoDow = utcDay === 0 ? 7 : utcDay;
    const mmStr = String(month).padStart(2, '0');
    const ddStr = String(day).padStart(2, '0');
    return {
      year,
      month,
      day,
      hour,
      minute,
      isoDow,
      ymd: `${year}-${mmStr}-${ddStr}`,
      ddmm: `${ddStr}/${mmStr}`,
    };
  }
}

export function resolveDateBounds(
  preset: string,
  startDate?: string | null,
  endDate?: string | null
): { clause: string; params: unknown[] } {
  const norm = String(preset || 'this_month').trim().toLowerCase();
  if (norm === 'all') return { clause: '1=1', params: [] };

  const nowMs = Date.now();
  const vnNow = new Date(nowMs + VN_OFFSET_MS);
  const y = vnNow.getUTCFullYear();
  const m = vnNow.getUTCMonth();
  const d = vnNow.getUTCDate();
  const utcDay = vnNow.getUTCDay();
  const isoDow = utcDay === 0 ? 7 : utcDay;

  if (norm === 'today' || norm === 'hôm nay') {
    return { clause: 'created_at >= $DATE_START', params: [vnMidnightUtc(y, m, d)] };
  }
  if (norm === 'yesterday' || norm === 'hôm qua') {
    return {
      clause: 'created_at >= $DATE_START AND created_at < $DATE_END',
      params: [vnMidnightUtc(y, m, d - 1), vnMidnightUtc(y, m, d)],
    };
  }
  if (norm === 'this_week' || norm === 'tuần này') {
    return {
      clause: 'created_at >= $DATE_START',
      params: [vnMidnightUtc(y, m, d - (isoDow - 1))],
    };
  }
  if (norm === 'last_week' || norm === 'tuần trước') {
    const thisWeekStart = vnMidnightUtc(y, m, d - (isoDow - 1));
    const lastWeekStart = vnMidnightUtc(y, m, d - (isoDow - 1) - 7);
    return {
      clause: 'created_at >= $DATE_START AND created_at < $DATE_END',
      params: [lastWeekStart, thisWeekStart],
    };
  }
  if (norm === '7_days' || norm === '7 ngày qua') {
    return { clause: 'created_at >= $DATE_START', params: [new Date(nowMs - 7 * 86400_000)] };
  }
  if (norm === '30_days' || norm === '30 ngày qua') {
    return { clause: 'created_at >= $DATE_START', params: [new Date(nowMs - 30 * 86400_000)] };
  }
  if (norm === 'last_month' || norm === 'tháng trước') {
    return {
      clause: 'created_at >= $DATE_START AND created_at < $DATE_END',
      params: [vnMidnightUtc(y, m - 1, 1), vnMidnightUtc(y, m, 1)],
    };
  }
  if (norm === 'custom' && startDate && endDate) {
    const startDt = new Date(`${startDate}T00:00:00+07:00`);
    const endDt = new Date(`${endDate}T23:59:59.999+07:00`);
    if (!Number.isNaN(startDt.getTime()) && !Number.isNaN(endDt.getTime())) {
      return {
        clause: 'created_at >= $DATE_START AND created_at <= $DATE_END',
        params: [startDt, endDt],
      };
    }
  }
  // Default: this_month
  return {
    clause: 'created_at >= $DATE_START',
    params: [vnMidnightUtc(y, m, 1)],
  };
}

export function bindDateParams(rawClause: string, params: unknown[], dateInfo: { clause: string; params: unknown[] }): string {
  let out = dateInfo.clause;
  if (out.includes('$DATE_START') && dateInfo.params.length >= 1) {
    params.push(dateInfo.params[0]);
    out = out.replace('$DATE_START', `$${params.length}`);
  }
  if (out.includes('$DATE_END') && dateInfo.params.length >= 2) {
    params.push(dateInfo.params[1]);
    out = out.replace('$DATE_END', `$${params.length}`);
  }
  return out;
}

/**
 * Phase 5: Single Aggregated Workspace Bootstrap Endpoint
 * Replaces 6 sequential initial fetches when opening /data/<slug>
 */
workspaceRouter.get('/bootstrap', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const catalog = await getPlatformBillingCatalog();

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [tenantUserRes, pipelinesRes, stagesRes, fieldsRes, roundsRes, badgesRes, rbacResolved] = await Promise.all([
        client.query(
          `SELECT
             t.id AS t_id, t.slug AS t_slug, t.name AS t_name, t.domain AS t_domain,
             t.industry AS t_industry, t.industry_key AS t_industry_key,
             t.package_code AS t_package_code, t.plan_tier AS t_plan_tier,
             t.enabled_modules AS t_enabled_modules, t.entitlements AS t_entitlements,
             t.status AS t_status,
             t.trial_ends_at AS t_trial_ends_at, t.subscription_expires_at AS t_subscription_expires_at,
             t.subscription_plan_code AS t_subscription_plan_code, t.billing_cycle AS t_billing_cycle,
             t.wallet_balance_vnd AS t_wallet_balance_vnd, t.crm_erp_upgrade_status AS t_crm_erp_upgrade_status,
             t.settings AS t_settings, t.created_at AS t_created_at,
             u.id AS u_id, u.email AS u_email, u.full_name AS u_full_name, u.phone AS u_phone,
             u.role AS u_role, u.role_id AS u_role_id, u.branch_id AS u_branch_id,
             u.department_id AS u_department_id, u.team_id AS u_team_id, u.position_id AS u_position_id,
             u.reports_to_user_id AS u_reports_to_user_id, u.is_tenant_owner AS u_is_tenant_owner,
             u.is_system_bot AS u_is_system_bot,
             u.is_external_agency AS u_is_external_agency, u.avatar_url AS u_avatar_url,
             p.status AS p_status, p.is_available AS p_is_available, p.vacation_mode AS p_vacation_mode,
             p.skipped_credit AS p_skipped_credit, p.work_schedule AS p_work_schedule, p.zalo_chat_id AS p_zalo_chat_id,
             p.sheet_sync_url AS p_sheet_sync_url, p.sheet_tab_name AS p_sheet_tab_name,
             ob.current_step AS ob_current_step, ob.completed_steps AS ob_completed_steps,
             ob.screen_tours AS ob_screen_tours, ob.is_completed AS ob_is_completed, ob.dismissed_at AS ob_dismissed_at
           FROM tenants t
           LEFT JOIN users u ON u.tenant_id = t.id AND u.id = $2
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = t.id AND p.user_id = u.id
           LEFT JOIN tenant_onboarding_progress ob ON ob.tenant_id = t.id
           WHERE t.id = $1
           LIMIT 1`,
          [ctx.tenantId, ctx.userId]
        ),
        client.query(
          'SELECT id, name, description, is_default FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC',
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, pipeline_id, stage_key, stage_name, stage_order, color_hex, badge_style,
                  is_won_stage, is_lost_stage, sla_timeout_minutes, funnel_category, score_delta,
                  required_fields, capi_event_mapping
           FROM tenant_pipeline_stages
           WHERE tenant_id = $1
           ORDER BY stage_order ASC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT id, pipeline_id, field_key, field_label, field_type, is_required, options_json, stage_visibility, config_json
           FROM tenant_pipeline_custom_fields
           WHERE tenant_id = $1
           ORDER BY created_at ASC`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, pipeline_id, name, description, cc_emails, priority, is_active FROM distribution_rounds WHERE tenant_id = $1 ORDER BY priority ASC, created_at ASC',
          [ctx.tenantId]
        ),
        client.query<{ pending_tickets: number; held_leads: number; unassigned_leads: number; nurture_leads: number }>(
          `SELECT
             (SELECT COUNT(*)::int FROM data_reports WHERE tenant_id = $1 AND status = 'pending') AS pending_tickets,
             (SELECT COUNT(*)::int FROM held_leads WHERE tenant_id = $1 AND status = 'held') AS held_leads,
             (SELECT COUNT(*)::int FROM leads WHERE tenant_id = $1 AND status = 'unassigned_pending' AND is_deleted = false) AS unassigned_leads,
             (SELECT COUNT(*)::int FROM leads WHERE tenant_id = $1 AND status = 'marketing_nurture' AND is_deleted = false) AS nurture_leads`,
          [ctx.tenantId]
        ),
        resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId),
      ]);

      const r = tenantUserRes.rows[0];
      if (!r) return null;

      const normSettings = normalizeTenantSettings(r.t_settings);
      const entSnap = resolveTenantEntitlementSnapshot({
        package_code: r.t_package_code,
        plan_tier: r.t_plan_tier,
        subscription_plan_code: r.t_subscription_plan_code,
        crm_erp_upgrade_status: r.t_crm_erp_upgrade_status,
        industry: r.t_industry,
        industry_key: r.t_industry_key,
        enabled_modules: r.t_enabled_modules,
        entitlements: r.t_entitlements,
        settings: normSettings,
      });

      return {
        tenant: {
          id: r.t_id,
          slug: r.t_slug,
          name: r.t_name,
          domain: r.t_domain,
          industry: r.t_industry,
          industry_key: entSnap.industry_key,
          package_code: entSnap.package_code,
          package_info: entSnap.package_info,
          plan_tier: r.t_plan_tier,
          enabled_modules: entSnap.enabled_modules,
          entitlements: entSnap.entitlements,
          terminology: entSnap.terminology,
          status: r.t_status,
          trial_ends_at: r.t_trial_ends_at,
          subscription_expires_at: r.t_subscription_expires_at,
          subscription_plan_code: r.t_subscription_plan_code || 'trial_1m',
          billing_cycle: r.t_billing_cycle || 'trial',
          wallet_balance_vnd: Number(r.t_wallet_balance_vnd || 0),
          crm_erp_upgrade_status: r.t_crm_erp_upgrade_status || 'none',
          subscription: computeSubscriptionSnapshot(
            {
              plan_tier: r.t_plan_tier,
              created_at: r.t_created_at,
              trial_ends_at: r.t_trial_ends_at,
              subscription_expires_at: r.t_subscription_expires_at,
              subscription_plan_code: r.t_subscription_plan_code,
              billing_cycle: r.t_billing_cycle,
              wallet_balance_vnd: r.t_wallet_balance_vnd,
              crm_erp_upgrade_status: r.t_crm_erp_upgrade_status,
            },
            catalog
          ),
          settings: {
            ...normSettings,
            terminology: entSnap.terminology as unknown as Record<string, string>,
            education_addon: entSnap.entitlements.education_addon,
            enable_ideas_mascot: entSnap.entitlements.enable_ideas_mascot,
          },
          created_at: r.t_created_at,
        },
        user: r.u_id
          ? {
              id: r.u_id,
              email: r.u_email,
              full_name: r.u_full_name,
              phone: r.u_phone,
              role: r.u_role,
              role_id: r.u_role_id || null,
              branch_id: r.u_branch_id || null,
              department_id: r.u_department_id || null,
              team_id: r.u_team_id || null,
              position_id: r.u_position_id || null,
              reports_to_user_id: r.u_reports_to_user_id || null,
              is_tenant_owner: Boolean(r.u_is_tenant_owner),
              is_system_bot: Boolean(r.u_is_system_bot),
              is_external_agency: r.u_is_external_agency,
              avatar_url: r.u_avatar_url,
              status: r.p_status || 'active',
              is_available: r.p_is_available ?? true,
              vacation_mode: r.p_vacation_mode ?? false,
              skipped_credit: r.p_skipped_credit ?? 0,
              work_schedule: r.p_work_schedule,
              zalo_chat_id: r.p_zalo_chat_id,
              sheet_sync_url: r.p_sheet_sync_url,
              sheet_tab_name: r.p_sheet_tab_name,
              effective_permissions: rbacResolved.effectivePermissions,
            }
          : null,
        rbac: {
          is_tenant_owner: Boolean(r.u_is_tenant_owner),
          effective_permissions: rbacResolved.effectivePermissions,
        },
        effective_permissions: rbacResolved.effectivePermissions,
        packages_catalog: SAAS_PACKAGES_CATALOG,
        modules_catalog: SAAS_MODULES_CATALOG,
        industry_presets: INDUSTRY_TERMINOLOGY_PRESETS,
        onboarding:
          r.ob_current_step !== null && r.ob_current_step !== undefined
            ? {
                current_step: r.ob_current_step,
                completed_steps: r.ob_completed_steps || [],
                screen_tours: r.ob_screen_tours || {},
                is_completed: Boolean(r.ob_is_completed),
                dismissed_at: r.ob_dismissed_at,
              }
            : { current_step: 1, completed_steps: [], screen_tours: {}, is_completed: false },
        catalog,
        badges: badgesRes.rows[0] || { pending_tickets: 0, held_leads: 0, unassigned_leads: 0, nurture_leads: 0 },
        pipelines: pipelinesRes.rows.map((p) => ({
          ...p,
          stages: stagesRes.rows.filter((s) => s.pipeline_id === p.id),
          custom_fields: fieldsRes.rows.filter((f) => f.pipeline_id === p.id),
        })),
        rounds: roundsRes.rows,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy Workspace.');
      return;
    }

    // Fetch multi-workspace list using system privilege
    const workspaces = await withSystemPrivilege(async (client) => {
      const wRes = await client.query<{
        id: string;
        slug: string;
        name: string;
        industry: string;
        plan_tier: 'starter' | 'growth' | 'enterprise';
        role: string;
        is_external_agency: boolean;
      }>(
        `SELECT t.id, t.slug, t.name, t.industry, t.plan_tier, u.role, u.is_external_agency
         FROM tenants t
         INNER JOIN users u ON u.tenant_id = t.id
         WHERE t.status IN ('active', 'trial') AND LOWER(u.email) = $1
         ORDER BY t.created_at DESC`,
        [(ctx.userEmail || '').toLowerCase()]
      );
      return wRes.rows.map((w) => ({
        id: w.id,
        slug: w.slug,
        company_name: w.name,
        industry: w.industry,
        plan_tier: w.plan_tier,
        role: w.role,
        is_external_agency: Boolean(w.is_external_agency),
      }));
    });

    res.json({
      success: true,
      data: {
        ...data,
        workspaces,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'BOOTSTRAP_FAILED', err?.message || 'Không thể khởi tạo dữ liệu Workspace.');
  }
});

/**
 * Phase 5: High-Speed SQL-Aggregated Dashboard Analytics
 * Supports date_preset (today|yesterday|this_week|last_week|7_days|30_days|this_month|last_month|all|custom),
 * chart_mode (day|hour|heatmap), source_mode (connection|lead)
 */
analyticsRouter.get('/dashboard', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cfg = await getTenantSettingsCached(ctx.tenantId);
    const datePreset = String(req.query.date_preset || 'this_month');
    const startDate = req.query.start_date ? String(req.query.start_date) : null;
    const endDate = req.query.end_date ? String(req.query.end_date) : null;
    const chartMode = String(req.query.chart_mode || 'day');
    const sourceMode = String(req.query.source_mode || 'lead');
    const roundId = req.query.round_id ? String(req.query.round_id) : null;
    const pipelineId = req.query.pipeline_id ? String(req.query.pipeline_id) : null;
    const excludeArchived = String(req.query.exclude_archived || 'false') === 'true';

    const scoped = buildScopedLeadWhereClause(ctx, 1);
    const dateInfo = resolveDateBounds(datePreset, startDate, endDate);

    const parseTimeMins = (hhmm: string | undefined, fallback: number) => {
      const parts = String(hhmm || '').split(':');
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : fallback;
    };
    const startMins = parseTimeMins(cfg.work_schedule_start, 8 * 60 + 30);
    const endMins = parseTimeMins(cfg.work_schedule_end, 18 * 60);

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [...scoped.values];
      const dateCond = bindDateParams(dateInfo.clause, params, dateInfo).replace(/created_at/g, 'l.created_at');
      let where = `${scoped.clause.replace(/leads\./g, 'l.')} AND l.is_deleted = false AND (${dateCond})`;
      if (excludeArchived) {
        where += ` AND l.status != 'archived'`;
      }
      if (pipelineId) {
        params.push(pipelineId);
        where += ` AND l.pipeline_id = $${params.length}`;
      }
      if (roundId) {
        params.push(roundId);
        where += ` AND l.round_id = $${params.length}`;
      }

      const cParams: unknown[] = [ctx.tenantId];
      const cDateCond = bindDateParams(dateInfo.clause, cParams, dateInfo).replace(/created_at/g, 'l.created_at');
      let cLeadExtra = '';
      if (excludeArchived) {
        cLeadExtra += ` AND l.status != 'archived'`;
      }
      if (pipelineId) {
        cParams.push(pipelineId);
        cLeadExtra += ` AND l.pipeline_id = $${cParams.length}`;
      }
      if (roundId) {
        cParams.push(roundId);
        cLeadExtra += ` AND l.round_id = $${cParams.length}`;
      }
      if (ctx.userRole === 'sale') {
        cParams.push(ctx.userId);
        cLeadExtra += ` AND l.assigned_to = $${cParams.length}`;
      }

      const [kpiRes, consultantRes, sourceRes, stageRes, heldRes, ticketRes, recentRes, capiRes, roundRatioRes, pipelineStatsRes, errorByConsultantRes, leadEventsRes] = await Promise.all([
        client.query(
          `SELECT
             COUNT(*) AS total_leads,
             COALESCE(SUM(CASE WHEN l.status = 'assigned' THEN 1 ELSE 0 END), 0) AS assigned_leads,
             COALESCE(SUM(CASE WHEN l.status = 'assigned' AND (l.custom_fields->>'original_status' = 'compensated' OR l.custom_fields->>'is_compensated' = 'true') THEN 1 ELSE 0 END), 0) AS compensated_leads,
             COALESCE(SUM(CASE WHEN l.status = 'unassigned_pending' THEN 1 ELSE 0 END), 0) AS unassigned_leads,
             COALESCE(SUM(CASE WHEN l.is_accepted = true THEN 1 ELSE 0 END), 0) AS accepted_leads,
             COALESCE(SUM(CASE WHEN l.is_duplicate_reminder = true OR l.is_duplicated = true THEN 1 ELSE 0 END), 0) AS duplicate_leads,
             COALESCE(SUM(CASE WHEN l.sla_breached = true THEN 1 ELSE 0 END), 0) AS sla_breached_leads,
             COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN 1 ELSE 0 END), 0) AS won_leads,
             COALESCE(SUM(CASE WHEN l.quality_status IN ('Notlead', 'Badtiming') THEN 1 ELSE 0 END), 0) AS below_standard_leads,
             COALESCE(SUM(l.ai_prompt_tokens + l.ai_completion_tokens), 0) AS ai_tokens_used,
             COALESCE(SUM(CASE WHEN l.zalo_notify_status = 'sent' THEN 1 ELSE 0 END), 0) AS zalo_sent_count,
             COALESCE(SUM(CASE WHEN l.email_notify_status = 'sent' THEN 1 ELSE 0 END), 0) AS email_sent_count
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${where}`,
          params
        ),
        client.query(
          `SELECT u.id, u.full_name, u.email, u.is_external_agency,
                  p.is_available, p.vacation_mode,
                  COUNT(l.id) AS lead_count,
                  COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND l.is_accepted = true THEN 1 ELSE 0 END), 0) AS accepted_count
           FROM users u
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
           LEFT JOIN leads l ON l.tenant_id = u.tenant_id AND l.assigned_to = u.id AND l.is_deleted = false AND (${cDateCond})${cLeadExtra}
           WHERE u.tenant_id = $1 AND u.role = 'sale'${ctx.userRole === 'sale' ? ' AND u.id = $' + cParams.length : ''}
           GROUP BY u.id, u.full_name, u.email, u.is_external_agency, p.is_available, p.vacation_mode
           ORDER BY lead_count DESC`,
          cParams
        ),
        client.query(
          sourceMode === 'connection'
            ? `SELECT COALESCE(w.name, l.source, 'Webhook') AS label, COUNT(*) AS count
               FROM leads l
               LEFT JOIN tenant_webhooks w ON w.tenant_id = l.tenant_id AND w.id = l.connection_id
               WHERE ${where}
               GROUP BY COALESCE(w.name, l.source, 'Webhook')
               ORDER BY count DESC
               LIMIT 10`
            : `SELECT COALESCE(l.source, 'Webhook') AS label, COUNT(*) AS count
               FROM leads l
               WHERE ${where}
               GROUP BY COALESCE(l.source, 'Webhook')
               ORDER BY count DESC
               LIMIT 10`,
          params
        ),
        client.query(
          `SELECT s.id, s.stage_name, s.color_hex, s.capi_event_mapping, COUNT(l.id) AS count
           FROM tenant_pipeline_stages s
           LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.stage_id = s.id AND l.is_deleted = false
           WHERE s.tenant_id = $1
           GROUP BY s.id, s.stage_name, s.color_hex, s.capi_event_mapping, s.stage_order
           ORDER BY s.stage_order ASC`,
          [ctx.tenantId]
        ),
        client.query<{ held_cnt: number; blacklisted_cnt: number }>(
          `SELECT
             COALESCE(SUM(CASE WHEN status = 'held' THEN 1 ELSE 0 END), 0) AS held_cnt,
             COALESCE(SUM(CASE WHEN status = 'blacklisted' THEN 1 ELSE 0 END), 0) AS blacklisted_cnt
           FROM held_leads
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query<{ total_tickets: number; pending_tickets: number; approved_tickets: number }>(
          `SELECT
             COUNT(*) AS total_tickets,
             COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_tickets,
             COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_tickets
           FROM data_reports
           WHERE tenant_id = $1`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT l.id, l.name, l.phone, l.source, l.status, l.is_accepted, l.is_duplicate_reminder,
                  l.created_at, u.full_name AS assigned_sale_name, s.stage_name, s.color_hex
           FROM leads l
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_to
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${where}
           ORDER BY l.created_at DESC
           LIMIT 12`,
          params
        ),
        client.query<{ sent_ok: number }>(
          `SELECT COUNT(*) AS sent_ok FROM capi_logs WHERE tenant_id = $1 AND response_status = 200`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT l.round_id, COALESCE(r.name, 'Chưa gắn vòng') AS round_name, COUNT(*) AS count
           FROM leads l
           LEFT JOIN distribution_rounds r ON r.tenant_id = l.tenant_id AND r.id = l.round_id
           WHERE ${where}
           GROUP BY l.round_id, r.name
           ORDER BY count DESC`,
          params
        ),
        client.query(
          `SELECT COALESCE(NULLIF(l.quality_status, ''), 'Pending') AS quality_status, COUNT(*) AS count
           FROM leads l
           WHERE ${where}
           GROUP BY COALESCE(NULLIF(l.quality_status, ''), 'Pending')
           ORDER BY count DESC`,
          params
        ),
        client.query(
          `SELECT dr.reporter_id AS id, COALESCE(u.full_name, 'Đại lý') AS name,
                  COUNT(dr.id) AS total_tickets,
                  COALESCE(SUM(CASE WHEN dr.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_tickets,
                  COALESCE(SUM(CASE WHEN dr.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_tickets,
                  COALESCE(SUM(CASE WHEN dr.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected_tickets
           FROM data_reports dr
           LEFT JOIN users u ON u.tenant_id = dr.tenant_id AND u.id = dr.reporter_id
           WHERE dr.tenant_id = $1
           GROUP BY dr.reporter_id, u.full_name
           ORDER BY total_tickets DESC`,
          [ctx.tenantId]
        ),
        client.query<{ created_at: Date | string; status: string; is_duplicate_reminder: boolean }>(
          `SELECT l.created_at, l.status, l.is_duplicate_reminder FROM leads l WHERE ${where}`,
          params
        ),
      ]);

      // Cross-dialect in-hours + time-series / 7x24 Heatmap aggregation in VN timezone
      let chartSeries: Array<Record<string, unknown>> = [];
      let heatmapMatrix: Array<{ wday: number; hour: number; count: number }> = [];
      let inHoursCount = 0;

      const hourBuckets = new Map<number, { total: number; assigned: number; dup: number }>();
      const heatmapBuckets = new Map<string, { wday: number; hour: number; count: number }>();
      const dayBuckets = new Map<string, { total: number; assigned: number; dup: number }>();

      for (const row of leadEventsRes.rows) {
        const zp = getZonedDateParts(row.created_at, 'Asia/Ho_Chi_Minh');
        if (!zp) continue;
        const mins = zp.hour * 60 + zp.minute;
        if (zp.isoDow <= 6 && mins >= startMins && mins <= endMins) {
          inHoursCount++;
        }
        const isAssigned = row.status === 'assigned';
        const isDup = row.is_duplicate_reminder === true;

        if (chartMode === 'hour') {
          const cur = hourBuckets.get(zp.hour) || { total: 0, assigned: 0, dup: 0 };
          cur.total++;
          if (isAssigned) cur.assigned++;
          if (isDup) cur.dup++;
          hourBuckets.set(zp.hour, cur);
        } else if (chartMode === 'heatmap') {
          const key = `${zp.isoDow}:${zp.hour}`;
          const cur = heatmapBuckets.get(key) || { wday: zp.isoDow, hour: zp.hour, count: 0 };
          cur.count++;
          heatmapBuckets.set(key, cur);
        } else {
          const cur = dayBuckets.get(zp.ymd) || { total: 0, assigned: 0, dup: 0 };
          cur.total++;
          if (isAssigned) cur.assigned++;
          if (isDup) cur.dup++;
          dayBuckets.set(zp.ymd, cur);
        }
      }

      if (chartMode === 'hour') {
        chartSeries = [...hourBuckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([hr, v]) => ({
            label: `${String(hr).padStart(2, '0')}:00`,
            total: v.total,
            assigned: v.assigned,
            duplicate: v.dup,
          }));
      } else if (chartMode === 'heatmap') {
        heatmapMatrix = [...heatmapBuckets.values()];
      } else {
        chartSeries = [...dayBuckets.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .slice(0, 60)
          .map(([dayStr, v]) => ({
            label: dayStr,
            total: v.total,
            assigned: v.assigned,
            duplicate: v.dup,
          }));
      }

      const k = kpiRes.rows[0] || {};
      const total = Number(k.total_leads || 0);
      const heldCnt = Number(heldRes.rows[0]?.held_cnt || 0);
      const blacklistedCnt = Number(heldRes.rows[0]?.blacklisted_cnt || 0);
      const totalReceived = total + heldCnt + blacklistedCnt;
      const accepted = Number(k.accepted_leads || 0);
      const slaRate = total > 0 ? Math.round(((total - Number(k.sla_breached_leads || 0)) / total) * 100) : 100;
      const assignedTotal = Number(k.assigned_leads || 0);
      const compensatedTotal = Number(k.compensated_leads || 0);
      const inHours = inHoursCount;
      const outHours = Math.max(0, total - inHours);

      return {
        kpis: {
          total_received: totalReceived,
          total_leads: total,
          assigned_leads: assignedTotal,
          assigned_normal_leads: Math.max(0, assignedTotal - compensatedTotal),
          compensated_leads: compensatedTotal,
          unassigned_leads: Number(k.unassigned_leads || 0),
          duplicate_leads: Number(k.duplicate_leads || 0),
          held_leads: heldCnt,
          blacklisted_leads: blacklistedCnt,
          below_standard_leads: Number(k.below_standard_leads || 0),
          error_tickets: Number(ticketRes.rows[0]?.total_tickets || 0),
          pending_tickets: Number(ticketRes.rows[0]?.pending_tickets || 0),
          approved_tickets: Number(ticketRes.rows[0]?.approved_tickets || 0),
          accepted_leads: accepted,
          acceptance_rate_pct: total > 0 ? Math.round((accepted / total) * 100) : 0,
          sla_compliance_pct: slaRate,
          won_leads: Number(k.won_leads || 0),
          capi_200_count: Number(capiRes.rows[0]?.sent_ok || 0),
          ai_tokens_used: Number(k.ai_tokens_used || 0),
          zalo_sent_count: Number(k.zalo_sent_count || 0),
          email_sent_count: Number(k.email_sent_count || 0),
        },
        chart_mode: chartMode,
        chart_series: chartSeries,
        heatmap_matrix: heatmapMatrix,
        by_consultant: consultantRes.rows,
        by_source: sourceRes.rows,
        by_stage: stageRes.rows,
        round_ratio: roundRatioRes.rows,
        pipeline_stats: pipelineStatsRes.rows,
        error_by_consultant: errorByConsultantRes.rows,
        out_of_hours: {
          in_hours: inHours,
          out_hours: outHours,
          total,
          in_hours_pct: total > 0 ? Math.round((inHours / total) * 100) : 100,
          out_hours_pct: total > 0 ? Math.round((outHours / total) * 100) : 0,
          work_schedule_start: cfg.work_schedule_start || '08:30',
          work_schedule_end: cfg.work_schedule_end || '18:00',
        },
        recent_logs: recentRes.rows.map((row) => ({
          ...row,
          phone: shouldMaskPiiForActor(ctx, cfg, { is_accepted: row.is_accepted })
            ? maskPhoneString(row.phone, cfg)
            : row.phone,
        })),
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'DASHBOARD_ANALYTICS_FAILED', err?.message || 'Không thể tải dữ liệu Dashboard.');
  }
});

/**
 * Fair-Share Audit & Gini Equity Engine
 */
analyticsRouter.get('/fair-share', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const roundId = req.query.round_id ? String(req.query.round_id) : null;
    const datePreset = String(req.query.date_preset || 'this_month');
    const dateInfo = resolveDateBounds(
      datePreset,
      req.query.start_date ? String(req.query.start_date) : null,
      req.query.end_date ? String(req.query.end_date) : null
    );

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      let targetRoundId = roundId;
      if (!targetRoundId) {
        const rRes = await client.query<{ id: string }>(
          'SELECT id FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC LIMIT 1',
          [ctx.tenantId]
        );
        targetRoundId = rRes.rows[0]?.id || null;
      }

      const params: unknown[] = [ctx.tenantId];
      const leadDateCond = bindDateParams(dateInfo.clause, params, dateInfo).replace(/created_at/g, 'l.created_at');

      let roundFilterSql = '';
      if (targetRoundId) {
        params.push(targetRoundId);
        roundFilterSql = `AND rc.round_id = $${params.length}`;
      }

      const [rowsRes, compLogsRes, roundsListRes] = await Promise.all([
        client.query(
          `SELECT rc.round_id, dr.name AS round_name, rc.user_id, u.full_name AS name, u.email, u.is_external_agency,
                  rc.receive_ratio, rc.data_per_turn, rc.leads_received_in_round, rc.compensation_count,
                  rc.skip_count, rc.current_turn_remaining,
                  p.status, p.is_available, p.vacation_mode, p.skipped_credit,
                  COALESCE(SUM(CASE WHEN l.id IS NOT NULL AND (${leadDateCond}) THEN 1 ELSE 0 END), 0) AS assigned_count,
                  COALESCE(SUM(CASE WHEN l.is_duplicate_reminder = true AND (${leadDateCond}) THEN 1 ELSE 0 END), 0) AS duplicate_count
           FROM round_consultants rc
           INNER JOIN distribution_rounds dr ON dr.tenant_id = rc.tenant_id AND dr.id = rc.round_id
           INNER JOIN users u ON u.tenant_id = rc.tenant_id AND u.id = rc.user_id
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = rc.tenant_id AND p.user_id = rc.user_id
           LEFT JOIN leads l ON l.tenant_id = rc.tenant_id AND l.assigned_to = rc.user_id AND l.is_deleted = false
             ${targetRoundId ? 'AND (l.round_id = rc.round_id OR l.round_id IS NULL)' : ''}
           WHERE rc.tenant_id = $1 ${roundFilterSql}
           GROUP BY rc.round_id, dr.name, rc.user_id, u.full_name, u.email, u.is_external_agency,
                    rc.receive_ratio, rc.data_per_turn, rc.leads_received_in_round, rc.compensation_count,
                    rc.skip_count, rc.current_turn_remaining, p.status, p.is_available, p.vacation_mode, p.skipped_credit
           ORDER BY assigned_count DESC, u.full_name ASC`,
          params
        ),
        client.query(
          `SELECT acl.id, acl.round_id, acl.consultant_user_id, u.full_name AS consultant_name,
                  acl.ticket_id, acl.amount, acl.reason, acl.source_type, acl.created_at
           FROM active_compensation_logs acl
           LEFT JOIN users u ON u.tenant_id = acl.tenant_id AND u.id = acl.consultant_user_id
           WHERE acl.tenant_id = $1
           ORDER BY acl.created_at DESC
           LIMIT 50`,
          [ctx.tenantId]
        ),
        client.query(
          'SELECT id, name, is_active FROM distribution_rounds WHERE tenant_id = $1 ORDER BY priority ASC',
          [ctx.tenantId]
        ),
      ]);

      // Count approved tickets per consultant
      const ticketRes = await client.query<{ reporter_id: string; approved_cnt: number; total_cnt: number }>(
        `SELECT reporter_id,
                COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_cnt,
                COUNT(*) AS total_cnt
         FROM data_reports
         WHERE tenant_id = $1
         GROUP BY reporter_id`,
        [ctx.tenantId]
      );
      const ticketMap = new Map<string, { approved: number; total: number }>();
      for (const t of ticketRes.rows) {
        ticketMap.set(t.reporter_id, { approved: t.approved_cnt, total: t.total_cnt });
      }

      const consultants = rowsRes.rows.map((r) => {
        const tk = ticketMap.get(r.user_id) || { approved: 0, total: 0 };
        return {
          id: r.user_id,
          round_id: r.round_id,
          round_name: r.round_name,
          name: r.name,
          email: r.email,
          is_external_agency: Boolean(r.is_external_agency),
          receive_ratio: Number(r.receive_ratio || 1),
          data_per_turn: Number(r.data_per_turn || 1),
          assigned_count: Number(r.assigned_count || 0),
          duplicate_count: Number(r.duplicate_count || 0),
          ticket_count: tk.approved,
          total_ticket_count: tk.total,
          compensation_count: Number(r.compensation_count || 0),
          pending_compensation: Number(r.compensation_count || 0),
          skip_count: Number(r.skip_count || 0),
          skipped_credit: Number(r.skipped_credit || 0),
          current_turn_remaining: Number(r.current_turn_remaining || 0),
          status: r.status || 'active',
          is_available: r.is_available ?? true,
        };
      });

      const totalLeads = consultants.reduce((s, c) => s + c.assigned_count, 0);
      const totalWeight = consultants.reduce((s, c) => s + c.receive_ratio, 0);

      // Compute normalized Gini coefficient across weighted ratios
      const ratios = consultants.map((c) => c.assigned_count / Math.max(1, c.receive_ratio));
      let gini = 0;
      if (ratios.length > 1) {
        const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        if (mean > 0) {
          let diffSum = 0;
          for (let i = 0; i < ratios.length; i++) {
            for (let j = 0; j < ratios.length; j++) {
              diffSum += Math.abs(ratios[i] - ratios[j]);
            }
          }
          gini = diffSum / (2 * ratios.length * ratios.length * mean);
        }
      }

      const enriched = consultants.map((c) => {
        const expected = totalWeight > 0 ? (totalLeads * c.receive_ratio) / totalWeight : 0;
        const deviationPct = expected > 0 ? Number((((c.assigned_count - expected) / expected) * 100).toFixed(1)) : 0;
        return {
          ...c,
          expected_count: Number(expected.toFixed(1)),
          deviation_pct: deviationPct,
          net_success_count: Math.max(0, c.assigned_count - c.ticket_count + c.compensation_count),
        };
      });

      return {
        selected_round_id: targetRoundId,
        rounds: roundsListRes.rows,
        totalLeads,
        gini_coefficient: Number(gini.toFixed(4)),
        fairness_score_pct: Number(((1 - Math.min(1, gini)) * 100).toFixed(1)),
        consultants: enriched,
        compensation_logs: compLogsRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'FAIR_SHARE_FAILED', err?.message || 'Không thể tải đối soát công bằng.');
  }
});

analyticsRouter.post(
  '/fair-share/compensate',
  requireAnyPermission([
    ['fair_share', 'edit'],
    ['rounds', 'edit'],
  ]),
  async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { round_id, consultant_user_id, amount = 1, reason = 'Bù lượt chủ động từ Admin' } = req.body || {};
    const delta = Math.round(Number(amount || 0));
    if (!round_id || !consultant_user_id || delta === 0) {
      sendApiError(res, 422, 'INVALID_COMPENSATION', 'Vui lòng chọn vòng, nhân sự và số lượt bù khác 0.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const upd = await client.query(
        `UPDATE round_consultants
         SET compensation_count = GREATEST(0, compensation_count + $4),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND round_id = $2 AND user_id = $3
         RETURNING *`,
        [ctx.tenantId, round_id, consultant_user_id, delta]
      );
      if (!upd.rows[0]) throw new Error('CONSULTANT_NOT_IN_ROUND');

      await client.query(
        `INSERT INTO active_compensation_logs (
           tenant_id, round_id, consultant_user_id, admin_user_id, amount, reason, source_type
         ) VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
        [ctx.tenantId, round_id, consultant_user_id, ctx.userId, delta, String(reason).trim()]
      );

      return upd.rows[0];
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'COMPENSATION_FAILED', err?.message || 'Không thể cộng/trừ lượt bù.');
  }
});

/**
 * Ads Performance Analytics (`meta_ads_insights` joined with `leads` quality)
 */
analyticsRouter.get('/ads-performance', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [insightsRes, leadAggRes] = await Promise.all([
        client.query(
          `SELECT ad_id, MAX(ad_name) AS ad_name, MAX(adset_id) AS adset_id, MAX(adset_name) AS adset_name,
                  MAX(campaign_id) AS campaign_id, MAX(campaign_name) AS campaign_name,
                  SUM(spend)::numeric AS spend, SUM(impressions)::int AS impressions,
                  SUM(clicks)::int AS clicks, SUM(reach)::int AS reach,
                  SUM(meta_leads)::int AS meta_leads,
                  MAX(thumbnail_url) AS thumbnail_url, MAX(image_url) AS image_url,
                  MAX(creative_title) AS creative_title, MAX(creative_body) AS creative_body,
                  MAX(story_id) AS story_id, MAX(optimization_goal) AS optimization_goal
           FROM meta_ads_insights
           WHERE tenant_id = $1
           GROUP BY ad_id
           ORDER BY spend DESC`,
          [ctx.tenantId]
        ),
        client.query(
          `SELECT COALESCE(l.ad_id, 'unattributed') AS ad_id,
                  COUNT(*) AS total_leads,
                  COALESCE(SUM(CASE WHEN l.status = 'assigned' THEN 1 ELSE 0 END), 0) AS assigned_leads,
                  COALESCE(SUM(CASE WHEN LOWER(l.quality_status) IN ('qualified', 'good', 'hot') THEN 1 ELSE 0 END), 0) AS qualified_cnt,
                  COALESCE(SUM(CASE WHEN LOWER(l.quality_status) IN ('booked', 'scheduled') THEN 1 ELSE 0 END), 0) AS booked_cnt,
                  COALESCE(SUM(CASE WHEN LOWER(l.quality_status) IN ('booking', 'deposited') THEN 1 ELSE 0 END), 0) AS deposit_cnt,
                  COALESCE(SUM(CASE WHEN LOWER(l.quality_status) IN ('closed', 'won') THEN 1 ELSE 0 END), 0) AS closed_cnt,
                  COALESCE(SUM(CASE WHEN LOWER(l.quality_status) IN ('disqualified', 'notlead', 'junk') THEN 1 ELSE 0 END), 0) AS notlead_cnt
           FROM leads l
           WHERE l.tenant_id = $1 AND l.is_deleted = false
           GROUP BY COALESCE(l.ad_id, 'unattributed')`,
          [ctx.tenantId]
        ),
      ]);

      const leadMap = new Map<string, any>();
      for (const row of leadAggRes.rows) {
        leadMap.set(row.ad_id, row);
      }

      const ads = insightsRes.rows.map((ins) => {
        const lm = leadMap.get(ins.ad_id) || {};
        const spend = Number(ins.spend || 0);
        const clicks = Number(ins.clicks || 0);
        const impressions = Number(ins.impressions || 0);
        const totalLeads = Number(lm.total_leads || ins.meta_leads || 0);
        const positiveLeads =
          Number(lm.qualified_cnt || 0) +
          Number(lm.booked_cnt || 0) +
          Number(lm.deposit_cnt || 0) +
          Number(lm.closed_cnt || 0);
        const negativeLeads = Number(lm.notlead_cnt || 0);
        const unrated = Math.max(0, totalLeads - positiveLeads - negativeLeads);

        return {
          ad_id: ins.ad_id,
          ad_name: ins.ad_name || `Ad ${ins.ad_id}`,
          adset_id: ins.adset_id || '',
          adset_name: ins.adset_name || '',
          campaign_id: ins.campaign_id || '',
          campaign_name: ins.campaign_name || 'Meta Campaign',
          platform: 'facebook',
          status: 'ACTIVE',
          thumbnail_url: ins.thumbnail_url || '',
          image_url: ins.image_url || '',
          creative_title: ins.creative_title || '',
          creative_body: ins.creative_body || '',
          story_id: ins.story_id || '',
          optimization_goal: ins.optimization_goal || 'LEAD_GENERATION',
          spend,
          impressions,
          clicks,
          reach: Number(ins.reach || 0),
          cpc: clicks > 0 ? Math.round(spend / clicks) : 0,
          cpm: impressions > 0 ? Math.round((spend / impressions) * 1000) : 0,
          ctr: impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
          total_leads: totalLeads,
          assigned_leads: Number(lm.assigned_leads || 0),
          positive_leads: positiveLeads,
          negative_leads: negativeLeads,
          positive_rate: totalLeads > 0 ? Math.round((positiveLeads / totalLeads) * 100) : 0,
          cpl: totalLeads > 0 ? Math.round(spend / totalLeads) : 0,
          cpql: positiveLeads > 0 ? Math.round(spend / positiveLeads) : 0,
          pipeline: {
            Qualified: Number(lm.qualified_cnt || 0),
            Booked: Number(lm.booked_cnt || 0),
            Booking: Number(lm.deposit_cnt || 0),
            Deposited: 0,
            Closed: Number(lm.closed_cnt || 0),
            Badtiming: 0,
            NoAnswer: 0,
            Notlead: negativeLeads,
            unrated,
          },
        };
      });

      const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
      const totalAdLeads = ads.reduce((s, a) => s + a.total_leads, 0);
      const totalPositive = ads.reduce((s, a) => s + a.positive_leads, 0);

      return {
        summary: {
          total_ads_tracked: ads.length,
          ads_with_leads: ads.filter((a) => a.total_leads > 0).length,
          total_ad_leads: totalAdLeads,
          unattributed_leads: Number(leadMap.get('unattributed')?.total_leads || 0),
          total_positive_leads: totalPositive,
          total_negative_leads: ads.reduce((s, a) => s + a.negative_leads, 0),
          overall_positive_rate: totalAdLeads > 0 ? Math.round((totalPositive / totalAdLeads) * 100) : 0,
          total_spend: totalSpend,
          avg_cpl: totalAdLeads > 0 ? Math.round(totalSpend / totalAdLeads) : 0,
          avg_cpql: totalPositive > 0 ? Math.round(totalSpend / totalPositive) : 0,
        },
        ads,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'ADS_PERFORMANCE_FAILED', err?.message || 'Không thể tải hiệu suất Meta Ads.');
  }
});


// Workspace-level aliases for 1-Click 4-Package Switch (`/api/v1/workspace/package` & `/api/v1/workspace/switch-package`)
const workspacePackageSwitchHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const targetCode = b.package_code || b.plan_tier || b.package;

    const switched = await withTenantTransaction(ctx.tenantId, (client) =>
      switchTenantSaasPackageInTx(client, ctx.tenantId, ctx.userId, {
        package_code: targetCode,
        education_addon: b.education_addon,
        industry_key: b.industry_key,
        note: b.note,
      })
    );

    tenantRedis.invalidateTenantCache(ctx.tenantId, switched.slug || ctx.tenantSlug);
    res.json({ success: true, data: switched });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INVALID_PACKAGE_CODE')) {
      sendApiError(res, 422, 'INVALID_PACKAGE_CODE', msg);
      return;
    }
    sendApiError(res, 500, 'SWITCH_PACKAGE_FAILED', msg || 'Không thể chuyển đổi gói sản phẩm.');
  }
};

workspaceRouter.post(
  ['/package', '/switch-package'],
  requirePermission('billing', 'manage_config'),
  workspacePackageSwitchHandler
);
workspaceRouter.patch(
  ['/package', '/switch-package'],
  requirePermission('billing', 'manage_config'),
  workspacePackageSwitchHandler
);
