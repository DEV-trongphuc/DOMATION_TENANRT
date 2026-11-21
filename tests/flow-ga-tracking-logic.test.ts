import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';
import { flushDomainEvents } from '../server/core/events/event-bus.ts';
import { ingestAndDistributeLead } from '../server/services/distribution.service.ts';
import {
  computeWaitDelayMs,
  evaluateConditionOnLead,
  executeFlowForLead,
  registerFlowEventListeners,
  resolveConditionNextStep,
} from '../server/modules/marketing/flow-engine.service.ts';

describe('TEAM 2: GA4 Website Tracking, CRM Auto Trigger Bridge, Deep Wait/Condition Engine & Flow Analytics', () => {
  let harness: TestHarness;
  let token = '';
  let tenantId = '';
  let adminUserId = '';
  let saleUserId = '';
  let roundId = '';
  let propertyId = '';
  let siteKey = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();
    registerFlowEventListeners();

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Domation Flow GA4 Test Co',
        tenant_slug: 'dom-flow-ga4-test',
        admin_name: 'Admin Director',
        work_email: 'admin@dom-flow-ga4.vn',
        phone: '0909111222',
        password: 'StrongPassword123!',
        industry: 'education',
        package_code: 'growth_combo',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.json)}`);
    token = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;
    adminUserId = reg.json.data.user.id;

    // Create a dedicated Sale consultant and distribution round inside tenant
    await withTenantTransaction(tenantId, async (client) => {
      saleUserId = crypto.randomUUID();
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role)
         VALUES ($1, $2, $3, $4, $5, $6, 'sale')`,
        [saleUserId, tenantId, 'sale.linh@dom-flow-ga4.vn', 'hashed_pw', 'Nguyễn Thùy Linh (Sale)', '+84909333444']
      );
      await client.query(
        `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
         VALUES ($1, $2, 'active', true, false)`,
        [tenantId, saleUserId]
      );

      const pipeRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1',
        [tenantId]
      );
      const pipelineId = pipeRes.rows[0]?.id || null;

      const existingRound = await client.query<{ id: string }>(
        'SELECT id FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC LIMIT 1',
        [tenantId]
      );
      if (existingRound.rows[0]?.id) {
        roundId = existingRound.rows[0].id;
      } else {
        roundId = crypto.randomUUID();
        await client.query(
          `INSERT INTO distribution_rounds (id, tenant_id, name, pipeline_id, priority, is_active)
           VALUES ($1, $2, 'Vòng chia IELTS VIP', $3, 1, true)`,
          [roundId, tenantId, pipelineId]
        );
      }
      await client.query(
        `DELETE FROM round_consultants WHERE tenant_id = $1 AND round_id = $2`,
        [tenantId, roundId]
      );
      await client.query(
        `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn, is_active)
         VALUES ($1, $2, $3, 1, 1, true)`,
        [tenantId, roundId, saleUserId]
      );
    });
  });

  after(async () => {
    await harness.close();
  });

  it('(a) /sdk.js GA4 active engagement timer, scroll milestones, CTA capture & /track persistence + abnormal jump cap', async () => {
    const createProp = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/properties', {
      method: 'POST',
      token,
      body: {
        name: 'Domation Main Site',
        domain: 'domation-ga4.vn',
        pricing_url_pattern: '/pricing,/bang-gia',
      },
    });
    assert.equal(createProp.status, 201, JSON.stringify(createProp.json));
    propertyId = createProp.json.data.id;
    siteKey = createProp.json.data.site_key;

    // Inspect /sdk.js output for GA4-grade primitives
    const sdkRes = await fetch(`${harness.baseUrl}/api/v1/public/marketing/sdk.js?site_key=${encodeURIComponent(siteKey)}`);
    assert.equal(sdkRes.status, 200);
    const sdkJs = await sdkRes.text();
    assert.ok(sdkJs.includes('IDLE_TIMEOUT_MS = 30000'), 'sdk.js must track 30s idle window');
    assert.ok(sdkJs.includes('visibilitychange'), 'sdk.js must pause/flush on visibilitychange');
    assert.ok(sdkJs.includes('blur'), 'sdk.js must pause active timer on blur');
    assert.ok(sdkJs.includes('active_duration_seconds'), 'sdk.js must emit active_duration_seconds');
    assert.ok(sdkJs.includes('sendBeacon'), 'sdk.js must use sendBeacon on exit');
    assert.ok(sdkJs.includes('[25, 50, 75, 90, 100]'), 'sdk.js must emit deduplicated scroll milestones');
    assert.ok(sdkJs.includes("closest('a,button"), 'sdk.js must resolve closest clickable CTA element');
    assert.ok(sdkJs.includes('element_text'), 'sdk.js must capture trimmed element_text');
    assert.ok(sdkJs.includes('form_focus'), 'sdk.js must capture form_focus');
    assert.ok(sdkJs.includes('outbound_click'), 'sdk.js must capture outbound_click');
    assert.ok(sdkJs.includes('pricing_intent'), 'sdk.js must capture pricing_intent');

    const visitorToken = 'vis_ga4_001';

    // 1. Pageview with identity stitching
    const pvRes = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: visitorToken,
        event_type: 'pageview',
        page_url: 'https://domation-ga4.vn/bang-gia?utm_source=google&utm_medium=cpc&utm_campaign=q4_launch',
        page_title: 'Bảng giá Gói Enterprise',
        email: 'khach.ga4@example.vn',
        name: 'Trần Minh Khôi',
      },
    });
    assert.equal(pvRes.status, 201, JSON.stringify(pvRes.json));
    assert.equal(pvRes.json.data.stitched, true);
    assert.equal(pvRes.json.data.pricing_intent_detected, true);
    const sessionId = pvRes.json.data.session_id;

    // 2. Button CTA Click with exact text, CSS selector, href, viewport
    const clickRes = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: visitorToken,
        event_type: 'click',
        page_url: 'https://domation-ga4.vn/bang-gia',
        element_tag: 'BUTTON',
        element_text: 'Nhận báo giá Enterprise ngay',
        element_selector: '#btn-enterprise-quote',
        href: 'https://domation-ga4.vn/dang-ky-tu-van',
        data_cta: 'pricing_cta_primary',
        x_pct: 52.4,
        y_pct: 41.2,
        viewport_w: 1440,
        viewport_h: 900,
      },
    });
    assert.equal(clickRes.status, 201, JSON.stringify(clickRes.json));
    assert.equal(clickRes.json.data.element_text, 'Nhận báo giá Enterprise ngay');
    assert.equal(clickRes.json.data.element_selector, '#btn-enterprise-quote');

    // 3. Scroll milestone 90%
    const scrollRes = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: visitorToken,
        event_type: 'scroll',
        page_url: 'https://domation-ga4.vn/bang-gia',
        scroll_depth_pct: 90,
      },
    });
    assert.equal(scrollRes.status, 201);
    assert.equal(scrollRes.json.data.scroll_depth_pct, 90);

    // 4. Abnormal background-tab duration jump (99,999s) MUST be safely capped at 1,800s!
    const exitRes = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: visitorToken,
        event_type: 'page_exit',
        page_url: 'https://domation-ga4.vn/bang-gia',
        active_duration_seconds: 99999,
        scroll_depth_pct: 90,
      },
    });
    assert.equal(exitRes.status, 201, JSON.stringify(exitRes.json));
    assert.equal(exitRes.json.data.active_duration_seconds, 1800, 'Single-ping duration jump must be capped at <= 1800s');
    assert.equal(exitRes.json.data.session_duration_seconds, 1800, 'Session duration must reflect capped delta');

    // Verify rich page-details & visitor timeline APIs return exact CTA text, scroll distribution, and capped active duration
    const pageDetailsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/web-tracking/page-details?page_url=${encodeURIComponent('/bang-gia')}`,
      { token }
    );
    assert.equal(pageDetailsRes.status, 200, JSON.stringify(pageDetailsRes.json));
    const pd = pageDetailsRes.json.data;
    assert.equal(pd.avg_active_duration_seconds, 1800);
    assert.equal(pd.scroll_distribution.depth_75, 100);
    assert.equal(pd.scroll_distribution.depth_90, 100);
    assert.ok(
      pd.top_ctas.some((c: any) => c.element_text === 'Nhận báo giá Enterprise ngay' && c.element_selector === '#btn-enterprise-quote'),
      `Expected CTA in top_ctas, got ${JSON.stringify(pd.top_ctas)}`
    );

    const visitorRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/marketing/web-tracking/visitors/${sessionId}`,
      { token }
    );
    assert.equal(visitorRes.status, 200);
    assert.equal(visitorRes.json.data.session.active_duration_seconds, 1800);
    assert.equal(visitorRes.json.data.session.max_scroll_pct, 90);
    assert.ok(
      visitorRes.json.data.events.some((ev: any) => ev.element_text === 'Nhận báo giá Enterprise ngay' && ev.href === 'https://domation-ga4.vn/dang-ky-tu-van'),
      'Visitor timeline events must preserve exact element_text and href'
    );
  });

  it('(b) CRM Auto lead.created & lead.assigned (from integration + specific Sale) trigger active Marketing Flows with dedup guard', async () => {
    // Flow 1: Triggered when lead is assigned to our specific Sale from Google Sheets integration
    const createAssignedFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token,
      body: {
        name: 'Flow Chăm Sóc Google Sheets -> Sale Linh',
        status: 'active',
        trigger_type: 'lead_assigned',
        trigger_config: {
          integration_type: 'google_sheets',
          assigned_to_user_id: saleUserId,
          round_id: roundId,
          re_entry_policy: 'once',
        },
        settings: {
          re_entry_policy: 'once',
        },
        steps: [
          {
            id: 'step_tag_gsheet',
            type: 'add_remove_tag',
            label: 'Gắn nhãn Google Sheets VIP',
            config: { mode: 'add', tag: 'gsheet-sale-linh' },
            nextStepId: 'step_score_boost',
          },
          {
            id: 'step_score_boost',
            type: 'update_lead_score',
            label: 'Cộng 20 điểm Lead',
            config: { delta: 20 },
          },
        ],
      },
    });
    assert.equal(createAssignedFlow.status, 201, JSON.stringify(createAssignedFlow.json));
    const assignedFlowId = createAssignedFlow.json.data.id;

    // Flow 2: Multi-trigger OR flow (`lead_created` OR `web_cta_click`)
    const createMultiFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token,
      body: {
        name: 'Flow Đa Trigger (Lead Created OR CTA Click)',
        status: 'active',
        trigger_type: 'lead_created',
        trigger_config: {
          source_contains: 'Google Sheets',
          trigger_match_logic: 'OR',
          additional_triggers: [
            { trigger_type: 'web_cta_click', cta_text_contains: 'Báo giá' },
          ],
        },
        settings: { re_entry_policy: 'once' },
        steps: [
          {
            id: 'step_multi_tag',
            type: 'add_remove_tag',
            label: 'Gắn nhãn Multi Trigger',
            config: { mode: 'add', tag: 'multi-trigger-hit' },
          },
        ],
      },
    });
    assert.equal(createMultiFlow.status, 201, JSON.stringify(createMultiFlow.json));
    const multiFlowId = createMultiFlow.json.data.id;

    // Ingest a lead via CRM distribution engine simulating Google Sheets integration
    const ingested = await ingestAndDistributeLead(tenantId, {
      name: 'Lê Hoàng Nam',
      phone: '0909555666',
      email: 'nam.le@example.vn',
      source: 'Google Sheets - Chiến dịch Q4',
      campaign: 'IELTS_Q4',
      utm_source: 'google_sheets',
      integration_type: 'google_sheets',
      skip_gatekeeper: true,
    });
    assert.equal(ingested.status, 'assigned');
    assert.equal(ingested.assignedTo, saleUserId);

    // Deterministically await non-blocking post-commit event listeners
    await flushDomainEvents();

    // Verify both Flow 1 (lead.assigned + specific Sale + integration_type) and Flow 2 (lead.created + source_contains) executed!
    const [f1Res, f2Res] = await Promise.all([
      apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${assignedFlowId}`, { token }),
      apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${multiFlowId}`, { token }),
    ]);
    assert.equal(f1Res.status, 200);
    assert.equal(f1Res.json.data.enrollments.length, 1, 'lead.assigned flow must enroll lead exactly once');
    assert.equal(f1Res.json.data.enrollments[0].status, 'completed');

    assert.equal(f2Res.status, 200);
    assert.equal(f2Res.json.data.enrollments.length, 1, 'lead.created multi-trigger flow must enroll lead exactly once');

    // Verify lead tags & score updated by the triggered flows
    const leadCheck = await withTenantTransaction(tenantId, async (client) => {
      const l = await client.query<{ lead_score: number }>('SELECT lead_score FROM leads WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        ingested.leadId,
      ]);
      const t = await client.query<{ slug: string }>(
        `SELECT tt.slug FROM lead_tags lt INNER JOIN tenant_tags tt ON tt.id = lt.tag_id WHERE lt.tenant_id = $1 AND lt.lead_id = $2`,
        [tenantId, ingested.leadId]
      );
      return { score: Number(l.rows[0]?.lead_score || 0), tags: t.rows.map((r) => r.slug) };
    });
    assert.ok(leadCheck.score >= 20, `Expected score >= 20, got ${leadCheck.score}`);
    assert.ok(leadCheck.tags.includes('gsheet_sale_linh'), `Expected gsheet_sale_linh tag, got ${JSON.stringify(leadCheck.tags)}`);
    assert.ok(leadCheck.tags.includes('multi_trigger_hit'), `Expected multi_trigger_hit tag, got ${JSON.stringify(leadCheck.tags)}`);
  });

  it('(c) wait_delay VN golden-hours/weekday calculation, wait_event resume & advanced_condition matching Web CTA + Scroll >= 75% + Assigned Sale', async () => {
    // 1. Unit-verify VN (+07:00) Golden Hours / Weekday computation:
    // Saturday 2026-11-21 22:00 VN = 2026-11-21T15:00:00Z -> allowed Mon-Fri (1..5), 08:30..21:00 VN
    // Should schedule for Monday 2026-11-23 08:30:00+07:00 (= 2026-11-23T01:30:00Z) => 34.5 hours = 124,200,000 ms!
    const satNightUtc = new Date('2026-11-21T15:00:00Z');
    const delayToMonMorning = computeWaitDelayMs(
      { mode: 'golden_hours', allowed_days: [1, 2, 3, 4, 5], window_start: '08:30', window_end: '21:00' },
      satNightUtc
    );
    assert.equal(delayToMonMorning, 34.5 * 3600_000, 'Sat 22:00 VN must wait 34.5h until Mon 08:30 VN');

    // Inside golden window: Monday 2026-11-23 10:00 VN (= 03:00Z) -> 0ms (proceed immediately!)
    const monMorningUtc = new Date('2026-11-23T03:00:00Z');
    const delayInsideWindow = computeWaitDelayMs(
      { mode: 'golden_hours', allowed_days: [1, 2, 3, 4, 5], window_start: '08:30', window_end: '21:00' },
      monMorningUtc
    );
    assert.equal(delayInsideWindow, 0, 'Inside Mon-Fri 08:30..21:00 VN window must return 0ms');

    // Exact date/time in +07:00 VN without explicit offset
    const exactDelay = computeWaitDelayMs(
      { mode: 'until_datetime', until_datetime: '2026-11-23T12:00:00' },
      monMorningUtc // 10:00 VN
    );
    assert.equal(exactDelay, 2 * 3600_000, '10:00 VN -> 12:00 VN must be exactly 2 hours');

    // 2. Unit-verify evaluateConditionOnLead + resolveConditionNextStep for Web CTA + Scroll >= 75% + Assigned Sale
    const sampleEnrichedLead = {
      assigned_to: saleUserId,
      lead_score: 65,
      clicked_texts: ['Nhận báo giá Enterprise ngay', '#btn-enterprise-quote'],
      visited_urls: ['https://domation-ga4.vn/bang-gia'],
      max_scroll_pct: 85,
      active_duration_seconds: 120,
      tags: ['vip'],
    };
    const advStep = {
      id: 'adv_cond_1',
      type: 'advanced_condition',
      label: 'Phân loại Khách nóng Web + Sale Linh',
      config: {
        branches: [
          {
            id: 'br_hot_web',
            label: 'Hot CTA + Scroll 75% + Sale Linh',
            stepId: 'step_hot_vip',
            conditionGroup: {
              logic: 'AND',
              conditions: [
                { field: 'web_cta_clicked', operator: 'contains', value: 'báo giá' },
                { field: 'web_max_scroll_pct', operator: 'gte', value: 75 },
                { field: 'crm_owner_id', operator: 'equals', value: saleUserId },
                { field: 'web_active_duration_sec', operator: 'gte', value: 60 },
              ],
            },
          },
        ],
        defaultStepId: 'step_cold_nurture',
      },
    };
    const branchRes = resolveConditionNextStep(sampleEnrichedLead, advStep);
    assert.equal(branchRes.matched, true);
    assert.equal(branchRes.nextId, 'step_hot_vip');
    assert.equal(evaluateConditionOnLead({ ...sampleEnrichedLead, max_scroll_pct: 40 }, advStep.config.branches[0]), false);

    // 3. End-to-end DB execution: Create lead with Sale Linh + Web CTA click & Scroll 85% -> Flow evaluates real DB records + wait_event resumes on web.cta_click!
    const webLead = await ingestAndDistributeLead(tenantId, {
      name: 'Phạm Bảo Anh',
      phone: '0909777888',
      email: 'baoanh@example.vn',
      source: 'Website Organic',
      force_assigned_to: saleUserId,
      skip_gatekeeper: true,
    });
    await flushDomainEvents();

    // Create a flow with `wait_event` (waits for web_cta_click) -> `advanced_condition` (checks CTA + scroll >= 75% + assigned Sale) -> tag `hot-web-qualified`
    const createWaitEventFlow = await apiRequest(harness.baseUrl, '/api/v1/marketing/flows', {
      method: 'POST',
      token,
      body: {
        name: 'Flow Wait Event CTA + Deep Condition',
        status: 'active',
        trigger_type: 'manual_enroll',
        steps: [
          {
            id: 'wait_cta',
            type: 'wait_delay',
            label: 'Chờ khách click nút Báo giá',
            config: {
              mode: 'wait_event',
              wait_event: 'web_cta_click',
              event_cta_contains: 'Tư vấn 1-1',
              timeout_duration: 24,
              timeout_unit: 'hours',
            },
            yesStepId: 'cond_web_sale',
            noStepId: 'step_timeout_tag',
          },
          {
            id: 'cond_web_sale',
            type: 'advanced_condition',
            label: 'Kiểm tra Scroll >= 75% & Sale Linh',
            config: {
              branches: [
                {
                  id: 'br_1',
                  label: 'Qualified Web VIP',
                  stepId: 'step_qualified',
                  conditionGroup: {
                    logic: 'AND',
                    conditions: [
                      { field: 'web_cta_clicked', operator: 'contains', value: 'Tư vấn 1-1' },
                      { field: 'web_max_scroll_pct', operator: 'gte', value: 75 },
                      { field: 'crm_owner_id', operator: 'equals', value: saleUserId },
                    ],
                  },
                },
              ],
              defaultStepId: 'step_timeout_tag',
            },
          },
          {
            id: 'step_qualified',
            type: 'add_remove_tag',
            label: 'Gắn nhãn Hot Web Qualified',
            config: { mode: 'add', tag: 'hot-web-qualified' },
            nextStepId: 'step_email_vip',
          },
          {
            id: 'step_email_vip',
            type: 'send_email',
            label: 'Gửi Email Ưu đãi VIP',
            config: { subject: 'Chào {{lead.name}}, ưu đãi riêng từ Sale Linh', customHtml: '<p>Xin chào</p>' },
          },
          {
            id: 'step_timeout_tag',
            type: 'add_remove_tag',
            label: 'Gắn nhãn Chưa click',
            config: { mode: 'add', tag: 'web-timeout' },
          },
        ],
      },
    });
    assert.equal(createWaitEventFlow.status, 201, JSON.stringify(createWaitEventFlow.json));
    const waitFlowId = createWaitEventFlow.json.data.id;

    // Enroll lead -> pauses at `wait_cta` waiting for `web_cta_click`
    const enrollRes = await executeFlowForLead(tenantId, waitFlowId, webLead.leadId);
    assert.equal(enrollRes.status, 'waiting');

    // First send scroll 85% event stitched to this lead
    await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: 'vis_wait_evt_001',
        lead_id: webLead.leadId,
        event_type: 'scroll',
        page_url: 'https://domation-ga4.vn/khoa-hoc',
        scroll_depth_pct: 85,
      },
    });
    // Now fire CTA click "Đặt lịch Tư vấn 1-1" -> automatically resumes waiting enrollment & evaluates advanced_condition!
    await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
      method: 'POST',
      body: {
        site_key: siteKey,
        visitor_token: 'vis_wait_evt_001',
        lead_id: webLead.leadId,
        event_type: 'click',
        page_url: 'https://domation-ga4.vn/khoa-hoc',
        element_tag: 'BUTTON',
        element_text: 'Đặt lịch Tư vấn 1-1',
        element_selector: '#btn-consult',
      },
    });
    await flushDomainEvents();

    // Verify enrollment completed via `step_qualified` & `step_email_vip`!
    const waitFlowDetail = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${waitFlowId}`, { token });
    assert.equal(waitFlowDetail.status, 200);
    const enrollment = waitFlowDetail.json.data.enrollments[0];
    assert.equal(enrollment.status, 'completed', `Expected completed after wait_event resume, trace: ${JSON.stringify(enrollment.execution_trace)}`);
    const traceIds = enrollment.execution_trace.map((t: any) => t.step_id);
    assert.ok(traceIds.includes('cond_web_sale'), 'Must evaluate advanced_condition');
    assert.ok(traceIds.includes('step_qualified'), 'Must take Qualified Web VIP branch');
    assert.ok(traceIds.includes('step_email_vip'), 'Must execute Email VIP step');

    // (d) Verify GET /flows/:id/analytics returns accurate rich per-step funnel metrics!
    const analyticsRes = await apiRequest(harness.baseUrl, `/api/v1/marketing/flows/${waitFlowId}/analytics`, { token });
    assert.equal(analyticsRes.status, 200, JSON.stringify(analyticsRes.json));
    const analytics = analyticsRes.json.data;
    assert.equal(analytics.summary.enrolled_count, 1);
    assert.equal(analytics.summary.completed_count, 1);
    assert.equal(analytics.summary.completion_rate_pct, 100);
    assert.ok(analytics.summary.total_sent >= 1, `Expected total_sent >= 1, got ${JSON.stringify(analytics.summary)}`);

    const waitStepMetric = analytics.step_funnel.find((s: any) => s.step_id === 'wait_cta');
    const condStepMetric = analytics.step_funnel.find((s: any) => s.step_id === 'cond_web_sale');
    const emailStepMetric = analytics.step_funnel.find((s: any) => s.step_id === 'step_email_vip');
    const timeoutStepMetric = analytics.step_funnel.find((s: any) => s.step_id === 'step_timeout_tag');

    assert.ok(waitStepMetric && waitStepMetric.entered === 1 && waitStepMetric.waiting === 0);
    assert.equal(typeof waitStepMetric.avg_wait_minutes, 'number');
    assert.equal(typeof waitStepMetric.drop_off_pct, 'number');
    assert.ok(condStepMetric && condStepMetric.entered === 1 && condStepMetric.completed === 1);
    assert.equal(condStepMetric.branch_counts['Qualified Web VIP'], 1);
    assert.ok(emailStepMetric && emailStepMetric.sent === 1 && emailStepMetric.failed === 0);
    assert.ok(timeoutStepMetric && timeoutStepMetric.entered === 0);
  });
});
