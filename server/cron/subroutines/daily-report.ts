import crypto from 'node:crypto';
import { withSystemPrivilege, withTenantTransaction } from '../../core/database/transaction.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import { normalizeTenantSettings, type TenantSettings } from '../../core/settings/tenant-settings.ts';
import { getZonedDateParts } from '../../routes/workspace.routes.ts';
import {
  buildTenantBrandForReport,
  compileTenantCrmReportMetrics,
  dispatchTenantDailyReportChannels,
  fetchTenantMetaAdsDailySummary,
  resolveReportWindow,
  type CompiledDailyReportPayload,
  type ReportPeriodType,
  type ReportWindow,
} from '../../services/daily-report.service.ts';

const WEEKDAY_TO_ISO_DOW: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

function parseSettingsObject(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, any>) };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, any>;
    } catch {}
  }
  return {};
}

function hasAnyEnabledReportChannel(cfg: TenantSettings): boolean {
  const ch = cfg.daily_report_channels;
  if (!ch) return false;
  return Boolean(ch.zalo || ch.telegram || ch.email || ch.discord);
}

function getSentMarkerKey(period: ReportPeriodType): string {
  if (period === 'weekly') return '_weekly_report_sent_key';
  if (period === 'monthly') return '_monthly_report_sent_key';
  return '_daily_report_sent_date';
}

function getExpectedSentMarkerVal(period: ReportPeriodType, window: ReportWindow): string {
  return period === 'daily' ? window.ymd : window.runKey;
}

async function recordDailyReportCronRun(params: {
  tenantId: string;
  runKey: string;
  status: 'success' | 'partial' | 'error';
  channelsDelivered: string[];
  errors: string[];
  durationMs: number;
}): Promise<void> {
  try {
    await withTenantTransaction(params.tenantId, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM tenant_cron_runs
         WHERE tenant_id = $1 AND subroutine_key = 'daily_report' AND run_key = $2
         LIMIT 1`,
        [params.tenantId, params.runKey]
      );
      const detailsJson = JSON.stringify({
        channels_delivered: params.channelsDelivered,
        errors: params.errors,
      });
      if (existing.rows[0]) {
        await client.query(
          `UPDATE tenant_cron_runs
           SET status = $2,
               items_processed = $3,
               duration_ms = $4,
               error_message = $5,
               details_json = $6::jsonb,
               finished_at = clock_timestamp()
           WHERE id = $1`,
          [
            existing.rows[0].id,
            params.status,
            params.channelsDelivered.length,
            Math.max(0, Math.round(params.durationMs)),
            params.errors.length > 0 ? params.errors.join(' | ').slice(0, 500) : null,
            detailsJson,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO tenant_cron_runs (
             id, tenant_id, subroutine_key, run_key, status, items_processed, duration_ms,
             error_message, details_json, triggered_by, started_at, finished_at
           ) VALUES ($1, $2, 'daily_report', $3, $4, $5, $6, $7, $8::jsonb, 'scheduler', clock_timestamp(), clock_timestamp())`,
          [
            crypto.randomUUID(),
            params.tenantId,
            params.runKey,
            params.status,
            params.channelsDelivered.length,
            Math.max(0, Math.round(params.durationMs)),
            params.errors.length > 0 ? params.errors.join(' | ').slice(0, 500) : null,
            detailsJson,
          ]
        );
      }
    });
  } catch {
    // Recording cron telemetry must never fail the worker
  }
}

