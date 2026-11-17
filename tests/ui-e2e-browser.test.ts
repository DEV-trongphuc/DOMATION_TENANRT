/**
 * Multi-Workspace Auth, Operations & Headless API End-to-End Verification
 * (Pure Node HTTP — zero browser automation / zero port 5174 SPA)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';

describe('Headless Multi-Workspace Auth, Routing & Operations API E2E', () => {
  let harness: TestHarness;
  let accountToken: string;
  let workspace1Slug: string;
  let workspace1Token: string;
  let workspace2Slug: string;

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  test('1. Headless root returns JSON service status without HTML SPA', async () => {
    const res = await fetch(`${harness.baseUrl}/`);
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('application/json'));
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.service, 'DOMATION AutoData Backend Kernel');
  });

  test('2. Email register -> create 2 workspaces -> login without slug returns select_workspace -> switch-workspace', async () => {
    const email = `multi_${Date.now()}@domation.net`;
    const reg = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        work_email: email,
        phone: '0909111222',
        password: 'Password@123',
        admin_name: 'Multi Workspace Founder',
        company_name: 'Domation Realty One',
        tenant_slug: `dom-one-${Date.now()}`,
        industry: 'real_estate',
      },
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.data.action, 'enter_workspace');
    workspace1Slug = reg.json.data.tenant.slug;
    workspace1Token = reg.json.data.access_token;

    // Create second workspace using workspace1Token (carries account_id)
    const cw = await apiRequest(harness.baseUrl, '/api/v1/auth/create-workspace', {
      method: 'POST',
      token: workspace1Token,
      body: {
        company_name: 'Domation Spa Two',
        tenant_slug: `dom-two-${Date.now()}`,
        industry: 'spa_clinic',
      },
    });
    assert.equal(cw.status, 201);
    workspace2Slug = cw.json.data.tenant.slug;
    assert.notEqual(workspace2Slug, workspace1Slug);

    // Login without slug -> select_workspace with >= 2 workspaces
    const login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email, password: 'Password@123' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.data.action, 'select_workspace');
    assert.ok(login.json.data.account_token);
    assert.equal(login.json.data.workspaces.length, 2);
    accountToken = login.json.data.account_token;

    // Switch into workspace 2
    const sw = await apiRequest(harness.baseUrl, '/api/v1/auth/switch-workspace', {
      method: 'POST',
      token: accountToken,
      body: { tenant_slug: workspace2Slug },
    });
    assert.equal(sw.status, 200);
    assert.equal(sw.json.data.tenant.slug, workspace2Slug);
    assert.ok(sw.json.data.access_token);
  });

  test('3. Onboarding & per-screen Spotlight Tour persistence via PATCH /api/v1/auth/onboarding', async () => {
    const patch = await apiRequest(harness.baseUrl, '/api/v1/auth/onboarding', {
      method: 'PATCH',
      token: workspace1Token,
      tenantSlug: workspace1Slug,
      body: {
        screen_tours: { dashboard: true },
        is_completed: true,
      },
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.data.screen_tours.dashboard, true);

    const me = await apiRequest(harness.baseUrl, '/api/v1/auth/me', {
      token: workspace1Token,
      tenantSlug: workspace1Slug,
    });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.onboarding.screen_tours.dashboard, true);
  });

  test('4. Batch Duplicate Check, Silent Batch Import & Fair-Share Compensation + Audit Rollback', async () => {
    const imp = await apiRequest(harness.baseUrl, '/api/v1/operations/leads/batch-import', {
      method: 'POST',
      token: workspace1Token,
      tenantSlug: workspace1Slug,
      body: {
        file_name: 'khach-hang-test.csv',
        rows: [
          { name: 'Nguyễn Batch Một', phone: '0911222333', source: 'Excel Import' },
          { name: 'Trần Batch Hai', phone: '0911222444', source: 'Excel Import' },
        ],
      },
    });
    assert.equal(imp.status, 201);
    assert.equal(imp.json.data.imported_count, 2);

    const chk = await apiRequest(harness.baseUrl, '/api/v1/operations/leads/batch-check', {
      method: 'POST',
      token: workspace1Token,
      tenantSlug: workspace1Slug,
      body: {
        rows: [
          { name: 'Check 1', phone: '0911222333' },
          { name: 'Check 2', phone: '0999888777' },
        ],
      },
    });
    assert.equal(chk.status, 200);
    assert.equal(chk.json.data.results[0].is_duplicate, true);
    assert.equal(chk.json.data.results[1].is_duplicate, false);

    // Check audit logs exist and support rollback
    const logs = await apiRequest(harness.baseUrl, '/api/v1/operations/admin-audit', {
      token: workspace1Token,
      tenantSlug: workspace1Slug,
    });
    assert.equal(logs.status, 200);
    assert.ok(Array.isArray(logs.json.data.items));
    assert.ok(logs.json.data.items.length >= 1);

    const rb = await apiRequest(
      harness.baseUrl,
      `/api/v1/operations/admin-audit/${logs.json.data.items[0].id}/rollback`,
      {
        method: 'POST',
        token: workspace1Token,
        tenantSlug: workspace1Slug,
      }
    );
    assert.equal(rb.status, 200);
    assert.equal(rb.json.data.is_rolled_back, true);
  });
});
