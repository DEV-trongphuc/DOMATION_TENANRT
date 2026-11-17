import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { sweepExpiredSlaTimeouts } from '../server/services/distribution.service.ts';
import {
  refreshExpiringZaloTokens,
  setSmtpTransportForTesting,
} from '../server/services/zalo-mail.service.ts';
import { setOutboundWebhookTransportForTesting } from '../server/services/webhook.service.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';

describe('Phase 6: Adversarial Review Regression Suite (Security, Contracts, Multi-Stage SLA, Presets & RBAC Op 18)', () => {
  let harness: TestHarness;

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    setSmtpTransportForTesting(null);
    setOutboundWebhookTransportForTesting(null);
    await harness.close();
  });

  it('Blocks unlinked Zalo privilege escalation, prevents double-approval credit inflation across multiple rounds, and marks failed OAuth refresh', async () => {
    const slug = 'zalo-sec-tenant';
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Zalo Security Corp',
        tenant_slug: slug,
        admin_name: 'Admin Zalo',
        work_email: 'admin@zalosec.vn',
        phone: '0912000111',
        password: 'Password123!',
        industry: 'real_estate',
        seed_demo_leads: false,
        zalo_config: {
          bot_token: 'zalo_tok_initial',
          group_chat_id: '-999111',
        },
        initial_sales: [
          {
            full_name: 'Sale Một',
            email: 'sale1@zalosec.vn',
            phone: '0912000222',
            is_available: true,
            receive_ratio: 1,
          },
          {
            full_name: 'Sale Hai',
            email: 'sale2@zalosec.vn',
            phone: '0912000333',
            is_available: true,
            receive_ratio: 1,
          },
        ],
      },
    });
    assert.equal(reg.status, 201);
    const adminToken = reg.json.data.access_token;
    const tenantId = reg.json.data.tenant.id;

    // Add a 2nd active distribution round containing Sale Một to test multi-round compensation scoping
    const pipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', { token: adminToken, tenantSlug: slug });
    const usersRes = await apiRequest(harness.baseUrl, '/api/v1/users?role=sale', { token: adminToken, tenantSlug: slug });
    const sale1 = usersRes.json.data.items.find((u: any) => u.email === 'sale1@zalosec.vn');
    const sale2 = usersRes.json.data.items.find((u: any) => u.email === 'sale2@zalosec.vn');

    await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: {
        pipeline_id: pipes.json.data[0].id,
        name: 'Vòng Chia Phụ VIP',
        priority: 2,
        consultants: [{ user_id: sale1.id, receive_ratio: 1 }],
      },
    });

    // Create a lead assigned to Sale Một and another lead assigned to Sale Hai
    const l1 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: { name: 'Khách Của Sale 1', phone: '0933111222', force_assigned_to: sale1.id },
    });
    const l2 = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: { name: 'Khách Của Sale 2', phone: '0933111333', force_assigned_to: sale2.id },
    });
    const lead1Short = l1.json.data.leadId.slice(0, 8);
    const lead2Short = l2.json.data.leadId.slice(0, 8);

    // 1. Unlinked external Zalo user attempts `/tiepnhan` and `/baoloi` via public webhook -> MUST be blocked
    const unlinkedAccept = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'stranger_zalo_999', text: `/tiepnhan #${lead1Short}` },
    });
    assert.equal(unlinkedAccept.status, 200);
    assert.match(unlinkedAccept.json.data.replyText, /chưa được liên kết/i);

    // 2. Sale 1 links Zalo ID via `sale sale1@zalosec.vn`
    const bindSale1 = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_sale1', text: 'sale sale1@zalosec.vn' },
    });
    assert.match(bindSale1.json.data.replyText, /Đã liên kết tài khoản/i);

    // Sale 1 CANNOT `/tiepnhan` Sale 2's lead
    const crossAccept = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_sale1', text: `/tiepnhan #${lead2Short}` },
    });
    assert.match(crossAccept.json.data.replyText, /chính mình/i);

    // Sale 1 accepts own lead via `/tiepnhan` -> clears SLA timer so expired sweep is 0
    const ownAccept = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_sale1', text: `/tiepnhan #${lead1Short}` },
    });
    assert.match(ownAccept.json.data.replyText, /thành công/i);
    const stage0Id = pipes.json.data[0].stages[0].id;
    const slaRemaining = await tenantRedis.zrangebyscore('sla_queue', 0, Date.now() + 86_400_000, tenantId);
    assert.equal(
      slaRemaining.includes(`${l1.json.data.leadId}:${stage0Id}`),
      false,
      '/tiepnhan must remove initial SLA timer from sla_queue'
    );

    // Sale 1 files `/baoloi` on own lead
    const reportRes = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_sale1', text: `/baoloi #${lead1Short} Sai số điện thoại` },
    });
    const ticketShort = String(reportRes.json.data.metadata.ticket_id).slice(0, 8);

    // 3. Unlinked stranger AND linked Sale 1 both try `/duyet` -> BOTH strictly rejected!
    const strangerApprove = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'stranger_zalo_999', text: `/duyet #${ticketShort}` },
    });
    assert.match(strangerApprove.json.data.replyText, /Chỉ Quản lý hoặc Admin/i);

    const saleApprove = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_sale1', text: `/duyet #${ticketShort}` },
    });
    assert.match(saleApprove.json.data.replyText, /Chỉ Quản lý hoặc Admin/i);

    // 4. Admin binds Zalo ID and approves `/duyet` -> grants EXACTLY +1 credit (not +2 across 2 rounds!)
    await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_admin', text: 'sale admin@zalosec.vn' },
    });
    const adminApprove1 = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_admin', text: `/duyet #${ticketShort}` },
    });
    assert.match(adminApprove1.json.data.replyText, /Đã duyệt khiếu nại/i);

    // Re-sending `/duyet` on the SAME resolved ticket MUST NOT grant another credit!
    const adminApprove2 = await apiRequest(harness.baseUrl, `/api/v1/webhooks/zalo/${slug}`, {
      method: 'POST',
      body: { chat_id: '-999111', sender_id: 'zalo_uid_admin', text: `/duyet #${ticketShort}` },
    });
    assert.match(adminApprove2.json.data.replyText, /đã được xử lý trước đó/i);

    const totalCompCredits = await withTenantTransaction(tenantId, async (client) => {
      const r = await client.query<{ sum: number }>(
        'SELECT COALESCE(SUM(compensation_count), 0)::int AS sum FROM round_consultants WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, sale1.id]
      );
      return r.rows[0].sum;
    });
    assert.equal(totalCompCredits, 1, 'Approving 1 ticket must grant exactly 1 total credit even across multiple rounds');

    // 5. Upstream OAuth refresh failure transitions integration to `refresh_required`
    await withTenantTransaction(tenantId, async (client) => {
      await client.query(
        `UPDATE tenant_integrations
         SET token_expires_at = clock_timestamp() + interval '30 minutes'
         WHERE tenant_id = $1 AND integration_type = 'zalo_bot'`,
        [tenantId]
      );
    });
    const failedRefresh = await refreshExpiringZaloTokens(tenantId, async () => {
      throw new Error('Upstream Zalo OAuth 400 invalid_grant');
    });
    assert.equal(failedRefresh.failedCount, 1);

    const overview = await apiRequest(harness.baseUrl, '/api/v1/integrations/overview', {
      token: adminToken,
      tenantSlug: slug,
    });
    assert.equal(overview.json.data.integrations.zalo_bot.status, 'refresh_required');
  });

  it('Masks External Agency F1 PII on GET /leads/tickets/list and enforces Op 18 CSV Export RBAC', async () => {
    const slug = 'pii-export-corp';
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'PII & Export Corp',
        tenant_slug: slug,
        admin_name: 'Admin PII',
        work_email: 'admin@piiexport.vn',
        phone: '0905111222',
        password: 'Password123!',
        seed_demo_leads: false,
        initial_sales: [
          {
            full_name: 'Sàn Đại Lý F1',
            email: 'f1@piiexport.vn',
            phone: '0905333444',
            is_external_agency: true,
            is_available: true,
          },
          {
            full_name: 'Quản Lý Sàn',
            email: 'mgr@piiexport.vn',
            phone: '0905555666',
            role: 'manager',
            is_available: true,
          },
        ],
      },
    });
    assert.equal(reg.status, 201);
    const adminToken = reg.json.data.access_token;

    const f1Login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: slug,
      body: { email: 'f1@piiexport.vn', password: 'Password123!' },
    });
    const f1Token = f1Login.json.data.access_token;

    const mgrLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: slug,
      body: { email: 'mgr@piiexport.vn', password: 'Password123!' },
    });
    const mgrToken = mgrLogin.json.data.access_token;

    const leadRes = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: {
        name: 'Khách Biệt Thự Biển',
        phone: '0912345678',
        email: 'bietthu@vip.vn',
        force_assigned_to: f1Login.json.data.user.id,
      },
    });
    assert.equal(leadRes.status, 201);
    const leadId = leadRes.json.data.leadId;

    // External Agency F1 sees `pii_masked: true` on GET /leads
    const f1Leads = await apiRequest(harness.baseUrl, '/api/v1/leads', { token: f1Token, tenantSlug: slug });
    assert.equal(f1Leads.json.data.items[0].phone, '0912***678');
    assert.equal(f1Leads.json.data.items[0].pii_masked, true);

    // External Agency F1 creates ticket & queries GET /leads/tickets/list -> `lead_phone` MUST be masked!
    await apiRequest(harness.baseUrl, `/api/v1/leads/${leadId}/tickets`, {
      method: 'POST',
      token: f1Token,
      tenantSlug: slug,
      body: { reason: 'Thuê bao', description: 'Gọi số 0912345678 không liên lạc được' },
    });

    const f1Tickets = await apiRequest(harness.baseUrl, '/api/v1/leads/tickets/list', {
      token: f1Token,
      tenantSlug: slug,
    });
    assert.equal(f1Tickets.status, 200);
    assert.equal(f1Tickets.json.data.length, 1);
    assert.equal(f1Tickets.json.data[0].lead_phone, '0912***678', 'Ticket list must mask lead_phone for External Agency F1');
    assert.match(f1Tickets.json.data[0].description, /0912\*\*\*678/);

    // Op 18 CSV Export: 403 for Sale & Manager, 200 CSV with unmasked data for Tenant Admin
    const saleCsv = await fetch(`${harness.baseUrl}/api/v1/leads/export`, {
      headers: { Authorization: `Bearer ${f1Token}`, 'X-Tenant-Slug': slug },
    });
    assert.equal(saleCsv.status, 403);

    const mgrCsv = await fetch(`${harness.baseUrl}/api/v1/leads/export`, {
      headers: { Authorization: `Bearer ${mgrToken}`, 'X-Tenant-Slug': slug },
    });
    assert.equal(mgrCsv.status, 403);

    const adminCsv = await fetch(`${harness.baseUrl}/api/v1/leads/export`, {
      headers: { Authorization: `Bearer ${adminToken}`, 'X-Tenant-Slug': slug },
    });
    assert.equal(adminCsv.status, 200);
    assert.match(adminCsv.headers.get('content-type') || '', /text\/csv/i);
    const csvText = await adminCsv.text();
    assert.match(csvText, /Khách Biệt Thự Biển/);
    assert.match(csvText, /84912345678/);
  });

  it('Provisions Education / Clinic / B2B presets accurately, saves initial SMTP config, and dispatches Dual-Send CAPI via UI keys', async () => {
    let sentEmails = 0;
    setSmtpTransportForTesting(async (_cfg, msg) => {
      sentEmails += 1;
      assert.match(msg.to, /alert@edu-center\.vn/);
      return { accepted: true, messageId: 'test-smtp-msg-01' };
    });

    // 1. Education preset + initial SMTP config (`{ host, port, user }` shape from RegisterWizard)
    const regEdu = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Học Viện Anh Ngữ Quốc Tế',
        tenant_slug: 'edu-center',
        admin_name: 'Cô Minh',
        work_email: 'admin@edu-center.vn',
        phone: '0988111222',
        password: 'Password123!',
        industry: 'education',
        smtp_config: { host: 'smtp.gmail.com', port: 587, user: 'alert@edu-center.vn' },
      },
    });
    assert.equal(regEdu.status, 201);
    const eduToken = regEdu.json.data.access_token;

    const eduPipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: eduToken,
      tenantSlug: 'edu-center',
    });
    assert.match(eduPipes.json.data[0].name, /Tuyển Sinh Giáo Dục/i);
    assert.ok(eduPipes.json.data[0].custom_fields.some((f: any) => f.field_key === 'target_course'));

    // Verify initial SMTP config was persisted & works via POST /integrations/smtp/test
    const smtpTest = await apiRequest(harness.baseUrl, '/api/v1/integrations/smtp/test', {
      method: 'POST',
      token: eduToken,
      tenantSlug: 'edu-center',
      body: {},
    });
    assert.equal(smtpTest.status, 200);
    assert.equal(sentEmails, 1);

    // 2. `clinic_spa` alias provisions Healthcare pipeline (NOT Real Estate)
    const regSpa = await apiRequest(harness.baseUrl, '/api/v1/auth/register-tenant', {
      method: 'POST',
      body: {
        company_name: 'Viện Thẩm Mỹ Aura',
        tenant_slug: 'aura-clinic',
        admin_name: 'BS Lan',
        work_email: 'admin@aura-clinic.vn',
        phone: '0988333444',
        password: 'Password123!',
        industry: 'clinic_spa',
        seed_demo_leads: false,
      },
    });
    assert.equal(regSpa.status, 201);
    const spaPipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: regSpa.json.data.access_token,
      tenantSlug: 'aura-clinic',
    });
    assert.doesNotMatch(spaPipes.json.data[0].name, /Bất Động Sản/i);

    // 3. Dual-Send Meta CAPI configured with UI keys (`secondary_dataset_id`, `secondary_access_token`)
    await apiRequest(harness.baseUrl, '/api/v1/integrations/vault/meta_capi', {
      method: 'PUT',
      token: eduToken,
      tenantSlug: 'edu-center',
      body: {
        dataset_id: '111111111111111',
        access_token: 'sandbox_primary_tok',
        test_event_code: 'TEST_DUAL',
        dual_send: true,
        secondary_dataset_id: '222222222222222',
        secondary_access_token: 'sandbox_secondary_tok',
      },
    });

    const dualTest = await apiRequest(harness.baseUrl, '/api/v1/integrations/capi/test-event', {
      method: 'POST',
      token: eduToken,
      tenantSlug: 'edu-center',
      body: { event_name: 'Purchase', sample_phone: '0912345678' },
    });
    assert.equal(dualTest.status, 200);
    assert.equal(dualTest.json.data.dual_sent, true, 'Dual-Send CAPI must fire using secondary_dataset_id');
  });

  it('Matches Conditional Routing Rules (CONTAINS), triggers Multi-Stage SLA + SMTP alert, drains Recalled leads, and handles Multi-Tenant Same-Email Login', async () => {
    let slaEmails = 0;
    setSmtpTransportForTesting(async () => {
      slaEmails += 1;
      return { accepted: true, messageId: 'sla-alert-msg' };
    });

    const outboundEvents: string[] = [];
    setOutboundWebhookTransportForTesting(async (_url, opts) => {
      const headers = (opts.headers || {}) as Record<string, string>;
      const ev = headers['X-AutoData-Event'] || headers['x-autodata-event'];
      if (ev) outboundEvents.push(ev);
      return { status: 200, statusText: 'OK' };
    });

    const slug = 'routing-sla-corp';
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Routing & SLA Corp',
        tenant_slug: slug,
        admin_name: 'CEO Routing',
        work_email: 'shared-founder@enterprise.vn',
        phone: '0977000111',
        password: 'FirstTenantPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
        smtp_config: { notify_email: 'sla@enterprise.vn' },
        initial_sales: [
          { full_name: 'General Sale', email: 'gen@enterprise.vn', is_available: true },
          { full_name: 'VIP Closer', email: 'vip@enterprise.vn', is_available: true },
        ],
      },
    });
    assert.equal(reg.status, 201);
    const adminToken = reg.json.data.access_token;
    const tenantId = reg.json.data.tenant.id;

    // Register a SECOND tenant with the SAME email (`shared-founder@enterprise.vn`) and a DIFFERENT password
    const reg2 = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Second Venture Corp',
        tenant_slug: 'second-venture',
        admin_name: 'CEO Routing',
        work_email: 'shared-founder@enterprise.vn',
        phone: '0977000999',
        password: 'SecondTenantPassword456!',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg2.status, 201);

    // Login WITHOUT `tenant_slug` using Tenant #1's password -> must authenticate into Tenant #1 (`routing-sla-corp`)!
    const loginT1 = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'shared-founder@enterprise.vn', password: 'FirstTenantPassword123!' },
    });
    assert.equal(loginT1.status, 200);
    assert.equal(loginT1.json.data.tenant.slug, slug);

    // Subscribe outbound webhook to all 4 events
    await apiRequest(harness.baseUrl, '/api/v1/integrations/webhooks', {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: {
        name: 'All Events Hook',
        webhook_type: 'outbound',
        url: 'https://hooks.enterprise.vn/events',
        subscribed_events: ['lead.created', 'lead.assigned', 'lead.stage_changed', 'ticket.resolved'],
      },
    });

    const pipes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', { token: adminToken, tenantSlug: slug });
    const pipe = pipes.json.data[0];
    const staffRes = await apiRequest(harness.baseUrl, '/api/v1/users?role=sale', { token: adminToken, tenantSlug: slug });
    const genSale = staffRes.json.data.items.find((u: any) => u.email === 'gen@enterprise.vn');
    const vipSale = staffRes.json.data.items.find((u: any) => u.email === 'vip@enterprise.vn');

    // Create dedicated VIP round containing ONLY `vipSale` + routing rule `{ field: 'campaign', operator: 'CONTAINS', value: 'VIP' }`
    const vipRound = await apiRequest(harness.baseUrl, '/api/v1/pipelines/rounds', {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: {
        pipeline_id: pipe.id,
        name: 'VIP Exclusive Round',
        priority: 1,
        consultants: [{ user_id: vipSale.id, receive_ratio: 1 }],
      },
    });
    await apiRequest(harness.baseUrl, '/api/v1/pipelines/routing-rules', {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: {
        round_id: vipRound.json.data.id,
        rule_name: 'Route VIP Campaign',
        priority: 1,
        conditions_json: [{ field: 'campaign', operator: 'CONTAINS', value: 'VIP' }],
      },
    });

    // Ingest 3 VIP leads -> ALL 3 must route to `vipSale` via conditional routing rule!
    for (let i = 0; i < 3; i++) {
      const vipLead = await apiRequest(harness.baseUrl, '/api/v1/leads', {
        method: 'POST',
        token: adminToken,
        tenantSlug: slug,
        body: { name: `VIP Client ${i}`, phone: `096610020${i}`, campaign: 'Penthouse_VIP_Launch' },
      });
      assert.equal(vipLead.status, 201);
      assert.equal(vipLead.json.data.assignedTo, vipSale.id);
    }

    // Multi-Stage SLA: Transition accepted lead to Stage 2 (`sla_timeout_minutes > 0`), expire timer, and sweep!
    const allLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', { token: adminToken, tenantSlug: slug });
    const targetLeadId = allLeads.json.data.items[0].id;
    const stage2 = pipe.stages[1];
    assert.ok(stage2.sla_timeout_minutes > 0);

    const stTrans = await apiRequest(harness.baseUrl, `/api/v1/leads/${targetLeadId}/stage`, {
      method: 'PATCH',
      token: adminToken,
      tenantSlug: slug,
      body: { stage_id: stage2.id, note: 'Đã gọi lần 1' },
    });
    assert.equal(stTrans.status, 200);

    // Force-expire Stage 2 SLA timer and sweep
    await tenantRedis.zadd('sla_queue', Date.now() - 2000, `${targetLeadId}:${stage2.id}`, tenantId);
    const stage2Breached = await sweepExpiredSlaTimeouts(tenantId);
    assert.equal(stage2Breached, 1, 'Post-acceptance Stage 2 SLA timeout must breach when lead lingers past deadline');
    assert.ok(slaEmails >= 1, 'SLA breach must trigger tenant SMTP alert');

    // Recalled Lead Immediate Re-routing (Spec §3.2 Step 2):
    // Turn Admin offline so `genSale` is the sole online active consultant when `vipSale` is deactivated without `target_user_id`!
    await apiRequest(harness.baseUrl, '/api/v1/users/me/availability', {
      method: 'PATCH',
      token: adminToken,
      tenantSlug: slug,
      body: { is_available: false },
    });

    const deactVip = await apiRequest(harness.baseUrl, `/api/v1/users/${vipSale.id}/admin-status`, {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: { status: 'inactive', reassignment_mode: 'retain' },
    });
    assert.equal(deactVip.status, 200);
    assert.equal(deactVip.json.data.leads_recalled, 2);

    // The 2 recalled unaccepted leads MUST be immediately re-assigned to online `genSale` (never stranded unassigned)!
    const genLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      tenantSlug: slug,
      body: { email: 'gen@enterprise.vn', password: 'FirstTenantPassword123!' },
    });
    const genLeads = await apiRequest(harness.baseUrl, '/api/v1/leads', {
      token: genLogin.json.data.access_token,
      tenantSlug: slug,
    });
    assert.equal(genLeads.status, 200);
    assert.equal(
      genLeads.json.data.items.length,
      2,
      'Recalled unaccepted leads must be immediately re-routed to eligible online Sale when deactivated without explicit target_user_id'
    );

    // Manual reassign triggers `lead.assigned` outbound webhook
    await apiRequest(harness.baseUrl, `/api/v1/leads/${targetLeadId}/reassign`, {
      method: 'POST',
      token: adminToken,
      tenantSlug: slug,
      body: { target_user_id: genSale.id },
    });

    // Wait briefly for async outbound webhook dispatches
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(outboundEvents.includes('lead.created'));
    assert.ok(outboundEvents.includes('lead.stage_changed'));
    assert.ok(outboundEvents.includes('lead.assigned'));

    // Unknown `/api/*` endpoint returns structured JSON 404
    const notFound = await apiRequest(harness.baseUrl, '/api/v1/nonexistent-endpoint');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error.code, 'ENDPOINT_NOT_FOUND');
  });

  it('Accepts cross-origin POST /api/v1/auth/register-tenant from MY_PORTFOLIO /data with initial_sales & #autodata_sso handoff', async () => {
    const resp = await fetch(`${harness.baseUrl}/api/v1/auth/register-tenant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:4173',
      },
      body: JSON.stringify({
        company_name: 'Portfolio Cross-Origin Tenant',
        tenant_slug: 'portfolio-live-handoff',
        admin_name: 'Founder Portfolio',
        work_email: 'founder@portfolio-handoff.vn',
        phone: '0912888999',
        password: 'Password123!',
        industry: 'clinic_spa',
        smtp_config: { notify_email: 'alerts@portfolio-handoff.vn' },
        initial_sales: [
          { full_name: 'Sale Portfolio 1', email: 's1@portfolio-handoff.vn', is_available: true },
          { full_name: 'Sale Portfolio 2', email: 's2@portfolio-handoff.vn', is_available: false },
        ],
      }),
    });
    assert.equal(resp.status, 201);
    assert.ok(resp.headers.get('access-control-allow-origin'), 'CORS header must be returned for MY_PORTFOLIO origin');
    const json: any = await resp.json();

    // Verify #autodata_sso base64url token handoff matches TenantAuthContext boot decoder
    const ssoPayload = Buffer.from(
      JSON.stringify({ token: json.data.access_token, slug: json.data.tenant.slug }),
      'utf8'
    ).toString('base64url');
    const decoded = JSON.parse(Buffer.from(ssoPayload, 'base64url').toString('utf8'));
    assert.equal(decoded.slug, 'portfolio-live-handoff');

    const me = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: decoded.token,
      tenantSlug: decoded.slug,
    });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.tenant.industry, 'clinic_spa');

    const roster = await apiRequest(harness.baseUrl, '/api/v1/users', {
      token: decoded.token,
      tenantSlug: decoded.slug,
    });
    assert.equal(roster.status, 200);
    assert.equal(roster.json.data.items.length, 3, 'Admin + 2 initial_sales from MY_PORTFOLIO /data Step 3 toggles must exist');
  });
});
