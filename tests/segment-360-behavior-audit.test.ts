import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import { ensureMarketingSchema } from '../server/modules/marketing/schema.ts';
import { ensureCrm360Schema } from '../server/modules/crm-360/schema.ts';
import { ensureErpOpsSchema } from '../server/modules/erp-ops/schema.ts';
import { compileSegmentWhereSql } from '../server/modules/audiences/segment-compiler.ts';

describe('Team 3 Audit: Full-Field Segment Compiler, Audience Analytics/Split/Merge & Customer 360 Ad-Attribution + Behavior', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string; userId: string };
  let tenantB: { id: string; slug: string; token: string; userId: string };

  let stageWonId = '';
  let stageNewId = '';
  let roundId = '';
  let leadVipId = '';
  let leadWebId = '';
  let leadColdId = '';
  let leadSuppressedId = '';
  let leadTenantBId = '';

  let listAlphaId = '';
  let listBetaId = '';
  let campaignId = '';
  let flowId = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();
    await ensureMarketingSchema();
    await ensureErpOpsSchema();
    await ensureCrm360Schema();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Alpha Growth Labs',
        tenant_slug: 'alpha-seg-360',
        admin_name: 'Alpha Owner',
        work_email: 'owner@alpha-seg360.vn',
        phone: '0901112201',
        password: 'SecurePassword123!',
        industry: 'agency',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
      userId: regA.json.data.user.id,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Beta Rival Corp',
        tenant_slug: 'beta-seg-360',
        admin_name: 'Beta Owner',
        work_email: 'owner@beta-seg360.vn',
        phone: '0909998802',
        password: 'SecurePassword123!',
        industry: 'agency',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
      userId: regB.json.data.user.id,
    };

    // Upgrade both tenants to Package 4 (`domation_promax`)
    for (const t of [tenantA, tenantB]) {
      await withTenantTransaction(t.id, async (client) => {
        await client.query('UPDATE tenants SET wallet_balance_vnd = 20000000 WHERE id = $1', [t.id]);
      });
      const sw = await apiRequest(harness.baseUrl, '/api/v1/workspace/package', {
        method: 'POST',
        token: t.token,
        tenantSlug: t.slug,
        body: { package_code: 'domation_promax', education_addon: false },
      });
      assert.equal(sw.status, 200);
    }

    // Seed rich multi-layer dataset in Tenant A
    await withTenantTransaction(tenantA.id, async (client) => {
      const stagesRes = await client.query<{ id: string; is_won_stage: boolean }>(
        'SELECT id, is_won_stage FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC',
        [tenantA.id]
      );
      stageNewId = stagesRes.rows[0].id;
      stageWonId = stagesRes.rows.find((s) => s.is_won_stage)?.id || stagesRes.rows[stagesRes.rows.length - 1].id;

      const pipeRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC LIMIT 1',
        [tenantA.id]
      );
      const pipeId = pipeRes.rows[0].id;

      roundId = crypto.randomUUID();
      await client.query(
        `INSERT INTO distribution_rounds (id, tenant_id, pipeline_id, name, priority, is_active)
         VALUES ($1, $2, $3, 'Vòng Sale VIP HCM', 1, true)`,
        [roundId, tenantA.id, pipeId]
      );

      // Lead 1: VIP Meta Ad + Deal + Web Behavior + Email + Flow + Survey + Voucher + Social
      leadVipId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, pipeline_id, stage_id, assigned_to, round_id,
           status, lifecycle_stage, name, phone, email, lead_score,
           email_consent, zns_consent, total_revenue_vnd, last_engaged_at,
           source, campaign, product_interest, utm_source, utm_medium, utm_content,
           ad_id, adset_id, campaign_id, fbclid, quality_status, custom_fields
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           'assigned', 'opportunity', 'Tran Quang Minh VIP', '84901234001', 'minh.vip@alpha.vn', 88,
           'subscribed', 'opted_in', 75000000, clock_timestamp(),
           'Facebook Ads', 'Q4_Enterprise_Scale', 'Domation ERP ProMax', 'facebook', 'paid_social', 'video_hook_a',
           'ad_meta_9001', 'adset_meta_8001', 'camp_meta_7001', 'IwAR3_test_fbclid_99', 'Hot', $7::jsonb
         )`,
        [
          leadVipId,
          tenantA.id,
          pipeId,
          stageWonId,
          tenantA.userId,
          roundId,
          JSON.stringify({
            vip_tier: 'platinum',
            annual_budget: 250000000,
            city: 'Hồ Chí Minh',
            gender: 'male',
            utm_campaign: 'Q4_Enterprise_Scale',
            ad_name: 'Video Demo ERP 60s',
            adset_name: 'Lookalike CEO HCM 2%',
          }),
        ]
      );

      // Meta Ads Insight row for Lead 1
      await client.query(
        `INSERT INTO meta_ads_insights (
           id, tenant_id, date_start, date_stop, campaign_id, campaign_name,
           adset_id, adset_name, ad_id, ad_name, spend, impressions, clicks,
           thumbnail_url, creative_title
         ) VALUES (
           $1, $2, CURRENT_DATE - 3, CURRENT_DATE, 'camp_meta_7001', 'Q4 Enterprise Scale Meta',
           'adset_meta_8001', 'Lookalike CEO HCM 2%', 'ad_meta_9001', 'Video Demo ERP 60s',
           5000000, 120000, 2400, 'https://cdn.example.com/ad-thumb.jpg', 'Tự động hóa ERP & Marketing'
         )`,
        [crypto.randomUUID(), tenantA.id]
      );

      // Deal for Lead 1 (80M VND, negotiation)
      await client.query(
        `INSERT INTO tenant_deals (
           id, tenant_id, deal_code, title, lead_id, owner_user_id, stage, amount_vnd, probability
         ) VALUES ($1, $2, 'DEAL-VIP-01', 'Triển khai ERP 100 Users', $3, $4, 'negotiation', 80000000, 80)`,
        [crypto.randomUUID(), tenantA.id, leadVipId, tenantA.userId]
      );

      // Lead 2: High-intent Web visitor (Pricing page + CTA click + 85% scroll)
      leadWebId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, pipeline_id, stage_id, assigned_to,
           status, lifecycle_stage, name, phone, email, lead_score,
           email_consent, zns_consent, total_revenue_vnd, last_engaged_at,
           source, campaign, utm_source, utm_medium, custom_fields
         ) VALUES (
           $1, $2, $3, $4, $5,
           'marketing_nurture', 'mql', 'Nguyen Thao Web Intent', '84901234002', 'thao.web@alpha.vn', 62,
           'subscribed', 'opted_in', 0, clock_timestamp(),
           'Google Organic', 'SEO_Pricing_2026', 'google', 'organic', $6::jsonb
         )`,
        [
          leadWebId,
          tenantA.id,
          pipeId,
          stageNewId,
          null,
          JSON.stringify({
            vip_tier: 'gold',
            annual_budget: 60000000,
            city: 'Hà Nội',
            gender: 'female',
            utm_campaign: 'SEO_Pricing_2026',
          }),
        ]
      );

      // Lead 3: Cold Lead
      leadColdId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, pipeline_id, stage_id, status, lifecycle_stage,
           name, phone, email, lead_score, email_consent, zns_consent, source, custom_fields
         ) VALUES (
           $1, $2, $3, $4, 'marketing_nurture', 'subscriber',
           'Le Van Cold', '84901234003', 'cold@alpha.vn', 12, 'subscribed', 'opted_out', 'Import CSV', $5::jsonb
         )`,
        [
          leadColdId,
          tenantA.id,
          pipeId,
          stageNewId,
          JSON.stringify({ vip_tier: 'silver', annual_budget: 10000000, city: 'Đà Nẵng' }),
        ]
      );

      // Lead 4: Suppressed Lead
      leadSuppressedId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, status, lifecycle_stage,
           name, email, lead_score, email_consent, source, custom_fields
         ) VALUES (
           $1, $2, 'marketing_nurture', 'subscriber',
           'Pham Suppressed', 'suppressed@alpha.vn', 5, 'unsubscribed', 'Import CSV', '{}'::jsonb
         )`,
        [leadSuppressedId, tenantA.id]
      );

      // Web property, sessions & events for Lead 1 & Lead 2
      const propId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_web_properties (id, tenant_id, name, domain, site_key, pricing_url_pattern)
         VALUES ($1, $2, 'Domation Main Site', 'domation.vn', $3, '/pricing,/bang-gia')`,
        [propId, tenantA.id, `site_${crypto.randomUUID().slice(0, 12)}`]
      );

      const sessVipId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_web_sessions (
           id, tenant_id, property_id, visitor_token, lead_id, entry_url, last_url, referrer,
           utm_source, utm_medium, utm_campaign, device_type, browser, os,
           pageviews_count, duration_seconds, pricing_intent_detected
         ) VALUES (
           $1, $2, $3, 'vis_vip_1', $4, 'https://domation.vn/landing/erp-promax', 'https://domation.vn/bang-gia',
           'https://l.facebook.com/', 'facebook', 'paid_social', 'Q4_Enterprise_Scale', 'desktop', 'Chrome', 'Windows',
           5, 240, true
         )`,
        [sessVipId, tenantA.id, propId, leadVipId]
      );

      const sessWebId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_web_sessions (
           id, tenant_id, property_id, visitor_token, lead_id, entry_url, last_url, referrer,
           utm_source, utm_medium, utm_campaign, device_type, browser, os,
           pageviews_count, duration_seconds, pricing_intent_detected
         ) VALUES (
           $1, $2, $3, 'vis_web_2', $4, 'https://domation.vn/bang-gia', 'https://domation.vn/bang-gia',
           'https://www.google.com/', 'google', 'organic', 'SEO_Pricing_2026', 'mobile', 'Safari', 'iOS',
           3, 185, true
         )`,
        [sessWebId, tenantA.id, propId, leadWebId]
      );

      // Web events: pageviews, scroll, CTA clicks for Lead 1 & Lead 2
      await client.query(
        `INSERT INTO mkt_web_events (id, tenant_id, property_id, session_id, lead_id, event_type, page_url, scroll_depth_pct, metadata)
         VALUES
           ($1, $2, $3, $4, $5, 'pricing_intent', 'https://domation.vn/bang-gia', 92, '{"page_title":"Bảng giá ERP ProMax"}'::jsonb),
           ($6, $2, $3, $4, $5, 'click', 'https://domation.vn/bang-gia', 92, '{"cta_text":"Đăng ký Demo 1-1","href":"https://domation.vn/demo"}'::jsonb),
           ($7, $2, $3, $4, $5, 'click', 'https://domation.vn/bang-gia', 92, '{"cta_text":"Đăng ký Demo 1-1","href":"https://domation.vn/demo"}'::jsonb),
           ($8, $2, $3, $9, $10, 'pricing_intent', 'https://domation.vn/bang-gia', 85, '{"page_title":"Bảng giá ERP ProMax"}'::jsonb),
           ($11, $2, $3, $9, $10, 'click', 'https://domation.vn/bang-gia', 85, '{"cta_text":"Nhận báo giá ngay","href":"https://domation.vn/quote"}'::jsonb)`,
        [
          crypto.randomUUID(),
          tenantA.id,
          propId,
          sessVipId,
          leadVipId,
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          sessWebId,
          leadWebId,
          crypto.randomUUID(),
        ]
      );

      // Campaign + Send Claims for Lead 1
      campaignId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status)
         VALUES ($1, $2, 'Email Ra mắt ProMax Q4', 'email', 'sent')`,
        [campaignId, tenantA.id]
      );
      await client.query(
        `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, status, sent_at, opened_at, clicked_at)
         VALUES ($1, $2, $3, $4, 'email', 'clicked', clock_timestamp(), clock_timestamp(), clock_timestamp())`,
        [crypto.randomUUID(), tenantA.id, campaignId, leadVipId]
      );

      // Flow + Enrollment (completed for VIP, active for Web)
      flowId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_flows (id, tenant_id, name, status, trigger_type)
         VALUES ($1, $2, 'Flow Nuôi dưỡng Enterprise', 'active', 'form_submitted')`,
        [flowId, tenantA.id]
      );
      await client.query(
        `INSERT INTO mkt_flow_enrollments (id, tenant_id, flow_id, lead_id, status, completed_at)
         VALUES
           ($1, $2, $3, $4, 'completed', clock_timestamp()),
           ($5, $2, $3, $6, 'active', NULL)`,
        [crypto.randomUUID(), tenantA.id, flowId, leadVipId, crypto.randomUUID(), leadWebId]
      );

      // Survey response (Promoter NPS 10, score 95) for Lead 1
      const surveyId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_surveys (id, tenant_id, title, slug, survey_type)
         VALUES ($1, $2, 'Khảo sát nhu cầu ERP', 'erp-nps-audit', 'nps')`,
        [surveyId, tenantA.id]
      );
      await client.query(
        `INSERT INTO mkt_survey_responses (id, tenant_id, survey_id, lead_id, quiz_score, nps_score)
         VALUES ($1, $2, $3, $4, 95, 10)`,
        [crypto.randomUUID(), tenantA.id, surveyId, leadVipId]
      );

      // Voucher claimed for Lead 1
      const vCampId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_voucher_campaigns (id, tenant_id, name, slug, discount_type, discount_value)
         VALUES ($1, $2, 'Voucher VIP 20%', 'vip-20-audit', 'percentage', 20)`,
        [vCampId, tenantA.id]
      );
      await client.query(
        `INSERT INTO mkt_voucher_codes (id, tenant_id, voucher_campaign_id, code, status, lead_id, claimed_at)
         VALUES ($1, $2, $3, 'DOM-VIP20-001', 'claimed', $4, clock_timestamp())`,
        [crypto.randomUUID(), tenantA.id, vCampId, leadVipId]
      );

      // Social conversation + messages for Lead 1 (messenger)
      const convId = crypto.randomUUID();
      await client.query(
        `INSERT INTO mkt_social_conversations (id, tenant_id, channel, external_thread_id, customer_name, lead_id, last_message_preview)
         VALUES ($1, $2, 'messenger', 'fb_thread_vip_1', 'Tran Quang Minh VIP', $3, 'Cho anh xin báo giá gói ProMax')`,
        [convId, tenantA.id, leadVipId]
      );
      await client.query(
        `INSERT INTO mkt_social_messages (id, tenant_id, conversation_id, sender_type, content)
         VALUES
           ($1, $2, $3, 'customer', 'Cho anh xin báo giá gói ProMax'),
           ($4, $2, $3, 'bot', 'Dạ em gửi anh bảng giá chi tiết ạ!')`,
        [crypto.randomUUID(), tenantA.id, convId, crypto.randomUUID()]
      );
    });

    // Seed identical-matching decoy lead in Tenant B to prove ZERO cross-tenant leakage!
    await withTenantTransaction(tenantB.id, async (client) => {
      leadTenantBId = crypto.randomUUID();
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, status, lifecycle_stage, name, phone, email, lead_score,
           source, campaign, utm_source, custom_fields
         ) VALUES (
           $1, $2, 'assigned', 'opportunity', 'Rival Secret VIP', '84909998899', 'secret@rival.vn', 99,
           'Facebook Ads', 'Q4_Enterprise_Scale', 'facebook', $3::jsonb
         )`,
        [
          leadTenantBId,
          tenantB.id,
          JSON.stringify({ vip_tier: 'platinum', annual_budget: 999000000, utm_campaign: 'Q4_Enterprise_Scale' }),
        ]
      );
    });
  });

  after(async () => {
    await harness.close();
  });

  it('1. Discovers dynamic JSONB custom_fields in GET /audiences/condition-schema and compiles ALL CRM + Ad + Web + Behavior fields safely with zero cross-tenant leakage', async () => {
    const schemaRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/condition-schema', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(schemaRes.status, 200);
    const sd = schemaRes.json.data;
    assert.ok(sd.groups.some((g: any) => g.id === 'ad_attribution'));
    assert.ok(sd.groups.some((g: any) => g.id === 'web_behavior'));
    assert.ok(sd.groups.some((g: any) => g.id === 'engagement_social'));
    assert.ok(sd.custom_field_keys.includes('custom.vip_tier'), 'Must discover sampled custom.vip_tier JSONB key');
    assert.ok(sd.custom_field_keys.includes('custom.annual_budget'), 'Must discover sampled custom.annual_budget JSONB key');
    assert.ok(sd.dynamic_options.rounds.length >= 1, 'Must expose distribution rounds');
    assert.ok(sd.dynamic_options.campaigns.length >= 1, 'Must expose campaigns');
    assert.ok(sd.dynamic_options.flows.length >= 1, 'Must expose flows');

    // (a) Dynamic custom_fields + SQL injection safety check
    const sqlInjCompiled = compileSegmentWhereSql(tenantA.id, [
      { field: "custom.vip_tier'; DROP TABLE leads;--", operator: 'equals', value: 'platinum' },
    ]);
    assert.ok(sqlInjCompiled.whereClause.includes('1 = 0'), 'Unsafe custom key must be rejected safely');

    const cfPrev = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'custom.vip_tier', operator: 'in', value: ['platinum', 'gold'] },
              { field: 'custom.annual_budget', operator: 'gte', value: 50000000 },
            ],
          },
        ],
      },
    });
    assert.equal(cfPrev.status, 200);
    assert.equal(cfPrev.json.data.count, 2);
    const cfIds = cfPrev.json.data.items.map((x: any) => x.id);
    assert.ok(cfIds.includes(leadVipId));
    assert.ok(cfIds.includes(leadWebId));
    assert.ok(!cfIds.includes(leadTenantBId), 'Zero cross-tenant leakage from Tenant B');

    // (b) CRM stage_id + assigned_to + round_id + deal_stage + deal_value + utm_campaign + ad_name + fbclid_present
    const crmAdPrev = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'crm_stage_id', operator: 'is', value: stageWonId },
              { field: 'assigned_to', operator: 'is', value: tenantA.userId },
              { field: 'round_id', operator: 'is', value: roundId },
              { field: 'has_deal', operator: 'is_true' },
              { field: 'deal_stage', operator: 'is', value: 'negotiation' },
              { field: 'deal_value', operator: 'gte', value: 50000000 },
              { field: 'utm_campaign', operator: 'equals', value: 'Q4_Enterprise_Scale' },
              { field: 'ad_name', operator: 'contains', value: 'Video Demo ERP' },
              { field: 'fbclid_present', operator: 'is_true' },
              { field: 'opened_campaign', operator: 'is', value: campaignId },
              { field: 'completed_flow', operator: 'is', value: flowId },
              { field: 'nps_category', operator: 'is', value: 'promoter' },
              { field: 'voucher_claimed', operator: 'has_done', value: 'any' },
              { field: 'social_channel', operator: 'is', value: 'messenger' },
            ],
          },
        ],
      },
    });
    assert.equal(crmAdPrev.status, 200);
    assert.equal(crmAdPrev.json.data.count, 1);
    assert.equal(crmAdPrev.json.data.items[0].id, leadVipId);

    // (c) Compound AND/OR branches: (web_clicked_cta='Nhận báo giá ngay' AND web_max_scroll_pct>=80) OR (is_suppressed=true)
    const compoundPrev = await apiRequest(harness.baseUrl, '/api/v1/audiences/preview', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        filter_branches: [
          {
            join: 'AND',
            rules: [
              { field: 'web_clicked_cta', operator: 'contains', value: 'Nhận báo giá' },
              { field: 'web_max_scroll_pct', operator: 'gte', value: 80 },
              { field: 'web_pricing_intent', operator: 'is_true' },
              { field: 'web_device_type', operator: 'is', value: 'mobile' },
              { field: 'in_flow', operator: 'is', value: flowId },
            ],
          },
          {
            join: 'AND',
            rules: [{ field: 'is_suppressed', operator: 'is_true' }],
          },
        ],
      },
    });
    assert.equal(compoundPrev.status, 200);
    assert.equal(compoundPrev.json.data.count, 2);
    const compIds = compoundPrev.json.data.items.map((x: any) => x.id);
    assert.ok(compIds.includes(leadWebId), 'Branch 1 must match high-intent web visitor');
    assert.ok(compIds.includes(leadSuppressedId), 'Branch 2 must match suppressed lead');
    assert.ok(!compIds.includes(leadVipId));
    assert.ok(!compIds.includes(leadTenantBId));
  });

  it('2. Serves Meta-Report-Style GET /audiences/analytics, AI Segment Insights, and bug-free idempotent Split (%, Round-Robin, Count) & Merge (Union/Intersection/Subtract)', async () => {
    // Analytics overview
    const anaRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/analytics', {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(anaRes.status, 200);
    const ana = anaRes.json.data;
    assert.equal(ana.summary.total_contacts, 4);
    assert.equal(ana.summary.suppressed_count, 1);
    assert.ok(ana.channel_reach.length === 4);
    assert.ok(ana.top_sources.length >= 2);
    assert.ok(ana.top_ad_attribution.some((a: any) => a.campaign_name === 'Q4_Enterprise_Scale'));
    assert.ok(ana.pipeline_stages.length >= 1);
    assert.equal(ana.engagement_tiers.length, 4);
    assert.equal(ana.growth_trend_14d.length, 14);

    // Create Static List Alpha [VIP, Web, Cold] and Static List Beta [Web, Cold, Suppressed]
    const createAlpha = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'List Alpha',
        audience_type: 'static_data',
        lead_ids: [leadVipId, leadWebId, leadColdId],
      },
    });
    assert.equal(createAlpha.status, 201);
    listAlphaId = createAlpha.json.data.id;

    const createBeta = await apiRequest(harness.baseUrl, '/api/v1/audiences', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        name: 'List Beta',
        audience_type: 'static_data',
        lead_ids: [leadWebId, leadColdId, leadSuppressedId],
      },
    });
    assert.equal(createBeta.status, 201);
    listBetaId = createBeta.json.data.id;

    // AI Segment Insights on List Alpha
    const aiSegRes = await apiRequest(harness.baseUrl, `/api/v1/audiences/${listAlphaId}/ai-analyze`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {},
    });
    assert.equal(aiSegRes.status, 200);
    assert.ok(aiSegRes.json.data.headline.includes('List Alpha'));
    assert.ok(aiSegRes.json.data.recommended_actions.length >= 1);
    assert.equal(aiSegRes.json.data.source, 'statistical_engine');

    // Merge UNION (Alpha ∪ Beta => 4 unique, 2 duplicates removed)
    const unionRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/merge', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        operation: 'union',
        source_ids: [listAlphaId, listBetaId],
        merge_type: 'new',
        new_list_name: 'Merged Union A+B',
      },
    });
    assert.equal(unionRes.status, 201);
    assert.equal(unionRes.json.data.total_members, 4);
    assert.equal(unionRes.json.data.duplicates_removed, 2);

    // Idempotent repeat merge into existing target -> 0 new added, still 4 members
    const unionRepeat = await apiRequest(harness.baseUrl, '/api/v1/audiences/merge', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        operation: 'union',
        source_ids: [listAlphaId, listBetaId],
        merge_type: 'existing',
        target_id: unionRes.json.data.target_audience_id,
      },
    });
    assert.equal(unionRepeat.status, 201);
    assert.equal(unionRepeat.json.data.merged_count, 0);
    assert.equal(unionRepeat.json.data.total_members, 4);

    // Merge INTERSECTION (Alpha ∩ Beta => [Web, Cold] = 2)
    const interRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/merge', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        operation: 'intersection',
        source_ids: [listAlphaId, listBetaId],
        merge_type: 'new',
        new_list_name: 'Intersection A∩B',
      },
    });
    assert.equal(interRes.status, 201);
    assert.equal(interRes.json.data.total_members, 2);

    // Merge SUBTRACT (Alpha \ Beta => [VIP] = 1)
    const subRes = await apiRequest(harness.baseUrl, '/api/v1/audiences/merge', {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {
        operation: 'subtract',
        base_id: listAlphaId,
        source_ids: [listAlphaId, listBetaId],
        merge_type: 'new',
        new_list_name: 'Subtract A\\B',
      },
    });
    assert.equal(subRes.status, 201);
    assert.equal(subRes.json.data.total_members, 1);

    // Split 1: Percentage (75/25 on 4-member Union list => exact 3 + 1 = 4)
    const splitPct = await apiRequest(
      harness.baseUrl,
      `/api/v1/audiences/${unionRes.json.data.target_audience_id}/split`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { mode: 'percentage', ratios: [75, 25], deterministic: true, name_prefix: 'PctTest' },
      }
    );
    assert.equal(splitPct.status, 201);
    assert.equal(splitPct.json.data.created_audiences.length, 2);
    assert.equal(splitPct.json.data.created_audiences[0].cached_member_count, 3);
    assert.equal(splitPct.json.data.created_audiences[1].cached_member_count, 1);

    // Split 2: Round-Robin (3 parts on 4-member Union list => [2, 1, 1])
    const splitRR = await apiRequest(
      harness.baseUrl,
      `/api/v1/audiences/${unionRes.json.data.target_audience_id}/split`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: { mode: 'round_robin', parts: 3, name_prefix: 'RRTest' },
      }
    );
    assert.equal(splitRR.status, 201);
    assert.equal(splitRR.json.data.created_audiences.length, 3);
    const rrCounts = splitRR.json.data.created_audiences.map((a: any) => a.cached_member_count);
    assert.deepEqual(rrCounts, [2, 1, 1]);

    // Split 3: Count extraction with cleanup_invalid=true (excludes suppressed lead)
    const splitCnt = await apiRequest(
      harness.baseUrl,
      `/api/v1/audiences/${unionRes.json.data.target_audience_id}/split`,
      {
        method: 'POST',
        token: tenantA.token,
        tenantSlug: tenantA.slug,
        body: {
          mode: 'count',
          quantity: 10,
          strategy: 'top',
          cleanup_invalid: true,
          destination_name: 'Clean Top Split',
        },
      }
    );
    assert.equal(splitCnt.status, 201);
    assert.equal(splitCnt.json.data.total_split_members, 3, 'Must exclude 1 unsubscribed lead when cleanup_invalid=true');
  });

  it('3. Enriches GET /api/v1/crm-360/contacts/:id (and compat /myerp/contacts/:id) with real ad_attribution + behavior_analytics + POST ai-profile', async () => {
    const res360 = await apiRequest(harness.baseUrl, `/api/v1/crm-360/contacts/${leadVipId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(res360.status, 200);
    const d = res360.json.data;

    // Ad Attribution checks
    assert.ok(d.ad_attribution, 'Response must include top-level ad_attribution');
    assert.equal(d.ad_attribution.platform, 'meta');
    assert.equal(d.ad_attribution.campaign_name, 'Q4 Enterprise Scale Meta');
    assert.equal(d.ad_attribution.adset_name, 'Lookalike CEO HCM 2%');
    assert.equal(d.ad_attribution.ad_name, 'Video Demo ERP 60s');
    assert.equal(d.ad_attribution.utm_source, 'facebook');
    assert.equal(d.ad_attribution.utm_medium, 'paid_social');
    assert.equal(d.ad_attribution.utm_campaign, 'Q4_Enterprise_Scale');
    assert.equal(d.ad_attribution.landing_page, 'https://domation.vn/landing/erp-promax');
    assert.equal(d.ad_attribution.referrer, 'https://l.facebook.com/');
    assert.ok(d.ad_attribution.first_touch_at);

    // Behavior Analytics checks
    assert.ok(d.behavior_analytics, 'Response must include top-level behavior_analytics');
    const ba = d.behavior_analytics;
    assert.equal(ba.web_pageviews, 5);
    assert.equal(ba.web_clicks, 2);
    assert.equal(ba.max_scroll_pct, 92);
    assert.equal(ba.total_active_seconds, 240);
    assert.equal(ba.pricing_intent_hits, 1);
    assert.equal(ba.emails_sent, 1);
    assert.equal(ba.emails_opened, 1);
    assert.equal(ba.emails_clicked, 1);
    assert.equal(ba.flows_enrolled, 1);
    assert.equal(ba.social_messages, 2);
    assert.equal(ba.surveys_submitted, 1);
    assert.ok(ba.top_clicked_ctas.length >= 1);
    assert.equal(ba.top_clicked_ctas[0].text, 'Đăng ký Demo 1-1');
    assert.equal(ba.top_clicked_ctas[0].count, 2);
    assert.ok(ba.top_visited_pages.length >= 1);
    assert.equal(ba.engagement_timeline_7d.length, 7);
    assert.ok(ba.engagement_score >= 60 && ba.engagement_score <= 100);

    // Compat endpoint `/api/v1/myerp/contacts/:id` preserves ad_attribution & behavior_analytics!
    const resCompat = await apiRequest(harness.baseUrl, `/api/v1/myerp/contacts/${leadVipId}`, {
      token: tenantA.token,
      tenantSlug: tenantA.slug,
    });
    assert.equal(resCompat.status, 200);
    assert.equal(resCompat.json.data.ad_attribution.ad_name, 'Video Demo ERP 60s');
    assert.equal(resCompat.json.data.behavior_analytics.max_scroll_pct, 92);

    // AI Behavioral Profile endpoint
    const aiProf = await apiRequest(harness.baseUrl, `/api/v1/crm-360/contacts/${leadVipId}/ai-profile`, {
      method: 'POST',
      token: tenantA.token,
      tenantSlug: tenantA.slug,
      body: {},
    });
    assert.equal(aiProf.status, 200);
    assert.equal(aiProf.json.data.intent_level, 'very_high');
    assert.ok(aiProf.json.data.behavioral_signals.length >= 3);
    assert.ok(aiProf.json.data.next_best_actions.length >= 1);
    assert.equal(aiProf.json.data.source, 'deterministic_engine');
  });
});
