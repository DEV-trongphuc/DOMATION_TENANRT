import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import puppeteer, {
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type HTTPRequest,
  type HTTPResponse,
  type Page,
} from 'puppeteer';

const execFileAsync = promisify(execFile);

export interface BrowserAuthInput {
  accessToken: string;
  tenantSlug: string;
  user: {
    id: string | number;
    email?: string;
    username?: string;
    full_name?: string;
    name?: string;
    role: string;
    tenant_id?: string | number;
    tenant_slug?: string;
    avatar_url?: string | null;
    [key: string]: unknown;
  };
  packageCode?: string;
  refreshToken?: string;
}

export interface RuntimeHttpError {
  status: number;
  url: string;
  method: string;
}

export interface RuntimeDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  http5xxErrors: RuntimeHttpError[];
  requestFailedErrors: string[];
}

export interface ErpBrowserHarness {
  readonly frontendBaseUrl: string;
  readonly backendBaseUrl: string;
  readonly executablePath: string;
  readonly browser: Browser;
  openAuthenticatedPage: (auth: BrowserAuthInput, initialPath?: string) => Promise<Page>;
  collectRuntimeDiagnostics: (page: Page) => RuntimeDiagnostics;
  closePage: (page: Page) => Promise<void>;
  teardown: () => Promise<void>;
}

export function resolveBrowserExecutable(): string {
  const envPath = process.env.CHROME_PATH?.trim();
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`CHROME_PATH does not exist: "${envPath}"`);
    }
    return envPath;
  }

  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim(),
    process.env.CHROME_BIN?.trim(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter((p): p is string => Boolean(p));

  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      return exe;
    }
  }

  throw new Error(
    `No Chrome or Edge executable found. Checked CHROME_PATH, PUPPETEER_EXECUTABLE_PATH, CHROME_BIN, and: ${candidates.join(', ')}`
  );
}

async function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function killViteProcessTree(proc: ChildProcess): Promise<void> {
  proc.stdout?.removeAllListeners();
  proc.stderr?.removeAllListeners();
  proc.stdout?.destroy();
  proc.stderr?.destroy();

  if (proc.exitCode !== null || proc.signalCode !== null) {
    proc.unref();
    return;
  }

  if (process.platform === 'win32' && proc.pid) {
    await execFileAsync('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
      windowsHide: true,
    }).catch(() => {});
  } else {
    proc.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => proc.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }
  proc.unref();
}

async function waitForViteReady(
  frontendBaseUrl: string,
  viteProc: ChildProcess,
  getLogs: () => string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exitedError: Error | null = null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exitedError = new Error(
      `DOMATION_ERP_FULL Vite exited prematurely (code=${code}, signal=${signal}). Logs:\n${getLogs()}`
    );
  };
  viteProc.once('exit', onExit);

  try {
    while (Date.now() < deadline) {
      if (exitedError) throw exitedError;
      try {
        const res = await fetch(`${frontendBaseUrl}/`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok || res.status < 500) {
          return;
        }
      } catch {
        // Vite still starting
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `Timed out waiting ${timeoutMs}ms for DOMATION_ERP_FULL Vite at ${frontendBaseUrl}. Logs:\n${getLogs()}`
    );
  } finally {
    viteProc.removeListener('exit', onExit);
  }
}

