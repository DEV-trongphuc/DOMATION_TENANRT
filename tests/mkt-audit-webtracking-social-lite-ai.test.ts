import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';

describe('Marketing Audit Suite: WebTracking Full Compat + SocialBot Meta/Zalo Dedup + Multi-Agent Lite RAG', () => {
  let harness: TestHarness;
  let token = '';
  let tenantId = '';
  let tenantSlug = 'mkt-audit-lite';
  let propertyId = '';
  let siteKey = '';

  before(async () => {
    process.env.OUTBOUND_SILENT_MODE = 'true';
    harness = await startTestServer();

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'EcoLife Marketing Lite Co',
        tenant_slug: tenantSlug,
        admin_name: 'EcoLife Marketing Director',
        work_email: 'director@ecolife-audit.vn',
        phone: '0909888686',
        password: 'StrongPassword123!',
        industry: 'retail',
        package_code: 'marketing_standalone',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201, `register failed: ${JSON.stringify(reg.json)}`);
    token = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;
    assert.equal(reg.json.data.tenant.package_code, 'marketing_standalone');
  });

  after(async () => {
    await harness.close();
  });

  it('1. WebTracking: /sdk.js emits scroll & page_exit beacons; /track + compat stats/visitors/heatmap/block_ip work end-to-end', async () => {
    // Create web property
    const createProp = await apiRequest(harness.baseUrl, '/api/v1/marketing/web-tracking/properties', {
      method: 'POST',
      token,
      body: {
        name: 'EcoLife Landing',
        domain: 'ecolife.vn',
      },
    });
    assert.equal(createProp.status, 201, JSON.stringify(createProp.json));
    propertyId = createProp.json.data.id;
    siteKey = createProp.json.data.site_key;
    assert.ok(propertyId);
    assert.ok(siteKey);

    // Verify /sdk.js serves scroll_depth_pct + page_exit beacon logic
    const sdkRes = await fetch(`${harness.baseUrl}/api/v1/public/marketing/sdk.js?site_key=${encodeURIComponent(siteKey)}`);
    assert.equal(sdkRes.status, 200);
    const sdkCode = await sdkRes.text();
    assert.ok(sdkCode.includes('scroll_depth_pct'), 'sdk.js must include scroll_depth_pct tracking');
    assert.ok(sdkCode.includes('page_exit'), 'sdk.js must include page_exit duration tracking');
    assert.ok(sdkCode.includes('sendBeacon'), 'sdk.js must use sendBeacon for page_exit');

    // Fire pageview, click, scroll, and page_exit events via public /track
    const visitorId = 'vis_audit_001';
    const sessionId = 'sess_audit_001';
    for (const ev of [
      {
        site_key: siteKey,
        visitor_id: visitorId,
        session_id: sessionId,
        event_type: 'pageview',
        page_url: 'https://ecolife.vn/bang-gia?utm_source=facebook&utm_medium=cpc&utm_campaign=launch',
        page_title: 'Bảng giá EcoLife',
        referrer: 'https://facebook.com',
      },
      {
        site_key: siteKey,
        visitor_token: visitorId,
        session_id: sessionId,
        event_type: 'click',
        page_url: 'https://ecolife.vn/bang-gia',
        x_pct: 48.5,
        y_pct: 32.1,
        element_tag: 'BUTTON',
        element_text: 'Đăng ký ngay',
      },
      {
        site_key: siteKey,
        visitor_id: visitorId,
        session_id: sessionId,
        event_type: 'scroll',
        page_url: 'https://ecolife.vn/bang-gia',
        scroll_depth_pct: 75,
      },
      {
        site_key: siteKey,
        visitor_id: visitorId,
        session_id: sessionId,
        event_type: 'page_exit',
        page_url: 'https://ecolife.vn/bang-gia',
        duration_seconds: 42,
        scroll_depth_pct: 80,
      },
    ]) {
      const tr = await apiRequest(harness.baseUrl, '/api/v1/public/marketing/track', {
        method: 'POST',
        body: ev,
      });
      assert.ok(tr.status === 200 || tr.status === 201, `track failed: ${tr.status} ${JSON.stringify(tr.json)}`);
    }

    // Compat action=stats returns full WebStats shape
    const statsRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/web_tracking?action=stats&id=${encodeURIComponent(propertyId)}&period=7d&device=all`,
      { token }
    );
    assert.equal(statsRes.status, 200, JSON.stringify(statsRes.json));
    const stats = statsRes.json.data || statsRes.json;
    assert.ok(stats.overview, 'stats must include overview');
    assert.ok(Number(stats.overview.visitors) >= 1, `expected visitors >= 1, got ${JSON.stringify(stats.overview)}`);
    assert.ok(Number(stats.overview.pageViews) >= 1, `expected pageViews >= 1, got ${JSON.stringify(stats.overview)}`);
    assert.ok(Number(stats.overview.avgDuration) >= 1, `expected avgDuration >= 1, got ${JSON.stringify(stats.overview)}`);
    assert.ok(Array.isArray(stats.chart), 'stats must include chart array');
    assert.ok(Array.isArray(stats.deviceStats), 'stats must include deviceStats');
    assert.ok(Array.isArray(stats.osStats), 'stats must include osStats');
    assert.ok(Array.isArray(stats.trafficSources), 'stats must include trafficSources');
    assert.ok(Array.isArray(stats.topPages) && stats.topPages.length >= 1, 'stats must include topPages');

    // Compat action=visitors returns totalPages + live_count + visitor timeline
    const visRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/web_tracking?action=visitors&id=${encodeURIComponent(propertyId)}&page=1`,
      { token }
    );
    assert.equal(visRes.status, 200, JSON.stringify(visRes.json));
    const visPayload = visRes.json.data || visRes.json;
    assert.ok(Array.isArray(visPayload.visitors) && visPayload.visitors.length >= 1, 'visitors list must be populated');
    assert.ok(typeof visPayload.pagination?.totalPages === 'number', 'pagination.totalPages must exist');
    assert.ok(typeof visPayload.live_count === 'number', 'live_count must exist');

    const timelineRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/web_tracking?action=visitors&id=${encodeURIComponent(propertyId)}&visitor_id=${encodeURIComponent(visitorId)}`,
      { token }
    );
    assert.equal(timelineRes.status, 200, JSON.stringify(timelineRes.json));
    const timelinePayload = timelineRes.json.data || timelineRes.json;
    assert.ok(Array.isArray(timelinePayload.timeline) && timelinePayload.timeline.length >= 3, 'visitor timeline must contain tracked events');

    // Compat action=heatmap accepts id & url aliases + device filter
    const hmRes = await apiRequest(
      harness.baseUrl,
      `/api/v1/myerp/web_tracking?action=heatmap&id=${encodeURIComponent(propertyId)}&url=${encodeURIComponent('https://ecolife.vn/bang-gia')}&device=all`,
      { token }
    );
    assert.equal(hmRes.status, 200, JSON.stringify(hmRes.json));
    const hmData = hmRes.json.data || hmRes.json;
    assert.ok(Array.isArray(hmData.click_points) && hmData.click_points.length >= 1, `heatmap click_points expected >=1, got ${JSON.stringify(hmData)}`);
    assert.equal(hmData.scroll_reach_pct?.depth_75, 100, 'scroll reach depth_75 should be 100%');

    // Compat block_ip / blacklist / unblock_ip
    const blockRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/web_tracking?action=block_ip', {
      method: 'POST',
      token,
      body: { ip: '203.0.113.55', reason: 'Spam bot test' },
    });
    assert.ok(blockRes.status === 200 || blockRes.status === 201, JSON.stringify(blockRes.json));

    const blRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/web_tracking?action=blacklist', { token });
    assert.equal(blRes.status, 200);
    const blList = Array.isArray(blRes.json.data) ? blRes.json.data : blRes.json.data?.items || [];
    assert.ok(blList.some((r: any) => r.ip === '203.0.113.55' || r.ip_address === '203.0.113.55'), 'blocked IP must appear in blacklist');

    const unblockRes = await apiRequest(harness.baseUrl, '/api/v1/myerp/web_tracking?action=unblock_ip', {
      method: 'POST',
      token,
      body: { ip: '203.0.113.55' },
    });
    assert.equal(unblockRes.status, 200, JSON.stringify(unblockRes.json));
  });

  it('2. SocialBot Meta & Zalo: /automation/meta_config.php Fanpage CRUD, /meta_automation.php & /zalo_automation.php scenarios, and webhook mid/msg_id deduplication', async () => {
    // Save Meta Fanpage config via compat route
    const savePage = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/meta_config.php?route=save', {
      method: 'POST',
      token,
      body: {
        page_id: '1009988776655',
        page_name: 'EcoLife Official Page',
        page_access_token: 'EAA_MOCK_SANDBOX_PAGE_TOKEN_123456',
        verify_token: 'ecolife_verify_2026',
        is_active: true,
      },
    });
    assert.ok(savePage.status === 200 || savePage.status === 201, JSON.stringify(savePage.json));
    assert.equal(savePage.json.data?.has_page_access_token, true);

    // GET /automation/meta_config.php must return array of Fanpages (NOT Ad Accounts object!)
    const getPages = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/meta_config.php', { token });
    assert.equal(getPages.status, 200, JSON.stringify(getPages.json));
    const pagesArr = Array.isArray(getPages.json.data) ? getPages.json.data : getPages.json;
    assert.ok(Array.isArray(pagesArr), `expected Fanpage array, got ${JSON.stringify(getPages.json)}`);
    assert.ok(pagesArr.some((p: any) => String(p.page_id) === '1009988776655'), 'saved Fanpage must be returned');

    // Create Messenger automation scenario via /automation/meta_automation.php
    const saveMetaScen = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/meta_automation.php?route=save', {
      method: 'POST',
      token,
      body: {
        name: 'Tư vấn báo giá Messenger',
        trigger_type: 'keyword',
        keywords: ['báo giá', 'giá gói'],
        reply_text: 'Chào bạn! Bảng giá gói EcoLife từ 1.800.000đ/tháng ạ.',
        is_active: true,
      },
    });
    assert.ok(saveMetaScen.status === 200 || saveMetaScen.status === 201, JSON.stringify(saveMetaScen.json));

    // List Messenger scenarios (NOT Meta Ads overview!)
    const listMetaScen = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/meta_automation.php?route=list', { token });
    assert.equal(listMetaScen.status, 200, JSON.stringify(listMetaScen.json));
    const metaScens = Array.isArray(listMetaScen.json.data) ? listMetaScen.json.data : [];
    assert.ok(metaScens.some((s: any) => s.name === 'Tư vấn báo giá Messenger'), `expected saved messenger scenario, got ${JSON.stringify(listMetaScen.json)}`);

    // Create Zalo OA automation scenario via /automation/zalo_automation.php
    const saveZaloScen = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/zalo_automation.php?route=save', {
      method: 'POST',
      token,
      body: {
        name: 'Chào mừng Zalo OA',
        trigger_type: 'keyword',
        keywords: ['xin chào', 'zalo'],
        reply_text: 'EcoLife Zalo OA xin chào quý khách!',
        is_active: true,
      },
    });
    assert.ok(saveZaloScen.status === 200 || saveZaloScen.status === 201, JSON.stringify(saveZaloScen.json));

    const listZaloScen = await apiRequest(harness.baseUrl, '/api/v1/myerp/automation/zalo_automation.php?route=list', { token });
    assert.equal(listZaloScen.status, 200);
    const zaloScens = Array.isArray(listZaloScen.json.data) ? listZaloScen.json.data : [];
    assert.ok(zaloScens.some((s: any) => s.name === 'Chào mừng Zalo OA'), 'expected saved Zalo scenario');
    assert.ok(!zaloScens.some((s: any) => s.name === 'Tư vấn báo giá Messenger'), 'Zalo list must isolate channel=zalo_oa from messenger');

    // Webhook Meta Messenger duplicate mid deduplication + is_echo skip
    const metaPayload = {
      object: 'page',
      entry: [
        {
          id: '1009988776655',
          messaging: [
            {
              sender: { id: 'psid_dedup_001' },
              recipient: { id: '1009988776655' },
              message: { mid: 'mid.dedup.unique.001', text: 'cho minh xin báo giá' },
            },
            {
              sender: { id: '1009988776655' },
              recipient: { id: 'psid_dedup_001' },
              message: { mid: 'mid.echo.001', is_echo: true, text: 'echo msg' },
            },
          ],
        },
      ],
    };

    const hook1 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/social/inbound/${tenantSlug}`, {
      method: 'POST',
      body: metaPayload,
    });
    assert.equal(hook1.status, 200, JSON.stringify(hook1.json));

    // Retry exact same webhook mid — must be deduplicated!
    const hook2 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/social/inbound/${tenantSlug}`, {
      method: 'POST',
      body: metaPayload,
    });
    assert.equal(hook2.status, 200, JSON.stringify(hook2.json));

    // Zalo OA webhook envelope + duplicate msg_id deduplication
    const zaloPayload = {
      event_name: 'user_send_text',
      oa_id: 'oa_ecolife_01',
      sender: { id: 'zalo_uid_001' },
      recipient: { id: 'oa_ecolife_01' },
      message: { msg_id: 'zmsg.unique.001', text: 'xin chào shop' },
    };
    const zHook1 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/social/inbound/${tenantSlug}`, {
      method: 'POST',
      body: zaloPayload,
    });
    assert.equal(zHook1.status, 200, JSON.stringify(zHook1.json));

    const zHook2 = await apiRequest(harness.baseUrl, `/api/v1/public/marketing/social/inbound/${tenantSlug}`, {
      method: 'POST',
      body: zaloPayload,
    });
    assert.equal(zHook2.status, 200, JSON.stringify(zHook2.json));

    // Verify DB only stored 1 inbound user message per unique mid / msg_id (no double replies)
    const msgCounts = await withTenantTransaction(tenantId, async (client) => {
      const r = await client.query(
        `SELECT sender_type, content, extracted_entities->>'external_msg_id' AS ext_id
         FROM mkt_social_messages
         WHERE tenant_id = $1`,
        [tenantId]
      );
      return r.rows;
    });
    const metaInbound = msgCounts.filter((m: any) => m.sender_type === 'customer' && m.ext_id === 'mid.dedup.unique.001');
    const zaloInbound = msgCounts.filter((m: any) => m.sender_type === 'customer' && m.ext_id === 'zmsg.unique.001');
    const echoMsgs = msgCounts.filter((m: any) => String(m.content || '').includes('echo msg'));
    assert.equal(metaInbound.length, 1, `expected exactly 1 Meta inbound message, got ${metaInbound.length}`);
    assert.equal(zaloInbound.length, 1, `expected exactly 1 Zalo inbound message, got ${zaloInbound.length}`);
    assert.equal(echoMsgs.length, 0, 'is_echo message must be skipped');
  });

  it('3. Multi-Agent Lite (marketing_standalone): bootstrap, RAG Knowledge CRUD without PROMAX dom_agent, and /dom-agent/chat Q&A answer', async () => {
    // Bootstrap DOM Agent in marketing_standalone package
    const boot = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/bootstrap', { token });
    assert.equal(boot.status, 200, JSON.stringify(boot.json));
    assert.equal(boot.json.data.can_manage_knowledge, true, 'Lite marketing admin must have can_manage_knowledge=true');
    const specialists = boot.json.data.specialists || [];
    assert.ok(specialists.length >= 2, `expected Lite marketing specialists, got ${JSON.stringify(specialists)}`);

    // Upload a Q&A training doc into /api/v1/dom-agent/knowledge
    const createDoc = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/knowledge', {
      method: 'POST',
      token,
      body: {
        title: 'Chính sách hoàn tiền gói EcoLife Marketing',
        category: 'policy',
        content: 'Hỏi: Chính sách hoàn tiền gói EcoLife Marketing như thế nào? Trả lời: EcoLife hỗ trợ hoàn tiền 100% trong vòng 14 ngày đầu nếu khách hàng chưa hài lòng với hiệu quả chiến dịch.',
      },
    });
    assert.equal(createDoc.status, 201, `Lite knowledge upload failed: ${JSON.stringify(createDoc.json)}`);
    assert.ok(createDoc.json.data?.id);

    // Ask the floating Multi-Agent chatbot via POST /api/v1/dom-agent/chat
    const chatRes = await apiRequest(harness.baseUrl, '/api/v1/dom-agent/chat', {
      method: 'POST',
      token,
      body: {
        message: 'Chính sách hoàn tiền gói EcoLife Marketing như thế nào?',
      },
    });
    assert.equal(chatRes.status, 200, `Lite dom-agent chat failed: ${JSON.stringify(chatRes.json)}`);
    const reply = String(
      chatRes.json.data?.assistant_message?.content ||
      chatRes.json.data?.reply ||
      ''
    );
    assert.ok(reply.includes('14 ngày') || reply.includes('hoàn tiền'), `expected RAG Q&A citation in reply, got: ${reply}`);
    assert.ok(
      Array.isArray(chatRes.json.data?.citations) && chatRes.json.data.citations.length >= 1,
      `expected citations in chat response, got: ${JSON.stringify(chatRes.json.data)}`
    );
  });
});
