import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import type { Server } from 'node:http';
import {
  createDatabasePool,
  executeMariaDbQueryWithPolyfill,
  MARIADB_JSON_COLS,
  parseMariaDbJsonFieldValue,
  setDatabasePool,
  type DatabasePool,
  type MinimalMariaDbConnection,
} from '../server/core/database/db-adapter.ts';
import { translatePostgresSqlToMariaDb } from '../server/core/database/sql-translator.ts';
import { runMigrations } from '../server/core/database/migrate.ts';
import { withSystemPrivilege, withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { signTenantAccessToken } from '../server/core/crypto/jwt.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { analyticsRouter, workspaceRouter } from '../server/routes/workspace.routes.ts';
import { legacyRouter } from '../server/routes/legacy.routes.ts';
import { enforceTenantOperationalPolicy } from '../server/services/billing.service.ts';
import { executeMasterCron } from '../server/cron/master-cron.ts';
import { domainEventBus } from '../server/core/events/event-bus.ts';
import { setZnsDispatcherForTesting } from '../server/modules/marketing/dispatchers.ts';

async function apiRequest<T = any>(
  baseUrl: string,
  path: string,
  options?: { method?: string; token?: string; tenantSlug?: string; body?: unknown }
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;
  if (options?.tenantSlug) headers['X-Tenant-Slug'] = options.tenantSlug;
  const resp = await fetch(`${baseUrl}${path}`, {
    method: options?.method || 'GET',
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await resp.text();
  return { status: resp.status, json: (text ? JSON.parse(text) : {}) as T };
}

describe('Wave A Backend Infrastructure: MariaDB Compatibility, Consolidated Schema & Wave 2 Cron', () => {
  let pool: DatabasePool;
  let server: Server;
  let baseUrl = '';
  let tenantA = { id: '', slug: '', userId: '', token: '' };
  let tenantB = { id: '', slug: '', userId: '', token: '' };
  let leadAId = '';
  let pipelineAId = '';
  let stageAId = '';

  before(async () => {
    tenantRedis.clearAllForTesting();
    pool = createDatabasePool({ inMemory: true });
    setDatabasePool(pool);
    await runMigrations({ seedSuperAdmin: false });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/workspace', workspaceRouter);
    app.use('/api/v1/analytics', analyticsRouter);
    app.use('/api/v1/legacy', legacyRouter);
    server = await new Promise((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    await withSystemPrivilege(async (client) => {
      for (const [label, slug, email] of [
        ['A', `wavea-alpha-${Date.now().toString(36)}`, 'alpha@wavea.test'],
        ['B', `wavea-beta-${Date.now().toString(36)}`, 'beta@wavea.test'],
      ] as const) {
        const tId = crypto.randomUUID();
        const uId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenants (id, slug, obfuscated_slug, name, industry, industry_key, package_code, plan_tier, status, settings, trial_ends_at)
           VALUES ($1, $2, $3, $4, 'general', 'general', 'crm_erp_suite', 'enterprise', 'active', $5::jsonb, $6)`,
          [
            tId,
            slug,
            `obf-${slug}`,
            `WaveA Tenant ${label}`,
            JSON.stringify({ timezone_name: 'Asia/Ho_Chi_Minh', keep_me: 'yes' }),
            new Date(Date.now() + 30 * 86400_000),
          ]
        );
        await client.query(
          `INSERT INTO users (id, tenant_id, email, password_hash, full_name, role, is_tenant_owner)
           VALUES ($1, $2, $3, 'hash', $4, 'tenant_admin', true)`,
          [uId, tId, email, `Admin ${label}`]
        );
        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, work_schedule)
           VALUES ($1, $2, 'active', true, false, '{}'::jsonb)`,
          [tId, uId]
        );
        const token = signTenantAccessToken({
          sub: uId,
          tenantId: tId,
          tenantSlug: slug,
          email,
          name: `Admin ${label}`,
          role: 'tenant_admin',
          isExternalAgency: false,
          planTier: 'enterprise',
        });
        if (label === 'A') {
          tenantA = { id: tId, slug, userId: uId, token };
        } else {
          tenantB = { id: tId, slug, userId: uId, token };
        }
      }

      pipelineAId = crypto.randomUUID();
      stageAId = crypto.randomUUID();
      const roundAId = crypto.randomUUID();
      leadAId = crypto.randomUUID();

      await client.query(
        `INSERT INTO tenant_pipelines (id, tenant_id, name, is_default) VALUES ($1, $2, 'Main Pipeline', true)`,
        [pipelineAId, tenantA.id]
      );
      await client.query(
        `INSERT INTO tenant_pipeline_stages (id, tenant_id, pipeline_id, stage_key, stage_name, stage_order, is_won_stage, badge_style)
         VALUES ($1, $2, $3, 'new_lead', 'New Lead', 1, false, '{}'::jsonb)`,
        [stageAId, tenantA.id, pipelineAId]
      );
      await client.query(
        `INSERT INTO distribution_rounds (id, tenant_id, pipeline_id, name, priority, is_active)
         VALUES ($1, $2, $3, 'Round 1', 1, true)`,
        [roundAId, tenantA.id, pipelineAId]
      );
      await client.query(
        `INSERT INTO round_consultants (id, tenant_id, round_id, user_id, receive_ratio, data_per_turn, is_active)
         VALUES ($1, $2, $3, $4, 100, 1, true)`,
        [crypto.randomUUID(), tenantA.id, roundAId, tenantA.userId]
      );
      await client.query(
        `INSERT INTO leads (id, tenant_id, pipeline_id, stage_id, round_id, assigned_to, name, phone, email, source, status, quality_status, is_accepted, custom_fields)
         VALUES ($1, $2, $3, $4, $5, $6, 'Lead Alpha', '0901234567', 'lead@wavea.test', 'meta_ads', 'assigned', 'Booked', true, $7::jsonb)`,
        [
          leadAId,
          tenantA.id,
          pipelineAId,
          stageAId,
          roundAId,
          tenantA.userId,
          JSON.stringify({ preserved_key: 'keep-this' }),
        ]
      );
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.close();
    setDatabasePool(null);
    tenantRedis.clearAllForTesting();
  });

  it('1. MariaDB typeCast registers all 49+ Wave 2 JSON columns & safely parses valid _json objects/arrays', () => {
    const requiredJsonCols = [
      'items_json', 'form_schema', 'pit_brackets', 'allowance_definitions', 'tiers_json',
      'breakdown', 'allowances_json', 'working_days', 'availability_rules', 'custom_questions',
      'blocks_json', 'channels_json', 'checklist_json', 'qr_design_json', 'steps_json',
      'trigger_config', 'whiteboard_json', 'task_columns_json', 'whiteboard_elements',
      'settings_json', 'fields_json', 'targets_json', 'faq_rules', 'guardrail_rules',
      'tool_calls', 'citations', 'args_summary', 'reminder_config', 'merge_tags',
      'tags_applied', 'answers_json', 'analytics_json', 'metadata_json', 'extra_json',
      'form_data', 'categories_json', 'history_json', 'attachments_json', 'reactions_json',
      'line_items_json', 'branch_ip_whitelist', 'screen_access', 'quick_actions',
      'holiday_schedules_json', 'audit_payload', 'snapshot_json', 'ab_variants_json',
      'utm_params', 'extracted_data', 'payload',
    ];
    for (const col of requiredJsonCols) {
      assert.equal(MARIADB_JSON_COLS.has(col), true, `MARIADB_JSON_COLS missing '${col}'`);
    }

    assert.deepEqual(parseMariaDbJsonFieldValue('items_json', '[{"sku":"A1"}]'), [{ sku: 'A1' }]);
    assert.deepEqual(parseMariaDbJsonFieldValue('dynamic_custom_json', '{"k":"v"}'), { k: 'v' });
    assert.deepEqual(parseMariaDbJsonFieldValue('dynamic_arr_json', '[1,2,3]'), [1, 2, 3]);
    assert.equal(parseMariaDbJsonFieldValue('scalar_json', '12345'), '12345');
    assert.equal(parseMariaDbJsonFieldValue('broken_json', '{not-valid-json'), '{not-valid-json');
    assert.equal(parseMariaDbJsonFieldValue('plain_name', '{"not_json_suffix":true}'), '{"not_json_suffix":true}');
  });

  it('2. SQL Translator & MariaDB Adapter support non-id ON CONFLICT DO NOTHING and INSERT/DELETE RETURNING polyfills', async () => {
    // 2a. Non-id ON CONFLICT DO NOTHING must emit INSERT IGNORE INTO (no .id assumption)
    const trPlatform = translatePostgresSqlToMariaDb(
      `INSERT INTO platform_settings (setting_key, setting_value) VALUES ($1, $2::jsonb) ON CONFLICT (setting_key) DO NOTHING`,
      ['default_settings', '{}']
    );
    assert.match(trPlatform.sql, /^INSERT IGNORE INTO platform_settings/i);
    assert.equal(trPlatform.sql.includes('id = id'), false);

    // 2b. Bare ON CONFLICT DO NOTHING without target parens
    const trBare = translatePostgresSqlToMariaDb(
      `INSERT INTO blacklist_entries (tenant_id, entry_type, value) VALUES ($1, 'phone', $2) ON CONFLICT DO NOTHING`,
      ['t-1', '0900']
    );
    assert.match(trBare.sql, /^INSERT IGNORE INTO blacklist_entries/i);
    assert.equal(trBare.sql.includes('CONFLICT'), false);

    // 2c. ON CONFLICT (...) DO UPDATE ... RETURNING polyfill via natural key re-SELECT
    const trUpsertRet = translatePostgresSqlToMariaDb(
      `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
       VALUES ('default_tenant_settings', $1::jsonb, clock_timestamp())
       ON CONFLICT (setting_key) DO UPDATE SET
         setting_value = EXCLUDED.setting_value,
         updated_at = clock_timestamp()
       RETURNING setting_value, updated_at`,
      ['{"mode":"strict"}']
    );
    assert.equal(trUpsertRet.isInsertReturning, true);
    assert.equal(trUpsertRet.sql.includes('RETURNING'), false);
    assert.ok(trUpsertRet.sql.includes('ON DUPLICATE KEY UPDATE'));
    assert.equal(trUpsertRet.insertMeta?.keyWhereClause, "setting_key = 'default_tenant_settings'");

    const queriesExecuted: Array<{ sql: string; params: any[] }> = [];
    const mockConn: MinimalMariaDbConnection = {
      async query<T = any>(sql: string, params: any[] = []): Promise<[T, any]> {
        queriesExecuted.push({ sql, params });
        if (/^SELECT setting_value, updated_at FROM platform_settings/i.test(sql)) {
          return [[{ setting_value: { mode: 'strict' }, updated_at: '2026-11-17T00:00:00Z' }] as unknown as T, []];
        }
        if (/^SELECT phone FROM leads/i.test(sql)) {
          return [[{ phone: '0901234567' }] as unknown as T, []];
        }
        return [{ affectedRows: 1, insertId: 0 } as unknown as T, []];
      },
    };

    const upsertRes = await executeMariaDbQueryWithPolyfill(
      mockConn,
      `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
       VALUES ('default_tenant_settings', $1::jsonb, clock_timestamp())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value
       RETURNING setting_value, updated_at`,
      ['{"mode":"strict"}']
    );
    assert.equal(upsertRes.rowCount, 1);
    assert.deepEqual(upsertRes.rows[0].setting_value, { mode: 'strict' });

    // 2d. DELETE ... RETURNING polyfill (FOR UPDATE snapshot + DELETE)
    const delRes = await executeMariaDbQueryWithPolyfill(
      mockConn,
      `DELETE FROM leads WHERE tenant_id = $1 AND id = $2 RETURNING phone`,
      ['t-1', 'l-1']
    );
    assert.equal(delRes.rowCount, 1);
    assert.equal(delRes.rows[0].phone, '0901234567');
    assert.ok(queriesExecuted.some((q) => /^SELECT phone FROM leads WHERE tenant_id = \? AND id = \? FOR UPDATE/i.test(q.sql)));
    assert.ok(queriesExecuted.some((q) => /^DELETE FROM leads WHERE tenant_id = \? AND id = \?$/i.test(q.sql)));
  });

  it('3. Full-Clone Schema Consolidation: Stage 1-4 tables, altered columns, docs sync & FORCE RLS zero leakage', async () => {
    // 3a. Verify schema docs stay synchronized
    const pgSql = fs.readFileSync('docs/DATABASE_SCHEMA.sql', 'utf8');
    const maSql = fs.readFileSync('docs/DATABASE_SCHEMA_MARIADB.sql', 'utf8');
    const countTables = (sqlText: string) =>
      new Set([...sqlText.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase()));
    const pgSet = countTables(pgSql);
    const maSet = countTables(maSql);
    assert.ok(pgSet.size >= 170, `Expected >= 170 PG tables, got ${pgSet.size}`);
    assert.equal(pgSet.size, maSet.size, 'PG and MariaDB schema docs must have identical table counts');

    // 3b. Verify altered columns, attendance defaults & Stage 1-4 tables live in database
    await withTenantTransaction(tenantA.id, async (client) => {
      const defPol = await client.query<{
        geofence_mode: string;
        require_gps: boolean;
        require_selfie: boolean;
        max_gps_accuracy_meters: number;
        grace_late_minutes: number;
        grace_early_minutes: number;
        allow_any_branch_checkin: boolean;
        allow_remote_with_approved_leave: boolean;
      }>(
        `INSERT INTO tenant_attendance_policies (tenant_id)
         VALUES ($1)
         RETURNING geofence_mode, require_gps, require_selfie, max_gps_accuracy_meters,
                   grace_late_minutes, grace_early_minutes, allow_any_branch_checkin, allow_remote_with_approved_leave`,
        [tenantA.id]
      );
      const pol = defPol.rows[0];
      assert.equal(pol.geofence_mode, 'flexible');
      assert.equal(pol.require_gps, false);
      assert.equal(pol.require_selfie, false);
      assert.equal(pol.max_gps_accuracy_meters, 150);
      assert.equal(pol.grace_late_minutes, 15);
      assert.equal(pol.grace_early_minutes, 15);
      assert.equal(pol.allow_any_branch_checkin, false);
      assert.equal(pol.allow_remote_with_approved_leave, true);

      // Verify altered columns on tenant_roles, tenant_role_permissions, tenant_branches
      const colsRes = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('tenant_roles', 'tenant_role_permissions', 'tenant_branches')`
      );
      const hasCol = (t: string, c: string) => colsRes.rows.some((r) => r.table_name === t && r.column_name === c);
      for (const tbl of ['tenant_roles', 'tenant_role_permissions']) {
        assert.equal(hasCol(tbl, 'screen_access'), true, `${tbl} missing screen_access`);
        assert.equal(hasCol(tbl, 'quick_actions'), true, `${tbl} missing quick_actions`);
        assert.equal(hasCol(tbl, 'default_route'), true, `${tbl} missing default_route`);
      }
      assert.equal(hasCol('tenant_branches', 'branch_ip_whitelist'), true);
      assert.equal(hasCol('tenant_branches', 'manager_user_id'), true);

      // Seed Tenant A rows in new Stage 1-4 Kernel tables
      await client.query(
        `INSERT INTO tenant_domain_events_outbox (tenant_id, event_type, payload_json)
         VALUES ($1, 'lead.created', '{"from":"A"}'::jsonb)`,
        [tenantA.id]
      );
      await client.query(
        `INSERT INTO tenant_user_notification_settings (tenant_id, user_id) VALUES ($1, $2)`,
        [tenantA.id, tenantA.userId]
      );
      await client.query(
        `INSERT INTO crm_public_leads_pool (tenant_id, lead_id, pool_status) VALUES ($1, $2, 'available')`,
        [tenantA.id, leadAId]
      );
      await client.query(
        `INSERT INTO tenant_geoip_blocks (tenant_id, rule_type, target_value) VALUES ($1, 'country', 'XX')`,
        [tenantA.id]
      );
    });

    // 3c. Verify Tenant B and Unscoped autodata_app see 0 rows of Tenant A across new tables
    const newTables = [
      'tenant_attendance_policies',
      'tenant_domain_events_outbox',
      'tenant_user_notification_settings',
      'crm_public_leads_pool',
      'tenant_geoip_blocks',
    ];
    await withTenantTransaction(tenantB.id, async (client) => {
      for (const tbl of newTables) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Tenant B must see 0 rows in ${tbl}`);
      }
    });
    await withUnscopedRlsCheck(async (client) => {
      for (const tbl of [...newTables, 'tenant_cron_runs']) {
        const res = await client.query(`SELECT * FROM ${tbl}`);
        assert.equal(res.rows.length, 0, `Unscoped autodata_app must see 0 rows in ${tbl}`);
      }
    });
  });

  it('4. Cross-dialect routes & billing service execute cleanly across analytics, fair-share, legacy & quota check', async () => {
    for (const mode of ['day', 'hour', 'heatmap']) {
      const dash = await apiRequest(
        baseUrl,
        `/api/v1/analytics/dashboard?date_preset=this_month&chart_mode=${mode}`,
        { token: tenantA.token, tenantSlug: tenantA.slug }
      );
      assert.equal(dash.status, 200, `Dashboard chart_mode=${mode} failed`);
      assert.ok(Number(dash.json.data.kpis.total_leads) >= 1);
    }

    const fairShare = await apiRequest(baseUrl, '/api/v1/analytics/fair-share?date_preset=this_month', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(fairShare.status, 200);

    const metaAds = await apiRequest(baseUrl, '/api/v1/analytics/ads-performance', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(metaAds.status, 200);

    const legacyDash = await apiRequest(baseUrl, '/api/v1/legacy?action=get_dashboard_stats&date=Th%C3%A1ng%20n%C3%A0y&chart_mode=heatmap', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(legacyDash.status, 200);

    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const ymd = now.toISOString().slice(0, 10);
    const calStats = await apiRequest(
      baseUrl,
      `/api/v1/legacy?action=get_calendar_stats&year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(calStats.status, 200);

    const calDay = await apiRequest(baseUrl, `/api/v1/legacy?action=get_calendar_day_details&date=${ymd}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(calDay.status, 200);
    assert.ok(ym.length === 7);

    const adsBd = await apiRequest(baseUrl, '/api/v1/legacy?action=get_ads_analytics_breakdowns', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(adsBd.status, 200);

    // Test JSON merge replacement (replacing PG `||` with JS read-merge-write)
    const editLeadRes = await apiRequest(baseUrl, '/api/v1/legacy?action=update_lead_fields', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { id: leadAId, note: 'Wave A updated note' },
    });
    assert.equal(editLeadRes.status, 200);
    assert.equal(editLeadRes.json.success, true);

    const ticketSetRes = await apiRequest(baseUrl, '/api/v1/legacy?action=save_ticket_settings', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { admin_ids: [tenantA.userId] },
    });
    assert.equal(ticketSetRes.status, 200);

    await withTenantTransaction(tenantA.id, async (client) => {
      const lRow = await client.query<{ custom_fields: Record<string, any> }>(
        'SELECT custom_fields FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, leadAId]
      );
      assert.equal(lRow.rows[0].custom_fields.preserved_key, 'keep-this');
      assert.equal(lRow.rows[0].custom_fields.note, 'Wave A updated note');

      const tRow = await client.query<{ settings: Record<string, any> }>('SELECT settings FROM tenants WHERE id = $1', [tenantA.id]);
      assert.equal(tRow.rows[0].settings.keep_me, 'yes');
      assert.deepEqual(tRow.rows[0].settings.ticket_notify_admins, [tenantA.userId]);

      await enforceTenantOperationalPolicy(client, tenantA.id, 'ingest_lead');
    });
  });

  it('5. Master Cron executes all 6 new Wave 2 subroutines cleanly & records logs in tenant_cron_runs', async () => {
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    const pastDate = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const flowId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    const audienceId = crypto.randomUUID();
    const dynAudienceId = crypto.randomUUID();
    const campaignId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const reminderId = crypto.randomUUID();
    const attBatchId = crypto.randomUUID();
    const depositId = crypto.randomUUID();
    const milestoneId = crypto.randomUUID();
    const outboxEvtId = crypto.randomUUID();

    let observedOutboxDomainEvent = false;
    const offListener = domainEventBus.on('lead.created', async (evt) => {
      if (evt.tenantId === tenantA.id && (evt.payload as any)?.from_outbox === true) {
        observedOutboxDomainEvent = true;
      }
    });

    try {
      await withTenantTransaction(tenantA.id, async (client) => {
        const tagId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex) VALUES ($1, $2, 'CronTag', 'cron-tag', '#1E40FF')`,
          [tagId, tenantA.id]
        );

        // 5a. Waiting flow enrollment due now
        await client.query(
          `INSERT INTO mkt_flows (id, tenant_id, name, status, trigger_type, steps_json)
           VALUES ($1, $2, 'WaveA Cron Flow', 'active', 'manual', $3::jsonb)`,
          [
            flowId,
            tenantA.id,
            JSON.stringify([{ id: 's1', type: 'add_tag', label: 'Add Tag', config: { tag_id: tagId } }]),
          ]
        );
        await client.query(
          `INSERT INTO mkt_flow_enrollments (id, tenant_id, flow_id, lead_id, current_step_id, status, next_run_at)
           VALUES ($1, $2, $3, $4, 's1', 'waiting', $5)`,
          [enrollmentId, tenantA.id, flowId, leadAId, pastIso]
        );

        // 5b. Audience + due scheduled campaign + dynamic audience
        await client.query(
          `INSERT INTO tenant_audiences (id, tenant_id, name, audience_type, filter_branches, is_active)
           VALUES ($1, $2, 'Static Camp Aud', 'static_data', '[]'::jsonb, true),
                  ($3, $2, 'Dyn Leads Aud', 'dynamic_logic', '[]'::jsonb, true)`,
          [audienceId, tenantA.id, dynAudienceId]
        );
        await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type, metadata)
           VALUES ($1, $2, $3, $4, 'manual', '{}'::jsonb)`,
          [crypto.randomUUID(), tenantA.id, audienceId, leadAId]
        );
        await client.query(
          `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status, audience_id, scheduled_at)
           VALUES ($1, $2, 'Scheduled Camp', 'email', 'scheduled', $3, $4)`,
          [campaignId, tenantA.id, audienceId, pastIso]
        );

        // 5c. Campaign reminder + overdue deposit milestone
        await client.query(
          `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, variant, status, reminder_sent, sent_at, metadata)
           VALUES ($1, $2, $3, $4, 'zns', 'A', 'sent', false, $5, '{}'::jsonb)`,
          [claimId, tenantA.id, campaignId, leadAId, pastIso]
        );
        await client.query(
          `INSERT INTO mkt_campaign_reminders (id, tenant_id, campaign_id, step_order, trigger_condition, wait_hours, subject, channel, is_active)
           VALUES ($1, $2, $3, 1, 'no_open', 1, 'Follow up', 'zns', true)`,
          [reminderId, tenantA.id, campaignId]
        );

        await client.query(
          `INSERT INTO tenant_deposits (id, tenant_id, deposit_code, lead_id, customer_name, amount_vnd, status)
           VALUES ($1, $2, 'DEP-CRON-1', $3, 'Lead Alpha', 10000000, 'pending')`,
          [depositId, tenantA.id, leadAId]
        );
        await client.query(
          `INSERT INTO tenant_deposit_milestones (id, tenant_id, deposit_id, tranche_no, name, amount_vnd, expected_pay_date, status)
           VALUES ($1, $2, $3, 1, 'Milestone 1', 5000000, $4, 'pending')`,
          [milestoneId, tenantA.id, depositId, pastDate]
        );

        // 5d. Attendance confirmation batch past deadline_at
        await client.query(
          `INSERT INTO tenant_attendance_confirmation_batches (id, tenant_id, title, period_month, from_date, to_date, deadline_at, status)
           VALUES ($1, $2, 'T11 Confirm', '2026-11', '2026-11-01', '2026-11-30', $3, 'open')`,
          [attBatchId, tenantA.id, pastIso]
        );
        await client.query(
          `INSERT INTO tenant_attendance_confirmations (id, tenant_id, batch_id, user_id, total_work_units, status)
           VALUES ($1, $2, $3, $4, 22, 'pending')`,
          [crypto.randomUUID(), tenantA.id, attBatchId, tenantA.userId]
        );

        // 5e. Pending outbox domain event
        await client.query(
          `INSERT INTO tenant_domain_events_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, payload_json, status, next_retry_at)
           VALUES ($1, $2, 'lead.created', 'lead', $3, $4::jsonb, 'pending', $5)`,
          [outboxEvtId, tenantA.id, leadAId, JSON.stringify({ leadId: leadAId, from_outbox: true }), pastIso]
        );
      });

      setZnsDispatcherForTesting(async () => ({
        sent: true,
        messageId: 'wavea-zns-test',
        provider: 'test_zns',
      }));

      const cronResult = await executeMasterCron({
        tenantId: tenantA.id,
        subroutines: [
          'marketing_flows',
          'marketing_campaigns',
          'audience_reeval',
          'attendance_confirm',
          'reminders',
          'outbox_events',
        ],
      });

      assert.equal(cronResult.locked, false);
      assert.deepEqual(cronResult.stats.errors, []);
      assert.ok(cronResult.stats.marketingFlowsProcessed >= 1, 'marketingFlowsProcessed >= 1');
      assert.ok(cronResult.stats.marketingCampaignsProcessed >= 1, 'marketingCampaignsProcessed >= 1');
      assert.ok(cronResult.stats.audiencesReevalCount >= 1, 'audiencesReevalCount >= 1');
      assert.ok(cronResult.stats.attendanceConfirmationsCount >= 1, 'attendanceConfirmationsCount >= 1');
      assert.ok(cronResult.stats.remindersDispatchedCount >= 2, 'remindersDispatchedCount >= 2');
      assert.ok(cronResult.stats.outboxEventsProcessed >= 1, 'outboxEventsProcessed >= 1');
      assert.equal(observedOutboxDomainEvent, true, 'Outbox worker must dispatch domainEventBus event');

      await withTenantTransaction(tenantA.id, async (client) => {
        const camp = await client.query<{ status: string }>(
          'SELECT status FROM mkt_campaigns WHERE tenant_id = $1 AND id = $2',
          [tenantA.id, campaignId]
        );
        assert.equal(camp.rows[0]?.status, 'completed');

        const conf = await client.query<{ status: string; confirmed_by_type: string }>(
          'SELECT status, confirmed_by_type FROM tenant_attendance_confirmations WHERE tenant_id = $1 AND batch_id = $2',
          [tenantA.id, attBatchId]
        );
        assert.equal(conf.rows[0]?.status, 'auto_confirmed');
        assert.equal(conf.rows[0]?.confirmed_by_type, 'cron');

        const ms = await client.query<{ status: string }>(
          'SELECT status FROM tenant_deposit_milestones WHERE tenant_id = $1 AND id = $2',
          [tenantA.id, milestoneId]
        );
        assert.equal(ms.rows[0]?.status, 'overdue');

        const ob = await client.query<{ status: string }>(
          'SELECT status FROM tenant_domain_events_outbox WHERE tenant_id = $1 AND id = $2',
          [tenantA.id, outboxEvtId]
        );
        assert.equal(ob.rows[0]?.status, 'processed');

        const logs = await client.query<{ subroutine_key: string; status: string }>(
          'SELECT subroutine_key, status FROM tenant_cron_runs WHERE tenant_id = $1',
          [tenantA.id]
        );
        const loggedKeys = new Set(logs.rows.map((r) => r.subroutine_key));
        for (const k of [
          'marketing_flows',
          'marketing_campaigns',
          'audience_reeval',
          'attendance_confirm',
          'reminders',
          'outbox_events',
        ]) {
          assert.equal(loggedKeys.has(k), true, `Missing tenant_cron_runs entry for ${k}`);
        }
      });
    } finally {
      setZnsDispatcherForTesting(null);
      offListener();
    }
  });
});
