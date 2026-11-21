import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HTTPRequest, HTTPResponse, Page } from 'puppeteer';
import {
  startMarketingE2eHarness,
  type MarketingE2eHarness,
  type TenantAuthContext,
} from './_harness.ts';
import {
  startErpBrowserHarness,
  type BrowserAuthInput,
  type ErpBrowserHarness,
} from './_browser-harness.ts';

let harness: MarketingE2eHarness;
let browserHarness: ErpBrowserHarness | undefined;

async function ensureBrowserHarness(): Promise<ErpBrowserHarness> {
  if (!browserHarness) {
    browserHarness = await startErpBrowserHarness(harness.baseUrl);
  }
  return browserHarness;
}

function requireBrowserHarness(): ErpBrowserHarness {
  if (!browserHarness) {
    throw new Error('Browser harness not initialized; call ensureBrowserHarness() first');
  }
  return browserHarness;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

interface NetworkGuardReport {
  api4xxErrors: Array<{ status: number; url: string; method: string }>;
  api5xxErrors: Array<{ status: number; url: string; method: string }>;
  php404Or501Errors: Array<{ status: number; url: string; method: string }>;
  port3199Requests: string[];
  externalApiRequests: string[];
}

interface NetworkGuard {
  getReport: () => NetworkGuardReport;
  reset: () => void;
}

function toBrowserUser(auth: TenantAuthContext): BrowserAuthInput['user'] {
  return {
    ...auth.user,
    id: auth.user?.id || auth.userId,
    role: String(auth.user?.role || 'admin'),
    email: auth.user?.email || auth.email,
    tenant_id: auth.user?.tenant_id || auth.tenantId,
    tenant_slug: auth.user?.tenant_slug || auth.tenantSlug,
  };
}

function attachNetworkGuard(page: Page): NetworkGuard {
  let state: NetworkGuardReport = {
    api4xxErrors: [],
    api5xxErrors: [],
    php404Or501Errors: [],
    port3199Requests: [],
    externalApiRequests: [],
  };

  page.on('request', (req: HTTPRequest) => {
    const url = req.url();
    if (url.includes(':3199')) {
      state.port3199Requests.push(`${req.method()} ${url}`);
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol.startsWith('http') && !LOOPBACK_HOSTS.has(parsed.hostname)) {
        const resType = req.resourceType();
        if (resType === 'xhr' || resType === 'fetch' || url.includes('/api/') || url.includes('/backend/')) {
          state.externalApiRequests.push(`${req.method()} ${url}`);
        }
      }
    } catch {
      // Ignore data:/blob: URLs
    }
  });

  page.on('response', (res: HTTPResponse) => {
    const status = res.status();
    const url = res.url();
    const method = res.request().method();
    const isApi = url.includes('/api/') || url.includes('/backend/');
    if (isApi && status >= 400 && status < 500) {
      state.api4xxErrors.push({ status, url, method });
    }
    if (isApi && status >= 500) {
      state.api5xxErrors.push({ status, url, method });
    }
    if (url.includes('.php') && (status === 404 || status === 501)) {
      state.php404Or501Errors.push({ status, url, method });
    }
  });

  return {
    getReport: () => ({
      api4xxErrors: [...state.api4xxErrors],
      api5xxErrors: [...state.api5xxErrors],
      php404Or501Errors: [...state.php404Or501Errors],
      port3199Requests: [...state.port3199Requests],
      externalApiRequests: [...state.externalApiRequests],
    }),
    reset: () => {
      state = {
        api4xxErrors: [],
        api5xxErrors: [],
        php404Or501Errors: [],
        port3199Requests: [],
        externalApiRequests: [],
      };
    },
  };
}

function assertCleanRuntime(
  page: Page,
  netGuard: NetworkGuard,
  label: string,
  opts?: { allowApi4xx?: boolean }
): void {
  const diag = requireBrowserHarness().collectRuntimeDiagnostics(page);
  const net = netGuard.getReport();

  assert.equal(diag.pageErrors.length, 0, `${label}: expected 0 pageErrors, got: ${JSON.stringify(diag.pageErrors)}`);
  assert.equal(diag.consoleErrors.length, 0, `${label}: expected 0 consoleErrors, got: ${JSON.stringify(diag.consoleErrors)}`);
  assert.equal(diag.http5xxErrors.length, 0, `${label}: expected 0 http5xxErrors, got: ${JSON.stringify(diag.http5xxErrors)}`);
  assert.equal(
    diag.requestFailedErrors.length,
    0,
    `${label}: expected 0 requestFailedErrors, got: ${JSON.stringify(diag.requestFailedErrors)}`
  );
  assert.equal(net.api5xxErrors.length, 0, `${label}: expected 0 API 5xx/501 responses, got: ${JSON.stringify(net.api5xxErrors)}`);
  assert.equal(
    net.php404Or501Errors.length,
    0,
    `${label}: expected 0 .php 404/501 responses, got: ${JSON.stringify(net.php404Or501Errors)}`
  );
  assert.equal(net.port3199Requests.length, 0, `${label}: expected 0 requests targeting :3199`);
  assert.equal(
    net.externalApiRequests.length,
    0,
    `${label}: expected 0 unmocked external API requests, got: ${JSON.stringify(net.externalApiRequests)}`
  );
  if (!opts?.allowApi4xx) {
    assert.equal(
      net.api4xxErrors.length,
      0,
      `${label}: expected 0 unexpected API 4xx responses, got: ${JSON.stringify(net.api4xxErrors)}`
    );
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSplashDismissed(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const g = globalThis as any;
      const splash = g.document?.getElementById('ideas-splash-screen');
      if (!splash) return true;
      if (splash.classList?.contains('splash-fade-out')) return true;
      const cs = g.getComputedStyle(splash);
      return cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;
    },
    { timeout }
  );
}

async function waitForAppReady(page: Page, timeout = 25_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const doc = (globalThis as any).document;
      const root = doc?.getElementById('root');
      const hasLoader = Boolean(doc?.querySelector('[role="status"][aria-busy="true"]'));
      return Boolean(root && root.children.length > 0 && !hasLoader && (root.innerText || '').trim().length > 0);
    },
    { timeout }
  );
  await waitForSplashDismissed(page, timeout);
}

