import crypto from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import { setMetaGraphFetcherForTesting } from '../server/services/meta-ads.service.ts';

describe('DOM ERP Global Multi-Tenant Standardization Integration Suite', () => {
  let harness: TestHarness;

  let tenantA!: {
    id: string;
    slug: string;
    ownerId: string;
    token: string;
  };
  let tenantB!: {
    id: string;
    slug: string;
    ownerId: string;
    token: string;
  };

  let createdMetaAccount1Id = '';
  let createdMetaAccount2Id = '';
  let customCategoryKey = 'procurement_it';
  let customWorkflowId = '';
  let customSegmentId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    // Register Tenant A on Package 1 (`autodata_crm`) initially
    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Alpha Cloud Enterprise',
        tenant_slug: 'alpha-cloud-std',
        admin_name: 'Nguyen Hoang',
        work_email: 'owner@alpha-cloud.vn',
        phone: '0901888111',
        password: 'SecurePassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      ownerId: regA.json.data.user.id,
      token: regA.json.data.access_token,
    };

    // Register Tenant B directly and upgrade to `domation_promax` for RLS isolation + approvals tests
    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Beta Logistics Group',
        tenant_slug: 'beta-logistics-std',
        admin_name: 'Tran Minh',
        work_email: 'owner@beta-logistics.vn',
        phone: '0902888222',
        password: 'SecurePassword123!',
        industry: 'retail',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      ownerId: regB.json.data.user.id,
      token: regB.json.data.access_token,
    };

    const upB = await apiRequest(harness.baseUrl, '/api/v1/myerp/package-entitlements/upgrade', {
      method: 'POST',
      token: tenantB.token,
      tenantSlug: tenantB.slug,
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(upB.status, 200);
    assert.equal(upB.json.data.package_code, 'domation_promax');
    assert.equal(upB.json.data.education_addon, false);
  });

  after(async () => {
    setMetaGraphFetcherForTesting(null);
    await harness.close();
  });

  it('1. Seamless 1-click /data (autodata_crm) -> DOM ERP (domation_promax) upgrade preserves leads, rounds & stages 100%', async () => {
    // Verify initial entitlements on `autodata_crm`
    const entBefore = await apiRequest(harness.baseUrl, '/api/v1/myerp/package-entitlements', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(entBefore.status, 200);
    assert.equal(entBefore.json.data.current_package, 'autodata_crm');
    assert.equal(entBefore.json.data.education_addon, false);
    assert.equal(entBefore.json.data.zero_migration_ready, true);

    // Seed pre-upgrade /data CRM state: custom stage, distribution round, and lead
    const pipeRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(pipeRes.status, 200);
    const defaultPipeline = Array.isArray(pipeRes.json.data)
      ? pipeRes.json.data[0]
      : pipeRes.json.data?.pipelines?.[0];
    assert.ok(defaultPipeline?.id, 'Expected default pipeline on autodata_crm');

    const stagesBeforeRes = await withTenantTransaction(tenantA.id, async (client) => {
      return client.query<{ id: string; stage_key: string; stage_name: string }>(
        'SELECT id, stage_key, stage_name FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC',
        [tenantA.id]
      );
    });
    const stageIdsBefore = stagesBeforeRes.rows.map((s) => s.id);
    assert.ok(stageIdsBefore.length >= 2, 'Expected pipeline stages to exist before upgrade');

    const roundCreate = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        pipeline_id: defaultPipeline.id,
        name: 'Vòng Chia Enterprise B2B',
        priority: 1,
        is_active: true,
        consultants: [{ user_id: tenantA.ownerId, receive_ratio: 1, data_per_turn: 1 }],
      },
    });
    assert.equal(roundCreate.status, 201);
    const createdRoundId = roundCreate.json.data.id;

    const leadCreate = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Khách Hàng Bảo Toàn Dữ Liệu',
        phone: '0912345678',
        email: 'preserve@enterprise.vn',
        source: 'Website Organic',
        product_interest: 'Gói Giải pháp Enterprise ERP',
        stage_id: stageIdsBefore[0],
        force_assigned_to: tenantA.ownerId,
      },
    });
    assert.equal(leadCreate.status, 201);
    const preservedLeadId = leadCreate.json.data.lead_id || leadCreate.json.data.id;
    assert.ok(preservedLeadId);

    // Perform 1-click upgrade from `autodata_crm` -> `domation_promax` (`DOM ERP`)
    const upgradeRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/package-entitlements/upgrade', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        package_code: 'domation_promax',
        education_addon: false,
        note: 'Upgrade /data CRM -> DOM ERP',
      },
    });
    assert.equal(upgradeRes.status, 200);
    assert.equal(upgradeRes.json.data.upgraded, true);
    assert.equal(upgradeRes.json.data.zero_migration_preserved, true);
    assert.equal(upgradeRes.json.data.previous_package, 'autodata_crm');
    assert.equal(upgradeRes.json.data.current_package, 'domation_promax');
    assert.equal(upgradeRes.json.data.education_addon, false);

    // Verify leads, distribution rounds, and pipeline stages remain 100% preserved on same tenant_id
    await withTenantTransaction(tenantA.id, async (client) => {
      const [leadRow, roundRow, stageRows] = await Promise.all([
        client.query<{ id: string; name: string; stage_id: string; product_interest: string }>(
          'SELECT id, name, stage_id, product_interest FROM leads WHERE tenant_id = $1 AND id = $2',
          [tenantA.id, preservedLeadId]
        ),
        client.query<{ id: string; name: string }>(
          'SELECT id, name FROM distribution_rounds WHERE tenant_id = $1 AND id = $2',
          [tenantA.id, createdRoundId]
        ),
        client.query<{ id: string }>(
          'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC',
          [tenantA.id]
        ),
      ]);
      assert.equal(leadRow.rows.length, 1);
      assert.equal(leadRow.rows[0].name, 'Khách Hàng Bảo Toàn Dữ Liệu');
      assert.equal(leadRow.rows[0].stage_id, stageIdsBefore[0]);
      assert.equal(roundRow.rows.length, 1);
      assert.equal(roundRow.rows[0].name, 'Vòng Chia Enterprise B2B');
      assert.deepEqual(
        stageRows.rows.map((r) => r.id),
        stageIdsBefore
      );
    });
  });

  it('2. Meta Ads Overview with 0 accounts returns HTTP 200 configured:false & zero hardcodes; Multi-Account CRUD, Discover & Sync with dynamic stages', async () => {
    // a) 0 accounts -> HTTP 200 configured:false and zero legacy hardcodes
    const emptyOverview = await apiRequest(harness.baseUrl, '/api/v1/myerp/marketing/meta/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(emptyOverview.status, 200);
    assert.equal(emptyOverview.json.data.configured, false);
    assert.deepEqual(emptyOverview.json.data.accounts, []);
    assert.deepEqual(emptyOverview.json.data.stage_breakdown, []);
    assert.equal(emptyOverview.json.data.summary.account_id, '');
    assert.equal(emptyOverview.json.data.summary.total_leads, 0);
    const serializedEmpty = JSON.stringify(emptyOverview.json);
    assert.ok(!serializedEmpty.includes('MBA 577'), 'Zero MBA 577 hardcode allowed');
    assert.ok(!serializedEmpty.includes('1852318231510577'), 'Zero 1852318231510577 hardcode allowed');
    assert.ok(!serializedEmpty.includes('EAAUZC'), 'Zero EAAUZC hardcode allowed');

    // b) Mock Meta Graph API via test hook -> Discover & Sync
    setMetaGraphFetcherForTesting(async (url: string) => {
      if (url.includes('/me?fields=')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: '99887766', name: 'DOM Enterprise BM' }),
        };
      }
      if (url.includes('/me/adaccounts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'act_700100200300',
                account_id: '700100200300',
                name: 'DOM Brand Growth 01',
                account_status: 1,
                currency: 'VND',
                adspixels: { data: [{ id: '111222333444', name: 'DOM Pixel 01' }] },
              },
              {
                id: 'act_800100200400',
                account_id: '800100200400',
                name: 'DOM Performance 02',
                account_status: 1,
                currency: 'VND',
                adspixels: { data: [{ id: '555666777888', name: 'DOM Pixel 02' }] },
              },
            ],
          }),
        };
      }
      if (url.includes('/act_700100200300/ads')) {
        const today = new Date().toISOString().slice(0, 10);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'ad_700_1',
                name: 'Video Enterprise Demo 01',
                campaign: { id: 'cmp_700_1', name: 'Camp B2B Q4', objective: 'LEAD_GENERATION' },
                adset: { id: 'as_700_1', name: 'AdSet CEO/COO', optimization_goal: 'LEAD_GENERATION' },
                creative: { id: 'cr_1', title: 'DOM ERP Trial', body: 'Optimize Ops' },
                insights: {
                  data: [
                    {
                      spend: '1500000',
                      impressions: '25000',
                      clicks: '620',
                      reach: '18000',
                      ctr: '2.48',
                      cpc: '2419',
                      cpm: '60000',
                      frequency: '1.39',
                      date_start: today,
                      date_stop: today,
                      actions: [{ action_type: 'lead', value: '12' }],
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      if (url.includes('/act_800100200400/ads')) {
        const today = new Date().toISOString().slice(0, 10);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'ad_800_1',
                name: 'Carousel CRM Automation',
                campaign: { id: 'cmp_800_1', name: 'Camp CRM Funnel', objective: 'LEAD_GENERATION' },
                adset: { id: 'as_800_1', name: 'AdSet SMB Founders', optimization_goal: 'LEAD_GENERATION' },
                creative: { id: 'cr_2', title: 'AutoData Sync', body: 'Fair Share' },
                insights: {
                  data: [
                    {
                      spend: '900000',
                      impressions: '15000',
                      clicks: '300',
                      reach: '11000',
                      ctr: '2.00',
                      cpc: '3000',
                      cpm: '60000',
                      frequency: '1.36',
                      date_start: today,
                      date_stop: today,
                      actions: [{ action_type: 'lead', value: '8' }],
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });

    try {
      const discoverRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/meta/discover', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { access_token: 'TEST_TOKEN_VALID_99999999' },
      });
      assert.equal(discoverRes.status, 200);
      assert.equal(discoverRes.json.data.success, true);
      assert.equal(discoverRes.json.data.ad_accounts.length, 2);
      assert.equal(discoverRes.json.data.pixels.length, 2);

      // Save 2 Meta Ad Accounts
      const saveAcc1 = await apiRequest(harness.baseUrl, '/api/v1/myerp/meta/accounts', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'DOM Brand Growth 01',
          ad_account_id: 'act_700100200300',
          access_token: 'TEST_TOKEN_ACC_1_XYZ12345',
          pixel_id: '111222333444',
          is_active: true,
        },
      });
      assert.equal(saveAcc1.status, 200);
      createdMetaAccount1Id = saveAcc1.json.data.account.id;

      const saveAcc2 = await apiRequest(harness.baseUrl, '/api/v1/myerp/meta/accounts', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          name: 'DOM Performance 02',
          ad_account_id: '800100200400',
          access_token: 'TEST_TOKEN_ACC_2_XYZ67890',
          pixel_id: '555666777888',
          is_active: true,
        },
      });
      assert.equal(saveAcc2.status, 200);
      createdMetaAccount2Id = saveAcc2.json.data.account.id;

      const listAccs = await apiRequest(harness.baseUrl, '/api/v1/myerp/meta/accounts', {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      });
      assert.equal(listAccs.status, 200);
      assert.equal(listAccs.json.data.total_accounts, 2);
      assert.equal(listAccs.json.data.accounts.length, 2);

      // Sync both accounts
      const syncAll = await apiRequest(harness.baseUrl, '/api/v1/myerp/meta/sync', {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {},
      });
      assert.equal(syncAll.status, 200);
      assert.equal(syncAll.json.data.success, true);
      assert.equal(syncAll.json.data.synced_ads, 2);

      // Toggle account 2 OFF -> ON
      const toggleOff = await apiRequest(
        harness.baseUrl,
        `/api/v1/myerp/meta/accounts/${createdMetaAccount2Id}/toggle`,
        {
          method: 'POST',
          token: tenantA.token,
          tenantSlug: tenantA.slug,
          body: { is_active: false },
        }
      );
      assert.equal(toggleOff.status, 200);
      assert.equal(toggleOff.json.data.account.is_active, false);

      const toggleOn = await apiRequest(
        harness.baseUrl,
        `/api/v1/myerp/meta/accounts/${createdMetaAccount2Id}/toggle`,
        {
          method: 'POST',
          token: tenantA.token,
          tenantSlug: tenantA.slug,
          body: { is_active: true },
        }
      );
      assert.equal(toggleOn.status, 200);
      assert.equal(toggleOn.json.data.account.is_active, true);
    } finally {
      setMetaGraphFetcherForTesting(null);
    }

    // Seed attributed CRM leads across dynamic pipeline stages (entry, qualified, won)
    const stageRows = await withTenantTransaction(tenantA.id, async (client) => {
      const sRes = await client.query<{
        id: string;
        stage_key: string;
        stage_name: string;
        funnel_category: string;
        is_won_stage: boolean;
      }>(
        'SELECT id, stage_key, stage_name, funnel_category, is_won_stage FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC',
        [tenantA.id]
      );
      const entryStage = sRes.rows[0];
      const wonStage = sRes.rows.find((s) => s.is_won_stage || s.funnel_category === 'closed_won') || sRes.rows[sRes.rows.length - 1];
      const qualStage =
        sRes.rows.find((s) => !s.is_won_stage && s.id !== entryStage.id && s.funnel_category !== 'closed_lost') ||
        entryStage;

      await client.query(
        `INSERT INTO leads (
           id, tenant_id, name, phone, email, source, campaign, campaign_id, adset_id, ad_id,
           stage_id, assigned_to, is_accepted, status, lead_score, total_revenue_vnd
         ) VALUES
         ($1, $2, 'Lead Meta Entry', '0909111001', 'meta1@alpha.vn', 'Facebook Ads', 'Camp B2B Q4', 'cmp_700_1', 'as_700_1', 'ad_700_1', $3, $4, true, 'assigned', 45, 0),
         ($5, $2, 'Lead Meta Won', '0909111002', 'meta2@alpha.vn', 'Facebook Ads', 'Camp B2B Q4', 'cmp_700_1', 'as_700_1', 'ad_700_1', $6, $4, true, 'assigned', 95, 25000000),
         ($7, $2, 'Lead Meta Qual 2', '0909111003', 'meta3@alpha.vn', 'Facebook Ads', 'Camp CRM Funnel', 'cmp_800_1', 'as_800_1', 'ad_800_1', $8, $4, false, 'assigned', 60, 0)`,
        [
          crypto.randomUUID(),
          tenantA.id,
          entryStage.id,
          tenantA.ownerId,
          crypto.randomUUID(),
          wonStage.id,
          crypto.randomUUID(),
          qualStage.id,
        ]
      );
      return sRes.rows;
    });

    // Query overview for ALL accounts
    const overviewAll = await apiRequest(
      harness.baseUrl,
      '/api/v1/myerp/marketing/meta/overview?ad_account_id=all&date_range=30days',
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(overviewAll.status, 200);
    assert.equal(overviewAll.json.data.configured, true);
    assert.equal(overviewAll.json.data.accounts.length, 2);
    assert.equal(overviewAll.json.data.summary.spend, 2400000);
    assert.equal(overviewAll.json.data.summary.total_leads, 4);
    assert.equal(overviewAll.json.data.summary.paid_leads, 3);
    assert.equal(overviewAll.json.data.summary.organic_leads, 1);
    assert.equal(overviewAll.json.data.summary.won_stage_leads, 1);
    assert.equal(overviewAll.json.data.summary.actual_revenue, 25000000);
    assert.equal(overviewAll.json.data.stage_breakdown.length, stageRows.length);

    // Query overview filtered to account 1 only (`700100200300`)
    const overviewAcc1 = await apiRequest(
      harness.baseUrl,
      '/api/v1/myerp/marketing/meta/overview?ad_account_id=700100200300&date_range=30days',
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(overviewAcc1.status, 200);
    assert.equal(overviewAcc1.json.data.summary.account_id, '700100200300');
    assert.equal(overviewAcc1.json.data.summary.spend, 1500000);
    assert.equal(overviewAcc1.json.data.summary.total_leads, 2);

    // Delete account 2 (`DELETE /meta/accounts/:id`) and verify remaining count = 1
    const delAcc2 = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/meta/accounts/${createdMetaAccount2Id}`,
      {
        method: 'DELETE',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(delAcc2.status, 200);
    assert.equal(delAcc2.json.data.summary.total_accounts, 1);
  });

  it('3. Unified Schema Registry (/schema/condition-fields) & Segment Builder + Flow Condition alias parity', async () => {
    // Seed custom_fields in tenants.settings and verify education group is hidden when education_addon=false
    await withTenantTransaction(tenantA.id, async (client) => {
      const tRes = await client.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE id = $1', [tenantA.id]);
      const cur = typeof tRes.rows[0]?.settings === 'object' && tRes.rows[0]?.settings ? (tRes.rows[0].settings as Record<string, unknown>) : {};
      const next = {
        ...cur,
        custom_fields: [
          {
            key: 'company_size',
            label: 'Quy mô Nhân sự',
            type: 'select',
            options: [
              { value: '10-50', label: '10-50 nhân sự' },
              { value: '50-200', label: '50-200 nhân sự' },
            ],
          },
          { key: 'industry_sector', label: 'Ngành nghề', type: 'text' },
        ],
      };
      await client.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [tenantA.id, JSON.stringify(next)]);
    });

    const schemaNoEdu = await apiRequest(harness.baseUrl, '/api/v1/myerp/schema/condition-fields', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(schemaNoEdu.status, 200);
    const d1 = schemaNoEdu.json.data;
    assert.equal(d1.education_enabled, false);
    const groupIds1 = d1.groups.map((g: any) => g.id);
    assert.ok(groupIds1.includes('profile'));
    assert.ok(groupIds1.includes('crm_pipeline'));
    assert.ok(groupIds1.includes('deals_revenue'));
    assert.ok(groupIds1.includes('behavior'));
    assert.ok(groupIds1.includes('custom_fields'));
    assert.ok(!groupIds1.includes('education'), 'Education group must be hidden when education_addon is false');
    assert.ok(d1.fields.some((f: any) => f.key === 'cf.company_size'));
    assert.ok(Array.isArray(d1.dynamic_options.stages) && d1.dynamic_options.stages.length > 0);
    assert.ok(Array.isArray(d1.dynamic_options.users) && d1.dynamic_options.users.length > 0);

    // Enable education_addon -> Education group must appear!
    const upEduOn = await apiRequest(harness.baseUrl, '/api/v1/myerp/package-entitlements/upgrade', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax', education_addon: true },
    });
    assert.equal(upEduOn.status, 200);
    assert.equal(upEduOn.json.data.education_addon, true);

    const schemaWithEdu = await apiRequest(harness.baseUrl, '/api/v1/myerp/schema/condition-fields', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(schemaWithEdu.status, 200);
    assert.equal(schemaWithEdu.json.data.education_enabled, true);
    assert.ok(schemaWithEdu.json.data.groups.some((g: any) => g.id === 'education'));

    // Disable education_addon again to return tenantA to clean non-education state
    const upEduOff = await apiRequest(harness.baseUrl, '/api/v1/myerp/package-entitlements/upgrade', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: { package_code: 'domation_promax', education_addon: false },
    });
    assert.equal(upEduOff.status, 200);

    // Seed a rich lead with custom_fields + won deal value for Segment AST + Flow Condition tests
    const stageId = d1.dynamic_options.stages[0].value;
    await withTenantTransaction(tenantA.id, async (client) => {
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, name, phone, email, status, stage_id, assigned_to,
           lead_score, total_revenue_vnd, custom_fields
         ) VALUES (
           $1, $2, 'Pham Enterprise VIP', '0988777666', 'vip@enterprise.vn',
           'assigned', $3, $4, 88, 120000000, $5::jsonb
         )`,
        [
          crypto.randomUUID(),
          tenantA.id,
          stageId,
          tenantA.ownerId,
          JSON.stringify({
            firstName: 'VIP',
            lastName: 'Pham Enterprise',
            company_size: '50-200',
            temperature: 'hot',
          }),
        ]
      );
    });

    // Test Segment Preview using frontend alias keys
    const segPreview = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'phoneNumber', operator: 'contains', value: '0988777' },
              { field: 'crm_stage_id', operator: 'is', value: stageId },
              { field: 'crm_lead_status', operator: 'is', value: 'active' },
              { field: 'crm_temperature', operator: 'is', value: 'hot' },
              { field: 'crm_owner_id', operator: 'is', value: tenantA.ownerId },
              { field: 'erp_deal_value', operator: 'gte', value: 100000000 },
              { field: 'leadScore', operator: 'gte', value: 80 },
              { field: 'lastActivityDays', operator: 'lte', value: 7 },
              { field: 'cf.company_size', operator: 'equals', value: '50-200' },
            ],
          },
        ],
      },
    });
    assert.equal(segPreview.status, 200);
    assert.equal(segPreview.json.data.count, 1);

    // Create Dynamic Segment via compat `/api/v1/myerp/segments`
    const createSeg = await apiRequest(harness.baseUrl, '/api/v1/myerp/segments', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Tệp VIP Alias Parity',
        audience_type: 'dynamic_logic',
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'custom_fields.company_size', operator: 'equals', value: '50-200' },
              { field: 'salesperson', operator: 'is', value: tenantA.ownerId },
            ],
          },
        ],
      },
    });
    assert.equal(createSeg.status, 201);
    customSegmentId = createSeg.json.data.id;
    assert.ok(customSegmentId);

    // Test Flow creation & simulation with alias condition keys
    const createFlow = await apiRequest(harness.baseUrl, '/api/v1/myerp/flows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Flow Kiểm Tra Điều Kiện Hợp Nhất',
        trigger_type: 'form_submitted',
        steps: [
          {
            id: 'cond_1',
            type: 'if_else_condition',
            label: 'Check VIP Alias',
            config: {
              conditionGroup: {
                logic: 'AND',
                conditions: [
                  { field: 'firstName', operator: 'contains', value: 'VIP' },
                  { field: 'crm_lead_status', operator: 'is', value: 'active' },
                  { field: 'erp_deal_value', operator: 'gte', value: 50000000 },
                  { field: 'leadScore', operator: 'gte', value: 80 },
                  { field: 'cf.company_size', operator: 'equals', value: '50-200' },
                ],
              },
            },
            yesStepId: 'push_1',
            noStepId: null,
          },
          {
            id: 'push_1',
            type: 'push_to_autodata_sale_round',
            label: 'Đẩy Sale',
            config: {},
            nextStepId: null,
          },
        ],
      },
    });
    assert.equal(createFlow.status, 201);
    const flowId = createFlow.json.data.id;

    const simFlow = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${flowId}/simulate`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        sample_lead: {
          name: 'VIP Pham',
          status: 'assigned',
          lead_score: 90,
          total_revenue_vnd: 80000000,
          custom_fields: { firstName: 'VIP', company_size: '50-200' },
        },
      },
    });
    assert.equal(simFlow.status, 200);
    assert.equal(simFlow.json.data.wouldPushToSaleRound, true);
  });

  it('4. Zero-Hardcode Dynamic N-Step Workflows & Custom Categories (no auto-reseed once deleted)', async () => {
    // 1. Delete all starter workflows -> switch to custom mode
    const clearRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/approvals/workflows/all', {
      method: 'DELETE',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.json.data.cleared, true);

    // 2. Re-querying overview & workflows must return 0 active workflows (NEVER auto-reseed!)
    const overviewAfterClear = await apiRequest(harness.baseUrl, '/api/v1/myerp/approvals/overview', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(overviewAfterClear.status, 200);
    assert.equal(overviewAfterClear.json.data.summary.active_workflows, 0);

    const listAfterClear = await apiRequest(harness.baseUrl, '/api/v1/myerp/approvals/workflows', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(listAfterClear.status, 200);
    assert.equal(
      listAfterClear.json.data.filter((w: any) => w.is_active !== false).length,
      0,
      'Must never auto-reseed starter workflows after delete/custom mode'
    );

    // 3. Create arbitrary Custom Category (testing dropped category CHECK constraint!)
    const createCat = await apiRequest(harness.baseUrl, '/api/v1/myerp/approvals/categories', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        key: customCategoryKey,
        label: 'Mua sắm Thiết bị IT',
        color: '#0284C7',
        description: 'Quy trình mua sắm laptop/server nội bộ',
      },
    });
    assert.equal(createCat.status, 201);
    assert.equal(createCat.json.data.category.key, customCategoryKey);

    const listCats = await apiRequest(harness.baseUrl, '/api/v1/myerp/approvals/categories', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(listCats.status, 200);
    assert.ok(listCats.json.data.some((c: any) => c.key === customCategoryKey));

    // 4. Create Dynamic N-Step Custom Workflow under the arbitrary custom category
    const createWf = await apiRequest(harness.baseUrl, '/api/v1/myerp/approvals/workflows', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Đề xuất Mua sắm Hạ tầng Cloud',
        category: customCategoryKey,
        category_label: 'Mua sắm Thiết bị IT',
        color_hex: '#1E40FF',
        default_watcher_ids: [tenantA.ownerId],
        form_schema: [
          { key: 'vendor_name', label: 'Nhà cung cấp', type: 'text', required: true },
          { key: 'budget_vnd', label: 'Dự toán (VNĐ)', type: 'currency', required: true },
        ],
        steps: [
          {
            step_order: 1,
            step_name: 'Trưởng nhóm IT duyệt kỹ thuật',
            approver_type: 'direct_manager',
            min_amount_threshold: 0,
            approval_mode: 'any_one',
            sla_hours: 12,
          },
          {
            step_order: 2,
            step_name: 'Giám đốc duyệt ngân sách > 20tr',
            approver_type: 'specific_user',
            approver_user_id: tenantA.ownerId,
            min_amount_threshold: 20000000,
            approval_mode: 'any_one',
            require_signature: true,
            sla_hours: 24,
          },
        ],
      },
    });
    assert.equal(createWf.status, 201);
    customWorkflowId = createWf.json.data.id;
    assert.equal(createWf.json.data.category, customCategoryKey);
    assert.equal(createWf.json.data.steps.length, 2);
    assert.deepEqual(createWf.json.data.default_watcher_ids, [tenantA.ownerId]);

    // Simulate dynamic N-step resolution (below vs above 20M threshold)
    const simLow = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/approvals/workflows/${customWorkflowId}/simulate`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { amount_vnd: 5000000 },
      }
    );
    assert.equal(simLow.status, 200);
    assert.equal(simLow.json.data.steps.length, 1);

    const simHigh = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/approvals/workflows/${customWorkflowId}/simulate`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { amount_vnd: 35000000 },
      }
    );
    assert.equal(simHigh.status, 200);
    assert.equal(simHigh.json.data.steps.length, 2);

    // 5. Explicit optional preset import works cleanly on demand
    const importPresets = await apiRequest(
      harness.baseUrl,
      '/api/v1/myerp/approvals/workflows/import-presets',
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { codes: ['WF_OVERTIME_REQUEST'] },
      }
    );
    assert.equal(importPresets.status, 201);
    assert.equal(importPresets.json.data.imported_count, 1);

    // Delete imported preset and confirm our custom workflow remains while deleted preset stays gone
    const importedId = importPresets.json.data.items[0].id;
    const delWf = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/approvals/workflows/${importedId}`,
      {
        method: 'DELETE',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(delWf.status, 200);

    // Tenant B isolation check on Tenant A's custom workflow
    const crossList = await apiRequest(harness.baseUrl, '/api/v1/myerp/approvals/workflows', {
      token: tenantB.token,
      tenantSlug: tenantB.slug,
    });
    assert.equal(crossList.status, 200);
    assert.ok(!crossList.json.data.some((w: any) => w.id === customWorkflowId));
  });

  it('5. Marketing compat & PHP endpoints return 200 OK (zero 401/500 across /api/v1/myerp and /backend)', async () => {
    const endpoints = [
      '/api/v1/myerp/campaigns',
      '/api/v1/myerp/marketing/campaigns',
      '/api/v1/myerp/ses_quota',
      '/api/v1/myerp/ses_quota.php',
      '/api/v1/myerp/marketing/ses_quota',
      '/api/v1/myerp/automation/campaigns.php',
      '/api/v1/myerp/automation/ses_quota.php',
      '/api/v1/myerp/automation/flows.php',
      '/api/v1/myerp/automation/templates.php',
      '/api/v1/myerp/automation/segments.php',
      '/api/v1/myerp/automation/lists.php',
      '/api/v1/myerp/automation/tags.php',
      '/api/v1/myerp/flows',
      '/api/v1/myerp/templates',
      '/api/v1/myerp/segments',
      '/api/v1/myerp/lists',
      '/api/v1/myerp/subscribers',
      '/api/v1/myerp/forms',
      '/api/v1/myerp/surveys',
      '/api/v1/myerp/voucher_campaigns',
      '/api/v1/myerp/links_qr',
      '/api/v1/myerp/web_tracking',
      '/api/v1/myerp/zalo_oa',
      '/backend/ses_quota',
      '/backend/campaigns',
      '/backend/automation/campaigns.php',
    ];

    for (const path of endpoints) {
      const res = await apiRequest(harness.baseUrl, path, {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      });
      assert.equal(res.status, 200, `Expected 200 OK on ${path}, got ${res.status}: ${JSON.stringify(res.json)}`);
    }

    // Verify PHP route mutation & `?id=` query forwarding works too (e.g. GET /automation/segments.php?id=...)
    const segDetailPhp = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/automation/segments.php?id=${encodeURIComponent(customSegmentId)}`,
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(segDetailPhp.status, 200);
    assert.equal(segDetailPhp.json.data.id, customSegmentId);
  });

  it('6. SSE chat/stream & get_sse_updates serve text/event-stream via ?token= query auth and /contacts returns live stage_counts', async () => {
    const readSseFirstEvent = async (urlPath: string, expectedEvent: string) => {
      const ac = new AbortController();
      try {
        const resp = await fetch(`${harness.baseUrl}${urlPath}`, {
          method: 'GET',
          signal: ac.signal,
        });
        assert.equal(resp.status, 200, `Expected 200 on ${urlPath}, got ${resp.status}`);
        const ct = String(resp.headers.get('content-type') || '');
        assert.ok(ct.includes('text/event-stream'), `Expected text/event-stream on ${urlPath}, got "${ct}"`);

        const reader = resp.body?.getReader();
        assert.ok(reader, `Expected readable SSE stream on ${urlPath}`);
        const { value } = await reader.read();
        const chunkText = Buffer.from(value || new Uint8Array()).toString('utf8');
        assert.ok(chunkText.includes(`event: ${expectedEvent}`), `Expected "event: ${expectedEvent}" in SSE chunk, got: ${chunkText}`);
        await reader.cancel().catch(() => {});
      } finally {
        ac.abort();
      }
    };

    const qToken = encodeURIComponent(tenantA.token);
    await readSseFirstEvent(`/backend/api.php?action=chat/stream&token=${qToken}`, 'connected');
    await readSseFirstEvent(`/backend/api.php?action=get_sse_updates&token=${qToken}`, 'update');
    await readSseFirstEvent(`/backend/chat/stream?token=${qToken}`, 'connected');
    await readSseFirstEvent(`/backend/get_sse_updates?token=${qToken}`, 'update');

    // Verify /api/v1/myerp/contacts returns non-zero live stage_counts & handles non-UUID stage filters cleanly
    const contactsRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/contacts', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(contactsRes.status, 200);
    const sc = contactsRes.json.data?.stage_counts || contactsRes.json?.stage_counts;
    assert.ok(sc && typeof sc === 'object', 'Expected stage_counts object on /api/v1/myerp/contacts');
    assert.ok(Number(sc.all || 0) >= 5, `Expected at least 5 leads in stage_counts.all, got ${sc.all}`);
    assert.ok(Number(sc.won || 0) >= 1, `Expected at least 1 won lead in stage_counts.won, got ${sc.won}`);

    for (const nonUuidStage of ['nurture', 'lost']) {
      const filteredRes = await apiRequest(
        harness.baseUrl,
        `/api/v1/myerp/contacts?stage_id=${encodeURIComponent(nonUuidStage)}`,
        {
          token: tenantA.token,
          tenantSlug: tenantA.slug,
        }
      );
      assert.equal(filteredRes.status, 200, `Expected 200 OK on stage_id=${nonUuidStage}, got ${filteredRes.status}`);
    }
  });

  it('7. Templates camelCase bodyStyle/htmlContent + /acl, /subscribers?status=all unwrap, and Segment preview aliases', async () => {
    // a) Create template using camelCase payload (`bodyStyle`, `htmlContent`) and verify GET /templates + /acl
    const tplCreate = await apiRequest(harness.baseUrl, '/api/v1/myerp/templates', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'Enterprise Welcome CamelCase',
        subject: 'Chào mừng đến với DOM ERP',
        bodyStyle: { backgroundColor: '#f8fafc', fontFamily: "'Inter', sans-serif" },
        htmlContent: '<html><body><h1>Hello DOM ERP</h1></body></html>',
        blocks: [],
      },
    });
    assert.equal(tplCreate.status, 201);
    const tplId = tplCreate.json.data.id;
    assert.ok(tplId);
    assert.equal(typeof tplCreate.json.data.bodyStyle, 'object');
    assert.equal(typeof tplCreate.json.data.htmlContent, 'string');

    const tplList = await apiRequest(harness.baseUrl, '/api/v1/myerp/templates', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(tplList.status, 200);
    const tplItems = Array.isArray(tplList.json.data?.items)
      ? tplList.json.data.items
      : Array.isArray(tplList.json.data)
        ? tplList.json.data
        : [];
    assert.ok(tplItems.length >= 1, 'Expected at least 1 template returned from GET /api/v1/myerp/templates');
    for (const item of tplItems) {
      assert.equal(typeof item.bodyStyle, 'object', 'Expected camelCase bodyStyle object on every template');
      assert.ok(item.bodyStyle !== null, 'Expected non-null bodyStyle');
      assert.equal(typeof item.htmlContent, 'string', 'Expected camelCase htmlContent string on every template');
    }

    const aclRes = await apiRequest(harness.baseUrl, `/api/v1/myerp/templates/${tplId}/acl`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(aclRes.status, 200);

    // b) /subscribers?status=all&verified=all&has_chat=all&sort=newest must match unfiltered total (> 0)
    const subUnfiltered = await apiRequest(harness.baseUrl, '/api/v1/myerp/subscribers?page=1&limit=100', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(subUnfiltered.status, 200);
    const expectedTotal = Number(subUnfiltered.json.data?.pagination?.total ?? subUnfiltered.json.data?.items?.length ?? 0);
    assert.ok(expectedTotal >= 5, `Expected unfiltered subscribers total >= 5, got ${expectedTotal}`);

    const subWithAll = await apiRequest(
      harness.baseUrl,
      '/api/v1/myerp/subscribers?page=1&limit=100&status=all&verified=all&has_chat=all&sort=newest',
      {
        token: tenantA.token,
        tenantSlug: tenantA.slug,
      }
    );
    assert.equal(subWithAll.status, 200);
    const subItems = subWithAll.json.data?.items || [];
    const subTotal = Number(subWithAll.json.data?.pagination?.total ?? subItems.length);
    assert.ok(subTotal > 0, `Expected total > 0 with status=all, got ${subTotal}`);
    assert.ok(subItems.length > 0, `Expected items.length > 0 with status=all, got ${subItems.length}`);
    assert.equal(subTotal, expectedTotal, 'Expected status=all&verified=all&has_chat=all total to match unfiltered total');

    // c) Segment preview aliases: POST /segments?action=preview & POST /segments.php?route=estimate
    const previewBody = {
      criteria: JSON.stringify([
        {
          join: 'AND',
          rules: [{ field: 'leadScore', operator: 'gte', value: 80 }],
        },
      ]),
      include_crm_contacts: true,
    };

    const preview1 = await apiRequest(harness.baseUrl, '/api/v1/myerp/segments?action=preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: previewBody,
    });
    assert.equal(preview1.status, 200);
    assert.equal(typeof preview1.json.data?.count, 'number');
    assert.ok(preview1.json.data.count >= 2, `Expected numeric data.count >= 2, got ${preview1.json.data?.count}`);

    const preview2 = await apiRequest(harness.baseUrl, '/api/v1/myerp/segments.php?route=estimate', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: previewBody,
    });
    assert.equal(preview2.status, 200);
    assert.equal(typeof preview2.json.data?.count, 'number');
    assert.equal(preview2.json.data.count, preview1.json.data.count);
  });
});
