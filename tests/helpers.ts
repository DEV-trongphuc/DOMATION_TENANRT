import type { Server } from 'node:http';
import { createDatabasePool, setDatabasePool, type DatabasePool } from '../server/core/database/db-adapter.ts';
import { runMigrations } from '../server/core/database/migrate.ts';
import { tenantRedis } from '../server/core/cache/tenant-redis.ts';
import { createApp } from '../server/app.ts';

export interface TestHarness {
  baseUrl: string;
  pool: DatabasePool;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestHarness> {
  tenantRedis.clearAllForTesting();
  const pool = createDatabasePool({ inMemory: true });
  setDatabasePool(pool);
  await runMigrations({ seedSuperAdmin: true });

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', 4096, () => resolve(srv));
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pool,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.close();
      setDatabasePool(null);
      tenantRedis.clearAllForTesting();
    },
  };
}

export async function apiRequest<T = any>(
  baseUrl: string,
  path: string,
  options?: {
    method?: string;
    token?: string;
    tenantSlug?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {
    ...(options?.headers || {}),
  };
  if (options?.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options?.tenantSlug) {
    headers['X-Tenant-Slug'] = options.tenantSlug;
  }

  const resp = await fetch(`${baseUrl}${path}`, {
    method: options?.method || 'GET',
    headers,
    body:
      options?.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body),
  });

  const json = (await resp.json().catch(() => ({}))) as T;
  return { status: resp.status, json };
}
