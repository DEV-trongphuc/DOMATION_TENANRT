import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { setDomMetaExternalFetcherForTesting } from '../server/services/dom-meta-report.service.ts';
import {
  dispatchStageCapiEventDetached,
  setCapiHttpTransportForTesting,
} from '../server/services/capi.service.ts';
import { withTenantTransaction } from '../server/core/database/transaction.ts';

describe('DOM Meta Report & Optional Google Ads Suite (Multi-Tenant RLS + Vault + Proxies)', () => {
  let harness: TestHarness;
  let tokenA = '';
  let tokenB = '';
  const slugA = 'dom-meta-alpha';
  const slugB = 'dom-meta-beta';

  before(async () => {
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'DOM Meta Alpha Corp',
        tenant_slug: slugA,
        admin_name: 'Alpha Admin',
        work_email: 'admin@dommeta-alpha.vn',
        phone: '0901222333',
        password: 'StrongPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regA.status, 201);
    tokenA = regA.json.data.access_token;
    assert.ok(tokenA.length > 20);

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'DOM Meta Beta Corp',
        tenant_slug: slugB,
        admin_name: 'Beta Admin',
        work_email: 'admin@dommeta-beta.vn',
        phone: '0901444555',
        password: 'StrongPassword123!',
        industry: 'education',
        seed_demo_leads: false,
      },
    });
    assert.equal(regB.status, 201);
    tokenB = regB.json.data.access_token;
  });

  after(async () => {
    setDomMetaExternalFetcherForTesting(null);
    await harness.close();
  });

  it('defaults Google Ads toggle to OFF (false) and returns default presets for new workspace', async () => {
    const res = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'GET',
      token: tokenA,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.equal(res.json.data.google_ads.enabled, false);
    assert.equal(res.json.data.google_ads.customer_id, '');
    assert.equal(res.json.data.google_ads.has_developer_token, false);
    assert.ok(Array.isArray(res.json.data.view_presets));
    assert.ok(res.json.data.view_presets.length >= 2);
  });

  it('batch-connects Meta Ad Accounts, shares them with ERP/AutoData meta_summary, and masks tokens', async () => {
    const batch = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/connect-batch', {
      method: 'POST',
      token: tokenA,
      body: {
        access_token: 'EAA_live_alpha_meta_token_secret_1234567890',
        accounts: [
          { ad_account_id: 'act_302787476028580', name: 'EcoLife Signature Main' },
          { ad_account_id: '676599667843841', name: 'DOM Secondary BM' },
        ],
        primary_ad_account_id: '302787476028580',
      },
    });
    assert.equal(batch.status, 201);
    assert.equal(batch.json.success, true);
    assert.equal(batch.json.connected_count, 2);
    assert.equal(batch.json.config.primary_ad_account_id, '302787476028580');
    assert.equal(batch.json.config.meta_summary.total_accounts, 2);
    assert.ok(!JSON.stringify(batch.json).includes('EAA_live_alpha_meta_token_secret_1234567890'));

    // Also visible via standard ERP/AutoData /meta-ads/accounts endpoint!
    const sharedCheck = await apiRequest(harness.baseUrl, '/api/v1/integrations/meta-ads/accounts', {
      method: 'GET',
      token: tokenA,
    });
    assert.equal(sharedCheck.status, 200);
    assert.equal(sharedCheck.json.data.total_accounts, 2);

    // Tenant B must see 0 accounts (strict RLS zero-leakage)
    const tenantBCheck = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'GET',
      token: tokenB,
    });
    assert.equal(tenantBCheck.status, 200);
    assert.equal(tenantBCheck.json.data.meta_summary.total_accounts, 0);
  });

  it('blocks Google Ads proxy while toggle is OFF, allows test_connection, and works once toggled ON while preserving masked developer_token', async () => {
    let lastRequestedUrl = '';
    setDomMetaExternalFetcherForTesting(async (url) => {
      lastRequestedUrl = url;
      if (url.includes('graph.facebook.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ spend: '84735701', impressions: '1694669', reach: '1017660' }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          h: ['date', 'campaign', 'spent', 'impression', 'click'],
          d: [['2026-11-18', 'EcoLife Search Brand', 4250000, 18200, 1450]],
          syncedAt: '2026-11-18T10:00:00.000Z',
        }),
      };
    });

    // Save Google Ads credentials with enabled STILL false
    const saveOff = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'PUT',
      token: tokenA,
      body: {
        brand_filters: [{ id: 'b1', name: 'EcoLife', filter: 'ecolife' }],
        goal_keywords: ['lead', 'mess'],
        google_ads: {
          enabled: false,
          customer_id: '295-339-0933',
          apps_script_url: 'https://script.google.com/macros/s/AKfycb_demo_exec/exec',
          developer_token: 'oBqM_GUwxCs4t-secret99',
        },
      },
    });
    assert.equal(saveOff.status, 200);
    assert.equal(saveOff.json.data.google_ads.enabled, false);
    assert.equal(saveOff.json.data.google_ads.has_developer_token, true);
    const maskedDevToken = saveOff.json.data.google_ads.developer_token_masked;
    assert.ok(maskedDevToken.includes('...'));

    // Normal Google Ads sync must be rejected while toggle is OFF
    const blockedSync = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: { time_range: { since: '2026-11-12', until: '2026-11-18' } },
    });
    assert.equal(blockedSync.status, 422);

    // Explicit test_connection: true succeeds during setup wizard verification
    const testConn = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: { test_connection: true, time_range: { since: '2026-11-12', until: '2026-11-18' } },
    });
    assert.equal(testConn.status, 200);
    assert.equal(testConn.json.data.d.length, 1);

    // Toggle Google Ads ON while passing back masked developer token (must preserve real secret!)
    const saveOn = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'PUT',
      token: tokenA,
      body: {
        google_ads: {
          enabled: true,
          developer_token: maskedDevToken,
        },
      },
    });
    assert.equal(saveOn.status, 200);
    assert.equal(saveOn.json.data.google_ads.enabled, true);

    const liveSync = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: { time_range: { since: '2026-11-12', until: '2026-11-18' } },
    });
    assert.equal(liveSync.status, 200);
    assert.ok(lastRequestedUrl.includes('token=oBqM_GUwxCs4t-secret99'));
    assert.ok(lastRequestedUrl.includes('account_id=295-339-0933'));

    // Meta Graph proxy rejects unsafe paths and proxies valid act_.../insights
    const badPath = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/meta-proxy', {
      method: 'POST',
      token: tokenA,
      body: { graph_path: '../../etc/passwd' },
    });
    assert.equal(badPath.status, 422);

    const goodMeta = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/meta-proxy', {
      method: 'POST',
      token: tokenA,
      body: {
        ad_account_id: '302787476028580',
        graph_path: 'act_302787476028580/insights',
        params: { fields: 'spend,impressions,reach' },
      },
    });
    assert.equal(goodMeta.status, 200);
    assert.equal(goodMeta.json.data.data[0].spend, '84735701');

    // Tenant B cannot proxy Tenant A's Meta Ad Account
    const crossTenantAttempt = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/meta-proxy', {
      method: 'POST',
      token: tokenB,
      body: {
        ad_account_id: '302787476028580',
        graph_path: 'act_302787476028580/insights',
      },
    });
    assert.equal(crossTenantAttempt.status, 422);
  });

  it('blocks SSRF URLs, prevents developer_token exfiltration on override URLs, and detects HTML login walls', async () => {
    // 1. Reject arbitrary HTTPS / internal hosts (SSRF prevention)
    for (const badUrl of [
      'https://attacker.example.com/steal',
      'https://127.0.0.1/macros/s/AKfycb/exec',
      'http://script.google.com/macros/s/AKfycb/exec',
      'https://script.google.com/admin/panel',
    ]) {
      const saveBad = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
        method: 'PUT',
        token: tokenA,
        body: { google_ads: { apps_script_url: badUrl } },
      });
      assert.equal(saveBad.status, 422, `Expected 422 for ${badUrl}`);

      const proxyBad = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
        method: 'POST',
        token: tokenA,
        body: {
          test_connection: true,
          override_config: { apps_script_url: badUrl },
        },
      });
      assert.equal(proxyBad.status, 422, `Expected proxy 422 for ${badUrl}`);
    }

    // 2. Testing a DIFFERENT valid Apps Script URL must NOT attach the stored vault developer_token
    let capturedOverrideUrl = '';
    setDomMetaExternalFetcherForTesting(async (url) => {
      capturedOverrideUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ h: ['date', 'campaign', 'spent'], d: [] }),
      };
    });

    const testOtherScript = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: {
        test_connection: true,
        override_config: {
          apps_script_url: 'https://script.google.com/macros/s/AKfycb_different_unverified_script/exec',
        },
      },
    });
    assert.equal(testOtherScript.status, 200);
    assert.ok(
      !capturedOverrideUrl.includes('oBqM_GUwxCs4t-secret99'),
      'Must never leak stored developer_token to an unverified override script URL'
    );

    // 3. Detect Google Accounts HTML sign-in wall when user forgot "Who has access: Anyone" in Step 4
    setDomMetaExternalFetcherForTesting(async () => ({
      ok: true,
      status: 200,
      text: async () => '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head><body>ServiceLogin</body></html>',
      json: async () => {
        throw new Error('Unexpected token <');
      },
    }));

    const htmlWall = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: tokenA,
      body: { test_connection: true },
    });
    assert.equal(htmlWall.status, 422);
    assert.match(String(htmlWall.json.error?.message || ''), /Anyone/i);

    // 4. Meta OAuthException 190 surfaces 401 with explicit re-connect message
    setDomMetaExternalFetcherForTesting(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: 'Error validating access token: Session has expired',
          type: 'OAuthException',
          code: 190,
        },
      }),
    }));

    const expiredMeta = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/meta-proxy', {
      method: 'POST',
      token: tokenA,
      body: {
        ad_account_id: '302787476028580',
        graph_path: 'act_302787476028580/insights',
      },
    });
    assert.equal(expiredMeta.status, 401);
    assert.match(String(expiredMeta.json.error?.message || ''), /190/);
  });

  it('enforces sub-role RBAC: manager can view reports & proxies read-only, while config mutations & overrides require admin', async () => {
    setDomMetaExternalFetcherForTesting(async (url) => {
      if (url.includes('graph.facebook.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ spend: '1200000' }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ h: ['date', 'campaign', 'spent'], d: [['2026-11-18', 'Camp 1', 500000]] }),
      };
    });

    const createManager = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tokenA,
      body: {
        email: 'mkt-manager@dommeta-alpha.vn',
        full_name: 'Marketing Manager',
        role: 'manager',
        password: 'ManagerPassword123!',
      },
    });
    assert.equal(createManager.status, 201);

    const createSale = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tokenA,
      body: {
        email: 'sale-staff@dommeta-alpha.vn',
        full_name: 'Sale Staff',
        role: 'sale',
        password: 'SalePassword123!',
      },
    });
    assert.equal(createSale.status, 201);

    const loginManager = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'mkt-manager@dommeta-alpha.vn',
        password: 'ManagerPassword123!',
        tenant_slug: slugA,
      },
    });
    assert.equal(loginManager.status, 200);
    const managerToken = loginManager.json.data.access_token;

    const loginSale = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'sale-staff@dommeta-alpha.vn',
        password: 'SalePassword123!',
        tenant_slug: slugA,
      },
    });
    assert.equal(loginSale.status, 200);
    const saleToken = loginSale.json.data.access_token;

    // Manager CAN read config & read-only Meta/Google proxies
    const mgrGet = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'GET',
      token: managerToken,
    });
    assert.equal(mgrGet.status, 200);

    const mgrMeta = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/meta-proxy', {
      method: 'POST',
      token: managerToken,
      body: { ad_account_id: '302787476028580', graph_path: 'act_302787476028580/insights' },
    });
    assert.equal(mgrMeta.status, 200);

    const mgrGads = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: managerToken,
      body: { time_range: { since: '2026-11-12', until: '2026-11-18' } },
    });
    assert.equal(mgrGads.status, 200);

    // Manager CANNOT mutate config, batch-connect tokens, or pass override/test_connection flags
    const mgrPut = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'PUT',
      token: managerToken,
      body: { google_ads: { enabled: false } },
    });
    assert.equal(mgrPut.status, 403);

    const mgrConnect = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/connect-batch', {
      method: 'POST',
      token: managerToken,
      body: { access_token: 'EAA_hijack_token_123456', accounts: [{ ad_account_id: '12345678' }] },
    });
    assert.equal(mgrConnect.status, 403);

    const mgrMetaOverride = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/meta-proxy', {
      method: 'POST',
      token: managerToken,
      body: { graph_path: 'me/adaccounts', override_access_token: 'EAA_probe_token' },
    });
    assert.equal(mgrMetaOverride.status, 403);

    const mgrGadsTest = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/google-ads-proxy', {
      method: 'POST',
      token: managerToken,
      body: { test_connection: true },
    });
    assert.equal(mgrGadsTest.status, 403);

    // Sale role is blocked from viewing ad spend config & proxies
    const saleGet = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'GET',
      token: saleToken,
    });
    assert.equal(saleGet.status, 403);
  });

  it('persists AI Report history (ai_reports) in encrypted workspace vault with strict tenant isolation', async () => {
    const saveReports = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'PUT',
      token: tokenA,
      body: {
        ai_reports: [
          {
            id: 'air_101',
            timestamp: '19/11/2026, 01:45:00',
            label: 'Chẩn đoán hiệu suất EcoLife Signature',
            brand: 'EcoLife',
            date_range: '2026-11-12 → 2026-11-18',
            preview: 'Tổng chi tiêu 84,733,468đ (+49.7%), Hook Rate 3s đạt 48.6%',
            html: '<h2>1. Tổng quan ngân sách</h2><p>Chi tiêu 84,733,468đ</p>',
            plain_text: '1. Tổng quan ngân sách: Chi tiêu 84,733,468đ',
          },
        ],
      },
    });
    assert.equal(saveReports.status, 200);
    assert.equal(saveReports.json.data.ai_reports.length, 1);
    assert.equal(saveReports.json.data.ai_reports[0].id, 'air_101');
    assert.equal(saveReports.json.data.ai_reports[0].brand, 'EcoLife');

    const getA = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'GET',
      token: tokenA,
    });
    assert.equal(getA.status, 200);
    assert.equal(getA.json.data.ai_reports.length, 1);
    assert.match(getA.json.data.ai_reports[0].html, /84,733,468đ/);

    const getB = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/config', {
      method: 'GET',
      token: tokenB,
    });
    assert.equal(getB.status, 200);
    assert.equal(getB.json.data.ai_reports.length, 0);
  });

  it('supports zero-friction quick-connect-status, auto_reuse from existing facebook_ads Vault, and Mode B new token quick-connect', async () => {
    // Initially Tenant B has no Meta token at all
    const initialStatusB = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/quick-connect-status',
      {
        method: 'GET',
        token: tokenB,
      }
    );
    assert.equal(initialStatusB.status, 200);
    assert.equal(initialStatusB.json.has_meta_token, false);
    assert.equal(initialStatusB.json.dom_meta_connected, false);
    assert.equal(initialStatusB.json.can_auto_connect, false);

    // Calling auto_reuse when no token exists must return 422
    const prematureReuse = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/quick-connect',
      {
        method: 'POST',
        token: tokenB,
        body: { auto_reuse: true },
      }
    );
    assert.equal(prematureReuse.status, 422);

    // Simulate Tenant B already having connected Meta Ads inside CRM (/meta-ads/accounts)
    const crmMetaConnect = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/meta-ads/accounts',
      {
        method: 'POST',
        token: tokenB,
        body: {
          name: 'Beta CRM Main Account',
          ad_account_id: 'act_889900112233',
          access_token: 'EAA_beta_crm_vault_token_secret_987654321',
          pixel_id: '11223344556677',
          is_active: true,
        },
      }
    );
    assert.equal(crmMetaConnect.status, 201);

    // Now quick-connect-status detects existing token and reports can_auto_connect: true!
    const preAutoStatusB = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/quick-connect-status',
      {
        method: 'GET',
        token: tokenB,
      }
    );
    assert.equal(preAutoStatusB.status, 200);
    assert.equal(preAutoStatusB.json.has_meta_token, true);
    assert.equal(preAutoStatusB.json.total_accounts, 1);
    assert.equal(preAutoStatusB.json.active_accounts, 1);
    assert.equal(preAutoStatusB.json.has_capi_pixel, true);
    assert.equal(preAutoStatusB.json.dom_meta_connected, false);
    assert.equal(preAutoStatusB.json.can_auto_connect, true);

    // Mode A: auto_reuse activates DOM Meta Report WITHOUT re-entering token & keeps Google Ads OFF
    const autoReuseRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/quick-connect',
      {
        method: 'POST',
        token: tokenB,
        body: { auto_reuse: true },
      }
    );
    assert.equal(autoReuseRes.status, 200);
    assert.equal(autoReuseRes.json.success, true);
    assert.equal(autoReuseRes.json.mode, 'auto_reuse');
    assert.equal(autoReuseRes.json.status.dom_meta_connected, true);
    assert.equal(autoReuseRes.json.status.can_auto_connect, false);
    assert.equal(autoReuseRes.json.status.primary_ad_account_id, '889900112233');
    assert.equal(autoReuseRes.json.config.google_ads.enabled, false);
    assert.ok(!JSON.stringify(autoReuseRes.json).includes('EAA_beta_crm_vault_token_secret_987654321'));

    // Mode B: Connect a fresh workspace via quick-connect with access_token + accounts + pixel_id
    const regC = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'DOM Meta Gamma Corp',
        tenant_slug: 'dom-meta-gamma',
        admin_name: 'Gamma Admin',
        work_email: 'admin@dommeta-gamma.vn',
        phone: '0901666777',
        password: 'StrongPassword123!',
        industry: 'spa_clinic',
        seed_demo_leads: false,
      },
    });
    assert.equal(regC.status, 201);
    const tokenC = regC.json.data.access_token;

    const modeBRes = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/quick-connect',
      {
        method: 'POST',
        token: tokenC,
        body: {
          access_token: 'EAA_gamma_fresh_token_secret_555666777888',
          accounts: [
            { ad_account_id: 'act_554433221100', name: 'Gamma Beauty Main' },
          ],
          pixel_id: '998877665544',
        },
      }
    );
    assert.equal(modeBRes.status, 201);
    assert.equal(modeBRes.json.success, true);
    assert.equal(modeBRes.json.mode, 'token_connect');
    assert.equal(modeBRes.json.connected_count, 1);
    assert.equal(modeBRes.json.status.dom_meta_connected, true);
    assert.equal(modeBRes.json.status.has_capi_pixel, true);
    assert.equal(modeBRes.json.config.google_ads.enabled, false);
    assert.ok(!JSON.stringify(modeBRes.json).includes('EAA_gamma_fresh_token_secret_555666777888'));
  });

  it('computes closed-loop crm-attribution across ad/adset/campaign with Sale breakdown, revenue, CAPI status, PII masking, and strict RLS zero-leakage', async () => {
    // Create 2 Sales + 1 External Agency Marketing Viewer in Tenant A
    const sale1Res = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tokenA,
      body: {
        email: 'minh.anh@dommeta-alpha.vn',
        full_name: 'Minh Anh',
        role: 'sale',
        password: 'SalePassword123!',
      },
    });
    assert.equal(sale1Res.status, 201);
    const sale1Id = sale1Res.json.data.id;

    const sale2Res = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tokenA,
      body: {
        email: 'tuan.kiet@dommeta-alpha.vn',
        full_name: 'Tuấn Kiệt',
        role: 'sale',
        password: 'SalePassword123!',
      },
    });
    assert.equal(sale2Res.status, 201);
    const sale2Id = sale2Res.json.data.id;

    const agencyRes = await apiRequest(harness.baseUrl, '/api/v1/users', {
      method: 'POST',
      token: tokenA,
      body: {
        email: 'agency.viewer@dommeta-alpha.vn',
        full_name: 'External Agency Viewer',
        role: 'manager',
        is_external_agency: true,
        password: 'AgencyPassword123!',
      },
    });
    assert.equal(agencyRes.status, 201);

    const loginAgency = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'agency.viewer@dommeta-alpha.vn',
        password: 'AgencyPassword123!',
        tenant_slug: slugA,
      },
    });
    assert.equal(loginAgency.status, 200);
    const agencyToken = loginAgency.json.data.access_token;

    // Resolve Tenant A & Tenant B IDs and seed realistic leads + CAPI logs inside RLS transactions
    const meA = await apiRequest(harness.baseUrl, '/api/v1/auth/me', { method: 'GET', token: tokenA });
    const tenantIdA = meA.json.data.tenant?.id || meA.json.data.user?.tenant_id;
    const meB = await apiRequest(harness.baseUrl, '/api/v1/auth/me', { method: 'GET', token: tokenB });
    const tenantIdB = meB.json.data.tenant?.id || meB.json.data.user?.tenant_id;
    assert.ok(tenantIdA);
    assert.ok(tenantIdB);

    const lead1Id = crypto.randomUUID();
    const lead2Id = crypto.randomUUID();
    const lead3Id = crypto.randomUUID();
    const lead4Id = crypto.randomUUID();
    const leadBId = crypto.randomUUID();

    await withTenantTransaction(tenantIdA, async (client) => {
      const pipeRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 LIMIT 1',
        [tenantIdA]
      );
      const pipelineId = pipeRes.rows[0]?.id || null;
      const stageRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipeline_stages WHERE tenant_id = $1 ORDER BY stage_order ASC LIMIT 1',
        [tenantIdA]
      );
      const stageId = stageRes.rows[0]?.id || null;

      let roundId: string | null = null;
      if (pipelineId) {
        const rRes = await client.query<{ id: string }>(
          `INSERT INTO distribution_rounds (tenant_id, pipeline_id, name, priority, is_active)
           VALUES ($1, $2, 'Vòng Dự Án EcoLife', 1, true)
           RETURNING id`,
          [tenantIdA, pipelineId]
        );
        roundId = rRes.rows[0]?.id || null;
      }

      // Lead 1: Ad 1001, Adset 2001, Camp 3001 -> Sale 1 (Minh Anh), Closed, 120M VND, CAPI Purchase 200
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, pipeline_id, stage_id, assigned_to, round_id, status, is_accepted,
           name, phone, email, quality_status, quality_note, total_revenue_vnd,
           source, campaign, campaign_id, adset_id, ad_id, custom_fields, created_at
         ) VALUES
         ($1, $2, $3, $4, $5, $6, 'assigned', true,
          'Nguyễn Hoàng Nam', '0912345678', 'nam.nguyen@example.vn', 'Closed', 'Đã ký HĐ căn A12 (0912345678)', 120000000,
          'Facebook Lead Ads', 'EcoLife Signature Q4', 'cmp_3001', 'aset_2001', 'ad_1001',
          '{"ad_name": "Video Hook Căn 2PN EcoLife"}'::jsonb, '2026-11-15T03:00:00.000Z'),
         ($7, $2, $3, $4, $5, $6, 'assigned', true,
          'Trần Thu Hà', '0987654321', 'ha.tran@example.vn', 'Qualified', 'Nhu cầu mua ở thực', 0,
          'Facebook Lead Ads', 'EcoLife Signature Q4', 'cmp_3001', 'aset_2001', 'ad_1001',
          '{"ad_name": "Video Hook Căn 2PN EcoLife"}'::jsonb, '2026-11-16T04:00:00.000Z'),
         ($8, $2, $3, $4, $9, $6, 'assigned', false,
          'Lê Quốc Bảo', '0909111222', 'bao.le@example.vn', 'Notlead', 'Nhầm số', 0,
          'Facebook Lead Ads', 'EcoLife Signature Q4', 'cmp_3001', 'aset_2001', 'ad_1001',
          '{"ad_name": "Video Hook Căn 2PN EcoLife"}'::jsonb, '2026-11-17T05:00:00.000Z'),
         ($10, $2, $3, $4, $9, $6, 'assigned', true,
          'Phạm Mỹ Linh', '0933444555', 'linh.pham@example.vn', 'Deposited', 'Đặt cọc giữ chỗ 50tr', 50000000,
          'Facebook Lead Ads', 'EcoLife Remarketing', 'cmp_3002', 'aset_2002', 'ad_1002',
          '{"ad_name": "Carousel Chính Sách Ân Hạn"}'::jsonb, '2026-11-17T08:00:00.000Z')`,
        [lead1Id, tenantIdA, pipelineId, stageId, sale1Id, roundId, lead2Id, lead3Id, sale2Id, lead4Id]
      );

      await client.query(
        `INSERT INTO capi_logs (
           tenant_id, lead_id, dataset_id, event_name, event_id, action_source, match_keys, sent_payload, response_status
         ) VALUES
         ($1, $2, 'px_1', 'Purchase', 'ev_1', 'system_generated', '{"ph":true}'::jsonb, '{}'::jsonb, 200),
         ($1, $3, 'px_1', 'Lead', 'ev_2', 'system_generated', '{"ph":true}'::jsonb, '{}'::jsonb, 200),
         ($1, $4, 'px_1', 'DisqualifiedLead', 'ev_3', 'system_generated', '{"ph":true}'::jsonb, '{}'::jsonb, 500)`,
        [tenantIdA, lead1Id, lead2Id, lead3Id]
      );
    });

    // Seed a lead in Tenant B with the SAME ad_id ('ad_1001') to prove strict RLS zero-leakage!
    await withTenantTransaction(tenantIdB, async (client) => {
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, status, name, phone, quality_status, total_revenue_vnd,
           source, campaign_id, adset_id, ad_id, created_at
         ) VALUES (
           $1, $2, 'assigned', 'Khách Nội Bộ Tenant B', '0977888999', 'Closed', 999000000,
           'Facebook Lead Ads', 'cmp_3001', 'aset_2001', 'ad_1001', '2026-11-16T06:00:00.000Z'
         )`,
        [leadBId, tenantIdB]
      );
    });

    // 1. Admin on Tenant A fetches crm-attribution with entity drilldown for ad_1001
    const attrA = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/crm-attribution?since=2026-11-12&until=2026-11-18&entity_type=ad&entity_id=ad_1001',
      {
        method: 'GET',
        token: tokenA,
      }
    );
    assert.equal(attrA.status, 200);
    assert.equal(attrA.json.success, true);

    // Summary checks (4 leads in Tenant A; Tenant B's 999M lead MUST NOT leak!)
    assert.equal(attrA.json.summary.total_leads, 4);
    assert.equal(attrA.json.summary.attributed_leads, 4);
    assert.equal(attrA.json.summary.qualified_leads, 3); // Closed + Qualified + Deposited
    assert.equal(attrA.json.summary.closed_leads, 1);
    assert.equal(attrA.json.summary.negative_leads, 1);
    assert.equal(attrA.json.summary.total_revenue_vnd, 170000000);
    assert.equal(attrA.json.summary.capi_sent_count, 2); // 2 leads with 200 OK CAPI logs

    // Bucket checks: by_ad['ad_1001'], by_adset['aset_2001'], by_campaign['cmp_3001']
    const ad1001 = attrA.json.by_ad['ad_1001'];
    assert.ok(ad1001);
    assert.equal(ad1001.total_leads, 3);
    assert.equal(ad1001.qualified_leads, 2);
    assert.equal(ad1001.negative_leads, 1);
    assert.equal(ad1001.pending_leads, 0);
    assert.equal(ad1001.positive_rate, 67);
    assert.equal(ad1001.total_revenue_vnd, 120000000);
    assert.equal(ad1001.capi_sent_count, 2);
    assert.equal(ad1001.sales.length, 2);
    assert.equal(ad1001.sales[0].name, 'Minh Anh');
    assert.equal(ad1001.sales[0].lead_count, 2);
    assert.equal(ad1001.sales[0].qualified_count, 2);
    assert.equal(ad1001.sales[0].revenue_vnd, 120000000);

    assert.equal(attrA.json.by_adset['aset_2001'].total_leads, 3);
    assert.equal(attrA.json.by_campaign['cmp_3001'].total_leads, 3);
    assert.equal(attrA.json.by_campaign['cmp_3002'].total_revenue_vnd, 50000000);

    // Entity leads drilldown (Admin has unmask_phone = true -> sees full phone)
    assert.ok(attrA.json.entity_leads);
    assert.equal(attrA.json.entity_leads.total, 3);
    assert.equal(attrA.json.entity_leads.sales_filter_options.length, 2);
    const namRowAdmin = attrA.json.entity_leads.items.find((i: any) => i.id === lead1Id);
    assert.ok(namRowAdmin);
    assert.equal(namRowAdmin.phone, '0912345678');
    assert.equal(namRowAdmin.round_name, 'Vòng Dự Án EcoLife');
    assert.equal(namRowAdmin.capi_last_event, 'Purchase');
    assert.equal(namRowAdmin.capi_last_status, 'sent');

    // Filter entity_leads by sale_id & quality_status
    const filteredAttrA = await apiRequest(
      harness.baseUrl,
      `/api/v1/integrations/dom-meta/crm-attribution?since=2026-11-12&until=2026-11-18&entity_type=ad&entity_id=ad_1001&sale_id=${sale1Id}&quality_status=Closed`,
      {
        method: 'GET',
        token: tokenA,
      }
    );
    assert.equal(filteredAttrA.status, 200);
    assert.equal(filteredAttrA.json.entity_leads.total, 1);
    assert.equal(filteredAttrA.json.entity_leads.items[0].id, lead1Id);

    // 2. External Agency Viewer MUST receive masked phones & sanitized notes (strict PII protection!)
    const attrAgency = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/crm-attribution?since=2026-11-12&until=2026-11-18&entity_type=ad&entity_id=ad_1001',
      {
        method: 'GET',
        token: agencyToken,
      }
    );
    assert.equal(attrAgency.status, 200);
    const namRowAgency = attrAgency.json.entity_leads.items.find((i: any) => i.id === lead1Id);
    assert.ok(namRowAgency);
    assert.notEqual(namRowAgency.phone, '0912345678');
    assert.match(namRowAgency.phone, /\*/);
    assert.ok(!JSON.stringify(attrAgency.json.entity_leads).includes('0912345678'));
    assert.ok(!JSON.stringify(attrAgency.json.entity_leads).includes('0987654321'));

    // 3. Tenant B sees ONLY Tenant B's 1 lead — zero leakage from Tenant A!
    const attrB = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/crm-attribution?since=2026-11-12&until=2026-11-18&entity_type=ad&entity_id=ad_1001',
      {
        method: 'GET',
        token: tokenB,
      }
    );
    assert.equal(attrB.status, 200);
    assert.equal(attrB.json.summary.total_leads, 1);
    assert.equal(attrB.json.summary.total_revenue_vnd, 999000000);
    assert.equal(attrB.json.entity_leads.total, 1);
    assert.equal(attrB.json.entity_leads.items[0].id, leadBId);
    assert.ok(!JSON.stringify(attrB.json).includes('Nguyễn Hoàng Nam'));

    // 4. Empty date window & boundary pagination return clean zeroed structures
    const emptyWindow = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/crm-attribution?since=2026-01-01&until=2026-01-02&entity_type=ad&entity_id=ad_1001&page=99&page_size=500',
      {
        method: 'GET',
        token: tokenA,
      }
    );
    assert.equal(emptyWindow.status, 200);
    assert.equal(emptyWindow.json.summary.total_leads, 0);
    assert.equal(emptyWindow.json.summary.attributed_leads, 0);
    assert.deepEqual(emptyWindow.json.by_ad, {});
    assert.equal(emptyWindow.json.entity_leads.total, 0);
    assert.equal(emptyWindow.json.entity_leads.page_size, 200); // clamped to 200 max
    assert.deepEqual(emptyWindow.json.entity_leads.items, []);

    // 5. ERP /contacts & CRM legacy get_logs expose Meta attribution fields and support campaign_id + lead_id filters
    const erpContacts = await apiRequest(
      harness.baseUrl,
      '/api/v1/myerp/contacts?campaign_id=cmp_3001',
      {
        method: 'GET',
        token: tokenA,
      }
    );
    assert.equal(erpContacts.status, 200);
    const erpItems = erpContacts.json.data?.items || erpContacts.json.items || [];
    assert.equal(erpItems.length, 3);
    const namErp = erpItems.find((i: any) => i.id === lead1Id);
    assert.ok(namErp);
    assert.equal(namErp.ad_id, 'ad_1001');
    assert.equal(namErp.campaign_id, 'cmp_3001');
    assert.equal(namErp.campaign_name, 'EcoLife Signature Q4');
    assert.equal(namErp.ad_name, 'Video Hook Căn 2PN EcoLife');

    const legacyLeadById = await apiRequest(
      harness.baseUrl,
      `/api/v1/legacy?action=get_logs&date=${encodeURIComponent('Hôm nay')}&lead_id=${encodeURIComponent(lead1Id)}`,
      {
        method: 'GET',
        token: tokenA,
      }
    );
    assert.equal(legacyLeadById.status, 200);
    assert.equal(legacyLeadById.json.success, true);
    assert.equal(legacyLeadById.json.data.length, 1);
    assert.equal(legacyLeadById.json.data[0].id, lead1Id);

    const legacyByCamp = await apiRequest(
      harness.baseUrl,
      `/api/v1/legacy?action=get_logs&campaign_id=cmp_3002`,
      {
        method: 'GET',
        token: tokenA,
      }
    );
    assert.equal(legacyByCamp.status, 200);
    assert.equal(legacyByCamp.json.data.length, 1);
    assert.equal(legacyByCamp.json.data[0].id, lead4Id);
  });

  it('validates Mode B tokens, shares facebook_ads Vault with Meta CAPI, and attributes Vietnamese custom stages + campaign-name-only Sheet/LadiPage leads', async () => {
    const regD = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'DOM Meta Delta Corp',
        tenant_slug: 'dom-meta-delta',
        admin_name: 'Delta Admin',
        work_email: 'admin@dommeta-delta.vn',
        phone: '0901999888',
        password: 'StrongPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regD.status, 201);
    const tokenD = regD.json.data.access_token;
    const meD = await apiRequest(harness.baseUrl, '/api/v1/auth/me', { method: 'GET', token: tokenD });
    const tenantIdD = meD.json.data.tenant?.id || meD.json.data.user?.tenant_id;

    // 1. Mode B rejects invalid/revoked Meta token instead of saving broken secret into Vault
    setDomMetaExternalFetcherForTesting(async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        error: { message: 'Invalid OAuth access token.', code: 190 },
      }),
    }));

    const badTokenConnect = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/quick-connect',
      {
        method: 'POST',
        token: tokenD,
        body: {
          access_token: 'EAA_revoked_dead_token_0000000000',
          accounts: [{ ad_account_id: 'act_7788990011', name: 'Delta Main' }],
          pixel_id: '776655443322',
        },
      }
    );
    assert.equal(badTokenConnect.status, 422);

    // 2. Valid token succeeds and Meta CAPI immediately shares the facebook_ads Vault pixel & token
    setDomMetaExternalFetcherForTesting(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: '1000998877', name: 'Delta BM System User' }),
    }));

    const goodConnect = await apiRequest(
      harness.baseUrl,
      '/api/v1/integrations/dom-meta/quick-connect',
      {
        method: 'POST',
        token: tokenD,
        body: {
          access_token: 'EAA_valid_shared_vault_token_112233445566',
          accounts: [{ ad_account_id: 'act_7788990011', name: 'Delta Main' }],
          pixel_id: '776655443322',
        },
      }
    );
    assert.equal(goodConnect.status, 201);

    const sheetLead1 = crypto.randomUUID();
    const sheetLead2 = crypto.randomUUID();
    await withTenantTransaction(tenantIdD, async (client) => {
      const pipeRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_pipelines WHERE tenant_id = $1 LIMIT 1',
        [tenantIdD]
      );
      const pipelineId = pipeRes.rows[0]?.id;
      const customStageId = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_pipeline_stages (id, tenant_id, pipeline_id, stage_key, stage_name, color_hex, stage_order)
         VALUES ($1, $2, $3, 'qualified', 'Khách tiềm năng BĐS cao cấp', '#10b981', 99)`,
        [customStageId, tenantIdD, pipelineId]
      );

      // Seed meta_ads_insights so campaign_name -> campaign_id reverse mapping works
      await client.query(
        `INSERT INTO meta_ads_insights (
           tenant_id, ad_account_id, date_start, date_stop,
           campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend
         ) VALUES (
           $1, '7788990011', '2026-11-15', '2026-11-18',
           'cmp_delta_99', 'Chiến dịch LadiPage Tháng 11', 'aset_delta_1', 'Nhóm Đà Nẵng', 'ad_delta_1', 'Bài Post 1', 5000000
         )`,
        [tenantIdD]
      );

      // Lead 1: Imported from Google Sheets with campaign name ONLY (no numeric campaign_id / ad_id) + custom Vietnamese stage_name while quality_status is still 'Pending'
      // Lead 2: Imported from UTM LadiPage for a brand-new campaign name not yet in meta_ads_insights
      await client.query(
        `INSERT INTO leads (
           id, tenant_id, pipeline_id, stage_id, status, name, phone, quality_status,
           source, campaign, created_at
         ) VALUES
         ($1, $2, $3, $4, 'assigned', 'Đỗ Gia Bảo', '0944555666', 'Pending',
          'Google Sheets Sync', 'Chiến dịch LadiPage Tháng 11', '2026-11-16T04:00:00.000Z'),
         ($5, $2, $3, $4, 'assigned', 'Vũ Khánh Vy', '0944777888', 'Pending',
          'LadiPage UTM', 'UTM Mở Bán Đợt 2', '2026-11-17T04:00:00.000Z')`,
        [sheetLead1, tenantIdD, pipelineId, customStageId, sheetLead2]
      );
    });

    // Dispatch CAPI event WITHOUT ever creating a separate meta_capi Vault row: must use shared pixel '776655443322' via live transport!
    let capturedDatasetId = '';
    let capturedToken = '';
    setCapiHttpTransportForTesting(async ({ datasetId, accessToken }) => {
      capturedDatasetId = datasetId;
      capturedToken = accessToken;
      return {
        httpStatus: 200,
        body: { events_received: 1, fbtrace_id: 'fb_trace_dom_meta_shared_ok' },
      };
    });
    let capiDispatch;
    try {
      capiDispatch = await dispatchStageCapiEventDetached({
        tenantId: tenantIdD,
        tenantSlug: 'dom-meta-delta',
        eventName: 'Lead',
        lead: {
          leadId: sheetLead1,
          name: 'Đỗ Gia Bảo',
          phone: '0944555666',
        },
      });
    } finally {
      setCapiHttpTransportForTesting(null);
    }
    assert.equal(capiDispatch.dispatched, true);
    assert.equal(capiDispatch.status, 200);
    assert.equal(capturedDatasetId, '776655443322');
    assert.equal(capturedToken, 'EAA_valid_shared_vault_token_112233445566');

    await withTenantTransaction(tenantIdD, async (client) => {
      const logRes = await client.query<{ dataset_id: string }>(
        'SELECT dataset_id FROM capi_logs WHERE tenant_id = $1 AND lead_id = $2 LIMIT 1',
        [tenantIdD, sheetLead1]
      );
      assert.equal(logRes.rows[0]?.dataset_id, '776655443322');
    });

    // Verify crm-attribution resolves cmp_delta_99 from campaign name, classifies 'Khách tiềm năng BĐS cao cấp' as Qualified, and exposes by_campaign_name for UTM-only campaign
    const attrD = await apiRequest(
      harness.baseUrl,
      `/api/v1/integrations/dom-meta/crm-attribution?since=2026-11-12&until=2026-11-18&entity_type=campaign&entity_id=unmapped_live_id&entity_name=${encodeURIComponent('UTM Mở Bán Đợt 2')}`,
      {
        method: 'GET',
        token: tokenD,
      }
    );
    assert.equal(attrD.status, 200);
    assert.equal(attrD.json.summary.total_leads, 2);
    assert.equal(attrD.json.summary.attributed_leads, 2);
    assert.equal(attrD.json.summary.qualified_leads, 2);
    assert.equal(attrD.json.by_campaign['cmp_delta_99'].total_leads, 1);
    assert.equal(attrD.json.by_campaign['cmp_delta_99'].qualified_leads, 1);
    assert.equal(attrD.json.by_campaign['cmp_delta_99'].capi_sent_count, 1);
    assert.equal(attrD.json.by_campaign_name['utm mở bán đợt 2'].total_leads, 1);
    assert.equal(attrD.json.entity_leads.total, 1);
    assert.equal(attrD.json.entity_leads.items[0].id, sheetLead2);
  });

  it('shares encrypted Gemini AI API Key across CRM & Meta Report with default-ON dual toggles (Lead & Ads), enforces toggle gates, chunks >45 Meta Batch items, and rotates JWT via /auth/refresh', async () => {
    // 1. Fresh tenant should default BOTH toggles (ai_lead_eval_enabled & ai_ads_eval_enabled) to TRUE with has_api_key: false
    const regAi = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'DOM Shared AI Corp',
        tenant_slug: 'dom-shared-ai',
        admin_name: 'AI Director',
        work_email: 'admin@domsharedai.vn',
        phone: '0901888999',
        password: 'StrongPassword123!',
        industry: 'ecommerce',
        seed_demo_leads: false,
      },
    });
    assert.equal(regAi.status, 201);
    const tokenAi = regAi.json.data.access_token;
    const refreshTokenAi = regAi.json.data.refresh_token;
    assert.ok(refreshTokenAi && refreshTokenAi.length > 20);

    // Verify /api/v1/auth/refresh rotates JWT access + refresh tokens cleanly
    const refreshRes = await apiRequest(harness.baseUrl, '/api/v1/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshTokenAi },
    });
    assert.equal(refreshRes.status, 200);
    assert.equal(refreshRes.json.success, true);
    const rotatedToken = refreshRes.json.data.access_token;
    assert.ok(rotatedToken && rotatedToken.length > 20);

    const initAiCfg = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'GET',
      token: rotatedToken,
    });
    assert.equal(initAiCfg.status, 200);
    assert.equal(initAiCfg.json.data.has_api_key, false);
    assert.equal(initAiCfg.json.data.ai_lead_eval_enabled, true);
    assert.equal(initAiCfg.json.data.ai_ads_eval_enabled, true);

    // Calling ai-analyze without an API key must return 422 AI_API_KEY_MISSING
    const missingKeyRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-analyze', {
      method: 'POST',
      token: rotatedToken,
      body: { scope: 'workspace', context_data: { spend: 10000000 } },
    });
    assert.equal(missingKeyRes.status, 422);
    assert.equal(missingKeyRes.json.error.code, 'AI_API_KEY_MISSING');

    // 2. Save Shared AI Key via Meta Report endpoint -> must encrypt & expose masked key in BOTH Meta Report & CRM Legacy get_settings
    const secretGeminiKey = 'AIzaSyTestSharedKeyCRMAndMeta9876543210';
    const saveMetaAi = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-config', {
      method: 'PUT',
      token: rotatedToken,
      body: {
        api_key: secretGeminiKey,
        model: 'gemini-2.5-flash',
        ai_lead_eval_enabled: true,
        ai_ads_eval_enabled: true,
      },
    });
    assert.equal(saveMetaAi.status, 200);
    assert.equal(saveMetaAi.json.data.has_api_key, true);
    assert.ok(!JSON.stringify(saveMetaAi.json).includes(secretGeminiKey));
    assert.match(saveMetaAi.json.data.api_key_masked, /^AIzaSy••••••••3210$/);
    assert.equal(saveMetaAi.json.data.ai_lead_eval_enabled, true);
    assert.equal(saveMetaAi.json.data.ai_ads_eval_enabled, true);

    // Verify CRM legacy get_settings sees the masked shared key & both toggles = '1', and zero plaintext in response
    const crmSettings1 = await apiRequest(harness.baseUrl, '/api/autodata?action=get_settings', {
      method: 'GET',
      token: rotatedToken,
    });
    assert.equal(crmSettings1.status, 200);
    assert.equal(crmSettings1.json.data.has_shared_gemini_key, '1');
    assert.equal(crmSettings1.json.data.gemini_api_key, saveMetaAi.json.data.api_key_masked);
    assert.equal(crmSettings1.json.data.ai_lead_eval_enabled, '1');
    assert.equal(crmSettings1.json.data.ai_ads_eval_enabled, '1');
    assert.ok(!JSON.stringify(crmSettings1.json).includes(secretGeminiKey));

    // 3. Execute live mock Gemini analysis for Ads & Lead when both toggles are ON
    setDomMetaExternalFetcherForTesting(async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '## 1. Chẩn đoán Hiệu suất\n- **CPR tối ưu**: 42,000đ/tin nhắn.\n- Tăng ngân sách khung giờ 20h-22h.',
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      const u = new URL(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ path: u.pathname }] }),
      };
    });

    try {
      const analyzeAdsOk = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-analyze', {
        method: 'POST',
        token: rotatedToken,
        body: { scope: 'entity', context_data: { id: 'ad_1', spend: 5000000, result: 120 } },
      });
      assert.equal(analyzeAdsOk.status, 200);
      assert.match(analyzeAdsOk.json.data.html, /<h2>1\. Chẩn đoán Hiệu suất<\/h2>/);
      assert.match(analyzeAdsOk.json.data.html, /<strong>CPR tối ưu<\/strong>/);

      // 4. Turn OFF ai_ads_eval_enabled from CRM Legacy save_settings (while submitting masked key -> must preserve real key!)
      const crmSaveToggle = await apiRequest(harness.baseUrl, '/api/autodata?action=save_settings', {
        method: 'POST',
        token: rotatedToken,
        body: {
          gemini_api_key: saveMetaAi.json.data.api_key_masked,
          ai_lead_eval_enabled: '1',
          ai_ads_eval_enabled: '0',
        },
      });
      assert.equal(crmSaveToggle.status, 200);

      // Ads AI evaluation must now return 403 AI_ADS_EVAL_DISABLED, whereas Lead AI evaluation still succeeds (200)!
      const analyzeAdsBlocked = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-analyze', {
        method: 'POST',
        token: rotatedToken,
        body: { scope: 'workspace', context_data: { spend: 5000000 } },
      });
      assert.equal(analyzeAdsBlocked.status, 403);
      assert.equal(analyzeAdsBlocked.json.error.code, 'AI_ADS_EVAL_DISABLED');

      const analyzeLeadOk = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-analyze', {
        method: 'POST',
        token: rotatedToken,
        body: { scope: 'lead', context_data: { name: 'Nguyễn Minh', phone: '0909123456' } },
      });
      assert.equal(analyzeLeadOk.status, 200);

      // 5. Verify >45 Meta Batch items auto-chunking (52 items)
      const batchConnect = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/quick-connect', {
        method: 'POST',
        token: rotatedToken,
        body: {
          access_token: 'EAA_shared_ai_meta_batch_token_123456789',
          accounts: [{ ad_account_id: 'act_6677889900', name: 'Batch 52 Test' }],
        },
      });
      assert.equal(batchConnect.status, 201);

      const fiftyTwoRequests = Array.from({ length: 52 }, (_, idx) => ({
        key: `slot_${idx}`,
        graph_path: 'act_6677889900/insights',
        params: { fields: 'spend', limit: idx + 1 },
      }));

      const batch52Res = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/meta-batch', {
        method: 'POST',
        token: rotatedToken,
        body: {
          ad_account_id: '6677889900',
          requests: fiftyTwoRequests,
        },
      });
      assert.equal(batch52Res.status, 200);
      assert.equal(Object.keys(batch52Res.json.data).length, 52);
    } finally {
      setDomMetaExternalFetcherForTesting(null);
    }
  });

  it('enables ai_screener_configs when CRM save_settings submits Gemini key with initial ai_screener_enabled=0, and renders fenced Markdown tables/code/dividers cleanly', async () => {
    const regFresh = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'DOM Fresh CRM AI Corp',
        tenant_slug: 'dom-fresh-crm-ai',
        admin_name: 'Fresh Admin',
        work_email: 'admin@dom-fresh-crm-ai.vn',
        phone: '0901777888',
        password: 'StrongPassword123!',
        industry: 'real_estate',
        seed_demo_leads: false,
      },
    });
    assert.equal(regFresh.status, 201);
    const freshToken = regFresh.json.data.access_token;

    const initSet = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      method: 'GET',
      token: freshToken,
    });
    assert.equal(initSet.status, 200);
    assert.equal(initSet.json.data.ai_screener_enabled, '0');
    assert.equal(initSet.json.data.ai_lead_eval_enabled, '1');
    assert.equal(initSet.json.data.ai_ads_eval_enabled, '1');

    // Simulate exact payload sent by CRM Settings.tsx when user pastes Gemini key into AI Key Modal (both toggles default ON)
    const saveCrmKey = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=save_settings', {
      method: 'POST',
      token: freshToken,
      body: {
        gemini_api_key: 'AIzaSyFreshCrmSharedKey99887766',
        gemini_model: 'gemini-2.5-flash',
        ai_lead_eval_enabled: '1',
        ai_ads_eval_enabled: '1',
        ai_screener_enabled: initSet.json.data.ai_screener_enabled, // '0' before fix!
      },
    });
    assert.equal(saveCrmKey.status, 200);

    const afterSet = await apiRequest(harness.baseUrl, '/api/v1/legacy?action=get_settings', {
      method: 'GET',
      token: freshToken,
    });
    assert.equal(afterSet.status, 200);
    assert.equal(afterSet.json.data.ai_screener_enabled, '1');
    assert.equal(afterSet.json.data.ai_lead_eval_enabled, '1');
    assert.equal(afterSet.json.data.ai_ads_eval_enabled, '1');
    assert.equal(afterSet.json.data.has_shared_gemini_key, '1');

    setDomMetaExternalFetcherForTesting(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: [
                    '```markdown',
                    '### 1. Bảng Đối Chiếu Phễu',
                    '- Tỷ lệ `Hook Rate` đạt **38.5%** (*rất tốt*).',
                    '---',
                    '| Hạng mục | Giá trị |',
                    '|---|---|',
                    '| Spent | 48.5Mđ |',
                    '| Leads | 218 |',
                    '1. Tăng ngân sách `20%` khung giờ 20h.',
                    '2. Giữ nguyên tệp Lookalike 1%.',
                    '```',
                  ].join('\n'),
                },
              ],
            },
          },
        ],
      }),
    }));

    try {
      const mdRes = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/ai-analyze', {
        method: 'POST',
        token: freshToken,
        body: { scope: 'workspace', context_data: { spend: 48500000 } },
      });
      assert.equal(mdRes.status, 200);
      const html = String(mdRes.json.data.html || '');
      assert.ok(!html.includes('```'), 'Must strip triple-backtick code fences');
      assert.ok(!html.includes('|---|'), 'Must parse Markdown pipe tables instead of leaking separator');
      assert.match(html, /<table><thead><tr><th>Hạng mục<\/th><th>Giá trị<\/th><\/tr><\/thead><tbody>/);
      assert.match(html, /<code>Hook Rate<\/code>/);
      assert.match(html, /<hr\/>/);
      assert.match(html, /<ol>\s*<li>Tăng ngân sách <code>20%<\/code> khung giờ 20h\.<\/li>/);
    } finally {
      setDomMetaExternalFetcherForTesting(null);
    }
  });

  it('persists Google OAuth avatar_url + full_name into global_accounts and propagates to invited workspace members', async () => {
    const invitedEmail = 'turniodev@gmail.com';
    const googleAvatarUrl = 'https://lh3.googleusercontent.com/a/ACg8ocTestAvatar123=s96-c';
    const realName = 'Trong Phuc';

    // 1. Admin A invites invitedEmail BEFORE they ever log in with Google (placeholder name = local-part)
    const inviteAlpha = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/share', {
      method: 'PUT',
      token: tokenA,
      body: {
        invite: { email: invitedEmail, full_name: 'turniodev', role: 'viewer' },
      },
    });
    assert.equal(inviteAlpha.status, 200);
    const beforeMember = (inviteAlpha.json.data.members || []).find(
      (m: any) => String(m.email).toLowerCase() === invitedEmail
    );
    assert.ok(beforeMember);
    assert.equal(beforeMember.avatar_url || null, null);

    // 2. User logs in with Google OAuth ID token (3-segment JWT payload + tokeninfo fallback)
    const jwtPayload = Buffer.from(
      JSON.stringify({ email: invitedEmail, name: realName, picture: googleAvatarUrl }),
      'utf8'
    ).toString('base64url');
    const mockIdToken = `eyJhbGciOiJSUzI1NiJ9.${jwtPayload}.sig`;
    const expectedAud = (process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim();

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input?.url || '');
      if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
        return new Response(
          JSON.stringify({
            email: invitedEmail,
            email_verified: 'true',
            name: realName,
            picture: googleAvatarUrl,
            sub: 'google-sub-avatar-test-001',
            ...(expectedAud ? { aud: expectedAud } : {}),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    let googleToken = '';
    try {
      const gLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/google', {
        method: 'POST',
        body: { id_token: mockIdToken, tenant_slug: slugA },
      });
      assert.equal(gLogin.status, 200, JSON.stringify(gLogin.json));
      assert.equal(gLogin.json.data.user.email, invitedEmail);
      assert.equal(gLogin.json.data.user.avatar_url, googleAvatarUrl);
      assert.equal(gLogin.json.data.user.full_name, realName);
      googleToken = gLogin.json.data.access_token;
      assert.ok(googleToken.length > 20);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 3. /auth/me & Alpha share list reflect persisted avatar_url + upgraded realName
    const meRes = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      method: 'GET',
      token: googleToken,
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.json.data.user.avatar_url, googleAvatarUrl);

    const shareAfterAlpha = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/share', {
      method: 'GET',
      token: tokenA,
    });
    assert.equal(shareAfterAlpha.status, 200);
    const syncedMemberAlpha = (shareAfterAlpha.json.data.members || []).find(
      (m: any) => String(m.email).toLowerCase() === invitedEmail
    );
    assert.ok(syncedMemberAlpha);
    assert.equal(syncedMemberAlpha.avatar_url, googleAvatarUrl);
    assert.equal(syncedMemberAlpha.full_name, realName);

    // 4. Inviting same user into Workspace Beta immediately inherits global_accounts avatar_url & full_name
    const inviteBeta = await apiRequest(harness.baseUrl, '/api/v1/integrations/dom-meta/share', {
      method: 'PUT',
      token: tokenB,
      body: {
        invite: { email: invitedEmail, role: 'tenant_admin' },
      },
    });
    assert.equal(inviteBeta.status, 200);
    const memberBeta = (inviteBeta.json.data.members || []).find(
      (m: any) => String(m.email).toLowerCase() === invitedEmail
    );
    assert.ok(memberBeta);
    assert.equal(memberBeta.avatar_url, googleAvatarUrl);
    assert.equal(memberBeta.full_name, realName);
  });
});
