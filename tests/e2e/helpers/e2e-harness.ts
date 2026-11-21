import crypto from 'node:crypto';
import type { Server } from 'node:http';

// MUST configure environment BEFORE importing server/config.ts or server/app.ts
// so APP_CONFIG and outbound/email guards read deterministic E2E settings.
process.env.DB_DIALECT = 'postgres';
delete process.env.DATABASE_URL;
process.env.OUTBOUND_SILENT_MODE = 'false';
process.env.TELEGRAM_SILENT_MODE = 'false';
process.env.TELEGRAM_NOTIFY_ENABLED = 'true';
process.env.MIGRATION_SILENT_MODE = 'false';
delete process.env.VITEST;
process.env.NODE_ENV = 'development';
process.env.BILLING_MANUAL_WEBHOOK_SECRET =
  process.env.BILLING_MANUAL_WEBHOOK_SECRET || 'e2e_manual_webhook_secret_2026';
process.env.PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY || 'e2e_payos_checksum_key_2026';
process.env.SEPAY_WEBHOOK_SECRET = process.env.SEPAY_WEBHOOK_SECRET || 'e2e_sepay_webhook_secret_2026';
delete process.env.VNPAY_HASH_SECRET; // Keep VNPay unconfigured to test 503 GATEWAY_NOT_CONFIGURED

export interface E2eServerHarness {
  baseUrl: string;
  pool: any;
  close: () => Promise<void>;
}

export async function startE2eServer(): Promise<E2eServerHarness> {
  const [
    { createDatabasePool, setDatabasePool },
    { runMigrations },
    { tenantRedis },
    { createApp },
  ] = await Promise.all([
    import('../../../server/core/database/db-adapter.ts'),
    import('../../../server/core/database/migrate.ts'),
    import('../../../server/core/cache/tenant-redis.ts'),
    import('../../../server/app.ts'),
  ]);

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
): Promise<{ status: number; json: T; rawText: string; headers: Headers }> {
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

  const rawText = await resp.text();
  let json = {} as T;
  try {
    json = rawText ? (JSON.parse(rawText) as T) : ({} as T);
  } catch {
    json = {} as T;
  }
  return { status: resp.status, json, rawText, headers: resp.headers };
}

export async function loginSuperAdmin(
  baseUrl: string,
  credentials?: { email?: string; password?: string }
): Promise<{ token: string; status: number; json: any }> {
  const { APP_CONFIG } = await import('../../../server/config.ts');
  const res = await apiRequest(baseUrl, '/api/v1/admin/auth/login', {
    method: 'POST',
    body: {
      email: credentials?.email || APP_CONFIG.superadminEmail || 'ops-admin@autodata.vn',
      password: credentials?.password || APP_CONFIG.superadminPassword || 'SuperAdminMasterPassword999!',
    },
  });
  return {
    token: res.json?.data?.access_token || '',
    status: res.status,
    json: res.json,
  };
}

export async function registerTenant(
  baseUrl: string,
  input: {
    company_name: string;
    tenant_slug: string;
    admin_name?: string;
    work_email?: string;
    phone?: string;
    password?: string;
    industry?: string;
    package_code?: string;
    seed_demo_leads?: boolean;
    custom_settings?: Record<string, unknown>;
    initial_sales?: Array<Record<string, unknown>>;
  }
): Promise<{
  status: number;
  json: any;
  rawText: string;
  tenantId: string;
  tenantSlug: string;
  adminToken: string;
  adminUserId: string;
}> {
  const cleanSlug = input.tenant_slug.toLowerCase();
  const res = await apiRequest(baseUrl, '/api/v1/auth/register', {
    method: 'POST',
    body: {
      company_name: input.company_name,
      tenant_slug: cleanSlug,
      admin_name: input.admin_name || `${input.company_name} Admin`,
      work_email: input.work_email || `admin@${cleanSlug}.vn`,
      phone: input.phone || '0909111222',
      password: input.password || 'SecurePassword123!',
      industry: input.industry || 'general',
      package_code: input.package_code,
      seed_demo_leads: input.seed_demo_leads ?? false,
      custom_settings: input.custom_settings,
      initial_sales: input.initial_sales,
    },
  });
  return {
    status: res.status,
    json: res.json,
    rawText: res.rawText,
    tenantId: res.json?.data?.tenant?.id || '',
    tenantSlug: res.json?.data?.tenant?.slug || cleanSlug,
    adminToken: res.json?.data?.access_token || '',
    adminUserId: res.json?.data?.user?.id || '',
  };
}

export async function triggerMasterCronHttp(
  baseUrl: string,
  options?: { secret?: string; subroutines?: string[]; tenantId?: string }
): Promise<{ status: number; json: any }> {
  const { APP_CONFIG } = await import('../../../server/config.ts');
  const cronSecret = options?.secret ?? (APP_CONFIG.cronSecret || APP_CONFIG.platformJwtSecret);
  const res = await apiRequest(baseUrl, '/api/v1/operations/cron/master', {
    method: 'POST',
    headers: {
      'X-Cron-Secret': cronSecret,
    },
    body: options?.subroutines || options?.tenantId
      ? { subroutines: options?.subroutines, tenant_id: options?.tenantId }
      : {},
  });
  return { status: res.status, json: res.json };
}

export function signWebhookHmac(rawBody: string | Buffer, signingSecret: string): string {
  const hex = crypto.createHmac('sha256', signingSecret).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

export function signPayosWebhook(dataObj: Record<string, unknown>, checksumKey: string): string {
  const sortedData = Object.keys(dataObj)
    .sort()
    .map((k) => `${k}=${dataObj[k] ?? ''}`)
    .join('&');
  return crypto.createHmac('sha256', checksumKey).update(sortedData).digest('hex');
}