export async function startErpBrowserHarness(backendBaseUrl: string): Promise<ErpBrowserHarness> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const defaultErpRoot = path.resolve(__dirname, '..', '..', '..', 'DOMATION_ERP_FULL');
  const erpRoot = process.env.DOMATION_ERP_DIR ? path.resolve(process.env.DOMATION_ERP_DIR) : defaultErpRoot;
  const viteBin = path.join(erpRoot, 'node_modules', 'vite', 'bin', 'vite.js');

  if (!fs.existsSync(erpRoot)) {
    throw new Error(`DOMATION_ERP_FULL directory not found: "${erpRoot}"`);
  }
  if (!fs.existsSync(viteBin)) {
    throw new Error(`DOMATION_ERP_FULL Vite binary not found: "${viteBin}"`);
  }

  const executablePath = resolveBrowserExecutable();
  const normalizedBackend = backendBaseUrl.replace(/\/+$/, '');
  const vitePort = await findFreeLoopbackPort();
  const frontendBaseUrl = `http://127.0.0.1:${vitePort}`;

  const logChunks: string[] = [];
  let logBytes = 0;
  const appendLog = (chunk: Buffer | string) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    logChunks.push(str);
    logBytes += str.length;
    while (logBytes > 8192 && logChunks.length > 1) {
      const shifted = logChunks.shift()!;
      logBytes -= shifted.length;
    }
  };

  const viteProc = spawn(
    process.execPath,
    [viteBin, '--port', String(vitePort), '--host', '127.0.0.1', '--strictPort'],
    {
      cwd: erpRoot,
      env: {
        ...process.env,
        VITE_API_ORIGIN: normalizedBackend,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  viteProc.stdout?.on('data', appendLog);
  viteProc.stderr?.on('data', appendLog);

  let browser: Browser | null = null;

  try {
    await waitForViteReady(frontendBaseUrl, viteProc, () => logChunks.join(''));

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  } catch (err) {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await killViteProcessTree(viteProc).catch(() => {});
    throw err;
  }

  const openContexts = new Map<Page, BrowserContext>();
  const diagnosticsMap = new WeakMap<Page, RuntimeDiagnostics>();

  const ensureDiagnosticsAttached = (page: Page): RuntimeDiagnostics => {
    const existing = diagnosticsMap.get(page);
    if (existing) return existing;

    const state: RuntimeDiagnostics = {
      consoleErrors: [],
      pageErrors: [],
      http5xxErrors: [],
      requestFailedErrors: [],
    };
    diagnosticsMap.set(page, state);

    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        state.consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err: unknown) => {
      state.pageErrors.push(err instanceof Error ? err.stack || err.message : String(err));
    });
    page.on('response', (res: HTTPResponse) => {
      const status = res.status();
      const url = res.url();
      if (status >= 500 && (url.includes('/api/') || url.includes('/backend/'))) {
        state.http5xxErrors.push({
          status,
          url,
          method: res.request().method(),
        });
      }
    });
    page.on('requestfailed', (req: HTTPRequest) => {
      const url = req.url();
      const errText = req.failure()?.errorText || 'unknown';
      if (errText !== 'net::ERR_ABORTED' && (url.includes('/api/') || url.includes('/backend/'))) {
        state.requestFailedErrors.push(`${req.method()} ${url}: ${errText}`);
      }
    });

    return state;
  };

  const openAuthenticatedPage = async (
    auth: BrowserAuthInput,
    initialPath = '/marketing'
  ): Promise<Page> => {
    if (!auth.accessToken) {
      throw new Error('openAuthenticatedPage requires auth.accessToken');
    }
    if (!auth.tenantSlug) {
      throw new Error('openAuthenticatedPage requires auth.tenantSlug');
    }
    if (auth.user?.id === undefined || auth.user?.id === null || auth.user?.id === '') {
      throw new Error('openAuthenticatedPage requires auth.user.id so TenantConfigContext hydrates');
    }

    const tenantSlug = auth.tenantSlug.trim().toLowerCase();
    const roleRaw = String(auth.user.role || 'admin').toLowerCase();
    const normalizedRole =
      roleRaw === 'sales'
        ? 'sale'
        : roleRaw === 'super_admin'
          ? 'superadmin'
          : roleRaw === 'tenant_admin'
            ? 'admin'
            : roleRaw;

    const normalizedUser = {
      ...auth.user,
      role: normalizedRole,
      username: auth.user.username || auth.user.email || '',
      name: auth.user.full_name || auth.user.name || auth.user.email || '',
      tenant_slug: tenantSlug,
      ...(auth.packageCode
        ? {
            package_code: auth.packageCode.toLowerCase(),
            plan_tier: auth.packageCode.toLowerCase(),
          }
        : {}),
    };

    const context = await browser!.createBrowserContext();
    const page = await context.newPage();
    openContexts.set(page, context);
    ensureDiagnosticsAttached(page);

    try {
      await page.evaluateOnNewDocument(
        (seed: {
          token: string;
          refreshToken?: string;
          tenantSlug: string;
          userJson: string;
          minthAuthJson: string;
        }) => {
          const g = globalThis as any;
          if (g.window !== g.top) return;
          try {
            const ls = g.localStorage;
            if (!ls || ls.getItem('__e2e_seeded') === '1') return;
            ls.setItem('domation_token', seed.token);
            ls.setItem('Ideas_token', seed.token);
            ls.setItem('access_token', seed.token);
            if (seed.refreshToken) {
              ls.setItem('refresh_token', seed.refreshToken);
            }
            ls.setItem('Ideas_user', seed.userJson);
            ls.setItem('minth-auth', seed.minthAuthJson);
            ls.setItem('domation_tenant_slug', seed.tenantSlug);
            ls.setItem('tenant_slug', seed.tenantSlug);
            ls.removeItem('IDEAS_DEMO_MODE');
            ls.setItem('__e2e_seeded', '1');
          } catch {
            /* ignore opaque/sandboxed origin */
          }
        },
        {
          token: auth.accessToken,
          refreshToken: auth.refreshToken,
          tenantSlug,
          userJson: JSON.stringify(normalizedUser),
          minthAuthJson: JSON.stringify({
            state: {
              user: normalizedUser,
              accessToken: auth.accessToken,
              refreshToken: auth.refreshToken ?? null,
              isAuthenticated: true,
            },
            version: 0,
          }),
        }
      );

      const cleanPath = initialPath.startsWith('/') ? initialPath : `/${initialPath}`;
      const targetUrl = `${frontendBaseUrl}${cleanPath}`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const doc = (globalThis as any).document;
          const root = doc?.getElementById('root');
          return Boolean(root && root.children.length > 0);
        },
        { timeout: 25_000 }
      );

      const currentPathname = new URL(page.url()).pathname;
      if (!cleanPath.startsWith('/login') && currentPathname === '/login') {
        throw new Error(`Authenticated navigation to "${cleanPath}" redirected unexpectedly to /login`);
      }

      return page;
    } catch (err) {
      openContexts.delete(page);
      if (!page.isClosed()) await page.close().catch(() => {});
      await context.close().catch(() => {});
      throw err;
    }
  };

  const collectRuntimeDiagnostics = (page: Page): RuntimeDiagnostics => {
    const state = ensureDiagnosticsAttached(page);
    return {
      consoleErrors: [...state.consoleErrors],
      pageErrors: [...state.pageErrors],
      http5xxErrors: [...state.http5xxErrors],
      requestFailedErrors: [...state.requestFailedErrors],
    };
  };

  const closePage = async (page: Page): Promise<void> => {
    const ctx = openContexts.get(page);
    openContexts.delete(page);
    if (!page.isClosed()) {
      await page.close().catch(() => {});
    }
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  };

  let teardownPromise: Promise<void> | null = null;
  const teardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      const entries = Array.from(openContexts.entries());
      openContexts.clear();
      await Promise.allSettled(
        entries.map(async ([page, ctx]) => {
          if (!page.isClosed()) await page.close().catch(() => {});
          await ctx.close().catch(() => {});
        })
      );

      if (browser) {
        const browserProc = browser.process();
        await Promise.race([
          browser.close().catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 4000)),
        ]);
        if (browser.connected && browserProc?.pid) {
          if (process.platform === 'win32') {
            await execFileAsync('taskkill', ['/pid', String(browserProc.pid), '/f', '/t'], {
              windowsHide: true,
            }).catch(() => {});
          } else {
            browserProc.kill('SIGKILL');
          }
        }
      }

      await killViteProcessTree(viteProc);
    })();
    return teardownPromise;
  };

  return {
    frontendBaseUrl,
    backendBaseUrl: normalizedBackend,
    executablePath,
    browser: browser!,
    openAuthenticatedPage,
    collectRuntimeDiagnostics,
    closePage,
    teardown,
  };
}
