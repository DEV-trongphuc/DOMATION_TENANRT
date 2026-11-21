import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { createDatabasePool, setDatabasePool } from '../server/core/database/db-adapter.ts';
import { withSystemPrivilege, withTenantTransaction } from '../server/core/database/transaction.ts';
import { translatePostgresSqlToMariaDb } from '../server/core/database/sql-translator.ts';
import { encryptTenantSecret } from '../server/core/crypto/vault.ts';
import {
  LegacyUrlRewriter,
  migrateMyerpIdeas,
  remapFlowTriggerAndSteps,
} from '../scripts/migrate-myerp-ideas.ts';
import {
  isEphemeralCdnAvatarUrl,
  sanitizeAvatarUrl,
  stripEphemeralAvatarsFromCustomFields,
} from '../server/core/security/pii-masker.ts';

describe('Wave 5 Polish: MYERP Showcase Compat (AI Training C09p, Meta CAPI C12p, Forms C11p, Avatars C05p)', () => {
  let harness: TestHarness;
  let tenant: { id: string; slug: string; token: string; userId: string };
  const origSilent = process.env.OUTBOUND_SILENT_MODE;

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'MYERP Showcase Parity Edu',
        tenant_slug: 'myerp-parity-edu',
        admin_name: 'Admin Ideas',
        work_email: 'admin@myerp-parity.vn',
        phone: '0909123456',
        password: 'SecurePassword123!',
        industry: 'education',
        package_code: 'enterprise',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    tenant = {
      id: reg.json.data.tenant.id,
      slug: reg.json.data.tenant.slug,
      token: reg.json.data.access_token,
      userId: reg.json.data.user.id,
    };

    await withTenantTransaction(tenant.id, async (client) => {
      await client.query('UPDATE tenants SET wallet_balance_vnd = 50000000 WHERE id = $1', [tenant.id]);
    });

    const sw = await apiRequest(harness.baseUrl, '/api/v1/billing/switch-package', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      headers: { 'X-Idempotency-Key': `myerp-parity-upgrade-${Date.now()}` },
      body: { package_code: 'growth_combo', payment_method: 'wallet', billing_cycle: 'monthly' },
    });
    assert.equal(sw.status, 200);
  });

  after(async () => {
    await harness.close();
    if (origSilent === undefined) delete process.env.OUTBOUND_SILENT_MODE;
    else process.env.OUTBOUND_SILENT_MODE = origSilent;
  });

  it('1. AI Training Center (C09p): web_tracking?action=list & ai_training?action=list_docs compute accurate docs_count, queries_count & property filtering', async () => {
    const propChiefId = crypto.randomUUID();
    const propIdeasId = crypto.randomUUID();
    const docChief1 = crypto.randomUUID();
    const docChief2 = crypto.randomUUID();
    const docIdeas1 = crypto.randomUUID();
    const docBotFallback = crypto.randomUUID();

    await withSystemPrivilege(async (client) => {
      const tRes = await client.query<{ settings: Record<string, unknown> }>('SELECT settings FROM tenants WHERE id = $1', [
        tenant.id,
      ]);
      const curSettings = tRes.rows[0]?.settings || {};
      await client.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [
        tenant.id,
        JSON.stringify({
          ...curSettings,
          ai_training_property_stats: {
            '7ac8420d-b248-4ab5-a97d-0fd177e0ae64': { queries_count: 12 },
            'ce71ea2e-d841-4e0f-b3ad-332297cde330': { queries_count: 18 },
          },
        }),
      ]);
    });

    await withTenantTransaction(tenant.id, async (client) => {
      await client.query('DELETE FROM mkt_ai_training_docs WHERE tenant_id = $1', [tenant.id]);
      await client.query('DELETE FROM mkt_web_properties WHERE tenant_id = $1', [tenant.id]);
      await client.query("DELETE FROM mkt_social_conversations WHERE tenant_id = $1 AND channel = 'web_chat'", [
        tenant.id,
      ]);

      await client.query(
        `INSERT INTO mkt_web_properties (id, tenant_id, name, domain, site_key, is_active)
         VALUES
           ($1, $3, 'Chief AI Officer', 'ai.ideas.edu.vn', 'wp_ideas_7ac8420d-b248-4ab5-a97d-0fd177e0ae64', true),
           ($2, $3, 'IDEAS.EDU.VN', 'ideas.edu.vn', 'wp_ideas_ce71ea2e-d841-4e0f-b3ad-332297cde330', true)`,
        [propChiefId, propIdeasId, tenant.id]
      );

      await client.query(
        `INSERT INTO mkt_ai_training_docs (id, tenant_id, title, doc_type, content_text, status, metadata_json)
         VALUES
           ($1, $5, 'Giáo trình Chief AI', 'pdf', 'Nội dung tài liệu Chief AI Officer', 'indexed', '{"property_id":"7ac8420d-b248-4ab5-a97d-0fd177e0ae64","tags":["AI","Executive"]}'::jsonb),
           ($2, $5, 'FAQ Học phí Chief AI', 'faq', 'Học phí chương trình Executive AI', 'indexed', '{"property_id":"7ac8420d-b248-4ab5-a97d-0fd177e0ae64"}'::jsonb),
           ($3, $5, 'Tuyển sinh MBA IDEAS', 'url', 'Điều kiện tuyển sinh MBA tại IDEAS.EDU.VN', 'indexed', '{"property_id":"ce71ea2e-d841-4e0f-b3ad-332297cde330"}'::jsonb),
           ($4, $5, 'Quy chế Chatbot Chung', 'manual', 'Tài liệu hướng dẫn chung chatbot', 'indexed', '{"property_id":"chatbot_699eadd924298"}'::jsonb)`,
        [docChief1, docChief2, docIdeas1, docBotFallback, tenant.id]
      );

      // Seed 30 web_chat conversations matching savedPropStats total (12 + 18 = 30)
      for (let i = 0; i < 30; i++) {
        await client.query(
          `INSERT INTO mkt_social_conversations (id, tenant_id, channel, external_thread_id, customer_name, status)
           VALUES ($1, $2, 'web_chat', $3, $4, 'open')`,
          [crypto.randomUUID(), tenant.id, `ai_conv_${i}`, `Visitor ${i}`]
        );
      }
    });

    const wtRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/web_tracking?action=list', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(wtRes.status, 200);
    assert.equal(wtRes.json.success, true);
    const props = wtRes.json.data as Array<Record<string, any>>;
    assert.equal(props.length, 2);

    const chief = props.find((p) => p.id === propChiefId);
    const ideas = props.find((p) => p.id === propIdeasId);
    assert.ok(chief, 'Chief AI Officer property present');
    assert.ok(ideas, 'IDEAS.EDU.VN property present');
    assert.equal(chief.ai_enabled, true);
    assert.equal(chief.stats.docs_count, 2);
    assert.equal(chief.stats.queries_count, 12);
    assert.equal(ideas.stats.docs_count, 2); // docIdeas1 + fallback chatbot_699eadd924298
    assert.equal(ideas.stats.queries_count, 18);

    const listPropsRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/ai_training?action=list_properties', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(listPropsRes.status, 200);
    assert.equal(listPropsRes.json.data.length, 2);

    const chiefDocsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/ai_training?action=list_docs&property_id=${propChiefId}`,
      { token: tenant.token, tenantSlug: tenant.slug }
    );
    assert.equal(chiefDocsRes.status, 200);
    assert.equal(chiefDocsRes.json.data.items.length, 2);
    assert.equal(chiefDocsRes.json.data.items[0].status, 'trained');

    const searchDocsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/ai_training?action=list_docs&property_id=${propChiefId}&search=${encodeURIComponent('Học phí')}`,
      { token: tenant.token, tenantSlug: tenant.slug }
    );
    assert.equal(searchDocsRes.status, 200);
    assert.equal(searchDocsRes.json.data.items.length, 1);
    assert.equal(searchDocsRes.json.data.items[0].name, 'FAQ Học phí Chief AI');

    // Also verify native /api/v1/marketing/social-bot/training-docs resolves property UUID -> legacy property_id + chatbot_* bucket
    const [sbChiefRes, sbIdeasRes] = await Promise.all([
      apiRequest(harness.baseUrl, `/api/v1/marketing/social-bot/training-docs?property_id=${propChiefId}`, {
        token: tenant.token,
        tenantSlug: tenant.slug,
      }),
      apiRequest(harness.baseUrl, `/api/v1/marketing/social-bot/training-docs?property_id=${propIdeasId}`, {
        token: tenant.token,
        tenantSlug: tenant.slug,
      }),
    ]);
    assert.equal(sbChiefRes.status, 200);
    assert.equal(sbChiefRes.json.data.items.length, 2);
    assert.equal(sbIdeasRes.status, 200);
    assert.equal(sbIdeasRes.json.data.items.length, 2);
  });

  it('2. Meta CAPI (C12p): /api/v1/myerp/capi/settings, /capi/logs, /capi/test, /capi/adsets & MariaDB parity', async () => {
    const stage1Id = crypto.randomUUID();
    const stage2Id = crypto.randomUUID();
    const leadId = crypto.randomUUID();
    const failLeadId = crypto.randomUUID();
    const encCapi = encryptTenantSecret(tenant.id, {
      dataset_id: '583807401361847',
      access_token: 'EAA_TEST_SHOWCASE_TOKEN_123456',
      secondary_dataset_id: '661260709828887',
      dual_send: true,
      quality_min_stage: 'needed',
      source_mode: 'all_quality',
    });

    await withSystemPrivilege(async (client) => {
      const tRes = await client.query<{ settings: Record<string, unknown> }>('SELECT settings FROM tenants WHERE id = $1', [
        tenant.id,
      ]);
      const curSettings = tRes.rows[0]?.settings || {};
      await client.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [
        tenant.id,
        JSON.stringify({
          ...curSettings,
          meta_pixel_id: '583807401361847',
          meta_web_pixel_id: '661260709828887',
          meta_ad_account_id: '1852318231510577',
          capi_source_mode: 'all_quality',
          capi_quality_min_stage: 'needed',
          capi_dual_pixel_enabled: '1',
          capi_event_triggers: JSON.stringify({ needed: 'Lead', enrolled: 'Purchase' }),
        }),
      ]);
    });

    await withTenantTransaction(tenant.id, async (client) => {
      await client.query(
        `INSERT INTO tenant_integrations (id, tenant_id, integration_type, config_encrypted, iv, auth_tag, status)
         VALUES ($1, $2, 'meta_capi', $3, $4, $5, 'active')
         ON CONFLICT (tenant_id, integration_type) DO UPDATE SET
           config_encrypted = EXCLUDED.config_encrypted,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           status = 'active'`,
        [crypto.randomUUID(), tenant.id, encCapi.configEncrypted, encCapi.iv, encCapi.authTag]
      );

      const pipRes = await client.query<{ id: string }>(
        `SELECT id FROM tenant_pipelines WHERE tenant_id = $1 LIMIT 1`,
        [tenant.id]
      );
      let pipelineId = pipRes.rows[0]?.id;
      if (!pipelineId) {
        pipelineId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_pipelines (id, tenant_id, name, is_default) VALUES ($1, $2, 'Default', true)`,
          [pipelineId, tenant.id]
        );
      }

      await client.query(
        `INSERT INTO tenant_pipeline_stages (id, tenant_id, pipeline_id, stage_key, stage_name, stage_order, color_hex, is_won_stage, is_lost_stage, capi_event_mapping)
         VALUES
           ($1, $3, $4, 'needed', '04 - Needed', 3, '#22c55e', false, false, 'Lead'),
           ($2, $3, $4, 'enrolled', '14 - Enrolled', 13, '#10b981', true, false, 'Purchase')`,
        [stage1Id, stage2Id, tenant.id, pipelineId]
      );

      await client.query(
        `INSERT INTO leads (id, tenant_id, pipeline_id, stage_id, name, phone, email, source, total_revenue_vnd, meta_lead_id)
         VALUES
           ($1, $3, $4, $5, 'Học viên Thành Công', '+84912345678', 'vip@ideas.vn', 'Facebook Ads - Form', 85000000, '2223154331914269'),
           ($2, $3, $4, $5, 'Học viên Lỗi Mạng', '+84912345999', 'fail@ideas.vn', 'Web Form', 0, NULL)`,
        [leadId, failLeadId, tenant.id, pipelineId, stage2Id]
      );

      await client.query(
        `INSERT INTO capi_logs (id, tenant_id, lead_id, dataset_id, event_name, event_id, action_source, match_keys, sent_payload, response_status, response_body)
         VALUES
           ($1, $4, $5, '583807401361847', 'Purchase', 'ev_purchase_1', 'system_generated',
            '{"emq_signals":7,"trigger_stage":"enrolled"}'::jsonb,
            '{"data":[{"event_name":"Purchase","custom_data":{"value":85000000,"currency":"VND","crm_stage":"enrolled"},"user_data":{"ph":["a"],"em":["b"]}}]}'::jsonb,
            200, '{"events_received":1,"fbtrace_id":"TRACE_OK_1"}'::jsonb),
           ($2, $4, $5, '583807401361847', 'Lead', 'ev_lead_1', 'system_generated',
            '{"emq_signals":5,"trigger_stage":"needed"}'::jsonb,
            '{"data":[{"event_name":"Lead","custom_data":{"crm_stage":"needed"},"user_data":{"ph":["a"],"em":["b"]}}]}'::jsonb,
            200, '{"events_received":1}'::jsonb),
           ($3, $4, $6, '583807401361847', 'Lead', 'ev_fail_1', 'system_generated',
            '{"emq_signals":4,"trigger_stage":"needed"}'::jsonb,
            '{"data":[{"event_name":"Lead","user_data":{"ph":["c"]}}]}'::jsonb,
            500, '{"error":{"message":"Graph timeout"}}'::jsonb)`,
        [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), tenant.id, leadId, failLeadId]
      );

      await client.query(
        `INSERT INTO meta_ads_insights (id, tenant_id, ad_account_id, date_start, date_stop, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, optimization_goal)
         VALUES ($1, $2, '1852318231510577', '2026-11-01', '2026-11-15', 'cmp_1', 'EMBA Fall', 'adset_9001', 'Lookalike EMBA 2%', 'ad_1', 'Video Ad 1', 1200000, 'LEAD_GENERATION')`,
        [crypto.randomUUID(), tenant.id]
      );
    });

    const setRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/capi/settings', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.json.data.meta_pixel_id, '583807401361847');
    assert.equal(setRes.json.data.meta_web_pixel_id, '661260709828887');
    assert.equal(setRes.json.data.capi_dual_pixel_enabled, true);
    assert.equal(setRes.json.data.capi_event_triggers.enrolled, 'Purchase');
    assert.equal(setRes.json.data.pipeline_stages.length >= 2, true);

    const logsAllRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/capi/logs?limit=150&status=all', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(logsAllRes.status, 200);
    assert.equal(logsAllRes.json.data.logs.length, 3);
    assert.equal(logsAllRes.json.data.summary.total_events, 3);
    assert.equal(logsAllRes.json.data.summary.success_events, 2);
    assert.equal(logsAllRes.json.data.summary.failed_events, 1);
    assert.equal(logsAllRes.json.data.summary.purchase_value_vnd, 85000000);
    assert.equal(logsAllRes.json.data.summary.avg_emq_signals, 5.3);
    assert.equal(typeof logsAllRes.json.data.logs[0].sent_payload, 'string');
    assert.equal(typeof logsAllRes.json.data.logs[0].response_body, 'string');

    const logsFailRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/capi/logs?limit=150&status=failed', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(logsFailRes.status, 200);
    assert.equal(logsFailRes.json.data.logs.length, 1);
    assert.equal(logsFailRes.json.data.summary.total_events, 3);

    const adsetsRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/capi/adsets', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(adsetsRes.status, 200);
    assert.equal(adsetsRes.json.data.adsets.length, 1);
    assert.equal(adsetsRes.json.data.adsets[0].phone_farm_excluded, false);

    const shieldRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/capi/adsets/adset_9001/exclude-phone-farm', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {},
    });
    assert.equal(shieldRes.status, 200);
    assert.equal(shieldRes.json.data.phone_farm_excluded, true);

    const adsetsAfterRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/capi/adsets', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(adsetsAfterRes.json.data.adsets[0].phone_farm_excluded, true);

    const testRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/capi/test', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: { pixel_type: 'crm', pixel_id: '583807401361847', event_name: 'Lead' },
    });
    assert.equal(testRes.status, 200);
    assert.equal(testRes.json.data.meta_http_status, 200);

    // MariaDB translator sanity check for CAPI aggregate SQL
    const mariaCountsSql = translatePostgresSqlToMariaDb(`
      SELECT COUNT(*) AS total_events,
             COALESCE(SUM(CASE WHEN response_status >= 200 AND response_status < 300 THEN 1 ELSE 0 END), 0) AS success_events
      FROM capi_logs WHERE tenant_id = $1
    `);
    assert.ok(!mariaCountsSql.sql.includes('FILTER'), 'Must not contain PG-only FILTER clause');
    assert.ok(!mariaCountsSql.sql.includes('::int'), 'Must not contain PG ::int cast');
  });

  it('3. Forms Compat & Aliasing (C11p): targetListId, targetListName, submissionCount fallback & toggle_status', async () => {
    const audId = crypto.randomUUID();
    const formLegacyId = crypto.randomUUID();

    await withTenantTransaction(tenant.id, async (client) => {
      await client.query(
        `INSERT INTO tenant_audiences (id, tenant_id, name, audience_type, is_active)
         VALUES ($1, $2, 'Form Webinar Audience', 'static_data', true)`,
        [audId, tenant.id]
      );

      await client.query(
        `INSERT INTO mkt_forms (id, tenant_id, name, public_token, status, routing_mode, target_audience_id, fields_json, submission_count)
         VALUES ($1, $2, 'Form Webinar', 'tok_webinar_1', 'active', 'marketing_nurture', $3, '[]'::jsonb, 0)`,
        [formLegacyId, tenant.id, audId]
      );

      // Seed 3 leads pointing to form_id='Form Webinar' without incrementing mkt_forms.submission_count
      for (let i = 0; i < 3; i++) {
        await client.query(
          `INSERT INTO leads (id, tenant_id, name, phone, email, form_id)
           VALUES ($1, $2, $3, $4, $5, 'Form Webinar')`,
          [crypto.randomUUID(), tenant.id, `Lead W ${i}`, `+8498000000${i}`, `leadw${i}@ideas.vn`]
        );
      }
    });

    const listRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/forms', {
      token: tenant.token,
      tenantSlug: tenant.slug,
    });
    assert.equal(listRes.status, 200);
    const items = listRes.json.data.items as Array<Record<string, any>>;
    const webForm = items.find((f) => f.id === formLegacyId);
    assert.ok(webForm, 'Form Webinar returned');
    assert.equal(webForm.targetListId, audId);
    assert.equal(webForm.target_list_id, audId);
    assert.equal(webForm.targetListName, 'Form Webinar Audience');
    assert.equal(webForm.submissionCount, 3);
    assert.equal(webForm.submission_count, 3);
    assert.equal(webForm.stats.submissions, 3);

    const createRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/forms', {
      method: 'POST',
      token: tenant.token,
      tenantSlug: tenant.slug,
      body: {
        name: 'ISTEC Landing Form',
        targetListId: audId,
        fields: [
          { id: 'f1', key: 'name', label: 'Họ tên', type: 'text', required: true },
          { id: 'f2', key: 'email', dbField: 'email', label: 'Email', type: 'email', required: true },
        ],
      },
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.json.data.targetListId, audId);
    assert.equal(createRes.json.data.targetListName, 'Form Webinar Audience');

    const createdId = createRes.json.data.id;
    const toggleRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/forms?route=toggle_status&id=${encodeURIComponent(createdId)}`,
      {
        method: 'POST',
        token: tenant.token,
        tenantSlug: tenant.slug,
        body: { status: 'paused' },
      }
    );
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.json.data.status, 'paused');
  });

  it('4. Ephemeral Facebook/Zalo CDN Avatar Sanitization (C05p): strips lookaside/fbcdn/zadn URLs on unit & API responses', async () => {
    assert.equal(
      isEphemeralCdnAvatarUrl('https://platform-lookaside.fbsbx.com/platform/profilepic/?psid=123'),
      true
    );
    assert.equal(isEphemeralCdnAvatarUrl('https://scontent.fsgn2-4.fna.fbcdn.net/v/t1.jpg'), true);
    assert.equal(isEphemeralCdnAvatarUrl('https://s120-ava-talk.zadn.vn/6/4/7/f.jpg'), true);
    assert.equal(isEphemeralCdnAvatarUrl('https://graph.facebook.com/123456/picture?type=large'), true);
    assert.equal(sanitizeAvatarUrl('https://platform-lookaside.fbsbx.com/abc'), null);
    assert.equal(sanitizeAvatarUrl('/imgs/logo.png'), '/imgs/logo.png');

    const cleanedCf = stripEphemeralAvatarsFromCustomFields({
      program: 'MBA',
      custom_attributes: {
        avatar: 'https://s120-ava-talk.zadn.vn/6/4/7/f.jpg',
        fb_avatar: 'https://scontent.xx.fbcdn.net/v/pic.jpg',
        referrer: 'https://ideas.edu.vn',
      },
    });
    assert.equal((cleanedCf.custom_attributes as Record<string, unknown>).avatar, undefined);
    assert.equal((cleanedCf.custom_attributes as Record<string, unknown>).fb_avatar, undefined);
    assert.equal((cleanedCf.custom_attributes as Record<string, unknown>).referrer, 'https://ideas.edu.vn');

    const badLeadId = crypto.randomUUID();
    const audId = crypto.randomUUID();
    await withTenantTransaction(tenant.id, async (client) => {
      await client.query(
        `INSERT INTO leads (id, tenant_id, name, phone, email, custom_fields)
         VALUES ($1, $2, 'Nguyễn Hương Thuỷ', '+84909111222', 'nt@ideas.vn', $3::jsonb)`,
        [
          badLeadId,
          tenant.id,
          JSON.stringify({
            custom_attributes: {
              avatar: 'https://platform-lookaside.fbsbx.com/platform/profilepic/?psid=999',
            },
          }),
        ]
      );
      await client.query(
        `INSERT INTO tenant_audiences (id, tenant_id, name, audience_type, is_active)
         VALUES ($1, $2, 'Avatar Audit Aud', 'static_data', true)`,
        [audId, tenant.id]
      );
      await client.query(
        `INSERT INTO tenant_audience_members (id, tenant_id, audience_id, lead_id, source_type)
         VALUES ($1, $2, $3, $4, 'manual')`,
        [crypto.randomUUID(), tenant.id, audId, badLeadId]
      );
    });

    const [subsRes, subDetailRes, contactsRes, membersRes] = await Promise.all([
      apiRequest(harness.baseUrl, '/api/v1/myerp/subscribers?search=Thu%E1%BB%B7', {
        token: tenant.token,
        tenantSlug: tenant.slug,
      }),
      apiRequest(harness.baseUrl, `/api/v1/myerp/subscribers/${badLeadId}`, {
        token: tenant.token,
        tenantSlug: tenant.slug,
      }),
      apiRequest(harness.baseUrl, '/api/v1/audiences/contacts?limit=50', {
        token: tenant.token,
        tenantSlug: tenant.slug,
      }),
      apiRequest(harness.baseUrl, `/api/v1/audiences/${audId}/members`, {
        token: tenant.token,
        tenantSlug: tenant.slug,
      }),
    ]);

    assert.equal(subsRes.status, 200);
    assert.equal(subDetailRes.status, 200);
    assert.equal(contactsRes.status, 200);
    assert.equal(membersRes.status, 200);

    for (const payload of [subsRes.json, subDetailRes.json, contactsRes.json, membersRes.json]) {
      assert.ok(
        !JSON.stringify(payload).includes('lookaside.fbsbx.com'),
        'Response must strip ephemeral CDN avatar URL'
      );
    }
  });
});

