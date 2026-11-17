import { getDatabasePool, type DatabasePool, type DbClient } from './db-adapter.ts';
import { getTenantContext } from '../context/tenant-context.ts';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const poolAppRoleSupportCache = new WeakMap<DatabasePool, boolean>();

/**
 * Layer 4 & Layer 5 Per-Transaction Tenant Session Binding:
 * 1. Verifies `autodata_app` (NOSUPERUSER NOBYPASSRLS) capability once per pool and caches via WeakMap.
 * 2. Combines `BEGIN`, `SET LOCAL search_path`, `SET LOCAL ROLE autodata_app`, and
 *    `set_config('app.current_tenant_id', uuid, true)` into a single SQL roundtrip via `client.exec(...)`
 *    (saving 5 TCP roundtrips per transaction on external PostgreSQL / PgBouncer).
 * 3. Because all session mutations are strictly transaction-local (`SET LOCAL` / `is_local = true`),
 *    PostgreSQL automatically reverts role, search_path, and `app.current_tenant_id` upon `COMMIT`/`ROLLBACK`.
 *    `RESET ALL` is executed only if `COMMIT`/`ROLLBACK` fails cleanly, preserving PgBouncer transaction-mode compatibility.
 * 4. Under MariaDB 10.6: sets session variable `@app_current_tenant_id` and starts a standard ACID transaction.
 */
async function resolveAppRoleSupport(pool: DatabasePool, client: DbClient): Promise<boolean> {
  let hasRole = poolAppRoleSupportCache.get(pool);
  if (hasRole === undefined) {
    const res = await client.query<{ ok: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autodata_app')
               AND pg_has_role(current_user, 'autodata_app', 'MEMBER')) AS ok`
    );
    hasRole = Boolean(res.rows[0]?.ok);
    poolAppRoleSupportCache.set(pool, hasRole);
  }
  return hasRole;
}

async function execBatchSql(client: DbClient, sql: string): Promise<void> {
  if (client.exec) {
    await client.exec(sql);
  } else {
    await client.query(sql);
  }
}

export async function withTenantTransaction<T>(
  tenantId: string | undefined,
  operation: (client: DbClient) => Promise<T>
): Promise<T> {
  const effectiveTenantId = tenantId || getTenantContext().tenantId;
  if (!effectiveTenantId || !UUID_REGEX.test(effectiveTenantId)) {
    throw new Error('INVALID_TENANT_UUID: Cannot open tenant transaction without valid UUID');
  }

  const pool = getDatabasePool();
  const client = await pool.connect();
  let txCleanlyClosed = false;
  try {
    if (client.dialect === 'mariadb') {
      await client.query('START TRANSACTION');
      await client.query(`SET @app_current_tenant_id = '${effectiveTenantId}'`);
      const result = await operation(client);
      await client.query('COMMIT');
      txCleanlyClosed = true;
      return result;
    } else {
      const hasRole = await resolveAppRoleSupport(pool, client);
      await execBatchSql(
        client,
        `BEGIN; SET LOCAL search_path TO public;${hasRole ? ' SET LOCAL ROLE autodata_app;' : ''} SELECT set_config('app.current_tenant_id', '${effectiveTenantId}', true);`
      );
      const result = await operation(client);
      await client.query('COMMIT');
      txCleanlyClosed = true;
      return result;
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
      txCleanlyClosed = true;
    } catch {
      // Ignore rollback errors if connection dropped
    }
    throw err;
  } finally {
    if (!txCleanlyClosed) {
      try {
        if (client.dialect === 'mariadb') {
          await client.query('SET @app_current_tenant_id = NULL');
        } else {
          await execBatchSql(client, 'RESET ALL; SET search_path TO public;');
        }
      } catch {
        // Ignore reset errors if connection already closed
      }
    }
    client.release();
  }
}

/**
 * Executes a query under `autodata_app` (non-superuser, RLS-enforced) WITHOUT setting
 * `app.current_tenant_id`. Used in security verification to prove Lemma 1 (returns 0 rows).
 */
export async function withUnscopedRlsCheck<T>(operation: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  let txCleanlyClosed = false;
  try {
    if (client.dialect === 'mariadb') {
      await client.query('START TRANSACTION');
      await client.query("SET @app_current_tenant_id = ''");
      const result = await operation(client);
      await client.query('COMMIT');
      txCleanlyClosed = true;
      return result;
    } else {
      const hasRole = await resolveAppRoleSupport(pool, client);
      await execBatchSql(
        client,
        `BEGIN; SET LOCAL search_path TO public;${hasRole ? ' SET LOCAL ROLE autodata_app;' : ''} SELECT set_config('app.current_tenant_id', '', true);`
      );
      const result = await operation(client);
      await client.query('COMMIT');
      txCleanlyClosed = true;
      return result;
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
      txCleanlyClosed = true;
    } catch {
      // Ignore
    }
    throw err;
  } finally {
    if (!txCleanlyClosed) {
      try {
        if (client.dialect === 'mariadb') {
          await client.query('SET @app_current_tenant_id = NULL');
        } else {
          await execBatchSql(client, 'RESET ALL; SET search_path TO public;');
        }
      } catch {
        // Ignore
      }
    }
    client.release();
  }
}

/**
 * Audited Platform Privilege Transaction:
 * Strictly reserved for:
 * 1. Pre-auth ingress resolution (mapping slug/domain/webhook-token -> tenant_id)
 * 2. Segregated `platform_superadmins` operations (`/api/v1/admin/*`)
 * 3. Background cron discovering active integration tenants before entering `withTenantTransaction`
 */
export async function withSystemPrivilege<T>(operation: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getDatabasePool();
  const client = await pool.connect();
  let txCleanlyClosed = false;
  try {
    if (client.dialect === 'mariadb') {
      await client.query('START TRANSACTION');
      const result = await operation(client);
      await client.query('COMMIT');
      txCleanlyClosed = true;
      return result;
    } else {
      await execBatchSql(client, 'BEGIN; SET LOCAL search_path TO public;');
      const result = await operation(client);
      await client.query('COMMIT');
      txCleanlyClosed = true;
      return result;
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
      txCleanlyClosed = true;
    } catch {
      // Ignore
    }
    throw err;
  } finally {
    if (!txCleanlyClosed) {
      try {
        if (client.dialect === 'mariadb') {
          // No special reset needed
        } else {
          await execBatchSql(client, 'RESET ALL; SET search_path TO public;');
        }
      } catch {
        // Ignore
      }
    }
    client.release();
  }
}
