import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import {
  renderTemplateString,
  flattenCustomFieldVars,
  resolveTenantBrandName,
  normalizeTenantSettings,
} from '../server/core/settings/tenant-settings.ts';
import { getPlatformOperationalConfigCached } from '../server/core/settings/platform-config.ts';
import {
  renderEmailHtmlEnvelope,
  setSmtpTransportForTesting,
  processZaloBotCommand,
} from '../server/services/zalo-mail.service.ts';
import { processTelegramBotCommand } from '../server/services/telegram.service.ts';

describe('Zero-Hardcode Dynamic Settings, Branding, Templates, Co-Managers, Analytics & Platform Cron Config', () => {
  let harness: TestHarness;
  let platformToken = '';
  let adminToken = '';
  let saleId = '';
  let saleToken = '';
  let tenantId = '';
  const tenantSlug = 'zero-hardcode-corp';

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    setSmtpTransportForTesting(null);
    await harness.close();
  });

  it('1. SuperAdmin configures Platform Operational Limits with OOM-safe clamping', async () => {
    const loginSa = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(loginSa.status, 200);
    platformToken = loginSa.json.data.access_token;

    const getInitial = await apiRequest(harness.baseUrl, '/api/v1/admin/platform-settings', {
      token: platformToken,
    });
    assert.equal(getInitial.status, 200);
    assert.equal(getInitial.json.data.operational_limits.cron_limits.sla_batch_limit, 100);
    assert.equal(getInitial.json.data.operational_limits.cron_limits.capi_retry_limit, 15);
    assert.equal(getInitial.json.data.operational_limits.cron_limits.webhook_retry_limit, 20);
    assert.equal(getInitial.json.data.operational_limits.cron_limits.billing_batch_limit, 25);

    const patchOps = await apiRequest(harness.baseUrl, '/api/v1/admin/platform-settings', {
      method: 'PATCH',
      token: platformToken,
      body: {
        operational_limits: {
          cron_limits: {
            sla_batch_limit: 99999,
            drain_batch_limit: 250,
            capi_retry_limit: 1,
            webhook_retry_limit: 40,
            billing_batch_limit: 1000,
            webhook_max_retries: 15,
            webhook_backoff_seconds: [10, 600, 999999],
          },
          industry_preset_overrides: {
            b2b: { label: 'Phễu B2B Doanh Nghiệp Tuỳ Biến' },
          },
        },
      },
    });
    assert.equal(patchOps.status, 200);
    const savedCron = patchOps.json.data.operational_limits.cron_limits;
    assert.equal(savedCron.sla_batch_limit, 500, 'Clamped to max 500');
    assert.equal(savedCron.drain_batch_limit, 250);
    assert.equal(savedCron.capi_retry_limit, 5, 'Clamped to min 5');
    assert.equal(savedCron.webhook_retry_limit, 40);
    assert.equal(savedCron.billing_batch_limit, 500, 'Clamped to max 500');
    assert.equal(savedCron.webhook_max_retries, 15);
    assert.deepEqual(savedCron.webhook_backoff_seconds, [30, 600, 86400]);

    const cachedOps = await getPlatformOperationalConfigCached();
    assert.equal(cachedOps.cron_limits.sla_batch_limit, 500);
    assert.equal(
      cachedOps.industry_preset_overrides.b2b?.label,
      'Phễu B2B Doanh Nghiệp Tuỳ Biến'
    );

    const regOverrideTenant = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Override Industry Check',
        tenant_slug: 'override-b2b-check',
        admin_name: 'Admin B2B',
        work_email: 'admin@override-b2b.vn',
        phone: '0903334455',
        password: 'AdminPassword123!',
        industry: 'b2b',
        seed_demo_leads: false,
      },
    });
    assert.equal(regOverrideTenant.status, 201);
    const b2bToken = regOverrideTenant.json.data.access_token;
    const pipesRes = await apiRequest(harness.baseUrl, '/api/v1/pipelines', {
      token: b2bToken,
      tenantSlug: 'override-b2b-check',
    });
    assert.equal(pipesRes.status, 200);
    assert.equal(pipesRes.json.data[0].name, 'Phễu B2B Doanh Nghiệp Tuỳ Biến');

    // Reset factory defaults cleanly
    const resetRes = await apiRequest(harness.baseUrl, '/api/v1/admin/platform-settings', {
      method: 'PATCH',
      token: platformToken,
      body: { reset_to_factory: true },
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.data.operational_limits.cron_limits.sla_batch_limit, 100);
  });

  it('2. Legacy save_settings / get_settings roundtrips all 70+ settings & white-label brand keys', async () => {
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Zero Hardcode Real Estate',
        tenant_slug: tenantSlug,
        admin_name: 'CEO Zero Hardcode',
        work_email: 'ceo@zero-hardcode.vn',
        phone: '0904445566',
        password: 'AdminPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
    tenantId = reg.json.data.tenant.id;

    const saveRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        brand_display_name: 'Novaland Elite CRM',
        brand_logo_url: 'https://cdn.example.com/novaland.png',
        brand_primary_color: '#0F766E',
        brand_email_accent_color: '#EA580C',
        brand_email_footer_text: 'Hệ thống CRM Độc quyền Novaland',
        support_email: 'support@novaland-crm.vn',
        distribution_mode: 'least_loaded',
        max_co_managers_per_consultant: 5,
        default_table_page_size: 50,
        default_date_filter: '30d',
        blocked_phone_sequences: ['0888888888', '0111122222'],
        default_closed_deal_value_vnd: 120000000,
        ads_target_cpl_vnd: 450000,
        ads_min_positive_rate_pct: 32,
        ads_max_frequency_fatigue: 4.2,
        fairness_warning_threshold_pct: 82,
        timezone_name: 'Asia/Bangkok',
        work_schedule_start: '09:00',
        work_schedule_end: '19:00',
        work_schedule_saturday_end: '16:00',
        work_schedule_sunday_enabled: true,
        zalo_bot_link: 'https://zalo.me/custom_bot_demo',
        note_types: [
          { value: 'SITE_VISIT', label: 'Đưa khách xem nhà mẫu', cat: 'call', internal_only: false },
          { value: 'INTERNAL_AUDIT', label: 'Ghi chú quản lý nội bộ', cat: 'note', internal_only: true },
        ],
        pipeline_capi_stages: [
          { key: 'Qualified', label: 'Đủ ĐK BĐS', short_label: 'Đủ ĐK', color: '#22c55e', group: 'positive', is_qualified: true, capi_event: 'Lead', enabled: true, order: 1 },
          { key: 'SiteVisit', label: 'Khách xem nhà mẫu', short_label: 'Xem mẫu', color: '#0ea5e9', group: 'positive', is_qualified: true, capi_event: 'ViewContent', enabled: true, order: 2 },
          { key: 'Notlead', label: 'Rác / Sai số', short_label: 'Sai số', color: '#ef4444', group: 'negative', is_qualified: false, capi_event: '', enabled: true, order: 3 },
        ],
        notification_templates: {
          assign_email_subject: '[{{brand_name}}] Lead VIP {{customer_name}} - {{custom_fields.budget_vnd}}',
          ticket_admin_subject: '[{{brand_name}}] Ticket báo lỗi mới #{{lead_short_id}} ({{reason}})',
          bot_chatid_reply: 'ID nhóm {{brand_name}}: {{chat_id}}',
        },
      },
    });
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.json.success, true);

    const getRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(getRes.status, 200);
    const data = getRes.json.data;
    assert.equal(data.brand_display_name, 'Novaland Elite CRM');
    assert.equal(data.brand_email_accent_color, '#EA580C');
    assert.equal(data.max_co_managers_per_consultant, 5);
    assert.equal(data.default_table_page_size, 50);
    assert.equal(data.default_date_filter, '30d');
    assert.equal(data.default_closed_deal_value_vnd, 120000000);
    assert.equal(data.ads_target_cpl_vnd, 450000);
    assert.equal(data.ads_min_positive_rate_pct, 32);
    assert.equal(data.ads_max_frequency_fatigue, 4.2);
    assert.equal(data.fairness_warning_threshold_pct, 82);
    assert.equal(data.distribution_mode, 'least_loaded');
    assert.equal(data.timezone_name, 'Asia/Bangkok');
    assert.equal(data.work_schedule_sunday_enabled, true);
    assert.equal(data.tenant_settings.note_types.length, 2);
    assert.equal(data.tenant_settings.pipeline_capi_stages.length, 3);
    assert.equal(data.tenant_settings.pipeline_capi_stages[1].key, 'SiteVisit');

    // Verify CAPI dashboard picks up dynamic closed value instead of 50,000,000
    const capiDash = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_capi_dashboard', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(capiDash.status, 200);
    assert.equal(capiDash.json.closed_value_vnd, 120000000);

    // Verify Fair-Share & Ads Performance expose tenant-configured thresholds
    const fairRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_fair_share_stats', {
      token: adminToken,
      tenantSlug,
    });
    assert.equal(fairRes.status, 200);
    assert.equal(fairRes.json.data.fairness_warning_threshold_pct, 82);

    const adsRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_ads_performance_dashboard',
      { token: adminToken, tenantSlug }
    );
    assert.equal(adsRes.status, 200);
    assert.equal(adsRes.json.ads_benchmarks.target_cpl_vnd, 450000);
    assert.equal(adsRes.json.ads_benchmarks.min_positive_rate_pct, 32);
    assert.equal(adsRes.json.ads_benchmarks.max_frequency_fatigue, 4.2);
    assert.equal(adsRes.json.ads_benchmarks.default_closed_deal_value_vnd, 120000000);
  });

  it('3. Dynamic max_co_managers_per_consultant allows 5 co-managers and blocks 6th across v1 and legacy', async () => {
    const createSale = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        full_name: 'Sale Multi CoMgr',
        email: 'sale.comgr@zero-hardcode.vn',
        password: 'SalePassword123!',
        role: 'sale',
        is_available: true,
      },
    });
    assert.equal(createSale.status, 201);
    saleId = createSale.json.data.id;

    const saleLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'sale.comgr@zero-hardcode.vn',
        password: 'SalePassword123!',
        tenant_slug: tenantSlug,
      },
    });
    assert.equal(saleLogin.status, 200);
    saleToken = saleLogin.json.data.access_token;

    // Add 4 co-managers via v1 route (would fail at #4 if still hardcoded >= 3)
    for (let i = 1; i <= 4; i++) {
      const r = await apiRequest(harness.baseUrl, `/api/v1/operations/co-managers/${saleId}`, {
        method: 'POST',
        token: saleToken,
        tenantSlug,
        body: { name: `CoMgr ${i}`, email: `cm${i}@zero-hardcode.vn` },
      });
      assert.equal(r.status, 201, `Co-manager #${i} should be allowed under limit 5`);
    }

    // Add 5th co-manager via legacy action (Admin action)
    const r5 = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=add_consultant_manager', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { consultant_id: saleId, name: 'CoMgr 5', email: 'cm5@zero-hardcode.vn' },
    });
    assert.equal(r5.status, 200);
    assert.equal(r5.json.managers.length, 5);

    // 6th co-manager is rejected with dynamic limit 5
    const r6 = await apiRequest(harness.baseUrl, `/api/v1/operations/co-managers/${saleId}`, {
      method: 'POST',
      token: saleToken,
      tenantSlug,
      body: { name: 'CoMgr 6', email: 'cm6@zero-hardcode.vn' },
    });
    assert.equal(r6.status, 422);
    assert.equal(r6.json.error.code, 'MAX_CO_MANAGERS_REACHED');
    assert.ok(String(r6.json.error.message).includes('5'));

    // Sale Portal returns max_co_managers_per_consultant + configured zalo_bot_link
    const portalRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_sale_portal_data',
      { token: saleToken, tenantSlug }
    );
    assert.equal(portalRes.status, 200);
    assert.equal(portalRes.json.data.max_co_managers_per_consultant, 5);
    assert.equal(portalRes.json.data.zalo_bot_link, 'https://zalo.me/custom_bot_demo');
  });

  it('4. Dynamic templates, custom_fields interpolation, bot /chatid replies & custom pipeline analytics', async () => {
    const vars = {
      ...flattenCustomFieldVars({ budget_vnd: '8.5 Tỷ' }),
      brand_name: resolveTenantBrandName(
        normalizeTenantSettings({ brand_display_name: 'Novaland Elite CRM' })
      ),
      customer_name: 'Nguyễn Minh Quân',
    };
    const renderedSubj = renderTemplateString(
      '[{{brand_name}}] Lead VIP {{customer_name}} - {{custom_fields.budget_vnd}}',
      vars
    );
    assert.equal(renderedSubj, '[Novaland Elite CRM] Lead VIP Nguyễn Minh Quân - 8.5 Tỷ');

    const html = renderEmailHtmlEnvelope({
      title: renderedSubj,
      badge: 'PHÂN BỔ LEAD MỚI',
      accentColor: '#EA580C',
      summaryText: 'Test custom brand email',
      tenantName: 'Novaland Elite CRM',
      footerText: 'Hệ thống CRM Độc quyền Novaland',
    });
    assert.ok(html.includes('#EA580C'));
    assert.ok(html.includes('Novaland Elite CRM'));
    assert.ok(html.includes('Hệ thống CRM Độc quyền Novaland'));

    // Telegram & Zalo /chatid obey custom bot_chatid_reply template
    const tgChatId = await processTelegramBotCommand({
      tenantId,
      chatId: '-100555999',
      text: '/chatid',
      senderName: 'Sale',
    });
    assert.equal(tgChatId.handled, true);
    assert.ok(tgChatId.replyText.includes('-100555999'));

    const zaloChatId = await processZaloBotCommand({
      tenantId,
      chatId: 'zalo_grp_777',
      senderZaloUserId: 'zalo_user_test_1',
      text: '/chatid',
    });
    assert.equal(zaloChatId.handled, true);
    assert.ok(zaloChatId.replyText.includes('zalo_grp_777'));

    // Ticket submit email uses custom ticket_admin_subject template + custom brand
    const sentEmails: Array<{ to: string; subject: string }> = [];
    setSmtpTransportForTesting(async (_cfg, msg) => {
      sentEmails.push({ to: msg.to, subject: msg.subject });
      return { accepted: true, messageId: 'test-msg-id' };
    });

    // Ingest a lead & assign custom stage 'SiteVisit' -> check dynamic get_dashboard_stats pipeline count & timezone SQL
    const ingestRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=manual_insert_lead', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: {
        name: 'Khách Xem Mẫu VIP',
        phone: '0977888999',
        source: 'Facebook Ads',
        override_consultant_id: saleId,
      },
    });
    assert.equal(ingestRes.status, 200);
    const createdLeadId =
      ingestRes.json.data?.leadId || ingestRes.json.data?.lead_id || ingestRes.json.data?.id;
    assert.ok(createdLeadId);

    // Update lead quality_status to custom stage 'SiteVisit'
    const evalRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=update_lead_quality',
      {
        method: 'POST',
        token: adminToken,
        tenantSlug,
        body: { lead_id: createdLeadId, quality_status: 'SiteVisit' },
      }
    );
    assert.equal(evalRes.status, 200);

    // Configure fallback_cc_email so submit_report sends ticket email
    await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: adminToken,
      tenantSlug,
      body: { fallback_cc_email: 'notify@novaland-crm.vn' },
    });

    const submitTicket = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=submit_report', {
      method: 'POST',
      token: saleToken,
      tenantSlug,
      body: {
        lead_id: createdLeadId,
        reason: 'Sai số',
        description: 'Thuê bao không liên lạc được',
      },
    });
    assert.equal(submitTicket.status, 200);
    assert.ok(
      sentEmails.some((m) => m.subject.includes('Novaland Elite CRM') && m.subject.includes('Sai số')),
      `Expected custom ticket template email, got: ${JSON.stringify(sentEmails)}`
    );

    const dashRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_dashboard_stats&date=Tháng này',
      { token: adminToken, tenantSlug }
    );
    assert.equal(dashRes.status, 200);
    assert.equal(dashRes.json.data.pipeline_stats.overall.SiteVisit, 1);
  });
});
