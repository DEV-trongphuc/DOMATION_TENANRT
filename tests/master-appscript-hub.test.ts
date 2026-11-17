import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withSystemPrivilege } from '../server/core/database/transaction.ts';
import {
  DEFAULT_DOMATION_SPREADSHEET_ID,
  invalidatePlatformAppscriptCache,
  setPlatformAppscriptFetcher,
} from '../server/services/platform-appscript.service.ts';
import { resetConsultationDedupCacheForTests } from '../server/routes/public.routes.ts';
import { runSubscriptionExpiryManager } from '../server/cron/subroutines/billing-manager.ts';

interface CapturedAppscriptCall {
  url: string;
  payload: Record<string, any>;
}

async function waitForCapturedEvent(
  events: CapturedAppscriptCall[],
  predicate: (p: Record<string, any>) => boolean,
  timeoutMs = 2500
): Promise<CapturedAppscriptCall> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = events.find((e) => predicate(e.payload));
    if (match) return match;
    await delay(25);
  }
  throw new Error(
    `Timed out waiting for Apps Script event. Captured so far: ${events.map((e) => e.payload.event_type).join(', ')}`
  );
}

describe('DOMATION Master Google Sheet & Apps Script Hub (All Forms + Registration + Billing/Renewals)', () => {
  let harness: TestHarness;
  let platformToken = '';
  const captured: CapturedAppscriptCall[] = [];
  const mockUrl = 'https://script.google.com/macros/s/AKfycbMockMasterDomationHub12345/exec';
  const mockSecret = 'domation-master-secret-999';

  before(async () => {
    harness = await startTestServer();
    setPlatformAppscriptFetcher(async (url, payload) => {
      captured.push({ url, payload });
      return {
        ok: true,
        status: 200,
        json: {
          success: true,
          event_type: payload.event_type,
          customer_mail_status: payload.email ? 'SENT' : 'SKIPPED_NO_EMAIL',
          admin_alert_sent: true,
          remaining_quota: 95,
        },
      };
    });

    const loginSa = await apiRequest(harness.baseUrl, '/api/v1/admin/auth/login', {
      method: 'POST',
      body: {
        email: 'ops-admin@autodata.vn',
        password: 'SuperAdminMasterPassword999!',
      },
    });
    assert.equal(loginSa.status, 200);
    platformToken = loginSa.json.data.access_token;
  });

  beforeEach(() => {
    captured.length = 0;
    resetConsultationDedupCacheForTests();
  });

  after(async () => {
    setPlatformAppscriptFetcher(null);
    invalidatePlatformAppscriptCache();
    await harness.close();
  });

  it('1. SuperAdmin validates, saves & tests Master Apps Script config pointing to Sheet 1FiCtjay20ZhIg4t4DHs3ONucrmjg4Ah5MBeofjxvV-A', async () => {
    const bad = await apiRequest(harness.baseUrl, '/api/v1/admin/master-appscript', {
      method: 'PUT',
      token: platformToken,
      body: {
        webhook_url: 'https://evil-domain.example.com/hook',
      },
    });
    assert.equal(bad.status, 422);

    const save = await apiRequest(harness.baseUrl, '/api/v1/admin/master-appscript', {
      method: 'PUT',
      token: platformToken,
      body: {
        enabled: true,
        webhook_url: mockUrl,
        secret: mockSecret,
        admin_notify_email: 'domation.net@gmail.com',
      },
    });
    assert.equal(save.status, 200);
    assert.equal(save.json.data.spreadsheet_id, DEFAULT_DOMATION_SPREADSHEET_ID);
    assert.equal(save.json.data.has_secret, true);
    assert.ok(save.json.data.secret.includes('*'));

    const testRes = await apiRequest(harness.baseUrl, '/api/v1/admin/master-appscript/test', {
      method: 'POST',
      token: platformToken,
      body: { to: 'domation.net@gmail.com' },
    });
    assert.equal(testRes.status, 200);
    assert.equal(testRes.json.data.success, true);

    const ev = await waitForCapturedEvent(captured, (p) => p.event_type === 'test_connection');
    assert.equal(ev.url, mockUrl);
    assert.equal(ev.payload.secret, mockSecret);
    assert.equal(ev.payload.spreadsheet_id, DEFAULT_DOMATION_SPREADSHEET_ID);
    assert.equal(ev.payload.to, 'domation.net@gmail.com');
  });

  it('2. Captures consultation forms from /web-design, /crm, /automation, /meta-ad-report & ContactModal + deduplicates double clicks', async () => {
    const missingContact = await apiRequest(harness.baseUrl, '/api/v1/public/consultation', {
      method: 'POST',
      body: { name: 'Empty Contact', service: 'CRM' },
    });
    assert.equal(missingContact.status, 422);

    const badEmail = await apiRequest(harness.baseUrl, '/api/v1/public/consultation', {
      method: 'POST',
      body: { email: 'not-an-email', phone: '0909123456' },
    });
    assert.equal(badEmail.status, 422);

    // Web Design quote via legacy /api/autodata?action=consultation bridge
    const webQuote = await apiRequest(harness.baseUrl, '/api/autodata?action=consultation', {
      method: 'POST',
      body: {
        email: 'ceo@brandx.vn',
        phone: '0912345678',
        service: 'Thiết Kế Website Enterprise & Sa Bàn 3D (/web-design)',
        budget_or_scale: '22.000.000 VNĐ',
        addons_summary: 'Gói Cơ bản 12M + Kết nối CRM & ERP 5.0 (+10.0M)',
        total_price_vnd: 22000000,
        message: 'Cần bàn giao nhanh trong 3 tuần',
        source_form: '/web-design',
        utm_source: 'google',
        utm_campaign: 'web_bds',
      },
    });
    assert.equal(webQuote.status, 201);
    assert.equal(webQuote.json.data.saved_to_db, true);
    assert.equal(webQuote.json.data.sheets_dispatched, true);
    assert.ok(String(webQuote.json.data.lead_code).startsWith('DOM-'));

    const webEv = await waitForCapturedEvent(captured, (p) => p.email === 'ceo@brandx.vn');
    assert.equal(webEv.payload.event_type, 'consultation');
    assert.equal(webEv.payload.source_form, '/web-design');
    assert.equal(webEv.payload.total_price_vnd, 22000000);
    assert.equal(webEv.payload.secret, mockSecret);

    // Immediate duplicate click within 15s should deduplicate cleanly without re-sending Apps Script
    const beforeCount = captured.length;
    const dupRes = await apiRequest(harness.baseUrl, '/api/autodata?action=consultation', {
      method: 'POST',
      body: {
        email: 'ceo@brandx.vn',
        phone: '0912345678',
        source_form: '/web-design',
        message: 'double click',
      },
    });
    assert.equal(dupRes.status, 200);
    assert.equal(dupRes.json.data.deduplicated, true);
    assert.equal(captured.length, beforeCount);

    // SuperAdmin DB audit trail contains persisted consultation
    const listRes = await apiRequest(harness.baseUrl, '/api/v1/admin/consultations?limit=10', {
      token: platformToken,
    });
    assert.equal(listRes.status, 200);
    const savedRow = listRes.json.data.items.find((r: any) => r.email === 'ceo@brandx.vn');
    assert.ok(savedRow);
    assert.equal(savedRow.source_form, '/web-design');
    assert.equal(savedRow.appscript_status, 'dispatched');
  });

  it('3. Dispatches Workspace Registration, Wallet Topup, Plan Subscribe/Renewal, Upgrade & Admin Grant events to Master Sheet', async () => {
    const slug = `master-mail-co-${Date.now().toString(36).slice(-4)}`;
    const adminEmail = `owner@${slug}.vn`;

    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Công Ty BĐS An Phú',
        tenant_slug: slug,
        admin_name: 'Nguyễn An Phú',
        work_email: adminEmail,
        phone: '0908111333',
        password: 'StrongPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const tenantId = reg.json.data.tenant.id;
    const tenantToken = reg.json.data.access_token;

    const regEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'workspace_registered' && p.tenant_slug === slug
    );
    assert.equal(regEv.payload.email, adminEmail);
    assert.equal(regEv.payload.tenant_name, 'Công Ty BĐS An Phú');

    // Topup request -> Pending -> Admin Approve
    const topupReq = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantToken,
      body: { package_id: 'topup_3m' },
    });
    assert.equal(topupReq.status, 201);
    const topupTx = topupReq.json.data.transaction;

    const topupReqEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'topup_requested' && p.reference_code === topupTx.reference_code
    );
    assert.equal(topupReqEv.payload.email, adminEmail);
    assert.ok(topupReqEv.payload.bank_info?.account_number);

    const approveTopup = await apiRequest(
      harness.baseUrl,
      `/api/v1/admin/billing/requests/${topupTx.id}/resolve`,
      {
        method: 'POST',
        token: platformToken,
        body: { decision: 'approve', resolution_note: 'Đã nhận VCB' },
      }
    );
    assert.equal(approveTopup.status, 200);

    const topupAppEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'topup_approved' && p.reference_code === topupTx.reference_code
    );
    assert.equal(topupAppEv.payload.status, 'approved');
    assert.ok(Number(topupAppEv.payload.wallet_balance_vnd) >= Number(topupTx.amount_vnd));

    // Rejected Topup request -> topup_rejected
    const topupRejReq = await apiRequest(harness.baseUrl, '/api/v1/billing/topup', {
      method: 'POST',
      token: tenantToken,
      body: { amount_vnd: 2_000_000 },
    });
    assert.equal(topupRejReq.status, 201);
    const rejTx = topupRejReq.json.data.transaction;

    await apiRequest(harness.baseUrl, `/api/v1/admin/billing/requests/${rejTx.id}/resolve`, {
      method: 'POST',
      token: platformToken,
      body: { decision: 'reject', resolution_note: 'Sai nội dung CK' },
    });
    await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'topup_rejected' && p.reference_code === rejTx.reference_code
    );

    // Instant Subscribe from Wallet -> subscription_activated
    const subWallet = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tenantToken,
      body: { plan_code: 'autodata_standard', billing_cycle: 'monthly', payment_method: 'wallet' },
    });
    assert.equal(subWallet.status, 200);
    const subEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'subscription_activated' && p.tenant_slug === slug
    );
    assert.equal(subEv.payload.plan_code, 'autodata_standard');
    assert.equal(subEv.payload.email, adminEmail);

    // Bank-transfer Subscribe -> subscription_requested
    const subBank = await apiRequest(harness.baseUrl, '/api/v1/billing/subscribe', {
      method: 'POST',
      token: tenantToken,
      body: { plan_code: 'autodata_growth', billing_cycle: 'annual', payment_method: 'bank_transfer' },
    });
    assert.equal(subBank.status, 201);
    await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'subscription_requested' && p.plan_code === 'autodata_growth'
    );

    // CRM / ERP Upgrade Request + Approval -> crm_erp_upgrade_requested + crm_erp_upgrade_approved
    const upgReq = await apiRequest(harness.baseUrl, '/api/v1/billing/upgrade-request', {
      method: 'POST',
      token: tenantToken,
      body: { target_suite: 'crm_erp_bundle', contact_phone: '0908111333' },
    });
    assert.equal(upgReq.status, 201);
    const upgTx = upgReq.json.data.transaction;
    await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'crm_erp_upgrade_requested' && p.reference_code === upgTx.reference_code
    );

    await apiRequest(harness.baseUrl, `/api/v1/admin/billing/requests/${upgTx.id}/resolve`, {
      method: 'POST',
      token: platformToken,
      body: { decision: 'approve' },
    });
    await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'crm_erp_upgrade_approved' && p.reference_code === upgTx.reference_code
    );

    // SuperAdmin direct grant -> admin_grant
    const grantRes = await apiRequest(harness.baseUrl, `/api/v1/admin/tenants/${tenantId}/billing-grant`, {
      method: 'POST',
      token: platformToken,
      body: { topup_amount_vnd: 500_000, extend_days: 15, note: 'Quà tri ân' },
    });
    assert.equal(grantRes.status, 200);
    const grantEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'admin_grant' && p.tenant_slug === slug
    );
    assert.equal(grantEv.payload.amount_vnd, 500_000);
  });

  it('4. Billing Cron dispatches idempotent expiry_warning, auto_renewal_success & subscription_expired_suspended', async () => {
    const slugCron = `cron-mail-${Date.now().toString(36).slice(-4)}`;
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Cron Expiry Studio',
        tenant_slug: slugCron,
        admin_name: 'Lê Cron',
        work_email: `cron@${slugCron}.vn`,
        phone: '0911222444',
        password: 'StrongPassword123!',
        industry: 'education',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const tid = reg.json.data.tenant.id;

    // Case A: 2 days left -> expiry_warning once, second cron tick should NOT duplicate
    const twoDaysIso = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await withSystemPrivilege(async (client) => {
      await client.query(
        `UPDATE tenants SET trial_ends_at = $2::timestamptz, subscription_expires_at = $2::timestamptz, wallet_balance_vnd = 2000000 WHERE id = $1`,
        [tid, twoDaysIso]
      );
    });
    await runSubscriptionExpiryManager(tid);
    const warnEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'expiry_warning' && p.tenant_slug === slugCron
    );
    assert.ok(warnEv.payload.days_remaining <= 3);

    const warnsBefore = captured.filter(
      (c) => c.payload.event_type === 'expiry_warning' && c.payload.tenant_slug === slugCron
    ).length;
    await runSubscriptionExpiryManager(tid);
    await delay(40);
    const warnsAfter = captured.filter(
      (c) => c.payload.event_type === 'expiry_warning' && c.payload.tenant_slug === slugCron
    ).length;
    assert.equal(warnsAfter, warnsBefore, 'Expiry warning milestone must be idempotent per billing cycle');

    // Case B: Expired WITH wallet >= 1.5M -> auto_renewal_success
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    await withSystemPrivilege(async (client) => {
      await client.query(
        `UPDATE tenants SET trial_ends_at = $2::timestamptz, subscription_expires_at = $2::timestamptz, wallet_balance_vnd = 2000000 WHERE id = $1`,
        [tid, pastIso]
      );
    });
    const renewCount = await runSubscriptionExpiryManager(tid);
    assert.equal(renewCount, 1);
    const autoEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'auto_renewal_success' && p.tenant_slug === slugCron
    );
    assert.equal(autoEv.payload.wallet_balance_vnd, 500_000);

    // Case C: Expired WITHOUT enough wallet -> suspended + subscription_expired_suspended
    await withSystemPrivilege(async (client) => {
      await client.query(
        `UPDATE tenants SET trial_ends_at = $2::timestamptz, subscription_expires_at = $2::timestamptz, wallet_balance_vnd = 100000, status = 'active' WHERE id = $1`,
        [tid, pastIso]
      );
    });
    const suspCount = await runSubscriptionExpiryManager(tid);
    assert.equal(suspCount, 1);
    const suspEv = await waitForCapturedEvent(
      captured,
      (p) => p.event_type === 'subscription_expired_suspended' && p.tenant_slug === slugCron
    );
    assert.equal(suspEv.payload.status, 'suspended');
    assert.ok(suspEv.payload.shortfall_vnd > 0);
  });
});
