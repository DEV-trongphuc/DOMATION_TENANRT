import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness } from './_harness.ts';

let harness: MarketingE2eHarness;

describe('Feature 2: Automation Flow Engine & Wait Resume (E2E)', () => {
  before(async () => {
    harness = await startMarketingE2eHarness();
  });

  after(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.resetCaptures();
  });

  // =========================================================================
  // Tier 1 — Happy Path (6 tests)
  // =========================================================================
  describe('Tier 1: Happy Path', () => {
    it('F2-T1-01: returns 15x11 catalog, creates flow, publishes immutable snapshot & restores snapshot', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const listRes = await harness.apiJson('/api/v1/marketing/flows', { auth });
      assert.equal(listRes.data.triggers_catalog.length, 15);
      assert.equal(listRes.data.nodes_catalog.length, 11);

      const v1Steps = [
        { id: 's1', type: 'update_lead_score', label: 'Score +15', config: { delta: 15 } },
      ];
      const created = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Snapshot Lifecycle Flow',
          trigger_type: 'form_submitted',
          steps: v1Steps,
        },
      });
      const flowId = created.data.id;
      assert.equal(created.data.version, 1);
      assert.equal(created.data.status, 'draft');

      const pubRes = await harness.apiJson(`/api/v1/marketing/flows/${flowId}/publish`, {
        method: 'POST',
        auth,
      });
      const snapshotId = pubRes.data.snapshot_id;
      assert.ok(snapshotId);
      assert.equal(pubRes.data.flow.version, 2);
      assert.equal(pubRes.data.flow.status, 'active');

      const v2Steps = [
        { id: 's2', type: 'add_remove_tag', label: 'Tag Edited', config: { tag: 'v2-tag', mode: 'add' } },
      ];
      await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, {
        method: 'PUT',
        auth,
        body: { steps: v2Steps },
      });

      const restored = await harness.apiJson(`/api/v1/marketing/flows/${flowId}/restore-snapshot`, {
        method: 'POST',
        auth,
        body: { snapshot_id: snapshotId },
      });
      assert.equal(restored.data.steps.length, 1);
      assert.equal(restored.data.steps[0].id, 's1');
      assert.equal(restored.data.steps[0].type, 'update_lead_score');
    });

    it('F2-T1-02: executes dry-run simulate (0 DB enrollments) & DOM Agent review audit', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const created = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Dry Run & Review Flow',
          trigger_type: 'form_submitted',
          steps: [
            {
              id: 'cond1',
              type: 'if_else_condition',
              label: 'Hot Lead Check',
              config: { field: 'lead_score', operator: 'gte', value: 50 },
              yesStepId: 'score1',
              noStepId: 'tag1',
            },
            { id: 'score1', type: 'update_lead_score', label: 'Add +10', config: { delta: 10 } },
            { id: 'tag1', type: 'add_remove_tag', label: 'Nurture Tag', config: { tag: 'nurture', mode: 'add' } },
          ],
        },
      });
      const flowId = created.data.id;

      const simRes = await harness.apiJson(`/api/v1/marketing/flows/${flowId}/simulate`, {
        method: 'POST',
        auth,
        body: { sample_lead: { lead_score: 80, email: 'sim@test.vn' } },
      });
      assert.ok(Array.isArray(simRes.data.trace) && simRes.data.trace.length >= 2);
      assert.equal(simRes.data.trace[0].branch, 'yes');
      assert.equal(typeof simRes.data.wouldPushToSaleRound, 'boolean');
      assert.ok(simRes.data.finalLeadState);

      const flowAfterSim = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.equal(flowAfterSim.data.enrollments.length, 0);

      const revRes = await harness.apiJson(`/api/v1/marketing/flows/${flowId}/review`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(revRes.data.auditor, 'DOM Agent');
      assert.equal(typeof revRes.data.score, 'number');
      assert.ok(revRes.data.score >= 0 && revRes.data.score <= 100);
      assert.ok(revRes.data.grade);
      assert.ok(Array.isArray(revRes.data.findings));
    });

    it('F2-T1-03: executes if_else_condition, ab_split, add_remove_tag, update_lead_score & tracks analytics/participants', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const leadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Branch Lead', email: 'branch@test.vn', phone: '0909123001', lead_score: 60 },
      });
      const leadId = leadRes.data.id;

      const created = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Multi-Branch Execution Flow',
          trigger_type: 'manual_enroll',
          steps: [
            {
              id: 'c1',
              type: 'if_else_condition',
              label: 'Score >= 50',
              config: { field: 'lead_score', operator: 'gte', value: 50 },
              yesStepId: 'ab1',
              noStepId: 'cold1',
            },
            {
              id: 'ab1',
              type: 'ab_split',
              label: '50/50 Split',
              config: { ratio_a: 50 },
              pathAStepId: 'act1',
              pathBStepId: 'act1',
            },
            {
              id: 'act1',
              type: 'add_remove_tag',
              label: 'Tag Qualified',
              config: { tag: 'qualified-vip', mode: 'add' },
              nextStepId: 'sc1',
            },
            { id: 'sc1', type: 'update_lead_score', label: 'Score +20', config: { delta: 20 } },
            { id: 'cold1', type: 'add_remove_tag', label: 'Tag Cold', config: { tag: 'cold', mode: 'add' } },
          ],
        },
      });
      const flowId = created.data.id;

      const enrollRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: leadId, skip_wait_delay: true },
      });
      assert.equal(enrollRes.status, 201);
      assert.equal(enrollRes.json.data.status, 'completed');
      const trace = enrollRes.json.data.trace as Array<any>;
      assert.equal(trace.find((t) => t.step_id === 'c1')?.branch, 'yes');
      const abBranch = trace.find((t) => t.step_id === 'ab1')?.branch;
      assert.ok(abBranch === 'A' || abBranch === 'B');

      const analytics = await harness.apiJson(`/api/v1/marketing/flows/${flowId}/analytics`, { auth });
      assert.ok(analytics.data.summary.enrolled_count >= 1);
      const c1Funnel = analytics.data.step_funnel.find((s: any) => s.step_id === 'c1');
      assert.equal(c1Funnel?.yes_count, 1);
      const abFunnel = analytics.data.step_funnel.find((s: any) => s.step_id === 'ab1');
      assert.equal((abFunnel?.branch_a_count || 0) + (abFunnel?.branch_b_count || 0), 1);

      const parts = await harness.apiJson(`/api/v1/marketing/flows/${flowId}/steps/act1/participants`, { auth });
      assert.equal(parts.data.step_id, 'act1');
      assert.ok(parts.data.total >= 1);
      assert.ok(parts.data.participants.some((p: any) => p.lead_id === leadId));
    });

    // [M1-REQ] True requirement: wait_delay honors cfg.unit='minutes' and cron resumes from current_step_id (NOT root!)
    it('F2-T1-04: [M1-REQ] wait_delay pauses (cfg.unit=minutes) & Master Cron resumes from current_step_id without re-running step 1', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const leadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Wait Resume Lead', email: 'waitresume@test.vn', phone: '0909123002', lead_score: 20 },
      });
      const leadId = leadRes.data.id;

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Wait Resume Flow',
          trigger_type: 'manual_enroll',
          steps: [
            {
              id: 'step1_score',
              type: 'update_lead_score',
              label: 'Initial Score +10',
              config: { delta: 10 },
              nextStepId: 'step2_wait',
            },
            {
              id: 'step2_wait',
              type: 'wait_delay',
              label: 'Wait 0.005m',
              config: { duration: 0.005, unit: 'minutes', pause_execution: true },
              nextStepId: 'step3_tag',
            },
            {
              id: 'step3_tag',
              type: 'add_remove_tag',
              label: 'Resumed Tag',
              config: { tag: 'resumed_ok', mode: 'add' },
            },
          ],
        },
      });
      const flowId = flowRes.data.id;

      const enrollRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: leadId, skip_wait_delay: false },
      });
      assert.equal(enrollRes.status, 201);
      assert.equal(enrollRes.json.data.status, 'waiting');

      // Score should be 20 + 10 = 30 after step1 (paused before step3)
      const contactsWhileWaiting = await harness.apiJson('/api/v1/audiences/contacts', { auth });
      const leadWhileWaiting = contactsWhileWaiting.data.items.find((c: any) => c.id === leadId);
      assert.equal(leadWhileWaiting.lead_score, 30);

      // 0.005 minutes = 300ms; wait 450ms then trigger Master Cron marketing_flows
      await new Promise((r) => setTimeout(r, 450));
      const cronRes = await harness.triggerMasterCron(['marketing_flows'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.ok(
        cronRes.stats.marketingFlowsProcessed >= 1,
        `Expected marketingFlowsProcessed >= 1 after 0.005m wait elapsed, got ${cronRes.stats.marketingFlowsProcessed}`
      );

      // Verify resumed at step3 ONLY (single completed enrollment, score still 30 not 40, tag 'resumed_ok' added)
      const flowDetail = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.equal(flowDetail.data.flow.enrolled_count, 1);
      assert.equal(flowDetail.data.flow.completed_count, 1);
      assert.equal(flowDetail.data.enrollments.length, 1);
      assert.equal(flowDetail.data.enrollments[0].status, 'completed');

      const contactsAfter = await harness.apiJson('/api/v1/audiences/contacts', { auth });
      const leadAfter = contactsAfter.data.items.find((c: any) => c.id === leadId);
      assert.equal(leadAfter.lead_score, 30, 'step1 must NOT re-execute on cron resume');
      assert.ok(
        Array.isArray(leadAfter.tags) && leadAfter.tags.some((t: any) => t.slug === 'resumed_ok' || t.name === 'resumed_ok'),
        'step3 tag "resumed_ok" must be applied upon resume'
      );
    });

    // [M1-REQ] True requirement: frontend canonical step-type aliases & field schema
    it('F2-T1-05: [M1-REQ] normalizes frontend step-type aliases & fields (condition, action, split_test, wait, update_tag, cfg, trueNextStepId, falseNextStepId)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const hotLeadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Alias Lead', email: 'alias@test.vn', phone: '0909123003', lead_score: 75 },
      });
      const hotLeadId = hotLeadRes.data.id;

      const coldLeadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Alias Cold Lead', email: 'alias-cold@test.vn', phone: '0909123013', lead_score: 20 },
      });
      const coldLeadId = coldLeadRes.data.id;

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Frontend Schema Flow',
          trigger_type: 'form_submitted',
          steps: [
            {
              id: 's_cond',
              type: 'condition',
              label: 'Frontend Condition',
              cfg: { field: 'lead_score', operator: 'gte', value: 50 },
              trueNextStepId: 's_action',
              falseNextStepId: 's_split',
            },
            {
              id: 's_action',
              type: 'action',
              label: 'Frontend Send Email',
              cfg: { subject: 'Welcome {{lead.name}}' },
            },
            {
              id: 's_split',
              type: 'split_test',
              label: 'Frontend Split Test',
              cfg: { ratio_a: 50 },
              pathAStepId: 's_wait',
              pathBStepId: 's_wait',
            },
            {
              id: 's_wait',
              type: 'wait',
              label: 'Frontend Wait',
              cfg: { duration: 0.005, unit: 'minutes' },
              nextStepId: 's_tag',
            },
            {
              id: 's_tag',
              type: 'update_tag',
              label: 'Frontend Tag',
              cfg: { tag: 'alias-false', mode: 'add' },
            },
          ],
        },
      });
      const flowId = flowRes.data.id;

      // 1. Hot lead (lead_score >= 50) takes trueNextStepId -> action ('send_email')
      harness.resetCaptures();
      const hotEnrollRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: hotLeadId, skip_wait_delay: true },
      });
      assert.equal(hotEnrollRes.status, 201);
      assert.equal(hotEnrollRes.json.data.status, 'completed');
      const hotTrace = hotEnrollRes.json.data.trace as Array<any>;
      const hotCondEntry = hotTrace.find((t) => t.step_id === 's_cond');
      assert.equal(hotCondEntry?.node_type, 'if_else_condition');
      assert.equal(hotCondEntry?.branch, 'yes', 'condition alias should evaluate cfg & take trueNextStepId');
      const actionEntry = hotTrace.find((t) => t.step_id === 's_action');
      assert.ok(actionEntry, 'trueNextStepId -> s_action should execute');
      assert.equal(actionEntry?.node_type, 'send_email');
      assert.ok(
        String(actionEntry?.outcome || '').includes('Đã gửi'),
        `Expected positive send_email outcome ("Đã gửi"), got "${actionEntry?.outcome}"`
      );
      assert.ok(harness.emailCapture.length >= 1, 'action alias must dispatch real email via emailCapture');
      assert.ok(
        harness.emailCapture.some((e) => e.to === 'alias@test.vn' && e.subject === 'Welcome Alias Lead'),
        `Expected emailCapture with subject "Welcome Alias Lead" to alias@test.vn, got ${JSON.stringify(harness.emailCapture)}`
      );
      assert.equal(
        hotTrace.some((t) => ['s_split', 's_wait', 's_tag'].includes(t.step_id)),
        false,
        'Hot lead must NOT execute falseNextStepId branch'
      );

      // 2. Cold lead (lead_score < 50) takes falseNextStepId -> split_test -> wait (pauses) -> cron resume -> update_tag
      const coldEnrollRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: coldLeadId, skip_wait_delay: false },
      });
      assert.equal(coldEnrollRes.status, 201);
      assert.equal(
        coldEnrollRes.json.data.status,
        'waiting',
        'wait alias must pause flow execution when skip_wait_delay is false'
      );
      const coldTrace = coldEnrollRes.json.data.trace as Array<any>;
      const coldCondEntry = coldTrace.find((t) => t.step_id === 's_cond');
      assert.equal(coldCondEntry?.node_type, 'if_else_condition');
      assert.equal(coldCondEntry?.branch, 'no', 'condition alias should take falseNextStepId for lead_score < 50');

      const splitEntry = coldTrace.find((t) => t.step_id === 's_split');
      assert.ok(splitEntry, 'falseNextStepId -> s_split (split_test alias) must execute');
      assert.equal(splitEntry?.node_type, 'ab_split');
      assert.ok(splitEntry?.branch === 'A' || splitEntry?.branch === 'B');

      const waitEntry = coldTrace.find((t) => t.step_id === 's_wait');
      assert.ok(waitEntry, 'split_test -> s_wait (wait alias) must execute');
      assert.equal(waitEntry?.node_type, 'wait_delay');
      assert.equal(coldTrace.some((t) => t.step_id === 's_action' || t.step_id === 's_tag'), false);

      // Wait 450ms (> 0.005m = 300ms) and resume via Master Cron -> executes s_tag (update_tag alias)
      await new Promise((r) => setTimeout(r, 450));
      const cronRes = await harness.triggerMasterCron(['marketing_flows'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.ok(cronRes.stats.marketingFlowsProcessed >= 1);

      const flowDetail = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      const coldEnrollment = (flowDetail.data.enrollments as Array<any>).find((e) => e.lead_id === coldLeadId);
      assert.ok(coldEnrollment, 'Expected cold lead enrollment in flow detail');
      assert.equal(coldEnrollment.status, 'completed');
      const resumedTrace = Array.isArray(coldEnrollment.execution_trace) ? coldEnrollment.execution_trace : [];
      const tagEntry = resumedTrace.find((t: any) => t.step_id === 's_tag');
      assert.ok(tagEntry, 'Resumed flow must execute s_tag (update_tag alias)');
      assert.equal(tagEntry?.node_type, 'add_remove_tag');
      assert.ok(String(tagEntry?.outcome || '').includes('alias-false'));

      const contactsAfter = await harness.apiJson('/api/v1/audiences/contacts', { auth });
      const coldLeadAfter = contactsAfter.data.items.find((c: any) => c.id === coldLeadId);
      assert.ok(
        Array.isArray(coldLeadAfter?.tags) &&
          coldLeadAfter.tags.some((t: any) => t.slug === 'alias-false' || t.name === 'alias-false'),
        'falseNextStepId -> update_tag must persist "alias-false" tag on second lead in DB'
      );
    });

    // [M1-REQ] True requirement: webhook_http & notify_internal real execution
    it('F2-T1-06: [M1-REQ] executes webhook_http (real HTTP POST) & notify_internal (real notification persistence)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const leadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Webhook Lead', email: 'webhooklead@test.vn', phone: '0909123004', lead_score: 90 },
      });
      const leadId = leadRes.data.id;

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Webhook & Internal Notify Flow',
          trigger_type: 'manual_enroll',
          steps: [
            {
              id: 'wh1',
              type: 'webhook_http',
              label: 'Outbound Hook',
              config: { url: harness.webhookSink.url, method: 'POST' },
              nextStepId: 'ni1',
            },
            {
              id: 'ni1',
              type: 'notify_internal',
              label: 'Alert Manager',
              config: {
                title: 'Hot Lead Alert',
                message: 'Lead {{lead.name}} is hot!',
                notify_email: 'ops-alert@e2em1.test',
              },
            },
          ],
        },
      });
      const flowId = flowRes.data.id;

      const enrollRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: leadId, skip_wait_delay: true },
      });
      assert.equal(enrollRes.status, 201);

      const deliveries = await harness.webhookSink.waitForDeliveries(1, 2000);
      assert.ok(deliveries.length >= 1, 'webhook_http must dispatch real HTTP POST to target url');
      assert.ok(
        deliveries[0].rawBody.includes(leadId) || deliveries[0].rawBody.includes('Webhook Lead'),
        'webhook_http payload must include lead details'
      );

      const niEntry = (enrollRes.json.data.trace as Array<any>).find((t) => t.step_id === 'ni1');
      assert.ok(niEntry);
      assert.equal(niEntry.node_type, 'notify_internal');
      assert.ok(
        String(niEntry.outcome || '').includes('Đã gửi thông báo nội bộ'),
        `Expected positive notify_internal outcome ("Đã gửi thông báo nội bộ"), got "${niEntry.outcome}"`
      );
      assert.ok(String(niEntry.outcome || '').includes('Hot Lead Alert'));
      assert.ok(
        harness.emailCapture.some(
          (e) =>
            e.to === 'ops-alert@e2em1.test' &&
            e.subject.includes('Hot Lead Alert') &&
            e.text.includes('Lead Webhook Lead is hot!')
        ),
        `notify_internal with notify_email must dispatch internal alert email, got ${JSON.stringify(harness.emailCapture)}`
      );

      const flowDetail = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      const persistedTrace = flowDetail.data.enrollments?.[0]?.execution_trace || [];
      const persistedNi = persistedTrace.find((t: any) => t.step_id === 'ni1');
      assert.ok(
        String(persistedNi?.outcome || '').includes('Đã gửi thông báo nội bộ'),
        'notify_internal execution trace must be persisted in mkt_flow_enrollments'
      );
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (5 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F2-T2-01: manual-trigger deduplicates leads when settings.re_entry_mode === "once"', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const leadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Once Lead', email: 'once@test.vn', phone: '0909123005' },
      });
      const leadId = leadRes.data.id;

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Once Entry Flow',
          trigger_type: 'manual_enroll',
          settings: { re_entry_mode: 'once' },
          steps: [{ id: 's1', type: 'update_lead_score', label: 'Score +5', config: { delta: 5 } }],
        },
      });
      const flowId = flowRes.data.id;

      const first = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/manual-trigger`, {
        method: 'POST',
        auth,
        body: { lead_ids: [leadId] },
      });
      assert.equal(first.status, 201);
      assert.equal(first.json.data.enrolled_count, 1);

      const second = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/manual-trigger`, {
        method: 'POST',
        auth,
        body: { lead_ids: [leadId] },
      });
      assert.equal(second.status, 201);
      assert.equal(second.json.data.enrolled_count, 0);
    });

    it('F2-T2-02: rejects whitespace flow name (422 FLOW_NAME_REQUIRED) & missing lead_id on enroll (422 LEAD_ID_REQUIRED)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const badFlow = await harness.apiRaw('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: { name: '   ' },
      });
      assert.equal(badFlow.status, 422);
      assert.equal(badFlow.json?.error?.code, 'FLOW_NAME_REQUIRED');

      const validFlow = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: { name: 'Valid Flow', steps: [] },
      });

      const badEnroll = await harness.apiRaw(`/api/v1/marketing/flows/${validFlow.data.id}/enroll`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(badEnroll.status, 422);
      assert.equal(badEnroll.json?.error?.code, 'LEAD_ID_REQUIRED');
    });

    it('F2-T2-03: returns 404 for nonexistent flow/snapshot and isolates foreign-tenant leads', async () => {
      const tenantA = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const tenantB = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const missingUuid = '00000000-0000-4000-8000-000000000099';

      const getMissing = await harness.apiRaw(`/api/v1/marketing/flows/${missingUuid}`, { auth: tenantA });
      assert.equal(getMissing.status, 404);
      assert.equal(getMissing.json?.error?.code, 'FLOW_NOT_FOUND');

      const flowA = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'Tenant A Flow', steps: [] },
      });

      const snapMissing = await harness.apiRaw(`/api/v1/marketing/flows/${flowA.data.id}/restore-snapshot`, {
        method: 'POST',
        auth: tenantA,
        body: { snapshot_id: missingUuid },
      });
      assert.equal(snapMissing.status, 404);
      assert.equal(snapMissing.json?.error?.code, 'SNAPSHOT_NOT_FOUND');

      const leadB = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth: tenantB,
        body: { name: 'Tenant B Lead', email: 'leadb@test.vn', phone: '0909123006' },
      });

      const crossEnroll = await harness.apiRaw(`/api/v1/marketing/flows/${flowA.data.id}/enroll`, {
        method: 'POST',
        auth: tenantA,
        body: { lead_id: leadB.data.id },
      });
      assert.equal(crossEnroll.status, 404);
      assert.equal(crossEnroll.json?.error?.code, 'FLOW_OR_LEAD_NOT_FOUND');
    });

    it('F2-T2-04: terminates cyclic step graphs safely via visited guard without hanging', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const leadRes = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Cycle Lead', email: 'cycle@test.vn', phone: '0909123007' },
      });

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Cyclic Flow',
          trigger_type: 'manual_enroll',
          steps: [
            { id: 'stepA', type: 'update_lead_score', label: 'A', config: { delta: 1 }, nextStepId: 'stepB' },
            { id: 'stepB', type: 'update_lead_score', label: 'B', config: { delta: 1 }, nextStepId: 'stepA' },
          ],
        },
      });
      const flowId = flowRes.data.id;

      const simRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/simulate`, {
        method: 'POST',
        auth,
        body: { sample_lead: { lead_score: 0 } },
      });
      assert.equal(simRes.status, 200);
      assert.equal(simRes.json.data.trace.length, 2);

      const enrollRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: leadRes.data.id, skip_wait_delay: true },
      });
      assert.equal(enrollRes.status, 201);
      assert.equal(enrollRes.json.data.trace.length, 2);
      assert.equal(enrollRes.json.data.status, 'completed');
    });

    // [M1-REQ] True requirement: wait_delay pauses by default even when pause_execution is omitted, and respects cfg.unit='minutes'
    it('F2-T2-05: [M1-REQ] wait_delay pauses by default (pause_execution omitted) with cfg.unit=minutes vs skip_wait_delay=true', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const lead1 = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Default Wait Lead 1', email: 'wait1@test.vn', phone: '0909123008', lead_score: 10 },
      });
      const lead2 = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Default Wait Lead 2', email: 'wait2@test.vn', phone: '0909123009', lead_score: 10 },
      });

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Default Wait Pause Flow',
          trigger_type: 'manual_enroll',
          steps: [
            {
              id: 'w1',
              type: 'wait_delay',
              label: 'Wait 5 minutes',
              config: { duration: 5, unit: 'minutes' },
              nextStepId: 'sc1',
            },
            { id: 'sc1', type: 'update_lead_score', label: 'Score +5', config: { delta: 5 } },
          ],
        },
      });
      const flowId = flowRes.data.id;

      const beforePauseMs = Date.now();
      const pausedEnroll = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: lead1.data.id, skip_wait_delay: false },
      });
      assert.equal(pausedEnroll.status, 201);
      assert.equal(pausedEnroll.json.data.status, 'waiting', 'wait_delay should pause by default when skip_wait_delay is false');

      // Check wait outcome timestamp is ~5 minutes ahead (not 5 hours ahead)
      const waitOutcome = String(pausedEnroll.json.data.trace?.[0]?.outcome || '');
      const isoMatch = waitOutcome.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
      assert.ok(isoMatch, `Expected wait_delay outcome to contain ISO timestamp, got "${waitOutcome}"`);
      const scheduledMs = Date.parse(isoMatch[0]);
      const deltaMs = scheduledMs - beforePauseMs;
      assert.ok(
        deltaMs >= 60_000 && deltaMs <= 15 * 60_000,
        `Expected ~5 minutes delay (60s..15m), got ${Math.round(deltaMs / 1000)}s`
      );

      const skippedEnroll = await harness.apiRaw(`/api/v1/marketing/flows/${flowId}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: lead2.data.id, skip_wait_delay: true },
      });
      assert.equal(skippedEnroll.status, 201);
      assert.equal(skippedEnroll.json.data.status, 'completed');
    });
  });
});
