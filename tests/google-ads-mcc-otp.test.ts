import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { setDomMetaExternalFetcherForTesting } from '../server/services/dom-meta-report.service.ts';
import {
  saveMasterAppscriptConfig,
  setPlatformAppscriptFetcher,
} from '../server/services/platform-appscript.service.ts';

describe('Google Ads MCC Hub Quick Setup + Zero-Trust Owner OTP + Multi-ID', () => {
  let harness: TestHarness;
  let tokenA = '';
  let tokenB = '';
  const capturedMails: Array<Record<string, unknown>> = [];
  const fetchedUrls: string[] = [];

  before(async () => {
    harness = await startTestServer();
    await saveMasterAppscriptConfig({
      enabled: true,
      webhook_url: 'https://script.google.com/macros/s/AKfycb_test_master_mail/exec',
      secret: 'test_secret',
    });

    setPlatformAppscriptFetcher(async (_url, payload) => {
      capturedMails.push(payload);
      return { ok: true, status: 200, json: { success: true } };
    });

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'IDEAS Education Group',
        tenant_slug: 'ideas-mcc-test',
        admin_name: 'IDEAS Admin',
        work_email: 'admin@ideas-test.vn',
        phone: '0901999111',
        password: 'StrongPassword123!',
        industry: 'education',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tokenA = regA.json.data.access_token;

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Intruder Agency',
        tenant_slug: 'intruder-mcc-test',
        admin_name: 'Intruder',
        work_email: 'hacker@evil-test.vn',
        phone: '0909888777',
        password: 'StrongPassword123!',
        industry: 'general',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tokenB = regB.json.data.access_token;
  });

  after(async () => {
    setDomMetaExternalFetcherForTesting(null);
    setPlatformAppscriptFetcher(null);
    await harness.close();
  });

  it('sends MCC invite email (to domation.net@gmail.com, cc turniodev@gmail.com) for unlinked IDs and blocks proxy until verified', async () => {
    capturedMails.length = 0;
    setDomMetaExternalFetcherForTesting(async (url) => {
      fetchedUrls.push(url);
      if (url.includes('action=inspect_mcc_account')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            linked: false,
            status: 'pending_mcc',
            customer_id: '888-111-2222',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ h: [], d: [] }) };
    });

    const reqRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads/mcc-add-or-request', {
      method: 'POST',
      token: tokenA,
      body: {
        items: [{ customer_id: '8881112222', label: 'IDEAS New Brand' }],
        note: 'Mời giúp mình tài khoản mới chạy khóa MBA',
      },
    });
    assert.equal(reqRes.status, 200);
    assert.equal(reqRes.json.data.pending_mcc_ids[0], '888-111-2222');
    assert.equal(reqRes.json.data.google_ads.setup_mode, 'mcc_quick');
    assert.equal(reqRes.json.data.google_ads.accounts[0].status, 'pending_mcc');

    const inviteMail = capturedMails.find((m) => m.event_type === 'google_ads_mcc_link_request');
    assert.ok(inviteMail, 'Must dispatch MCC invite email');
    assert.equal(inviteMail.to, 'domation.net@gmail.com');
    assert.equal(inviteMail.cc, 'turniodev@gmail.com');
    assert.ok(String(inviteMail.text).includes('888-111-2222'));

    // Proxy MUST block unverified pending_mcc ID with 403
    const blocked = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: {
        customer_id: '888-111-2222',
        time_range: { since: '2026-11-01', until: '2026-11-19' },
      },
    });
    assert.equal(blocked.status, 403);
  });

  it('enforces Zero-Trust OTP sent to real Google Ads ADMIN email (never leaks raw email/name before OTP), locks after 5 wrong tries, and unlocks on valid OTP', async () => {
    capturedMails.length = 0;
    setDomMetaExternalFetcherForTesting(async (url) => {
      if (url.includes('action=inspect_mcc_account') && url.includes('227-521-6666')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            linked: true,
            status: 'linked',
            customer_id: '227-521-6666',
            account_name: 'IDEAS Secret Real Account Name',
            currency_code: 'VND',
            user_access_readable: true,
            admin_emails: ['owner.secret@ideas.edu.vn'],
            standard_emails: [],
          }),
        };
      }
      if (url.includes('account_id=227-521-6666')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            h: ['date', 'campaign', 'campaign_id', 'spent', 'impression', 'click'],
            d: [['2026-11-19', 'MBA Executive Search', '9001', 1200000, 4500, 210]],
            syncedAt: '2026-11-20T03:00:00.000Z',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, h: [], d: [] }) };
    });

    // Intruder Tenant B tries to hijack IDEAS 227-521-6666 (which is already inside shared MCC!)
    const hijackRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/google-ads/mcc-add-or-request',
      {
        method: 'POST',
        token: tokenB,
        body: { items: [{ customer_id: '227-521-6666' }] },
      }
    );
    assert.equal(hijackRes.status, 200);
    const accB = hijackRes.json.data.google_ads.accounts[0];
    assert.equal(accB.status, 'pending_otp');
    // Must NOT leak real account name or raw email to Tenant B!
    assert.equal(accB.label, '');
    assert.ok(!JSON.stringify(hijackRes.json).includes('owner.secret@ideas.edu.vn'));
    assert.ok(!JSON.stringify(hijackRes.json).includes('IDEAS Secret Real Account Name'));
    assert.ok(accB.otp_sent_to_masked && accB.otp_sent_to_masked.includes('*'));

    // OTP email MUST go strictly to real Google Ads ADMIN owner.secret@ideas.edu.vn
    const otpMail = capturedMails.find((m) => m.event_type === 'google_ads_mcc_otp');
    assert.ok(otpMail);
    assert.equal(otpMail.to, 'owner.secret@ideas.edu.vn');
    const otpMatch = String(otpMail.text).match(/\b(\d{6})\b/);
    assert.ok(otpMatch, 'OTP email must include 6-digit code');

    // Tenant B CANNOT read data via proxy before OTP verification
    const blockedB = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenB,
      body: { customer_id: '227-521-6666', time_range: { since: '2026-11-10', until: '2026-11-19' } },
    });
    assert.equal(blockedB.status, 403);

    // Tenant B CANNOT forge status=connected via PUT /dom-meta/config
    const forgeRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'PUT',
      token: tokenB,
      body: {
        google_ads: {
          enabled: true,
          setup_mode: 'mcc_quick',
          customer_id: '227-521-6666',
          accounts: [{ customer_id: '227-521-6666', status: 'connected' }],
        },
      },
    });
    assert.equal(forgeRes.status, 200);
    assert.equal(forgeRes.json.data.google_ads.accounts[0].status, 'pending_otp');

    // Brute-force protection: 5 wrong attempts invalidate the OTP
    for (let i = 1; i <= 5; i++) {
      const wrong = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads/mcc-verify-otp', {
        method: 'POST',
        token: tokenB,
        body: { customer_id: '227-521-6666', otp_code: '000000' },
      });
      assert.equal(wrong.status, 422);
    }
    // Even entering the real OTP after 5 failures must fail because OTP hash was invalidated!
    const afterLock = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads/mcc-verify-otp', {
      method: 'POST',
      token: tokenB,
      body: { customer_id: '227-521-6666', otp_code: otpMatch[1] },
    });
    assert.equal(afterLock.status, 422);

    // Resend within 60s cooldown must be rate-limited (429)
    const cooldownRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads/mcc-resend-otp', {
      method: 'POST',
      token: tokenB,
      body: { customer_id: '227-521-6666' },
    });
    assert.equal(cooldownRes.status, 429);

    // Now legitimate Tenant A requests 227-521-6666 and enters the real 6-digit OTP
    capturedMails.length = 0;
    const legitReq = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/google-ads/mcc-add-or-request',
      {
        method: 'POST',
        token: tokenA,
        body: { items: [{ customer_id: '227-521-6666' }] },
      }
    );
    assert.equal(legitReq.status, 200);
    const legitOtpMail = capturedMails.find((m) => m.event_type === 'google_ads_mcc_otp');
    const legitOtp = String(legitOtpMail?.text || '').match(/\b(\d{6})\b/)?.[1];
    assert.ok(legitOtp);

    const verifyOk = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads/mcc-verify-otp', {
      method: 'POST',
      token: tokenA,
      body: { customer_id: '227-521-6666', otp_code: legitOtp },
    });
    assert.equal(verifyOk.status, 200);
    assert.equal(verifyOk.json.data.verified, true);
    assert.equal(verifyOk.json.data.account.status, 'connected');
    assert.equal(verifyOk.json.data.account.verified_via, 'owner_email_otp');
    // Real Google Ads account name is revealed ONLY AFTER OTP verification!
    assert.equal(verifyOk.json.data.account.label, 'IDEAS Secret Real Account Name');

    // Now Tenant A CAN query 227-521-6666 via proxy!
    const liveData = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: { customer_id: '227-521-6666', time_range: { since: '2026-11-10', until: '2026-11-19' } },
    });
    assert.equal(liveData.status, 200);
    assert.equal(liveData.json.data.d[0][1], 'MBA Executive Search');
  });

  it('falls back OTP to MCC admin (domation.net@gmail.com CC turniodev@gmail.com) when user_access is unreadable, and merges ONLY verified Multi-IDs on customer_id=all', async () => {
    capturedMails.length = 0;
    setDomMetaExternalFetcherForTesting(async (url) => {
      if (url.includes('action=inspect_mcc_account') && url.includes('333-444-5555')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            linked: true,
            status: 'linked',
            customer_id: '333-444-5555',
            account_name: 'IDEAS Sub Account 2',
            user_access_readable: false,
            admin_emails: [],
            standard_emails: [],
          }),
        };
      }
      if (url.includes('account_id=227-521-6666')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            h: ['date', 'campaign', 'campaign_id', 'spent', 'impression', 'click'],
            d: [['2026-11-19', 'MBA Search', '9001', 1000000, 3000, 100]],
            syncedAt: '2026-11-20T03:10:00.000Z',
          }),
        };
      }
      if (url.includes('account_id=333-444-5555')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            h: ['date', 'campaign', 'campaign_id', 'spent', 'impression', 'click'],
            d: [['2026-11-19', 'DBA Brand', '9002', 500000, 2000, 80]],
            syncedAt: '2026-11-20T03:12:00.000Z',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, h: [], d: [] }) };
    });

    // Add 2nd Google Ads ID to Tenant A (MCC Standard permission fallback)
    const add2 = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/google-ads/mcc-add-or-request',
      {
        method: 'POST',
        token: tokenA,
        body: { items: [{ customer_id: '333-444-5555', label: 'IDEAS DBA' }] },
      }
    );
    assert.equal(add2.status, 200);
    assert.equal(add2.json.data.sent_otp_ids[0].is_mcc_fallback, true);

    const fallbackMail = capturedMails.find((m) => m.event_type === 'google_ads_mcc_otp');
    assert.ok(fallbackMail);
    assert.equal(fallbackMail.to, 'domation.net@gmail.com');
    assert.equal(fallbackMail.cc, 'turniodev@gmail.com');
    const otp2 = String(fallbackMail.text).match(/\b(\d{6})\b/)?.[1];
    assert.ok(otp2);

    const verify2 = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads/mcc-verify-otp', {
      method: 'POST',
      token: tokenA,
      body: { customer_id: '333-444-5555', otp_code: otp2 },
    });
    assert.equal(verify2.status, 200);
    assert.equal(verify2.json.data.account.verified_via, 'mcc_admin_otp');

    // Tenant A now has: 888-111-2222 (pending_mcc), 227-521-6666 (connected), 333-444-5555 (connected)
    // Querying customer_id='all' MUST merge ONLY the 2 connected accounts and ignore pending_mcc!
    const merged = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: { customer_id: 'all', time_range: { since: '2026-11-10', until: '2026-11-19' } },
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.json.data.merged, true);
    assert.deepEqual(merged.json.data.customer_ids, ['227-521-6666', '333-444-5555']);
    assert.equal(merged.json.data.d.length, 2);
    assert.ok(String(merged.json.data.d[0][1]).includes('MBA Search'));
    assert.ok(String(merged.json.data.d[1][1]).includes('IDEAS DBA'));
    assert.ok(merged.json.data.h.includes('customer_id'));

    // Removing an account works cleanly
    const delRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/google-ads/mcc-account/888-111-2222',
      { method: 'DELETE', token: tokenA }
    );
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.data.google_ads.accounts.length, 2);
  });
});