export async function runDailyReportWorker(
  tenantIdFilter?: string,
  options?: {
    now?: Date;
    allowGraphInSilentMode?: boolean;
  }
): Promise<number> {
  const now = options?.now ?? new Date();
  let dispatchedCount = 0;

  const candidates = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT id, slug, name, status, settings
      FROM tenants
      WHERE status IN ('active', 'trial', 'grace')
        ${tenantIdFilter ? 'AND id = $1' : ''}
      ORDER BY created_at ASC
      LIMIT 200
    `;
    const r = await client.query<{
      id: string;
      slug: string;
      name: string;
      status: string;
      settings: unknown;
    }>(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return r.rows;
  });

  for (const tRow of candidates) {
    const preRaw = parseSettingsObject(tRow.settings);
    const preCfg = normalizeTenantSettings(preRaw);
    if (!hasAnyEnabledReportChannel(preCfg)) {
      continue;
    }

    const tz = preCfg.timezone_name || 'Asia/Ho_Chi_Minh';
    const zp = getZonedDateParts(now, tz);
    if (!zp) continue;
    const currentHHmm = `${String(zp.hour).padStart(2, '0')}:${String(zp.minute).padStart(2, '0')}`;

    const duePeriods: Array<{ period: ReportPeriodType; window: ReportWindow }> = [];

    // 1. Daily schedule check (same-day catch-up: currentHHmm >= scheduledHHmm)
    const dailyWindow = resolveReportWindow('daily', tz, now);
    if (
      currentHHmm >= preCfg.zalo_daily_report_time &&
      preRaw._daily_report_sent_date !== dailyWindow.ymd &&
      preRaw.daily_report_sent_date !== dailyWindow.ymd
    ) {
      duePeriods.push({ period: 'daily', window: dailyWindow });
    }

    // 2. Weekly schedule check
    const targetWeeklyDow = WEEKDAY_TO_ISO_DOW[preCfg.zalo_weekly_report_day];
    if (targetWeeklyDow && zp.isoDow === targetWeeklyDow && currentHHmm >= preCfg.zalo_weekly_report_time) {
      const weeklyWindow = resolveReportWindow('weekly', tz, now);
      if (preRaw._weekly_report_sent_key !== weeklyWindow.runKey) {
        duePeriods.push({ period: 'weekly', window: weeklyWindow });
      }
    }

    // 3. Monthly schedule check (1st day of month in tenant timezone)
    if (preCfg.zalo_monthly_report_enabled === true && zp.day === 1 && currentHHmm >= preCfg.zalo_monthly_report_time) {
      const monthlyWindow = resolveReportWindow('monthly', tz, now);
      if (preRaw._monthly_report_sent_key !== monthlyWindow.runKey) {
        duePeriods.push({ period: 'monthly', window: monthlyWindow });
      }
    }

    if (duePeriods.length === 0) continue;

    for (const { period, window } of duePeriods) {
      const periodStartMs = Date.now();
      let claimed: {
        cfg: TenantSettings;
        rawSettings: Record<string, any>;
        payloadBase: Omit<CompiledDailyReportPayload, 'metaAds'>;
      } | null = null;

      try {
        claimed = await withTenantTransaction(tRow.id, async (client) => {
          const lockRes = await client.query<{
            id: string;
            slug: string;
            name: string;
            status: string;
            settings: unknown;
          }>('SELECT id, slug, name, status, settings FROM tenants WHERE id = $1 FOR UPDATE', [tRow.id]);

          const locked = lockRes.rows[0];
          if (!locked || !['active', 'trial', 'grace'].includes(locked.status)) {
            return null;
          }

          const rawSettings = parseSettingsObject(locked.settings);
          const cfg = normalizeTenantSettings(rawSettings);
          if (!hasAnyEnabledReportChannel(cfg)) {
            return null;
          }

          const markerKey = getSentMarkerKey(period);
          const markerVal = getExpectedSentMarkerVal(period, window);
          if (rawSettings[markerKey] === markerVal) {
            return null;
          }
          if (period === 'daily' && rawSettings.daily_report_sent_date === window.ymd) {
            return null;
          }

          // Belt-and-suspenders idempotency check via tenant_cron_runs
          try {
            const runCheck = await client.query<{ id: string }>(
              `SELECT id FROM tenant_cron_runs
               WHERE tenant_id = $1 AND subroutine_key = 'daily_report' AND run_key = $2 AND status = 'success'
               LIMIT 1`,
              [tRow.id, window.runKey]
            );
            if (runCheck.rows[0]) {
              return null;
            }
          } catch {
            // If tenant_cron_runs query fails, rely on tenants.settings marker
          }

          const crm = await compileTenantCrmReportMetrics(client, tRow.id, window, cfg);
          const nextSettings = {
            ...rawSettings,
            [markerKey]: markerVal,
          };

          await client.query(
            `UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
            [tRow.id, JSON.stringify(nextSettings)]
          );

          const brandName = buildTenantBrandForReport(cfg, {
            name: locked.name,
            slug: locked.slug,
            settings: nextSettings,
          });

          return {
            cfg,
            rawSettings: nextSettings,
            payloadBase: {
              tenantId: tRow.id,
              tenantName: locked.name || tRow.name,
              tenantSlug: locked.slug || tRow.slug,
              brandName,
              window,
              crm,
            },
          };
        });
      } catch (err: any) {
        console.error(`[DailyReport] Failed claiming report lock for tenant ${tRow.id}:`, err?.message || err);
        continue;
      }

      if (!claimed) continue;
      tenantRedis.invalidateTenantCache(tRow.id, claimed.payloadBase.tenantSlug);

      // Outside any DB transaction: fetch optional Meta Ads summary (strictly if ON) and dispatch outbound channels
      let metaAds = null;
      if (claimed.cfg.daily_report_include_meta_ads === true) {
        metaAds = await fetchTenantMetaAdsDailySummary(tRow.id, window, claimed.cfg, {
          allowGraphInSilentMode: options?.allowGraphInSilentMode,
        });
      }

      const fullPayload: CompiledDailyReportPayload = {
        ...claimed.payloadBase,
        metaAds,
      };

      const dispatchRes = await dispatchTenantDailyReportChannels({
        payload: fullPayload,
        cfg: claimed.cfg,
        rawSettings: claimed.rawSettings,
      });

      if (dispatchRes.channelsDelivered.length > 0) {
        dispatchedCount += 1;
      } else if (dispatchRes.errors.length > 0) {
        const markerKey = getSentMarkerKey(period);
        const markerVal = getExpectedSentMarkerVal(period, window);
        try {
          await withTenantTransaction(tRow.id, async (client) => {
            const curRes = await client.query<{ settings: unknown }>(
              'SELECT settings FROM tenants WHERE id = $1 FOR UPDATE',
              [tRow.id]
            );
            const curSettings = parseSettingsObject(curRes.rows[0]?.settings);
            let changed = false;
            if (curSettings[markerKey] === markerVal) {
              delete curSettings[markerKey];
              changed = true;
            }
            if (period === 'daily' && curSettings.daily_report_sent_date === markerVal) {
              delete curSettings.daily_report_sent_date;
              changed = true;
            }
            if (changed) {
              await client.query(
                `UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1`,
                [tRow.id, JSON.stringify(curSettings)]
              );
            }
          });
          tenantRedis.invalidateTenantCache(tRow.id, claimed.payloadBase.tenantSlug);
        } catch (rollbackErr: any) {
          console.warn(
            `[DailyReport] Failed rolling back ${markerKey} after channel failure for tenant ${tRow.id}:`,
            rollbackErr?.message || rollbackErr
          );
        }
      }

      const runStatus =
        dispatchRes.errors.length === 0
          ? 'success'
          : dispatchRes.channelsDelivered.length > 0
            ? 'partial'
            : 'error';

      await recordDailyReportCronRun({
        tenantId: tRow.id,
        runKey: window.runKey,
        status: runStatus,
        channelsDelivered: dispatchRes.channelsDelivered,
        errors: dispatchRes.errors,
        durationMs: Date.now() - periodStartMs,
      });
    }
  }

  return dispatchedCount;
}
