import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness } from './_harness.ts';

let harness: MarketingE2eHarness;

describe('Feature 5: Master Cronjob & Subroutines (E2E)', () => {
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
  // Tier 1 — Happy Path (5 tests)
  // =========================================================================
  describe('Tier 1: Happy Path', () => {
    it('F5-T1-01: master cron executes all 13 subroutines & returns complete CronRunStats', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const res = await harness.triggerMasterCron(undefined, auth.tenantId);
      assert.equal(res.status, 200);
      assert.equal(res.locked, false);

      const expectedKeys = [
        'slaBreachedCount',
        'leadsDrainedCount',
        'zaloRefreshedCount',
        'subscriptionsProcessed',
        'webhooksReplayedCount',
        'capiRetriedCount',
        'marketingFlowsProcessed',
        'marketingCampaignsProcessed',
        'audiencesReevalCount',
        'attendanceConfirmationsCount',
        'remindersDispatchedCount',
        'outboxEventsProcessed',
        'dailyReportsDispatchedCount',
      ];
      for (const k of expectedKeys) {
        assert.equal(typeof res.stats[k], 'number', `Expected numeric stat "${k}"`);
      }
      assert.ok(typeof res.stats.durationMs === 'number' && res.stats.durationMs >= 0);
      assert.deepEqual(res.stats.errors, []);
    });

    it('F5-T1-02: records tenant_cron_runs per subroutine & exposes them via GET /api/v1/org-rbac/cron-status', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const targetSubroutines = [
        'marketing_flows',
        'marketing_campaigns',
        'audience_reeval',
        'reminders',
        'outbox_events',
      ];

      const cronRes = await harness.triggerMasterCron(targetSubroutines, auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.equal(cronRes.locked, false);

      const statusRes = await harness.apiJson('/api/v1/org-rbac/cron-status', { auth });
      const runs = statusRes.data?.runs as Array<any>;
      assert.ok(Array.isArray(runs) && runs.length >= 5);

      for (const sub of targetSubroutines) {
        const match = runs.find(
          (r) => r.subroutine_key === sub && r.tenant_id === auth.tenantId && r.status === 'success'
        );
        assert.ok(match, `Expected tenant_cron_runs entry for subroutine "${sub}"`);
        assert.equal(match.triggered_by, 'scheduler');
      }
    });

    it('F5-T1-03: marketing_campaigns subroutine transitions due scheduled campaign to sent & creates claims', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const contact = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Scheduled Camp Recipient',
          email: 'sched-camp@test.vn',
          phone: '0909333001',
          email_consent: 'subscribed',
        },
      });
      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Scheduled Static Audience',
          audience_type: 'static_data',
          lead_ids: [contact.data.id],
        },
      });

      const pastIso = new Date(Date.now() - 120_000).toISOString();
      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Due Scheduled Campaign',
          channel: 'email',
          audience_id: aud.data.id,
          subject_a: 'Hello Scheduled',
          scheduled_at: pastIso,
        },
      });
      assert.equal(camp.data.status, 'scheduled');

      const cronRes = await harness.triggerMasterCron(['marketing_campaigns'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.ok(cronRes.stats.marketingCampaignsProcessed >= 1);

      const detail = await harness.apiJson(`/api/v1/marketing/campaigns/${camp.data.id}/detail`, { auth });
      assert.ok(
        ['sent', 'completed'].includes(detail.data.campaign.status),
        `Expected campaign status to be sent/completed, got ${detail.data.campaign.status}`
      );
      assert.ok(detail.data.campaign.sent_count >= 1);
    });

    it('F5-T1-04: audience_reeval subroutine refreshes dynamic_logic audience membership', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const lead = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Dynamic High Score Lead',
          email: 'dynscore@test.vn',
          phone: '0909333002',
          lead_score: 85,
        },
      });

      const dynAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Hot Score >= 70',
          audience_type: 'dynamic_logic',
          filter_branches: [
            {
              logic: 'AND',
              conditions: [{ field: 'lead_score', operator: 'gte', value: 70 }],
            },
          ],
        },
      });

      const cronRes = await harness.triggerMasterCron(['audience_reeval'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.ok(cronRes.stats.audiencesReevalCount >= 1);

      const audDetail = await harness.apiJson(`/api/v1/audiences/${dynAud.data.id}`, { auth });
      assert.ok(Number(audDetail.data.cached_member_count) >= 1);

      const members = await harness.apiJson(`/api/v1/audiences/${dynAud.data.id}/members`, { auth });
      assert.ok(members.data.items.some((m: any) => m.id === lead.data.id || m.lead_id === lead.data.id));
    });

    it('F5-T1-05: reminders subroutine sweeps overdue deposit milestones & increments remindersDispatchedCount', async () => {
      const auth = await harness.registerTenant({ packageCode: 'domation_promax' });

      const deposit = await harness.apiJson('/api/v1/finance/deposits', {
        method: 'POST',
        auth,
        body: {
          customer_name: 'Overdue Milestone Customer',
          amount_vnd: 5_000_000,
          status: 'pending',
          milestones: [
            {
              name: 'Overdue Tranche 1',
              amount_vnd: 5_000_000,
              expected_pay_date: '2020-01-01',
              status: 'pending',
            },
          ],
        },
      });
      const depositId = deposit.data.id;

      const cronRes = await harness.triggerMasterCron(['reminders'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.ok(cronRes.stats.remindersDispatchedCount >= 1);

      const depositAfter = await harness.apiJson(`/api/v1/finance/deposits/${depositId}`, { auth });
      assert.equal(depositAfter.data.milestones[0]?.status, 'overdue');
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (5 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F5-T2-01: rejects missing or wrong x-cron-secret with 401 UNAUTHORIZED_CRON_TICK', async () => {
      const noSecret = await harness.apiRaw('/api/v1/operations/cron/master', {
        method: 'POST',
        body: { subroutines: ['sla'] },
      });
      assert.equal(noSecret.status, 401);
      assert.equal(noSecret.json?.error?.code, 'UNAUTHORIZED_CRON_TICK');

      const wrongSecret = await harness.apiRaw('/api/v1/operations/cron/master', {
        method: 'POST',
        headers: { 'X-Cron-Secret': 'wrong-secret-xyz' },
        body: { subroutines: ['sla'] },
      });
      assert.equal(wrongSecret.status, 401);
      assert.equal(wrongSecret.json?.error?.code, 'UNAUTHORIZED_CRON_TICK');
    });

    it('F5-T2-02: authenticates via ?secret= query parameter identically to x-cron-secret header', async () => {
      const res = await harness.apiRaw('/api/v1/operations/cron/master', {
        method: 'GET',
        query: {
          secret: harness.cronSecret,
          subroutines: 'sla',
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json?.data?.locked, false);
      assert.deepEqual(res.json?.data?.stats?.errors, []);
    });

    it('F5-T2-03: tenant_id parameter isolates cron execution strictly to target tenant', async () => {
      const tenantA = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const tenantB = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const pastIso = new Date(Date.now() - 120_000).toISOString();
      const campA = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'Tenant A Scheduled', channel: 'email', scheduled_at: pastIso },
      });
      const campB = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth: tenantB,
        body: { name: 'Tenant B Scheduled', channel: 'email', scheduled_at: pastIso },
      });

      const cronRes = await harness.triggerMasterCron(['marketing_campaigns'], tenantA.tenantId);
      assert.equal(cronRes.status, 200);
      assert.ok(cronRes.stats.marketingCampaignsProcessed >= 1);

      const detailA = await harness.apiJson(`/api/v1/marketing/campaigns/${campA.data.id}/detail`, {
        auth: tenantA,
      });
      assert.ok(
        ['sent', 'completed'].includes(detailA.data.campaign.status),
        `Expected tenant A campaign status to be sent/completed, got ${detailA.data.campaign.status}`
      );

      const detailB = await harness.apiJson(`/api/v1/marketing/campaigns/${campB.data.id}/detail`, {
        auth: tenantB,
      });
      assert.equal(detailB.data.campaign.status, 'scheduled');

      const runsB = await harness.apiJson('/api/v1/org-rbac/cron-status', { auth: tenantB });
      assert.equal(
        runsB.data.runs.some((r: any) => r.subroutine_key === 'marketing_campaigns'),
        false
      );
    });

    it('F5-T2-04: ignores unknown subroutine names gracefully with zero counters and zero errors', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const cronRes = await harness.triggerMasterCron(['nonexistent_worker_xyz'], auth.tenantId);

      assert.equal(cronRes.status, 200);
      assert.equal(cronRes.locked, false);
      assert.equal(cronRes.stats.slaBreachedCount, 0);
      assert.equal(cronRes.stats.marketingFlowsProcessed, 0);
      assert.equal(cronRes.stats.marketingCampaignsProcessed, 0);
      assert.deepEqual(cronRes.stats.errors, []);
    });

    it('F5-T2-05: guards concurrent master cron ticks with in-flight skip or advisory lock', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      // Configure Resend over HTTP + mockFetch delay so the first tick yields to libuv I/O while in-flight
      await harness.apiJson('/api/v1/myerp/settings', {
        method: 'POST',
        auth,
        body: {
          email_provider: 'resend',
          resend_api_key: 're_e2e_concurrency_key',
          resend_from_email: 'noreply@concurrency.test.vn',
        },
      });
      const contact = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Concurrent Email Lead',
          email: 'conclead@test.vn',
          phone: '0909888001',
          email_consent: 'subscribed',
        },
      });
      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Concurrent Static Aud', audience_type: 'static_data', lead_ids: [contact.data.id] },
      });
      const pastIso = new Date(Date.now() - 120_000).toISOString();
      await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Concurrent Due Camp',
          channel: 'email',
          audience_id: aud.data.id,
          scheduled_at: pastIso,
        },
      });

      harness.setSmtpCaptureEnabled(false);
      harness.mockFetch.setFailureMode({ responseDelayMs: 150 });

      const fireCron = () =>
        harness.apiRaw('/api/v1/operations/cron/master', {
          method: 'POST',
          headers: {
            'X-Cron-Secret': harness.cronSecret,
            Connection: 'close',
          },
          body: { subroutines: ['marketing_campaigns'], tenant_id: auth.tenantId },
        });

      const firstReq = fireCron();
      await new Promise((r) => setTimeout(r, 20));
      const overlapReqs = Array.from({ length: 5 }, () => fireCron());
      const responses = await Promise.all([firstReq, ...overlapReqs]);

      for (const r of responses) {
        assert.equal(r.status, 200);
      }

      const payloads = responses.map((r) => r.json?.data || {});
      const completedCount = payloads.filter((d) => d.locked === false && !d.skipped).length;
      const guardedCount = payloads.filter((d) => d.skipped === true || d.locked === true).length;

      assert.equal(completedCount, 1, 'Exactly one concurrent cron call should execute');
      assert.ok(guardedCount >= 1, `Expected >= 1 concurrent call to be skipped/locked, got ${guardedCount}`);
    });
  });
});
