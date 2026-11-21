import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness, type TenantAuthContext } from './_harness.ts';

let harness: MarketingE2eHarness;

async function setupCapiVault(
  auth: TenantAuthContext,
  opts?: { datasetId?: string; accessToken?: string; testEventCode?: string }
): Promise<void> {
  const res = await harness.apiJson('/api/v1/integrations/vault/meta_capi', {
    method: 'PUT',
    auth,
    body: {
      dataset_id: opts?.datasetId ?? '998877665544',
      access_token: opts?.accessToken ?? 'EAA_e2e_live_meta_capi_token_1234567890abcdef',
      live_http_enabled: true,
      test_event_code: opts?.testEventCode ?? 'TEST_E2E_08',
    },
  });
  assert.equal(res.data.integration_type, 'meta_capi');
}

async function getDefaultPipelineAndStages(auth: TenantAuthContext): Promise<{
  pipelineId: string;
  leadStage: any;
  scheduleStage: any;
  wonStage: any;
}> {
  const res = await harness.apiJson('/api/v1/pipelines', { auth });
  const pipelines: any[] = res.data || [];
  const defaultPipeline = pipelines.find((p) => p.is_default) || pipelines[0];
  assert.ok(defaultPipeline, 'Expected seeded default pipeline');
  const stages: any[] = defaultPipeline.stages || [];
  const leadStage =
    stages.find((s) => s.capi_event_mapping === 'Lead') || stages[0];
  const scheduleStage =
    stages.find((s) => s.capi_event_mapping === 'Schedule') ||
    stages.find((s) => !s.is_won_stage && !s.is_lost_stage && s.id !== leadStage?.id) ||
    stages[1];
  const wonStage =
    stages.find((s) => Boolean(s.is_won_stage)) ||
    stages.find((s) => s.capi_event_mapping === 'Purchase');
  assert.ok(leadStage, 'Expected lead stage');
  assert.ok(scheduleStage, 'Expected schedule stage');
  assert.ok(wonStage, 'Expected won stage');
  return {
    pipelineId: String(defaultPipeline.id),
    leadStage,
    scheduleStage,
    wonStage,
  };
}

