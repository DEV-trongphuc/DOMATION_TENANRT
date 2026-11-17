import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { setMetaGraphFetcherForTesting } from '../server/services/meta-ads.service.ts';
import { setEmailWebhookFetcherForTesting } from '../server/services/zalo-mail.service.ts';

describe('Multi-Account Meta Ads Vault & Google Sheets Apps Script Email Suite', () => {
  let harness: TestHarness;
  let adminToken = '';
  let tenantSlug = 'multi-meta-mail-demo';
  let account1Id = '';
  let account2Id = '';

  before(async () => {
    harness = await startTestServer();
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Multi Meta Mail Studio',
        tenant_slug: tenantSlug,
        admin_name: 'Admin Studio',
        work_email: 'admin@multimetamail.vn',
        phone: '0909888777',
        password: 'StrongPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    adminToken = reg.json.data.access_token;
  });

  after(async () => {
    setMetaGraphFetcherForTesting(null);
    setEmailWebhookFetcherForTesting(null);
    await harness.close();
  });

  it('supports adding, rejecting duplicates, editing while preserving secret token, toggling, syncing, filtering, and deleting multiple Meta Ad Accounts', async () => {
    // 1. Add Account 1 via legacy API (act_ prefix should normalize to digits)
    const add1 = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=add_meta_ad_account', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'TK Chính Hà Nội',
        ad_account_id: 'act_111111111111111',
        access_token: 'EAAG_token_alpha_secret_987654',
        pixel_id: '998877665544332',
      },
    });
    assert.equal(add1.status, 200);
    assert.equal(add1.json.success, true);
    assert.equal(add1.json.account.ad_account_id, '111111111111111');
    account1Id = add1.json.account.id;
    assert.equal(add1.json.data.total_accounts, 1);

    // 2. Add Account 2 via REST endpoint
    const add2 = await apiRequest(harness.baseUrl, '/api/v1/integrations/meta-ads/accounts', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'TK Phụ Hồ Chí Minh',
        ad_account_id: '222222222222222',
        access_token: 'EAAG_token_beta_secret_123456',
        pixel_id: '112233445566778',
      },
    });
    assert.equal(add2.status, 201);
    assert.equal(add2.json.success, true);
    account2Id = add2.json.account.id;
    assert.equal(add2.json.summary.total_accounts, 2);

    // 3. Reject duplicate ad_account_id on creation
    const dup = await apiRequest(harness.baseUrl, '/api/v1/integrations/meta-ads/accounts', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'TK Trùng',
        ad_account_id: '111111111111111',
        access_token: 'EAAG_another_token',
      },
    });
    assert.equal(dup.status, 422);
    assert.equal(dup.json.success, false);

    // 4. Edit Account 1 with __KEEP_EXISTING__ -> label updates, secret token remains usable!
    const edit1 = await apiRequest(harness.baseUrl, `/api/v1/integrations/meta-ads/accounts/${account1Id}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        name: 'TK Chính Hà Nội Updated',
        ad_account_id: '111111111111111',
        access_token: '__KEEP_EXISTING__',
        pixel_id: '998877665544332',
      },
    });
    assert.equal(edit1.status, 200);
    assert.equal(edit1.json.account.name, 'TK Chính Hà Nội Updated');
    assert.equal(edit1.json.account.has_token, true);

    // 5. Toggle Account 2 inactive, then mock Meta Graph API v21.0 sync
    const togOff = await apiRequest(harness.baseUrl, `/api/v1/integrations/meta-ads/accounts/${account2Id}/toggle`, {
      method: 'PATCH',
      token: adminToken,
      body: { is_active: false },
    });
    assert.equal(togOff.status, 200);
    assert.equal(togOff.json.account.is_active, false);

    const calledUrls: string[] = [];
    setMetaGraphFetcherForTesting(async (url: string) => {
      calledUrls.push(url);
      if (url.includes('act_111111111111111')) {
        assert.ok(url.includes('EAAG_token_alpha_secret_987654'), 'Preserved token 1 must be sent to Graph API');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'ad_alpha_1',
                name: 'Quảng cáo Hà Nội 01',
                campaign: { id: 'cmp_hn_1', name: 'Campaign HN', objective: 'OUTCOME_LEADS' },
                adset: { id: 'as_hn_1', name: 'Adset HN', optimization_goal: 'LEAD_GENERATION' },
                creative: {
                  title: 'EcoLife HN',
                  body: 'Ưu đãi đặc biệt Hà Nội',
                  thumbnail_url: 'https://cdn.example.com/hn.jpg',
                },
                insights: {
                  data: [
                    {
                      date_start: '2026-11-16',
                      date_stop: '2026-11-16',
                      spend: '1500000',
                      impressions: '10000',
                      clicks: '250',
                      reach: '8200',
                      ctr: '2.5',
                      cpc: '6000',
                      cpm: '150000',
                      frequency: '1.22',
                      actions: [{ action_type: 'lead', value: '12' }],
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      if (url.includes('act_222222222222222')) {
        assert.ok(url.includes('EAAG_token_beta_secret_123456'), 'Token 2 must be sent to Graph API');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'ad_beta_1',
                name: 'Quảng cáo HCM 01',
                campaign: { id: 'cmp_hcm_1', name: 'Campaign HCM', objective: 'OUTCOME_LEADS' },
                adset: { id: 'as_hcm_1', name: 'Adset HCM', optimization_goal: 'LEAD_GENERATION' },
                creative: {
                  title: 'EcoLife HCM',
                  body: 'Ưu đãi đặc biệt TP.HCM',
                  image_url: 'https://cdn.example.com/hcm.jpg',
                },
                insights: {
                  data: [
                    {
                      date_start: '2026-11-16',
                      date_stop: '2026-11-16',
                      spend: '2000000',
                      impressions: '14000',
                      clicks: '420',
                      reach: '11000',
                      ctr: '3.0',
                      cpc: '4762',
                      cpm: '142857',
                      frequency: '1.27',
                      actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '18' }],
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: { message: 'Unknown account' } }) };
    });

    // Only Account 1 is active -> only Account 1 is synced
    const syncActiveOnly = await apiRequest(harness.baseUrl, '/api/v1/integrations/meta-ads/sync', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(syncActiveOnly.status, 200);
    assert.equal(syncActiveOnly.json.synced_ads, 1);
    assert.equal(calledUrls.length, 1);
    assert.ok(calledUrls[0].includes('act_111111111111111'));

    // Toggle Account 2 back active and sync all
    const togOn = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=toggle_meta_ad_account', {
      method: 'POST',
      token: adminToken,
      body: { id: account2Id, is_active: true },
    });
    assert.equal(togOn.status, 200);
    assert.equal(togOn.json.account.is_active, true);

    calledUrls.length = 0;
    const syncAll = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=sync_meta_ads_data', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(syncAll.status, 200);
    assert.equal(syncAll.json.success, true);
    assert.equal(syncAll.json.synced_ads, 2);
    assert.equal(calledUrls.length, 2);

    // 6. Verify dashboard filtering by ad_account_id + CAPI available_pixels
    const dashAll = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_ads_performance_dashboard&date=maximum',
      { token: adminToken }
    );
    assert.equal(dashAll.status, 200);
    assert.equal(dashAll.json.ads.length, 2);
    assert.equal(dashAll.json.meta_config.total_accounts, 2);

    const dashAcc2 = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_ads_performance_dashboard&date=maximum&ad_account_id=222222222222222',
      { token: adminToken }
    );
    assert.equal(dashAcc2.status, 200);
    assert.equal(dashAcc2.json.ads.length, 1);
    assert.equal(dashAcc2.json.ads[0].ad_id, 'ad_beta_1');

    const preview = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_ad_preview_iframe&ad_id=ad_beta_1',
      { token: adminToken }
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.json.data.ad_account_id, '222222222222222');

    const capiDash = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_capi_dashboard', {
      token: adminToken,
    });
    assert.equal(capiDash.status, 200);
    assert.equal(capiDash.json.available_pixels.length, 2);

    // 7. Delete Account 2 with purge_insights=true -> only ad_alpha_1 stays in dashboard
    const del2 = await apiRequest(
      harness.baseUrl,
      `/api/v1/integrations/meta-ads/accounts/${account2Id}?purge_insights=true`,
      { method: 'DELETE', token: adminToken }
    );
    assert.equal(del2.status, 200);
    assert.equal(del2.json.purged_ads_count, 1);

    const dashAfterDel = await apiRequest(
      harness.baseUrl,
      '/api/v1/legacy?action=get_ads_performance_dashboard&date=maximum',
      { token: adminToken }
    );
    assert.equal(dashAfterDel.json.ads.length, 1);
    assert.equal(dashAfterDel.json.ads[0].ad_id, 'ad_alpha_1');

    // 8. Token Discovery: paste token -> discover multiple Ad Account IDs & Pixels cleanly (plus stored account_id lookup & 422 on invalid token)
    setMetaGraphFetcherForTesting(async (url: string) => {
      if (url.includes('invalid_expired_token')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'Session has expired on Monday' } }),
        };
      }
      if (url.includes('/me?fields=')) {
        return { ok: true, status: 200, json: async () => ({ id: 'usr_99', name: 'Marketing Director' }) };
      }
      if (url.includes('/me/adaccounts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'act_777888999000',
                account_id: '777888999000',
                name: 'TK Brand Bắc',
                account_status: 1,
                currency: 'VND',
                adspixels: { data: [{ id: '123000123000', name: 'Pixel Brand Bắc' }] },
              },
              {
                id: 'act_555666777888',
                account_id: '555666777888',
                name: 'TK Brand Nam',
                account_status: 1,
                currency: 'USD',
                adspixels: { data: [{ id: '456000456000', name: 'Pixel Brand Nam' }] },
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });

    const discNew = await apiRequest(harness.baseUrl, '/api/v1/integrations/meta-ads/discover', {
      method: 'POST',
      token: adminToken,
      body: { access_token: 'EAAG_fresh_token_discover_xyz123456789' },
    });
    assert.equal(discNew.status, 200);
    assert.equal(discNew.json.success, true);
    assert.equal(discNew.json.token_owner.name, 'Marketing Director');
    assert.equal(discNew.json.ad_accounts.length, 2);
    assert.equal(discNew.json.pixels.length, 2);

    // Discover using saved account_id in Vault without resending secret token
    const discSaved = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=discover_meta_assets', {
      method: 'POST',
      token: adminToken,
      body: { account_id: account1Id },
    });
    assert.equal(discSaved.status, 200);
    assert.equal(discSaved.json.success, true);
    assert.equal(discSaved.json.ad_accounts.length, 2);

    const discInvalid = await apiRequest(harness.baseUrl, '/api/v1/integrations/meta-ads/discover', {
      method: 'POST',
      token: adminToken,
      body: { access_token: 'invalid_expired_token' },
    });
    assert.equal(discInvalid.status, 422);
    assert.equal(discInvalid.json.success, false);
  });

  it('persists Apps Script email config, dispatches all 9 email categories, and surfaces Google HTML Anyone-access errors clearly', async () => {
    const webhookUrl = 'https://script.google.com/macros/s/AKfycbTestUnifiedMailScript/exec';
    const secret = 'domation_secret_key_2026';

    const saveCfg = await apiRequest(harness.baseUrl, '/api/v1/integrations/email/config', {
      method: 'POST',
      token: adminToken,
      body: {
        email_provider: 'appscript',
        appscript_webhook_url: webhookUrl,
        appscript_secret: secret,
        frontend_url: 'https://data.domation.net',
        ses_sender_name: 'DOMATION Mail Studio',
      },
    });
    assert.equal(saveCfg.status, 200);
    assert.equal(saveCfg.json.success, true);

    // Regression check: legacy get_settings must preserve appscript fields!
    const getSettings = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      token: adminToken,
    });
    assert.equal(getSettings.status, 200);
    assert.equal(getSettings.json.data.email_provider, 'appscript');
    assert.equal(getSettings.json.data.appscript_webhook_url, webhookUrl);
    assert.equal(getSettings.json.data.appscript_secret, secret);
    assert.equal(getSettings.json.data.frontend_url, 'https://data.domation.net');

    const sentPayloads: any[] = [];
    setEmailWebhookFetcherForTesting(async (url, init) => {
      assert.equal(url, webhookUrl);
      const parsed = JSON.parse(init.body);
      sentPayloads.push(parsed);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ success: true, remaining_quota: 94, sheet_logged: true }),
      };
    });

    const categories = [
      'system',
      'assignment',
      'zalo_sale',
      'zalo_admin',
      'ticket_admin',
      'ticket_sale_success',
      'ticket_sale_fail',
      'admin_confirm',
      'daily_report',
    ];

    for (const cat of categories) {
      const testRes = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=test_email', {
        method: 'POST',
        token: adminToken,
        body: {
          to_email: 'receiver@multimetamail.vn',
          type: cat,
        },
      });
      assert.equal(testRes.status, 200, `Legacy test_email failed for ${cat}`);
      assert.equal(testRes.json.success, true);
      assert.equal(testRes.json.remaining_quota, 94);
      assert.equal(testRes.json.sheet_logged, true);
    }

    assert.equal(sentPayloads.length, categories.length);
    for (let i = 0; i < categories.length; i++) {
      const p = sentPayloads[i];
      assert.equal(p.category, categories[i]);
      assert.equal(p.to, 'receiver@multimetamail.vn');
      assert.equal(p.email, 'receiver@multimetamail.vn');
      assert.equal(p.secret, secret);
      assert.equal(p.tenant_slug, tenantSlug);
      assert.ok(String(p.html).includes('<!DOCTYPE html>'));
      assert.equal(p.htmlBody, p.html);
    }

    // Verify REST /integrations/email/test also works + surfaces Google sign-in HTML redirect clearly
    setEmailWebhookFetcherForTesting(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<!DOCTYPE html><html><title>Sign in - Google Accounts</title></html>',
    }));

    const restFail = await apiRequest(harness.baseUrl, '/api/v1/integrations/email/test', {
      method: 'POST',
      token: adminToken,
      body: {
        to_email: 'receiver@multimetamail.vn',
        type: 'assignment',
      },
    });
    assert.equal(restFail.status, 422);
    assert.equal(restFail.json.success, false);
    assert.ok(String(restFail.json.message || restFail.json.error?.message || '').includes('Anyone'));
  });
});