async function navigateRoute(page: Page, targetPath: string): Promise<void> {
  const cleanPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  await page.goto(`${requireBrowserHarness().frontendBaseUrl}${cleanPath}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForAppReady(page, 25_000);
}

async function navigateSpaRoute(page: Page, targetPath: string): Promise<void> {
  const cleanPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  const clickedSidebar = await page.evaluate((path: string) => {
    const g = globalThis as any;
    const doc = g.document;
    const main = doc.querySelector('main');
    if (main && g.location.pathname + g.location.search !== path) {
      g.__e2ePrevScopeEl =
        Array.from(main.querySelectorAll('.mkt-scope, .dom-meta-scope')).find(
          (el: any) =>
            !el.closest('[role="status"][aria-busy="true"]') &&
            el.style?.display !== 'contents' &&
            !(
              Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
              el.querySelectorAll('button, a, input, select, textarea').length <= 1
            ) &&
            g.getComputedStyle(el).visibility !== 'hidden'
        ) || null;
    } else {
      g.__e2ePrevScopeEl = null;
    }
    const sidebarLink = doc.querySelector(`aside.responsive-sidebar a[href="${path}"]`) as any;
    if (sidebarLink) {
      sidebarLink.click();
      return true;
    }
    return false;
  }, cleanPath);

  if (!clickedSidebar) {
    await navigateRoute(page, cleanPath);
  }
}

async function waitForMainRouteReady(
  page: Page,
  route: string,
  timeout = 20_000
): Promise<{
  pathname: string;
  mainTextLength: number;
  mainSnippet: string;
  hasVisibleMktScope: boolean;
  hasVisibleDomMetaScope: boolean;
  hasAccessDenied: boolean;
  hasErrorBoundary: boolean;
}> {
  await page
    .waitForFunction(
      (r: string) => {
        const g = globalThis as any;
        const doc = g.document;
        if (doc.querySelector('[role="status"][aria-busy="true"]')) return false;
        const main = doc.querySelector('main');
        if (!main) return false;
        const currentPath = g.location.pathname;
        if (currentPath !== r) return false;
        if (
          g.__e2ePrevScopeEl &&
          g.__e2ePrevScopeEl.isConnected &&
          g.getComputedStyle(g.__e2ePrevScopeEl).visibility !== 'hidden'
        ) {
          return false;
        }
        const mainText = (main.innerText || '').trim();
        if (mainText.length <= 40) return false;
        if (r === '/data') {
          return !main.querySelector('.animate-pulse') && mainText.includes('Quản lý Data');
        }
        if (r === '/meta-report') {
          return Array.from(main.querySelectorAll('.dom-meta-scope, .mkt-scope')).some(
            (el: any) =>
              el !== g.__e2ePrevScopeEl &&
              !el.closest('[role="status"][aria-busy="true"]') &&
              el.style?.display !== 'contents' &&
              !(
                Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                el.querySelectorAll('button, a, input, select, textarea').length <= 1
              ) &&
              g.getComputedStyle(el).visibility !== 'hidden'
          );
        }
        if (r === '/capi') {
          return !main.querySelector('.animate-pulse') || mainText.length > 80;
        }
        return Array.from(main.querySelectorAll('.mkt-scope')).some(
          (el: any) =>
            el !== g.__e2ePrevScopeEl &&
            !el.closest('[role="status"][aria-busy="true"]') &&
            el.style?.display !== 'contents' &&
            !(
              Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
              el.querySelectorAll('button, a, input, select, textarea').length <= 1
            ) &&
            g.getComputedStyle(el).visibility !== 'hidden'
        );
      },
      { timeout },
      route
    )
    .catch(() => {});

  await sleep(150);

  return page.evaluate(() => {
    const g = globalThis as any;
    const doc = g.document;
    const main = doc.querySelector('main');
    const mainText = (main?.innerText || '').trim();
    const hasVisibleMktScope = Boolean(
      main &&
        Array.from(main.querySelectorAll('.mkt-scope')).some(
          (el: any) =>
            !el.closest('[role="status"][aria-busy="true"]') &&
            el.style?.display !== 'contents' &&
            !(
              Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
              el.querySelectorAll('button, a, input, select, textarea').length <= 1
            ) &&
            g.getComputedStyle(el).visibility !== 'hidden'
        )
    );
    const hasVisibleDomMetaScope = Boolean(
      main &&
        Array.from(main.querySelectorAll('.dom-meta-scope')).some(
          (el: any) => !el.closest('[role="status"][aria-busy="true"]') && g.getComputedStyle(el).visibility !== 'hidden'
        )
    );
    return {
      pathname: g.location.pathname,
      mainTextLength: mainText.length,
      mainSnippet: mainText.slice(0, 220),
      hasVisibleMktScope,
      hasVisibleDomMetaScope,
      hasAccessDenied: mainText.includes('Không có quyền truy cập'),
      hasErrorBoundary:
        mainText.includes('Đã xảy ra lỗi') ||
        mainText.includes('Đã xảy ra sự cố') ||
        mainText.includes('Không thể tải nội dung này'),
    };
  });
}

async function assertLightSidebar(page: Page, contextLabel: string): Promise<void> {
  const sidebarAudit = await page.evaluate(() => {
    const g = globalThis as any;
    const doc = g.document;
    const aside = doc.querySelector('aside.responsive-sidebar');
    if (!aside) return { exists: false };

    const cs = g.getComputedStyle(aside);
    const rawBgCombined = `${cs.backgroundColor || ''} ${cs.backgroundImage || ''}`;
    const allBgStops: Array<{ r: number; g: number; b: number; a: number }> = [];
    for (const m of rawBgCombined.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/gi)) {
      const a = m[4] !== undefined ? Number(m[4]) : 1;
      if (a > 0.05) {
        allBgStops.push({ r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a });
      }
    }

    const hasDarkStop = allBgStops.some((c) => c.r < 120 && c.g < 120 && c.b < 120 && c.a >= 0.5);
    const hasLightStop = allBgStops.some((c) => c.r >= 220 && c.g >= 220 && c.b >= 220 && c.a >= 0.7);

    const asideDuration = parseFloat(cs.transitionDuration || '0') || 0;
    const navItems = Array.from(aside.querySelectorAll('a.sidebar-nav-item')) as any[];
    const inactiveNav = navItems.find((a) => !a.classList.contains('active') && a.getAttribute('data-active') !== 'true');
    let navColor: { r: number; g: number; b: number; a: number } | null = null;
    if (inactiveNav) {
      const m = (g.getComputedStyle(inactiveNav).color || '').match(
        /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i
      );
      if (m) {
        navColor = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
      }
    }
    const navDuration = inactiveNav ? parseFloat(g.getComputedStyle(inactiveNav).transitionDuration || '0') || 0 : 0;

    return {
      exists: true,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      hasDarkStop,
      hasLightStop,
      transitionDuration: Math.max(asideDuration, navDuration),
      navTextColor: navColor,
    };
  });

  assert.equal(sidebarAudit.exists, true, `${contextLabel}: expected aside.responsive-sidebar`);
  assert.equal(
    sidebarAudit.hasDarkStop,
    false,
    `${contextLabel}: expected white/light sidebar, got bg=${sidebarAudit.backgroundColor} bgImg=${sidebarAudit.backgroundImage}`
  );
  assert.equal(
    sidebarAudit.hasLightStop,
    true,
    `${contextLabel}: expected light/white sidebar rgb >= 220, got bg=${sidebarAudit.backgroundColor} bgImg=${sidebarAudit.backgroundImage}`
  );
  assert.ok(
    (sidebarAudit.transitionDuration ?? 0) > 0,
    `${contextLabel}: expected non-zero sidebar transitionDuration, got ${sidebarAudit.transitionDuration}`
  );
  if (sidebarAudit.navTextColor) {
    assert.ok(
      sidebarAudit.navTextColor.r < 130 && sidebarAudit.navTextColor.g < 130 && sidebarAudit.navTextColor.b < 130,
      `${contextLabel}: expected dark text contrast on light sidebar, got ${JSON.stringify(sidebarAudit.navTextColor)}`
    );
  }
}

async function assertStandardAppIcons(
  page: Page,
  rootSelector: string,
  minSize: number,
  maxSize: number,
  contextLabel: string,
  iconSelector = 'svg[viewBox="0 0 56 56"]'
): Promise<void> {
  const iconAudit = await page.evaluate(
    (rootSel: string, minPx: number, maxPx: number, iconSel: string) => {
      const g = globalThis as any;
      const doc = g.document;
      const roots = (Array.from(doc.querySelectorAll(rootSel)) as any[]).filter((el) => {
        const cs = g.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
        if (cs.display !== 'contents') {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
        }
        return true;
      });
      if (roots.length === 0) return { count: 0, distorted: [] as any[] };
      const seen = new Set<any>();
      const svgs: any[] = [];
      for (const r of roots) {
        for (const svg of Array.from(r.querySelectorAll(iconSel)) as any[]) {
          if (!seen.has(svg)) {
            seen.add(svg);
            svgs.push(svg);
          }
        }
      }
      const visible = svgs.filter((svg) => {
        const cs = g.getComputedStyle(svg);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = svg.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const distorted = visible
        .map((svg) => {
          const r = svg.getBoundingClientRect();
          return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
        })
        .filter((d) => d.w < minPx || d.w > maxPx || d.h < minPx || d.h > maxPx || Math.abs(d.w - d.h) > 2);
      return { count: visible.length, distorted };
    },
    rootSelector,
    minSize,
    maxSize,
    iconSelector
  );

  assert.ok(iconAudit.count >= 1, `${contextLabel}: expected >= 1 visible standard AppIcon in ${rootSelector}`);
  assert.equal(
    iconAudit.distorted.length,
    0,
    `${contextLabel}: expected normal/square bounded AppIcons (${minSize}..${maxSize}px), found distorted: ${JSON.stringify(iconAudit.distorted)}`
  );
}

async function assertVisibleDatePicker(page: Page, selector: string, contextLabel: string): Promise<void> {
  const hasVisibleDatePicker = await page.evaluate((sel: string) => {
    const g = globalThis as any;
    const doc = g.document;
    return Array.from(doc.querySelectorAll(sel)).some((el: any) => {
      const cs = g.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }, selector);
  assert.equal(
    hasVisibleDatePicker,
    true,
    `${contextLabel}: expected visible unified date range filter matching ${selector}`
  );
}

async function assertErpQuickNavRedAccent(page: Page, contextLabel: string): Promise<void> {
  await page.evaluate(() => {
    (globalThis as any).window.dispatchEvent(new (globalThis as any).CustomEvent('open-quick-menu'));
  });
  await page.waitForFunction(
    () => ((globalThis as any).document.body.innerText || '').includes('Menu điều hướng nhanh'),
    { timeout: 8_000 }
  );
  const erpQuickNavRedCount = await page.evaluate(() => {
    const g = globalThis as any;
    const doc = g.document;
    const modalRoot = Array.from(doc.querySelectorAll('div')).find(
      (d: any) =>
        (d.textContent || '').includes('Menu điều hướng nhanh') &&
        g.getComputedStyle(d).position === 'fixed'
    ) as any;
    if (!modalRoot) return 0;
    const els = Array.from(modalRoot.querySelectorAll('*')) as any[];
    let hits = 0;
    for (const el of els) {
      const cs = g.getComputedStyle(el);
      const combined = `${cs.backgroundColor || ''} ${cs.backgroundImage || ''} ${cs.color || ''}`;
      const rgbHit = Array.from(
        combined.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
      ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
      const hexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(combined);
      if (rgbHit || hexHit) {
        hits++;
      }
    }
    return hits;
  });
  await page.keyboard.press('Escape');
  await sleep(200);
  assert.ok(
    erpQuickNavRedCount >= 1,
    `${contextLabel}: expected red accent (#DC2626/#EF4444) in ERP Quick Navigation palette, found ${erpQuickNavRedCount}`
  );
}

async function clickButtonByText(
  page: Page,
  textNeedle: string,
  opts?: { exact?: boolean; rootSelector?: string; selector?: string }
): Promise<boolean> {
  const selector = opts?.selector || 'button, [role="tab"]';
  const rootSelector = opts?.rootSelector || 'body';
  const exact = opts?.exact ?? false;
  return page.evaluate(
    (needle: string, sel: string, rootSel: string, isExact: boolean) => {
      const g = globalThis as any;
      const doc = g.document;
      const root = doc.querySelector(rootSel) || doc.body;
      if (!root) return false;
      const nodes = Array.from(root.querySelectorAll(sel)) as any[];
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const cs = g.getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0 || cs.display === 'none' || cs.visibility === 'hidden') {
          continue;
        }
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const matched = isExact ? txt === needle : txt.includes(needle);
        if (matched && !el.disabled) {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.click();
          return true;
        }
      }
      return false;
    },
    textNeedle,
    selector,
    rootSelector,
    exact
  );
}

async function configureResendEmail(auth: TenantAuthContext, fromEmail: string): Promise<void> {
  await harness.apiJson('/api/v1/auth/tenant-settings', {
    method: 'PATCH',
    auth,
    body: {
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_e2e_t4_key_001',
        resend_from_email: fromEmail,
        resend_from_name: 'DOMATION Scenario E2E',
      },
    },
  });
}

async function configureZnsVault(auth: TenantAuthContext, accessToken = 'zns_live_t4_tok_001'): Promise<void> {
  const res = await harness.apiJson('/api/v1/integrations/vault/zalo_zns', {
    method: 'PUT',
    auth,
    body: {
      access_token: accessToken,
      refresh_token: 'zns_t4_ref_001',
      oa_id: 'OA_T4_01',
      app_id: 'APP_T4_01',
    },
  });
  assert.equal(res.data.integration_type, 'zalo_zns');
}

async function setupCapiVault(auth: TenantAuthContext, testEventCode = 'TEST_T4_01'): Promise<void> {
  const res = await harness.apiJson('/api/v1/integrations/vault/meta_capi', {
    method: 'PUT',
    auth,
    body: {
      dataset_id: '887766554433',
      access_token: 'EAA_e2e_t4_capi_token_1234567890abcdef',
      live_http_enabled: true,
      test_event_code: testEventCode,
    },
  });
  assert.equal(res.data.integration_type, 'meta_capi');
}

async function getDefaultPipelineStages(auth: TenantAuthContext) {
  const res = await harness.apiJson('/api/v1/pipelines', { auth });
  const pipelines: any[] = res.data || [];
  const defaultPipeline = pipelines.find((p) => p.is_default) || pipelines[0];
  assert.ok(defaultPipeline, 'Expected default pipeline');
  const stages: any[] = defaultPipeline.stages || [];
  const scheduleStage =
    stages.find((s) => s.capi_event_mapping === 'Schedule') ||
    stages.find((s) => !s.is_won_stage && !s.is_lost_stage && s.id !== stages[0]?.id) ||
    stages[1];
  const wonStage =
    stages.find((s) => Boolean(s.is_won_stage)) ||
    stages.find((s) => s.capi_event_mapping === 'Purchase');
  assert.ok(scheduleStage, 'Expected scheduleStage');
  assert.ok(wonStage, 'Expected wonStage');
  return { pipelineId: String(defaultPipeline.id), scheduleStage, wonStage };
}

