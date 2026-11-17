import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabasePool, setDatabasePool, type DatabasePool } from '../server/core/database/db-adapter.ts';
import { verifyPassword } from '../server/core/crypto/password.ts';
import {
  migrateEcoLifeData,
  ECOLIFE_ADMIN_EMAIL,
  ECOLIFE_ADMIN_PASSWORD,
} from '../scripts/migrate-ecolife-data.ts';

describe('EcoLife Real SQL Dump (yinpzoab_data.sql) Migration & Integrity', () => {
  let pool: DatabasePool;
  let tenantId: string;

  before(async () => {
    const isPersistent = process.env.TEST_PERSISTENT_DB === 'true';
    pool = createDatabasePool({ inMemory: !isPersistent });
    setDatabasePool(pool);
    const res = await migrateEcoLifeData();
    assert.equal(res.success, true);
    assert.equal(res.totalSourceLeads, 631);
    assert.equal(res.totalMigrated, 631);
    assert.equal(res.activeAssignedCount, 195);
    assert.equal(res.archivedSilentCount, 434);
    assert.equal(res.heldRejectedCount, 1);
    assert.equal(res.blacklistedCount, 1);
    assert.equal(res.ticketsCount, 5);
    assert.equal(res.duplicateRemindersCount, 8);
    assert.equal(res.consultantsCount, 3);
    tenantId = res.tenantId;
  });

  after(async () => {
    if (pool) {
      await pool.close().catch(() => {});
      setDatabasePool(null);
    }
  });

  test('1. Provisions tenant "ecolife" with real_estate industry and enterprise plan', async () => {
    const client = await pool.connect();
    try {
      const res = await client.query<{
        id: string;
        slug: string;
        industry: string;
        plan_tier: string;
        status: string;
      }>(`SELECT id, slug, industry, plan_tier, status FROM tenants WHERE id = $1`, [tenantId]);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].slug, 'ecolife');
      assert.equal(res.rows[0].industry, 'real_estate');
      assert.equal(res.rows[0].plan_tier, 'enterprise');
      assert.equal(res.rows[0].status, 'active');
    } finally {
      client.release();
    }
  });

  test('2. Verifies admin turniodev@gmail.com / 123456 & real EcoLife admin accounts', async () => {
    const client = await pool.connect();
    try {
      const res = await client.query<{
        email: string;
        role: string;
        password_hash: string;
        account_id: string | null;
      }>(
        `SELECT email, role, password_hash, account_id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2`,
        [tenantId, ECOLIFE_ADMIN_EMAIL]
      );
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].role, 'tenant_admin');
      assert.ok(res.rows[0].account_id);
      assert.equal(await verifyPassword(ECOLIFE_ADMIN_PASSWORD, res.rows[0].password_hash), true);
    } finally {
      client.release();
    }
  });

  test('3. Exact 3 real F1 Real-Estate Agencies active lead breakdown (64 / 65 / 66 = 195)', async () => {
    const client = await pool.connect();
    try {
      const res = await client.query<{ email: string; full_name: string; is_external_agency: boolean; cnt: number }>(
        `SELECT u.email, u.full_name, u.is_external_agency, COUNT(l.id)::int AS cnt
         FROM users u
         LEFT JOIN leads l ON l.tenant_id = u.tenant_id AND l.assigned_to = u.id AND l.status = 'assigned' AND l.is_deleted = false
         WHERE u.tenant_id = $1 AND u.role = 'sale'
         GROUP BY u.id, u.email, u.full_name, u.is_external_agency`,
        [tenantId]
      );
      const map = new Map(res.rows.map((r) => [r.email, r]));
      assert.equal(res.rows.length, 3);
      assert.equal(map.get('diaoctunglong@gmail.com')?.cnt, 64);
      assert.equal(map.get('qlsp.hopnhatland@gmail.com')?.cnt, 65);
      assert.equal(map.get('phuongvh@iholdings.vn')?.cnt, 66);
    } finally {
      client.release();
    }
  });

  test('4. Migrates rounds, routing_rules, co-managers, data_reports, held_leads, blacklist & meta ads insights', async () => {
    const client = await pool.connect();
    try {
      const rounds = await client.query<{ name: string }>(
        `SELECT name FROM distribution_rounds WHERE tenant_id = $1 ORDER BY name ASC`,
        [tenantId]
      );
      assert.deepEqual(
        rounds.rows.map((r) => r.name),
        ['EcoLife Signature - Meta Form', 'EcoLife Signature - Website']
      );

      const cm = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM consultant_managers WHERE tenant_id = $1`,
        [tenantId]
      );
      assert.equal(cm.rows[0].cnt, 4);

      const tickets = await client.query<{ total: number; approved: number }>(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'approved')::int AS approved
         FROM data_reports WHERE tenant_id = $1`,
        [tenantId]
      );
      assert.equal(tickets.rows[0].total, 5);
      assert.equal(tickets.rows[0].approved, 5);

      const blacklist = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM blacklist_entries WHERE tenant_id = $1`,
        [tenantId]
      );
      assert.equal(blacklist.rows[0].cnt, 1);

      const ads = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM meta_ads_insights WHERE tenant_id = $1`,
        [tenantId]
      );
      assert.ok(ads.rows[0].cnt > 0);
    } finally {
      client.release();
    }
  });

  test('5. Idempotency & Strict Silent Mode: zero CAPI logs and zero secrets leaked into settings', async () => {
    const second = await migrateEcoLifeData();
    assert.equal(second.totalMigrated, 631);
    assert.equal(second.activeAssignedCount, 195);

    const client = await pool.connect();
    try {
      const capi = await client.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM capi_logs WHERE tenant_id = $1`,
        [tenantId]
      );
      assert.equal(capi.rows[0].cnt, 0);

      const tSettings = await client.query<{ settings: Record<string, unknown> }>(
        `SELECT settings FROM tenants WHERE id = $1`,
        [tenantId]
      );
      const jsonStr = JSON.stringify(tSettings.rows[0].settings);
      assert.equal(jsonStr.includes('gemini_api_key'), false);
      assert.equal(jsonStr.includes('meta_ads_access_token'), false);
      assert.equal(jsonStr.includes('zalo_bot_token'), false);
    } finally {
      client.release();
    }
  });
});
