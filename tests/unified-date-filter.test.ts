import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidIsoDateString,
  resolveDateBounds,
} from '../server/routes/workspace.routes.ts';
import {
  normalizeLegacyDatePreset,
  buildLegacyDateFilter,
  buildLegacyDateFilterFromParams,
} from '../server/routes/legacy/legacy-helpers.ts';
import { resolveOverviewDateWindow } from '../server/services/meta-ads.service.ts';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';

describe('Unified Date Filter — Backend Parser & VN +07:00 Bounds', () => {
  // 2026-11-20 14:30:00+07:00 (Friday) -> 2026-11-20T07:30:00.000Z
  const REF_FRI_VN = new Date('2026-11-20T07:30:00.000Z');
  // 2026-11-22 01:00:00+07:00 (Sunday in VN, still Saturday 18:00 UTC)
  const REF_SUN_EARLY_VN = new Date('2026-11-21T18:00:00.000Z');

  it('validates ISO dates strictly and rejects impossible calendar dates', () => {
    assert.equal(isValidIsoDateString('2026-11-20'), true);
    assert.equal(isValidIsoDateString('2024-02-29'), true); // leap year
    assert.equal(isValidIsoDateString('2026-02-29'), false); // non-leap year
    assert.equal(isValidIsoDateString('2026-02-31'), false);
    assert.equal(isValidIsoDateString('2026-13-01'), false);
    assert.equal(isValidIsoDateString('20-11-2026'), false);
    assert.equal(isValidIsoDateString(''), false);
    assert.equal(isValidIsoDateString(null), false);
  });

  it('maps all unified presets and Vietnamese aliases in normalizeLegacyDatePreset', () => {
    assert.equal(normalizeLegacyDatePreset('yesterday_to_today').preset, 'yesterday_to_today');
    assert.equal(normalizeLegacyDatePreset('Hôm qua - Hôm nay').preset, 'yesterday_to_today');
    assert.equal(normalizeLegacyDatePreset('Yesterday - Today').preset, 'yesterday_to_today');
    assert.equal(normalizeLegacyDatePreset('last_7days').preset, '7_days');
    assert.equal(normalizeLegacyDatePreset('7 ngày qua').preset, '7_days');
    assert.equal(normalizeLegacyDatePreset('last_30days').preset, '30_days');
    assert.equal(normalizeLegacyDatePreset('30 ngày qua').preset, '30_days');
    assert.equal(normalizeLegacyDatePreset('Tất cả thời gian').preset, 'all');
    assert.equal(normalizeLegacyDatePreset('all').preset, 'all');

    const customDash = normalizeLegacyDatePreset('2026-11-01 - 2026-11-15');
    assert.deepEqual(customDash, {
      preset: 'custom',
      startDate: '2026-11-01',
      endDate: '2026-11-15',
      isSingleDay: false,
    });

    const customVi = normalizeLegacyDatePreset('2026-11-10 đến 2026-11-10');
    assert.deepEqual(customVi, {
      preset: 'custom',
      startDate: '2026-11-10',
      endDate: '2026-11-10',
      isSingleDay: true,
    });

    // Inverted range auto-swaps
    const inverted = normalizeLegacyDatePreset('2026-11-20 - 2026-11-05');
    assert.equal(inverted.startDate, '2026-11-05');
    assert.equal(inverted.endDate, '2026-11-20');
  });

  it('gives explicit since/until higher priority than date preset', () => {
    const parsed = normalizeLegacyDatePreset('Tháng này', '2026-10-05', '2026-10-12');
    assert.equal(parsed.preset, 'custom');
    assert.equal(parsed.startDate, '2026-10-05');
    assert.equal(parsed.endDate, '2026-10-12');

    const sp = new URLSearchParams({
      date: 'today',
      since: '2026-09-01',
      until: '2026-09-15',
    });
    const df = buildLegacyDateFilterFromParams(sp);
    assert.equal(df.preset, 'custom');
    assert.equal(df.sinceIso, '2026-09-01');
    assert.equal(df.untilIso, '2026-09-15');

    const sqlParams: unknown[] = ['tenant-1'];
    const clause = df.bindSql('l.created_at', sqlParams);
    assert.equal(clause, 'l.created_at >= $2 AND l.created_at <= $3');
    assert.equal((sqlParams[1] as Date).toISOString(), new Date('2026-09-01T00:00:00+07:00').toISOString());
    assert.equal((sqlParams[2] as Date).toISOString(), new Date('2026-09-15T23:59:59.999+07:00').toISOString());
  });

  it('resolves exact VN +07:00 00:00:00 to 23:59:59.999 bounds for every preset', () => {
    const today = resolveDateBounds('today', null, null, REF_FRI_VN);
    assert.equal(today.sinceIso, '2026-11-20');
    assert.equal(today.untilIso, '2026-11-20');
    assert.equal((today.params[0] as Date).toISOString(), '2026-11-19T17:00:00.000Z');
    assert.equal((today.params[1] as Date).toISOString(), '2026-11-20T16:59:59.999Z');

    const y2t = resolveDateBounds('yesterday_to_today', null, null, REF_FRI_VN);
    assert.equal(y2t.sinceIso, '2026-11-19');
    assert.equal(y2t.untilIso, '2026-11-20');
    assert.equal((y2t.params[0] as Date).toISOString(), new Date('2026-11-19T00:00:00+07:00').toISOString());
    assert.equal((y2t.params[1] as Date).toISOString(), new Date('2026-11-20T23:59:59.999+07:00').toISOString());

    const last7 = resolveDateBounds('last_7days', null, null, REF_FRI_VN);
    assert.equal(last7.sinceIso, '2026-11-14');
    assert.equal(last7.untilIso, '2026-11-20');
    assert.equal((last7.params[0] as Date).toISOString(), new Date('2026-11-14T00:00:00+07:00').toISOString());

    const last30 = resolveDateBounds('last_30days', null, null, REF_FRI_VN);
    assert.equal(last30.sinceIso, '2026-10-22');
    assert.equal(last30.untilIso, '2026-11-20');

    const thisMonth = resolveDateBounds('this_month', null, null, REF_FRI_VN);
    assert.equal(thisMonth.sinceIso, '2026-11-01');
    assert.equal(thisMonth.untilIso, '2026-11-20');

    const lastMonth = resolveDateBounds('last_month', null, null, REF_FRI_VN);
    assert.equal(lastMonth.sinceIso, '2026-10-01');
    assert.equal(lastMonth.untilIso, '2026-10-31');

    // VN early Sunday 01:00+07:00 (Saturday 18:00 UTC) -> VN date is Sunday 2026-11-22, week starts Mon 2026-11-16
    const thisWeekSun = resolveDateBounds('this_week', null, null, REF_SUN_EARLY_VN);
    assert.equal(thisWeekSun.sinceIso, '2026-11-16');
    assert.equal(thisWeekSun.untilIso, '2026-11-22');

    const lastWeekSun = resolveDateBounds('last_week', null, null, REF_SUN_EARLY_VN);
    assert.equal(lastWeekSun.sinceIso, '2026-11-09');
    assert.equal(lastWeekSun.untilIso, '2026-11-15');

    const all = resolveDateBounds('all', null, null, REF_FRI_VN);
    assert.equal(all.clause, '1=1');
    assert.deepEqual(all.params, []);
  });

  it('computes previous-period SQL bounds for custom and rolling presets', () => {
    const df = buildLegacyDateFilter('custom', {
      since: '2026-11-11',
      until: '2026-11-20',
      nowRef: REF_FRI_VN,
    });
    const prevParams: unknown[] = ['t1'];
    const prevClause = df.bindPrevSql('l.created_at', prevParams);
    assert.equal(prevClause, 'l.created_at >= $2 AND l.created_at <= $3');
    // 10-day span prior to Nov 11..20 is Nov 1..10
    assert.equal((prevParams[1] as Date).toISOString(), new Date('2026-11-01T00:00:00+07:00').toISOString());
    assert.equal((prevParams[2] as Date).toISOString(), new Date('2026-11-10T23:59:59.999+07:00').toISOString());

    const allDf = buildLegacyDateFilter('all', { nowRef: REF_FRI_VN });
    assert.equal(allDf.bindPrevSql('l.created_at', []), null);
  });

  it('rejects impossible calendar dates in resolveOverviewDateWindow instead of passing them to SQL/Graph API', () => {
    const invalidWin = resolveOverviewDateWindow('7days', '2026-02-31', '2026-03-05');
    assert.notEqual(invalidWin.since, '2026-02-31');
    assert.equal(isValidIsoDateString(invalidWin.since), true);
    assert.equal(isValidIsoDateString(invalidWin.until), true);

    const swappedWin = resolveOverviewDateWindow('30days', '2026-11-18', '2026-11-05');
    assert.equal(swappedWin.since, '2026-11-05');
    assert.equal(swappedWin.until, '2026-11-18');
  });
});

