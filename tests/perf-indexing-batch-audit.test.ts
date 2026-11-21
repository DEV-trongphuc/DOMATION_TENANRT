import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createDatabasePool,
  setDatabasePool,
  getDatabasePool,
  type DatabasePool,
} from '../server/core/database/db-adapter.ts';
import { runMigrations } from '../server/core/database/migrate.ts';
import { ensureMarketingSchema } from '../server/modules/marketing/schema.ts';
import { ensureErpOpsSchema } from '../server/modules/erp-ops/schema.ts';
import {
  clearDomMetaGraphCacheForTesting,
  executeDomMetaGraphBatch,
  setDomMetaExternalFetcherForTesting,
} from '../server/services/dom-meta-report.service.ts';

describe('Backend Performance — Composite DB Indexes & Meta Graph Batch Deduplication', () => {
  let pool: DatabasePool;

  before(async () => {
    pool = createDatabasePool({ inMemory: true });
    setDatabasePool(pool);
    await runMigrations({ seedSuperAdmin: false });
    await ensureErpOpsSchema();
    await ensureMarketingSchema();
  });

  after(async () => {
    setDomMetaExternalFetcherForTesting(null);
    clearDomMetaGraphCacheForTesting();
    await pool.close();
    setDatabasePool(null);
  });

  it('creates all performance composite indexes across leads, erp-ops, and marketing tables', async () => {
    const activePool = getDatabasePool();
    const client = await activePool.connect();
    let res: { rows: Array<{ indexname: string }> };
    try {
      res = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
      );
    } finally {
      client.release();
    }
    const indexSet = new Set(res.rows.map((r) => r.indexname));

    const expectedIndexes = [
      // Core Leads & Meta attribution / dedupe
      'idx_leads_tenant_adset_created',
      'idx_leads_tenant_email_lower',
      'idx_leads_tenant_phone',
      'idx_leads_tenant_updated',
      // ERP Ops (Tasks, Deals, Helpdesk)
      'idx_tenant_tasks_assignee_status',
      'idx_tenant_deals_owner_stage',
      'idx_tenant_deals_company',
      'idx_helpdesk_lead',
      'idx_helpdesk_assignee_status',
      // Marketing Automation, Flows, Web Tracking & Customer 360
      'idx_mkt_flow_enroll_due',
      'idx_mkt_flow_enroll_step',
      'idx_mkt_flow_enroll_lead',
      'idx_mkt_websess_lead',
      'idx_mkt_websess_prop_started',
      'idx_mkt_websess_pricing',
      'idx_mkt_webevt_session',
      'idx_mkt_webevt_prop_created',
      'idx_mkt_send_claims_lead',
      'idx_mkt_send_claims_camp_sent',
      'idx_mkt_socconv_lead',
      'idx_mkt_form_sub_lead',
      'idx_mkt_srv_resp_lead',
      'idx_mkt_vcode_lead',
    ];

    const missing = expectedIndexes.filter((name) => !indexSet.has(name));
    assert.deepEqual(missing, [], `Missing expected performance indexes: ${missing.join(', ')}`);
  });

  it('executeDomMetaGraphBatch deduplicates identical sub-requests within a single batch and validates bounds', async () => {
    clearDomMetaGraphCacheForTesting();
    const upstreamUrls: string[] = [];
    setDomMetaExternalFetcherForTesting(async (url) => {
      upstreamUrls.push(url);
      const payload = { data: [{ spend: '150000', impressions: '1200' }] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      };
    });

    // Duplicate relativeUrl under two distinct keys -> must execute ONLY 1 upstream call and populate BOTH keys
    const res = await executeDomMetaGraphBatch('tenant-perf-1', 'EAAG_TEST_TOKEN', {
      ad_account_id: 'act_123456',
      requests: [
        { key: 'summary_a', graph_path: 'act_123456/insights', params: { fields: 'spend,impressions' } },
        { key: 'summary_b', graph_path: 'act_123456/insights', params: { fields: 'spend,impressions' } },
        { key: 'daily', graph_path: 'act_123456/insights', params: { fields: 'spend', time_increment: 1 } },
      ],
    });

    assert.equal(res.success, true);
    assert.equal(upstreamUrls.length, 2, 'Expected duplicate sub-requests to coalesce into 2 unique upstream calls');
    assert.deepEqual((res as any).data.summary_a, { data: [{ spend: '150000', impressions: '1200' }] });
    assert.deepEqual((res as any).data.summary_b, { data: [{ spend: '150000', impressions: '1200' }] });
    assert.ok((res as any).data.daily);

    // Boundary checks: empty batch & invalid graph_path rejected cleanly
    const emptyRes = await executeDomMetaGraphBatch('tenant-perf-1', 'EAAG_TEST_TOKEN', {
      requests: [],
    });
    assert.equal(emptyRes.success, false);
    assert.equal(emptyRes.status, 422);

    const badPathRes = await executeDomMetaGraphBatch('tenant-perf-1', 'EAAG_TEST_TOKEN', {
      requests: [{ key: 'evil', graph_path: '../etc/passwd' }],
    });
    assert.equal(badPathRes.success, false);
    assert.equal(badPathRes.status, 422);
  });

  it('retries transient HTTP 429 on production Meta Graph batch chunks and deduplicates batch JSON payload', async () => {
    setDomMetaExternalFetcherForTesting(null);
    clearDomMetaGraphCacheForTesting();

    const originalFetch = globalThis.fetch;
    let attempts = 0;
    let sentBatchLength = 0;

    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      attempts += 1;
      const bodyParams = new URLSearchParams(String(init?.body || ''));
      const batchArr = JSON.parse(bodyParams.get('batch') || '[]');
      sentBatchLength = batchArr.length;

      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: 'Rate limited', code: 4 } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify([
          { code: 200, body: JSON.stringify({ data: [{ spend: '500000' }] }) },
          { code: 200, body: JSON.stringify({ data: [{ impressions: '9000' }] }) },
        ]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }) as typeof fetch;

    try {
      const res = await executeDomMetaGraphBatch('tenant-perf-retry', 'EAAG_RETRY_TOKEN', {
        ad_account_id: 'act_999999',
        requests: [
          { key: 'dup_1', graph_path: 'act_999999/insights', params: { fields: 'spend' } },
          { key: 'dup_2', graph_path: 'act_999999/insights', params: { fields: 'spend' } },
          { key: 'uniq_3', graph_path: 'act_999999/insights', params: { fields: 'impressions' } },
        ],
      });

      assert.equal(res.success, true);
      assert.equal(attempts, 2, 'Should retry transient 429 once and succeed on attempt 2');
      assert.equal(sentBatchLength, 2, 'Batch JSON payload should contain 2 deduplicated sub-requests, not 3');
      assert.deepEqual((res as any).data.dup_1, { data: [{ spend: '500000' }] });
      assert.deepEqual((res as any).data.dup_2, { data: [{ spend: '500000' }] });
      assert.deepEqual((res as any).data.uniq_3, { data: [{ impressions: '9000' }] });
    } finally {
      globalThis.fetch = originalFetch;
      clearDomMetaGraphCacheForTesting();
    }
  });

  it('surfaces errors for failed chunks in multi-chunk batches instead of silently dropping keys', async () => {
    setDomMetaExternalFetcherForTesting(null);
    clearDomMetaGraphCacheForTesting();

    const originalFetch = globalThis.fetch;
    let callIdx = 0;

    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      callIdx += 1;
      const bodyParams = new URLSearchParams(String(init?.body || ''));
      const batchArr = JSON.parse(bodyParams.get('batch') || '[]');

      // First chunk (4 items) succeeds, second chunk (2 items) returns HTTP 500 across retries
      const isSecondChunk = batchArr.some((b: any) => String(b.relative_url).includes('fields=k5'));
      if (isSecondChunk) {
        return new Response(JSON.stringify({ error: { message: 'Upstream 500', code: 2 } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify(
          batchArr.map((_: any, idx: number) => ({
            code: 200,
            body: JSON.stringify({ data: [{ ok: idx + 1 }] }),
          }))
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const res = await executeDomMetaGraphBatch('tenant-perf-partial', 'EAAG_PARTIAL_TOKEN', {
        ad_account_id: 'act_777777',
        requests: [
          { key: 'k1', graph_path: 'act_777777/insights', params: { fields: 'k1' } },
          { key: 'k2', graph_path: 'act_777777/insights', params: { fields: 'k2' } },
          { key: 'k3', graph_path: 'act_777777/insights', params: { fields: 'k3' } },
          { key: 'k4', graph_path: 'act_777777/insights', params: { fields: 'k4' } },
          { key: 'k5', graph_path: 'act_777777/insights', params: { fields: 'k5' } },
          { key: 'k6', graph_path: 'act_777777/insights', params: { fields: 'k6' } },
        ],
      });

      assert.equal(res.success, true);
      assert.ok(callIdx >= 3, 'Chunk 2 should retry once on HTTP 500');
      assert.ok((res as any).data.k1 && (res as any).data.k4, 'Chunk 1 keys should succeed');
      assert.ok((res as any).errors?.k5, 'Chunk 2 key k5 must be reported in errors (not silently dropped)');
      assert.ok((res as any).errors?.k6, 'Chunk 2 key k6 must be reported in errors (not silently dropped)');
    } finally {
      globalThis.fetch = originalFetch;
      clearDomMetaGraphCacheForTesting();
    }
  });

  it('maintains MariaDB 10.6 schema parity for all leads, erp-ops, and marketing composite indexes', () => {
    const migrateSrc = fs.readFileSync(path.resolve('server/core/database/migrate.ts'), 'utf8');
    const erpSchemaSrc = fs.readFileSync(path.resolve('server/modules/erp-ops/schema.ts'), 'utf8');
    const mktSchemaSrc = fs.readFileSync(path.resolve('server/modules/marketing/schema.ts'), 'utf8');
    const mariaSql = fs.readFileSync(path.resolve('docs/DATABASE_SCHEMA_MARIADB.sql'), 'utf8');

    const mariaLeadIndexes = [
      'idx_leads_tenant_adset_created',
      'idx_leads_tenant_email',
      'idx_leads_tenant_phone',
      'idx_leads_tenant_updated',
    ];
    for (const idx of mariaLeadIndexes) {
      assert.ok(migrateSrc.includes(idx), `migrate.ts missing MariaDB lead index ${idx}`);
      assert.ok(mariaSql.includes(idx), `DATABASE_SCHEMA_MARIADB.sql missing lead index ${idx}`);
    }

    const mariaErpIndexes = [
      'idx_tenant_tasks_assignee_status',
      'idx_tenant_deals_owner_stage',
      'idx_tenant_deals_company',
      'idx_helpdesk_lead',
      'idx_helpdesk_assignee_status',
    ];
    const mariaErpSection = erpSchemaSrc.slice(erpSchemaSrc.indexOf('runErpOpsMariaDbSchema'));
    for (const idx of mariaErpIndexes) {
      assert.ok(mariaErpSection.includes(idx), `runErpOpsMariaDbSchema missing ${idx}`);
      assert.ok(mariaSql.includes(idx), `DATABASE_SCHEMA_MARIADB.sql missing ${idx}`);
    }

    const mariaMktSection = mktSchemaSrc.slice(mktSchemaSrc.indexOf('MARIADB_MARKETING_ALTERS'));
    for (const idx of ['idx_mkt_flow_enroll_due', 'idx_mkt_websess_lead', 'idx_mkt_send_claims_lead']) {
      assert.ok(mariaMktSection.includes(idx), `MARIADB_MARKETING_ALTERS missing ${idx}`);
    }
  });
});
