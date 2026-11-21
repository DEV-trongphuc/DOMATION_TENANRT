import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { DatabasePool } from '../../server/core/database/db-adapter.ts';
import {
  startMockSmtpServer,
  type MockSmtpServer,
  type CapturedSmtpMessage,
  type MockSmtpServerOptions,
  type SmtpRejectMode,
} from './helpers/mock-smtp.ts';
import {
  createSnsTestSigner,
  signSnsNotification,
  buildCanonicalSnsStringToSign,
  verifySnsEnvelopeSignature,
  buildSesNotificationMessage,
  type SnsTestSigner,
  type SnsTestSignerOptions,
  type SnsEnvelope,
  type SnsMessageType,
  type SnsSignatureVersion,
  type SesEventBuildOptions,
  type SignSnsOptions,
  type SignedSnsRequest,
} from './helpers/sns-signer.ts';
import {
  installIdeasMockFetch,
  type IdeasMockFetchController,
  type RecordedFetchRequest,
  type MockFetchRouteSpec,
} from './helpers/mock-fetch.ts';
import {
  buildSyntheticMyerpSql,
  inspectSqlDumpMetadata,
  type SyntheticMyerpOptions,
  type SyntheticMyerpResult,
  type SqlDumpMetadata,
} from './helpers/synthetic-myerp.ts';

export {
  startMockSmtpServer,
  createSnsTestSigner,
  signSnsNotification,
  buildCanonicalSnsStringToSign,
  verifySnsEnvelopeSignature,
  buildSesNotificationMessage,
  installIdeasMockFetch,
  buildSyntheticMyerpSql,
  inspectSqlDumpMetadata,
};

