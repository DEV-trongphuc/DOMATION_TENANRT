import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startMarketingE2eHarness, type MarketingE2eHarness } from './_harness.ts';

let harness: MarketingE2eHarness;

function buildDynamicBirthdayDates() {
  const now = new Date();
  const mmToday = String(now.getMonth() + 1).padStart(2, '0');
  const ddToday = String(now.getDate()).padStart(2, '0');
  const todayIso = `1995-${mmToday}-${ddToday}`;

  // Shift +2 months and pick day 15 so neither month nor within-3-days matches today
  const otherMonthNum = ((now.getMonth() + 2) % 12) + 1;
  const mmOther = String(otherMonthNum).padStart(2, '0');
  const otherIso = `1990-${mmOther}-15`;

  return { todayIso, otherIso };
}

describe('Feature 4: Audiences, Segments, Tags, Lists & Fields (E2E)', () => {
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
    it('F4-T1-01: GET /field-catalog returns standard/custom fields (birthday, quiz_score, cf.*), tags, pipelines, stages & rounds', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      await harness.apiJson('/api/v1/audiences/tags', {
        method: 'POST',
        auth,
        body: { name: 'Catalog Tag', color_hex: '#1E40FF' },
      });

      const catalog = await harness.apiJson('/api/v1/audiences/field-catalog', { auth });
      const d = catalog.data;

      assert.ok(Array.isArray(d.fields) && d.fields.length > 0);
      assert.ok(Array.isArray(d.standard_fields) && d.standard_fields.length >= 20);
      assert.ok(Array.isArray(d.pipelines) && d.pipelines.length >= 1);
      assert.ok(Array.isArray(d.stages) && d.stages.length >= 1);
      assert.ok(Array.isArray(d.custom_fields));
      assert.ok(Array.isArray(d.rounds) && d.rounds.length >= 1);
      assert.ok(Array.isArray(d.tags) && d.tags.some((t: any) => t.name === 'Catalog Tag'));

      const stdKeys = new Set(d.standard_fields.map((f: any) => f.key));
      for (const expected of ['cf.birthday', 'quiz_score', 'inactive_days', 'tag', 'lead_score', 'total_revenue_vnd']) {
        assert.ok(stdKeys.has(expected), `Expected standard field ${expected}`);
      }

      const stdBday = d.standard_fields.find((f: any) => f.key === 'cf.birthday');
      assert.equal(stdBday?.type, 'birthday');

      const normBday = d.fields.find((f: any) => f.key === 'cf.birthday');
      assert.equal(normBday?.valueType, 'birthday');

      if (d.custom_fields.length > 0) {
        const cf0 = d.custom_fields[0];
        assert.equal(cf0.filter_key, `cf.${cf0.field_key}`);
        assert.ok(d.fields.some((f: any) => f.key === cf0.filter_key));
      }
    });

    it('F4-T1-02: performs Tags CRUD and contact tag assignment/unassignment with live usage_count', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const tagCreate = await harness.apiRaw('/api/v1/audiences/tags', {
        method: 'POST',
        auth,
        body: { name: 'VIP Buyer', color_hex: '#10B981', category: 'tier' },
      });
      assert.equal(tagCreate.status, 201);
      const tagId = tagCreate.json.data.id;
      assert.equal(tagCreate.json.data.slug, 'vip_buyer');

      const list1 = await harness.apiJson('/api/v1/audiences/tags', { auth });
      const createdTag = list1.data.find((t: any) => t.id === tagId);
      assert.equal(createdTag?.usage_count, 0);

      const tagUpd = await harness.apiJson(`/api/v1/audiences/tags/${tagId}`, {
        method: 'PUT',
        auth,
        body: { name: 'VIP Gold Buyer', color_hex: '#1E40FF' },
      });
      assert.equal(tagUpd.data.name, 'VIP Gold Buyer');
      assert.equal(tagUpd.data.color_hex, '#1E40FF');

      const contact = await harness.apiRaw('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Tagged Lead', email: 'tagged@test.vn', phone: '0909888777' },
      });
      assert.equal(contact.status, 201);
      const leadId = contact.json.data.id;

      await harness.apiJson(`/api/v1/audiences/contacts/${leadId}/tags`, {
        method: 'POST',
        auth,
        body: { tag_id: tagId },
      });

      const contactsWithTag = await harness.apiJson(`/api/v1/audiences/contacts?tag_id=${encodeURIComponent(tagId)}`, {
        auth,
      });
      assert.equal(contactsWithTag.data.items.length, 1);
      assert.equal(contactsWithTag.data.items[0].id, leadId);
      assert.ok(contactsWithTag.data.items[0].tags.some((t: any) => t.id === tagId));

      const list2 = await harness.apiJson('/api/v1/audiences/tags', { auth });
      assert.equal(list2.data.find((t: any) => t.id === tagId)?.usage_count, 1);

      const untagRes = await harness.apiJson(`/api/v1/audiences/contacts/${leadId}/tags/${tagId}`, {
        method: 'DELETE',
        auth,
      });
      assert.equal(untagRes.data.deleted, true);

      const contactsAfterUntag = await harness.apiJson(
        `/api/v1/audiences/contacts?tag_id=${encodeURIComponent(tagId)}`,
        { auth }
      );
      assert.equal(contactsAfterUntag.data.items.length, 0);

      const list3 = await harness.apiJson('/api/v1/audiences/tags', { auth });
      assert.equal(list3.data.find((t: any) => t.id === tagId)?.usage_count, 0);

      const delTag = await harness.apiJson(`/api/v1/audiences/tags/${tagId}`, { method: 'DELETE', auth });
      assert.equal(delTag.data.deleted, true);

      const list4 = await harness.apiJson('/api/v1/audiences/tags', { auth });
      assert.equal(list4.data.some((t: any) => t.id === tagId), false);
    });

    it('F4-T1-03: manages static lists and compiles dynamic AST segments (quiz_score, cf.*, custom_fields.*, birthday, tag, inactive_days)', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const { todayIso, otherIso } = buildDynamicBirthdayDates();

      const leadMatch = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Match Lead',
          email: 'match.seg@test.vn',
          phone: '0909111001',
          custom_fields: {
            tier: 'vip',
            budget_vnd: 5000000000,
            birthday: todayIso,
          },
        },
      });
      const leadMiss = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Miss Lead',
          email: 'miss.seg@test.vn',
          phone: '0909111002',
          custom_fields: {
            tier: 'basic',
            budget_vnd: 500000,
            birthday: otherIso,
          },
        },
      });

      // Static audience membership lifecycle
      const staticAud = await harness.apiRaw('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Static Members List',
          audience_type: 'static_data',
          initial_lead_ids: [leadMatch.data.id],
        },
      });
      assert.equal(staticAud.status, 201);
      assert.equal(staticAud.json.data.cached_member_count, 1);

      const addMem = await harness.apiJson(`/api/v1/audiences/${staticAud.json.data.id}/members`, {
        method: 'POST',
        auth,
        body: { lead_ids: [leadMiss.data.id] },
      });
      assert.equal(addMem.data.cached_member_count, 2);

      const listMem = await harness.apiJson(`/api/v1/audiences/${staticAud.json.data.id}/members`, { auth });
      assert.equal(listMem.data.items.length, 2);

      const delMem = await harness.apiJson(
        `/api/v1/audiences/${staticAud.json.data.id}/members/${leadMiss.data.id}`,
        { method: 'DELETE', auth }
      );
      assert.equal(delMem.data.cached_member_count, 1);

      // Tag & quiz_score timeline event for leadMatch
      const tagRes = await harness.apiJson('/api/v1/audiences/tags', {
        method: 'POST',
        auth,
        body: { name: 'hot-vip' },
      });
      await harness.apiJson(`/api/v1/audiences/contacts/${leadMatch.data.id}/tags`, {
        method: 'POST',
        auth,
        body: { tag_id: tagRes.data.id },
      });

      const surveyRes = await harness.apiJson('/api/v1/marketing/surveys', {
        method: 'POST',
        auth,
        body: {
          title: 'Segment Quiz',
          survey_type: 'quiz',
          blocks: [{ id: 'q1', type: 'quiz_scored', label: 'Ready?', correctValue: 'yes', points: 90 }],
          settings: { base_lead_score: 0 },
        },
      });
      await harness.apiJson(`/api/v1/public/marketing/surveys/${surveyRes.data.slug}`, {
        method: 'POST',
        body: {
          tenant_slug: auth.tenantSlug,
          email: 'match.seg@test.vn',
          phone: '0909111001',
          answers: { q1: 'yes' },
        },
      });

      // Preview multi-rule AST including birthday, quiz_score, cf.*, custom_fields.*, tag, inactive_days
      const filterAst = {
        operator: 'AND',
        branches: [
          {
            operator: 'AND',
            rules: [
              { field: 'quiz_score', op: 'gte', val: 80 },
              { field: 'cf.tier', op: 'equals', val: 'vip' },
              { field: 'custom_fields.budget_vnd', op: 'gte', val: 3000000000 },
              { field: 'birthday', op: 'is_today' },
              { field: 'tag', op: 'equals', val: 'hot-vip' },
              { field: 'inactive_days', op: 'lte', val: 1 },
            ],
          },
        ],
      };

      const previewMatch = await harness.apiJson('/api/v1/audiences/preview', {
        method: 'POST',
        auth,
        body: { filter_branches: filterAst },
      });
      assert.equal(previewMatch.data.has_rules, true);
      assert.equal(previewMatch.data.count, 1);
      assert.equal(previewMatch.data.items[0].id, leadMatch.data.id);

      // Verify other birthday operators (is_this_month & before_days) and inactive_days gt
      for (const bdayOp of [
        { field: 'birthday', op: 'is_this_month' },
        { field: 'birthday', op: 'before_days', val: 3 },
      ]) {
        const prevBday = await harness.apiJson('/api/v1/audiences/preview', {
          method: 'POST',
          auth,
          body: { filter_branches: [bdayOp] },
        });
        assert.equal(prevBday.data.count, 1);
        assert.equal(prevBday.data.items[0].id, leadMatch.data.id);
      }

      const prevInactive = await harness.apiJson('/api/v1/audiences/preview', {
        method: 'POST',
        auth,
        body: { filter_branches: [{ field: 'inactive_days', op: 'gt', val: 30 }] },
      });
      assert.equal(prevInactive.data.count, 0);

      // Create dynamic_logic audience & verify initial evaluation
      const dynAud = await harness.apiRaw('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'VIP Birthday Quiz Segment',
          audience_type: 'dynamic_logic',
          filter_branches: filterAst,
        },
      });
      assert.equal(dynAud.status, 201);
      const dynId = dynAud.json.data.id;
      assert.equal(dynAud.json.data.cached_member_count, 1);
      assert.equal(dynAud.json.data.evaluation.entered_count, 1);

      // Downgrade leadMatch tier -> evaluate() records exit
      await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { email: 'match.seg@test.vn', custom_fields: { tier: 'downgraded' } },
      });

      const evalAfter = await harness.apiJson(`/api/v1/audiences/${dynId}/evaluate`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(evalAfter.data.total_count, 0);

      const dynMembersAfter = await harness.apiJson(`/api/v1/audiences/${dynId}/members`, { auth });
      assert.equal(dynMembersAfter.data.items.length, 0);

      const dynAudAfter = await harness.apiJson(`/api/v1/audiences/${dynId}`, { auth });
      assert.equal(dynAudAfter.data.cached_member_count, 0);
    });

    it('F4-T1-04: imports contacts via csv_text (Vietnamese headers & quoted commas) and JSON rows/items with deduplication', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Import Batch Target', audience_type: 'static_data' },
      });
      const audId = aud.data.id;

      const csvText = [
        'Họ tên,Số điện thoại,Email,cf.city,custom_fields.plan',
        '"Nguyễn Văn A, Jr",0909111222,csv1@test.vn,"HCM",pro',
        'No Contact,,',
        ',0909111333,csv2@test.vn,HN,basic',
      ].join('\n');

      const csvRes = await harness.apiRaw(`/api/v1/audiences/${audId}/import`, {
        method: 'POST',
        auth,
        body: { csv_text: csvText },
      });
      assert.equal(csvRes.status, 201);
      assert.equal(csvRes.json.data.created_count, 2);
      assert.equal(csvRes.json.data.skipped_count, 1);
      assert.equal(csvRes.json.data.imported_count, 2);
      assert.equal(csvRes.json.data.total_audience_members, 2);
      assert.equal(csvRes.json.data.lead_ids.length, 2);

      const jsonRowsRes = await harness.apiRaw(`/api/v1/audiences/${audId}/import`, {
        method: 'POST',
        auth,
        body: {
          rows: [
            { name: 'CSV1 Updated', email: 'csv1@test.vn', custom_fields: { source_note: 'json' } },
            { name: 'JSON New', email: 'json3@test.vn', phone: '0909111444' },
          ],
        },
      });
      assert.equal(jsonRowsRes.status, 201);
      assert.equal(jsonRowsRes.json.data.updated_count, 1);
      assert.equal(jsonRowsRes.json.data.created_count, 1);
      assert.equal(jsonRowsRes.json.data.total_audience_members, 3);

      const jsonItemsRes = await harness.apiRaw(`/api/v1/audiences/${audId}/import`, {
        method: 'POST',
        auth,
        body: {
          items: [{ name: 'Items New', email: 'items4@test.vn' }],
        },
      });
      assert.equal(jsonItemsRes.status, 201);
      assert.equal(jsonItemsRes.json.data.created_count, 1);
      assert.equal(jsonItemsRes.json.data.total_audience_members, 4);

      const membersRes = await harness.apiJson(`/api/v1/audiences/${audId}/members`, { auth });
      assert.equal(membersRes.data.items.length, 4);
      const csv1Member = membersRes.data.items.find((m: any) => m.email === 'csv1@test.vn');
      assert.equal(csv1Member?.custom_fields?.city, 'HCM');
      assert.equal(csv1Member?.custom_fields?.plan, 'pro');
      assert.equal(csv1Member?.custom_fields?.source_note, 'json');
    });

    it('F4-T1-05: preserves existing custom_fields on contact upsert (non-destructive merge) and performs /split & /ab-split', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const createLead = await harness.apiRaw('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Merge Lead',
          email: 'merge@test.vn',
          phone: '0909555111',
          custom_fields: { tier: 'gold', city: 'HN', points: 100 },
        },
      });
      assert.equal(createLead.status, 201);

      const updateLead = await harness.apiRaw('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          email: 'merge@test.vn',
          custom_fields: { city: 'HCM', promo: 'vip2026' },
        },
      });
      assert.equal(updateLead.status, 200);
      assert.deepEqual(updateLead.json.data.custom_fields, {
        tier: 'gold',
        city: 'HCM',
        points: 100,
        promo: 'vip2026',
      });

      const searchAfter = await harness.apiJson('/api/v1/audiences/contacts?search=merge%40test.vn', { auth });
      assert.equal(searchAfter.data.items.length, 1);
      assert.deepEqual(searchAfter.data.items[0].custom_fields, {
        tier: 'gold',
        city: 'HCM',
        points: 100,
        promo: 'vip2026',
      });

      // Split & AB-split on 6-member audience
      const leadIds: string[] = [createLead.json.data.id];
      for (let i = 1; i <= 5; i += 1) {
        const l = await harness.apiJson('/api/v1/audiences/contacts', {
          method: 'POST',
          auth,
          body: { name: `Split ${i}`, email: `split${i}@test.vn` },
        });
        leadIds.push(l.data.id);
      }

      const parentAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Parent Split Audience', audience_type: 'static_data', lead_ids: leadIds },
      });

      const splitRes = await harness.apiRaw(`/api/v1/audiences/${parentAud.data.id}/split`, {
        method: 'POST',
        auth,
        body: { ratios: [50, 50], name_prefix: 'AB' },
      });
      assert.equal(splitRes.status, 201);
      assert.equal(splitRes.json.data.total_split_members, 6);
      assert.equal(splitRes.json.data.created_audiences.length, 2);

      const memberUnion = new Set<string>();
      let countSum = 0;
      for (const child of splitRes.json.data.created_audiences) {
        countSum += Number(child.cached_member_count);
        const mRes = await harness.apiJson(`/api/v1/audiences/${child.id}/members`, { auth });
        for (const item of mRes.data.items) {
          memberUnion.add(item.id);
        }
      }
      assert.equal(countSum, 6);
      assert.equal(memberUnion.size, 6);

      const abSplitRes = await harness.apiRaw(`/api/v1/audiences/${parentAud.data.id}/ab-split`, {
        method: 'POST',
        auth,
        body: { parts: 3, name_prefix: 'ABC' },
      });
      assert.equal(abSplitRes.status, 201);
      assert.equal(abSplitRes.json.data.created.length, 3);
      const abSum = abSplitRes.json.data.created.reduce(
        (acc: number, c: any) => acc + Number(c.cached_member_count),
        0
      );
      assert.equal(abSum, 6);

      // Non-divisible /split on 7-member audience with [50, 50] -> 4 + 3 (disjoint, non-empty, sum = 7)
      const lead7 = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Split 6', email: 'split6@test.vn' },
      });
      const oddLeadIds = [...leadIds, lead7.data.id];
      const oddParentAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Odd 7-Member Split Audience', audience_type: 'static_data', lead_ids: oddLeadIds },
      });
      const oddSplitRes = await harness.apiRaw(`/api/v1/audiences/${oddParentAud.data.id}/split`, {
        method: 'POST',
        auth,
        body: { ratios: [50, 50], name_prefix: 'OddAB' },
      });
      assert.equal(oddSplitRes.status, 201);
      assert.equal(oddSplitRes.json.data.total_split_members, 7);
      assert.equal(oddSplitRes.json.data.created_audiences.length, 2);

      const oddCounts: number[] = [];
      const oddUnion = new Set<string>();
      let oddFetchedTotal = 0;
      for (const child of oddSplitRes.json.data.created_audiences) {
        const cnt = Number(child.cached_member_count);
        assert.ok(cnt > 0, 'Expected non-empty split bucket for 7-lead [50, 50] split');
        oddCounts.push(cnt);
        const mRes = await harness.apiJson(`/api/v1/audiences/${child.id}/members`, { auth });
        assert.equal(mRes.data.items.length, cnt);
        for (const item of mRes.data.items) {
          oddUnion.add(item.id);
          oddFetchedTotal += 1;
        }
      }
      assert.deepEqual([...oddCounts].sort((a, b) => a - b), [3, 4]);
      assert.equal(oddCounts.reduce((a, b) => a + b, 0), 7);
      assert.equal(oddFetchedTotal, 7);
      assert.equal(oddUnion.size, 7);
      for (const id of oddLeadIds) {
        assert.ok(oddUnion.has(id), `Expected lead ${id} in one of the split buckets`);
      }
    });
  });

  // =========================================================================
  // Tier 2 — Boundary, Corner & Negative (5 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Corner & Negative', () => {
    it('F4-T2-01: rejects contacts without valid phone/email and empty tag/audience names with 422', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const missingContact = await harness.apiRaw('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Missing Contact' },
      });
      assert.equal(missingContact.status, 422);
      assert.equal(missingContact.json?.error?.code, 'CONTACT_REQUIRES_PHONE_OR_EMAIL');

      const badPhoneEmail = await harness.apiRaw('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Bad Contact', phone: '123', email: 'not-an-email' },
      });
      assert.equal(badPhoneEmail.status, 422);
      assert.equal(badPhoneEmail.json?.error?.code, 'CONTACT_REQUIRES_PHONE_OR_EMAIL');

      const emptyTag = await harness.apiRaw('/api/v1/audiences/tags', {
        method: 'POST',
        auth,
        body: { name: '   ' },
      });
      assert.equal(emptyTag.status, 422);
      assert.equal(emptyTag.json?.error?.code, 'VALIDATION_ERROR');

      const emptyAud = await harness.apiRaw('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: '' },
      });
      assert.equal(emptyAud.status, 422);
      assert.equal(emptyAud.json?.error?.code, 'VALIDATION_ERROR');
    });

    it('F4-T2-02: rejects empty import payloads ({}, [], whitespace csv, header-only csv) with 422 EMPTY_IMPORT_PAYLOAD', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const aud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Empty Import Target', audience_type: 'static_data' },
      });

      for (const payload of [
        {},
        { rows: [] },
        { items: [] },
        { csv_text: '   ' },
        { csv_text: 'name,email,phone\n' },
      ]) {
        const res = await harness.apiRaw(`/api/v1/audiences/${aud.data.id}/import`, {
          method: 'POST',
          auth,
          body: payload,
        });
        assert.equal(res.status, 422);
        assert.equal(res.json?.error?.code, 'EMPTY_IMPORT_PAYLOAD');
      }
    });

    it('F4-T2-03: sanitizes/rejects invalid & SQL-injection-like custom_fields keys in segment compiler without SQL errors', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: {
          name: 'Safe Lead',
          email: 'safe@test.vn',
          custom_fields: { tier: 'vip' },
        },
      });

      const adversarialRules = [
        { field: "cf.tier') OR 1=1--", op: 'equals', val: 'vip' },
        { field: 'custom_fields.tier; DROP TABLE leads;--', op: 'equals', val: 'vip' },
        { field: `cf.${'a'.repeat(65)}`, op: 'equals', val: 'vip' },
        { field: "cf.bad'key", op: 'is_today' },
        { field: 'cf.tier', op: 'equals', val: "' OR '1'='1" },
      ];

      for (const rule of adversarialRules) {
        const prev = await harness.apiRaw('/api/v1/audiences/preview', {
          method: 'POST',
          auth,
          body: { filter_branches: [rule] },
        });
        assert.equal(prev.status, 200);
        assert.equal(prev.json.data.count, 0);
        assert.equal(prev.json.data.items.length, 0);
      }

      const stillIntact = await harness.apiJson('/api/v1/audiences/contacts', { auth });
      assert.equal(stillIntact.data.items.length, 1);
      assert.equal(stillIntact.data.items[0].email, 'safe@test.vn');
    });

    it('F4-T2-04: enforces empty segment boundary (0 matches), negate, within_days, and audience exclusions', async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      // Empty AST -> 0 matches (never leaks all leads)
      const leadSurveyed = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Surveyed Lead', email: 'surveyed@test.vn', phone: '0909333001' },
      });
      const leadUnsurveyed = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth,
        body: { name: 'Unsurveyed Lead', email: 'unsurveyed@test.vn', phone: '0909333002' },
      });

      for (const emptyAst of [[], { operator: 'OR', branches: [] }]) {
        const emptyPrev = await harness.apiJson('/api/v1/audiences/preview', {
          method: 'POST',
          auth,
          body: { filter_branches: emptyAst },
        });
        assert.equal(emptyPrev.data.has_rules, false);
        assert.equal(emptyPrev.data.count, 0);
        assert.equal(emptyPrev.data.items.length, 0);
      }

      const emptyDyn = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: { name: 'Empty Dynamic', audience_type: 'dynamic_logic', filter_branches: [] },
      });
      assert.equal(emptyDyn.data.cached_member_count, 0);

      // Assign vip-member tag + complete survey for leadSurveyed
      const tagRes = await harness.apiJson('/api/v1/audiences/tags', {
        method: 'POST',
        auth,
        body: { name: 'vip-member' },
      });
      await harness.apiJson(`/api/v1/audiences/contacts/${leadSurveyed.data.id}/tags`, {
        method: 'POST',
        auth,
        body: { tag_id: tagRes.data.id },
      });

      const survey = await harness.apiJson('/api/v1/marketing/surveys', {
        method: 'POST',
        auth,
        body: { title: 'Negate & Within Days Survey', survey_type: 'survey', blocks: [] },
      });
      await harness.apiJson(`/api/v1/public/marketing/surveys/${survey.data.slug}`, {
        method: 'POST',
        body: {
          tenant_slug: auth.tenantSlug,
          email: 'surveyed@test.vn',
          phone: '0909333001',
          answers: {},
        },
      });

      const prevWithin = await harness.apiJson('/api/v1/audiences/preview', {
        method: 'POST',
        auth,
        body: { filter_branches: [{ field: 'completed_survey', val: true, within_days: 7 }] },
      });
      assert.equal(prevWithin.data.count, 1);
      assert.equal(prevWithin.data.items[0].id, leadSurveyed.data.id);

      const prevNegSurvey = await harness.apiJson('/api/v1/audiences/preview', {
        method: 'POST',
        auth,
        body: { filter_branches: [{ field: 'completed_survey', val: true, negate: true }] },
      });
      assert.equal(prevNegSurvey.data.count, 1);
      assert.equal(prevNegSurvey.data.items[0].id, leadUnsurveyed.data.id);

      const prevNegTag = await harness.apiJson('/api/v1/audiences/preview', {
        method: 'POST',
        auth,
        body: { filter_branches: [{ field: 'tag', op: 'equals', val: 'vip-member', negate: true }] },
      });
      assert.equal(prevNegTag.data.count, 1);
      assert.equal(prevNegTag.data.items[0].id, leadUnsurveyed.data.id);

      // Dynamic audience + exclusion removes leadSurveyed
      const dynSurveyAud = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'Surveyed Dynamic With Exclusion',
          audience_type: 'dynamic_logic',
          filter_branches: [{ field: 'completed_survey', val: true, within_days: 7 }],
        },
      });
      assert.equal(dynSurveyAud.data.cached_member_count, 1);

      const exclRes = await harness.apiRaw(`/api/v1/audiences/${dynSurveyAud.data.id}/exclusions`, {
        method: 'POST',
        auth,
        body: { lead_id: leadSurveyed.data.id, reason: 'Manual exclude' },
      });
      assert.equal(exclRes.status, 201);

      const evalAfterExcl = await harness.apiJson(`/api/v1/audiences/${dynSurveyAud.data.id}/evaluate`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(evalAfterExcl.data.total_count, 0);
      const dynMembersAfterExcl = await harness.apiJson(`/api/v1/audiences/${dynSurveyAud.data.id}/members`, {
        auth,
      });
      assert.equal(dynMembersAfterExcl.data.items.length, 0);
    });

    it('F4-T2-05: enforces cross-tenant audience, contact & tag isolation (404 / zero leakage / FK rejection)', async () => {
      const tenantA = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      const tenantB = await harness.registerTenant({ packageCode: 'marketing_standalone' });

      const tagA = await harness.apiJson('/api/v1/audiences/tags', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'Tenant A Exclusive Tag' },
      });
      const leadA = await harness.apiJson('/api/v1/audiences/contacts', {
        method: 'POST',
        auth: tenantA,
        body: { name: 'Tenant A Lead', email: 'secreta@tenanta.vn', phone: '0909444001' },
      });
      await harness.apiJson(`/api/v1/audiences/contacts/${leadA.data.id}/tags`, {
        method: 'POST',
        auth: tenantA,
        body: { tag_id: tagA.data.id },
      });
      const staticAudA = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth: tenantA,
        body: {
          name: 'Tenant A Static',
          audience_type: 'static_data',
          lead_ids: [leadA.data.id],
        },
      });
      const dynAudA = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth: tenantA,
        body: {
          name: 'Tenant A Dynamic',
          audience_type: 'dynamic_logic',
          filter_branches: [{ field: 'email', op: 'contains', val: 'tenanta.vn' }],
        },
      });

      // Cross-tenant audience endpoints -> 404 AUDIENCE_NOT_FOUND
      for (const req of [
        { method: 'GET', path: `/api/v1/audiences/${staticAudA.data.id}` },
        { method: 'PUT', path: `/api/v1/audiences/${staticAudA.data.id}`, body: { name: 'Hijacked' } },
        { method: 'POST', path: `/api/v1/audiences/${staticAudA.data.id}/evaluate`, body: {} },
        {
          method: 'POST',
          path: `/api/v1/audiences/${staticAudA.data.id}/import`,
          body: { rows: [{ email: 'x@y.vn' }] },
        },
        { method: 'POST', path: `/api/v1/audiences/${staticAudA.data.id}/split`, body: { parts: 2 } },
        { method: 'POST', path: `/api/v1/audiences/${staticAudA.data.id}/push-to-sale`, body: {} },
      ]) {
        const res = await harness.apiRaw(req.path, { method: req.method, auth: tenantB, body: req.body });
        assert.equal(res.status, 404);
        assert.equal(res.json?.error?.code, 'AUDIENCE_NOT_FOUND');
      }

      const tagPutB = await harness.apiRaw(`/api/v1/audiences/tags/${tagA.data.id}`, {
        method: 'PUT',
        auth: tenantB,
        body: { name: 'Hijacked Tag' },
      });
      assert.equal(tagPutB.status, 404);
      assert.equal(tagPutB.json?.error?.code, 'TAG_NOT_FOUND');

      // Zero leakage in Tenant B queries
      const audListB = await harness.apiJson('/api/v1/audiences', { auth: tenantB });
      assert.equal(audListB.data.items.some((a: any) => a.id === staticAudA.data.id), false);

      const tagListB = await harness.apiJson('/api/v1/audiences/tags', { auth: tenantB });
      assert.equal(tagListB.data.some((t: any) => t.id === tagA.data.id), false);

      const contactsB = await harness.apiJson('/api/v1/audiences/contacts', { auth: tenantB });
      assert.equal(contactsB.data.items.length, 0);

      const byListB = await harness.apiJson(
        `/api/v1/audiences/contacts?list_id=${encodeURIComponent(staticAudA.data.id)}`,
        { auth: tenantB }
      );
      assert.equal(byListB.data.items.length, 0);

      const bySegB = await harness.apiJson(
        `/api/v1/audiences/contacts?segment_id=${encodeURIComponent(dynAudA.data.id)}`,
        { auth: tenantB }
      );
      assert.equal(bySegB.data.items.length, 0);

      const membersB = await harness.apiJson(`/api/v1/audiences/${staticAudA.data.id}/members`, { auth: tenantB });
      assert.equal(membersB.data.items.length, 0);

      const previewB = await harness.apiJson('/api/v1/audiences/preview', {
        method: 'POST',
        auth: tenantB,
        body: { filter_branches: [{ field: 'email', op: 'contains', val: '@' }] },
      });
      assert.equal(previewB.data.count, 0);

      // Cross-tenant tag assignment fails FK and cross-tenant DELETE leaves Tenant A intact
      const tagB = await harness.apiJson('/api/v1/audiences/tags', {
        method: 'POST',
        auth: tenantB,
        body: { name: 'Tenant B Tag' },
      });
      const crossAssign = await harness.apiRaw(`/api/v1/audiences/contacts/${leadA.data.id}/tags`, {
        method: 'POST',
        auth: tenantB,
        body: { tag_id: tagB.data.id },
      });
      assert.ok(crossAssign.status >= 400);

      await harness.apiRaw(`/api/v1/audiences/${staticAudA.data.id}`, { method: 'DELETE', auth: tenantB });
      const checkA = await harness.apiJson(`/api/v1/audiences/${staticAudA.data.id}`, { auth: tenantA });
      assert.equal(checkA.data.id, staticAudA.data.id);

      const contactsA = await harness.apiJson('/api/v1/audiences/contacts', { auth: tenantA });
      assert.equal(contactsA.data.items[0].tags.length, 1);
      assert.equal(contactsA.data.items[0].tags[0].id, tagA.data.id);
    });
  });
});
