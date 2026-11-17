import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, apiRequest, type TestHarness } from './helpers.ts';
import { withTenantTransaction, withUnscopedRlsCheck } from '../server/core/database/transaction.ts';
import { tenantStorage, getTenantContext } from '../server/core/context/tenant-context.ts';

describe('Phase 1: PostgreSQL Kernel RLS Zero-Leakage & Immutability Proofs', () => {
  let harness: TestHarness;
  let tenantA: { id: string; slug: string; token: string };
  let tenantB: { id: string; slug: string; token: string };

  before(async () => {
    harness = await startTestServer();

    const regA = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'EcoLife Signature',
        tenant_slug: 'ecolife',
        admin_name: 'Nam Nguyen',
        work_email: 'admin@ecolife.vn',
        phone: '0912345678',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: true,
      },
    });
    assert.equal(regA.status, 201);
    tenantA = {
      id: regA.json.data.tenant.id,
      slug: regA.json.data.tenant.slug,
      token: regA.json.data.access_token,
    };

    const regB = await apiRequest(harness.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'Khang Dien Corp',
        tenant_slug: 'khang-dien',
        admin_name: 'Binh Tran',
        work_email: 'admin@khangdien.vn',
        phone: '0987654321',
        password: 'SecurePassword123!',
        industry: 'real_estate',
        seed_demo_leads: true,
      },
    });
    assert.equal(regB.status, 201);
    tenantB = {
      id: regB.json.data.tenant.id,
      slug: regB.json.data.tenant.slug,
      token: regB.json.data.access_token,
    };
  });

  after(async () => {
    await harness.close();
  });

  it('Lemma 1: Queries executed without app.current_tenant_id return 0 rows across all tenant tables', async () => {
    await withUnscopedRlsCheck(async (client) => {
      const tables = ['tenants', 'users', 'leads', 'tenant_pipelines', 'lead_timeline_events', 'tenant_webhooks'];
      for (const table of tables) {
        const res = await client.query(`SELECT * FROM ${table}`);
        assert.equal(res.rows.length, 0, `Table ${table} must return 0 rows without tenant context`);
      }
    });
  });

  it('Lemma 2: Tenant A cannot read, update, or delete Tenant B records even by exact UUID', async () => {
    const tenantBLeadId = await withTenantTransaction(tenantB.id, async (client) => {
      const r = await client.query<{ id: string }>('SELECT id FROM leads LIMIT 1');
      assert.ok(r.rows[0]?.id);
      return r.rows[0].id;
    });

    await withTenantTransaction(tenantA.id, async (client) => {
      const readAttempt = await client.query('SELECT * FROM leads WHERE id = $1', [tenantBLeadId]);
      assert.equal(readAttempt.rows.length, 0, 'Cross-tenant SELECT by UUID must return 0 rows');

      const updateAttempt = await client.query("UPDATE leads SET name = 'HACKED' WHERE id = $1 RETURNING id", [
        tenantBLeadId,
      ]);
      assert.equal(updateAttempt.rows.length, 0, 'Cross-tenant UPDATE must affect 0 rows');

      const deleteAttempt = await client.query('DELETE FROM leads WHERE id = $1 RETURNING id', [tenantBLeadId]);
      assert.equal(deleteAttempt.rows.length, 0, 'Cross-tenant DELETE must affect 0 rows');
    });

    // Verify Tenant B record remains completely intact
    await withTenantTransaction(tenantB.id, async (client) => {
      const check = await client.query<{ name: string }>('SELECT name FROM leads WHERE id = $1', [tenantBLeadId]);
      assert.equal(check.rows.length, 1);
      assert.notEqual(check.rows[0].name, 'HACKED');
    });
  });

  it('Composite Foreign Keys block cross-tenant entity linkage at kernel level', async () => {
    const tenantBPipeline = await withTenantTransaction(tenantB.id, async (client) => {
      const p = await client.query<{ id: string }>('SELECT id FROM tenant_pipelines LIMIT 1');
      const s = await client.query<{ id: string }>('SELECT id FROM tenant_pipeline_stages LIMIT 1');
      return { pipelineId: p.rows[0].id, stageId: s.rows[0].id };
    });

    await assert.rejects(
      async () => {
        await withTenantTransaction(tenantA.id, async (client) => {
          await client.query(
            `INSERT INTO leads (tenant_id, pipeline_id, stage_id, status, name, phone)
             VALUES ($1, $2, $3, 'unassigned_pending', 'Cross FK Attack', '84901999888')`,
            [tenantA.id, tenantBPipeline.pipelineId, tenantBPipeline.stageId]
          );
        });
      },
      /foreign key constraint/i
    );
  });

  it('Timeline Immutability Trigger strictly blocks UPDATE and DELETE on lead_timeline_events', async () => {
    const timelineEventId = await withTenantTransaction(tenantA.id, async (client) => {
      const r = await client.query<{ id: string }>('SELECT id FROM lead_timeline_events LIMIT 1');
      assert.ok(r.rows[0]?.id);
      return r.rows[0].id;
    });

    await assert.rejects(
      async () => {
        await withTenantTransaction(tenantA.id, async (client) => {
          await client.query("UPDATE lead_timeline_events SET content = 'Tampered' WHERE id = $1", [timelineEventId]);
        });
      },
      /immutable append-only audit stream/i
    );

    await assert.rejects(
      async () => {
        await withTenantTransaction(tenantA.id, async (client) => {
          await client.query('DELETE FROM lead_timeline_events WHERE id = $1', [timelineEventId]);
        });
      },
      /immutable append-only audit stream/i
    );
  });

  it('AsyncLocalStorage & DB Transactions preserve 100% isolation across 50 parallel requests', async () => {
    const tasks = Array.from({ length: 50 }, (_, idx) => {
      const target = idx % 2 === 0 ? tenantA : tenantB;
      return tenantStorage.run(
        {
          tenantId: target.id,
          tenantSlug: target.slug,
          userId: `u-${idx}`,
          userRole: 'tenant_admin',
          isExternalAgency: false,
          planTier: 'starter',
        },
        async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          const ctxAfterAwait = getTenantContext();
          assert.equal(ctxAfterAwait.tenantId, target.id);

          const rows = await withTenantTransaction(ctxAfterAwait.tenantId, async (client) => {
            const res = await client.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM leads');
            return res.rows;
          });
          assert.equal(rows.length, 1);
          assert.equal(rows[0].tenant_id, target.id);
        }
      );
    });

    await Promise.all(tasks);
  });
});