describe('Wave 5 Polish: End-to-End migrateMyerpIdeas Mini-SQL Fixture', () => {
  it('migrates AI Training stats, Form audience/submission fallbacks, clean avatars & strict F8 on isolated dump', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autodata-myerp-minitest-'));
    const sqlPath = path.join(tmpRoot, 'mini_myerp.sql');
    const dataDir = path.join(tmpRoot, 'pgdata');
    const origSilent = process.env.OUTBOUND_SILENT_MODE;
    process.env.OUTBOUND_SILENT_MODE = 'true';

    const miniSql = `
CREATE TABLE \`tenants\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`name\` varchar(255) NOT NULL,
  \`slug\` varchar(100) NOT NULL,
  \`plan\` enum('free','pro','enterprise') NOT NULL DEFAULT 'free',
  \`logo_url\` text DEFAULT NULL,
  \`primary_color\` varchar(20) DEFAULT '#BD1D2D',
  \`currency\` char(3) DEFAULT 'VND',
  \`timezone\` varchar(50) DEFAULT 'Asia/Ho_Chi_Minh',
  \`is_active\` tinyint(1) NOT NULL DEFAULT 1,
  \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp()
);
INSERT INTO \`tenants\` VALUES (1,'IDEAS Test','ideas','enterprise',NULL,'#BD1D2D','VND','Asia/Ho_Chi_Minh',1,'2026-01-01 00:00:00','2026-01-01 00:00:00');

CREATE TABLE \`users\` (
  \`id\` int(11) NOT NULL AUTO_INCREMENT,
  \`tenant_id\` int(11) NOT NULL DEFAULT 1,
  \`username\` varchar(100) DEFAULT NULL,
  \`email\` varchar(255) NOT NULL,
  \`password_hash\` varchar(255) DEFAULT NULL,
  \`full_name\` varchar(200) NOT NULL,
  \`job_title\` varchar(150) DEFAULT NULL,
  \`phone\` varchar(50) DEFAULT NULL,
  \`avatar_url\` varchar(255) DEFAULT NULL,
  \`signature_url\` longtext DEFAULT NULL,
  \`role\` varchar(50) NOT NULL DEFAULT 'sales',
  \`department\` varchar(100) DEFAULT NULL,
  \`is_active\` tinyint(1) NOT NULL DEFAULT 1,
  \`two_factor_enabled\` tinyint(1) DEFAULT 0,
  \`two_factor_type\` varchar(20) DEFAULT 'email',
  \`two_factor_secret\` varchar(255) DEFAULT NULL,
  \`two_factor_backup_codes\` text DEFAULT NULL,
  \`status\` enum('active','inactive','leave') DEFAULT 'active',
  \`vacation_mode\` tinyint(1) DEFAULT 0,
  \`leave_start\` date DEFAULT NULL,
  \`leave_end\` date DEFAULT NULL,
  \`work_start_time\` varchar(5) DEFAULT '08:00',
  \`work_end_time\` varchar(10) DEFAULT '17:00',
  \`work_schedule\` longtext DEFAULT NULL,
  \`zalo_chat_id\` varchar(255) DEFAULT NULL,
  \`telegram_chat_id\` varchar(255) DEFAULT NULL,
  \`is_confirmed\` tinyint(1) DEFAULT 0,
  \`confirm_token\` varchar(64) DEFAULT NULL,
  \`bio\` text DEFAULT NULL,
  \`last_login_at\` timestamp NULL DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`team_id\` int(11) DEFAULT NULL,
  \`dob\` date DEFAULT NULL,
  \`gender\` varchar(20) DEFAULT NULL,
  \`citizen_id\` varchar(50) DEFAULT NULL,
  \`address\` text DEFAULT NULL,
  \`bank_name\` varchar(150) DEFAULT NULL,
  \`bank_account\` varchar(100) DEFAULT NULL,
  \`overtime_mode\` tinyint(1) DEFAULT 0,
  \`permissions_json\` longtext DEFAULT NULL,
  \`extra_fields_json\` longtext DEFAULT NULL,
  \`manager_behavior_mode\` varchar(50) NOT NULL DEFAULT 'combined',
  \`use_custom_work_hours\` tinyint(1) DEFAULT 0,
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  \`google_id\` varchar(128) DEFAULT NULL
);
INSERT INTO \`users\` VALUES (100001,1,'admin','admin@ideas.edu.vn','$2b$10$kRjTusxHD1luPJMZtqrjA.Ymh2EApuWtX/1aph3GjYRkgXssgN94m','Admin Test','Director',NULL,'uploads/avatars/missing_avatar_file_999.jpg',NULL,'director','BGD',1,0,'email',NULL,NULL,'active',0,NULL,NULL,'08:00','17:00',NULL,NULL,NULL,1,NULL,NULL,NULL,'2026-01-01 00:00:00','2026-01-01 00:00:00',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,'combined',0,NULL,NULL);

CREATE TABLE \`lists\` (
  \`id\` char(36) NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`source\` varchar(100) DEFAULT 'Manual',
  \`type\` enum('static','sync') DEFAULT 'static',
  \`subscriber_count\` int(11) DEFAULT 0,
  \`phone_count\` int(11) DEFAULT 0,
  \`created_at\` timestamp NULL DEFAULT current_timestamp(),
  \`updated_at\` timestamp NULL DEFAULT current_timestamp(),
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL
);
INSERT INTO \`lists\` VALUES ('list-webinar-1','Lead Form ISTEC','Manual','static',2,2,'2026-01-01 00:00:00','2026-01-01 00:00:00',NULL,1,100001,100001);

CREATE TABLE \`forms\` (
  \`id\` char(36) NOT NULL,
  \`tenant_id\` int(11) DEFAULT 1,
  \`name\` varchar(255) NOT NULL,
  \`schema\` longtext DEFAULT NULL,
  \`mapping\` longtext DEFAULT NULL,
  \`embed_token\` varchar(64) DEFAULT NULL,
  \`is_active\` tinyint(1) DEFAULT 1,
  \`submit_count\` int(11) DEFAULT 0,
  \`created_by\` int(11) DEFAULT 1,
  \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  \`status\` enum('active','inactive') NOT NULL DEFAULT 'active',
  \`target_list_id\` char(36) DEFAULT NULL,
  \`fields_json\` longtext DEFAULT NULL,
  \`notification_enabled\` tinyint(1) DEFAULT 0,
  \`notification_emails\` text DEFAULT NULL,
  \`notification_cc_emails\` text DEFAULT NULL,
  \`notification_subject\` varchar(255) DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`updated_by\` int(11) DEFAULT NULL
);
INSERT INTO \`forms\` VALUES ('form-legacy-1',1,'Form Webinar','[{"name":"email","label":"Email","type":"email"}]','{}','tok_webinar_1',1,0,100001,'2026-02-01 00:00:00',NULL,'active','list-webinar-1','[{"name":"email","label":"Email","type":"email"}]',0,NULL,NULL,NULL,1,NULL);
INSERT INTO \`forms\` VALUES ('form-legacy-2',1,'Form Fallback NoList','[{"name":"phone","label":"SĐT","type":"tel"}]','{}','tok_fallback_2',1,0,100001,'2026-02-02 00:00:00',NULL,'active',NULL,'[{"name":"phone","label":"SĐT","type":"tel"}]',0,NULL,NULL,NULL,1,NULL);

CREATE TABLE \`subscribers\` (
  \`id\` char(36) NOT NULL,
  \`contact_id\` int(11) DEFAULT NULL,
  \`person_id\` char(36) DEFAULT NULL,
  \`phone_norm9\` varchar(15) DEFAULT NULL,
  \`email_norm\` varchar(191) DEFAULT NULL,
  \`email\` varchar(191) NOT NULL,
  \`first_name\` varchar(100) DEFAULT NULL,
  \`last_name\` varchar(100) DEFAULT NULL,
  \`gender\` varchar(20) DEFAULT NULL,
  \`status\` varchar(50) DEFAULT 'active',
  \`source\` varchar(100) DEFAULT 'Manual',
  \`salesperson\` varchar(255) DEFAULT NULL,
  \`phone_number\` varchar(50) DEFAULT NULL,
  \`phone\` varchar(20) DEFAULT NULL,
  \`job_title\` varchar(100) DEFAULT NULL,
  \`company_name\` varchar(100) DEFAULT NULL,
  \`country\` varchar(100) DEFAULT NULL,
  \`city\` varchar(100) DEFAULT NULL,
  \`timezone\` varchar(50) DEFAULT NULL,
  \`address\` text DEFAULT NULL,
  \`date_of_birth\` date DEFAULT NULL,
  \`anniversary_date\` date DEFAULT NULL,
  \`notes\` longtext DEFAULT NULL,
  \`last_activity_at\` datetime DEFAULT NULL,
  \`tags\` longtext DEFAULT NULL,
  \`custom_attributes\` longtext DEFAULT NULL,
  \`stats_sent\` int(11) DEFAULT 0,
  \`stats_opened\` int(11) DEFAULT 0,
  \`stats_clicked\` int(11) DEFAULT 0,
  \`last_open_at\` datetime DEFAULT NULL,
  \`last_click_at\` datetime DEFAULT NULL,
  \`joined_at\` timestamp NULL DEFAULT current_timestamp(),
  \`updated_at\` timestamp NULL DEFAULT current_timestamp(),
  \`deleted_at\` timestamp NULL DEFAULT NULL,
  \`zalo_user_id\` varchar(100) DEFAULT NULL,
  \`is_zalo_follower\` tinyint(1) DEFAULT 0,
  \`meta_psid\` varchar(100) DEFAULT NULL,
  \`lead_score\` int(11) DEFAULT 0,
  \`verified\` tinyint(1) DEFAULT 0,
  \`avatar\` varchar(500) DEFAULT NULL,
  \`last_os\` varchar(50) DEFAULT NULL,
  \`last_device\` varchar(50) DEFAULT NULL,
  \`last_browser\` varchar(50) DEFAULT NULL,
  \`last_city\` varchar(100) DEFAULT NULL,
  \`last_country\` varchar(100) DEFAULT NULL,
  \`property_id\` char(36) DEFAULT NULL,
  \`last_ip\` varchar(64) DEFAULT NULL,
  \`workspace_id\` int(11) DEFAULT 1,
  \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  \`owner_id\` int(11) DEFAULT NULL,
  \`program\` varchar(150) DEFAULT NULL,
  \`stage_id\` int(11) DEFAULT NULL,
  \`pipeline_status\` varchar(50) DEFAULT NULL,
  \`lead_status\` varchar(50) DEFAULT NULL,
  \`district\` varchar(100) DEFAULT NULL,
  \`ward\` varchar(100) DEFAULT NULL,
  \`temperature\` varchar(32) DEFAULT 'warm',
  \`last_send_at\` datetime DEFAULT NULL
);
INSERT INTO \`subscribers\` VALUES ('sub-1',NULL,NULL,'909000111','anh.nguyen@test.vn','anh.nguyen@test.vn','Anh','Nguyen',NULL,'active','WebForm',NULL,'0909000111','0909000111',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'[]','{"form_name":"Form Webinar","avatar":"uploads/avatars/missing_sub.jpg","avatar_url":"https://platform-lookaside.fbsbx.com/platform/profilepic/?psid=1"}',0,0,0,NULL,NULL,'2026-02-01 00:00:00','2026-02-01 00:00:00',NULL,NULL,0,NULL,10,0,'https://s120-ava-talk.zadn.vn/1/2/3/a.jpg',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,'2026-02-01 00:00:00',NULL,NULL,NULL,'MBA',NULL,NULL,NULL,NULL,NULL,'warm',NULL);

CREATE TABLE \`web_properties\` (
  \`id\` char(36) NOT NULL,
  \`workspace_id\` int(10) unsigned NOT NULL DEFAULT 1,
  \`name\` varchar(255) NOT NULL,
  \`domain\` varchar(255) NOT NULL,
  \`settings\` text DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`status\` varchar(255) DEFAULT NULL,
  \`api_key\` varchar(255) DEFAULT NULL,
  \`created_by\` int(11) DEFAULT NULL,
  \`updated_by\` int(11) DEFAULT NULL,
  \`is_deleted\` tinyint(1) NOT NULL DEFAULT 0,
  \`deleted_at\` timestamp NULL DEFAULT NULL
);
INSERT INTO \`web_properties\` VALUES ('7ac8420d-b248-4ab5-a97d-0fd177e0ae64',1,'Chief AI Officer','chiefaiofficer.vn',NULL,'2026-01-12 06:26:35',NULL,NULL,NULL,NULL,0,NULL),('ce71ea2e-d841-4e0f-b3ad-332297cde330',1,'IDEAS.EDU.VN','ideas.edu.vn',NULL,'2026-01-09 06:18:09',NULL,NULL,NULL,NULL,0,NULL);

CREATE TABLE \`domation_ai_training_docs\` (
  \`id\` varchar(100) NOT NULL,
  \`parent_id\` varchar(100) DEFAULT '0',
  \`property_id\` varchar(100) DEFAULT NULL,
  \`name\` varchar(255) NOT NULL,
  \`source_type\` varchar(50) DEFAULT 'manual',
  \`version\` int(11) DEFAULT 1,
  \`is_active\` tinyint(1) DEFAULT 1,
  \`status\` enum('pending','processing','trained','error') NOT NULL DEFAULT 'pending',
  \`priority\` int(11) DEFAULT 0,
  \`content\` longtext DEFAULT NULL,
  \`tags\` longtext DEFAULT NULL,
  \`metadata\` longtext DEFAULT NULL,
  \`batch_id_virtual\` varchar(100) DEFAULT NULL,
  \`created_at\` timestamp NULL DEFAULT current_timestamp(),
  \`updated_at\` timestamp NULL DEFAULT current_timestamp(),
  \`chatbot_id\` varchar(100) DEFAULT NULL,
  \`filename\` varchar(255) DEFAULT NULL,
  \`error_message\` text DEFAULT NULL,
  \`type\` enum('url','text','file','folder','sitemap') DEFAULT 'text',
  \`book_title\` varchar(500) DEFAULT NULL,
  \`book_author\` varchar(255) DEFAULT NULL,
  \`total_pages\` int(11) DEFAULT NULL,
  \`is_global_workspace\` tinyint(1) NOT NULL DEFAULT 0,
  \`uploaded_by\` varchar(100) DEFAULT NULL
);
INSERT INTO \`domation_ai_training_docs\` VALUES ('doc-chief-1','0','7ac8420d-b248-4ab5-a97d-0fd177e0ae64','Học phí Chief AI','manual',1,1,'trained',0,'5400 CHF',NULL,'{}',NULL,'2026-01-25 00:00:00','2026-01-25 00:00:00',NULL,NULL,NULL,'text',NULL,NULL,NULL,0,NULL),('doc-ideas-1','0','ce71ea2e-d841-4e0f-b3ad-332297cde330','Giới thiệu IDEAS','manual',1,1,'trained',0,'Swiss UMEF',NULL,'{}',NULL,'2026-01-25 00:00:00','2026-01-25 00:00:00',NULL,NULL,NULL,'text',NULL,NULL,NULL,0,NULL),('doc-bot-1','0','chatbot_699eadd924298','Kịch bản Chatbot','manual',1,1,'trained',0,'Nội dung chatbot',NULL,'{}',NULL,'2026-01-25 00:00:00','2026-01-25 00:00:00',NULL,NULL,NULL,'text',NULL,NULL,NULL,0,NULL);

CREATE TABLE \`domation_ai_conversations\` (
  \`id\` varchar(100) NOT NULL,
  \`contact_id\` int(11) DEFAULT NULL,
  \`visitor_id\` varchar(100) DEFAULT NULL,
  \`property_id\` varchar(100) DEFAULT NULL,
  \`status\` enum('ai','human','closed') DEFAULT 'ai',
  \`metadata\` longtext DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`last_message\` text DEFAULT NULL,
  \`last_message_at\` timestamp NOT NULL DEFAULT current_timestamp(),
  \`active_scenario_id\` varchar(60) DEFAULT NULL,
  \`active_node_id\` varchar(100) DEFAULT NULL
);
INSERT INTO \`domation_ai_conversations\` VALUES ('conv-1',NULL,'vis-1','7ac8420d-b248-4ab5-a97d-0fd177e0ae64','ai',NULL,'2026-02-01 00:00:00','2026-02-01 00:00:00','Hỏi học phí','2026-02-01 00:00:00',NULL,NULL),('conv-2',NULL,'vis-2','chatbot_699eadd924298','ai',NULL,'2026-02-01 00:00:00','2026-02-01 00:00:00','Tư vấn MBA','2026-02-01 00:00:00',NULL,NULL);
`;
    fs.writeFileSync(sqlPath, miniSql, 'utf8');

    try {
      const summary = await migrateMyerpIdeas({
        sqlPath,
        dataDir,
        tenantSlug: 'ideas-minitest',
        skipWebAnalytics: true,
      });
      assert.equal(summary.success, true);
      assert.equal(summary.safety_gates.zalo_bot_disabled, true);
      assert.equal(summary.target_migrated_counts.mkt_ai_training_docs, 3);
      assert.equal(summary.target_migrated_counts.mkt_forms, 2);

      const pool = createDatabasePool({ inMemory: false, dataDir });
      setDatabasePool(pool);
      try {
        await withSystemPrivilege(async (client) => {
          const tRes = await client.query<{ id: string; settings: Record<string, any> }>(
            `SELECT id, settings FROM tenants WHERE slug = 'ideas-minitest' LIMIT 1`
          );
          const tid = tRes.rows[0].id;
          assert.equal(tRes.rows[0].settings.zalo_bot_disabled, true);
          const stats = tRes.rows[0].settings.ai_training_property_stats;
          assert.equal(stats['7ac8420d-b248-4ab5-a97d-0fd177e0ae64']?.queries_count, 1);
          assert.equal(stats['ce71ea2e-d841-4e0f-b3ad-332297cde330']?.queries_count, 1);

          const uRes = await client.query<{ avatar_url: string | null }>(
            `SELECT avatar_url FROM users WHERE tenant_id = $1`,
            [tid]
          );
          assert.equal(uRes.rows[0].avatar_url, null);

          const lRes = await client.query<{ custom_fields: unknown }>(
            `SELECT custom_fields FROM leads WHERE tenant_id = $1`,
            [tid]
          );
          const leadDump = JSON.stringify(lRes.rows);
          assert.ok(!leadDump.includes('fbsbx.com') && !leadDump.includes('zadn.vn') && !leadDump.includes('missing_sub.jpg'));

          const fRes = await client.query<{ name: string; target_audience_id: string | null; submission_count: number }>(
            `SELECT name, target_audience_id, submission_count FROM mkt_forms WHERE tenant_id = $1 ORDER BY name`,
            [tid]
          );
          assert.equal(fRes.rows.length, 2);
          for (const fm of fRes.rows) {
            assert.ok(fm.target_audience_id, `Form ${fm.name} must have target_audience_id`);
          }
          const webinarForm = fRes.rows.find((f) => f.name === 'Form Webinar');
          assert.equal(webinarForm?.submission_count, 1);
        });
      } finally {
        await pool.close();
        setDatabasePool(null);
      }
    } finally {
      if (origSilent === undefined) delete process.env.OUTBOUND_SILENT_MODE;
      else process.env.OUTBOUND_SILENT_MODE = origSilent;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('MYERP -> DOMATION Cutover: Rewriter, Flow Trigger Remap, Public Timer & Template Compat', () => {
  it('rewrites legacy MYERP/automation hosts to DOMATION while keeping customer sites intact', () => {
    const rw = new LegacyUrlRewriter('https://data.domation.net', 'https://erp.domation.net');
    const html = [
      'https://automation.ideas.edu.vn/mail_api/timer.php?target=2026-12-31T23%3A59&color=ffffff&bg=transparent',
      'https://automation.ideas.edu.vn/s/phan-hoi-san-pham-728b3d',
      'https://myerp.ideas.edu.vn/backend/uploadss/banner.png',
      'https://erp.ideas.edu.vn/marketing/flows',
      'https://mail.ideas.edu.vn/uploads/template_thumbs/tpl_abc.webp',
      'https://open.automation.net/campaigns',
      'https://crm.domation.net/s/survey-1',
      'https://ideas.edu.vn/webinar-ideas-talk',
      'https://chiefaiofficer.vn/caio',
      'https://vtci.edu.vn/wp-content/uploads/2025/07/bba-degree.jpg',
    ].join('\n');

    const out = rw.rewriteString(html, 'html');
    assert.ok(out.includes('https://data.domation.net/api/v1/public/marketing/timer?target=2026-12-31T23%3A59&color=ffffff&bg=transparent'));
    assert.ok(out.includes('https://erp.domation.net/s/phan-hoi-san-pham-728b3d'));
    assert.ok(out.includes('https://data.domation.net/uploadss/banner.png'));
    assert.ok(out.includes('https://erp.domation.net/marketing/flows'));
    assert.ok(out.includes('/uploads/template_thumbs/tpl_abc.webp'));
    assert.ok(out.includes('https://erp.domation.net/campaigns'));
    assert.ok(out.includes('https://erp.domation.net/s/survey-1'));
    assert.ok(!/automation\.ideas|myerp\.ideas|erp\.ideas|mail\.ideas|open\.automation|crm\.domation/i.test(out));
    // Customer public websites stay untouched
    assert.ok(out.includes('https://ideas.edu.vn/webinar-ideas-talk'));
    assert.ok(out.includes('https://chiefaiofficer.vn/caio'));
    assert.ok(out.includes('https://vtci.edu.vn/wp-content/uploads/2025/07/bba-degree.jpg'));
  });

  it('remaps legacy non-UUID form, segment, and campaign flow trigger IDs to live UUIDs', () => {
    const formUuid = '1d53a656-29a0-5e63-b9fa-597e3ddc99d1';
    const audUuid = 'c15d1d72-4967-57f3-a47c-e576c9fbf6ce';
    const campUuid = 'e5012a75-60e3-5058-8851-63a516bc44a3';

    const formFlow = remapFlowTriggerAndSteps(
      'form',
      { type: 'form', targetId: '285bf4087f3635fe1e4df6f581454a8d', targetSubtype: 'list' },
      [{ id: 'step_1', type: 'trigger', config: { type: 'form', targetId: '285bf4087f3635fe1e4df6f581454a8d', targetSubtype: 'list' } }],
      { formIdMap: new Map([['285bf4087f3635fe1e4df6f581454a8d', formUuid]]) }
    );
    assert.equal(formFlow.triggerConfig.targetId, formUuid);
    assert.equal(formFlow.triggerConfig.form_id, formUuid);
    assert.equal((formFlow.steps[0] as any).config.targetId, formUuid);

    const segFlow = remapFlowTriggerAndSteps(
      'segment',
      { type: 'segment', targetId: 'seg_form_istec' },
      [{ id: 'step_1', type: 'trigger', config: { type: 'segment', targetId: 'seg_form_istec' } }],
      { listIdMap: new Map([['seg_form_istec', audUuid]]) }
    );
    assert.equal(segFlow.triggerConfig.targetId, audUuid);
    assert.equal(segFlow.triggerConfig.audience_id, audUuid);

    const campFlow = remapFlowTriggerAndSteps(
      'campaign',
      { type: 'campaign', targetId: '69dc974be65bc' },
      [{ id: 'step_1', type: 'trigger', config: { type: 'campaign', targetId: '69dc974be65bc' } }],
      { campaignIdMap: new Map([['69dc974be65bc', campUuid]]) }
    );
    assert.equal(campFlow.triggerConfig.targetId, campUuid);
    assert.equal(campFlow.triggerConfig.campaign_id, campUuid);
  });

  it('serves /api/v1/public/marketing/timer SVG, /uploads/template_thumbs/*.webp (with traversal guard), and /templates?id=<uuid>', async () => {
    const h = await startTestServer();
    try {
      // 1. Public dynamic timer SVG
      const timerRes = await fetch(`${h.baseUrl}/api/v1/public/marketing/timer?target=2026-12-31T23:59&color=ffffff&bg=transparent`);
      assert.equal(timerRes.status, 200);
      assert.ok((timerRes.headers.get('content-type') || '').includes('image/svg+xml'));
      const svgBody = await timerRes.text();
      assert.ok(svgBody.includes('<svg') && svgBody.includes('fill="#ffffff"'));

      // 2. Migrated template thumbnail static file + traversal prevention
      const thumbFiles = fs.readdirSync(path.resolve(process.cwd(), 'public', 'uploads', 'template_thumbs')).filter((f) => f.endsWith('.webp'));
      assert.ok(thumbFiles.length > 0, 'Expected copied template_thumbs .webp files');
      const okThumbRes = await fetch(`${h.baseUrl}/uploads/template_thumbs/${thumbFiles[0]}`);
      assert.equal(okThumbRes.status, 200);
      const traversalRes = await fetch(`${h.baseUrl}/uploads/%2e%2e/package.json`);
      assert.ok(traversalRes.status === 400 || traversalRes.status === 404);

      // 3. Single-template lookup via `?id=<uuid>` compat query
      const reg = await apiRequest(h.baseUrl, '/api/v1/auth/register', {
        method: 'POST',
        body: {
          company_name: 'Cutover Template Check Co',
          tenant_slug: 'cutover-tpl-check',
          admin_name: 'Cutover Admin',
          work_email: 'cutover@domation.net',
          phone: '0909888777',
          password: 'Password123!',
          package_code: 'growth_combo',
        },
      });
      assert.equal(reg.status, 201);
      const token = reg.json.data.access_token;
      const createRes = await apiRequest(h.baseUrl, '/api/v1/marketing/templates', {
        method: 'POST',
        token,
        tenantSlug: 'cutover-tpl-check',
        body: {
          name: 'Cutover Single Fetch Template',
          subject: 'DOMATION Cutover Preview',
          compiled_html: '<html><body><p>Preview HTML Ready</p></body></html>',
          thumbnail_url: `/uploads/template_thumbs/${thumbFiles[0]}`,
        },
      });
      assert.equal(createRes.status, 201);
      const createdId = createRes.json.data.id;
      const byQueryRes = await apiRequest(h.baseUrl, `/api/v1/marketing/templates?id=${encodeURIComponent(createdId)}`, {
        token,
        tenantSlug: 'cutover-tpl-check',
      });
      assert.equal(byQueryRes.status, 200);
      assert.equal(byQueryRes.json.data.id, createdId);
      assert.ok(byQueryRes.json.data.htmlContent.includes('Preview HTML Ready'));
      assert.equal(byQueryRes.json.data.thumbnail, `/uploads/template_thumbs/${thumbFiles[0]}`);
    } finally {
      await h.close();
    }
  });
});