describe('Unified Date Filter & Standalone Package Entitlements — Live HTTP Integration', () => {
  let harness: TestHarness;
  let token = '';
  let tenantId = '';
  let regUserId = '';
  const slug = 'udf-mkt-standalone';

  before(async () => {
    harness = await startTestServer();
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'UDF Standalone Test Co',
        tenant_slug: slug,
        admin_name: 'UDF Admin',
        work_email: 'admin@udf-standalone.vn',
        phone: '0901888999',
        password: 'StrongPassword123!',
        industry: 'real_estate',
        package_code: 'marketing_standalone',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    token = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;
    regUserId = reg.json.data.user.id;

    // Seed 2 leads right across the VN +07:00 midnight boundary for 2026-04-10:
    // Lead A: 2026-04-10 00:05:00+07:00 (= 2026-04-09T17:05:00.000Z) -> INSIDE 2026-04-10 VN
    // Lead B: 2026-04-09 23:55:00+07:00 (= 2026-04-09T16:55:00.000Z) -> OUTSIDE 2026-04-10 VN
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `INSERT INTO leads (tenant_id, name, phone, email, source, status, created_at)
         VALUES
           ($1, 'Lead Inside VN Midnight', '0901000001', 'in@test.vn', 'Facebook', 'assigned', $2),
           ($1, 'Lead Outside VN Midnight', '0901000002', 'out@test.vn', 'Facebook', 'assigned', $3)`,
        [
          tenantId,
          new Date('2026-04-10T00:05:00+07:00').toISOString(),
          new Date('2026-04-09T23:55:00+07:00').toISOString(),
        ]
      );
    });
  });

  after(async () => {
    await harness.close();
  });

  it('enforces explicit ?since=&until= over ?date=all with exact VN +07:00 midnight boundaries across legacy & analytics endpoints', async () => {
    const logsRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_logs&date=all&since=2026-04-10&until=2026-04-10',
      { token, tenantSlug: slug }
    );
    assert.equal(logsRes.status, 200);
    const items = Array.isArray(logsRes.json.data) ? logsRes.json.data : [];
    assert.equal(items.length, 1);
    assert.equal(items[0].name || items[0].full_name, 'Lead Inside VN Midnight');

    const statsRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_dashboard_stats&date=all&since=2026-04-10&until=2026-04-10',
      { token, tenantSlug: slug }
    );
    assert.equal(statsRes.status, 200);
    assert.equal(Number(statsRes.json.data?.total ?? 0), 1);

    const analyticsRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/analytics/dashboard?date_preset=all&since=2026-04-10&until=2026-04-10',
      { token, tenantSlug: slug }
    );
    assert.equal(analyticsRes.status, 200);
    assert.equal(Number(analyticsRes.json.data?.kpis?.total_leads ?? 0), 1);

    const twoDayRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/analytics/dashboard?date_preset=today&since=2026-04-09&until=2026-04-10',
      { token, tenantSlug: slug }
    );
    assert.equal(twoDayRes.status, 200);
    assert.equal(Number(twoDayRes.json.data?.kpis?.total_leads ?? 0), 2);

    const reportsRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_reports&since=2026-04-10&until=2026-04-10',
      { token, tenantSlug: slug }
    );
    assert.equal(reportsRes.status, 200);
    assert.equal(reportsRes.json.success, true);

    // export_csv respects explicit since/until and filters exact VN midnight boundary
    const csvRes = await fetch(
      `${harness.baseUrl}/api/v1/legacy?action=export_csv&since=2026-04-10&until=2026-04-10&status=assigned`,
      { headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Slug': slug } }
    );
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('Lead Inside VN Midnight'));
    assert.ok(!csvText.includes('Lead Outside VN Midnight'));

    // get_sale_portal_data honors date_mode and since/until
    const portalRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_sale_portal_data&date_mode=today',
      { token, tenantSlug: slug }
    );
    assert.equal(portalRes.status, 200);
    assert.equal(portalRes.json.success, true);
    const portalLeads = Array.isArray(portalRes.json.data?.leads) ? portalRes.json.data.leads : [];
    assert.equal(portalLeads.length, 0);

    // get_rounds does NOT fall back to lifetime leads_received_in_round on a 0-lead date window
    const userId = regUserId;
    await withTenantTransaction(tenantId, async (client) => {
      const pip = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 LIMIT 1',
        [tenantId]
      );
      const rIns = await client.query<{ id: string }>(
        `INSERT INTO distribution_rounds (tenant_id, pipeline_id, name, is_active, priority)
         VALUES ($1, $2, 'Test Round Window', true, 1) RETURNING id`,
        [tenantId, pip.rows[0].id]
      );
      await client.query(
        `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn, leads_received_in_round, is_active)
         VALUES ($1, $2, $3, 1, 1, 99, true)`,
        [tenantId, rIns.rows[0].id, userId]
      );
      await client.query(
        `INSERT INTO held_leads (tenant_id, round_id, name, phone, status, created_at)
         VALUES ($1, $2, 'Held Old', '0909000111', 'held', $3)`,
        [tenantId, rIns.rows[0].id, new Date('2026-04-09T23:50:00+07:00').toISOString()]
      );
    });

    const roundsEmptyWin = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_rounds&since=2020-01-01&until=2020-01-02',
      { token, tenantSlug: slug }
    );
    assert.equal(roundsEmptyWin.status, 200);
    const testRound = (roundsEmptyWin.json.data || []).find((r: any) => r.name === 'Test Round Window');
    assert.ok(testRound, 'Test Round Window must exist');
    assert.equal(testRound.total_leads, 0, 'Empty date window must report 0, not lifetime 99');
    assert.equal(testRound.leads_by_user[userId], 0, 'Consultant leads in empty window must be 0');

    // get_gatekeeper_stats filters rounds_breakdown by date window as well as stats
    const gkEmpty = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_gatekeeper_stats&since=2026-04-10&until=2026-04-10',
      { token, tenantSlug: slug }
    );
    assert.equal(gkEmpty.status, 200);
    assert.equal(Number(gkEmpty.json.stats?.total || 0), 0);
    assert.equal((gkEmpty.json.rounds_breakdown || []).length, 0);

    const gkHit = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_gatekeeper_stats&since=2026-04-09&until=2026-04-09',
      { token, tenantSlug: slug }
    );
    assert.equal(gkHit.status, 200);
    assert.equal(Number(gkHit.json.stats?.total || 0), 1);
    assert.equal(gkHit.json.rounds_breakdown.length, 1);
    assert.equal(Number(gkHit.json.rounds_breakdown[0].count), 1);
  });

  it('exposes package_code=marketing_standalone in both /auth/login and /myerp/tenant-config', async () => {
    const loginRes = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'admin@udf-standalone.vn',
        password: 'StrongPassword123!',
        tenant_slug: slug,
      },
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.json.data.tenant.package_code, 'marketing_standalone');

    const cfgRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/tenant-config', {
      token,
      tenantSlug: slug,
    });
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.json.data.package_code, 'marketing_standalone');
    assert.ok(Array.isArray(cfgRes.json.data.enabled_modules));
    assert.ok(cfgRes.json.data.enabled_modules.includes('automation_flows'));
  });
});
