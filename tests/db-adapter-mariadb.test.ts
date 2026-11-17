import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { translatePostgresSqlToMariaDb } from '../server/core/database/sql-translator.ts';
import { generateCsprngBase62, generateObfuscatedSlug } from '../server/core/crypto/slug.ts';
import { getTenantBySlugCached } from '../server/core/settings/tenant-cache.ts';
import { startTestServer, type TestHarness } from './helpers.ts';
import { withSystemPrivilege } from '../server/core/database/transaction.ts';

describe('Milestone 1: Dual-Dialect Database Adapter & CSPRNG Obfuscated Slug Engine', () => {
  let harness: TestHarness;

  before(async () => {
    harness = await startTestServer();
  });

  after(async () => {
    await harness.close();
  });

  it('1. SQL Translator maps numbered placeholders to ? with parameter duplication for repeated placeholders', () => {
    const sql = 'SELECT * FROM leads WHERE tenant_id = $1 AND (assigned_to = $2 OR created_by = $2) AND status = $3';
    const params = ['tenant-uuid-1', 'user-uuid-2', 'assigned'];

    const translated = translatePostgresSqlToMariaDb(sql, params);
    assert.equal(
      translated.sql,
      'SELECT * FROM leads WHERE tenant_id = ? AND (assigned_to = ? OR created_by = ?) AND status = ?'
    );
    assert.deepEqual(translated.params, [
      'tenant-uuid-1',
      'user-uuid-2',
      'user-uuid-2',
      'assigned',
    ]);
  });

  it('2. SQL Translator ignores $N placeholders inside single-quoted strings and escaped quotes', () => {
    const sql = "SELECT '$1' AS literal, 'It''s $2 test' AS literal_escaped, name FROM users WHERE id = $1";
    const params = ['actual-user-id'];

    const translated = translatePostgresSqlToMariaDb(sql, params);
    assert.equal(
      translated.sql,
      "SELECT '$1' AS literal, 'It''s $2 test' AS literal_escaped, name FROM users WHERE id = ?"
    );
    assert.deepEqual(translated.params, ['actual-user-id']);
  });

  it('3. SQL Translator strips PostgreSQL typecasts and translates PostgreSQL functions to MariaDB 10.6 syntax', () => {
    const sql = `
      SELECT id, clock_timestamp() AS ts, gen_random_uuid() AS uid, COUNT(*)::int AS cnt,
             custom_fields->>'company' AS company_name, metadata->'tags' AS tags_json
      FROM leads
      WHERE tenant_id = $1::uuid
        AND name ILIKE $2
        AND custom_fields = '{}'::jsonb
        AND created_at <= clock_timestamp() - INTERVAL '7 days'
    `;
    const params = ['t-1', '%Nguyen%'];

    const translated = translatePostgresSqlToMariaDb(sql, params);

    assert.ok(!translated.sql.includes('clock_timestamp()'), 'Must not contain clock_timestamp()');
    assert.ok(translated.sql.includes('CURRENT_TIMESTAMP(6)'), 'Must contain CURRENT_TIMESTAMP(6)');
    assert.ok(!translated.sql.includes('gen_random_uuid()'), 'Must not contain gen_random_uuid()');
    assert.ok(translated.sql.includes('UUID()'), 'Must contain UUID()');
    assert.ok(!translated.sql.includes('::'), 'Must not contain any PostgreSQL :: typecasts');
    assert.ok(translated.sql.includes('LIKE ?'), 'Must translate ILIKE to LIKE');
    assert.ok(translated.sql.includes("JSON_UNQUOTE(JSON_EXTRACT(custom_fields, '$.company'))"));
    assert.ok(translated.sql.includes("JSON_EXTRACT(metadata, '$.tags')"));
    assert.ok(translated.sql.includes("INTERVAL 7 DAY"));
    assert.equal(translated.params.length, 2);
    assert.equal(translated.params[0], 't-1');
    assert.equal(translated.params[1], '%Nguyen%');
  });

  it('4. SQL Translator handles ON CONFLICT DO NOTHING, DO UPDATE and EXCLUDED', () => {
    const sqlNothing = 'INSERT INTO round_consultants (id) VALUES ($1) ON CONFLICT (tenant_id, round_id, user_id) DO NOTHING';
    const trNothing = translatePostgresSqlToMariaDb(sqlNothing, ['rc-1']);
    assert.ok(trNothing.sql.includes('ON DUPLICATE KEY UPDATE id = id'));

    const sqlUpdate = 'INSERT INTO tenant_settings (id, val) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET val = EXCLUDED.val';
    const trUpdate = translatePostgresSqlToMariaDb(sqlUpdate, ['s-1', 'v-1']);
    assert.ok(trUpdate.sql.includes('ON DUPLICATE KEY UPDATE'));
    assert.ok(trUpdate.sql.includes('VALUES(val)'));
  });

  it('5. SQL Translator translates PostgreSQL ANY($N) array checks to MariaDB IN (?)', () => {
    const sql = 'SELECT * FROM users WHERE tenant_id = $1 AND role = ANY($2::varchar[]) AND NOT (id = ANY($3::uuid[]))';
    const params = ['t-1', ['sale', 'manager'], ['u-1', 'u-2']];

    const tr = translatePostgresSqlToMariaDb(sql, params);
    assert.ok(tr.sql.includes('role IN (?)'), 'Translates = ANY($2) to role IN (?)');
    assert.ok(tr.sql.includes('id NOT IN (?)'), 'Translates NOT (id = ANY($3)) to id NOT IN (?)');
    assert.deepEqual(tr.params, ['t-1', ['sale', 'manager'], ['u-1', 'u-2']]);
  });

  it('6. SQL Translator extracts metadata for MariaDB UPDATE ... RETURNING polyfill', () => {
    const sql = `UPDATE leads SET status = $1, sla_breached = true WHERE tenant_id = $2 AND id = $3 RETURNING id, status, updated_at`;
    const params = ['recalled', 'tenant-123', 'lead-456'];

    const translated = translatePostgresSqlToMariaDb(sql, params);
    assert.equal(translated.isUpdateReturning, true);
    assert.ok(translated.updateMeta);
    assert.equal(translated.updateMeta.table, 'leads');
    assert.equal(translated.updateMeta.returningCols, 'id, status, updated_at');
    assert.ok(!translated.sql.includes('RETURNING'));
    assert.equal(translated.updateMeta.whereClause, 'tenant_id = ? AND id = ?');
    assert.deepEqual((translated.updateMeta as any).whereParams, ['tenant-123', 'lead-456']);
  });

  it('7. CSPRNG Base62 generates uniform unbiased strings with rejection sampling', () => {
    const slug1 = generateCsprngBase62(10);
    const slug2 = generateCsprngBase62(10);
    assert.equal(slug1.length, 10);
    assert.equal(slug2.length, 10);
    assert.match(slug1, /^[0-9a-zA-Z]{10}$/);
    assert.match(slug2, /^[0-9a-zA-Z]{10}$/);
    assert.notEqual(slug1, slug2);

    // Verify rejection sampling entropy over 1000 generations: 0 collisions
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const generated = generateCsprngBase62(10);
      assert.equal(set.has(generated), false, `Collision detected at iteration ${i}: ${generated}`);
      set.add(generated);
    }
  });

  it('8. Obfuscated Slug Generator produces clean non-enumerable slugs with brand prefixes', () => {
    const ecoSlug = generateObfuscatedSlug('EcoLife Real Estate');
    assert.match(ecoSlug, /^ecoliferealestate-[0-9a-zA-Z]{10}$/);

    const vinSlug = generateObfuscatedSlug('VinFast Auto 2026!');
    assert.match(vinSlug, /^vinfastauto2026-[0-9a-zA-Z]{10}$/);

    const emptySlug = generateObfuscatedSlug('');
    assert.match(emptySlug, /^tenant-[0-9a-zA-Z]{10}$/);
  });

  it('9. Dual-Resolution Slug Cache resolves tenants by both vanity slug and obfuscated_slug', async () => {
    const brandPrefix = `dual-brand-${Date.now().toString(36)}`;
    const obfSlug = generateObfuscatedSlug(brandPrefix);

    let testTenantId = '';
    await withSystemPrivilege(async (client) => {
      const insRes = await client.query<{ id: string }>(
        `INSERT INTO tenants (slug, obfuscated_slug, name, industry, plan_tier, status)
         VALUES ($1, $2, 'Dual Resolution Co', 'general', 'starter', 'active')
         RETURNING id`,
        [brandPrefix, obfSlug]
      );
      testTenantId = insRes.rows[0].id;
    });

    try {
      // 1. Resolve by vanity slug
      const byVanity = await getTenantBySlugCached(brandPrefix);
      assert.ok(byVanity);
      assert.equal(byVanity.id, testTenantId);
      assert.equal(byVanity.slug, brandPrefix);
      assert.equal(byVanity.obfuscated_slug, obfSlug);

      // 2. Resolve by obfuscated slug
      const byObfuscated = await getTenantBySlugCached(obfSlug);
      assert.ok(byObfuscated);
      assert.equal(byObfuscated.id, testTenantId);
      assert.equal(byObfuscated.slug, brandPrefix);
      assert.equal(byObfuscated.obfuscated_slug, obfSlug);
    } finally {
      await withSystemPrivilege(async (client) => {
        await client.query('DELETE FROM tenants WHERE id = $1', [testTenantId]);
      });
    }
  });

  it('10. SQL Translator fixes table-qualified JSON columns without leaking table to JSON_UNQUOTE', () => {
    const sql = `
      SELECT id, (t.settings->>'zalo_token_refresh_window_hours')::int AS refresh_win,
             t.settings->'zalo_credentials' AS creds
      FROM tenants t
      WHERE t.id = $1
    `;
    const tr = translatePostgresSqlToMariaDb(sql, ['t-uuid-1']);

    assert.ok(!tr.sql.includes('t.JSON_UNQUOTE'), 'Must not generate invalid schema-qualified t.JSON_UNQUOTE');
    assert.ok(
      tr.sql.includes("JSON_UNQUOTE(JSON_EXTRACT(t.settings, '$.zalo_token_refresh_window_hours'))"),
      'Must wrap table-qualified column inside JSON_EXTRACT'
    );
    assert.ok(
      tr.sql.includes("JSON_EXTRACT(t.settings, '$.zalo_credentials')"),
      'Must extract nested object with table alias'
    );
    assert.deepEqual(tr.params, ['t-uuid-1']);
  });

  it('11. SQL Translator handles complex expressions in ANY($N) and NOT (... = ANY($N))', () => {
    // 1. Complex COALESCE + JSON extraction expression wrapped in NOT (... = ANY(...))
    const sqlNot = `
      SELECT * FROM lead_timeline_events
      WHERE tenant_id = $1
        AND NOT (COALESCE(metadata->>'note_category', '') = ANY($2::text[]))
    `;
    const trNot = translatePostgresSqlToMariaDb(sqlNot, ['tenant-123', ['system', 'capi']]);

    assert.ok(!trNot.sql.includes('= ANY('), 'Must not leak = ANY to MariaDB');
    assert.ok(
      trNot.sql.includes("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.note_category')), '') NOT IN (?)"),
      'Must translate to NOT IN (?) with preserved expression'
    );
    assert.deepEqual(trNot.params, ['tenant-123', ['system', 'capi']]);

    // 2. Positive ANY expression with function
    const sqlPos = `SELECT * FROM leads WHERE COALESCE(status, 'new') = ANY($1::text[]) AND id = $2`;
    const trPos = translatePostgresSqlToMariaDb(sqlPos, [['open', 'assigned'], 'lead-1']);
    assert.ok(!trPos.sql.includes('= ANY('), 'Must not leak = ANY');
    assert.ok(trPos.sql.includes("COALESCE(status, 'new') IN (?)"));
    assert.deepEqual(trPos.params, [['open', 'assigned'], 'lead-1']);
  });

  it('12. SQL Translator cleanses leaked typecasts and ILIKE in UPDATE RETURNING WHERE clause', () => {
    const sql = `
      UPDATE leads
      SET status = $1, sla_breached = true
      WHERE tenant_id = $2::uuid AND name ILIKE $3
      RETURNING id, status
    `;
    const tr = translatePostgresSqlToMariaDb(sql, ['recalled', 'tenant-uuid-1', '%Nguyen%']);

    assert.equal(tr.isUpdateReturning, true);
    assert.ok(tr.updateMeta);
    assert.ok(!tr.updateMeta.whereClause.includes('::uuid'), 'Must strip ::uuid from whereClause');
    assert.ok(!tr.updateMeta.whereClause.includes('ILIKE'), 'Must translate ILIKE to LIKE in whereClause');
    assert.equal(tr.updateMeta.whereClause, 'tenant_id = ? AND name LIKE ?');
    assert.deepEqual(tr.updateMeta.whereParams, ['tenant-uuid-1', '%Nguyen%']);
    assert.equal(tr.updateMeta.returningCols, 'id, status');
  });

  it('13. SQL Translator cleans trailing semicolons in UPDATE RETURNING statements and returningCols', () => {
    const sql = `UPDATE leads SET status = $1 WHERE id = $2 RETURNING id, status, updated_at;`;
    const tr = translatePostgresSqlToMariaDb(sql, ['active', 'lead-777']);

    assert.equal(tr.isUpdateReturning, true);
    assert.ok(tr.updateMeta);
    assert.ok(!tr.updateMeta.returningCols.includes(';'), 'Must not contain trailing semicolon in returningCols');
    assert.equal(tr.updateMeta.returningCols, 'id, status, updated_at');
    assert.ok(!tr.sql.includes(';'), 'Main SQL must not contain trailing semicolon');
  });

  it('14. SQL Translator supports UPDATE RETURNING without WHERE clause', () => {
    const sql = `UPDATE platform_settings SET setting_value = $1 RETURNING setting_key, setting_value`;
    const tr = translatePostgresSqlToMariaDb(sql, ['{"maintenance": false}']);

    assert.equal(tr.isUpdateReturning, true);
    assert.ok(tr.updateMeta);
    assert.equal(tr.updateMeta.table, 'platform_settings');
    assert.equal(tr.updateMeta.whereClause, '');
    assert.deepEqual(tr.updateMeta.whereParams, []);
    assert.equal(tr.updateMeta.pkCol, 'setting_key');
    assert.equal(tr.updateMeta.returningCols, 'setting_key, setting_value');
    assert.equal(tr.sql, 'UPDATE platform_settings SET setting_value = ?');
    assert.deepEqual(tr.params, ['{"maintenance": false}']);
  });

  it('15. SQL Translator preserves string literals containing :: typecast signatures', () => {
    const sql = `
      SELECT 'user::jsonb' AS col1, 'is_active::boolean' AS col2, 'status::varchar(30)' AS col3, id
      FROM users
      WHERE role = $1::varchar(30) AND tenant_id = $2::uuid
    `;
    const tr = translatePostgresSqlToMariaDb(sql, ['sale', 't-123']);

    assert.ok(tr.sql.includes("'user::jsonb'"), 'String literal user::jsonb must not be mutated');
    assert.ok(tr.sql.includes("'is_active::boolean'"), 'String literal is_active::boolean must not be mutated');
    assert.ok(tr.sql.includes("'status::varchar(30)'"), 'String literal status::varchar(30) must not be mutated');
    assert.ok(tr.sql.includes('WHERE role = ? AND tenant_id = ?'), 'Typecasts in WHERE clause must be stripped');
    assert.ok(!tr.sql.includes('::uuid'), 'SQL typecast ::uuid must be stripped');
    assert.deepEqual(tr.params, ['sale', 't-123']);
  });

  it('16. SQL Translator supports nested JSON paths and keys with hyphens and special characters', () => {
    // Nested unquoted path
    const sqlNested = `SELECT custom_fields->'address'->>'city' AS city FROM leads WHERE id = $1`;
    const trNested = translatePostgresSqlToMariaDb(sqlNested, ['lead-1']);
    assert.ok(
      trNested.sql.includes("JSON_UNQUOTE(JSON_EXTRACT(custom_fields, '$.address.city'))"),
      'Must resolve nested chained arrows to dot-notation path'
    );

    // Hyphenated and non-ASCII keys
    const sqlHyphen = `SELECT custom_fields->>'first-name' AS fname, custom_fields->>'họ_tên' AS name FROM leads WHERE id = $1`;
    const trHyphen = translatePostgresSqlToMariaDb(sqlHyphen, ['lead-2']);
    assert.ok(
      trHyphen.sql.includes("JSON_UNQUOTE(JSON_EXTRACT(custom_fields, '$.first-name'))"),
      'Must support hyphenated keys in JSON unquote'
    );
    assert.ok(
      trHyphen.sql.includes("JSON_UNQUOTE(JSON_EXTRACT(custom_fields, '$.họ_tên'))"),
      'Must support unicode / Vietnamese characters in JSON keys'
    );

    // Nested non-unquoted path
    const sqlNestedObj = `SELECT custom_fields->'address'->'geo' AS geo FROM leads WHERE id = $1`;
    const trNestedObj = translatePostgresSqlToMariaDb(sqlNestedObj, ['lead-3']);
    assert.ok(
      trNestedObj.sql.includes("JSON_EXTRACT(custom_fields, '$.address.geo')"),
      'Must resolve nested object without JSON_UNQUOTE'
    );
  });
});