function signHmacHex(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('Tier 4: Real-World End-to-End Application Scenarios (E2E)', () => {
  before(
    async () => {
      harness = await startMarketingE2eHarness();
    },
    { timeout: 90_000 }
  );

  after(
    async () => {
      try {
        await browserHarness?.teardown();
      } finally {
        await harness?.teardown();
      }
    },
    { timeout: 30_000 }
  );

  beforeEach(() => {
    harness.resetCaptures();
  });

  it(
    'T4-01: Lead-to-Sale Omni-Channel Funnel (Form+OTP -> Tag -> Segment -> Wait Flow Resume -> Email/ZNS -> Campaign Click -> CRM Sale Round -> Won CAPI Purchase)',
    { timeout: 90_000 },
    async () => {
      const auth = await harness.registerTenant({
        packageCode: 'growth_combo',
        industry: 'real_estate',
        seedDemoLeads: false,
      });
      await configureResendEmail(auth, 'funnel@sc1.test.vn');
      await configureZnsVault(auth, 'zns_live_sc1_tok');
      await setupCapiVault(auth, 'TEST_SC1');
      harness.setSmtpCaptureEnabled(false);

      try {
        const saleUserRes = await harness.apiJson('/api/v1/users', {
          method: 'POST',
          auth,
          body: {
            full_name: 'Sale Funnel Rep',
            email: `sale.sc1@${auth.tenantSlug}.vn`,
            password: 'SalePassword123!',
            role: 'sale',
            is_available: true,
          },
        });
        const saleUserId = String(saleUserRes.data.id);

        const { wonStage } = await getDefaultPipelineStages(auth);

        await harness.apiJson('/api/v1/marketing/social-bot/zalo-templates', {
          method: 'POST',
          auth,
          body: {
            name: 'SC1 ZNS',
            template_code: 'ZNS_SC1_01',
            content_body: 'Chào {{customer_name}}',
          },
        });

        const tagRes = await harness.apiJson('/api/v1/audiences/tags', {
          method: 'POST',
          auth,
          body: { name: 'hot-funnel', color: '#DC2626' },
        });
        const tagId = String(tagRes.data.id);

        const segRes = await harness.apiJson('/api/v1/audiences', {
          method: 'POST',
          auth,
          body: {
            name: 'SC1 Hot Funnel Seg',
            audience_type: 'dynamic_logic',
            filter_branches: [
              {
                join: 'AND',
                rules: [{ field: 'tag', op: 'equals', value: 'hot-funnel' }],
              },
            ],
          },
        });
        const segId = String(segRes.data.id);

        const nurtureFlow = await harness.apiJson('/api/v1/marketing/flows', {
          method: 'POST',
          auth,
          body: {
            name: 'SC1 Nurture Wait Flow',
            status: 'active',
            trigger_type: 'audience_joined',
            trigger_config: { audience_id: segId },
            steps: [
              {
                id: 's1',
                type: 'update_lead_score',
                label: 'Score +10',
                config: { delta: 10 },
                nextStepId: 's2',
              },
              {
                id: 's2',
                type: 'wait_delay',
                label: 'Wait 0.005m',
                config: { duration: 0.005, unit: 'minutes', pause_execution: true },
                nextStepId: 's3',
              },
              {
                id: 's3',
                type: 'send_email',
                label: 'Funnel Email',
                config: {
                  subject: 'Funnel Email {{lead.name}}',
                  customHtml: '<p>Hi {{lead.name}}</p>',
                },
                nextStepId: 's4',
              },
              {
                id: 's4',
                type: 'send_zns',
                label: 'Funnel ZNS',
                config: { template_id: 'ZNS_SC1_01', subject: 'ZNS Funnel {{lead.name}}' },
              },
            ],
          },
        });
        const nurtureFlowId = String(nurtureFlow.data.id);

        const clickToSaleFlow = await harness.apiJson('/api/v1/marketing/flows', {
          method: 'POST',
          auth,
          body: {
            name: 'SC1 Click Push To Sale',
            status: 'active',
            trigger_type: 'link_clicked',
            steps: [
              {
                id: 'push_sale',
                type: 'push_to_autodata_sale_round',
                label: 'Push to Sale Round',
                config: {},
              },
            ],
          },
        });
        const clickToSaleFlowId = String(clickToSaleFlow.data.id);

        const formRes = await harness.apiJson('/api/v1/marketing/forms', {
          method: 'POST',
          auth,
          body: {
            name: 'SC1 Funnel Form',
            require_otp: true,
            otp_channel: 'email',
            routing_mode: 'marketing_nurture',
            fields: [
              { id: 'n', key: 'name', label: 'Họ tên', type: 'text', required: true },
              { id: 'e', key: 'email', label: 'Email', type: 'email', required: true },
              { id: 'p', key: 'phone', label: 'SĐT', type: 'phone', required: true },
            ],
          },
        });
        const formToken = String(formRes.data.public_token);

        // OTP send -> verify -> submit form
        const otpSend = await harness.apiRaw('/api/v1/public/marketing/otp/send', {
          method: 'POST',
          body: { form_token: formToken, recipient: 'buyer.sc1@test.vn', channel: 'email' },
        });
        assert.equal(otpSend.status, 201);
        const otpId = String(otpSend.json?.data?.otp_id);
        const otpCode = String(otpSend.json?.data?.sandbox_otp_code);
        assert.ok(otpCode);
        assert.equal(
          harness.emailCapture.some((e) => e.to === 'buyer.sc1@test.vn' && e.text.includes(otpCode)),
          true
        );

        const otpVerify = await harness.apiRaw('/api/v1/public/marketing/otp/verify', {
          method: 'POST',
          body: { form_token: formToken, otp_id: otpId, code: otpCode, recipient: 'buyer.sc1@test.vn' },
        });
        assert.equal(otpVerify.status, 200);
        assert.equal(otpVerify.json?.data?.verified, true);

        const formSubmit = await harness.apiRaw(`/api/v1/public/marketing/forms/${formToken}/submit`, {
          method: 'POST',
          body: {
            name: 'Khách Funnel',
            email: 'buyer.sc1@test.vn',
            phone: '0909100200',
            otp_id: otpId,
          },
        });
        assert.equal(formSubmit.status, 201);
        const leadId = String(formSubmit.json?.data?.lead_id);
        assert.ok(leadId);

        await harness.apiJson(`/api/v1/audiences/contacts/${leadId}/tags`, {
          method: 'POST',
          auth,
          body: { tag_id: tagId },
        });

        const evalRes = await harness.apiJson(`/api/v1/audiences/${segId}/evaluate`, {
          method: 'POST',
          auth,
          body: {},
        });
        // Tag assignment already emits lead.updated/marketing.engaged -> auto-evaluates dynamic segments
        assert.equal(evalRes.data.total_count, 1);

        const flowBeforeCron = await harness.apiJson(`/api/v1/marketing/flows/${nurtureFlowId}`, { auth });
        assert.equal(flowBeforeCron.data.enrollments.length, 1);
        assert.equal(flowBeforeCron.data.enrollments[0].status, 'waiting');
        const waitParticipants = await harness.apiJson(
          `/api/v1/marketing/flows/${nurtureFlowId}/steps/s2/participants?status=waiting`,
          { auth }
        );
        assert.equal(
          waitParticipants.data.participants.some((p: any) => p.lead_id === leadId && p.enrollment_status === 'waiting'),
          true
        );

        const contactBeforeCron = await harness.apiJson('/api/v1/audiences/contacts?search=buyer.sc1%40test.vn', { auth });
        const scoreBeforeCron = Number(contactBeforeCron.data.items[0].lead_score);
        assert.ok(scoreBeforeCron >= 10, `Expected lead_score >= 10 from s1 before cron, got ${scoreBeforeCron}`);

        await sleep(450);
        harness.emailCapture.length = 0;
        harness.zaloCapture.length = 0;

        const cronRes = await harness.triggerMasterCron(['marketing_flows'], auth.tenantId);
        assert.equal(cronRes.status, 200);
        assert.ok(Number(cronRes.stats.marketingFlowsProcessed || 0) >= 1);

        const flowAfterCron = await harness.apiJson(`/api/v1/marketing/flows/${nurtureFlowId}`, { auth });
        assert.equal(flowAfterCron.data.enrollments[0].status, 'completed');

        const contactAfterCron = await harness.apiJson('/api/v1/audiences/contacts?search=buyer.sc1%40test.vn', { auth });
        assert.equal(Number(contactAfterCron.data.items[0].lead_score), scoreBeforeCron);

        assert.equal(
          harness.emailCapture.some((e) => e.to === 'buyer.sc1@test.vn' && e.subject === 'Funnel Email Khách Funnel'),
          true
        );
        assert.equal(
          harness.zaloCapture.some(
            (z) =>
              z.channel === 'zns' &&
              z.body?.template_id === 'ZNS_SC1_01' &&
              String(z.body?.phone || '').endsWith('909100200')
          ),
          true
        );

        // Campaign send + click -> triggers clickToSaleFlow -> assigns CRM lead
        const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
          method: 'POST',
          auth,
          body: {
            name: 'SC1 Offer Tpl',
            subject: 'SC1 Offer',
            compiled_html: '<p>Offer</p><a href="https://domation.net/sc1-offer">Offer</a>',
          },
        });
        const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
          method: 'POST',
          auth,
          body: {
            name: 'SC1 Offer Camp',
            channel: 'email',
            audience_id: segId,
            template_id: tplRes.data.id,
            subject_a: 'SC1 Final Offer',
          },
        });
        const campId = String(campRes.data.id);
        const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
          method: 'POST',
          auth,
          body: {},
        });
        const claimId = String(sendRes.data.claim_ids[0]);
        assert.ok(claimId);

        const clickResp = await fetch(
          `${harness.baseUrl}/api/v1/public/marketing/track/click/${claimId}?url=${encodeURIComponent('https://domation.net/sc1-offer')}`,
          { redirect: 'manual' }
        );
        assert.equal(clickResp.status, 302);

        const campDetail = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
        assert.equal(campDetail.data.funnel.opened, 1);
        assert.equal(campDetail.data.funnel.clicked, 1);

        const saleFlowDetail = await harness.apiJson(`/api/v1/marketing/flows/${clickToSaleFlowId}`, { auth });
        assert.equal(
          saleFlowDetail.data.enrollments.some((e: any) => e.lead_id === leadId && e.status === 'completed'),
          true
        );

        const crmSearch = await harness.apiJson('/api/v1/leads?search=buyer.sc1%40test.vn', { auth });
        const crmLead = (crmSearch.data.items || []).find((l: any) => l.id === leadId);
        assert.ok(crmLead);
        assert.equal(crmLead.status, 'assigned');
        assert.equal(crmLead.assigned_sale?.id, saleUserId);

        const stageRes = await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
          method: 'PATCH',
          auth,
          body: { stage_id: wonStage.id, deal_value_vnd: 88_000_000, note: 'SC1 Won' },
        });
        assert.equal(stageRes.data.capi_dispatched?.event_name, 'Purchase');
        assert.equal(stageRes.data.capi_dispatched?.value, 88_000_000);
        assert.equal(stageRes.data.capi_dispatched?.currency, 'VND');
        assert.equal(stageRes.data.capi_dispatched?.status, 200);

        const purchaseCapi = harness.capiCapture.find((c) => {
          const evs = Array.isArray((c.payload as any)?.data) ? (c.payload as any).data : [];
          return evs.some((ev: any) => ev.event_name === 'Purchase' && ev.custom_data?.value === 88_000_000);
        });
        assert.ok(purchaseCapi, 'Expected Purchase CAPI payload in capiCapture');
        const pEv = ((purchaseCapi!.payload as any).data as any[]).find((ev) => ev.event_name === 'Purchase');
        assert.ok(Array.isArray(pEv.user_data?.ph) && pEv.user_data.ph[0].length === 64);
        assert.ok(Array.isArray(pEv.user_data?.em) && pEv.user_data.em[0].length === 64);
      } finally {
        harness.setSmtpCaptureEnabled(true);
      }
    }
  );

  it(
    'T4-02: Standalone Tenant Onboarding, MarketingSpotlightTour, First Campaign Open/Click Measurement & Upgrade to domation_promax preserving data',
    { timeout: 120_000 },
    async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      await configureResendEmail(auth, 'sc2@e2e.vn');
      const bh = await ensureBrowserHarness();

      let page: Page | undefined;
      try {
        harness.setSmtpCaptureEnabled(false);

        const bgJpgRes = await fetch(`${bh.frontendBaseUrl}/imgs/landing/fluent-brand-ambient-bg.jpg`);
        const bgWebpRes = await fetch(`${bh.frontendBaseUrl}/imgs/landing/fluent-brand-ambient-bg.webp`);
        assert.ok(
          bgJpgRes.status === 200 || bgWebpRes.status === 200,
          `Expected landing ambient bg asset HTTP 200 (jpg=${bgJpgRes.status}, webp=${bgWebpRes.status})`
        );

        page = await bh.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'marketing_standalone',
          },
          '/'
        );
        const netGuard = attachNetworkGuard(page);

        await waitForAppReady(page, 30_000);
        await page.waitForSelector('aside.responsive-sidebar', { timeout: 15_000 });
        await page.waitForFunction(
          () => {
            const main = (globalThis as any).document.querySelector('main');
            return Boolean(main?.querySelector('.mkt-scope')) && (main?.innerText || '').includes('Marketing & Đa kênh');
          },
          { timeout: 20_000 }
        );

        const standaloneAudit = await page.evaluate(() => {
          const g = globalThis as any;
          const doc = g.document;
          const splash = doc.getElementById('ideas-splash-screen');
          const splashImg = splash?.querySelector('img')?.getAttribute('src') || '';
          const splashSource = splash?.querySelector('source')?.getAttribute('srcset') || '';

          const sidebar = doc.querySelector('aside.responsive-sidebar');
          const sidebarText = sidebar?.textContent || '';
          const hrefs = Array.from(sidebar?.querySelectorAll('a[href]') || []).map((a: any) => a.getAttribute('href'));
          const hasSidebarUpgradeLink = Boolean(sidebar?.querySelector('a[href*="package_upgrade"]'));

          const rootCs = g.getComputedStyle(doc.documentElement);
          const scope = Array.from(doc.querySelectorAll('main .mkt-scope')).find(
            (el: any) =>
              el.style?.display !== 'contents' &&
              !(
                Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                el.querySelectorAll('button, a, input, select, textarea').length <= 1
              ) &&
              g.getComputedStyle(el).visibility !== 'hidden'
          ) as any;
          const scopeCs = scope ? g.getComputedStyle(scope) : null;

          const decorRoots = [scope, ...Array.from(doc.querySelectorAll('.dom-meta-app-canvas'))].filter(Boolean) as any[];
          const seenSvgs = new Set<any>();
          const svgs: any[] = [];
          for (const root of decorRoots) {
            for (const svg of Array.from(root.querySelectorAll('svg')) as any[]) {
              if (!seenSvgs.has(svg)) {
                seenSvgs.add(svg);
                svgs.push(svg);
              }
            }
          }
          const decorSvgs = svgs.filter((svg) => {
            const cls = String(svg.getAttribute('class') || '');
            if (cls.includes('lucide') || svg.closest('button, aside, nav, header, #ideas-splash-screen, .lucide')) {
              return false;
            }
            const cs = g.getComputedStyle(svg);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
            const r = svg.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const vb = svg.getAttribute('viewBox') || '';
            return [
              '0 0 1440 500',
              '0 0 1440 260',
              '0 0 280 96',
              '0 0 80 80',
              '0 0 64 64',
              '0 0 48 48',
            ].includes(vb);
          });

          const purpleMatches: string[] = [];
          for (const el of Array.from(scope?.querySelectorAll('button, a, [role="button"]') || []) as any[]) {
            const cs = g.getComputedStyle(el);
            const combined = `${cs.backgroundColor || ''} ${cs.borderColor || ''}`;
            if (combined.includes('124, 58, 237') || combined.includes('139, 92, 246')) {
              purpleMatches.push(el.tagName);
            }
          }

          let redHits = 0;
          for (const el of Array.from(scope?.querySelectorAll('*') || []) as any[]) {
            const tag = (el.tagName || '').toLowerCase();
            const cs = g.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const s = `${cs.backgroundColor || ''} ${cs.backgroundImage || ''} ${cs.borderColor || ''} ${cs.color || ''}`;
            const rgbHit = Array.from(
              s.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
            ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
            const hexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(s);
            if (rgbHit || hexHit) {
              redHits++;
              break;
            }
            if (tag === 'stop' || tag === 'path' || tag === 'rect' || tag === 'circle') {
              const attrColors = `${el.getAttribute('stop-color') || ''} ${el.getAttribute('fill') || ''} ${el.getAttribute('stroke') || ''}`;
              const attrRgbHit = Array.from(
                attrColors.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
              ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
              const attrHexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(attrColors);
              if (attrRgbHit || attrHexHit) {
                redHits++;
                break;
              }
            }
          }

          const datePickerBtn = Array.from(
            scope?.querySelectorAll('[data-testid="mkt-dashboard-date-picker"], [data-testid="open-date-picker"]') || []
          ).find((el: any) => {
            const cs = g.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });

          return {
            splashHasBg: splashImg.includes('fluent-brand-ambient-bg') || splashSource.includes('fluent-brand-ambient-bg'),
            sidebarText,
            hrefs,
            hasSidebarUpgradeLink,
            colorPrimaryVar: rootCs.getPropertyValue('--color-primary').trim().toLowerCase(),
            colorDangerVar: rootCs.getPropertyValue('--color-danger').trim().toLowerCase(),
            scopeFont: scopeCs?.fontFamily || '',
            decorSvgCount: decorSvgs.length,
            purpleCount: purpleMatches.length,
            redHits,
            hasDatePicker: Boolean(datePickerBtn),
          };
        });

        assert.equal(standaloneAudit.splashHasBg, true, 'Expected splash screen landing background image');
        assert.ok(standaloneAudit.sidebarText.includes('MARKETING AUTOMATION'));
        assert.ok(
          standaloneAudit.sidebarText.includes('DOM AUTOMATION') ||
            standaloneAudit.sidebarText.includes('Marketing Automation')
        );
        assert.equal(standaloneAudit.sidebarText.includes('Nâng cấp'), false);
        assert.equal(standaloneAudit.hasSidebarUpgradeLink, false);
        for (const allowed of ['/marketing', '/marketing/flows', '/marketing/campaigns', '/marketing/templates', '/settings', '/accounts', '/ai-training']) {
          assert.ok(standaloneAudit.hrefs.includes(allowed), `Expected ${allowed} in standalone sidebar`);
        }
        for (const hidden of ['/data', '/contacts', '/deals', '/rounds', '/rules', '/integrations']) {
          assert.equal(standaloneAudit.hrefs.includes(hidden), false, `Expected ${hidden} hidden in standalone sidebar`);
        }
        await assertLightSidebar(page, 'T4-02 standalone "/"');
        await assertStandardAppIcons(
          page,
          'aside.responsive-sidebar',
          14,
          38,
          'T4-02 standalone sidebar nav icons',
          'a.sidebar-nav-item svg'
        );
        await assertStandardAppIcons(page, 'main .mkt-scope', 32, 56, 'T4-02 standalone "/" AppIcons');

        assert.equal(standaloneAudit.colorPrimaryVar, '#1e40ff');
        assert.ok(standaloneAudit.colorDangerVar === '#dc2626' || standaloneAudit.colorDangerVar === '#ef4444');
        assert.ok(standaloneAudit.scopeFont.toLowerCase().includes('be vietnam pro'));
        assert.ok(standaloneAudit.decorSvgCount >= 1, 'Expected Domation SVG decorative accent');
        assert.equal(standaloneAudit.purpleCount, 0, 'Expected zero legacy purple accents');
        assert.ok(standaloneAudit.redHits >= 1, 'Expected red accent in Marketing UI');
        assert.equal(standaloneAudit.hasDatePicker, true, 'Expected visible unified date range filter on "/"');

        // Exercise unified date picker popover on standalone "/" and close cleanly
        const clickedMktDatePicker = await page.evaluate(() => {
          const g = globalThis as any;
          const doc = g.document;
          const scope = Array.from(doc.querySelectorAll('main .mkt-scope')).find(
            (el: any) =>
              el.style?.display !== 'contents' &&
              !(
                Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                el.querySelectorAll('button, a, input, select, textarea').length <= 1
              ) &&
              g.getComputedStyle(el).visibility !== 'hidden'
          ) as any;
          if (!scope) return false;
          const btn = Array.from(
            scope.querySelectorAll('[data-testid="mkt-dashboard-date-picker"], [data-testid="open-date-picker"]')
          ).find((el: any) => {
            const cs = g.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }) as any;
          if (!btn) return false;
          btn.scrollIntoView({ block: 'center' });
          btn.click();
          return true;
        });
        assert.equal(
          clickedMktDatePicker,
          true,
          'Expected clickable visible date-picker button inside active standalone .mkt-scope'
        );
        await page.waitForSelector('[data-testid="unified-date-picker-popover"]', { timeout: 5_000 });
        await page.keyboard.press('Escape');
        await sleep(150);

        // Exercise MarketingSpotlightTour (true M3 contract)
        const openMktTour = async () =>
          page!.evaluate(() => {
            const doc = (globalThis as any).document;
            const byTestId = doc.querySelector('[data-testid="open-mkt-tour"]') as any;
            if (byTestId) {
              byTestId.click();
              return true;
            }
            const byLabel = Array.from(doc.querySelectorAll('button')).find((b: any) =>
              (b.textContent || '').includes('Tour Hướng Dẫn')
            ) as any;
            if (byLabel) {
              byLabel.click();
              return true;
            }
            return false;
          });

        assert.equal(
          await openMktTour(),
          true,
          'Expected MarketingSpotlightTour trigger ([data-testid="open-mkt-tour"] or "Tour Hướng Dẫn") on /'
        );
        await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 8_000 });
        const tourState = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          const dialog = doc.querySelector('div[role="dialog"][aria-modal="true"]');
          return {
            tourTargetsCount: doc.querySelectorAll('[data-tour]').length,
            initialText: dialog?.innerText || '',
          };
        });
        assert.ok(tourState.tourTargetsCount >= 1, 'Expected [data-tour] targets');
        assert.equal(
          await clickButtonByText(page, 'Tiếp theo', { rootSelector: 'div[role="dialog"][aria-modal="true"]' }),
          true
        );
        await page.waitForFunction(
          (prev: string) =>
            ((globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]')?.innerText || '') !== prev,
          { timeout: 5_000 },
          tourState.initialText
        );
        assert.equal(
          await clickButtonByText(page, 'Quay lại', { rootSelector: 'div[role="dialog"][aria-modal="true"]' }),
          true
        );
        let finished = false;
        for (let i = 0; i < 12; i++) {
          if (await clickButtonByText(page, 'Hoàn tất', { rootSelector: 'div[role="dialog"][aria-modal="true"]' })) {
            finished = true;
            break;
          }
          await clickButtonByText(page, 'Tiếp theo', { rootSelector: 'div[role="dialog"][aria-modal="true"]' });
          await sleep(150);
        }
        assert.equal(finished, true, 'Expected to finish MarketingSpotlightTour');
        await page.waitForFunction(
          () => !(globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]'),
          { timeout: 5_000 }
        );
        const tourLsKeys = await page.evaluate(() => {
          const ls = (globalThis as any).localStorage;
          const hits: string[] = [];
          for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && /mkt.*tour|marketing.*tour/i.test(k) && ls.getItem(k)) hits.push(k);
          }
          return hits;
        });
        assert.ok(tourLsKeys.length >= 1, 'Expected MarketingSpotlightTour localStorage persistence');

        // Verify visible Upgrade CTA (<button> containing "Nâng cấp") inside /settings?tab=package_upgrade
        await navigateSpaRoute(page, '/settings?tab=package_upgrade');
        await page.waitForFunction(
          () => {
            const txt = (globalThis as any).document.querySelector('main')?.innerText || '';
            return txt.includes('Gói dịch vụ') && txt.includes('Nâng cấp');
          },
          { timeout: 15_000 }
        );
        const settingsUpgradeCheck = await page.evaluate(() => {
          const g = globalThis as any;
          const main = g.document.querySelector('main');
          const btns = Array.from(main?.querySelectorAll('button') || []) as any[];
          const upgradeBtns = btns.filter((b) => {
            if (!(b.textContent || '').includes('Nâng cấp')) return false;
            const cs = g.getComputedStyle(b);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          return {
            hasUpgradePanelText: (main?.innerText || '').includes('Gói dịch vụ'),
            upgradeBtnCount: upgradeBtns.length,
          };
        });
        assert.equal(settingsUpgradeCheck.hasUpgradePanelText, true, 'Expected "Gói dịch vụ" in /settings?tab=package_upgrade');
        assert.ok(
          settingsUpgradeCheck.upgradeBtnCount >= 1,
          `Expected visible <button> containing "Nâng cấp" inside /settings?tab=package_upgrade, got: ${JSON.stringify(settingsUpgradeCheck)}`
        );

        // Seed Contact, Audience, Template & Campaign, Send, Track Open/Click & Verify Measurement Drawer
        const contact = await harness.apiJson('/api/v1/audiences/contacts', {
          method: 'POST',
          auth,
          body: { name: 'SC2 Reader', email: 'sc2.reader@test.vn', email_consent: 'subscribed' },
        });
        const aud = await harness.apiJson('/api/v1/audiences', {
          method: 'POST',
          auth,
          body: { name: 'SC2 Aud', audience_type: 'static_data', lead_ids: [contact.data.id] },
        });
        const tplName = 'SC2 Onboarding Template';
        const tpl = await harness.apiJson('/api/v1/marketing/templates', {
          method: 'POST',
          auth,
          body: {
            name: tplName,
            subject: 'SC2 Welcome',
            compiled_html: '<p>Welcome</p><a href="https://example.com/s2-offer">Offer</a>',
          },
        });
        const campName = 'SC2 First Campaign';
        const camp = await harness.apiJson('/api/v1/marketing/campaigns', {
          method: 'POST',
          auth,
          body: {
            name: campName,
            channel: 'email',
            audience_id: aud.data.id,
            template_id: tpl.data.id,
            subject_a: 'SC2 Launch',
          },
        });
        const campId = String(camp.data.id);

        const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
          method: 'POST',
          auth,
          body: {},
        });
        assert.equal(sendRes.data.newly_sent, 1);
        const claimId = String(sendRes.data.claim_ids[0]);
        assert.ok(harness.emailCapture.length >= 1);

        const openRes = await fetch(`${harness.baseUrl}/api/v1/public/marketing/track/open/${claimId}`);
        assert.equal(openRes.status, 200);
        assert.ok(String(openRes.headers.get('content-type') || '').includes('image/gif'));

        const clickRes = await fetch(
          `${harness.baseUrl}/api/v1/public/marketing/track/click/${claimId}?url=${encodeURIComponent('https://example.com/s2-offer')}&json=1`
        );
        assert.equal(clickRes.status, 200);

        const detailRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth });
        assert.equal(detailRes.data.funnel.opened, 1);
        assert.equal(detailRes.data.funnel.clicked, 1);
        assert.equal(detailRes.data.campaign.open_rate_pct, 100);
        assert.equal(detailRes.data.campaign.click_rate_pct, 100);

        // Open CampaignDetailDrawer in UI
        await navigateSpaRoute(page, '/marketing/campaigns');
        await page.waitForFunction(
          (name: string) => ((globalThis as any).document.body.innerText || '').includes(name),
          { timeout: 15_000 },
          campName
        );
        const clickedRow = await page.evaluate((name: string) => {
          const rows = Array.from((globalThis as any).document.querySelectorAll('tr, div.cursor-pointer')) as any[];
          const row = rows.find((r) => (r.textContent || '').includes(name));
          if (!row) return false;
          row.scrollIntoView({ block: 'center' });
          row.click();
          return true;
        }, campName);
        assert.equal(clickedRow, true);
        await page.waitForSelector('.campaign-detail-drawer', { timeout: 15_000 });
        const drawerTxt = (
          await page.evaluate(
            () => (globalThis as any).document.querySelector('.campaign-detail-drawer')?.innerText || ''
          )
        ).toLowerCase();
        assert.ok(drawerTxt.includes('tỷ lệ mở') || drawerTxt.includes('open rate'));
        assert.ok(drawerTxt.includes('tỷ lệ click') || drawerTxt.includes('ctr'));
        assert.ok(drawerTxt.includes('phễu chuyển đổi') || drawerTxt.includes('funnel'));
        await page.keyboard.press('Escape');
        await sleep(200);

        // 1-Click Upgrade to domation_promax + reload + verify CRM/Meta/CAPI unlocked & marketing data preserved
        const upg = await harness.upgradePackage(auth, 'domation_promax', {
          billingCycle: 'monthly',
          paymentMethod: 'wallet',
        });
        assert.equal(upg.upgraded, true);

        await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/v1/myerp/tenant-config') && r.status() === 200,
            { timeout: 20_000 }
          ),
          page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
        ]);
        await waitForAppReady(page, 25_000);

        await page.waitForFunction(
          () => {
            const sb = (globalThis as any).document.querySelector('aside.responsive-sidebar');
            return Boolean(sb?.querySelector('a[href="/data"]'));
          },
          { timeout: 20_000 }
        );
        const postUpgradeHrefs = await page.evaluate(() =>
          Array.from((globalThis as any).document.querySelectorAll('aside.responsive-sidebar a[href]')).map((a: any) =>
            a.getAttribute('href')
          )
        );
        assert.ok(postUpgradeHrefs.includes('/data'));
        assert.ok(postUpgradeHrefs.includes('/meta-report') || postUpgradeHrefs.includes('/marketing/meta-report'));
        assert.ok(postUpgradeHrefs.includes('/capi') || postUpgradeHrefs.includes('/marketing/capi'));

        await navigateSpaRoute(page, '/data');
        await page.waitForFunction(
          () =>
            (globalThis as any).location.pathname === '/data' &&
            ((globalThis as any).document.querySelector('main')?.innerText || '').includes('Quản lý Data'),
          { timeout: 15_000 }
        );
        await assertLightSidebar(page, 'T4-02 post-upgrade /data');
        await assertStandardAppIcons(
          page,
          'aside.responsive-sidebar',
          14,
          38,
          'T4-02 /data sidebar nav icons',
          'a.sidebar-nav-item svg'
        );
        await assertVisibleDatePicker(page, 'main [data-testid="erp-datalist-date-picker"]', 'T4-02 /data');
        await assertErpQuickNavRedAccent(page, 'T4-02 /data');

        await navigateSpaRoute(page, '/meta-report');
        const metaCheck = await waitForMainRouteReady(page, '/meta-report', 15_000);
        assert.equal(metaCheck.hasAccessDenied, false);
        assert.equal(metaCheck.hasErrorBoundary, false);
        const metaFont = await page.evaluate(() => {
          const g = globalThis as any;
          const el = g.document.querySelector('main .dom-meta-scope');
          return el ? g.getComputedStyle(el).fontFamily : '';
        });
        assert.ok(
          metaFont.toLowerCase().includes('be vietnam pro'),
          `Expected Be Vietnam Pro on .dom-meta-scope, got: ${metaFont}`
        );
        await assertVisibleDatePicker(page, 'main [data-testid="open-date-picker"]', 'T4-02 /meta-report');

        await navigateRoute(page, '/capi');
        const capiCheck = await waitForMainRouteReady(page, '/capi', 15_000);
        assert.equal(capiCheck.hasAccessDenied, false);
        assert.equal(capiCheck.hasErrorBoundary, false);
        assert.equal(
          capiCheck.hasVisibleMktScope,
          true,
          'Expected visible main .mkt-scope wrapper on /capi (true M3 contract)'
        );

        await navigateSpaRoute(page, '/marketing/templates');
        await page.waitForFunction(
          (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
          { timeout: 15_000 },
          tplName
        );
        await navigateSpaRoute(page, '/marketing/campaigns');
        await page.waitForFunction(
          (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
          { timeout: 15_000 },
          campName
        );

        assertCleanRuntime(page, netGuard, 'T4-02 Standalone Onboarding & Upgrade');
      } finally {
        harness.setSmtpCaptureEnabled(true);
        if (page) {
          await bh.closePage(page);
        }
      }
    }
  );

  it(
    'T4-03: Survey Quiz Auto-Segmentation & ZNS Follow-up (Public Quiz -> redirect_rules tag persistence -> Segment -> ZNS Flow + Master Cron)',
    { timeout: 60_000 },
    async () => {
      const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
      await configureZnsVault(auth, 'zns_live_sc3_tok');

      await harness.apiJson('/api/v1/marketing/social-bot/zalo-templates', {
        method: 'POST',
        auth,
        body: { name: 'Quiz VIP ZNS', template_code: 'ZNS_QUIZ_VIP', content_body: 'Chào {{customer_name}}' },
      });

      const surveyRes = await harness.apiJson('/api/v1/marketing/surveys', {
        method: 'POST',
        auth,
        body: {
          title: 'SC3 VIP Readiness Quiz',
          survey_type: 'quiz',
          blocks: [
            { id: 'q1', type: 'quiz_scored', label: 'Budget?', correctValue: 'high', points: 30 },
            { id: 'nps1', type: 'nps', label: 'Score?' },
          ],
          settings: { base_lead_score: 10, auto_tag: 'Quiz Done' },
          redirect_rules: [
            {
              minScore: 50,
              maxScore: 100,
              assignTag: 'VIP Quiz Tier',
              redirectUrl: 'https://domation.net/quiz-vip',
            },
          ],
        },
      });
      const slug = String(surveyRes.data.slug);

      const segRes = await harness.apiJson('/api/v1/audiences', {
        method: 'POST',
        auth,
        body: {
          name: 'SC3 VIP Quiz Seg',
          audience_type: 'dynamic_logic',
          filter_branches: [
            {
              join: 'AND',
              rules: [
                { field: 'tag', op: 'equals', value: 'VIP Quiz Tier' },
                { field: 'quiz_score', op: 'gte', value: 50 },
              ],
            },
          ],
        },
      });
      const segId = String(segRes.data.id);

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'SC3 ZNS Quiz Follow-up',
          status: 'active',
          trigger_type: 'audience_joined',
          trigger_config: { audience_id: segId },
          steps: [
            {
              id: 'w1',
              type: 'wait_delay',
              label: 'Wait 0.005m',
              config: { duration: 0.005, unit: 'minutes', pause_execution: true },
              nextStepId: 'z1',
            },
            {
              id: 'z1',
              type: 'send_zns',
              label: 'Send ZNS VIP',
              config: { template_id: 'ZNS_QUIZ_VIP', subject: 'Chúc mừng {{lead.name}} đạt VIP Quiz!' },
            },
          ],
        },
      });
      const flowId = String(flowRes.data.id);

      const pubGet = await harness.apiJson(`/api/v1/public/marketing/surveys/${slug}`);
      assert.equal(pubGet.data.blocks.length, 2);

      const subRes = await harness.apiRaw(`/api/v1/public/marketing/surveys/${slug}`, {
        method: 'POST',
        body: {
          tenant_slug: auth.tenantSlug,
          name: 'Quiz ZNS Lead',
          email: 'quizzns@test.vn',
          phone: '0909200300',
          answers: { q1: 'high', nps1: 10 },
        },
      });
      assert.equal(subRes.status, 201);
      assert.equal(subRes.json?.data?.quiz_score, 55);
      assert.ok(subRes.json?.data?.tags_applied?.includes('VIP Quiz Tier'));
      assert.ok(subRes.json?.data?.tags_applied?.includes('NPS Promoter'));
      assert.ok(subRes.json?.data?.tags_applied?.includes('Quiz Done'));

      const contactsRes = await harness.apiJson('/api/v1/audiences/contacts?search=quizzns%40test.vn', { auth });
      const tagNames = (contactsRes.data.items[0]?.tags || []).map((t: any) => t.name);
      assert.ok(tagNames.includes('VIP Quiz Tier'));

      const evalRes = await harness.apiJson(`/api/v1/audiences/${segId}/evaluate`, {
        method: 'POST',
        auth,
        body: {},
      });
      // Survey submission already emits marketing.engaged -> auto-evaluates dynamic segments
      assert.equal(evalRes.data.total_count, 1);

      const flowBefore = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.equal(flowBefore.data.enrollments[0]?.status, 'waiting');

      await sleep(450);
      const cronRes = await harness.triggerMasterCron(['marketing_flows'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.ok(Number(cronRes.stats.marketingFlowsProcessed || 0) >= 1);

      const flowAfter = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.equal(flowAfter.data.enrollments[0]?.status, 'completed');

      assert.equal(
        harness.zaloCapture.some(
          (z) =>
            z.channel === 'zns' &&
            z.url.includes('business.openapi.zalo.me') &&
            z.body?.template_id === 'ZNS_QUIZ_VIP' &&
            z.body?.phone === '84909200300'
        ),
        true
      );
    }
  );

  it(
    'T4-04: Web Tracking Anonymous-to-Known Stitching & Pricing Intent Flow (/sdk.js + /track -> retroactive stitch -> page_visited Flow + Outbound Webhook)',
    { timeout: 60_000 },
    async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });
      const { scheduleStage } = await getDefaultPipelineStages(auth);

      const propRes = await harness.apiJson('/api/v1/marketing/web-tracking/properties', {
        method: 'POST',
        auth,
        body: {
          name: 'Pricing Site',
          domain: 'pricing.test.vn',
          pricing_url_pattern: '/pricing,/bang-gia',
          auto_alert_pricing: true,
        },
      });
      const propId = String(propRes.data.id);
      const siteKey = String(propRes.data.site_key);

      const whRes = await harness.apiJson('/api/v1/integrations/webhooks', {
        method: 'POST',
        auth,
        body: {
          name: 'Pricing Webhook',
          webhook_type: 'outbound',
          url: harness.webhookSink.url,
          subscribed_events: ['lead.stage_changed', 'lead.created'],
          is_active: true,
        },
      });
      const signingSecret = String(whRes.data.signing_secret || '');

      await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'SC4 Pricing Intent Flow',
          status: 'active',
          trigger_type: 'page_visited',
          steps: [
            {
              id: 'wh1',
              type: 'webhook_http',
              label: 'Notify Pricing Intent',
              config: { url: harness.webhookSink.url, method: 'POST' },
              nextStepId: 'tag1',
            },
            {
              id: 'tag1',
              type: 'add_remove_tag',
              label: 'Tag Pricing Intent',
              config: { tag: 'pricing-intent-hot', mode: 'add' },
            },
          ],
        },
      });

      const formRes = await harness.apiJson('/api/v1/marketing/forms', {
        method: 'POST',
        auth,
        body: {
          name: 'Web Lead Form',
          fields: [
            { id: 'n', key: 'name', label: 'Name', type: 'text' },
            { id: 'e', key: 'email', label: 'Email', type: 'email', required: true },
          ],
        },
      });
      const formToken = String(formRes.data.public_token);

      const sdkRes = await harness.apiRaw('/api/v1/public/marketing/sdk.js', {
        method: 'GET',
        query: { site_key: siteKey },
      });
      assert.equal(sdkRes.status, 200);
      assert.ok(String(sdkRes.headers.get('content-type') || '').includes('javascript'));
      assert.ok(sdkRes.rawText.includes(siteKey));
      assert.ok(sdkRes.rawText.includes('/api/v1/public/marketing/track'));

      const homeUrl = 'https://pricing.test.vn/home';
      const ev1 = await harness.apiRaw('/api/v1/public/marketing/track', {
        method: 'POST',
        body: { site_key: siteKey, visitor_token: 'vis_sc4_anon', event_type: 'pageview', page_url: homeUrl },
      });
      assert.equal(ev1.status, 201);
      assert.equal(ev1.json?.data?.stitched, false);
      assert.equal(ev1.json?.data?.lead_id, null);

      const ev2 = await harness.apiRaw('/api/v1/public/marketing/track', {
        method: 'POST',
        body: {
          site_key: siteKey,
          visitor_token: 'vis_sc4_anon',
          event_type: 'click',
          page_url: homeUrl,
          x_pct: 50,
          y_pct: 30,
          element_selector: 'A.pricing',
        },
      });
      assert.equal(ev2.status, 201);

      const subRes = await harness.apiRaw(`/api/v1/public/marketing/forms/${formToken}/submit`, {
        method: 'POST',
        body: { name: 'Pricing Visitor', email: 'pricing.sc4@test.vn' },
      });
      assert.equal(subRes.status, 201);
      const leadId = String(subRes.json?.data?.lead_id);

      const ev3 = await harness.apiRaw('/api/v1/public/marketing/track', {
        method: 'POST',
        body: {
          site_key: siteKey,
          visitor_token: 'vis_sc4_anon',
          event_type: 'identify',
          page_url: 'https://pricing.test.vn/pricing',
          email: 'pricing.sc4@test.vn',
        },
      });
      assert.equal(ev3.status, 201);
      assert.equal(ev3.json?.data?.stitched, true);
      assert.equal(ev3.json?.data?.lead_id, leadId);
      assert.equal(ev3.json?.data?.pricing_intent_detected, true);

      const pageDetails = await harness.apiJson(
        `/api/v1/marketing/web-tracking/page-details?page_url=${encodeURIComponent(homeUrl)}`,
        { auth }
      );
      assert.equal(pageDetails.data.identified_leads, 1);

      const sessions = await harness.apiJson(
        `/api/v1/marketing/web-tracking/sessions?property_id=${encodeURIComponent(propId)}&pricing_intent=true`,
        { auth }
      );
      assert.ok(sessions.data.items.length >= 1);
      assert.ok(Number(sessions.data.items[0].lead_score) >= 15);
      assert.equal(sessions.data.items[0].pricing_intent_detected, true);

      const flowDeliveries = await harness.webhookSink.waitForDeliveries(1, 3000);
      assert.ok(flowDeliveries.some((d) => JSON.stringify(d.json).includes(leadId) || JSON.stringify(d.json).includes('pricing.sc4@test.vn')));

      const contacts = await harness.apiJson('/api/v1/audiences/contacts?search=pricing.sc4%40test.vn', { auth });
      const tagNames = (contacts.data.items[0]?.tags || []).map((t: any) => t.name);
      assert.ok(tagNames.includes('pricing-intent-hot'));

      await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
        method: 'PATCH',
        auth,
        body: { stage_id: scheduleStage.id, note: 'SC4 Stage HMAC Check' },
      });
      const allDeliveries = await harness.webhookSink.waitForDeliveries(2, 3000);
      const stageDelivery = allDeliveries.find((d) => d.headers['x-autodata-event'] === 'lead.stage_changed');
      assert.ok(stageDelivery);
      assert.equal(stageDelivery!.headers['x-autodata-signature-256'], signHmacHex(stageDelivery!.rawBody, signingSecret));
    }
  );

  it(
    'T4-05: AI Chatbot RAG Training -> Contact Extraction -> CRM Sale Round & Flow Trigger',
    { timeout: 60_000 },
    async () => {
      const auth = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });

      const saleUserRes = await harness.apiJson('/api/v1/users', {
        method: 'POST',
        auth,
        body: {
          full_name: 'Sale Bot Receiver',
          email: `sale.sc5@${auth.tenantSlug}.vn`,
          password: 'SalePassword123!',
          role: 'sale',
          is_available: true,
        },
      });
      const saleUserId = String(saleUserRes.data.id);

      const botOverview = await harness.apiJson('/api/v1/marketing/social-bot', { auth });
      const roundId = String(botOverview.data.rounds[0].id);
      assert.ok(roundId);

      const docRes = await harness.apiJson('/api/v1/marketing/social-bot/training-docs', {
        method: 'POST',
        auth,
        body: {
          title: 'Chính sách bảo hành Diamond 2026',
          doc_type: 'policy',
          content_text: 'Gói Diamond được bảo hành VIP 24 tháng tận nơi và tặng kèm tư vấn 1-1.',
        },
      });
      assert.equal(docRes.data.status, 'indexed');

      await harness.apiJson('/api/v1/marketing/social-bot/bot-config', {
        method: 'PUT',
        auth,
        body: {
          bot_name: 'DOM RAG Bot',
          auto_extract_contact: true,
          routing_mode: 'sale_round',
          distribution_round_id: roundId,
          is_active: true,
        },
      });

      const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
        method: 'POST',
        auth,
        body: {
          name: 'Social Inbound Flow',
          status: 'active',
          trigger_type: 'webhook_received',
          steps: [
            {
              id: 't1',
              type: 'add_remove_tag',
              label: 'Tag Chat Lead',
              config: { tag: 'chatbot-rag-lead', mode: 'add' },
            },
          ],
        },
      });
      const flowId = String(flowRes.data.id);

      const inboundRes = await harness.apiRaw(`/api/v1/public/marketing/social/inbound/${auth.tenantSlug}`, {
        method: 'POST',
        body: {
          channel: 'web_chat',
          thread_id: 'wc_sc5_01',
          customer_name: 'Chị Lan Chat',
          message: 'Cho mình hỏi Chính sách bảo hành Diamond 2026 nhé, sđt mình 0912333444 email lan.chat@test.vn',
        },
      });
      assert.equal(inboundRes.status, 201);
      assert.equal(inboundRes.json?.data?.extracted?.phone, '0912333444');
      assert.equal(inboundRes.json?.data?.extracted?.email, 'lan.chat@test.vn');
      const leadId = String(inboundRes.json?.data?.lead_id);
      assert.ok(leadId);
      assert.ok(String(inboundRes.json?.data?.reply || '').includes('24 tháng'));

      const leadsRes = await harness.apiJson('/api/v1/leads?search=lan.chat%40test.vn', { auth });
      const crmLead = (leadsRes.data.items || []).find((l: any) => l.id === leadId);
      assert.ok(crmLead);
      assert.equal(crmLead.status, 'assigned');
      assert.equal(crmLead.assigned_sale?.id, saleUserId);

      const flowDetail = await harness.apiJson(`/api/v1/marketing/flows/${flowId}`, { auth });
      assert.equal(
        flowDetail.data.enrollments.some((e: any) => e.lead_id === leadId && e.status === 'completed'),
        true
      );

      const contacts = await harness.apiJson('/api/v1/audiences/contacts?search=lan.chat%40test.vn', { auth });
      const tagNames = (contacts.data.items[0]?.tags || []).map((t: any) => t.name);
      assert.ok(tagNames.includes('chatbot-rag-lead'));
    }
  );

  it(
    'T4-06: Portal-Embedded Mode + Legacy Compat .php Client + CAPI 503 Failure & Retry Closed Loop + Measurement UI',
    { timeout: 120_000 },
    async () => {
      const auth = await harness.registerTenant({
        packageCode: 'domation_promax',
        industry: 'real_estate',
        seedDemoLeads: false,
      });
      await setupCapiVault(auth, 'TEST_SC6');
      const { scheduleStage } = await getDefaultPipelineStages(auth);

      // Part A: Legacy Compat .php Client parity
      const tenantCfg = await harness.apiJson('/api/v1/myerp/tenant-config', { auth });
      assert.equal(tenantCfg.data.package_code, 'domation_promax');

      const compatChecks = [
        await harness.apiRaw('/api/v1/myerp/automation/templates.php', {
          method: 'POST',
          auth,
          body: { name: 'Compat SC6 Tpl', subject: 'Hi', compiled_html: '<p>Compat</p>' },
        }),
        await harness.apiRaw('/api/v1/myerp/automation/campaigns.php', {
          method: 'POST',
          auth,
          body: { name: 'Compat SC6 Camp', channel: 'email', subject_a: 'Compat Sub' },
        }),
        await harness.apiRaw('/api/v1/myerp/automation/flows.php', {
          method: 'POST',
          auth,
          body: {
            name: 'Compat SC6 Flow',
            trigger_type: 'manual_enroll',
            steps: [{ id: 's1', type: 'update_lead_score', config: { delta: 5 } }],
          },
        }),
        await harness.apiRaw('/api/v1/myerp/automation/segments.php?action=preview', {
          method: 'POST',
          auth,
          body: { filter_branches: [] },
        }),
        await harness.apiRaw('/api/v1/myerp/automation/voucher_campaigns.php', {
          method: 'POST',
          auth,
          body: { name: 'Compat SC6 Voucher', code_prefix: 'SC6' },
        }),
        await harness.apiRaw('/api/v1/myerp/automation/links_qr.php', {
          method: 'POST',
          auth,
          body: { title: 'Compat SC6 Link', target_url: 'https://domation.net/sc6' },
        }),
        await harness.apiRaw('/api/v1/myerp/automation/campaigns.php?route=pre_send_review', {
          method: 'POST',
          auth,
          body: { channel: 'email', subject_a: 'Compat Review Subject' },
        }),
        await harness.apiRaw('/api/v1/myerp/automation/overview_stats.php', { auth }),
        await harness.apiRaw('/backend/automation/flows.php', { auth }),
      ];

      for (const resp of compatChecks) {
        assert.ok(resp.status === 200 || resp.status === 201, `Expected 200/201 from compat endpoint, got ${resp.status}`);
        assert.notEqual(resp.headers.get('x-myerp-compat'), 'unmapped');
      }

      // Part B: CAPI 503 Injection -> Overview Log -> Retry Recovery + Cron clean run
      const leadRes = await harness.apiJson('/api/v1/leads', {
        method: 'POST',
        auth,
        body: { name: 'CAPI 503 Lead', phone: '0909600700', email: 'capi503.sc6@test.vn' },
      });
      const leadId = String(leadRes.data.id || leadRes.data.lead_id);

      try {
        harness.mockFetch.setFailureMode({ metaCapiStatus: 503, metaErrorMessage: 'Service Unavailable' });
        const failStageRes = await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
          method: 'PATCH',
          auth,
          body: { stage_id: scheduleStage.id, note: 'Trigger 503 CAPI' },
        });
        assert.equal(failStageRes.data.capi_dispatched?.status, 503);
      } finally {
        harness.mockFetch.resetFailureModes();
      }

      const overviewBefore = await harness.apiJson('/api/v1/integrations/overview', { auth });
      const failedLog = (overviewBefore.data.capi_logs || []).find(
        (l: any) => l.lead_id === leadId && Number(l.response_status) === 503
      );
      assert.ok(failedLog?.id, 'Expected 503 capi_logs row in /integrations/overview');

      const retryRes = await harness.apiJson(`/api/v1/integrations/capi/retry/${failedLog.id}`, {
        method: 'POST',
        auth,
        body: {},
      });
      assert.equal(retryRes.data.retried, true);
      assert.equal(retryRes.data.meta_http_status, 200);

      const cronRes = await harness.triggerMasterCron(['capi'], auth.tenantId);
      assert.equal(cronRes.status, 200);
      assert.deepEqual(cronRes.stats.errors || [], []);

      const overviewAfter = await harness.apiJson('/api/v1/integrations/overview', { auth });
      assert.equal(
        (overviewAfter.data.capi_logs || []).some((l: any) => l.lead_id === leadId && Number(l.response_status) === 200),
        true
      );
      assert.ok(harness.capiCapture.some((c) => c.httpStatus === 503));
      assert.ok(harness.capiCapture.some((c) => c.httpStatus === 200));

      // Part C: Browser Portal-Embedded Sync & CAPI Measurement UI Verification
      const bh = await ensureBrowserHarness();
      let page: Page | undefined;

      try {
        page = await bh.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'domation_promax',
          },
          '/'
        );
        const netGuard = attachNetworkGuard(page);

        await waitForAppReady(page, 30_000);
        const rootCheck = await page.evaluate(() => {
          const doc = (globalThis as any).document;
          const hrefs = Array.from(doc.querySelectorAll('aside.responsive-sidebar a[href]')).map((a: any) =>
            a.getAttribute('href')
          );
          const hasMktHeroAtRoot = Array.from(doc.querySelectorAll('.mkt-scope h1')).some((h: any) =>
            (h.textContent || '').includes('Marketing & Đa kênh')
          );
          return { hrefs, hasMktHeroAtRoot };
        });
        assert.equal(rootCheck.hasMktHeroAtRoot, false);
        assert.ok(rootCheck.hrefs.includes('/data'));
        assert.ok(rootCheck.hrefs.includes('/marketing'));
        await assertLightSidebar(page, 'T4-06 portal "/"');
        await assertStandardAppIcons(
          page,
          'aside.responsive-sidebar',
          14,
          38,
          'T4-06 portal "/" sidebar nav icons',
          'a.sidebar-nav-item svg'
        );

        await navigateSpaRoute(page, '/data');
        await page.waitForFunction(
          () =>
            (globalThis as any).location.pathname === '/data' &&
            ((globalThis as any).document.querySelector('main')?.innerText || '').includes('Quản lý Data'),
          { timeout: 15_000 }
        );
        await assertLightSidebar(page, 'T4-06 /data');
        await assertVisibleDatePicker(page, 'main [data-testid="erp-datalist-date-picker"]', 'T4-06 /data');
        await assertErpQuickNavRedAccent(page, 'T4-06 /data');

        await navigateSpaRoute(page, '/marketing');
        const mktRes = await waitForMainRouteReady(page, '/marketing', 25_000);
        assert.equal(mktRes.hasAccessDenied, false);
        assert.equal(mktRes.hasErrorBoundary, false);
        assert.equal(mktRes.hasVisibleMktScope, true);
        await assertStandardAppIcons(page, 'main .mkt-scope', 32, 56, 'T4-06 /marketing AppIcons');
        await assertVisibleDatePicker(
          page,
          'main .mkt-scope [data-testid="mkt-dashboard-date-picker"], main .mkt-scope [data-testid="open-date-picker"]',
          'T4-06 /marketing'
        );

        await navigateRoute(page, '/meta-report');
        const metaRes = await waitForMainRouteReady(page, '/meta-report', 15_000);
        assert.equal(metaRes.hasAccessDenied, false);
        assert.equal(metaRes.hasErrorBoundary, false);
        const metaFont = await page.evaluate(() => {
          const g = globalThis as any;
          const el = g.document.querySelector('main .dom-meta-scope');
          return el ? g.getComputedStyle(el).fontFamily : '';
        });
        assert.ok(
          metaFont.toLowerCase().includes('be vietnam pro'),
          `Expected Be Vietnam Pro on /meta-report .dom-meta-scope, got: ${metaFont}`
        );
        await assertVisibleDatePicker(page, 'main [data-testid="open-date-picker"]', 'T4-06 /meta-report');

        await navigateRoute(page, '/capi');
        const capiRes = await waitForMainRouteReady(page, '/capi', 20_000);
        assert.equal(capiRes.hasAccessDenied, false);
        assert.equal(capiRes.hasErrorBoundary, false);
        assert.equal(capiRes.hasVisibleMktScope, true, 'Expected .mkt-scope wrapper on /capi (true M3 contract)');
        const capiUiText = await page.evaluate(() => (globalThis as any).document.querySelector('main')?.innerText || '');
        assert.ok(capiUiText.includes('Meta Conversions API (CAPI)'));
        assert.ok(capiUiText.includes('TỔNG SỰ KIỆN ĐÃ BẮN'));
        assert.ok(capiUiText.includes('TỶ LỆ ĐỒNG BỘ 2XX'));
        assert.ok(capiUiText.includes('TÍN HIỆU KHỚP (EMQ)'));
        assert.ok(capiUiText.includes('DOANH THU PURCHASE CAPI'));

        assertCleanRuntime(page, netGuard, 'T4-06 Portal-Embedded & CAPI UI');
      } finally {
        if (page) {
          await bh.closePage(page);
        }
      }
    }
  );

  it(
    'T4-07: Voucher Claim, Shortlink Deduplicated Attribution & Multi-Tenant RLS Isolation',
    { timeout: 60_000 },
    async () => {
      const tenantA = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });
      const tenantB = await harness.registerTenant({ packageCode: 'growth_combo', seedDemoLeads: false });
      const { wonStage } = await getDefaultPipelineStages(tenantA);

      const shortCode = `sc7${Date.now().toString(36)}`;
      const linkRes = await harness.apiJson('/api/v1/marketing/vouchers/shortlinks', {
        method: 'POST',
        auth: tenantA,
        body: {
          title: 'SC7 Promo Link',
          target_url: 'https://domation.net/sc7',
          short_code: shortCode,
          utm_source: 'facebook',
          utm_medium: 'cpc',
          utm_campaign: 'sc7',
        },
      });
      const linkId = String(linkRes.data.id);

      for (let i = 0; i < 3; i++) {
        const hit = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}`, {
          redirect: 'manual',
          headers: { 'X-Forwarded-For': '203.0.113.71', 'User-Agent': 'SC7Visitor1/1.0' },
        });
        assert.equal(hit.status, 302);
      }
      const hit2 = await fetch(`${harness.baseUrl}/api/v1/public/marketing/r/${shortCode}`, {
        redirect: 'manual',
        headers: { 'X-Forwarded-For': '203.0.113.72', 'User-Agent': 'SC7Visitor2/1.0' },
      });
      assert.equal(hit2.status, 302);

      const vListA = await harness.apiJson('/api/v1/marketing/vouchers', { auth: tenantA });
      const slRow = (vListA.data.shortlinks || []).find((s: any) => s.id === linkId);
      assert.equal(slRow?.click_count, 4);
      assert.equal(slRow?.unique_click_count, 2);

      const analyticsA = await harness.apiJson(
        `/api/v1/marketing/vouchers/clicks-analytics?short_link_id=${encodeURIComponent(linkId)}`,
        { auth: tenantA }
      );
      assert.equal(analyticsA.data.total_clicks, 4);
      assert.equal(analyticsA.data.unique_visitors, 2);

      const poolRes = await harness.apiJson('/api/v1/marketing/vouchers', {
        method: 'POST',
        auth: tenantA,
        body: {
          name: 'SC7 100K Off',
          code_prefix: 'SC7',
          discount_type: 'fixed_vnd',
          discount_value: 100000,
          min_order_vnd: 500000,
          auto_generate_count: 2,
        },
      });
      const poolId = String(poolRes.data.id);
      const poolSlug = String(poolRes.data.slug);

      const claimRes = await harness.apiRaw(`/api/v1/public/marketing/vouchers/${poolSlug}/claim`, {
        method: 'POST',
        body: { name: 'Voucher Attrib Buyer', phone: '0909700800', email: 'attrib.sc7@test.vn' },
      });
      assert.equal(claimRes.status, 201);
      const claimedCode = String(claimRes.json?.data?.code);
      const leadId = String(claimRes.json?.data?.lead_id);

      const redeem1 = await harness.apiJson('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth: tenantA,
        body: { code: claimedCode, order_vnd: 1_200_000 },
      });
      assert.equal(redeem1.data.discount_value, 100000);

      const redeem2 = await harness.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth: tenantA,
        body: { code: claimedCode, order_vnd: 1_200_000 },
      });
      assert.equal(redeem2.status, 400);
      assert.equal(redeem2.json?.error?.code, 'CODE_ALREADY_REDEEMED');

      await configureResendEmail(tenantA, 'sc7@e2e.vn');
      harness.setSmtpCaptureEnabled(false);

      let campId = '';
      try {
        await harness.apiJson('/api/v1/audiences/contacts', {
          method: 'POST',
          auth: tenantA,
          body: {
            name: 'Voucher Attrib Buyer',
            phone: '0909700800',
            email: 'attrib.sc7@test.vn',
            email_consent: 'subscribed',
          },
        });
        const audRes = await harness.apiJson('/api/v1/audiences', {
          method: 'POST',
          auth: tenantA,
          body: { name: 'SC7 Attrib Aud', audience_type: 'static_data', lead_ids: [leadId] },
        });
        const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
          method: 'POST',
          auth: tenantA,
          body: {
            name: 'SC7 Tpl',
            subject: 'SC7 Promo',
            compiled_html: '<p>Promo</p><a href="https://domation.net/sc7">Go</a>',
          },
        });
        const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
          method: 'POST',
          auth: tenantA,
          body: {
            name: 'SC7 Attrib Camp',
            channel: 'email',
            audience_id: audRes.data.id,
            template_id: tplRes.data.id,
            subject_a: 'SC7 Deal',
          },
        });
        campId = String(campRes.data.id);

        const sendRes = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/send`, {
          method: 'POST',
          auth: tenantA,
          body: {},
        });
        const claimId = String(sendRes.data.claim_ids[0]);

        const clickRes = await fetch(
          `${harness.baseUrl}/api/v1/public/marketing/track/click/${claimId}?url=${encodeURIComponent('https://domation.net/sc7')}`,
          { redirect: 'manual' }
        );
        assert.equal(clickRes.status, 302);

        await harness.apiJson(`/api/v1/leads/${leadId}/stage`, {
          method: 'PATCH',
          auth: tenantA,
          body: { stage_id: wonStage.id, deal_value_vnd: 25_000_000 },
        });

        await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/attribute-revenue`, {
          method: 'POST',
          auth: tenantA,
          body: {},
        });

        const detailA = await harness.apiJson(`/api/v1/marketing/campaigns/${campId}/detail`, { auth: tenantA });
        assert.equal(detailA.data.campaign.attributed_revenue_vnd, 25_000_000);
        assert.equal(detailA.data.funnel.sent, 1);
        assert.equal(detailA.data.funnel.opened, 1);
        assert.equal(detailA.data.funnel.clicked, 1);
      } finally {
        harness.setSmtpCaptureEnabled(true);
      }

      // Cross-tenant RLS isolation checks as tenantB
      const bRedeem = await harness.apiRaw('/api/v1/marketing/vouchers/redeem', {
        method: 'POST',
        auth: tenantB,
        body: { code: claimedCode, order_vnd: 1_200_000 },
      });
      assert.equal(bRedeem.status, 400);
      assert.equal(bRedeem.json?.error?.code, 'CODE_NOT_FOUND');

      const bCodes = await harness.apiRaw(`/api/v1/marketing/vouchers/${poolId}/codes`, { auth: tenantB });
      assert.equal(bCodes.status, 404);
      assert.equal(bCodes.json?.error?.code, 'VOUCHER_POOL_NOT_FOUND');

      const bShortlink = await harness.apiRaw(`/api/v1/marketing/vouchers/shortlinks/${linkId}`, {
        method: 'PUT',
        auth: tenantB,
        body: { title: 'Cross-tenant hijack' },
      });
      assert.equal(bShortlink.status, 404);
      assert.equal(bShortlink.json?.error?.code, 'SHORTLINK_NOT_FOUND');

      const bCamp = await harness.apiRaw(`/api/v1/marketing/campaigns/${campId}/detail`, { auth: tenantB });
      assert.equal(bCamp.status, 404);
      assert.equal(bCamp.json?.error?.code, 'CAMPAIGN_NOT_FOUND');

      const bLead = await harness.apiRaw(`/api/v1/leads/${leadId}`, { auth: tenantB });
      assert.equal(bLead.status, 404);

      const [bVouchers, bClicks, bCamps, bContacts] = await Promise.all([
        harness.apiJson('/api/v1/marketing/vouchers', { auth: tenantB }),
        harness.apiJson('/api/v1/marketing/vouchers/clicks-analytics', { auth: tenantB }),
        harness.apiJson('/api/v1/marketing/campaigns', { auth: tenantB }),
        harness.apiJson('/api/v1/audiences/contacts', { auth: tenantB }),
      ]);
      assert.equal((bVouchers.data.pools || []).length, 0);
      assert.equal((bVouchers.data.shortlinks || []).length, 0);
      assert.equal(bClicks.data.total_clicks, 0);
      assert.equal((bCamps.data.items || bCamps.data || []).length, 0);
      assert.equal((bContacts.data.items || []).some((c: any) => c.id === leadId), false);
    }
  );
});