export type {
  MockSmtpServer,
  CapturedSmtpMessage,
  MockSmtpServerOptions,
  SmtpRejectMode,
  SnsTestSigner,
  SnsTestSignerOptions,
  SnsEnvelope,
  SnsMessageType,
  SnsSignatureVersion,
  SesEventBuildOptions,
  SignSnsOptions,
  SignedSnsRequest,
  IdeasMockFetchController,
  RecordedFetchRequest,
  MockFetchRouteSpec,
  SyntheticMyerpOptions,
  SyntheticMyerpResult,
  SqlDumpMetadata,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const LIVE_PGLITE_DATA_DIR = path.resolve(REPO_ROOT, '.autodata-pgdata');
const UNUSED_DEFAULT_PGLITE_SENTINEL = path.join(os.tmpdir(), 'e2e-ideas-unused-default-pgdata');

function normalizeForPathCompare(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isLivePgDataDirPath(candidate: string, baseDir = REPO_ROOT): boolean {
  const resolvedNorm = normalizeForPathCompare(path.resolve(baseDir, candidate));
  const liveNorm = normalizeForPathCompare(LIVE_PGLITE_DATA_DIR);
  return resolvedNorm === liveNorm || resolvedNorm.startsWith(liveNorm + path.sep);
}

export function assertNotLivePgDataDir(
  candidate: string,
  baseDir = REPO_ROOT,
  label = 'PGLITE_DATA_DIR'
): string {
  const resolved = path.resolve(baseDir, candidate);
  if (isLivePgDataDirPath(candidate, baseDir)) {
    throw new Error(
      `REFUSED_LIVE_PGLITE_DATA_DIR: ${label} must NEVER target live '${LIVE_PGLITE_DATA_DIR}'. Use os.tmpdir() or inMemory: true.`
    );
  }
  return resolved;
}

/**
 * Configure critical environment variables synchronously at module load BEFORE any
 * dynamic import of server/* initializes APP_CONFIG in server/config.ts.
 */
function configureE2eIdeasEnv(): void {
  process.env.DB_DIALECT = 'postgres';
  delete process.env.DATABASE_URL;
  delete process.env.VITEST;
  delete process.env.VNPAY_HASH_SECRET;
  process.env.NODE_ENV = 'development';
  process.env.SERVE_SPA = 'false';
  process.env.OUTBOUND_SILENT_MODE = 'false';
  process.env.TELEGRAM_SILENT_MODE = 'false';
  process.env.TELEGRAM_NOTIFY_ENABLED = 'false';
  process.env.MIGRATION_SILENT_MODE = 'false';
  process.env.ALLOW_LOCAL_WEBHOOKS = 'true';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e_ideas_tenant_jwt_secret_2026';
  process.env.PLATFORM_JWT_SECRET = process.env.PLATFORM_JWT_SECRET || 'e2e_ideas_platform_jwt_secret_2026';
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'e2e_ideas_cron_secret_2026';
  process.env.VAULT_MASTER_SECRET = process.env.VAULT_MASTER_SECRET || 'e2e_ideas_vault_master_secret_2026';
  if (!process.env.PGLITE_DATA_DIR || isLivePgDataDirPath(process.env.PGLITE_DATA_DIR)) {
    process.env.PGLITE_DATA_DIR = UNUSED_DEFAULT_PGLITE_SENTINEL;
  }
}

configureE2eIdeasEnv();

interface ServerModuleBundle {
  createDatabasePool: typeof import('../../server/core/database/db-adapter.ts').createDatabasePool;
  setDatabasePool: typeof import('../../server/core/database/db-adapter.ts').setDatabasePool;
  runMigrations: typeof import('../../server/core/database/migrate.ts').runMigrations;
  tenantRedis: typeof import('../../server/core/cache/tenant-redis.ts').tenantRedis;
  createApp: typeof import('../../server/app.ts').createApp;
  APP_CONFIG: typeof import('../../server/config.ts').APP_CONFIG;
  invalidateBillingCatalogCache: typeof import('../../server/services/billing.service.ts').invalidateBillingCatalogCache;
  invalidatePlatformOperationalConfigCache: typeof import('../../server/core/settings/platform-config.ts').invalidatePlatformOperationalConfigCache;
  invalidatePlatformAppscriptCache: typeof import('../../server/services/platform-appscript.service.ts').invalidatePlatformAppscriptCache;
  clearDomMetaGraphCacheForTesting: typeof import('../../server/services/dom-meta-report.service.ts').clearDomMetaGraphCacheForTesting;
  resetConsultationDedupCacheForTests: typeof import('../../server/routes/public.routes.ts').resetConsultationDedupCacheForTests;
  clearSnsCertCacheForTesting: typeof import('../../server/services/ses-sns.service.ts').clearSnsCertCacheForTesting;
  clearVaultKeyCacheForTesting: typeof import('../../server/core/crypto/vault.ts').clearVaultKeyCacheForTesting;
}

let cachedServerModules: ServerModuleBundle | null = null;

async function loadServerModules(): Promise<ServerModuleBundle> {
  if (cachedServerModules) return cachedServerModules;
  const [
    dbAdapter,
    migrate,
    redisMod,
    appMod,
    configMod,
    billingMod,
    platformConfigMod,
    platformAppscriptMod,
    domMetaMod,
    publicRoutesMod,
    sesSnsMod,
    vaultMod,
  ] = await Promise.all([
    import('../../server/core/database/db-adapter.ts'),
    import('../../server/core/database/migrate.ts'),
    import('../../server/core/cache/tenant-redis.ts'),
    import('../../server/app.ts'),
    import('../../server/config.ts'),
    import('../../server/services/billing.service.ts'),
    import('../../server/core/settings/platform-config.ts'),
    import('../../server/services/platform-appscript.service.ts'),
    import('../../server/services/dom-meta-report.service.ts'),
    import('../../server/routes/public.routes.ts'),
    import('../../server/services/ses-sns.service.ts'),
    import('../../server/core/crypto/vault.ts'),
  ]);

  cachedServerModules = {
    createDatabasePool: dbAdapter.createDatabasePool,
    setDatabasePool: dbAdapter.setDatabasePool,
    runMigrations: migrate.runMigrations,
    tenantRedis: redisMod.tenantRedis,
    createApp: appMod.createApp,
    APP_CONFIG: configMod.APP_CONFIG,
    invalidateBillingCatalogCache: billingMod.invalidateBillingCatalogCache,
    invalidatePlatformOperationalConfigCache: platformConfigMod.invalidatePlatformOperationalConfigCache,
    invalidatePlatformAppscriptCache: platformAppscriptMod.invalidatePlatformAppscriptCache,
    clearDomMetaGraphCacheForTesting: domMetaMod.clearDomMetaGraphCacheForTesting,
    resetConsultationDedupCacheForTests: publicRoutesMod.resetConsultationDedupCacheForTests,
    clearSnsCertCacheForTesting: sesSnsMod.clearSnsCertCacheForTesting,
    clearVaultKeyCacheForTesting: vaultMod.clearVaultKeyCacheForTesting,
  };
  return cachedServerModules;
}

function clearAllModuleCaches(mods: ServerModuleBundle): void {
  mods.tenantRedis.clearAllForTesting();
  mods.invalidateBillingCatalogCache();
  mods.invalidatePlatformOperationalConfigCache();
  mods.invalidatePlatformAppscriptCache();
  mods.clearDomMetaGraphCacheForTesting();
  mods.resetConsultationDedupCacheForTests();
  mods.clearSnsCertCacheForTesting();
  mods.clearVaultKeyCacheForTesting();
}

export interface IsolatedContextOptions {
  dbMode?: 'memory' | 'tempdir';
  inMemory?: boolean;
  dataDir?: string;
  cleanupDataDir?: boolean;
  seedSuperAdmin?: boolean;
  appPublicUrl?: string;
  cronSecret?: string;
  snsRegion?: string;
  smtpOptions?: MockSmtpServerOptions;
}

export interface ApiRawResponse<T = any> {
  status: number;
  ok: boolean;
  headers: Headers;
  rawText: string;
  json: T;
}

export interface ApiRequestOptions {
  method?: string;
  token?: string;
  tenantSlug?: string;
  auth?: { accessToken: string; tenantSlug?: string };
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export interface SeededTenantContext {
  status: number;
  tenantId: string;
  tenantSlug: string;
  accessToken: string;
  refreshToken: string;
  adminUserId: string;
  email: string;
  password: string;
  packageCode: string;
  tenant: Record<string, any>;
  user: Record<string, any>;
  raw: any;
}

export interface MasterCronResult {
  status: number;
  ok: boolean;
  locked: boolean;
  skipped: boolean;
  stats: Record<string, any>;
  json: any;
}

export interface CliSubprocessOptions {
  runner?: 'tsx' | 'node' | 'bash';
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  input?: string;
}

export interface CliSubprocessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface IsolatedE2eContext {
  baseUrl: string;
  cronSecret: string;
  dbMode: 'memory' | 'tempdir';
  dataDir: string | null;
  pool: DatabasePool;
  smtp: MockSmtpServer;
  snsSigner: SnsTestSigner;
  mockFetch: IdeasMockFetchController;
  apiRaw: <T = any>(reqPath: string, opts?: ApiRequestOptions) => Promise<ApiRawResponse<T>>;
  apiJson: <T = any>(reqPath: string, opts?: ApiRequestOptions) => Promise<T>;
  createTempDir: (prefix?: string) => string;
  createSyntheticDump: (opts?: SyntheticMyerpOptions) => SyntheticMyerpResult;
  runCli: (args: string[], opts?: CliSubprocessOptions) => Promise<CliSubprocessResult>;
  clearCaches: () => Promise<void>;
  close: () => Promise<void>;
}

function resolveBaseUrl(target: IsolatedE2eContext | string): string {
  return (typeof target === 'string' ? target : target.baseUrl).replace(/\/+$/, '');
}

export async function apiRaw<T = any>(
  target: IsolatedE2eContext | string,
  reqPath: string,
  opts: ApiRequestOptions = {}
): Promise<ApiRawResponse<T>> {
  const baseUrl = resolveBaseUrl(target);
  const method = (opts.method || (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const url = new URL(reqPath.startsWith('http') ? reqPath : `${baseUrl}${reqPath.startsWith('/') ? '' : '/'}${reqPath}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = {};
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers[k] = v;
    }
  }

  const token = opts.token ?? opts.auth?.accessToken;
  if (token && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const tenantSlug = opts.tenantSlug ?? opts.auth?.tenantSlug;
  if (tenantSlug && !Object.keys(headers).some((k) => k.toLowerCase() === 'x-tenant-slug')) {
    headers['X-Tenant-Slug'] = tenantSlug;
  }

  let bodyToSend: string | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') {
      bodyToSend = opts.body;
    } else {
      bodyToSend = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: bodyToSend,
  });

  const rawText = await res.text();
  let json: any = null;
  if (rawText) {
    try {
      json = JSON.parse(rawText);
    } catch {
      json = null;
    }
  }

  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    rawText,
    json: json as T,
  };
}

export async function apiJson<T = any>(
  target: IsolatedE2eContext | string,
  reqPath: string,
  opts: ApiRequestOptions = {}
): Promise<T> {
  const res = await apiRaw<T>(target, reqPath, opts);
  if (!res.ok) {
    const method = (opts.method || (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase();
    throw new Error(`HTTP ${res.status} ${method} ${reqPath}: ${res.rawText}`);
  }
  return res.json;
}

export async function createIsolatedContext(options: IsolatedContextOptions = {}): Promise<IsolatedE2eContext> {
  configureE2eIdeasEnv();

  const savedEnvKeys = ['APP_PUBLIC_URL', 'PGLITE_DATA_DIR', 'CRON_SECRET'] as const;
  const previousEnv: Partial<Record<(typeof savedEnvKeys)[number], string | undefined>> = {};
  for (const k of savedEnvKeys) {
    previousEnv[k] = process.env[k];
  }

  const useTempDir =
    options.dataDir !== undefined ||
    options.dbMode === 'tempdir' ||
    options.inMemory === false;
  const dbMode: 'memory' | 'tempdir' = useTempDir ? 'tempdir' : 'memory';

  let dataDir: string | null = null;
  let ownsDataDir = false;
  if (dbMode === 'tempdir') {
    if (options.dataDir) {
      dataDir = assertNotLivePgDataDir(options.dataDir, process.cwd(), 'options.dataDir');
      fs.mkdirSync(dataDir, { recursive: true });
      ownsDataDir = options.cleanupDataDir ?? false;
    } else {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ideas-pg-'));
      ownsDataDir = options.cleanupDataDir ?? true;
    }
    process.env.PGLITE_DATA_DIR = dataDir;
  } else {
    process.env.PGLITE_DATA_DIR = UNUSED_DEFAULT_PGLITE_SENTINEL;
  }

  if (options.appPublicUrl !== undefined) {
    process.env.APP_PUBLIC_URL = options.appPublicUrl;
  }
  if (options.cronSecret !== undefined) {
    process.env.CRON_SECRET = options.cronSecret;
  }

  const mods = await loadServerModules();
  clearAllModuleCaches(mods);

  const previousAppConfigCronSecret = mods.APP_CONFIG.cronSecret;
  if (options.cronSecret !== undefined) {
    (mods.APP_CONFIG as { cronSecret: string }).cronSecret = options.cronSecret;
  }

  const pool =
    dbMode === 'tempdir' && dataDir
      ? mods.createDatabasePool({ inMemory: false, dataDir })
      : mods.createDatabasePool({ inMemory: true });

  const ownedTempDirs: string[] = [];
  const ownedDumps: SyntheticMyerpResult[] = [];
  let smtp: MockSmtpServer | null = null;
  let mockFetch: IdeasMockFetchController | null = null;
  let server: http.Server | null = null;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  try {
    mods.setDatabasePool(pool);
    await mods.runMigrations({ seedSuperAdmin: options.seedSuperAdmin ?? true });

    smtp = await startMockSmtpServer(options.smtpOptions);
    const snsSigner = createSnsTestSigner({ region: options.snsRegion || 'ap-southeast-2' });
    mockFetch = installIdeasMockFetch();
    mockFetch.registerSnsCertRoute(snsSigner);

    const app = mods.createApp();
    server = await new Promise<http.Server>((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', 4096, () => resolve(srv));
      srv.once('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve ephemeral HTTP server port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const resolvedCronSecret =
      options.cronSecret || mods.APP_CONFIG.cronSecret || mods.APP_CONFIG.platformJwtSecret;

    const createTempDir = (prefix = 'e2e-ideas-tmp-'): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      ownedTempDirs.push(dir);
      return dir;
    };

    const createSyntheticDump = (dumpOpts: SyntheticMyerpOptions = {}): SyntheticMyerpResult => {
      const res = buildSyntheticMyerpSql(dumpOpts);
      ownedDumps.push(res);
      return res;
    };

    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (closed) return;
        closed = true;

        if (server) {
          (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          await new Promise<void>((resolve) => {
            server!.close(() => resolve());
          });
          server = null;
        }

        if (smtp) {
          await smtp.close().catch(() => {});
        }

        if (mockFetch) {
          mockFetch.restore();
        }

        await pool.close().catch(() => {});
        mods.setDatabasePool(null);
        clearAllModuleCaches(mods);

        if (options.cronSecret !== undefined) {
          (mods.APP_CONFIG as { cronSecret: string }).cronSecret = previousAppConfigCronSecret;
        }
        for (const k of savedEnvKeys) {
          if (previousEnv[k] === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = previousEnv[k];
          }
        }

        for (const dump of ownedDumps) {
          dump.cleanup();
        }
        for (const tmpDir of ownedTempDirs) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {}
        }
        if (ownsDataDir && dataDir) {
          try {
            fs.rmSync(dataDir, { recursive: true, force: true });
          } catch {}
        }
      })();
      return closePromise;
    };

    const ctx: IsolatedE2eContext = {
      baseUrl,
      cronSecret: resolvedCronSecret,
      dbMode,
      dataDir,
      pool,
      smtp,
      snsSigner,
      mockFetch,
      apiRaw: <T = any>(reqPath: string, opts?: ApiRequestOptions) => apiRaw<T>(baseUrl, reqPath, opts),
      apiJson: <T = any>(reqPath: string, opts?: ApiRequestOptions) => apiJson<T>(baseUrl, reqPath, opts),
      createTempDir,
      createSyntheticDump,
      runCli: (args: string[], opts?: CliSubprocessOptions) =>
        runCliSubprocess(args, {
          ...opts,
          env: {
            ...(dataDir ? { PGLITE_DATA_DIR: dataDir } : {}),
            ...(opts?.env || {}),
          },
        }),
      clearCaches: async () => {
        clearAllModuleCaches(mods);
      },
      close,
    };

    return ctx;
  } catch (err) {
    if (server) {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve())).catch(() => {});
    }
    if (smtp) await smtp.close().catch(() => {});
    if (mockFetch) mockFetch.restore();
    await pool.close().catch(() => {});
    mods.setDatabasePool(null);
    clearAllModuleCaches(mods);
    if (options.cronSecret !== undefined) {
      (mods.APP_CONFIG as { cronSecret: string }).cronSecret = previousAppConfigCronSecret;
    }
    for (const k of savedEnvKeys) {
      if (previousEnv[k] === undefined) delete process.env[k];
      else process.env[k] = previousEnv[k];
    }
    if (ownsDataDir && dataDir) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    throw err;
  }
}

export async function loginSuperAdmin(
  target: IsolatedE2eContext | string,
  credentials?: { email?: string; password?: string }
): Promise<{
  status: number;
  ok: boolean;
  token: string;
  admin: Record<string, any>;
  json: any;
}> {
  const mods = await loadServerModules();
  const email = credentials?.email || mods.APP_CONFIG.superadminEmail || 'ops-admin@autodata.vn';
  const password = credentials?.password || mods.APP_CONFIG.superadminPassword || 'SuperAdminMasterPassword999!';
  const res = await apiRaw(target, '/api/v1/admin/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  return {
    status: res.status,
    ok: res.ok,
    token: res.json?.data?.access_token || '',
    admin: res.json?.data?.admin || {},
    json: res.json,
  };
}

let recipientSeq = 0;

export function makeTestRecipient(label = 'e2e'): string {
  recipientSeq += 1;
  const sanitized = String(label || 'e2e')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'e2e';
  return `${sanitized}-${recipientSeq}@test-sink.domation.local`;
}

export function assertTestRecipientsOnly(addresses: string[]): void {
  const allowedSuffix = '@test-sink.domation.local';
  const bareTestEmailRe = /^[^\s@<>,;"\r\n]+@test-sink\.domation\.local$/i;
  const angledTestEmailRe =
    /^(?:"[^"\r\n<>]*"|[^<>@,;"\r\n]*)[ \t]*<([^\s@<>,;"\r\n]+@test-sink\.domation\.local)>$/i;
  for (const raw of addresses) {
    const trimmed = String(raw || '').trim();
    const hasAngleBracket = trimmed.includes('<') || trimmed.includes('>');
    const isValid =
      trimmed.length > 0 &&
      !/[\r\n]/.test(trimmed) &&
      (hasAngleBracket ? angledTestEmailRe.test(trimmed) : bareTestEmailRe.test(trimmed));
    if (!isValid) {
      throw new Error(
        `UNSAFE_TEST_RECIPIENT: '${raw}' is not an isolated '*${allowedSuffix}' address.`
      );
    }
  }
}

export async function seedIdeasTenant(
  ctx: IsolatedE2eContext,
  options: {
    slug?: string;
    companyName?: string;
    packageCode?: string;
    industry?: string;
    email?: string;
    password?: string;
    phone?: string;
    activateBillingGrant?: boolean;
    configureLoopbackSmtp?: boolean;
    smtpVia?: 'aws_ses' | 'smtp';
    fromEmail?: string;
    customSettings?: Record<string, unknown>;
  } = {}
): Promise<SeededTenantContext> {
  const slug = options.slug ?? 'ideas';
  const packageCode = options.packageCode ?? 'growth_combo';
  const industry = options.industry ?? 'education';
  const email = options.email ?? makeTestRecipient(`${slug}-admin`);
  const password = options.password ?? 'IdeasE2ePass#2026';
  const phone = options.phone ?? '0909111222';
  const companyName = options.companyName ?? 'IDEAS Institute';

  const regRes = await ctx.apiRaw('/api/v1/auth/register-tenant', {
    method: 'POST',
    body: {
      company_name: companyName,
      tenant_slug: slug,
      admin_name: `${slug.toUpperCase()} Admin`,
      work_email: email,
      phone,
      password,
      industry,
      package_code: packageCode,
      seed_demo_leads: false,
      ...(options.customSettings ? { custom_settings: options.customSettings } : {}),
    },
  });

  if (!regRes.ok) {
    throw new Error(`seedIdeasTenant(${slug}) failed HTTP ${regRes.status}: ${regRes.rawText}`);
  }

  const data = regRes.json?.data || {};
  const tenantId: string = data.tenant?.id;
  const accessToken: string = data.access_token;
  const refreshToken: string = data.refresh_token || '';
  const adminUserId: string = data.user?.id || '';

  if (options.activateBillingGrant !== false && tenantId) {
    const sa = await loginSuperAdmin(ctx);
    if (!sa.ok || !sa.token) {
      throw new Error(`seedIdeasTenant superAdmin login failed (${sa.status}): ${JSON.stringify(sa.json)}`);
    }
    await ctx.apiJson(`/api/v1/admin/tenants/${tenantId}/billing-grant`, {
      method: 'POST',
      token: sa.token,
      body: {
        plan_code: packageCode,
        extend_months: 12,
        note: 'E2E isolated tenant activation',
      },
    });
  }

  if (options.configureLoopbackSmtp) {
    const vaultType = options.smtpVia ?? 'aws_ses';
    const fromEmail = options.fromEmail ?? 'noreply@test-sink.domation.local';
    await ctx.apiJson(`/api/v1/integrations/vault/${vaultType}`, {
      method: 'PUT',
      token: accessToken,
      tenantSlug: slug,
      body: {
        smtp_host: ctx.smtp.host,
        smtp_port: ctx.smtp.port,
        smtp_user: 'e2e-ses-user',
        smtp_pass: 'e2e-ses-pass',
        from_email: fromEmail,
        from_name: companyName,
        region: 'ap-southeast-2',
      },
    });
    await ctx.apiJson('/api/v1/integrations/email/config', {
      method: 'POST',
      token: accessToken,
      tenantSlug: slug,
      body: {
        email_provider: vaultType === 'smtp' ? 'smtp' : 'ses',
        ses_sender_email: fromEmail,
        ses_sender_name: companyName,
      },
    });
  }

  const meRes = await ctx.apiJson<{ success: boolean; data: { tenant: Record<string, any>; user: Record<string, any> } }>(
    '/api/v1/auth/me',
    { token: accessToken, tenantSlug: slug }
  );

  return {
    status: regRes.status,
    tenantId,
    tenantSlug: slug,
    accessToken,
    refreshToken,
    adminUserId,
    email,
    password,
    packageCode,
    tenant: meRes.data?.tenant || data.tenant,
    user: meRes.data?.user || data.user,
    raw: regRes.json,
  };
}

export async function seedSiblingTenant(
  ctx: IsolatedE2eContext,
  slug: string,
  options: {
    companyName?: string;
    packageCode?: string;
    industry?: string;
    email?: string;
    password?: string;
    phone?: string;
    activateBillingGrant?: boolean;
    customSettings?: Record<string, unknown>;
  } = {}
): Promise<SeededTenantContext> {
  return seedIdeasTenant(ctx, {
    slug,
    companyName: options.companyName ?? `Sibling ${slug}`,
    packageCode: options.packageCode ?? 'autodata_crm',
    industry: options.industry ?? 'general',
    email: options.email ?? makeTestRecipient(`${slug}-admin`),
    password: options.password ?? 'SiblingE2ePass#2026',
    phone: options.phone ?? '0909222333',
    activateBillingGrant: options.activateBillingGrant ?? true,
    configureLoopbackSmtp: false,
    customSettings: options.customSettings,
  });
}

export async function impersonateTenant(
  target: IsolatedE2eContext | string,
  superAdminToken: string,
  tenantId: string,
  durationMinutes = 15
): Promise<{
  status: number;
  ok: boolean;
  accessToken: string;
  tenantSlug: string;
  impersonatedBy: string;
  expiresIn: number;
  json: any;
}> {
  const res = await apiRaw(target, `/api/v1/admin/tenants/${tenantId}/impersonate`, {
    method: 'POST',
    token: superAdminToken,
    body: { duration_minutes: durationMinutes },
  });
  return {
    status: res.status,
    ok: res.ok,
    accessToken: res.json?.data?.access_token || '',
    tenantSlug: res.json?.data?.tenant_slug || '',
    impersonatedBy: res.json?.data?.impersonated_by || '',
    expiresIn: Number(res.json?.data?.expires_in_seconds || res.json?.data?.expires_in || 0),
    json: res.json,
  };
}

export async function triggerMasterCron(
  target: IsolatedE2eContext | string,
  options: {
    secret?: string;
    subroutines?: string[];
    tenantId?: string;
    method?: 'POST' | 'GET';
  } = {}
): Promise<MasterCronResult> {
  const mods = await loadServerModules();
  const secret =
    options.secret ??
    (typeof target === 'object' ? target.cronSecret : undefined) ??
    mods.APP_CONFIG.cronSecret ??
    mods.APP_CONFIG.platformJwtSecret;
  const method = options.method ?? 'POST';
  const query: Record<string, string | undefined> = {};
  if (options.subroutines && options.subroutines.length > 0) {
    query.subroutines = options.subroutines.join(',');
  }
  if (options.tenantId) {
    query.tenant_id = options.tenantId;
  }

  const res = await apiRaw(target, '/api/v1/operations/cron/master', {
    method,
    headers: secret ? { 'X-Cron-Secret': secret } : {},
    query,
    body: method === 'POST' ? (options.subroutines || options.tenantId ? { subroutines: options.subroutines, tenant_id: options.tenantId } : {}) : undefined,
  });

  const data = res.json?.data || {};
  return {
    status: res.status,
    ok: res.ok,
    locked: Boolean(data.locked),
    skipped: Boolean(data.skipped),
    stats: data.stats || data,
    json: res.json,
  };
}

function resolveTsxCliPath(): string {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.js'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`tsx CLI entrypoint not found in node_modules/tsx/dist/`);
  }
  return found;
}

export async function runCliSubprocess(
  args: string[],
  options: CliSubprocessOptions = {}
): Promise<CliSubprocessResult> {
  const runner = options.runner || 'tsx';
  const cwd = options.cwd || REPO_ROOT;
  const timeoutMs = options.timeoutMs ?? 60_000;

  if (
    options.env &&
    'PGLITE_DATA_DIR' in options.env &&
    options.env.PGLITE_DATA_DIR &&
    options.env.PGLITE_DATA_DIR.trim() !== ''
  ) {
    assertNotLivePgDataDir(options.env.PGLITE_DATA_DIR, cwd, 'runCliSubprocess env.PGLITE_DATA_DIR');
  }

  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  delete mergedEnv.DATABASE_URL;
  delete mergedEnv.VITEST;
  if (!mergedEnv.PGLITE_DATA_DIR || isLivePgDataDirPath(mergedEnv.PGLITE_DATA_DIR, cwd)) {
    mergedEnv.PGLITE_DATA_DIR = UNUSED_DEFAULT_PGLITE_SENTINEL;
  }
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (v === undefined) {
        delete mergedEnv[k];
      } else {
        mergedEnv[k] = v;
      }
    }
  }
  if (!mergedEnv.PGLITE_DATA_DIR || !mergedEnv.PGLITE_DATA_DIR.trim()) {
    mergedEnv.PGLITE_DATA_DIR = UNUSED_DEFAULT_PGLITE_SENTINEL;
  }
  assertNotLivePgDataDir(mergedEnv.PGLITE_DATA_DIR, cwd, 'resolved subprocess PGLITE_DATA_DIR');

  let command: string;
  let spawnArgs: string[];
  if (runner === 'tsx') {
    command = process.execPath;
    spawnArgs = [resolveTsxCliPath(), ...args];
  } else if (runner === 'node') {
    command = process.execPath;
    spawnArgs = [...args];
  } else {
    command = 'bash';
    spawnArgs = [...args];
  }

  const started = Date.now();
  return new Promise<CliSubprocessResult>((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
      cwd,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
      });
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}
