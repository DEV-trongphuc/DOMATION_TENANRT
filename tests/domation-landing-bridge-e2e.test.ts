/**
 * DOMATION_LANDINGPAGE Thin Reverse Proxy Bridge E2E Test
 * Verifies pure proxy forwarding to AUTO_DATA_TENANRT (:3100) and strict 503 when backend unavailable.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, type TestHarness } from './helpers.ts';
import { handleAutodataBridgeHttp } from '../../DOMATION_LANDINGPAGE/lib/autodataBridge.ts';

describe('DOMATION Landing Reverse Proxy Bridge E2E', () => {
  let harness: TestHarness;
  let proxyServer: http.Server;
  let proxyBaseUrl: string;
  let activeUpstreamUrl: string | undefined;

  before(async () => {
    harness = await startTestServer();
    activeUpstreamUrl = harness.baseUrl;

    proxyServer = http.createServer((req, res) => {
      void handleAutodataBridgeHttp(req, res, activeUpstreamUrl);
    });
    await new Promise<void>((resolve) => {
      proxyServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = proxyServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    proxyBaseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    if (harness) await harness.close();
  });

  test('1. Returns 503 BACKEND_UNAVAILABLE when AUTODATA_API_URL is missing or down (no fake fallback)', async () => {
    const prevEnv = process.env.AUTODATA_API_URL;
    process.env.AUTODATA_API_URL = '';
    activeUpstreamUrl = '';

    const r1 = await fetch(`${proxyBaseUrl}/api/autodata?action=bootstrap`);
    assert.equal(r1.status, 503);
    const j1 = (await r1.json()) as any;
    assert.equal(j1.success, false);
    assert.equal(j1.error.code, 'BACKEND_UNAVAILABLE');

    activeUpstreamUrl = 'http://127.0.0.1:59999';
    const r2 = await fetch(`${proxyBaseUrl}/api/v1/workspace/bootstrap`);
    assert.equal(r2.status, 503);
    const j2 = (await r2.json()) as any;
    assert.equal(j2.error.code, 'BACKEND_UNAVAILABLE');

    activeUpstreamUrl = harness.baseUrl;
    if (prevEnv !== undefined) process.env.AUTODATA_API_URL = prevEnv;
    else delete process.env.AUTODATA_API_URL;
  });

  test('2. Proxies /api/autodata?action=register, login, bootstrap & /api/v1/analytics/dashboard faithfully', async () => {
    const email = `proxy_${Date.now()}@domation.net`;
    const regRes = await fetch(`${proxyBaseUrl}/api/autodata?action=register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_email: email,
        phone: '0909333444',
        password: 'Password@123',
        admin_name: 'Proxy Bridge User',
        company_name: 'Proxy Test Agency',
        tenant_slug: `proxy-${Date.now()}`,
        industry: 'real_estate',
      }),
    });
    assert.equal(regRes.status, 201);
    const regJson = (await regRes.json()) as any;
    assert.equal(regJson.success, true);
    const slug = regJson.data.tenant.slug;

    // Login via proxy WITHOUT tenant_slug
    const loginRes = await fetch(`${proxyBaseUrl}/api/autodata?action=login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password@123' }),
    });
    assert.equal(loginRes.status, 200);
    const loginJson = (await loginRes.json()) as any;
    assert.equal(loginJson.data.action, 'enter_workspace');
    const token = loginJson.data.access_token;

    // Proxy /api/autodata?action=bootstrap (public billing catalog)
    const bootRes = await fetch(`${proxyBaseUrl}/api/autodata?action=bootstrap`);
    assert.equal(bootRes.status, 200);
    const bootJson = (await bootRes.json()) as any;
    assert.equal(bootJson.data.catalog.trial_duration_days, 30);

    // Proxy /api/autodata?action=workspace-overview
    const wsRes = await fetch(`${proxyBaseUrl}/api/autodata?action=workspace-overview`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Slug': slug,
      },
    });
    assert.equal(wsRes.status, 200);
    const wsJson = (await wsRes.json()) as any;
    assert.equal(wsJson.data.tenant.slug, slug);

    // Direct /api/v1/* passthrough
    const dashRes = await fetch(`${proxyBaseUrl}/api/v1/analytics/dashboard?date_preset=this_month`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Tenant-Slug': slug,
      },
    });
    assert.equal(dashRes.status, 200);
    const dashJson = (await dashRes.json()) as any;
    assert.equal(dashJson.success, true);
    assert.ok(dashJson.data.kpis);
  });
});
