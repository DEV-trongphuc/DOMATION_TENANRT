import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withSystemPrivilege, withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { translatePostgresSqlToMariaDb } from '../server/core/database/sql-translator.ts';
import { MARKETING_TABLES } from '../server/modules/marketing/schema.ts';
import { upsertMasterContactInTx } from '../server/modules/audiences/audiences.service.ts';
import { compileSegmentWhereSql } from '../server/modules/audiences/segment-compiler.ts';
import {
  auditFlowWithDomAgent,
  computeWaitDelayMs,
  executeFlowForLead,
  simulateFlowExecution,
} from '../server/modules/marketing/flow-engine.service.ts';
import {
  assertSafeOutboundWebhookUrl,
  setCampaignEmailDispatcherForTesting,
  setFlowWebhookTransportForTesting,
  setSmsTransportForTesting,
  setZnsDispatcherForTesting,
} from '../server/modules/marketing/dispatchers.ts';
import { injectEmailOpenAndClickTracking } from '../server/modules/marketing/utils.ts';
import { setEmailWebhookFetcherForTesting } from '../server/services/zalo-mail.service.ts';
import { executeMasterCron } from '../server/cron/master-cron.ts';

describe('M1 Core: Schema Parity, 1-Click Upgrade, Flow Engine, Campaigns, Tracking, Audiences & Master Cron', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  let tenantB: { id: string; slug: string; token: string };
  let sharedQuizLeadId = '';

  before(async () => {
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Core Sapphire Corp',
        tenant_slug: 'm1-sapphire',
        admin_name: 'Minh Anh',
        work_email: 'owner@m1-sapphire.vn',
        phone: '0908111222',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'M1 Core Emerald Corp',
        tenant_slug: 'm1-emerald',
        admin_name: 'Quoc Bao',
        work_email: 'owner@m1-emerald.vn',
        phone: '0908333444',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
    };

    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 50000000 WHERE id = $1', [tenantA.id]);
    });
    await withTenantTransaction(tenantB.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 50000000 WHERE id = $1', [tenantB.id]);
    });
  });

  after(async () => {
    setEmailWebhookFetcherForTesting(null);
    setZnsDispatcherForTesting(null);
    setSmsTransportForTesting(null);
    setFlowWebhookTransportForTesting(null);
    setCampaignEmailDispatcherForTesting(null);
    await harness.close();
  });

  it('1. DB Schema PG vs MariaDB parity (32 mkt_* tables, 16 altered cols, cooperation slips) + FORCE RLS + 1-Click SaaS upgrade & pending idempotency', async () => {
    const pgSchema = fs.readFileSync(path.resolve('docs/DATABASE_SCHEMA.sql'), 'utf8');
    const mariaSchema = fs.readFileSync(path.resolve('docs/DATABASE_SCHEMA_MARIADB.sql'), 'utf8');

    assert.equal(MARKETING_TABLES.length, 32);
    for (const tbl of MARKETING_TABLES) {
      assert.ok(pgSchema.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `PG schema missing ${tbl}`);
      assert.ok(mariaSchema.includes(`CREATE TABLE IF NOT EXISTS ${tbl}`), `MariaDB schema missing ${tbl}`);
      assert.ok(pgSchema.includes(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`) || pgSchema.includes(`'${tbl}'`), `PG RLS check for ${tbl}`);
    }

    const expectedAlteredCols = [
      'saved_blocks_json',
      'thumbnail_url',
      'fallback_vars_json',
      'throttle_per_minute',
      'ab_winner_criteria',
      'ab_test_hours',
      'pre_send_score',
      'settings_json',
      'webhook_secret',
      'redirect_rules_json',
      'thank_you_json',
      'geo_country',
      'geo_city',
      'browser',
      'os',
      'duration_seconds',
    ];
    for (const col of expectedAlteredCols) {
      assert.ok(mariaSchema.includes(col), `MariaDB schema missing altered marketing column ${col}`);
    }
    for (const coopCol of ['unit_code', 'project_name', 'expected_commission_vnd', 'total_percentage', 'dispute_details', 'approved_at', 'metadata_json']) {
      assert.ok(pgSchema.includes(coopCol), `PG schema missing tenant_cooperation_slips col ${coopCol}`);
    }

    // Kernel FORCE RLS zero-leakage check across all 32 mkt_* tables + audience/tag tables
    for (const tbl of [...MARKETING_TABLES, 'tenant_audiences', 'tenant_audience_members', 'tenant_audience_exclusions', 'tenant_tags', 'lead_tags']) {
      const cnt = await withUnscopedRlsCheck(async (client) => {
        const r = await client.query<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
        return Number(r.rows[0]?.cnt || 0);
      });
      assert.equal(cnt, 0, `Unscoped RLS query on ${tbl} must return 0`);
    }

    // 1-Click SaaS Package Switch: marketing_standalone -> create lead & audience -> growth_combo -> domation_promax
    const sw1 = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'X-Idempotency-Key': 'm1-pkg-mkt-1' },
      body: { package_code: 'marketing_standalone', payment_method: 'wallet', billing_cycle: 'monthly' },
    });
    assert.equal(sw1.status, 200);
    assert.equal(sw1.json.data.package_code, 'marketing_standalone');
    assert.equal(sw1.json.data.requires_payment, false);

    // Completed wallet replay returns requires_payment: false + idempotent_replay: true
    const sw1Replay = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'X-Idempotency-Key': 'm1-pkg-mkt-1' },
      body: { package_code: 'marketing_standalone', payment_method: 'wallet', billing_cycle: 'monthly' },
    });
    assert.equal(sw1Replay.status, 200);
    assert.equal(sw1Replay.json.data.requires_payment, false);
    assert.equal(sw1Replay.json.data.idempotent_replay, true);

    // Seed a contact & audience in marketing_standalone
    const audRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { name: 'M1 Upgrade Preserved List', audience_type: 'static_data' },
    });
    assert.equal(audRes.status, 201);
    const audId = audRes.json.data.id;

    // Pending bank_transfer switch + idempotent_replay MUST return requires_payment: true + gateway_session + payment_bank_info
    const pendingSwitch = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'X-Idempotency-Key': 'm1-pending-combo-1' },
      body: { package_code: 'growth_combo', payment_method: 'bank_transfer', billing_cycle: 'monthly' },
    });
    assert.equal(pendingSwitch.status, 201);
    assert.equal(pendingSwitch.json.data.requires_payment, true);
    assert.ok(pendingSwitch.json.data.gateway_session?.reference_code);
    assert.ok(pendingSwitch.json.data.payment_bank_info?.account_number);

    const pendingReplay = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      headers: { 'X-Idempotency-Key': 'm1-pending-combo-1' },
      body: { package_code: 'growth_combo', payment_method: 'bank_transfer', billing_cycle: 'monthly' },
    });
    assert.equal(pendingReplay.status, 200);
    assert.equal(pendingReplay.json.data.requires_payment, true);
    assert.equal(pendingReplay.json.data.idempotent_replay, true);
    assert.ok(pendingReplay.json.data.gateway_session?.reference_code);
    assert.ok(pendingReplay.json.data.payment_bank_info?.account_number);

    // Real wallet upgrade to growth_combo -> domation_promax preserves existing audience
    const sw2 = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'growth_combo', payment_method: 'wallet', billing_cycle: 'monthly' },
    });
    assert.equal(sw2.status, 200);
    assert.equal(sw2.json.data.package_code, 'growth_combo');

    const sw3 = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax', payment_method: 'wallet', billing_cycle: 'monthly' },
    });
    assert.equal(sw3.status, 200);
    assert.equal(sw3.json.data.package_code, 'domation_promax');

    const audGet = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(audGet.status, 200);
    assert.ok(audGet.json.data.items.some((a: any) => a.id === audId), '1-click upgrade must preserve audience data');
  });

  it('2. Automation Flow wait_delay pause (default + cfg.unit), cron resume from next step (no root restart/duplication), multi-wait & frontend aliases', async () => {
    let leadId = '';
    let audId = '';
    await withTenantTransaction(tenantA.id, async (client) => {
      const up = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Tran Van Wait',
        phone: '0909111001',
        email: 'wait.lead@m1.vn',
        custom_fields: { tier: 'gold' },
      });
      leadId = up.leadId;

      audId = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_audiences (id, tenant_id, name, audience_type, filter_branches, is_active)
         VALUES ($1, $2, 'Flow Target List', 'static_data', '[]'::jsonb, true)`,
        [audId, tenantA.id]
      );
    });

    // Multi-wait flow using frontend aliases: trigger -> update_lead_score -> wait (minutes) -> update_tag (tags/action) -> wait (days) -> list_action (listId) -> split_test (ratioA)
    const flowSteps = [
      { id: 't1', type: 'trigger', label: 'Start', nextStepId: 's_score' },
      { id: 's_score', type: 'update_lead_score', label: 'Add 15', config: { delta: 15 }, nextStepId: 'w1' },
      { id: 'w1', type: 'wait', label: 'Wait 15 mins', config: { duration: 15, unit: 'minutes' }, nextStepId: 's_tag' },
      { id: 's_tag', type: 'update_tag', label: 'Add FE Tag', config: { action: 'add', tags: ['FE-Aliased'] }, nextStepId: 'w2' },
      { id: 'w2', type: 'wait_delay', label: 'Wait 2 days', config: { duration: 2, unit: 'days' }, nextStepId: 's_list' },
      { id: 's_list', type: 'list_action', label: 'Add to List', config: { action: 'add', listId: audId }, nextStepId: 's_split' },
      { id: 's_split', type: 'split_test', label: 'Split 70/30', config: { ratioA: 70, ratioB: 30 }, pathAStepId: 's_end_a', pathBStepId: 's_end_b' },
      { id: 's_end_a', type: 'update_lead_score', label: 'Bonus A', config: { delta: 5 }, nextStepId: null },
      { id: 's_end_b', type: 'update_lead_score', label: 'Bonus B', config: { delta: 1 }, nextStepId: null },
    ];

    // Verify fractional & seconds wait_delay durations (`computeWaitDelayMs`) + `cfg`, `trueNextStepId`, `falseNextStepId`
    assert.equal(computeWaitDelayMs({ duration: 0.5, unit: 'minutes' }), 30_000);
    assert.equal(computeWaitDelayMs({ duration: 5, unit: 'seconds' }), 5_000);
    assert.equal(computeWaitDelayMs({ duration: 0, unit: 's' }), 0);

    const feCondSteps = [
      {
        id: 'cond_fe',
        type: 'condition',
        label: 'FE cfg + true/false edges',
        cfg: { field: 'lead_score', operator: 'gte', value: 20 },
        trueNextStepId: 'yes_fe',
        falseNextStepId: 'no_fe',
      },
      { id: 'yes_fe', type: 'wait', cfg: { duration: 10, unit: 'seconds' }, nextStepId: null },
      { id: 'no_fe', type: 'update_tag', cfg: { action: 'add', tags: ['LowScore'] }, nextStepId: null },
    ];
    const simFeCond = simulateFlowExecution(feCondSteps as any, { name: 'FE Cond', lead_score: 25 });
    assert.equal(simFeCond.trace[0]?.branch, 'yes');
    assert.equal(simFeCond.trace[1]?.step_id, 'yes_fe');
    const simFeCondNo = simulateFlowExecution(feCondSteps as any, { name: 'FE Cond Low', lead_score: 5 });
    assert.equal(simFeCondNo.trace[0]?.branch, 'no');
    assert.equal(simFeCondNo.trace[1]?.step_id, 'no_fe');

    // Verify simulateFlowExecution & auditFlowWithDomAgent understand frontend aliases cleanly
    const sim = simulateFlowExecution(flowSteps as any, { name: 'Sim Lead', lead_score: 10 });
    assert.ok(sim.trace.some((t) => t.step_id === 's_tag' && t.node_type === 'add_remove_tag'));
    assert.ok(sim.trace.some((t) => t.step_id === 's_list' && t.node_type === 'add_remove_list'));
    assert.ok(sim.trace.some((t) => t.step_id === 's_split' && t.node_type === 'ab_split'));
    const audit = auditFlowWithDomAgent('manual_enroll', flowSteps as any);
    assert.ok(audit.score >= 70);

    const createFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'M1 Multi-Wait Alias Flow',
        trigger_type: 'manual_enroll',
        status: 'active',
        steps: flowSteps,
      },
    });
    assert.equal(createFlow.status, 201);
    const flowId = createFlow.json.data.id;

    // Enroll via API (default skip_wait_delay MUST be false!)
    const enrollRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flowId}/enroll`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { lead_id: leadId },
    });
    assert.equal(enrollRes.status, 201);
    assert.equal(enrollRes.json.data.status, 'waiting');
    const enrollmentId = enrollRes.json.data.enrollmentId;

    // Check paused at w1 (~15 minutes from now, NOT 1 hour)
    await withTenantTransaction(tenantA.id, async (client) => {
      const en = await client.query<{ current_step_id: string; status: string; next_run_at: string }>(
        'SELECT current_step_id, status, next_run_at FROM mkt_flow_enrollments WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, enrollmentId]
      );
      assert.equal(en.rows[0]?.current_step_id, 'w1');
      assert.equal(en.rows[0]?.status, 'waiting');
      const deltaMs = new Date(en.rows[0].next_run_at).getTime() - Date.now();
      assert.ok(deltaMs > 10 * 60_000 && deltaMs <= 16 * 60_000, `Expected ~15m wait, got ${deltaMs}ms`);

      // Make w1 due now
      await client.query(
        'UPDATE mkt_flow_enrollments SET next_run_at = $3 WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, enrollmentId, new Date(Date.now() - 10_000).toISOString()]
      );
    });

    // Cron tick 1: resumes from w1 -> runs s_tag -> pauses at w2 (2 days)
    const cron1 = await executeMasterCron({ tenantId: tenantA.id, subroutines: ['marketing_flows'] });
    assert.equal(cron1.stats.marketingFlowsProcessed, 1);

    await withTenantTransaction(tenantA.id, async (client) => {
      const enRows = await client.query<{ id: string; current_step_id: string; status: string; next_run_at: string }>(
        'SELECT id, current_step_id, status, next_run_at FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2',
        [tenantA.id, flowId]
      );
      assert.equal(enRows.rows.length, 1, 'Must NOT create duplicate enrollment row on resume');
      assert.equal(enRows.rows[0].current_step_id, 'w2');
      assert.equal(enRows.rows[0].status, 'waiting');
      const daysDelta = new Date(enRows.rows[0].next_run_at).getTime() - Date.now();
      assert.ok(daysDelta > 40 * 3600_000 && daysDelta <= 49 * 3600_000, `Expected ~2d wait, got ${daysDelta}ms`);

      // Score must still be 15 (root s_score must NOT have re-run!)
      const l = await client.query<{ lead_score: number }>('SELECT lead_score FROM leads WHERE tenant_id = $1 AND id = $2', [tenantA.id, leadId]);
      assert.equal(Number(l.rows[0]?.lead_score), 15);

      // Verify FE-Aliased tag was applied
      const tg = await client.query<{ name: string }>(
        `SELECT tt.name FROM lead_tags lt INNER JOIN tenant_tags tt ON tt.id = lt.tag_id WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
        [tenantA.id, leadId]
      );
      assert.ok(tg.rows.some((r) => r.name === 'FE-Aliased'));

      // Check enrolled_count is still 1
      const f = await client.query<{ enrolled_count: number; completed_count: number }>(
        'SELECT enrolled_count, completed_count FROM mkt_flows WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, flowId]
      );
      assert.equal(Number(f.rows[0]?.enrolled_count), 1);
      assert.equal(Number(f.rows[0]?.completed_count), 0);

      // Make w2 due now
      await client.query(
        'UPDATE mkt_flow_enrollments SET next_run_at = $3 WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, enrollmentId, new Date(Date.now() - 10_000).toISOString()]
      );
    });

    // Cron tick 2: resumes from w2 -> runs s_list + s_split + bonus -> completed!
    const cron2 = await executeMasterCron({ tenantId: tenantA.id, subroutines: ['marketing_flows'] });
    assert.equal(cron2.stats.marketingFlowsProcessed, 1);

    await withTenantTransaction(tenantA.id, async (client) => {
      const enRows = await client.query<{ status: string }>(
        'SELECT status FROM mkt_flow_enrollments WHERE tenant_id = $1 AND flow_id = $2',
        [tenantA.id, flowId]
      );
      assert.equal(enRows.rows.length, 1);
      assert.equal(enRows.rows[0].status, 'completed');

      const mem = await client.query(
        'SELECT 1 FROM tenant_audience_members WHERE tenant_id = $1 AND audience_id = $2 AND lead_id = $3',
        [tenantA.id, audId, leadId]
      );
      assert.equal(mem.rows.length, 1, 'list_action must persist lead in tenant_audience_members');

      const f = await client.query<{ enrolled_count: number; completed_count: number }>(
        'SELECT enrolled_count, completed_count FROM mkt_flows WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, flowId]
      );
      assert.equal(Number(f.rows[0]?.enrolled_count), 1);
      assert.equal(Number(f.rows[0]?.completed_count), 1);
    });
  });

  it('3. Flow send_email, send_zns, webhook_http (+ SSRF block), notify_internal, and suppression/consent checks', async () => {
    const emailCaptured: Array<{ to: string; subject: string; html: string }> = [];
    const znsCaptured: Array<{ phone: string; message?: string }> = [];
    const webhookCaptured: Array<{ url: string; payload: any }> = [];

    setCampaignEmailDispatcherForTesting(async (input) => {
      emailCaptured.push({ to: input.to, subject: input.subject, html: input.html });
      return { sent: true, messageId: `mock-mail-${emailCaptured.length}`, provider: 'test_email_hook' };
    });
    setZnsDispatcherForTesting(async (input) => {
      znsCaptured.push({ phone: input.phone, message: input.message });
      return { sent: true, messageId: `mock-zns-${znsCaptured.length}`, provider: 'test_zns_hook' };
    });
    setFlowWebhookTransportForTesting(async (input) => {
      webhookCaptured.push({ url: input.url, payload: input.payload });
      return { ok: true, status: 200, body: '{"ok":true}' };
    });

    try {
      let subscribedLeadId = '';
      let suppressedLeadId = '';
      await withTenantTransaction(tenantA.id, async (client) => {
        const up1 = await upsertMasterContactInTx(client, tenantA.id, {
          name: 'Flow Subscribed',
          phone: '0909222111',
          email: 'flow.ok@m1.vn',
        });
        subscribedLeadId = up1.leadId;

        const up2 = await upsertMasterContactInTx(client, tenantA.id, {
          name: 'Flow Suppressed',
          phone: '0909222999',
          email: 'flow.blocked@m1.vn',
          email_consent: 'unsubscribed',
          zns_consent: 'opted_out',
        });
        suppressedLeadId = up2.leadId;
      });

      const flowRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'M1 Real Action Nodes Flow',
          trigger_type: 'manual_enroll',
          status: 'active',
          steps: [
            { id: 'n1', type: 'action', label: 'Send Email FE', config: { subject: 'Chào {{lead.name}}', customHtml: '<p>Hi {{lead.name}}</p>' }, nextStepId: 'n2' },
            { id: 'n2', type: 'zalo_zns', label: 'Send ZNS FE', config: { template_id: 'ZNS_01', subject: 'ZNS {{lead.name}}' }, nextStepId: 'n3' },
            { id: 'n3', type: 'webhook_http', label: 'Safe Webhook', config: { url: 'https://hooks.example.com/m1-event', secret: 'wh-sec-1' }, nextStepId: 'n4' },
            { id: 'n4', type: 'webhook_http', label: 'SSRF Metadata', config: { url: 'http://169.254.169.254/latest/meta-data' }, nextStepId: 'n5' },
            { id: 'n5', type: 'webhook_http', label: 'SSRF RFC1918', config: { url: 'http://10.0.0.1/internal' }, nextStepId: 'n6' },
            { id: 'n6', type: 'notify_internal', label: 'Notify Sale', config: { title: 'Alert {{lead.name}}', message: 'Check lead' }, nextStepId: null },
          ],
        },
      });
      assert.equal(flowRes.status, 201);
      const flowId = flowRes.json.data.id;

      // Subscribed lead triggers email, ZNS, safe webhook, blocks SSRF, and writes notify_internal
      const runOk = await executeFlowForLead(tenantA.id, flowId, subscribedLeadId);
      assert.equal(runOk.status, 'completed');
      assert.equal(emailCaptured.length, 1);
      assert.equal(emailCaptured[0].to, 'flow.ok@m1.vn');
      assert.ok(emailCaptured[0].html.includes('Hi Flow Subscribed'));
      assert.equal(znsCaptured.length, 1);
      assert.equal(znsCaptured[0].phone, '84909222111');
      assert.equal(webhookCaptured.length, 1, 'Only safe HTTPS webhook should fire; SSRF URLs must be blocked');
      assert.equal(webhookCaptured[0].url, 'https://hooks.example.com/m1-event');
      assert.ok(runOk.trace.some((t) => t.step_id === 'n4' && t.outcome.includes('SSRF_BLOCKED')));
      assert.ok(runOk.trace.some((t) => t.step_id === 'n5' && t.outcome.includes('SSRF_BLOCKED')));

      await withTenantTransaction(tenantA.id, async (client) => {
        const auditRows = await client.query(
          `SELECT action FROM admin_audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action = 'flow_notify_internal'`,
          [tenantA.id, subscribedLeadId]
        );
        assert.equal(auditRows.rows.length, 1);
        const tlRows = await client.query(
          `SELECT event_type FROM lead_timeline_events WHERE tenant_id = $1 AND lead_id = $2 AND event_type = 'internal_notification'`,
          [tenantA.id, subscribedLeadId]
        );
        assert.equal(tlRows.rows.length, 1);
      });

      // Unsubscribed / opted-out lead must NOT receive email or ZNS
      const emailCountBefore = emailCaptured.length;
      const znsCountBefore = znsCaptured.length;
      await executeFlowForLead(tenantA.id, flowId, suppressedLeadId);
      assert.equal(emailCaptured.length, emailCountBefore);
      assert.equal(znsCaptured.length, znsCountBefore);
    } finally {
      setCampaignEmailDispatcherForTesting(null);
      setZnsDispatcherForTesting(null);
      setFlowWebhookTransportForTesting(null);
    }
  });

  it('4. Campaign & Reminder dispatch: dedicated Resend HTML merge tags, open pixel, click wrap, multi channel, exclusions, completed status & tracking', async () => {
    const capturedWebhooks: Array<{ url: string; payload: any }> = [];
    const capturedZns: Array<{ phone: string; message?: string }> = [];

    // Configure dedicated email provider (Resend) on Tenant A — Apps Script is reserved for CRM-basic notifications only
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [
          tenantA.id,
          JSON.stringify({
            email_provider: 'resend',
            resend_api_key: 're_m1_test_key',
            resend_from_email: 'marketing@m1.domation.net',
          }),
        ]
      );
    });

    setEmailWebhookFetcherForTesting(async (url, init) => {
      capturedWebhooks.push({ url, payload: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ status: 'ok', messageId: 'appscript-m1-1' });
        },
      };
    });
    setZnsDispatcherForTesting(async (input) => {
      capturedZns.push({ phone: input.phone, message: input.message });
      return { sent: true, messageId: `zns-m1-${capturedZns.length}`, provider: 'test_zns' };
    });

    try {
      // Create audience + 2 leads (1 eligible, 1 excluded via excluded_audience_id)
      const audMain = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { name: 'M1 Campaign Target Aud', audience_type: 'static_data' },
      });
      const audExcl = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { name: 'M1 Campaign Excluded Aud', audience_type: 'static_data' },
      });
      const mainAudId = audMain.json.data.id;
      const exclAudId = audExcl.json.data.id;

      let leadEligibleId = '';
      let leadExcludedId = '';
      await withTenantTransaction(tenantA.id, async (client) => {
        const up1 = await upsertMasterContactInTx(client, tenantA.id, {
          name: 'Camp Winner',
          phone: '0909444111',
          email: 'camp.winner@m1.vn',
        });
        const up2 = await upsertMasterContactInTx(client, tenantA.id, {
          name: 'Camp Excluded',
          phone: '0909444222',
          email: 'camp.excl@m1.vn',
        });
        leadEligibleId = up1.leadId;
        leadExcludedId = up2.leadId;

        await client.query(
          `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type)
           VALUES ($1, $2, $3, $4, 'manual'), ($5, $2, $3, $6, 'manual'), ($7, $2, $8, $6, 'manual')`,
          [
            crypto.randomUUID(),
            tenantA.id,
            mainAudId,
            leadEligibleId,
            crypto.randomUUID(),
            leadExcludedId,
            crypto.randomUUID(),
            exclAudId,
          ]
        );
        await client.query(
          `INSERT INTO tenant_audience_exclusions (id, tenant_id, audience_id, excluded_audience_id)
           VALUES ($1, $2, $3, $4)`,
          [crypto.randomUUID(), tenantA.id, mainAudId, exclAudId]
        );
      });

      const tplRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/templates', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'M1 Tracking Email',
          subject: 'Xin chào {{lead.name}}',
          compiled_html:
            '<html><body><p>Chào {{lead.name}}, xem <a href="https://domation.net/pricing?ref=m1">Bảng giá</a></p><a href="{{unsubscribe_url}}">Unsub</a></body></html>',
        },
      });
      assert.equal(tplRes.status, 201);
      const tplId = tplRes.json.data.id;

      const campRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/campaigns', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'M1 Multi Campaign',
          channel: 'multi',
          audience_id: mainAudId,
          template_id: tplId,
          subject_a: 'Ưu đãi cho {{lead.name}}',
        },
      });
      assert.equal(campRes.status, 201);
      const campId = campRes.json.data.id;

      // Add a reminder rule
      await withTenantTransaction(tenantA.id, async (client) => {
        await client.query(
          `INSERT INTO mkt_campaign_reminders (id, tenant_id, campaign_id, step_order, trigger_condition, wait_hours, subject, template_id, channel, is_active)
           VALUES ($1, $2, $3, 1, 'no_click', 1, 'Nhắc lại cho {{lead.name}}', $4, 'email', true)`,
          [crypto.randomUUID(), tenantA.id, campId, tplId]
        );
      });

      const sendRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/send`, {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      });
      assert.equal(sendRes.status, 200);
      assert.equal(sendRes.json.data.campaign.status, 'completed');
      assert.equal(sendRes.json.data.newly_sent, 2, '1 eligible lead x 2 channels (email + zns)');
      assert.equal(capturedWebhooks.length, 1);
      assert.equal(capturedZns.length, 1);

      const sentHtml = String(capturedWebhooks[0].payload.html || '');
      assert.ok(sentHtml.includes('Chào Camp Winner'), 'HTML merge tags must be rendered');
      const openMatch = sentHtml.match(/https?:\/\/[^"']+\/api\/v1\/public\/marketing\/track\/open\/([0-9a-f-]+)/i);
      const clickMatch = sentHtml.match(/https?:\/\/[^"']+\/api\/v1\/public\/marketing\/track\/click\/([0-9a-f-]+)\?url=[^"']+/i);
      assert.ok(openMatch, 'Email HTML must contain 1x1 open tracking pixel URL');
      assert.ok(clickMatch, 'Email HTML must wrap CTA href with click tracker');
      assert.ok(!sentHtml.includes('/track/click/' + openMatch![1] + '?url=http%3A%2F%2F127.0.0.1') || !sentHtml.includes('/unsubscribe%3F'), 'Unsubscribe URL must NOT be wrapped by click tracker');

      // Hit open pixel -> increments opened_count to 1 and sets status = 'opened'
      const openHit = await fetch(openMatch![0]);
      assert.equal(openHit.status, 200);

      // Process reminders (trigger_condition = 'no_click'): MUST still target the opened-but-not-clicked claim!
      const remRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/process-reminders`, {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { trigger_condition: 'no_click' },
      });
      assert.equal(remRes.status, 200);
      assert.equal(remRes.json.data.reminders_dispatched, 1, 'Email-only reminder on multi campaign must only target email claim');

      await withTenantTransaction(tenantA.id, async (client) => {
        const remRow = await client.query<{ dispatched_count: number }>(
          'SELECT dispatched_count FROM mkt_campaign_reminders WHERE tenant_id = $1 AND campaign_id = $2',
          [tenantA.id, campId]
        );
        assert.ok(Number(remRow.rows[0]?.dispatched_count) >= 1, 'dispatched_count must increment');
        const znsClaim = await client.query<{ reminder_sent: boolean }>(
          `SELECT reminder_sent FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2 AND channel = 'zns' LIMIT 1`,
          [tenantA.id, campId]
        );
        assert.equal(znsClaim.rows[0]?.reminder_sent, false, 'Email reminder must not mark ZNS claim reminder_sent');
      });

      // Hit click link -> increments clicked_count to 1
      const clickHit = await fetch(`${clickMatch![0]}&json=1`);
      assert.equal(clickHit.status, 200);
      const clickJson: any = await clickHit.json();
      assert.equal(clickJson.data.redirect_url, 'https://domation.net/pricing?ref=m1');

      const detail = await apiRequest(harness.baseUrl, `/api/v1/marketing/campaigns/${campId}/detail`, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      });
      assert.equal(detail.status, 200);
      assert.equal(detail.json.data.funnel.opened, 1);
      assert.equal(detail.json.data.funnel.clicked, 1);
    } finally {
      setEmailWebhookFetcherForTesting(null);
      setZnsDispatcherForTesting(null);
    }
  });

  it('5. Public /otp/send real Email & SMS dispatch, /r/:code unique_click_count dedup, survey redirect_rules assignTag DB persistence', async () => {
    const otpEmails: Array<{ to: string; subject: string; html: string }> = [];
    const otpSms: Array<{ phone: string; code: string }> = [];

    setEmailWebhookFetcherForTesting(async (_url, init) => {
      const p = JSON.parse(init.body);
      otpEmails.push({ to: Array.isArray(p.to) ? String(p.to[0] || '') : String(p.to || ''), subject: p.subject, html: p.html });
      return { ok: true, status: 200, async text() { return '{"id":"resend-otp-1"}'; } };
    });
    setSmsTransportForTesting(async (input) => {
      otpSms.push({ phone: input.phone, code: input.code });
      return { sent: true, messageId: 'sms-m1-1', provider: 'test_sms_hook' };
    });

    try {
      const otpEmailRes = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/send', {
        method: 'POST',
        body: { tenant_slug: tenantA.slug, channel: 'email', recipient: 'otp.user@m1.vn', purpose: 'm1_verify' },
      });
      assert.equal(otpEmailRes.status, 201);
      assert.equal(otpEmailRes.json.data.dispatched, true);
      assert.equal(otpEmails.length, 1);
      assert.equal(otpEmails[0].to, 'otp.user@m1.vn');

      const otpSmsRes = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/send', {
        method: 'POST',
        body: { tenant_slug: tenantA.slug, channel: 'sms', recipient: '0909888777', purpose: 'm1_verify' },
      });
      assert.equal(otpSmsRes.status, 201);
      assert.equal(otpSmsRes.json.data.dispatched, true);
      assert.equal(otpSms.length, 1);
      assert.equal(otpSms[0].phone, '0909888777');
    } finally {
      setEmailWebhookFetcherForTesting(null);
      setSmsTransportForTesting(null);
    }

    // Shortlink unique_click_count deduplication
    const slRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/shortlinks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { title: 'M1 Dedup Link', target_url: 'https://domation.net/m1' },
    });
    assert.equal(slRes.status, 201);
    const shortCode = slRes.json.data.short_code;
    const shortLinkId = slRes.json.data.id;

    await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}?json=1`, { headers: { 'User-Agent': 'BrowserA/1.0' } });
    await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}?json=1`, { headers: { 'User-Agent': 'BrowserA/1.0' } });
    await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}?json=1`, { headers: { 'User-Agent': 'BrowserB/2.0' } });

    await withTenantTransaction(tenantA.id, async (client) => {
      const r = await client.query<{ click_count: number; unique_click_count: number }>(
        'SELECT click_count, unique_click_count FROM mkt_short_links WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, shortLinkId]
      );
      assert.equal(Number(r.rows[0]?.click_count), 3);
      assert.equal(Number(r.rows[0]?.unique_click_count), 2);
    });

    // Survey redirect_rules assignTag persisted in tenant_tags & lead_tags
    const srvRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'M1 Quiz Tag Persist',
        survey_type: 'quiz',
        blocks: [
          { id: 'q1', type: 'quiz_scored', label: 'Score Question', correctValue: 'yes', points: 40 },
        ],
        redirect_rules: [
          { minScore: 30, maxScore: 100, assignTag: 'M1-Quiz-Master', redirectUrl: 'https://domation.net/vip' },
        ],
      },
    });
    assert.equal(srvRes.status, 201);
    const srvSlug = srvRes.json.data.slug;

    const subSrv = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/surveys/${srvSlug}`, {
      method: 'POST',
      body: {
        tenant_slug: tenantA.slug,
        name: 'Quiz Taker',
        email: 'quiz.taker@m1.vn',
        answers: { q1: 'yes' },
      },
    });
    assert.equal(subSrv.status, 201);
    assert.ok(subSrv.json.data.tags_applied.includes('M1-Quiz-Master'));
    const quizLeadId = subSrv.json.data.lead_id;
    sharedQuizLeadId = quizLeadId;

    await withTenantTransaction(tenantA.id, async (client) => {
      const dbTags = await client.query<{ name: string }>(
        `SELECT tt.name FROM lead_tags lt INNER JOIN tenant_tags tt ON tt.id = lt.tag_id WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
        [tenantA.id, quizLeadId]
      );
      assert.ok(dbTags.rows.some((r) => r.name === 'M1-Quiz-Master'), 'redirect_rules assignTag must persist to lead_tags in DB');
    });
  });

  it('6. Audiences & Segments: non-destructive custom_fields merge, quiz_score, cf. MariaDB translation, birthday operators & segment exclusions', async () => {
    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const todayStr = `1995-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const in5Days = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5);
    const in5Str = `1992-${pad2(in5Days.getMonth() + 1)}-${pad2(in5Days.getDate())}`;

    let mergeLeadId = '';
    let upcomingLeadId = '';
    let excludedLeadId = '';

    await withTenantTransaction(tenantA.id, async (client) => {
      // Initial upsert with birthday + city
      const first = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Merge Contact',
        phone: '0907123123',
        email: 'merge@m1.vn',
        custom_fields: { birthday: todayStr, city: 'Ha Noi' },
      });
      mergeLeadId = first.leadId;

      // Second upsert with only cf.company -> MUST preserve birthday and city!
      await upsertMasterContactInTx(client, tenantA.id, {
        email: 'merge@m1.vn',
        'cf.company': 'Domation Tech',
      });

      const checkMerge = await client.query<{ custom_fields: Record<string, unknown> }>(
        'SELECT custom_fields FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, mergeLeadId]
      );
      assert.equal(checkMerge.rows[0].custom_fields.birthday, todayStr);
      assert.equal(checkMerge.rows[0].custom_fields.city, 'Ha Noi');
      assert.equal(checkMerge.rows[0].custom_fields.company, 'Domation Tech');

      const up2 = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Upcoming Birthday',
        phone: '0907123456',
        email: 'upcoming@m1.vn',
        lead_score: 90,
        custom_fields: { birthday: in5Str, city: 'Da Nang' },
      });
      upcomingLeadId = up2.leadId;

      const up3 = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Excluded Birthday',
        phone: '0907123789',
        email: 'excl.bday@m1.vn',
        custom_fields: { birthday: todayStr, city: 'Ha Noi' },
      });
      excludedLeadId = up3.leadId;
    });

    // Test MariaDB translation on cf.<key> and numeric custom field guard
    const compiledCf = compileSegmentWhereSql(tenantA.id, [
      { field: 'cf.city', operator: 'equals', value: 'Ha Noi' },
      { field: 'cf.budget', operator: 'gte', value: 1000 },
      { field: 'quiz_score', operator: 'equals', value: 40 },
    ]);
    const mariaSql = translatePostgresSqlToMariaDb(`SELECT l.id FROM leads l WHERE ${compiledCf.whereClause}`, compiledCf.params);
    assert.ok(!mariaSql.sql.includes('->>?'), 'MariaDB SQL must not contain untranslated ->>?');
    assert.ok(!mariaSql.sql.includes(' ~ '), 'MariaDB SQL must translate ~ to REGEXP');
    assert.ok(mariaSql.sql.includes("JSON_UNQUOTE(JSON_EXTRACT(l.custom_fields, '$.city'))"));

    // Preview quiz_score = 50 (default base_lead_score 10 + 40 points from Test 5!)
    const quizPrev = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'quiz_score', operator: 'equals', value: 50 }] },
    });
    assert.equal(quizPrev.status, 200);
    assert.ok(quizPrev.json.data.items.some((s: any) => s.id === sharedQuizLeadId));

    const quizBetweenPrev = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'quiz_score', operator: 'between', min: 45, max: 55 }] },
    });
    assert.equal(quizBetweenPrev.status, 200);
    assert.ok(quizBetweenPrev.json.data.items.some((s: any) => s.id === sharedQuizLeadId));

    // Preview birthday is_today & before_days
    const bdayTodayPrev = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'cf.birthday', operator: 'is_today' }] },
    });
    assert.equal(bdayTodayPrev.status, 200);
    assert.ok(bdayTodayPrev.json.data.items.some((s: any) => s.id === mergeLeadId));

    const bdayBeforeDaysPrev = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'birthday', operator: 'before_days', value: 7 }] },
    });
    assert.equal(bdayBeforeDaysPrev.status, 200);
    assert.ok(bdayBeforeDaysPrev.json.data.items.some((s: any) => s.id === upcomingLeadId));

    // Dynamic segment with exclusion + GET /contacts?segment_id=...&sort=score_desc
    const segRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'M1 Birthday Today Segment',
        audience_type: 'dynamic_logic',
        filter_branches: [{ field: 'cf.birthday', operator: 'is_today' }],
      },
    });
    assert.equal(segRes.status, 201);
    const segId = segRes.json.data.id;

    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `INSERT INTO tenant_audience_exclusions (id, tenant_id, audience_id, lead_id) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), tenantA.id, segId, excludedLeadId]
      );
    });

    const contactsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/audiences/contacts?segment_id=${segId}&sort=score_desc`,
      { token: tenantA.token, tenantSlug: tenantA.slug }
    );
    assert.equal(contactsRes.status, 200);
    const returnedIds = contactsRes.json.data.items.map((x: any) => x.id);
    assert.ok(returnedIds.includes(mergeLeadId));
    assert.ok(!returnedIds.includes(excludedLeadId), 'GET /contacts?segment_id= must honor tenant_audience_exclusions');
  });

  it('7. Master Cronjob end-to-end execution across marketing_flows, marketing_campaigns & reminders', async () => {
    const swB = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { package_code: 'marketing_standalone', payment_method: 'wallet', billing_cycle: 'monthly' },
    });
    assert.equal(swB.status, 200);

    const cronAudRes = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { name: 'Tenant B Cron Aud', audience_type: 'static_data' },
    });
    assert.equal(cronAudRes.status, 201);
    const audBId = cronAudRes.json.data.id;

    const pastIso = new Date(Date.now() - 120_000).toISOString();
    const campId = crypto.randomUUID();
    const remId = crypto.randomUUID();

    await withTenantTransaction(tenantB.id, async (client) => {
      const up = await upsertMasterContactInTx(client, tenantB.id, {
        name: 'Cron Target B',
        phone: '0906555111',
        email: 'cron.b@m1.vn',
      });
      await client.query(
        `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type)
         VALUES ($1, $2, $3, $4, 'manual')`,
        [crypto.randomUUID(), tenantB.id, audBId, up.leadId]
      );
      await client.query(
        `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status, audience_id, subject_a, scheduled_at)
         VALUES ($1, $2, 'Cron Scheduled Camp B', 'email', 'scheduled', $3, 'Cron Hi {{lead.name}}', $4)`,
        [campId, tenantB.id, audBId, pastIso]
      );
      await client.query(
        `INSERT INTO mkt_campaign_reminders (id, tenant_id, campaign_id, step_order, trigger_condition, wait_hours, subject, channel, is_active)
         VALUES ($1, $2, $3, 1, 'no_open', 1, 'Cron Rem', 'email', true)`,
        [remId, tenantB.id, campId]
      );
    });

    const cronRes = await executeMasterCron({
      tenantId: tenantB.id,
      subroutines: ['marketing_flows', 'marketing_campaigns', 'reminders'],
    });
    assert.equal(cronRes.locked, false);
    assert.deepEqual(cronRes.stats.errors, []);
    assert.ok(cronRes.stats.marketingCampaignsProcessed >= 1);

    await withSystemPrivilege(async (client) => {
      const runs = await client.query(
        `SELECT subroutine_key, status FROM tenant_cron_runs WHERE tenant_id = $1 AND subroutine_key IN ('marketing_flows', 'marketing_campaigns', 'reminders')`,
        [tenantB.id]
      );
      assert.ok(runs.rows.length >= 3);
    });
  });

  it('8. Regression: IPv4-mapped/compatible IPv6 SSRF, SMS OTP bypass, active flow PUT snapshot + cfg edges, quiz_score/negate, & minor hardening', async () => {
    // 8a. SSRF IPv4-mapped/compatible IPv6 & NAT64 blocking under production flags
    const savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      OUTBOUND_SILENT_MODE: process.env.OUTBOUND_SILENT_MODE,
      TELEGRAM_SILENT_MODE: process.env.TELEGRAM_SILENT_MODE,
      MIGRATION_SILENT_MODE: process.env.MIGRATION_SILENT_MODE,
      ALLOW_LOCAL_WEBHOOKS: process.env.ALLOW_LOCAL_WEBHOOKS,
    };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.OUTBOUND_SILENT_MODE;
      delete process.env.TELEGRAM_SILENT_MODE;
      delete process.env.MIGRATION_SILENT_MODE;
      delete process.env.ALLOW_LOCAL_WEBHOOKS;

      const blockedUrls = [
        'http://[::ffff:169.254.169.254]/latest/meta-data',
        'http://[::ffff:10.0.0.1]/admin',
        'http://[0:0:0:0:0:ffff:169.254.169.254]/',
        'http://[::ffff:0:169.254.169.254]/',
        'http://[::ffff:127.0.0.1]/',
        'http://[::ffff:192.168.1.1]/',
        'http://[64:ff9b::169.254.169.254]/',
      ];
      for (const u of blockedUrls) {
        assert.throws(() => assertSafeOutboundWebhookUrl(u), /SSRF_BLOCKED_HOST/, `Expected SSRF block for ${u}`);
      }
      assert.equal(assertSafeOutboundWebhookUrl('https://hooks.example.com/ok').hostname, 'hooks.example.com');

      // Even in silent mode, metadata & RFC1918 via ::ffff: remain blocked
      process.env.OUTBOUND_SILENT_MODE = 'true';
      assert.throws(() => assertSafeOutboundWebhookUrl('http://[::ffff:169.254.169.254]/latest/meta-data'), /SSRF_BLOCKED_HOST/);
      assert.throws(() => assertSafeOutboundWebhookUrl('http://[::ffff:10.0.0.1]/admin'), /SSRF_BLOCKED_HOST/);
      assert.equal(assertSafeOutboundWebhookUrl('http://[::ffff:127.0.0.1]:3100/hook').port, '3100');
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // 8b. SMS OTP verification bypass blocked + HTML escaping in OTP email + /sdk.js JSON serialization
    const otpHtmlCaptured: string[] = [];
    setEmailWebhookFetcherForTesting(async (_url, init) => {
      const p = JSON.parse(init.body);
      otpHtmlCaptured.push(String(p.html || ''));
      return { ok: true, status: 200, async text() { return '{"status":"ok"}'; } };
    });
    setSmsTransportForTesting(async () => ({ sent: true, messageId: 'sms-reg-1', provider: 'test_sms_hook' }));

    try {
      const smsFormRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/forms', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'M1 SMS OTP Guard Form',
          routing_mode: 'marketing_nurture',
          require_otp: true,
          otp_channel: 'sms',
          fields: [
            { id: 'f1', key: 'name', label: 'Name', type: 'text', required: true },
            { id: 'f2', key: 'phone', label: 'Phone', type: 'phone', required: false },
          ],
        },
      });
      assert.equal(smsFormRes.status, 201);
      const smsFormToken = smsFormRes.json.data.public_token;

      // Send & verify an EMAIL OTP (with XSS payload in purpose)
      const sendEmailOtp = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/send', {
        method: 'POST',
        body: {
          tenant_slug: tenantA.slug,
          channel: 'email',
          recipient: 'attacker@m1.vn',
          purpose: '<img src=x onerror=alert(1)>',
        },
      });
      assert.equal(sendEmailOtp.status, 201);
      assert.ok(otpHtmlCaptured[0]?.includes('&lt;img src=x onerror=alert(1)&gt;'), 'OTP HTML must escape purpose');
      assert.ok(!otpHtmlCaptured[0]?.includes('<img src=x'), 'OTP HTML must not contain raw unescaped HTML');

      const verifyEmailOtp = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/verify', {
        method: 'POST',
        body: { otp_id: sendEmailOtp.json.data.otp_id, code: sendEmailOtp.json.data.sandbox_otp_code },
      });
      assert.equal(verifyEmailOtp.status, 200);

      // Bypass attempt 1: { email, otp_id: emailOtpId } without phone on SMS OTP form
      const bypass1 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/forms/${smsFormToken}/submit`, {
        method: 'POST',
        body: { name: 'Bypass 1', email: 'attacker@m1.vn', otp_id: sendEmailOtp.json.data.otp_id },
      });
      assert.equal(bypass1.status, 422);
      assert.equal(bypass1.json.error?.code, 'OTP_VERIFICATION_FAILED');

      // Bypass attempt 2: { phone, otp_id: emailOtpId } using email otp_id on SMS gate
      const bypass2 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/forms/${smsFormToken}/submit`, {
        method: 'POST',
        body: { name: 'Bypass 2', phone: '0909777666', otp_id: sendEmailOtp.json.data.otp_id },
      });
      assert.equal(bypass2.status, 422);
      assert.equal(bypass2.json.error?.code, 'OTP_VERIFICATION_FAILED');

      // Valid SMS OTP succeeds
      const sendSmsOtp = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/send', {
        method: 'POST',
        body: { tenant_slug: tenantA.slug, channel: 'sms', recipient: '0909777666', purpose: 'form_submit' },
      });
      assert.equal(sendSmsOtp.status, 201);
      const verifySmsOtp = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/otp/verify', {
        method: 'POST',
        body: { otp_id: sendSmsOtp.json.data.otp_id, code: sendSmsOtp.json.data.sandbox_otp_code },
      });
      assert.equal(verifySmsOtp.status, 200);

      const validSubmit = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/forms/${smsFormToken}/submit`, {
        method: 'POST',
        body: { name: 'Valid SMS', phone: '0909777666', otp_id: sendSmsOtp.json.data.otp_id },
      });
      assert.equal(validSubmit.status, 201);
    } finally {
      setEmailWebhookFetcherForTesting(null);
      setSmsTransportForTesting(null);
    }

    // 8c. Active flow PUT edit + wait_delay cron resume executes updated post-wait step & cfg.trueNextStepId
    let flowEditLeadId = '';
    await withTenantTransaction(tenantA.id, async (client) => {
      const up = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Flow Edit Lead',
        phone: '0909555666',
        email: 'flow.edit@m1.vn',
        lead_score: 80,
      });
      flowEditLeadId = up.leadId;
    });

    const createEditFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'M1 Active Edit Snapshot Flow',
        trigger_type: 'manual_enroll',
        status: 'active',
        steps: [
          { id: 'p_w', type: 'wait', config: { duration: 1, unit: 'seconds' }, nextStepId: 'p_old' },
          { id: 'p_old', type: 'update_lead_score', config: { delta: 5 }, nextStepId: null },
        ],
      },
    });
    assert.equal(createEditFlow.status, 201);
    const editFlowId = createEditFlow.json.data.id;

    const putEditFlow = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${editFlowId}`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        steps: [
          { id: 'p_w', type: 'wait', config: { duration: 1, unit: 'seconds' }, nextStepId: 'p_cond' },
          {
            id: 'p_cond',
            type: 'condition',
            cfg: {
              field: 'lead_score',
              operator: 'gte',
              value: 50,
              trueNextStepId: 'p_new',
              falseNextStepId: 'p_old',
            },
          },
          { id: 'p_new', type: 'update_lead_score', config: { delta: 50 }, nextStepId: null },
          { id: 'p_old', type: 'update_lead_score', config: { delta: 5 }, nextStepId: null },
        ],
      },
    });
    assert.equal(putEditFlow.status, 200);
    assert.equal(Number(putEditFlow.json.data.version), 2);

    const enrollEdited = await executeFlowForLead(tenantA.id, editFlowId, flowEditLeadId);
    assert.equal(enrollEdited.status, 'waiting');

    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        'UPDATE mkt_flow_enrollments SET next_run_at = $3 WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, enrollEdited.enrollmentId, new Date(Date.now() - 10_000).toISOString()]
      );
    });

    const cronEdited = await executeMasterCron({ tenantId: tenantA.id, subroutines: ['marketing_flows'] });
    assert.equal(cronEdited.stats.marketingFlowsProcessed, 1);

    await withTenantTransaction(tenantA.id, async (client) => {
      const enRes = await client.query<{ status: string; snapshot_version: number; execution_trace: any[] }>(
        'SELECT status, snapshot_version, execution_trace FROM mkt_flow_enrollments WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, enrollEdited.enrollmentId]
      );
      assert.equal(enRes.rows[0]?.status, 'completed');
      assert.equal(Number(enRes.rows[0]?.snapshot_version), 2);
      const stepIds = (enRes.rows[0]?.execution_trace || []).map((t: any) => t.step_id);
      assert.ok(stepIds.includes('p_new'), `Expected updated step p_new in trace, got ${stepIds.join('->')}`);
      assert.ok(!stepIds.includes('p_old'), 'Stale v1 step p_old must not execute after active PUT edit');

      const l = await client.query<{ lead_score: number }>(
        'SELECT lead_score FROM leads WHERE tenant_id = $1 AND id = $2',
        [tenantA.id, flowEditLeadId]
      );
      assert.equal(Number(l.rows[0]?.lead_score), 130);
    });

    // 8d. quiz_score non-numeric 'N/A' + scoreless {} + negate: true on quiz_score & birthday + MariaDB
    let naQuizLeadId = '';
    let scorelessQuizLeadId = '';
    await withTenantTransaction(tenantA.id, async (client) => {
      const u1 = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Quiz NA',
        phone: '0909666111',
        email: 'quiz.na@m1.vn',
      });
      const u2 = await upsertMasterContactInTx(client, tenantA.id, {
        name: 'Quiz Scoreless',
        phone: '0909666222',
        email: 'quiz.empty@m1.vn',
      });
      naQuizLeadId = u1.leadId;
      scorelessQuizLeadId = u2.leadId;

      await client.query(
        `INSERT INTO lead_timeline_events (id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, metadata)
         VALUES ($1, $2, $3, 'survey_completed', 'marketing', 'system', 'Quiz System', 'Quiz NA', $4::jsonb),
                ($5, $2, $6, 'survey_completed', 'marketing', 'system', 'Quiz System', 'Quiz Scoreless', '{}'::jsonb)`,
        [crypto.randomUUID(), tenantA.id, naQuizLeadId, JSON.stringify({ quiz_score: 'N/A' }), crypto.randomUUID(), scorelessQuizLeadId]
      );
    });

    const quizLt60 = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'quiz_score', operator: 'lt', value: 60 }] },
    });
    assert.equal(quizLt60.status, 200);
    const lt60Ids = quizLt60.json.data.items.map((x: any) => x.id);
    assert.ok(lt60Ids.includes(sharedQuizLeadId));
    assert.ok(!lt60Ids.includes(naQuizLeadId), 'Non-numeric quiz_score must not match or crash');
    assert.ok(!lt60Ids.includes(scorelessQuizLeadId), 'Scoreless survey must not be coerced to 0');

    const quizEq0 = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'quiz_score', operator: 'equals', value: 0 }] },
    });
    assert.equal(quizEq0.status, 200);
    assert.ok(!quizEq0.json.data.items.some((x: any) => x.id === scorelessQuizLeadId));

    const quizNeg = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'quiz_score', operator: 'equals', value: 50, negate: true }] },
    });
    assert.equal(quizNeg.status, 200);
    const quizNegIds = quizNeg.json.data.items.map((x: any) => x.id);
    assert.ok(!quizNegIds.includes(sharedQuizLeadId), 'negate: true on quiz_score must exclude score=50');
    assert.ok(quizNegIds.includes(scorelessQuizLeadId));

    const bdayNeg = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { filter_branches: [{ field: 'cf.birthday', operator: 'is_this_month', negate: true }] },
    });
    assert.equal(bdayNeg.status, 200);
    const bdayNegIds = bdayNeg.json.data.items.map((x: any) => x.id);
    assert.ok(!bdayNegIds.some((id: string) => id === flowEditLeadId && false));
    assert.ok(bdayNegIds.includes(flowEditLeadId), 'Lead without birthday must match negated is_this_month');
    assert.ok(
      !bdayNegIds.some((id: string) => {
        const found = bdayNeg.json.data.items.find((x: any) => x.id === id);
        return found?.email === 'merge@m1.vn';
      }),
      'negate: true on cf.birthday is_this_month must exclude today birthday contact'
    );

    const compiledQuizMaria = compileSegmentWhereSql(tenantA.id, [
      { field: 'quiz_score', operator: 'equals', value: 50, negate: true },
      { field: 'cf.birthday', operator: 'is_today', negate: true },
    ]);
    const mariaQuiz = translatePostgresSqlToMariaDb(
      `SELECT l.id FROM leads l WHERE ${compiledQuizMaria.whereClause}`,
      compiledQuizMaria.params
    );
    assert.ok(!mariaQuiz.sql.includes(' ~ '), 'MariaDB quiz_score must translate ~ to REGEXP');
    assert.ok(!mariaQuiz.sql.includes('->>?'), 'MariaDB SQL must not contain untranslated ->>?');
    assert.ok(mariaQuiz.sql.includes('NOT (EXISTS'), 'Negated quiz_score must emit NOT (EXISTS ...)');

    // 8e. Minor hardening checks: PUT shortlinks target_url, /sdk.js, utils.ts, object-map field-catalog, multi-campaign single-channel reminder
    const badSl = await apiRequest(harness.baseUrl, '/api/v1/marketing/vouchers/shortlinks', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { title: 'Valid SL', target_url: 'https://domation.net/ok' },
    });
    assert.equal(badSl.status, 201);
    const badPutSl = await apiRequest(harness.baseUrl, `/api/v1/marketing/vouchers/shortlinks/${badSl.json.data.id}`, {
      method: 'PUT',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { target_url: 'javascript:alert(1)' },
    });
    assert.equal(badPutSl.status, 422);
    assert.equal(badPutSl.json.error?.code, 'INVALID_SHORTLINK');

    const sdkRes = await fetch(`${harness.baseUrl}/api/v1/public/marketing/sdk.js?site_key=m1_key`, {
      headers: { 'X-Forwarded-Host': 'evil.com";alert(1);//' },
    });
    assert.equal(sdkRes.status, 200);
    const sdkBody = await sdkRes.text();
    assert.ok(sdkBody.includes('\\"') || sdkBody.includes('127.0.0.1'), 'sdk.js endpoint must be JSON-serialized safely');

    const plainTracked = injectEmailOpenAndClickTracking('Price <b and > c\nSee https://domation.net', {
      baseUrl: 'https://app.domation.net',
      claimId: 'claim-1',
    });
    assert.ok(plainTracked.includes('Price &lt;b and &gt; c'), 'Plain text with < must be HTML-escaped rather than misclassified');
    const extUnsubTracked = injectEmailOpenAndClickTracking(
      '<a href="https://other.example.com/unsubscribe?id=1">Unsub</a><a href="https://domation.net/go">Go</a>',
      { baseUrl: 'https://app.domation.net', claimId: 'claim-1' }
    );
    assert.ok(extUnsubTracked.includes('href="https://other.example.com/unsubscribe?id=1"'), 'External /unsubscribe URL must not be wrapped');
    assert.ok(extUnsubTracked.includes('/api/v1/public/marketing/track/click/claim-1?url=https%3A%2F%2Fdomation.net%2Fgo'));

    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
        [tenantA.id, JSON.stringify({ custom_fields: { vip_tier: { label: 'VIP Tier', type: 'text' } } })]
      );
    });
    const catRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/field-catalog', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(catRes.status, 200);
    assert.ok(
      catRes.json.data.fields.some((f: any) => f.key === 'cf.vip_tier' && String(f.label).includes('VIP Tier')),
      'field-catalog must support object-map tenants.settings.custom_fields'
    );

    // Verify cron runRemindersWorker single-channel filter on multi campaign
    const multiCampId = crypto.randomUUID();
    const multiRemId = crypto.randomUUID();
    const multiEmailClaimId = crypto.randomUUID();
    const multiZnsClaimId = crypto.randomUUID();
    const oldSentAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    await withTenantTransaction(tenantB.id, async (client) => {
      const up = await upsertMasterContactInTx(client, tenantB.id, {
        name: 'Multi Rem Lead',
        phone: '0906111999',
        email: 'multi.rem@m1.vn',
      });
      await client.query(
        `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status, subject_a)
         VALUES ($1, $2, 'Cron Multi Rem Camp', 'multi', 'completed', 'Multi Hi')`,
        [multiCampId, tenantB.id]
      );
      await client.query(
        `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, status, sent_at, reminder_sent)
         VALUES ($1, $2, $3, $4, 'email', 'sent', $5, false),
                ($6, $2, $3, $4, 'zns', 'sent', $5, false)`,
        [multiEmailClaimId, tenantB.id, multiCampId, up.leadId, oldSentAt, multiZnsClaimId]
      );
      await client.query(
        `INSERT INTO mkt_campaign_reminders (id, tenant_id, campaign_id, step_order, trigger_condition, wait_hours, subject, channel, is_active)
         VALUES ($1, $2, $3, 1, 'no_open', 1, 'Email-only Cron Rem', 'email', true)`,
        [multiRemId, tenantB.id, multiCampId]
      );
    });
    const remCronRes = await executeMasterCron({ tenantId: tenantB.id, subroutines: ['reminders'] });
    assert.deepEqual(remCronRes.stats.errors, []);
    await withTenantTransaction(tenantB.id, async (client) => {
      const claims = await client.query<{ channel: string; reminder_sent: boolean }>(
        'SELECT channel, reminder_sent FROM mkt_send_claims WHERE tenant_id = $1 AND campaign_id = $2',
        [tenantB.id, multiCampId]
      );
      const emailClaim = claims.rows.find((c) => c.channel === 'email');
      const znsClaim = claims.rows.find((c) => c.channel === 'zns');
      assert.equal(emailClaim?.reminder_sent, true);
      assert.equal(znsClaim?.reminder_sent, false, 'Cron email reminder must not touch ZNS claim on multi campaign');
    });
  });

  it('9. Regression: Survey matrix (likert_matrix, matrix_multi, matrix_single) & object answers emit human-readable question_stats and export.csv with zero [object Object]', async () => {
    const createRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'M1 Matrix & Object Survey Regression',
        survey_type: 'survey',
        blocks: [
          {
            id: 'blk_likert_matrix',
            type: 'likert_matrix',
            label: 'Đánh giá mức độ hài lòng',
            matrix_rows: [
              { id: 'row_stability_long', label: 'Độ ổn định' },
              { id: 'r2', label: 'Hỗ trợ' },
            ],
            matrix_cols: [
              { id: 'c1', label: 'Tốt' },
              { id: 'c2', label: 'Xuất sắc' },
            ],
          },
          {
            id: 'blk_matrix_multi',
            type: 'matrix_multi',
            label: 'Tiêu chí ưu tiên',
            matrixRows: [
              { id: '11111111-1111-4111-8111-111111111111', label: 'Tiêu chí A' },
              { id: '22222222-2222-4222-8222-222222222222', label: 'Tiêu chí B' },
            ],
            matrixCols: [
              { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Tiện lợi' },
              { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'Nhanh chóng' },
            ],
          },
          {
            id: 'blk_matrix_single',
            type: 'matrix_single',
            label: 'Ma trận đơn',
            matrixRows: [{ id: 'ms_r1', label: 'Chất lượng' }],
            matrixCols: [
              { id: 'ms_c1', label: 'Chưa đạt' },
              { id: 'ms_c2', label: 'Đạt' },
            ],
          },
          {
            id: 'blk_multi',
            type: 'multi_choice',
            label: 'Kênh sử dụng',
            options: [
              { id: 'mo1', label: 'Lựa chọn Alpha', value: 'opt_a' },
              { id: 'mo2', label: 'Lựa chọn Beta', value: 'opt_b' },
            ],
          },
          {
            id: 'blk_file',
            type: 'file_upload',
            label: 'Tài liệu đính kèm',
          },
          {
            id: 'blk_adhoc',
            type: 'matrix_multi',
            label: 'Thuộc tính bổ sung',
          },
        ],
      },
    });
    assert.equal(createRes.status, 201);
    const surveyId = createRes.json.data.id;
    const surveySlug = createRes.json.data.slug;

    const sub1 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/surveys/${surveySlug}`, {
      method: 'POST',
      body: {
        tenant_slug: tenantA.slug,
        name: 'Matrix Respondent 1',
        email: 'matrix1@m1.vn',
        answers: {
          blk_likert_matrix: { row_stability_long: 'c1', r2: 'c2' },
          blk_matrix_multi: {
            '11111111-1111-4111-8111-111111111111': [
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            ],
            '22222222-2222-4222-8222-222222222222': ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
          },
          blk_matrix_single: { ms_r1: ['ms_c2'] },
          blk_multi: ['opt_a', 'opt_b'],
          blk_file: { name: 'brief.pdf', size: 2048, type: 'application/pdf', dataUrl: 'data:application/pdf;base64,AAA' },
          blk_adhoc: { speed: 'fast', ui: ['clean', 'clear'] },
        },
      },
    });
    assert.equal(sub1.status, 201);

    const sub2 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/surveys/${surveySlug}`, {
      method: 'POST',
      body: {
        tenant_slug: tenantA.slug,
        name: 'Matrix Respondent 2',
        email: 'matrix2@m1.vn',
        answers: {
          blk_likert_matrix: { row_stability_long: 'c2', r2: 'c2' },
          blk_matrix_multi: {
            '11111111-1111-4111-8111-111111111111': ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
            '22222222-2222-4222-8222-222222222222': [],
          },
          blk_matrix_single: {},
        },
      },
    });
    assert.equal(sub2.status, 201);

    const reportRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/report`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(reportRes.status, 200);
    const reportRawJson = JSON.stringify(reportRes.json);
    assert.ok(!reportRawJson.includes('[object Object]'), `Report payload must never contain [object Object]: ${reportRawJson}`);

    const statsById = new Map<string, any>(
      (reportRes.json.data.question_stats || []).map((q: any) => [q.block_id, q])
    );

    const likertStat = statsById.get('blk_likert_matrix');
    assert.equal(likertStat.answered_count, 2);
    assert.deepEqual(likertStat.breakdown[0], { option: 'Hỗ trợ: Xuất sắc', count: 2, pct: 100 });
    assert.equal(likertStat.breakdown.length, 3);
    assert.ok(likertStat.breakdown.some((b: any) => b.option === 'Độ ổn định: Tốt' && b.count === 1 && b.pct === 50));
    assert.ok(likertStat.breakdown.some((b: any) => b.option === 'Độ ổn định: Xuất sắc' && b.count === 1 && b.pct === 50));

    const matrixMultiStat = statsById.get('blk_matrix_multi');
    assert.equal(matrixMultiStat.answered_count, 2);
    assert.equal(matrixMultiStat.breakdown[0].option, 'Tiêu chí A: Nhanh chóng');
    assert.equal(matrixMultiStat.breakdown[0].count, 2);
    assert.ok(matrixMultiStat.breakdown.some((b: any) => b.option === 'Tiêu chí A: Tiện lợi' && b.count === 1));
    assert.ok(matrixMultiStat.breakdown.some((b: any) => b.option === 'Tiêu chí B: Nhanh chóng' && b.count === 1));

    const matrixSingleStat = statsById.get('blk_matrix_single');
    assert.equal(matrixSingleStat.answered_count, 1, 'Empty matrix {} must not increment answered_count');
    assert.deepEqual(matrixSingleStat.breakdown, [{ option: 'Chất lượng: Đạt', count: 1, pct: 100 }]);

    const fileStat = statsById.get('blk_file');
    assert.equal(fileStat.answered_count, 1);
    assert.deepEqual(fileStat.breakdown, [{ option: 'brief.pdf', count: 1, pct: 100 }]);

    const adhocStat = statsById.get('blk_adhoc');
    assert.equal(adhocStat.answered_count, 1);
    assert.ok(adhocStat.breakdown.some((b: any) => b.option === 'speed: fast' && b.count === 1));
    assert.ok(adhocStat.breakdown.some((b: any) => b.option === 'ui: clean' && b.count === 1));
    assert.ok(adhocStat.breakdown.some((b: any) => b.option === 'ui: clear' && b.count === 1));

    const csvResp = await fetch(`${harness.baseUrl}/api/v1/marketing/surveys/${surveyId}/export.csv`, {
      headers: {
        Authorization: `Bearer ${tenantA.token}`,
        'X-Tenant-Slug': tenantA.slug,
      },
    });
    assert.equal(csvResp.status, 200);
    const csvText = await csvResp.text();
    assert.ok(!csvText.includes('[object Object]'), `CSV export must never contain [object Object]: ${csvText}`);
    assert.ok(csvText.includes('Độ ổn định: Tốt | Hỗ trợ: Xuất sắc'));
    assert.ok(csvText.includes('Tiêu chí A: Tiện lợi, Nhanh chóng | Tiêu chí B: Nhanh chóng'));
    assert.ok(csvText.includes('Chất lượng: Đạt'));
    assert.ok(csvText.includes('Lựa chọn Alpha; Lựa chọn Beta'));
    assert.ok(csvText.includes('brief.pdf'));
    assert.ok(!csvText.includes('data:application/pdf'), 'CSV export must not dump base64 dataUrl');
    assert.ok(csvText.includes('speed: fast'));
    assert.ok(csvText.includes('ui: clean, clear'));

    const analyticsRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/analytics`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(analyticsRes.status, 200);
    assert.ok(!JSON.stringify(analyticsRes.json).includes('[object Object]'));
    assert.equal(analyticsRes.json.data.overview.total_responses, 2);
    const analyticsQById = new Map<string, any>(
      (analyticsRes.json.data.questions || []).map((q: any) => [q.question_id, q])
    );
    const analyticsLikert = analyticsQById.get('blk_likert_matrix');
    assert.equal(analyticsLikert.total_answered, 2);
    assert.ok(
      (analyticsLikert.choice_distribution || []).some(
        (d: any) => d.label === 'Hỗ trợ: Xuất sắc' && d.count === 2 && d.percentage === 100
      )
    );

    const respondentsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/surveys/${surveyId}/analytics?action=respondents`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(respondentsRes.status, 200);
    assert.ok(!JSON.stringify(respondentsRes.json).includes('[object Object]'));
    const respRows = respondentsRes.json.data.responses || [];
    assert.equal(respRows.length, 2);
    const firstResp = respRows.find((r: any) => Array.isArray(r.answers) && r.answers.some((a: any) => a.block_id === 'blk_file'));
    assert.ok(firstResp, 'action=respondents must format response.answers as { block_id, question_title, answer_text }[]');
    const likertAnsItem = firstResp.answers.find((a: any) => a.block_id === 'blk_likert_matrix');
    assert.equal(likertAnsItem?.answer_text, 'Độ ổn định: Tốt | Hỗ trợ: Xuất sắc');
  });

  it('10. Survey Analytics/Report/CSV decode HTML entities (&amp;), skip all-false matrices, fall back past empty labels, and strip _answer_details', async () => {
    const createRes = await apiRequest(harness.baseUrl, '/api/v1/marketing/surveys', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        title: 'M1 Edge Survey Normalization',
        survey_type: 'survey',
        blocks: [
          {
            id: 'blk_amp_choice',
            type: 'single_choice',
            label: 'Định hướng phát triển',
            options: [
              {
                id: 'opt_amp',
                label: 'Bứt phá quy mô doanh nghiệp & vị thế lãnh đạo C-suite.',
                value: 'bứt_phá_quy_mô_doanh_nghiệp_&_vị_thế_lãnh_đạo_c-suite.',
              },
            ],
          },
          {
            id: 'blk_empty_lbl_matrix',
            type: 'matrix_multi',
            label: 'Khả năng đáp ứng',
            matrix_rows: [{ id: 'r_fb', label: '', text: 'Tốc độ phản hồi' }],
            matrix_cols: [
              { id: 'c_a', label: '', text: 'Nhanh' },
              { id: 'c_b', label: '', text: 'Rõ ràng' },
            ],
          },
          {
            id: 'blk_all_false_matrix',
            type: 'matrix_multi',
            label: 'Ma trận chưa chọn',
            matrix_rows: [{ id: 'r_none', label: 'Mục X' }],
            matrix_cols: [{ id: 'c_x1', label: 'Chọn 1' }],
          },
        ],
      },
    });
    assert.equal(createRes.status, 201);
    const surveyId = createRes.json.data.id;
    const surveySlug = createRes.json.data.slug;

    const sub = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/surveys/${surveySlug}`, {
      method: 'POST',
      body: {
        tenant_slug: tenantA.slug,
        name: 'Entity Edge User',
        email: 'entity@m1.vn',
        answers: {
          blk_amp_choice: 'bứt_phá_quy_mô_doanh_nghiệp_&amp;_vị_thế_lãnh_đạo_c-suite.',
          blk_empty_lbl_matrix: { r_fb: { c_a: true, c_b: false } },
          blk_all_false_matrix: { r_none: { c_x1: false } },
          _answer_details: [{ question_title: 'Legacy Raw Detail', answer_text: 'Bứt phá' }],
        },
      },
    });
    assert.equal(sub.status, 201);

    const reportRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/surveys/${surveyId}/report`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(reportRes.status, 200);
    assert.ok(!JSON.stringify(reportRes.json).includes('[object Object]'));
    const stats = new Map<string, any>((reportRes.json.data.question_stats || []).map((q: any) => [q.block_id, q]));

    assert.deepEqual(stats.get('blk_amp_choice')?.breakdown, [
      { option: 'Bứt phá quy mô doanh nghiệp & vị thế lãnh đạo C-suite.', count: 1, pct: 100 },
    ]);
    assert.deepEqual(stats.get('blk_empty_lbl_matrix')?.breakdown, [
      { option: 'Tốc độ phản hồi: Nhanh', count: 1, pct: 100 },
    ]);
    assert.equal(stats.get('blk_all_false_matrix')?.answered_count, 0, 'All-false checkbox matrix must count as unanswered');
    assert.deepEqual(stats.get('blk_all_false_matrix')?.breakdown, []);

    const analyticsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/surveys/${surveyId}/analytics?action=respondents`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(analyticsRes.status, 200);
    const analyticsJson = JSON.stringify(analyticsRes.json);
    assert.ok(!analyticsJson.includes('[object Object]'));
    assert.ok(!analyticsJson.includes('_answer_details'), 'Internal _answer_details key must be stripped from analytics responses');
    const aqById = new Map<string, any>(
      (analyticsRes.json.data.questions || []).map((q: any) => [q.question_id, q])
    );
    assert.equal(aqById.get('blk_all_false_matrix')?.total_answered, 0);
    assert.equal(
      aqById.get('blk_amp_choice')?.choice_distribution?.[0]?.label,
      'Bứt phá quy mô doanh nghiệp & vị thế lãnh đạo C-suite.'
    );
    const respAns = analyticsRes.json.data.responses?.[0]?.answers || [];
    assert.equal(respAns.find((a: any) => a.block_id === 'blk_empty_lbl_matrix')?.answer_text, 'Tốc độ phản hồi: Nhanh');
    assert.equal(respAns.find((a: any) => a.block_id === 'blk_all_false_matrix')?.answer_text, '');

    const csvResp = await fetch(`${harness.baseUrl}/api/v1/marketing/surveys/${surveyId}/export.csv`, {
      headers: {
        Authorization: `Bearer ${tenantA.token}`,
        'X-Tenant-Slug': tenantA.slug,
      },
    });
    assert.equal(csvResp.status, 200);
    const csvText = await csvResp.text();
    assert.ok(!csvText.includes('[object Object]'));
    assert.ok(csvText.includes('Bứt phá quy mô doanh nghiệp & vị thế lãnh đạo C-suite.'));
    assert.ok(csvText.includes('Tốc độ phản hồi: Nhanh'));
    assert.ok(!csvText.includes('Mục X: false'));
  });
});
