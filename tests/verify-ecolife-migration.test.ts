import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import {
  DEFAULT_ECOLIFE_SQL_PATH,
  migrateEcoLifeData,
  ECOLIFE_ADMIN_EMAIL,
  ECOLIFE_ADMIN_PASSWORD,
} from '../scripts/migrate-ecolife-data.ts';
import { sendTelegramNotification } from '../server/services/telegram.service.ts';

const hasEcoLifeDump = fs.existsSync(DEFAULT_ECOLIFE_SQL_PATH);

describe('EcoLife Real Dump — End-to-End API & Analytics Verification', { skip: !hasEcoLifeDump ? 'Optional EcoLife SQL dump not present' : false }, () => {
  let harness: TestHarness;
  let adminToken: string;
  let saleToken: string;
  let saleUserId: string;

  before(async () => {
    harness = await startTestServer();
    const res = await migrateEcoLifeData();
    assert.equal(res.success, true);
    assert.equal(res.totalMigrated, 631);
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
  });

  test('1. Admin logs in WITHOUT tenant_slug -> enter_workspace "ecolife" directly', async () => {
    const login = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: ECOLIFE_ADMIN_EMAIL, password: ECOLIFE_ADMIN_PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.success, true);
    assert.equal(login.json.data.action, 'enter_workspace');
    assert.equal(login.json.data.tenant.slug, 'ecolife');
    assert.ok(login.json.data.access_token);
    adminToken = login.json.data.access_token;

    const badLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: ECOLIFE_ADMIN_EMAIL, password: 'wrong-password' },
    });
    assert.equal(badLogin.status, 401);
  });

  test('2. Workspace Bootstrap & Dashboard Analytics reflect real 631-record EcoLife dump', async () => {
    const boot = await apiRequest(harness.baseUrl, '/api/v1/workspace/bootstrap', {
      token: adminToken,
      tenantSlug: 'ecolife',
    });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.data.tenant.slug, 'ecolife');
    assert.equal(boot.json.data.rounds.length, 2);
    assert.ok(boot.json.data.pipelines.length >= 1);

    const dash = await apiRequest(
      harness.baseUrl,
      '/api/v1/analytics/dashboard?date_preset=all&chart_mode=heatmap&source_mode=lead',
      {
        token: adminToken,
        tenantSlug: 'ecolife',
      }
    );
    assert.equal(dash.status, 200);
    const kpis = dash.json.data.kpis;
    assert.equal(kpis.total_received, 631);
    assert.equal(kpis.assigned_leads, 195);
    assert.equal(kpis.duplicate_leads, 8);
    assert.equal(kpis.error_tickets, 5);
    assert.equal(kpis.held_leads, 1);
    assert.equal(kpis.blacklisted_leads, 1);
    assert.ok(Array.isArray(dash.json.data.heatmap_matrix));
  });

  test('3. Fair-Share Audit, Ads Performance & Gatekeeper endpoints return seeded data', async () => {
    const fair = await apiRequest(harness.baseUrl, '/api/v1/analytics/fair-share', {
      token: adminToken,
      tenantSlug: 'ecolife',
    });
    assert.equal(fair.status, 200);
    assert.ok(typeof fair.json.data.fairness_score_pct === 'number');
    assert.ok(Array.isArray(fair.json.data.consultants));
    assert.equal(fair.json.data.consultants.length, 3);

    const ads = await apiRequest(harness.baseUrl, '/api/v1/analytics/ads-performance', {
      token: adminToken,
      tenantSlug: 'ecolife',
    });
    assert.equal(ads.status, 200);
    assert.ok(ads.json.data.ads.length > 0);

    const held = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/held-leads?status=held', {
      token: adminToken,
      tenantSlug: 'ecolife',
    });
    assert.equal(held.status, 200);
    assert.equal(held.json.data.items.length, 1);

    const bl = await apiRequest(harness.baseUrl, '/api/v1/operations/gatekeeper/blacklist', {
      token: adminToken,
      tenantSlug: 'ecolife',
    });
    assert.equal(bl.status, 200);
    assert.equal(bl.json.data.items.length, 1);
  });

  test('4. Real F1 Agency (Địa Ốc Tùng Long) Login, Personal Leads (0 Quota) & Co-Manager Max-3 Cap', async () => {
    const saleLogin = await apiRequest(harness.baseUrl, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'diaoctunglong@gmail.com', password: '123456' },
    });
    assert.equal(saleLogin.status, 200);
    saleToken = saleLogin.json.data.access_token;
    saleUserId = saleLogin.json.data.user.id;

    // Personal Lead -> isolated from round-robin quota
    const pCreate = await apiRequest(harness.baseUrl, '/api/v1/operations/personal-leads', {
      method: 'POST',
      token: saleToken,
      tenantSlug: 'ecolife',
      body: {
        name: 'Khách VIP Tự Khai Thác',
        phone: '0909888777',
        source: 'Giới thiệu cá nhân',
        note: 'Khách quen xem căn 3PN',
      },
    });
    assert.equal(pCreate.status, 201);

    const pList = await apiRequest(harness.baseUrl, '/api/v1/operations/personal-leads', {
      token: saleToken,
      tenantSlug: 'ecolife',
    });
    assert.equal(pList.status, 200);
    assert.equal(pList.json.data.items.length, 1);

    // Tùng Long already has 1 co-manager; adding 2 succeeds (3 total), adding 4th hits 400 cap
    const cm2 = await apiRequest(harness.baseUrl, `/api/v1/operations/co-managers/${saleUserId}`, {
      method: 'POST',
      token: saleToken,
      tenantSlug: 'ecolife',
      body: { name: 'Quản Lý Phụ 2', email: 'cm2@tunglong.vn', phone: '0905100112' },
    });
    assert.equal(cm2.status, 201);

    const cm3 = await apiRequest(harness.baseUrl, `/api/v1/operations/co-managers/${saleUserId}`, {
      method: 'POST',
      token: saleToken,
      tenantSlug: 'ecolife',
      body: { name: 'Quản Lý Phụ 3', email: 'cm3@tunglong.vn', phone: '0905100113' },
    });
    assert.equal(cm3.status, 201);

    const cm4 = await apiRequest(harness.baseUrl, `/api/v1/operations/co-managers/${saleUserId}`, {
      method: 'POST',
      token: saleToken,
      tenantSlug: 'ecolife',
      body: { name: 'Quản Lý Phụ 4', email: 'cm4@tunglong.vn', phone: '0905100114' },
    });
    assert.equal(cm4.status, 422);
  });

  test('5. Outbound Silent Mode blocks external Telegram HTTP calls completely', async () => {
    const res = await sendTelegramNotification(null, 'Silent verification test', {
      chatId: '999999',
      silentOverride: true,
    });
    assert.equal(res.silent, true);
    assert.equal(res.mocked, true);
  });
});
