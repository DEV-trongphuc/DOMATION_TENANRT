import { withSystemPrivilege } from '../../core/database/transaction.ts';
import { drainUnassignedLeadsFairShare, isWithinWorkSchedule } from '../../services/distribution.service.ts';
import { getTenantSettingsCached } from '../../core/settings/tenant-cache.ts';
import { getPlatformOperationalConfigCached } from '../../core/settings/platform-config.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';

export async function runUnassignedLeadDrainer(tenantIdFilter?: string): Promise<number> {
  const opsCfg = await getPlatformOperationalConfigCached();
  const drainBatchLimit = opsCfg.cron_limits.drain_batch_limit;
  const tenantsWithQueue = await withSystemPrivilege(async (client) => {
    const sql = `
      SELECT l.tenant_id, MIN(l.created_at) AS oldest_pending, COUNT(l.id) AS pending_count
      FROM leads l
      INNER JOIN tenants t ON t.id = l.tenant_id
      WHERE l.status IN ('unassigned_pending', 'recalled')
        AND l.assigned_to IS NULL
        AND l.is_deleted = false
        AND t.status IN ('active', 'trial')
        ${tenantIdFilter ? 'AND l.tenant_id = $1' : ''}
      GROUP BY l.tenant_id
      ORDER BY oldest_pending ASC
      LIMIT ${drainBatchLimit}
    `;
    const res = await client.query(sql, tenantIdFilter ? [tenantIdFilter] : []);
    return res.rows.map((r: any) => r.tenant_id as string);
  });

  if (tenantsWithQueue.length === 0) return 0;

  // Fair multi-tenant queue processing: Rotate tenant list based on last processed cursor
  // to avoid head-of-line blocking when one tenant has a massive backlog.
  let orderedTenants = tenantsWithQueue;
  if (!tenantIdFilter && tenantsWithQueue.length > 1) {
    const lastTenantId = await tenantRedis.get('lead_drainer_last_tenant_id', 'system').catch(() => null);
    if (lastTenantId) {
      const idx = tenantsWithQueue.indexOf(lastTenantId);
      if (idx !== -1 && idx < tenantsWithQueue.length - 1) {
        orderedTenants = [...tenantsWithQueue.slice(idx + 1), ...tenantsWithQueue.slice(0, idx + 1)];
      }
    }
  }

  let totalDrained = 0;
  let lastProcessedTenantId = '';

  for (const tenantId of orderedTenants) {
    const cfg = await getTenantSettingsCached(tenantId);
    if (!cfg.auto_drain_on_online) continue;

    // Find available sale whose schedule is currently active
    const availableSales = await withSystemPrivilege(async (client) => {
      const res = await client.query<{ id: string; full_name: string; work_schedule: any }>(
        `SELECT u.id, u.full_name, p.work_schedule
         FROM users u
         INNER JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         WHERE u.tenant_id = $1
           AND u.role = 'sale'
           AND p.status = 'active'
           AND p.is_available = true
           AND p.vacation_mode = false
         ORDER BY u.created_at ASC, u.id ASC`,
        [tenantId]
      );
      const now = new Date();
      return cfg.enforce_work_schedule
        ? res.rows.filter((s) => isWithinWorkSchedule(s.work_schedule, now, cfg.timezone_offset_hours))
        : res.rows;
    });

    if (availableSales.length > 0) {
      const drained = await drainUnassignedLeadsFairShare(
        tenantId,
        availableSales.map((s) => ({ id: s.id, full_name: s.full_name }))
      );
      totalDrained += drained;
      if (drained > 0) {
        lastProcessedTenantId = tenantId;
      }
    }
  }

  if (lastProcessedTenantId) {
    await tenantRedis.set('lead_drainer_last_tenant_id', lastProcessedTenantId, 86400, 'system').catch(() => undefined);
  }

  return totalDrained;
}
