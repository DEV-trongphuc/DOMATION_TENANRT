import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness } from './_harness.ts';

let harness: MarketingE2eHarness;

describe('Feature 9: Legacy & MYERP Compat Bridge Endpoints (E2E)', () => {
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
    it('F9-T1-01: unauthenticated _health & /backend/* mount parity with /api/v1/myerp/*', async () => {
      const h1 = await harness.apiRaw('/api/v1/myerp/_health');
      assert.equal(h1.status, 200);
      assert.equal(h1.json?.success, true);
      assert.equal(h1.json?.data?.service, 'myerp-compat');
      assert.equal(h1.json?.data?.version, 1);

      const h2 = await harness.apiRaw('/backend/_health');
      assert.equal(h2.status, 200);
      assert.equal(h2.json?.success, true);
      assert.equal(h2.json?.data?.service, 'myerp-compat');

      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const backendCampaigns = await harness.apiRaw('/backend/campaigns', { auth });
      assert.equal(backendCampaigns.status, 200);
      assert.equal(backendCampaigns.json?.success, true);
      assert.ok(Array.isArray(backendCampaigns.json?.data?.items));
    });

    it('F9-T1-02: supports segments.php preview & lists CRUD via compat bridge', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const preview = await harness.apiRaw('/api/v1/myerp/automation/segments.php', {
        method: 'POST',
        auth,
        query: { action: 'preview' },
        body: { filter_branches: [] },
      });
      assert.equal(preview.status, 200);
      assert.equal(typeof preview.json?.data?.count, 'number');
      assert.ok(Array.isArray(preview.json?.data?.items));

      const createdList = await harness.apiRaw('/api/v1/myerp/lists', {
        method: 'POST',
        auth,
        body: { name: 'Compat List' },
      });
      assert.equal(createdList.status, 201);
      const listId = createdList.json?.data?.id;
      assert.ok(listId);

      const updatedList = await harness.apiRaw(`/api/v1/myerp/lists/${listId}`, {
        method: 'PUT',
        auth,
        body: { name: 'Updated Compat List' },
      });
      assert.equal(updatedList.status, 200);
      assert.equal(updatedList.json?.data?.name, 'Updated Compat List');

      const deletedList = await harness.apiRaw(`/api/v1/myerp/lists/${listId}`, {
        method: 'DELETE',
        auth,
      });
      assert.equal(deletedList.status, 200);
      assert.equal(deletedList.json?.data?.deleted, true);
    });

    it('F9-T1-03: supports voucher_campaigns.php, links_qr.php & campaigns.php?route=pre_send_review', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const vc = await harness.apiRaw('/api/v1/myerp/automation/voucher_campaigns.php', {
        method: 'POST',
        auth,
        body: { name: 'Compat Voucher', code_prefix: 'CMP' },
      });
      assert.equal(vc.status, 201);
      assert.equal(vc.json?.data?.code_prefix, 'CMP');

      const qr = await harness.apiRaw('/api/v1/myerp/automation/links_qr.php', {
        method: 'POST',
        auth,
        body: { title: 'Compat QR1', target_url: 'https://example.com/promo' },
      });
      assert.equal(qr.status, 201);
      assert.ok(qr.json?.data?.short_code || qr.json?.data?.id);

      const review = await harness.apiRaw('/api/v1/myerp/automation/campaigns.php', {
        method: 'POST',
        auth,
        query: { route: 'pre_send_review' },
        body: { channel: 'email', subject_a: 'Clean Newsletter Subject' },
      });
      assert.equal(review.status, 200);
      assert.equal(typeof review.json?.data?.readiness_score, 'number');
      assert.equal(typeof review.json?.data?.net_reachable_estimate, 'number');
    });

    // [M2-REQ] True requirement: ?route= handlers on /automation/campaigns, /automation/flows & flows.php
    it('F9-T1-04: [M2-REQ] handles campaigns?route=rename|pause|resume|clear_attachments & flows?route=duplicate|sync|bulk-delete with real DB state', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
        method: 'POST',
        auth,
        body: {
          name: 'Original Compat Campaign',
          channel: 'email',
          subject_a: 'Original Subject',
          scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
          attachments: [{ name: 'brochure.pdf', url: 'https://example.com/brochure.pdf' }],
        },
      });
      const campId = camp.data.id;

      const renameRes = await harness.apiRaw('/api/v1/myerp/automation/campaigns', {
        method: 'POST',
        auth,
        query: { route: 'rename' },
        body: { id: campId, name: 'Renamed Compat Campaign' },
      });
      assert.ok(renameRes.ok, `Expected 2xx for campaigns?route=rename, got ${renameRes.status}: ${renameRes.rawText}`);

      const pauseRes = await harness.apiRaw('/api/v1/myerp/automation/campaigns', {
        method: 'POST',
        auth,
        query: { route: 'pause' },
        body: { campaign_id: campId },
      });
      assert.ok(pauseRes.ok, `Expected 2xx for campaigns?route=pause, got ${pauseRes.status}: ${pauseRes.rawText}`);

      const pausedDetail = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
      assert.equal(pausedDetail.data.campaign.name, 'Renamed Compat Campaign');
      assert.equal(pausedDetail.data.campaign.status, 'paused');
      const seededAttachments =
        pausedDetail.data?.campaign?.attachments ?? pausedDetail.data?.attachments;
      assert.ok(
        Array.isArray(seededAttachments) &&
          seededAttachments.length === 1 &&
          (seededAttachments[0]?.name === 'brochure.pdf' || seededAttachments[0] === 'brochure.pdf'),
        `Expected seeded brochure.pdf attachment to be persisted in campaign detail before clear_attachments, got ${JSON.stringify(seededAttachments)}`
      );

      const resumeRes = await harness.apiRaw('/api/v1/myerp/automation/campaigns', {
        method: 'POST',
        auth,
        query: { route: 'resume' },
        body: { campaign_id: campId },
      });
      assert.ok(resumeRes.ok, `Expected 2xx for campaigns?route=resume, got ${resumeRes.status}: ${resumeRes.rawText}`);

      const resumedDetail = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
      assert.notEqual(
        resumedDetail.data.campaign.status,
        'paused',
        'campaigns?route=resume must transition campaign out of paused status in DB'
      );
      assert.ok(
        ['scheduled', 'draft', 'sending'].includes(resumedDetail.data.campaign.status),
        `Expected resumed status to be scheduled/draft/sending, got ${resumedDetail.data.campaign.status}`
      );

      const clearRes = await harness.apiRaw('/api/v1/myerp/automation/campaigns', {
        method: 'POST',
        auth,
        query: { route: 'clear_attachments' },
        body: { id: campId },
      });
      assert.ok(clearRes.ok, `Expected 2xx for campaigns?route=clear_attachments, got ${clearRes.status}`);
      assert.equal(clearRes.json?.success, true);

      const afterClearDetail = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
      assert.equal(afterClearDetail.data.campaign.id, campId);
      const clearedAttachments =
        afterClearDetail.data?.campaign?.attachments ?? afterClearDetail.data?.attachments;
      assert.ok(
        Array.isArray(clearedAttachments),
        `campaigns?route=clear_attachments must expose an explicit attachments array in campaign detail, got ${JSON.stringify(clearedAttachments)}`
      );
      assert.deepEqual(
        clearedAttachments,
        [],
        'campaigns?route=clear_attachments must leave attachments empty in campaign detail'
      );
      if (clearRes.json?.data?.attachments !== undefined) {
        assert.deepEqual(clearRes.json.data.attachments, []);
      }

      // Flows ?route=duplicate, sync, bulk-delete
      const flow = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Compat Source Flow',
          trigger_type: 'form_submitted',
          steps: [{ id: 's1', type: 'update_lead_score', label: 'Score', config: { delta: 5 } }],
        },
      });
      const flowId = flow.data.id;

      const dupRes = await harness.apiRaw('/api/v1/myerp/automation/flows', {
        method: 'POST',
        auth,
        query: { route: 'duplicate', id: flowId },
        body: { name: 'Compat Cloned Flow' },
      });
      assert.ok(dupRes.ok, `Expected 2xx for flows?route=duplicate, got ${dupRes.status}: ${dupRes.rawText}`);

      const syncRes = await harness.apiRaw('/api/v1/myerp/automation/flows', {
        method: 'GET',
        auth,
        query: { route: 'sync', id: flowId },
      });
      assert.ok(syncRes.ok, `Expected 2xx for flows?route=sync, got ${syncRes.status}`);
      assert.equal(syncRes.json?.success, true);
      const syncPayload = syncRes.json?.data?.flow ?? syncRes.json?.data;
      const syncedFlowId = syncPayload?.id ?? syncPayload?.flow_id;
      assert.equal(syncedFlowId, flowId, 'flows?route=sync must return matching flowId payload');
      assert.equal(
        syncPayload?.name,
        'Compat Source Flow',
        'flows?route=sync must return DB-persisted flow name'
      );
      assert.ok(
        Array.isArray(syncPayload?.steps) &&
          syncPayload.steps.length === 1 &&
          syncPayload.steps[0]?.id === 's1',
        `flows?route=sync must return DB-persisted steps containing s1, got ${JSON.stringify(syncPayload?.steps)}`
      );

      const syncMissingRes = await harness.apiRaw('/api/v1/myerp/automation/flows', {
        method: 'GET',
        auth,
        query: { route: 'sync', id: '00000000-0000-4000-8000-000000000099' },
      });
      assert.equal(
        syncMissingRes.status,
        404,
        `Expected 404 for flows?route=sync with nonexistent flow ID, got ${syncMissingRes.status}`
      );

      const flowsList = await harness.apiJson('/api/v1/marketing/flows', { auth });
      const cloned = flowsList.data.items.find((f: any) => f.id !== flowId && f.name.includes('Compat'));
      assert.ok(cloned, 'Expected duplicated flow to exist in /api/v1/marketing/flows');

      const bulkDelRes = await harness.apiRaw('/api/v1/myerp/automation/flows', {
        method: 'POST',
        auth,
        query: { route: 'bulk-delete' },
        body: { ids: [cloned.id] },
      });
      assert.ok(bulkDelRes.ok, `Expected 2xx for flows?route=bulk-delete, got ${bulkDelRes.status}`);

      const flowsAfterDel = await harness.apiJson('/api/v1/marketing/flows', { auth });
      assert.equal(
        flowsAfterDel.data.items.some((f: any) => f.id === cloned.id),
        false,
        'Bulk-deleted cloned flow must be removed from DB'
      );
    });

    // [M2-REQ] True requirement: flow_ai_review.php & zalo_oa?route=generate-auth-url
    it('F9-T1-05: [M2-REQ] resolves flow_ai_review.php & zalo_oa?route=generate-auth-url without 501/fallback', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const aiRev = await harness.apiRaw('/api/v1/myerp/automation/flow_ai_review.php', {
        method: 'POST',
        auth,
        body: {
          flow: {
            name: 'Welcome Flow',
            trigger_type: 'form_submitted',
            steps: [{ id: 's1', type: 'send_email', label: 'Welcome' }],
          },
        },
      });
      assert.equal(aiRev.status, 200, `Expected 200 for flow_ai_review.php, got ${aiRev.status}: ${aiRev.rawText}`);
      assert.equal(typeof aiRev.json?.data?.review, 'string');
      assert.ok(aiRev.json.data.review.length > 0);

      const zaloAuth = await harness.apiRaw('/api/v1/myerp/zalo_oa', {
        method: 'POST',
        auth,
        query: { route: 'generate-auth-url' },
        body: {},
      });
      assert.equal(zaloAuth.status, 200, `Expected 200 for zalo_oa?route=generate-auth-url, got ${zaloAuth.status}: ${zaloAuth.rawText}`);
      assert.equal(typeof zaloAuth.json?.data?.auth_url, 'string');
      assert.ok(
        zaloAuth.json.data.auth_url.startsWith('https://'),
        `Expected valid https OAuth URL, got "${zaloAuth.json?.data?.auth_url}"`
      );
    });

    // [M2-REQ] True requirement: template_groups, subscribers/:id, otp_profiles must persist to DB (no hardcoded stubs)
    it('F9-T1-06: [M2-REQ] persists mutations on template_groups, subscribers/:id & otp_profiles in DB', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      // 1. template_groups PUT persistence
      const grp = await harness.apiJson('/api/v1/myerp/template_groups', {
        method: 'POST',
        auth,
        body: { name: 'Grp1' },
      });
      const grpId = grp.data.id;
      const grpPut = await harness.apiRaw(`/api/v1/myerp/template_groups/${grpId}`, {
        method: 'PUT',
        auth,
        body: { name: 'Grp1-Updated' },
      });
      assert.equal(grpPut.status, 200);
      const tplList = await harness.apiJson('/api/v1/myerp/templates', { auth });
      assert.ok(
        tplList.data.groups.some((g: any) => g.id === grpId && g.name === 'Grp1-Updated'),
        'PUT /template_groups/:id must persist updated name in DB'
      );

      // 2. subscribers/:id PUT & DELETE persistence
      const sub = await harness.apiJson('/api/v1/myerp/subscribers', {
        method: 'POST',
        auth,
        body: { name: 'Sub-Initial', email: 'compat-sub@test.vn', phone: '0909444001' },
      });
      const subId = sub.data.id;
      const subPut = await harness.apiRaw(`/api/v1/myerp/subscribers/${subId}`, {
        method: 'PUT',
        auth,
        body: { name: 'Sub-Updated' },
      });
      assert.equal(subPut.status, 200);
      const subListAfterPut = await harness.apiJson('/api/v1/myerp/subscribers', { auth });
      assert.ok(
        subListAfterPut.data.items.some((s: any) => s.id === subId && s.name === 'Sub-Updated'),
        'PUT /subscribers/:id must persist updated name in DB'
      );

      const subDel = await harness.apiRaw(`/api/v1/myerp/subscribers/${subId}`, {
        method: 'DELETE',
        auth,
      });
      assert.equal(subDel.status, 200);
      const subListAfterDel = await harness.apiJson('/api/v1/myerp/subscribers', { auth });
      assert.equal(
        subListAfterDel.data.items.some((s: any) => s.id === subId),
        false,
        'DELETE /subscribers/:id must delete/archive subscriber in DB'
      );

      // 3. otp_profiles POST persistence
      const otpCreate = await harness.apiRaw('/api/v1/myerp/otp_profiles', {
        method: 'POST',
        auth,
        body: { name: 'OTP-Profile-1', token_length: 6, ttl_seconds: 300 },
      });
      assert.equal(otpCreate.status, 201);
      const otpList = await harness.apiJson('/api/v1/myerp/otp_profiles', { auth });
      const otpItems = Array.isArray(otpList.data?.items)
        ? otpList.data.items
        : Array.isArray(otpList.data?.profiles)
          ? otpList.data.profiles
          : Array.isArray(otpList.data)
            ? otpList.data
            : [];
      assert.ok(
        otpItems.some((p: any) => p.name === 'OTP-Profile-1'),
        'POST /otp_profiles must persist profile in DB and return it from GET /otp_profiles'
      );
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (5 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F9-T2-01: unmapped write returns 501 MYERP_COMPAT_NOT_IMPLEMENTED + X-MyERP-Compat: unmapped', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const res = await harness.apiRaw('/api/v1/myerp/does_not_exist_action', {
        method: 'POST',
        auth,
        body: { foo: 'bar' },
      });
      assert.equal(res.status, 501);
      assert.equal(res.json?.error?.code, 'MYERP_COMPAT_NOT_IMPLEMENTED');
      assert.equal(res.headers.get('x-myerp-compat'), 'unmapped');
    });

    it('F9-T2-02: unmapped GET returns empty MYERP list envelope + X-MyERP-Compat: unmapped', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const res = await harness.apiRaw('/api/v1/myerp/does_not_exist_resource', {
        method: 'GET',
        auth,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-myerp-compat'), 'unmapped');
      assert.deepEqual(res.json?.data, { items: [], total: 0, page: 1, limit: 0 });
    });

    it('F9-T2-03: supports method override via _method body & X-HTTP-Method-Override header', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const created = await harness.apiJson('/api/v1/myerp/lists', {
        method: 'POST',
        auth,
        body: { name: 'Override Target' },
      });
      const listId = created.data.id;

      const viaBodyOverride = await harness.apiRaw(`/api/v1/myerp/lists/${listId}`, {
        method: 'POST',
        auth,
        body: { _method: 'PUT', name: 'ViaMethodOverride' },
      });
      assert.equal(viaBodyOverride.status, 200);
      assert.equal(viaBodyOverride.json?.data?.name, 'ViaMethodOverride');

      const viaHeaderOverride = await harness.apiRaw(`/api/v1/myerp/lists/${listId}`, {
        method: 'POST',
        auth,
        headers: { 'X-HTTP-Method-Override': 'DELETE' },
        body: {},
      });
      assert.equal(viaHeaderOverride.status, 200);
      assert.equal(viaHeaderOverride.json?.data?.deleted, true);
    });

    it('F9-T2-04: enforces 401 AUTHENTICATION_REQUIRED & 403 MODULE_NOT_ENTITLED on compat routes', async () => {
      const unauth = await harness.apiRaw('/api/v1/myerp/flows');
      assert.equal(unauth.status, 401);
      assert.equal(unauth.json?.error?.code, 'AUTHENTICATION_REQUIRED');

      const crmAuth = await harness.registerTenant({ packageCode: 'autodata_crm' });
      const forbidden = await harness.apiRaw('/api/v1/myerp/flows', { auth: crmAuth });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.json?.error?.code, 'MODULE_NOT_ENTITLED');
    });

    it('F9-T2-05: returns structured 4xx (not 500) on invalid/missing legacy .php IDs & routes', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const sendWithoutId = await harness.apiRaw('/api/v1/myerp/automation/campaigns.php', {
        method: 'POST',
        auth,
        query: { route: 'send' },
        body: {},
      });
      assert.ok(sendWithoutId.status >= 400 && sendWithoutId.status < 500);
      assert.equal(sendWithoutId.json?.success, false);
      assert.ok(sendWithoutId.json?.error?.code);

      const missingFlow = await harness.apiRaw('/api/v1/myerp/automation/flows.php', {
        method: 'GET',
        auth,
        query: { id: '00000000-0000-4000-8000-000000000099' },
      });
      assert.equal(missingFlow.status, 404);
      assert.equal(missingFlow.json?.success, false);
      assert.equal(missingFlow.json?.error?.code, 'FLOW_NOT_FOUND');
    });
  });
});