function signHmac(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function signHmacHex(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 2000,
  intervalMs = 50
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

describe('Feature 8: Cross-App Triggers, Meta CAPI & CRM Sync (E2E)', () => {
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
    it('F8-T1-01: push_to_autodata_sale_round Flow node & POST /api/v1/audiences/:id/push-to-sale promote nurture contacts to CRM Sale Round', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });

      // Seed an active online sale consultant so runUnassignedLeadDrainer immediately assigns drained leads
      const saleUserRes = await harness.apiJson('/api/v1/users', {
        method: 'POST',
        auth,
        body: {
          full_name: 'Sale Round Receiver',
          email: `sale.round.${Date.now()}@${auth.tenantSlug}.vn`,
          password: 'SalePassword123!',
          role: 'sale',
          is_available: true,
        },
      });
      const saleUserId = String(saleUserRes.data.id);
      assert.ok(saleUserId);

      // Part A: Flow node push_to_autodata_sale_round
      const contactA = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Nurture Flow Lead',
          phone: '0909444001',
          email: 'nurture.flow@test.vn',
          status: 'marketing_nurture',
        },
      });
      const leadAId = contactA.data.id;
      assert.equal(contactA.data.status, 'marketing_nurture');

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Push To Sale Round Flow',
          status: 'active',
          trigger_type: 'manual_enroll',
          steps: [
            {
              id: 'push1',
              type: 'push_to_autodata_sale_round',
              label: 'Push Sale',
              config: {},
            },
          ],
        },
      });

      const enrollRes = await harness.apiRaw(`/api/v1/marketing/flows/${flowRes.data.id}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: leadAId },
      });
      assert.equal(enrollRes.status, 201);
      assert.equal(enrollRes.json?.data?.promotedToSaleRound, true);
      assert.equal(enrollRes.json?.data?.status, 'completed');

      const leadsSearch = await harness.apiJson('/api/v1/leads', {
        auth,
        query: { search: 'nurture.flow@test.vn' },
      });
      const promotedLeadA = (leadsSearch.data?.items || []).find((l: any) => l.id === leadAId);
      assert.ok(promotedLeadA, 'Expected promoted leadA in CRM leads');
      assert.equal(promotedLeadA.status, 'assigned');
      assert.ok(promotedLeadA.pipeline_id);
      assert.ok(promotedLeadA.stage?.id);
      assert.equal(promotedLeadA.assigned_sale?.id, saleUserId);

      const tlRes = await harness.apiJson(`/api/v1/leads/${leadAId}/timeline`, { auth });
      assert.ok(
        (tlRes.data?.items || tlRes.data || []).some((e: any) => e.event_type === 'pushed_to_sale_round'),
        'Expected pushed_to_sale_round timeline event'
      );

      // Part B: Audience bulk push-to-sale
      const contactB = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Nurture Audience Lead',
          phone: '0909444002',
          email: 'nurture.aud@test.vn',
          status: 'marketing_nurture',
        },
      });
      const leadBId = contactB.data.id;

      const audRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Push Sale Audience',
          audience_type: 'static_data',
          lead_ids: [leadBId],
        },
      });
      const pushRes = await harness.apiJson(`/api/v1/audiences/${audRes.data.id}/push-to-sale`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(pushRes.data.promoted_count, 1);
      assert.ok(pushRes.data.promoted_lead_ids.includes(leadBId));
      assert.ok(pushRes.data.immediately_assigned_count >= 1);
    });

    it('F8-T1-02: lead.stage_changed triggers active Flow (stage_changed), Meta CAPI Stage Event & Outbound Webhook Sink', async () => {
      const auth = await harness.registerTenant({
        packageCode: 'growth_combo',
        industry: 'real_estate',
        seedDemoLeads: false,
      });
      await setupCapiVault(auth);
      const { scheduleStage } = await getDefaultPipelineAndStages(auth);

      const whRes = await harness.apiJson('/api/v1/integrations/webhooks', {
        method: 'POST',
        auth,
        body: {
          name: 'Stage Sink',
          webhook_type: 'outbound',
          url: harness.webhookSink.url,
          subscribed_events: ['lead.stage_changed'],
          is_active: true,
        },
      });
      const signingSecret = String(whRes.data.signing_secret || '');
      assert.ok(signingSecret);

      // Ensure marketing router is hit so registerFlowEventListeners() is active
      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Stage Changed Tag Flow',
          status: 'active',
          trigger_type: 'stage_changed',
          steps: [
            {
              id: 't1',
              type: 'add_remove_tag',
              label: 'Tag Stage Triggered',
              config: { tag: 'stage-triggered', mode: 'add' },
            },
          ],
        },
      });
      const flowId = flowRes.data.id;

      const leadRes = await harness.apiJson('/api/v1/leads', {
        method: 'POST',
        auth,
        body: {
          name: 'Trần Stage CAPI',
          phone: '0909555001',
          email: 'stage@test.vn',
          fbclid: 'fb_e2e_123',
        },
      });
      const leadId = leadRes.data.id || leadRes.data.lead_id;
      assert.ok(leadId);

      const stageRes = await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
        method: 'PATCH',
        auth,
        body: {
          stage_id: scheduleStage.id,
          note: 'Booked visit',
        },
      });
      assert.equal(stageRes.data.current_stage, scheduleStage.stage_key);
      assert.equal(stageRes.data.capi_dispatched?.event_name, 'Schedule');
      assert.equal(stageRes.data.capi_dispatched?.status, 200);

      const capiMatch = harness.capiCapture.find((c) => {
        const events = Array.isArray((c.payload as any)?.data) ? (c.payload as any).data : [];
        return events.some((ev: any) => ev.event_name === 'Schedule');
      });
      assert.ok(capiMatch, 'Expected Meta CAPI Schedule event in capiCapture');
      const capiEv = ((capiMatch!.payload as any).data as any[]).find((ev) => ev.event_name === 'Schedule');
      assert.ok(Array.isArray(capiEv.user_data?.ph) && capiEv.user_data.ph.length >= 1);
      assert.ok(Array.isArray(capiEv.user_data?.em) && capiEv.user_data.em.length >= 1);
      assert.ok(String(capiEv.user_data?.fbc || '').includes('fb_e2e_123'));

      const deliveries = await harness.webhookSink.waitForDeliveries(1, 3000);
      const stageDelivery = deliveries.find((d) => d.headers['x-autodata-event'] === 'lead.stage_changed');
      assert.ok(stageDelivery, 'Expected outbound lead.stage_changed webhook delivery');
      assert.equal(stageDelivery!.json?.lead_id, leadId);
      const expectedSig = signHmacHex(stageDelivery!.rawBody, signingSecret);
      assert.equal(stageDelivery!.headers['x-autodata-signature-256'], expectedSig);

      const flowDetail = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.ok(
        (flowDetail.data.enrollments || []).some((e: any) => e.lead_id === leadId && e.status === 'completed'),
        'Expected active stage_changed flow to enroll and complete leadId'
      );

      const contactsRes = await harness.apiJson('/api/v1/audiences/contacts', {
        auth,
        query: { search: 'stage@test.vn' },
      });
      const contactRow = (contactsRes.data?.items || []).find((c: any) => c.id === leadId);
      assert.ok(contactRow?.tags?.some((t: any) => t.slug === 'stage-triggered' || t.name === 'stage-triggered'));
    });

    it('F8-T1-03: deal.won triggers Win-Flow (purchase_event) & Meta CAPI Purchase with Deal Value across Pipeline Won & CRM-360 Deal', async () => {
      const auth = await harness.registerTenant({
        packageCode: 'domation_promax',
        industry: 'real_estate',
        seedDemoLeads: false,
      });
      await setupCapiVault(auth);
      const { wonStage } = await getDefaultPipelineAndStages(auth);

      const winFlowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Deal Won VIP Flow',
          status: 'active',
          trigger_type: 'purchase_event',
          steps: [
            { id: 'score1', type: 'update_lead_score', label: 'Win +30', config: { delta: 30 } },
            { id: 'tag1', type: 'add_remove_tag', label: 'VIP Tag', config: { tag: 'won-vip', mode: 'add' } },
          ],
        },
      });
      const winFlowId = winFlowRes.data.id;

      // Part A: Pipeline Won Stage
      const lead1Res = await harness.apiJson('/api/v1/leads', {
        method: 'POST',
        auth,
        body: {
          name: 'Pipeline Won Buyer',
          phone: '0909666001',
          email: 'won.pipeline@test.vn',
        },
      });
      const lead1Id = lead1Res.data.id || lead1Res.data.lead_id;

      const stageWonRes = await harness.apiJson(`/api/v1/leads/${lead1Id}/stage`, {
        method: 'PATCH',
        auth,
        body: {
          stage_id: wonStage.id,
          deal_value_vnd: 125_000_000,
          note: 'Closed pipeline deal',
        },
      });
      assert.equal(stageWonRes.data.capi_dispatched?.event_name, 'Purchase');
      assert.equal(stageWonRes.data.capi_dispatched?.value, 125_000_000);
      assert.equal(stageWonRes.data.capi_dispatched?.currency, 'VND');

      const purchaseCapi = harness.capiCapture.find((c) => {
        const evs = Array.isArray((c.payload as any)?.data) ? (c.payload as any).data : [];
        return evs.some((ev: any) => ev.event_name === 'Purchase' && ev.custom_data?.value === 125_000_000);
      });
      assert.ok(purchaseCapi, 'Expected Purchase CAPI capture with custom_data.value === 125_000_000');

      const winDetailA = await harness.apiJson(`/api/v1/marketing/flows/${winFlowId}`, { auth });
      assert.ok(
        (winDetailA.data.enrollments || []).some((e: any) => e.lead_id === lead1Id),
        'Expected purchase_event flow enrollment for pipeline won lead'
      );

      const leadsAfterWin = await harness.apiJson('/api/v1/leads', {
        auth,
        query: { search: 'won.pipeline@test.vn' },
      });
      const lead1Row = (leadsAfterWin.data?.items || []).find((l: any) => l.id === lead1Id);
      assert.equal(lead1Row?.total_revenue_vnd, 125_000_000);

      // Part B: CRM-360 Deal Won
      const lead2Res = await harness.apiJson('/api/v1/leads', {
        method: 'POST',
        auth,
        body: {
          name: 'CRM Deal Won Buyer',
          phone: '0909666002',
          email: 'won.deal@test.vn',
        },
      });
      const lead2Id = lead2Res.data.id || lead2Res.data.lead_id;

      const dealRes = await harness.apiJson('/api/v1/crm-360/deals', {
        method: 'POST',
        auth,
        body: {
          title: 'Enterprise Deal E2E',
          lead_id: lead2Id,
          amount_vnd: 50_000_000,
        },
      });
      const dealId = dealRes.data.id;
      assert.ok(dealId);

      await harness.apiJson(`/api/v1/crm-360/deals/${dealId}/stage`, {
        method: 'PATCH',
        auth,
        body: { stage: 'won' },
      });

      const enrolledLead2 = await pollUntil(async () => {
        const d = await harness.apiJson(`/api/v1/marketing/flows/${winFlowId}`, { auth });
        return (d.data.enrollments || []).find((e: any) => e.lead_id === lead2Id) || null;
      }, 2500);
      assert.ok(enrolledLead2, 'Expected purchase_event win-flow enrollment from CRM-360 deal.won');
    });

    it('F8-T1-04: CAPI test-event & failed 429/500/503 capi_logs recovery via /integrations/capi/retry/:logId + master cron capi execution', async () => {
      const auth = await harness.registerTenant({
        packageCode: 'growth_combo',
        industry: 'real_estate',
        seedDemoLeads: false,
      });
      await setupCapiVault(auth);
      const { scheduleStage } = await getDefaultPipelineAndStages(auth);

      // Part A: CAPI Test Event
      const testRes = await harness.apiJson('/api/v1/integrations/capi/test-event', {
        method: 'POST',
        auth,
        body: {
          event_name: 'Lead',
          test_event_code: 'TEST69201',
          deal_value_vnd: 50_000_000,
        },
      });
      assert.equal(testRes.data.events_received, 1);
      assert.equal(typeof testRes.data.hashes_sent?.ph, 'string');
      assert.equal(testRes.data.hashes_sent.ph.length, 64);
      assert.equal(typeof testRes.data.hashes_sent?.em, 'string');
      assert.equal(testRes.data.hashes_sent.em.length, 64);
      assert.ok(
        harness.capiCapture.some((c) => (c.payload as any)?.test_event_code === 'TEST69201'),
        'Expected test_event_code TEST69201 in capiCapture'
      );

      // Part B: Trigger real 429, 500, and 503 failures -> inspect capi_logs via /overview -> recover each via /retry/:logId
      const retryableStatuses = [429, 500, 503] as const;
      const failedCases: Array<{ status: number; leadId: string; logId: string }> = [];

      for (const status of retryableStatuses) {
        const leadRes = await harness.apiJson('/api/v1/leads', {
          method: 'POST',
          auth,
          body: {
            name: `CAPI Retry Lead ${status}`,
            phone: `0909777${status}`,
            email: `capiretry.${status}@test.vn`,
          },
        });
        const leadId = leadRes.data.id || leadRes.data.lead_id;

        try {
          harness.mockFetch.setFailureMode({
            metaCapiStatus: status,
            metaErrorMessage: `Meta CAPI ${status} Error`,
          });
          const failStageRes = await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
            method: 'PATCH',
            auth,
            body: { stage_id: scheduleStage.id },
          });
          assert.equal(failStageRes.data.capi_dispatched?.status, status);
        } finally {
          harness.mockFetch.resetFailureModes();
        }

        const overviewBefore = await harness.apiJson('/api/v1/integrations/overview', { auth });
        const failedLog = (overviewBefore.data.capi_logs || []).find(
          (l: any) => l.lead_id === leadId && Number(l.response_status) === status
        );
        assert.ok(failedLog?.id, `Expected ${status} capi_logs entry in /integrations/overview`);
        failedCases.push({ status, leadId, logId: String(failedLog.id) });
      }

      for (const item of failedCases) {
        const retryRes = await harness.apiJson(`/api/v1/integrations/capi/retry/${item.logId}`, {
          method: 'POST',
          auth,
          body: {},
        });
        assert.equal(retryRes.data.retried, true);
        assert.equal(retryRes.data.meta_http_status, 200);
      }

      const overviewAfter = await harness.apiJson('/api/v1/integrations/overview', { auth });
      for (const item of failedCases) {
        assert.ok(
          (overviewAfter.data.capi_logs || []).some(
            (l: any) => l.lead_id === item.leadId && Number(l.response_status) === 200
          ),
          `Expected recovered 200 capi_logs entry after /retry/:logId for status ${item.status}`
        );
      }

      // Verify master cron ['capi'] executes cleanly with zero errors.
      // Note: capi-retry.ts:28 enforces `sent_at <= clock_timestamp() - INTERVAL '3 minutes'`,
      // so >3m-aged Master Cron retry pickup (429/500/503), 400 exclusion, retry_count < 5 cap,
      // and 24h window require aged timestamps covered in white-box Tier 5 / concurrency-m2-fairness.test.ts.
      const cronRes = await harness.triggerMasterCron(['capi'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.deepEqual(cronRes.stats.errors || [], []);
    });

    // [M2-REQ] True requirement: POST /api/v1/myerp/contacts/match-domation-sync must perform real
    // Match-Only synchronization (non-zero matched counts, zero new leads created) instead of { matched: 0, synced: 0 }.
    it('F8-T1-05: [M2-REQ] CRM Sync Bridge (match-domation-sync Match-Only) & /audiences/:id/evaluate (sync_data + dynamic_logic)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });

      const c1Res = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Sync Match Lead',
          phone: '0909123789',
          email: 'sync.match@test.vn',
          lead_score: 50,
          status: 'marketing_nurture',
        },
      });
      const c1Id = c1Res.data.id;

      // Part A: sync_data & dynamic_logic audience evaluation + audience_joined flow trigger
      const syncAudRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'CRM Sync Data Audience',
          audience_type: 'sync_data',
          lead_ids: [c1Id],
          sync_config: { crm_source: 'autodata' },
        },
      });
      const syncEval = await harness.apiJson(`/api/v1/audiences/${syncAudRes.data.id}/evaluate`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(syncEval.data.total_count, 1);

      const joinFlowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Audience Joined Sync Flow',
          status: 'active',
          trigger_type: 'audience_joined',
          steps: [
            { id: 'tag_j1', type: 'add_remove_tag', label: 'Tag Hot', config: { tag: 'hot-sync', mode: 'add' } },
          ],
        },
      });

      const dynAudRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'High Score Dynamic Sync',
          audience_type: 'dynamic_logic',
          auto_push_to_sale_round: true,
          filter_branches: [
            {
              logic: 'AND',
              rules: [{ field: 'lead_score', operator: 'gte', value: 80 }],
            },
          ],
        },
      });
      assert.equal(dynAudRes.data.cached_member_count, 0);

      // Raise c1 lead_score from 50 -> 90 via flow update_lead_score before calling /evaluate
      const manualEnrollFlow = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Activity Flow For Match Sync',
          status: 'active',
          trigger_type: 'manual_enroll',
          steps: [{ id: 's1', type: 'update_lead_score', label: 'Score +40', config: { delta: 40 } }],
        },
      });
      await harness.apiJson(`/api/v1/marketing/flows/${manualEnrollFlow.data.id}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: c1Id },
      });

      // Evaluate dynamic_logic audience so c1 genuinely transitions in, promotes to sale round, and triggers joinFlow
      const dynEval = await harness.apiJson(`/api/v1/audiences/${dynAudRes.data.id}/evaluate`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.ok(dynEval.data.entered_count >= 1, `Expected entered_count >= 1 on /evaluate, got ${dynEval.data.entered_count}`);
      assert.ok((dynEval.data.entered_lead_ids || []).includes(c1Id));
      assert.ok(dynEval.data.pushed_to_sale_count >= 1, `Expected pushed_to_sale_count >= 1, got ${dynEval.data.pushed_to_sale_count}`);
      assert.ok(dynEval.data.total_count >= 1);

      const joinDetail = await harness.apiJson(`/api/v1/marketing/flows/${joinFlowRes.data.id}`, { auth });
      assert.ok(
        (joinDetail.data.enrollments || []).some((e: any) => e.lead_id === c1Id && e.status === 'completed'),
        'Expected audience_joined flow enrollment completed for c1Id'
      );

      const contactsAfterEval = await harness.apiJson('/api/v1/audiences/contacts', {
        auth,
        query: { search: 'sync.match@test.vn' },
      });
      const c1AfterEval = (contactsAfterEval.data?.items || []).find((c: any) => c.id === c1Id);
      assert.ok(
        c1AfterEval?.tags?.some((t: any) => t.slug === 'hot-sync' || t.name === 'hot-sync'),
        'Expected hot-sync tag applied to contact by audience_joined flow'
      );

      // Part B: [M2-REQ] Real Match-Only sync via /api/v1/myerp/contacts/match-domation-sync
      const leadsBefore = await harness.apiJson('/api/v1/leads', { auth });
      const totalBefore = Number(leadsBefore.data?.pagination?.total ?? leadsBefore.data?.items?.length ?? 0);

      const syncBridgeRes = await harness.apiJson('/api/v1/myerp/contacts/match-domation-sync', {
        method: 'POST',
        auth,
        body: {},
      });
      const syncData = syncBridgeRes.data || {};
      const totalMatched =
        Number(syncData.matched_subscribers ?? 0) +
        Number(syncData.matched_activities ?? 0) +
        Number(syncData.matched_flows ?? 0) +
        Number(syncData.matched_visitors ?? 0);

      assert.ok(
        totalMatched >= 1,
        `Expected real Match-Only sync counts >= 1 (matched_subscribers/activities/flows/visitors), got: ${JSON.stringify(syncData)}`
      );
      assert.equal(typeof syncData.unmatched_skipped, 'number');

      const leadsAfter = await harness.apiJson('/api/v1/leads', { auth });
      const totalAfter = Number(leadsAfter.data?.pagination?.total ?? leadsAfter.data?.items?.length ?? 0);
      assert.equal(totalAfter, totalBefore, 'Match-Only sync must never create new CRM leads');
    });

    it('F8-T1-06: Inbound webhook with valid HMAC-SHA256 enforces signature, ingests lead & fires outbound lead.created sink', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });

      const inWh = await harness.apiJson('/api/v1/integrations/webhooks', {
        method: 'POST',
        auth,
        body: {
          name: 'Strict HMAC Inbound',
          webhook_type: 'inbound',
          field_mappings: { _enforce_hmac: true },
          is_active: true,
        },
      });
      const inboundToken = String(inWh.data.token);
      const inboundSecret = String(inWh.data.signing_secret);
      assert.ok(inboundToken && inboundSecret);

      const outWh = await harness.apiJson('/api/v1/integrations/webhooks', {
        method: 'POST',
        auth,
        body: {
          name: 'Lead Created Sink',
          webhook_type: 'outbound',
          url: harness.webhookSink.url,
          subscribed_events: ['lead.created'],
          is_active: true,
        },
      });
      const outboundSecret = String(outWh.data.signing_secret);

      const rawPayload = JSON.stringify({
        name: 'Inbound HMAC Lead',
        phone: '0909888111',
        email: 'hmac.ok@test.vn',
      });
      const sig = signHmac(rawPayload, inboundSecret);

      const ingestRes = await harness.apiRaw(`/api/v1/webhooks/${auth.tenantSlug}/${inboundToken}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': sig,
          'X-Idempotency-Key': 'idem-t1-06',
        },
        body: rawPayload,
      });
      assert.equal(ingestRes.status, 202);
      assert.equal(ingestRes.json?.status, 'ENQUEUED');
      const createdLeadId = ingestRes.json?.lead_id;
      assert.ok(createdLeadId);

      const deliveries = await harness.webhookSink.waitForDeliveries(1, 3000);
      const createdDelivery = deliveries.find((d) => d.headers['x-autodata-event'] === 'lead.created');
      assert.ok(createdDelivery, 'Expected outbound lead.created delivery');
      assert.equal(createdDelivery!.json?.lead_id, createdLeadId);
      assert.equal(
        createdDelivery!.headers['x-autodata-signature-256'],
        signHmacHex(createdDelivery!.rawBody, outboundSecret)
      );
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (6 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F8-T2-01: Inbound webhook rejects missing, invalid & tampered HMAC signatures (401 INVALID_WEBHOOK_SIGNATURE)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });

      const inWh = await harness.apiJson('/api/v1/integrations/webhooks', {
        method: 'POST',
        auth,
        body: {
          name: 'Enforced HMAC Inbound',
          webhook_type: 'inbound',
          field_mappings: { _enforce_hmac: true },
          is_active: true,
        },
      });
      const token = String(inWh.data.token);
      const secret = String(inWh.data.signing_secret);
      const url = `/api/v1/webhooks/${auth.tenantSlug}/${token}`;

      const bodyA = JSON.stringify({ name: 'Bad Sig', phone: '0909000111' });

      // 1. Missing X-Webhook-Signature
      const rMissing = await harness.apiRaw(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyA,
      });
      assert.equal(rMissing.status, 401);
      assert.equal(rMissing.json?.error?.code, 'INVALID_WEBHOOK_SIGNATURE');

      // 2. Wrong signature
      const rWrong = await harness.apiRaw(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${'0'.repeat(64)}`,
        },
        body: bodyA,
      });
      assert.equal(rWrong.status, 401);
      assert.equal(rWrong.json?.error?.code, 'INVALID_WEBHOOK_SIGNATURE');

      // 3. Tampered body with signature computed for bodyA
      const sigForA = signHmac(bodyA, secret);
      const bodyB = JSON.stringify({ name: 'Tampered', phone: '0909000222' });
      const rTampered = await harness.apiRaw(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': sigForA,
        },
        body: bodyB,
      });
      assert.equal(rTampered.status, 401);
      assert.equal(rTampered.json?.error?.code, 'INVALID_WEBHOOK_SIGNATURE');

      const leads = await harness.apiJson('/api/v1/leads', { auth });
      assert.equal(leads.data?.items?.length ?? 0, 0);
    });

    it('F8-T2-02: Inbound webhook 24h X-Idempotency-Key & canonical payload deduplication (200 DUPLICATE_SKIPPED)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });
      const overview = await harness.apiJson('/api/v1/integrations/overview', { auth });
      const inboundWh = (overview.data.webhooks || []).find((w: any) => w.webhook_type === 'inbound');
      assert.ok(inboundWh?.token);
      const url = `/api/v1/webhooks/${auth.tenantSlug}/${inboundWh.token}`;

      // 1. X-Idempotency-Key dedup
      const r1 = await harness.apiRaw(url, {
        method: 'POST',
        headers: { 'X-Idempotency-Key': 'key-24h-01' },
        body: { name: 'Idem Key 1', phone: '0909777001' },
      });
      assert.equal(r1.status, 202);
      assert.equal(r1.json?.status, 'ENQUEUED');

      const r1Dup = await harness.apiRaw(url, {
        method: 'POST',
        headers: { 'X-Idempotency-Key': 'key-24h-01' },
        body: { name: 'Different Payload Same Key', phone: '0909777099' },
      });
      assert.equal(r1Dup.status, 200);
      assert.equal(r1Dup.json?.status, 'DUPLICATE_SKIPPED');

      // 2. Canonical payload dedup (ignoring volatile timestamp)
      const r2 = await harness.apiRaw(url, {
        method: 'POST',
        body: { name: 'Idem Canonical', phone: '0909777002', timestamp: 't1' },
      });
      assert.equal(r2.status, 202);
      assert.equal(r2.json?.status, 'ENQUEUED');

      const r2Dup = await harness.apiRaw(url, {
        method: 'POST',
        body: { name: 'Idem Canonical', phone: '0909777002', timestamp: 't2' },
      });
      assert.equal(r2Dup.status, 200);
      assert.equal(r2Dup.json?.status, 'DUPLICATE_SKIPPED');

      const leads = await harness.apiJson('/api/v1/leads', { auth });
      assert.equal(leads.data?.items?.length, 2);
    });

    // Note: capi-retry.ts:28 enforces `sent_at <= clock_timestamp() - INTERVAL '3 minutes'`, so testing
    // >3m-aged 400 exclusion, 429/500/503 cron pickup, retry_count < 5 cap, and 24h window is covered
    // in white-box Tier 5 / concurrency-m2-fairness.test.ts.
    it('F8-T2-03: logs non-retryable 400 CAPI failure, runs master cron capi cleanly & isolates retry/:logId across tenants', async () => {
      const tenantA = await harness.registerTenant({
        packageCode: 'growth_combo',
        industry: 'real_estate',
        seedDemoLeads: false,
      });
      const tenantB = await harness.registerTenant({
        packageCode: 'growth_combo',
        industry: 'real_estate',
        seedDemoLeads: false,
      });
      await setupCapiVault(tenantA);
      const { scheduleStage } = await getDefaultPipelineAndStages(tenantA);

      const leadRes = await harness.apiJson('/api/v1/leads', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'NonRetry 400 Lead', phone: '0909222333', email: 'capi400@test.vn' },
      });
      const leadId = leadRes.data.id || leadRes.data.lead_id;

      try {
        harness.mockFetch.setFailureMode({
          metaCapiStatus: 400,
          metaErrorCode: 100,
          metaErrorMessage: 'Invalid parameter',
        });
        const stageRes = await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
          method: 'PATCH',
          auth: tenantA,
          body: { stage_id: scheduleStage.id },
        });
        assert.equal(stageRes.data.capi_dispatched?.status, 400);
      } finally {
        harness.mockFetch.resetFailureModes();
      }

      const overviewA = await harness.apiJson('/api/v1/integrations/overview', { auth: tenantA });
      const log400 = (overviewA.data.capi_logs || []).find(
        (l: any) => l.lead_id === leadId && Number(l.response_status) === 400
      );
      assert.ok(log400?.id, 'Expected 400 capi_logs entry in /integrations/overview');
      assert.equal(Number(log400.response_status), 400);

      const cronRes = await harness.triggerMasterCron(['capi'], tenantA.tenantId);
      assert.equal(cronRes.status, 200);
      assert.deepEqual(cronRes.stats.errors || [], []);

      const crossRetry = await harness.apiRaw(`/api/v1/integrations/capi/retry/${log400.id}`, {
        method: 'POST',
        auth: tenantB,
        body: {},
      });
      assert.equal(crossRetry.status, 404);
      assert.equal(crossRetry.json?.error?.code, 'CAPI_LOG_NOT_FOUND');
    });

    it('F8-T2-04: returns 404 CAPI_LOG_NOT_FOUND & 404 AUDIENCE_NOT_FOUND on nonexistent UUIDs', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });
      const missingUuid = '00000000-0000-4000-8000-000000000099';

      const capiRes = await harness.apiRaw(`/api/v1/integrations/capi/retry/${missingUuid}`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(capiRes.status, 404);
      assert.equal(capiRes.json?.error?.code, 'CAPI_LOG_NOT_FOUND');

      const audRes = await harness.apiRaw(`/api/v1/audiences/${missingUuid}/push-to-sale`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(audRes.status, 404);
      assert.equal(audRes.json?.error?.code, 'AUDIENCE_NOT_FOUND');
    });

    // Note: PUT /integrations/vault/meta_capi & /myerp/meta/capi-config permit settings:manage_config/view
    // on marketing_standalone, whereas CAPI operational endpoints require ads_capi / integrations_crm.
    it('F8-T2-05: rejects CAPI test-event & retry on unentitled marketing_standalone (403 MODULE_NOT_ENTITLED) & CAPI vault/test-event on sale user (403 FORBIDDEN_RBAC_PERMISSION)', async () => {
      const standaloneAuth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const missingUuid = '00000000-0000-4000-8000-000000000099';

      const unentitledTest = await harness.apiRaw('/api/v1/integrations/capi/test-event', {
        method: 'POST',
        auth: standaloneAuth,
        body: { event_name: 'Lead' },
      });
      assert.equal(unentitledTest.status, 403);
      assert.equal(unentitledTest.json?.error?.code, 'MODULE_NOT_ENTITLED');

      const unentitledRetry = await harness.apiRaw(`/api/v1/integrations/capi/retry/${missingUuid}`, {
        method: 'POST',
        auth: standaloneAuth,
        body: {},
      });
      assert.equal(unentitledRetry.status, 403);
      assert.equal(unentitledRetry.json?.error?.code, 'MODULE_NOT_ENTITLED');

      // Sale role inside growth_combo
      const comboAuth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });
      const saleEmail = `sale.capi.${Date.now()}@${comboAuth.tenantSlug}.vn`;
      const salePassword = 'SalePassword123!';
      await harness.apiJson('/api/v1/users', {
        method: 'POST',
        auth: comboAuth,
        body: {
          full_name: 'Sale CAPI Restricted',
          email: saleEmail,
          password: salePassword,
          role: 'sale',
        },
      });
      const saleAuth = await harness.loginTenant({
        email: saleEmail,
        password: salePassword,
        tenantSlug: comboAuth.tenantSlug,
      });

      const saleVault = await harness.apiRaw('/api/v1/integrations/vault/meta_capi', {
        method: 'PUT',
        auth: saleAuth,
        body: { dataset_id: '123', access_token: 'tok' },
      });
      assert.equal(saleVault.status, 403);
      assert.equal(saleVault.json?.error?.code, 'FORBIDDEN_RBAC_PERMISSION');

      const saleTestEvent = await harness.apiRaw('/api/v1/integrations/capi/test-event', {
        method: 'POST',
        auth: saleAuth,
        body: { event_name: 'Lead' },
      });
      assert.equal(saleTestEvent.status, 403);
      assert.equal(saleTestEvent.json?.error?.code, 'FORBIDDEN_RBAC_PERMISSION');
    });

    it('F8-T2-06: enforces 422 validation guards (INVALID_OUTBOUND_URL, MISSING_STAGE_ID) & protects already-assigned sale leads from push overwrite', async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });

      const badOutbound = await harness.apiRaw('/api/v1/integrations/webhooks', {
        method: 'POST',
        auth,
        body: {
          name: 'Bad Outbound',
          webhook_type: 'outbound',
          url: 'ftp://invalid.local/hook',
        },
      });
      assert.equal(badOutbound.status, 422);
      assert.equal(badOutbound.json?.error?.code, 'INVALID_OUTBOUND_URL');

      // Create a second sale user and assign a lead specifically to that sale
      const saleEmail = `sale.owner.${Date.now()}@${auth.tenantSlug}.vn`;
      const saleUserRes = await harness.apiJson('/api/v1/users', {
        method: 'POST',
        auth,
        body: {
          full_name: 'Sale Owner',
          email: saleEmail,
          password: 'SalePassword123!',
          role: 'sale',
        },
      });
      const saleUserId = String(saleUserRes.data.id);

      const leadRes = await harness.apiJson('/api/v1/leads', {
        method: 'POST',
        auth,
        body: {
          name: 'Already Assigned Lead',
          phone: '0909333111',
          email: 'assigned@test.vn',
          force_assigned_to: saleUserId,
        },
      });
      const leadId = leadRes.data.id || leadRes.data.lead_id;
      assert.equal(leadRes.data.status, 'assigned');
      assert.equal(leadRes.data.assigned_to, saleUserId);

      const missingStage = await harness.apiRaw(`/api/v1/leads/${leadId}/stage`, {
        method: 'PATCH',
        auth,
        body: { note: 'Missing stage_id' },
      });
      assert.equal(missingStage.status, 422);
      assert.equal(missingStage.json?.error?.code, 'MISSING_STAGE_ID');

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Protect Assigned Lead Flow',
          status: 'active',
          trigger_type: 'manual_enroll',
          steps: [{ id: 'p1', type: 'push_to_autodata_sale_round', label: 'Push', config: {} }],
        },
      });
      const enrollRes = await harness.apiJson(`/api/v1/marketing/flows/${flowRes.data.id}/enroll`, {
        method: 'POST',
        auth,
        body: { lead_id: leadId },
      });
      assert.equal(enrollRes.data.promotedToSaleRound, false);

      const leadsAfter = await harness.apiJson('/api/v1/leads', {
        auth,
        query: { search: 'assigned@test.vn' },
      });
      const row = (leadsAfter.data?.items || []).find((l: any) => l.id === leadId);
      assert.equal(row?.assigned_sale?.id, saleUserId);
    });
  });
});
