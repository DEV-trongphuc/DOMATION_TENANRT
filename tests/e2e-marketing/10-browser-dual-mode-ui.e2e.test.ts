import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, HTTPRequest, HTTPResponse, Page } from 'puppeteer';
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

let harness: MarketingE2eHarness;
let browserHarness: ErpBrowserHarness;

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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

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
  const diag = browserHarness.collectRuntimeDiagnostics(page);
  const net = netGuard.getReport();

  assert.equal(
    diag.pageErrors.length,
    0,
    `${label}: expected 0 pageErrors, got: ${JSON.stringify(diag.pageErrors)}`
  );
  assert.equal(
    diag.consoleErrors.length,
    0,
    `${label}: expected 0 consoleErrors, got: ${JSON.stringify(diag.consoleErrors)}`
  );
  assert.equal(
    diag.http5xxErrors.length,
    0,
    `${label}: expected 0 http5xxErrors, got: ${JSON.stringify(diag.http5xxErrors)}`
  );
  assert.equal(
    diag.requestFailedErrors.length,
    0,
    `${label}: expected 0 requestFailedErrors, got: ${JSON.stringify(diag.requestFailedErrors)}`
  );
  assert.equal(
    net.api5xxErrors.length,
    0,
    `${label}: expected 0 API 5xx/501 responses, got: ${JSON.stringify(net.api5xxErrors)}`
  );
  assert.equal(
    net.php404Or501Errors.length,
    0,
    `${label}: expected 0 .php 404/501 responses, got: ${JSON.stringify(net.php404Or501Errors)}`
  );
  assert.equal(
    net.port3199Requests.length,
    0,
    `${label}: expected 0 requests targeting :3199, got: ${JSON.stringify(net.port3199Requests)}`
  );
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

async function waitForSplashDismissed(page: Page, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const g = globalThis as any;
      const doc = g.document;
      const splash = doc?.getElementById('ideas-splash-screen');
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
  await page.goto(`${browserHarness.frontendBaseUrl}${cleanPath}`, {
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
    `${contextLabel}: expected white/light sidebar synced with /data & /meta-report (no dark navy/black background), got bg=${sidebarAudit.backgroundColor} bgImg=${sidebarAudit.backgroundImage}`
  );
  assert.equal(
    sidebarAudit.hasLightStop,
    true,
    `${contextLabel}: expected light/white sidebar background rgb >= 220, got bg=${sidebarAudit.backgroundColor} bgImg=${sidebarAudit.backgroundImage}`
  );
  assert.ok(
    (sidebarAudit.transitionDuration ?? 0) > 0,
    `${contextLabel}: expected non-zero sidebar transitionDuration animation, got ${sidebarAudit.transitionDuration}`
  );
  if (sidebarAudit.navTextColor) {
    assert.ok(
      sidebarAudit.navTextColor.r < 130 && sidebarAudit.navTextColor.g < 130 && sidebarAudit.navTextColor.b < 130,
      `${contextLabel}: expected readable dark text contrast on light sidebar, got ${JSON.stringify(sidebarAudit.navTextColor)}`
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedMarketingFixtures(
  auth: TenantAuthContext,
  opts?: { sendCampaign?: boolean; flowStatus?: 'draft' | 'active'; prefix?: string }
) {
  const prefix = opts?.prefix || 'E2E UI';
  const flowStatus = opts?.flowStatus ?? 'draft';

  await harness.apiJson('/api/v1/auth/tenant-settings', {
    method: 'PATCH',
    auth,
    body: {
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_e2e_ui_key_001',
        resend_from_email: 'mkt-ui@e2e.vn',
        resend_from_name: 'DOMATION E2E',
      },
    },
  });

  const contactRes = await harness.apiJson('/api/v1/audiences/contacts', {
    method: 'POST',
    auth,
    body: {
      name: `${prefix} Contact`,
      email: `ui-${auth.tenantSlug}@e2e.vn`,
      phone: '0909888777',
      email_consent: 'subscribed',
    },
  });
  const contactId = String(contactRes.data.id);

  const audRes = await harness.apiJson('/api/v1/audiences', {
    method: 'POST',
    auth,
    body: {
      name: `${prefix} Audience`,
      audience_type: 'static_data',
      lead_ids: [contactId],
    },
  });
  const audienceId = String(audRes.data.id);

  const tplRes = await harness.apiJson('/api/v1/marketing/templates', {
    method: 'POST',
    auth,
    body: {
      name: `${prefix} Email Template`,
      subject: `${prefix} Welcome {{lead.name}}`,
      compiled_html:
        '<html><body><h1>Xin chào {{lead.name}}</h1><a href="https://example.com/e2e-ui">Khám phá</a></body></html>',
    },
  });
  const templateId = String(tplRes.data.id);

  const flowRes = await harness.apiJson('/api/v1/marketing/flows', {
    method: 'POST',
    auth,
    body: {
      name: `${prefix} Flow`,
      trigger_type: 'form_submitted',
      status: flowStatus,
      steps: [
        {
          id: 'step_trigger_ui_1',
          type: 'trigger',
          label: 'Khi điền Form',
          nextStepId: 'step_email_ui_1',
          config: {
            triggerType: 'form_submitted',
          },
        },
        {
          id: 'step_email_ui_1',
          type: 'action',
          label: 'Gửi Email Chào Mừng',
          config: {
            subject: `${prefix} Xin chào {{first_name}}`,
            template_id: templateId,
            sender_email: 'mkt-ui@e2e.vn',
          },
        },
      ],
    },
  });
  const flowId = String(flowRes.data.id);

  const dueAt = opts?.sendCampaign ? new Date(Date.now() - 60_000).toISOString() : undefined;
  const campRes = await harness.apiJson('/api/v1/marketing/campaigns', {
    method: 'POST',
    auth,
    body: {
      name: `${prefix} Campaign`,
      channel: 'email',
      audience_id: audienceId,
      template_id: templateId,
      subject_a: `${prefix} Campaign Offer`,
      sender_email: 'mkt-ui@e2e.vn',
      ...(dueAt ? { scheduled_at: dueAt } : {}),
    },
  });
  const campaignId = String(campRes.data.id);

  if (opts?.sendCampaign) {
    await harness.triggerMasterCron(['marketing_campaigns'], auth.tenantId);
  }

  const surveyRes = await harness.apiJson('/api/v1/marketing/surveys', {
    method: 'POST',
    auth,
    body: {
      title: `${prefix} Customer Survey`,
      survey_type: 'survey',
      blocks: [
        {
          id: 'q_name',
          type: 'short_text',
          label: 'Họ và tên của bạn',
          required: true,
          placeholder: 'Nhập tên...',
        },
        {
          id: 'q_feedback',
          type: 'yes_no',
          label: 'Bạn có hài lòng với dịch vụ?',
          required: false,
        },
      ],
      thank_you: {
        title: 'Cảm ơn bạn đã đánh giá!',
        message: 'Phản hồi của bạn đã được lưu thành công.',
      },
    },
  });

  const voucherRes = await harness.apiJson('/api/v1/marketing/vouchers', {
    method: 'POST',
    auth,
    body: {
      name: `${prefix} VIP Voucher`,
      code_prefix: 'E2EUI',
      discount_type: 'percentage',
      discount_value: 20,
      auto_generate_count: 5,
    },
  });

  return {
    contactId,
    audienceId,
    templateId,
    flowId,
    flowName: `${prefix} Flow`,
    campaignId,
    campaignName: `${prefix} Campaign`,
    survey: surveyRes.data as { id: string; slug: string; title: string },
    voucher: voucherRes.data as { id: string; slug: string; name: string },
  };
}

describe('Feature 10: Dual-Mode Browser & UI/UX Synchronization (E2E)', () => {
  before(
    async () => {
      harness = await startMarketingE2eHarness();
      browserHarness = await startErpBrowserHarness(harness.baseUrl);
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

  // =========================================================================
  // Tier 1 — Happy Path (>=6 tests)
  // =========================================================================
  describe('Tier 1: Happy Path', () => {
    it(
      'F10-T1-01: portal-embedded mode (domation_promax) exposes CRM Auto, Realtime Report, CAPI & Marketing Automation seamlessly',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'domation_promax' });
        assert.equal(auth.status, 201);
        const fixtures = await seedMarketingFixtures(auth, { prefix: 'PortalMode' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'domation_promax',
          },
          '/'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);
          await page.waitForSelector('aside.responsive-sidebar', { timeout: 15_000 });

          // Verify '/' renders portal dashboard (NOT MarketingDashboardPage) and sidebar exposes CRM + Marketing links + light UI
          const rootCheck = await page.evaluate(() => {
            const doc = (globalThis as any).document;
            const sidebar = doc.querySelector('aside.responsive-sidebar');
            const sidebarText = sidebar?.textContent || '';
            const hrefs = Array.from(sidebar?.querySelectorAll('a[href]') || []).map((a: any) =>
              a.getAttribute('href')
            );
            const hasMktHeroAtRoot = Array.from(doc.querySelectorAll('.mkt-scope h1')).some((h: any) =>
              (h.textContent || '').includes('Marketing & Đa kênh')
            );
            return { sidebarText, hrefs, hasMktHeroAtRoot };
          });

          assert.equal(rootCheck.hasMktHeroAtRoot, false, 'Portal mode "/" must NOT render MarketingDashboardPage');
          assert.ok(rootCheck.hrefs.includes('/data'), `Expected /data in sidebar: ${JSON.stringify(rootCheck.hrefs)}`);
          assert.ok(
            rootCheck.hrefs.includes('/marketing/meta-report') || rootCheck.hrefs.includes('/meta-report'),
            `Expected Realtime Report link in sidebar: ${JSON.stringify(rootCheck.hrefs)}`
          );
          assert.ok(
            rootCheck.hrefs.includes('/marketing/capi') || rootCheck.hrefs.includes('/capi'),
            `Expected CAPI link in sidebar: ${JSON.stringify(rootCheck.hrefs)}`
          );
          assert.ok(rootCheck.hrefs.includes('/marketing'), 'Expected /marketing in sidebar');
          assert.ok(rootCheck.hrefs.includes('/marketing/flows'), 'Expected /marketing/flows in sidebar');
          await assertLightSidebar(page, 'F10-T1-01 portal "/"');

          // Navigate /data -> /meta-report -> /marketing/flows cleanly with <AccessDeniedView> / <ErrorBoundary> false-pass guards
          await navigateRoute(page, '/data');
          const dataAudit = await waitForMainRouteReady(page, '/data', 15_000);
          assert.equal(dataAudit.pathname, '/data', 'Expected pathname /data');
          assert.equal(dataAudit.hasAccessDenied, false, 'Expected /data NOT to render AccessDeniedView');
          assert.equal(dataAudit.hasErrorBoundary, false, 'Expected /data NOT to render ErrorBoundary');
          const hasDataHeading = await page.evaluate(() => {
            const mainText = ((globalThis as any).document.querySelector('main')?.innerText || '').trim();
            return mainText.includes('Quản lý Data') && mainText.length > 50;
          });
          assert.equal(hasDataHeading, true, 'Expected /data CRM DataList heading ("Quản lý Data") in <main>');
          await assertLightSidebar(page, 'F10-T1-01 /data');

          await navigateRoute(page, '/meta-report');
          const metaAudit = await waitForMainRouteReady(page, '/meta-report', 15_000);
          assert.equal(metaAudit.hasVisibleDomMetaScope, true, 'Expected visible .dom-meta-scope inside <main> on /meta-report');
          assert.equal(metaAudit.hasAccessDenied, false, 'Expected /meta-report NOT to render AccessDeniedView');
          await assertLightSidebar(page, 'F10-T1-01 /meta-report');

          await navigateRoute(page, '/marketing/flows');
          const flowsAudit = await waitForMainRouteReady(page, '/marketing/flows', 15_000);
          assert.equal(flowsAudit.hasVisibleMktScope, true, 'Expected visible .mkt-scope inside <main> on /marketing/flows');
          assert.equal(flowsAudit.hasAccessDenied, false, 'Expected /marketing/flows NOT to render AccessDeniedView');
          const flowVisible = await page.waitForFunction(
            (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.flowName
          );
          assert.ok(flowVisible, 'Expected seeded flow visible in portal-embedded /marketing/flows <main>');
          await assertLightSidebar(page, 'F10-T1-01 /marketing/flows');

          assertCleanRuntime(page, netGuard, 'F10-T1-01 portal-embedded navigation');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );

    it(
      'F10-T1-02: standalone mode (marketing_standalone) isolates sidebar & renders MarketingDashboardPage at "/" sharing same DB',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
        assert.equal(auth.status, 201);
        const fixtures = await seedMarketingFixtures(auth, { prefix: 'StandaloneMode' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'marketing_standalone',
          },
          '/'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);
          await page.waitForSelector('aside.responsive-sidebar', { timeout: 15_000 });
          await page.waitForFunction(
            () => {
              const doc = (globalThis as any).document;
              const main = doc.querySelector('main');
              return (
                Boolean(main?.querySelector('.mkt-scope')) &&
                (main?.innerText || '').includes('Marketing & Đa kênh')
              );
            },
            { timeout: 20_000 }
          );

          const standaloneInfo = await page.evaluate(() => {
            const doc = (globalThis as any).document;
            const sidebar = doc.querySelector('aside.responsive-sidebar');
            const sidebarText = sidebar?.textContent || '';
            const hrefs = Array.from(sidebar?.querySelectorAll('a[href]') || []).map((a: any) =>
              a.getAttribute('href')
            );
            const hasSidebarUpgradeLink = Boolean(sidebar?.querySelector('a[href*="package_upgrade"]'));
            return { sidebarText, hrefs, hasSidebarUpgradeLink };
          });

          assert.ok(standaloneInfo.sidebarText.includes('MARKETING AUTOMATION'), 'Expected MARKETING AUTOMATION group');
          assert.ok(
            standaloneInfo.sidebarText.includes('DOM AUTOMATION') ||
              standaloneInfo.sidebarText.includes('Marketing Automation'),
            `Expected standalone sidebar brand/subtitle ("DOM AUTOMATION" / "Marketing Automation"), got: ${standaloneInfo.sidebarText.slice(0, 200)}`
          );
          assert.equal(
            standaloneInfo.sidebarText.includes('Nâng cấp'),
            false,
            'Standalone sidebar bottom must NOT render truncated "Nâng cấp" upgrade box (moved to /settings)'
          );
          assert.equal(
            standaloneInfo.hasSidebarUpgradeLink,
            false,
            'Standalone sidebar must NOT contain a[href*="package_upgrade"] footer link (moved to /settings)'
          );
          await assertLightSidebar(page, 'F10-T1-02 standalone "/"');

          for (const allowed of ['/marketing', '/marketing/flows', '/settings', '/accounts', '/ai-training']) {
            assert.ok(
              standaloneInfo.hrefs.includes(allowed),
              `Expected standalone sidebar to include ${allowed}, got: ${JSON.stringify(standaloneInfo.hrefs)}`
            );
          }
          for (const hidden of ['/data', '/contacts', '/deals', '/rounds', '/rules', '/integrations']) {
            assert.equal(
              standaloneInfo.hrefs.includes(hidden),
              false,
              `Expected standalone sidebar to hide CRM/ERP route ${hidden}`
            );
          }

          // Verify Upgrade ("Nâng cấp") button/panel is rendered cleanly in /settings?tab=package_upgrade
          await navigateSpaRoute(page, '/settings?tab=package_upgrade');
          await page.waitForFunction(
            () => {
              const mainText = ((globalThis as any).document.querySelector('main')?.innerText || '').trim();
              return mainText.includes('Nâng cấp') && mainText.length > 100;
            },
            { timeout: 15_000 }
          );
          const settingsUpgradeCheck = await page.evaluate(() => {
            const main = (globalThis as any).document.querySelector('main');
            const btns = Array.from(main?.querySelectorAll('button') || []) as any[];
            const upgradeBtns = btns.filter((b) => (b.textContent || '').includes('Nâng cấp'));
            return {
              hasUpgradePanelText: (main?.innerText || '').includes('Gói dịch vụ'),
              upgradeBtnCount: upgradeBtns.length,
            };
          });
          assert.equal(
            settingsUpgradeCheck.upgradeBtnCount >= 1,
            true,
            `Expected Upgrade ("Nâng cấp") button inside /settings, got: ${JSON.stringify(settingsUpgradeCheck)}`
          );

          // Verify seeded flow & campaign from shared backend/DB render in standalone UI
          await navigateSpaRoute(page, '/marketing/flows');
          await page.waitForFunction(
            (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.flowName
          );

          await navigateSpaRoute(page, '/marketing/campaigns');
          await page.waitForFunction(
            (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.campaignName
          );

          assertCleanRuntime(page, netGuard, 'F10-T1-02 standalone mode');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );

    it(
      'F10-T1-03: design system token, Be Vietnam Pro typography across /data + /meta-report + /marketing, loading backdrop & SVG decor parity',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'domation_promax' });
        await seedMarketingFixtures(auth, { prefix: 'TokenParity' });

        // Verify landing-page background asset is reachable with HTTP 200 on Vite origin
        const bgJpgRes = await fetch(`${browserHarness.frontendBaseUrl}/imgs/landing/fluent-brand-ambient-bg.jpg`);
        const bgWebpRes = await fetch(`${browserHarness.frontendBaseUrl}/imgs/landing/fluent-brand-ambient-bg.webp`);
        assert.ok(
          bgJpgRes.status === 200 || bgWebpRes.status === 200,
          `Expected landing-page ambient bg asset HTTP 200 on Vite origin (jpg=${bgJpgRes.status}, webp=${bgWebpRes.status})`
        );

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'domation_promax',
          },
          '/data'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);

          // Check splash/loader markup references landing bg asset
          const splashAssetInfo = await page.evaluate(() => {
            const doc = (globalThis as any).document;
            const splash = doc.getElementById('ideas-splash-screen');
            const img = splash?.querySelector('img');
            const source = splash?.querySelector('source');
            return {
              hasSplash: Boolean(splash),
              imgSrc: img?.getAttribute('src') || '',
              sourceSrcset: source?.getAttribute('srcset') || '',
            };
          });
          assert.ok(
            splashAssetInfo.imgSrc.includes('fluent-brand-ambient-bg') ||
              splashAssetInfo.sourceSrcset.includes('fluent-brand-ambient-bg'),
            `Expected splash/loader backdrop to reference fluent-brand-ambient-bg, got: ${JSON.stringify(splashAssetInfo)}`
          );

          // 1. /data surface tokens, typography, light sidebar, normal app icons, date range filter & ERP red accent
          const dataMetrics = await page.evaluate(() => {
            const g = globalThis as any;
            const doc = g.document;
            const bodyCs = g.getComputedStyle(doc.body);
            const rootCs = g.getComputedStyle(doc.documentElement);
            return {
              fontFamily: bodyCs.fontFamily,
              bodyBg: bodyCs.backgroundColor,
              bodyColor: bodyCs.color,
              colorPrimaryVar: rootCs.getPropertyValue('--color-primary').trim().toLowerCase(),
              colorDangerVar: rootCs.getPropertyValue('--color-danger').trim().toLowerCase(),
              colorBgVar: rootCs.getPropertyValue('--color-bg').trim().toLowerCase(),
              colorTextVar: rootCs.getPropertyValue('--color-text').trim().toLowerCase(),
              hasDatePicker: Boolean(doc.querySelector('[data-testid="erp-datalist-date-picker"], [data-testid="open-date-picker"]')),
            };
          });
          assert.ok(
            dataMetrics.fontFamily.toLowerCase().includes('be vietnam pro'),
            `Expected Be Vietnam Pro on /data, got: ${dataMetrics.fontFamily}`
          );
          assert.equal(dataMetrics.colorPrimaryVar, '#1e40ff', 'Expected --color-primary #1e40ff');
          assert.ok(
            dataMetrics.colorDangerVar === '#dc2626' || dataMetrics.colorDangerVar === '#ef4444',
            `Expected red accent --color-danger (#dc2626 / #ef4444), got: ${dataMetrics.colorDangerVar}`
          );
          assert.equal(dataMetrics.colorBgVar, '#f8f9fa', 'Expected --color-bg #f8f9fa');
          assert.equal(dataMetrics.colorTextVar, '#0f172a', 'Expected --color-text #0f172a');
          assert.equal(dataMetrics.hasDatePicker, true, 'Expected unified date range filter on /data');
          await assertLightSidebar(page, 'F10-T1-03 /data');
          await assertStandardAppIcons(
            page,
            'aside.responsive-sidebar',
            14,
            38,
            'F10-T1-03 sidebar nav icons',
            'a.sidebar-nav-item svg'
          );

          // Verify ERP Quick Navigation ("Menu điều hướng nhanh") includes red accent alongside other colors
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
            const modalRoot = Array.from(doc.querySelectorAll('div')).find((d: any) =>
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
            `Expected red accent (#DC2626/#EF4444) in ERP Quick Navigation palette, found ${erpQuickNavRedCount}`
          );

          // 2. /meta-report (.dom-meta-scope) surface typography (TRUE M3 contract: Be Vietnam Pro, NOT Roboto), light sidebar & date picker
          await navigateSpaRoute(page, '/meta-report');
          const metaRouteAudit = await waitForMainRouteReady(page, '/meta-report', 15_000);
          assert.equal(metaRouteAudit.pathname, '/meta-report', 'Expected pathname /meta-report');
          assert.equal(metaRouteAudit.hasAccessDenied, false, 'Expected /meta-report NOT to render AccessDeniedView');
          assert.equal(metaRouteAudit.hasErrorBoundary, false, 'Expected /meta-report NOT to render ErrorBoundary');
          assert.equal(
            metaRouteAudit.hasVisibleDomMetaScope,
            true,
            'Expected visible .dom-meta-scope on /meta-report'
          );
          const metaAudit = await page.evaluate(() => {
            const g = globalThis as any;
            const doc = g.document;
            const scope = Array.from(doc.querySelectorAll('main .dom-meta-scope')).find(
              (el: any) => g.getComputedStyle(el).visibility !== 'hidden'
            ) as any;
            const heading = scope?.querySelector('h1, h2') || scope;
            return {
              scopeFont: scope ? g.getComputedStyle(scope).fontFamily : '',
              headingFont: heading ? g.getComputedStyle(heading).fontFamily : '',
              hasDatePicker: Array.from(doc.querySelectorAll('main [data-testid="open-date-picker"]')).some(
                (el: any) => {
                  const cs = g.getComputedStyle(el);
                  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                }
              ),
            };
          });
          assert.ok(
            metaAudit.scopeFont.toLowerCase().includes('be vietnam pro'),
            `Expected Be Vietnam Pro on /meta-report (.dom-meta-scope), got: ${metaAudit.scopeFont}`
          );
          assert.ok(
            metaAudit.headingFont.toLowerCase().includes('be vietnam pro'),
            `Expected Be Vietnam Pro on /meta-report headings, got: ${metaAudit.headingFont}`
          );
          assert.equal(metaAudit.hasDatePicker, true, 'Expected unified date range filter on /meta-report');
          await assertLightSidebar(page, 'F10-T1-03 /meta-report');

          // 3. /marketing (.mkt-scope) + /marketing/flows tokens, tabular-nums, zero legacy purple, tightened Domation SVG decor, red accent, normal icons & date picker
          await navigateSpaRoute(page, '/marketing');
          const mktRouteAudit = await waitForMainRouteReady(page, '/marketing', 15_000);
          assert.equal(mktRouteAudit.pathname, '/marketing', 'Expected pathname /marketing');
          assert.equal(mktRouteAudit.hasAccessDenied, false, 'Expected /marketing NOT to render AccessDeniedView');
          assert.equal(mktRouteAudit.hasErrorBoundary, false, 'Expected /marketing NOT to render ErrorBoundary');
          assert.equal(mktRouteAudit.hasVisibleMktScope, true, 'Expected visible .mkt-scope on /marketing');
          const mktCheck = await page.evaluate(() => {
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
            const scopeCs = scope ? g.getComputedStyle(scope) : null;

            // Visible Domation SVG decor across BOTH active main .mkt-scope AND .dom-meta-app-canvas (exclude button/aside/nav/header/#ideas-splash-screen/.lucide & <AppIcon> 56x56)
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
              if (cls.includes('lucide')) return false;
              if (svg.closest('button, aside, nav, header, #ideas-splash-screen, .lucide')) return false;
              const cs = g.getComputedStyle(svg);
              if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
              const rect = svg.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              const viewBox = svg.getAttribute('viewBox') || '';
              return (
                viewBox === '0 0 1440 500' ||
                viewBox === '0 0 1440 260' ||
                viewBox === '0 0 280 96' ||
                viewBox === '0 0 64 64' ||
                viewBox === '0 0 80 80' ||
                viewBox === '0 0 48 48'
              );
            });

            // Legacy purple accents check across visible buttons/links inside .mkt-scope
            const interactiveEls = Array.from(scope?.querySelectorAll('button, a, [role="button"]') || []) as any[];
            const purpleMatches: string[] = [];
            for (const el of interactiveEls) {
              const cs = g.getComputedStyle(el);
              const bg = cs.backgroundColor || '';
              const border = cs.borderColor || '';
              if (
                bg.includes('124, 58, 237') ||
                bg.includes('139, 92, 246') ||
                border.includes('124, 58, 237') ||
                border.includes('139, 92, 246')
              ) {
                purpleMatches.push(`${el.tagName}:${bg}`);
              }
            }

            // Red accent check across visible Marketing UI elements & AppIcon SVG stops
            let mktRedHits = 0;
            for (const el of Array.from(scope?.querySelectorAll('*') || []) as any[]) {
              const tag = (el.tagName || '').toLowerCase();
              const cs = g.getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              const combinedStyles = `${cs.backgroundColor || ''} ${cs.backgroundImage || ''} ${cs.borderColor || ''} ${cs.color || ''}`;
              const styleRgbHit = Array.from(
                combinedStyles.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
              ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
              const styleHexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(combinedStyles);
              if (styleRgbHit || styleHexHit) {
                mktRedHits++;
                break;
              }
              if (tag === 'stop' || tag === 'path' || tag === 'rect' || tag === 'circle') {
                const attrColors = `${el.getAttribute('stop-color') || ''} ${el.getAttribute('fill') || ''} ${el.getAttribute('stroke') || ''}`;
                const attrRgbHit = Array.from(
                  attrColors.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/gi)
                ).some((m) => Number(m[1]) >= 200 && Number(m[2]) <= 80 && Number(m[3]) <= 90);
                const attrHexHit = /#(?:dc2626|ef4444|e11d48|b91c1c|f43f5e)/i.test(attrColors);
                if (attrRgbHit || attrHexHit) {
                  mktRedHits++;
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
              fontFamily: scopeCs?.fontFamily || '',
              decorSvgCount: decorSvgs.length,
              purpleMatches,
              mktRedHits,
              hasDatePicker: Boolean(datePickerBtn),
            };
          });

          assert.ok(
            mktCheck.fontFamily.toLowerCase().includes('be vietnam pro'),
            `Expected Be Vietnam Pro in .mkt-scope, got: ${mktCheck.fontFamily}`
          );
          assert.ok(
            mktCheck.decorSvgCount >= 1,
            `Expected >=1 visible Domation SVG decorative accent in Marketing UI (viewBox 1440x500/1440x260/280x96/64x64/80x80/48x48 outside button/aside/nav/header/#ideas-splash-screen), got ${mktCheck.decorSvgCount}`
          );
          assert.equal(
            mktCheck.purpleMatches.length,
            0,
            `Expected zero legacy purple primary accents in .mkt-scope, found: ${JSON.stringify(mktCheck.purpleMatches)}`
          );
          assert.ok(
            mktCheck.mktRedHits >= 1,
            'Expected red accent (#DC2626/#EF4444) present in Marketing UI palette/icons'
          );
          assert.equal(mktCheck.hasDatePicker, true, 'Expected unified date range filter on /marketing dashboard');
          await assertLightSidebar(page, 'F10-T1-03 /marketing');
          await assertStandardAppIcons(page, 'main .mkt-scope', 32, 56, 'F10-T1-03 /marketing AppIcons');

          // Exercise date range filter popover on /marketing cleanly (target visible trigger in active main .mkt-scope to avoid hidden AppTabs collision)
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
            'Expected clickable visible date-picker button inside active /marketing .mkt-scope'
          );
          await page.waitForSelector('[data-testid="unified-date-picker-popover"]', { timeout: 5_000 });
          await page.keyboard.press('Escape');
          await sleep(150);

          // Check primary button RGB(30, 64, 255) & tabular-nums KPI metrics on /marketing/flows
          await navigateSpaRoute(page, '/marketing/flows');
          const flowsRouteAudit = await waitForMainRouteReady(page, '/marketing/flows', 15_000);
          assert.equal(flowsRouteAudit.pathname, '/marketing/flows', 'Expected pathname /marketing/flows');
          assert.equal(
            flowsRouteAudit.hasAccessDenied,
            false,
            'Expected /marketing/flows NOT to render AccessDeniedView'
          );
          assert.equal(flowsRouteAudit.hasErrorBoundary, false, 'Expected /marketing/flows NOT to render ErrorBoundary');
          assert.equal(flowsRouteAudit.hasVisibleMktScope, true, 'Expected visible .mkt-scope on /marketing/flows');
          const flowsStyle = await page.evaluate(() => {
            const g = globalThis as any;
            const doc = g.document;
            const visibleScope = Array.from(doc.querySelectorAll('main .mkt-scope')).find(
              (el: any) =>
                el.style?.display !== 'contents' &&
                !(
                  Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                  el.querySelectorAll('button, a, input, select, textarea').length <= 1
                ) &&
                g.getComputedStyle(el).visibility !== 'hidden'
            ) as any;
            const buttons = Array.from(visibleScope?.querySelectorAll('button') || []) as any[];
            const primaryBtn = buttons.find((b) => (b.textContent || '').includes('Tạo kịch bản'));
            const primaryBg = primaryBtn ? g.getComputedStyle(primaryBtn).backgroundColor : '';
            const kpiEls = Array.from(visibleScope?.querySelectorAll('*') || []).filter((el: any) =>
              (el.textContent || '').includes('Tổng kịch bản')
            );
            const scopeFontVar = visibleScope ? g.getComputedStyle(visibleScope).fontVariantNumeric : '';
            return {
              primaryBg,
              hasKpi: kpiEls.length > 0,
              scopeFontVar,
            };
          });

          assert.equal(
            flowsStyle.primaryBg,
            'rgb(30, 64, 255)',
            `Expected primary CTA button Royal Sapphire rgb(30, 64, 255), got: ${flowsStyle.primaryBg}`
          );
          assert.equal(flowsStyle.hasKpi, true, 'Expected StatGrid KPI card "Tổng kịch bản" on /marketing/flows');
          assert.ok(
            flowsStyle.scopeFontVar.includes('tabular-nums'),
            `Expected tabular-nums on .mkt-scope KPI metrics, got: ${flowsStyle.scopeFontVar}`
          );
          await assertLightSidebar(page, 'F10-T1-03 /marketing/flows');

          assertCleanRuntime(page, netGuard, 'F10-T1-03 design system parity');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );

    it(
      'F10-T1-04: Automation Flows page & expanded two-column Email Step Modal (StepEditor + EmailActionConfig)',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
        const fixtures = await seedMarketingFixtures(auth, { flowStatus: 'draft', prefix: 'FlowModal' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'marketing_standalone',
          },
          '/marketing/flows'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);

          // Ensure draft/all flow list displays StatGrid KPIs (StatCard title uses CSS uppercase, so inspect textContent) and our seeded flow
          await page.waitForFunction(
            (flowName: string) => {
              const txt = (globalThis as any).document.body.textContent || '';
              return txt.toLowerCase().includes('tổng kịch bản') && txt.includes(flowName);
            },
            { timeout: 15_000 },
            fixtures.flowName
          );

          // Click the seeded flow card/row to enter FlowBuilderTab
          const openedFlow = await page.evaluate((flowName: string) => {
            const doc = (globalThis as any).document;
            const candidates = Array.from(doc.querySelectorAll('tr, div.cursor-pointer, [role="button"]')) as any[];
            const match = candidates.find((el) => (el.textContent || '').includes(flowName));
            if (!match) return false;
            match.scrollIntoView({ block: 'center' });
            match.click();
            return true;
          }, fixtures.flowName);
          assert.equal(openedFlow, true, 'Expected to click seeded flow to enter FlowBuilderTab');

          // Wait for Email step node in FlowTree
          await page.waitForSelector('#step-node-step_email_ui_1', { timeout: 15_000 });
          await page.click('#step-node-step_email_ui_1');

          // Wait for StepEditor modal ("Cấu hình bước")
          await page.waitForFunction(
            () => {
              const root = (globalThis as any).document.getElementById('mkt-portal-root');
              return Boolean(root && (root.innerText || '').includes('Cấu hình bước'));
            },
            { timeout: 15_000 }
          );

          // Verify true M3 expanded modal contract: >= 768px width (max-w-4xl/5xl/6xl, NOT max-w-2xl), layout-agnostic 2-column EmailActionConfig, zero overflow clipping
          const modalAudit = await page.evaluate(() => {
            const g = globalThis as any;
            const doc = g.document;
            const portal = doc.getElementById('mkt-portal-root');
            const subjectInput = portal?.querySelector('input[placeholder*="Quà tặng cho"]') as any;
            const mergeBtn = portal?.querySelector('button[title="Cá nhân hóa tiêu đề"]') as any;
            const visualBtn = Array.from(portal?.querySelectorAll('button') || []).find((b: any) =>
              (b.textContent || '').includes('Chọn Mẫu (Visual)')
            ) as any;
            const htmlBtn = Array.from(portal?.querySelectorAll('button') || []).find((b: any) =>
              (b.textContent || '').includes('HTML Code')
            ) as any;

            // Find the modal dialog box wrapping "Cấu hình bước"
            let dialogBox: any = subjectInput?.parentElement;
            while (dialogBox && dialogBox !== portal) {
              const cls = String(dialogBox.className || '');
              if (
                cls.includes('max-w-') &&
                (cls.includes('rounded-[var(--radius-xl)]') || cls.includes('shadow-'))
              ) {
                break;
              }
              dialogBox = dialogBox.parentElement;
            }
            const dialogRect = dialogBox ? dialogBox.getBoundingClientRect() : { width: 0, height: 0 };
            const dialogClass = dialogBox ? String(dialogBox.className || '') : '';

            // Scroll container inside modal body
            const scrollBody = Array.from(dialogBox?.querySelectorAll('div') || []).find((d: any) =>
              String(d.className || '').includes('overflow-y-auto')
            ) as any;

            // Layout-agnostic two-column check: either CSS grid (>=2 resolved tracks >=150px) OR side-by-side column containers (>=150px wide, leftDelta >=150px, overlapping Y)
            const candidates = scrollBody ? [scrollBody, ...Array.from(scrollBody.querySelectorAll('div, section, form'))] : [];
            let twoColumnEvidence: { mode: string; tracks: string; col1Left: number; col2Left: number } | null = null;

            for (const container of candidates as any[]) {
              const cs = g.getComputedStyle(container);
              if (cs.display === 'none' || cs.visibility === 'hidden') continue;
              const children = Array.from(container.children || []).filter((ch: any) => {
                if (ch.tagName === 'BUTTON') return false;
                const ccs = g.getComputedStyle(ch);
                if (ccs.display === 'none' || ccs.visibility === 'hidden') return false;
                const r = ch.getBoundingClientRect();
                return r.width >= 150 && r.height >= 120;
              }) as any[];

              if (children.length < 2) continue;

              // Check any pair of wide visible children sitting side-by-side with vertical overlap and real Email form/content
              let foundPair: { col1Left: number; col2Left: number } | null = null;
              for (let i = 0; i < children.length && !foundPair; i++) {
                const c1 = children[i];
                const r1 = c1.getBoundingClientRect();
                for (let j = i + 1; j < children.length; j++) {
                  const c2 = children[j];
                  const r2 = c2.getBoundingClientRect();
                  const leftDelta = Math.abs(r1.left - r2.left);
                  const yOverlap = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);
                  const subjectCol =
                    subjectInput && c1.contains(subjectInput) && !c2.contains(subjectInput)
                      ? c1
                      : subjectInput && c2.contains(subjectInput) && !c1.contains(subjectInput)
                        ? c2
                        : null;
                  const oppositeCol = subjectCol === c1 ? c2 : subjectCol === c2 ? c1 : null;
                  const hasSubjectExclusive = Boolean(subjectCol && oppositeCol);
                  const hasContentToggleOppositeCol = Boolean(
                    subjectCol &&
                      oppositeCol &&
                      ((visualBtn && oppositeCol.contains(visualBtn) && !subjectCol.contains(visualBtn)) ||
                        (htmlBtn && oppositeCol.contains(htmlBtn) && !subjectCol.contains(htmlBtn)))
                  );
                  const hasPreviewOrEditorOppositeCol = Boolean(
                    oppositeCol &&
                      (oppositeCol.querySelector('iframe, textarea, [data-testid*="preview"]') ||
                        /xem trước|preview|nội dung email/i.test(oppositeCol.innerText || oppositeCol.textContent || ''))
                  );
                  const hasDistinctSections =
                    hasSubjectExclusive &&
                    (hasPreviewOrEditorOppositeCol || (visualBtn || htmlBtn ? hasContentToggleOppositeCol : true));
                  if (leftDelta >= 150 && yOverlap >= 40 && hasDistinctSections) {
                    foundPair = { col1Left: Math.round(r1.left), col2Left: Math.round(r2.left) };
                    break;
                  }
                }
              }
              if (!foundPair) continue;

              if (cs.display.includes('grid')) {
                const tracks = String(cs.gridTemplateColumns || '')
                  .trim()
                  .split(/\s+/)
                  .map((t) => parseFloat(t))
                  .filter((n) => Number.isFinite(n) && n >= 150);
                if (tracks.length >= 2) {
                  twoColumnEvidence = {
                    mode: 'grid',
                    tracks: cs.gridTemplateColumns,
                    col1Left: foundPair.col1Left,
                    col2Left: foundPair.col2Left,
                  };
                  break;
                }
              }

              // Flex row or side-by-side container
              if (cs.display.includes('flex') && cs.flexDirection !== 'column') {
                twoColumnEvidence = {
                  mode: 'flex-row',
                  tracks: cs.flexDirection,
                  col1Left: foundPair.col1Left,
                  col2Left: foundPair.col2Left,
                };
                break;
              }
            }

            return {
              dialogWidth: Math.round(dialogRect.width),
              dialogClass,
              hasSubjectInput: Boolean(subjectInput),
              hasMergeBtn: Boolean(mergeBtn && !mergeBtn.disabled),
              hasVisualBtn: Boolean(visualBtn),
              hasHtmlBtn: Boolean(htmlBtn),
              twoColumnEvidence,
              bodyScrollWidth: scrollBody ? scrollBody.scrollWidth : 0,
              bodyClientWidth: scrollBody ? scrollBody.clientWidth : 0,
            };
          });

          assert.equal(modalAudit.hasSubjectInput, true, 'Expected Email Subject input inside StepEditor');
          assert.equal(modalAudit.hasMergeBtn, true, 'Expected enabled merge-tag button inside StepEditor');
          assert.equal(modalAudit.hasVisualBtn, true, 'Expected "Chọn Mẫu (Visual)" button');
          assert.equal(modalAudit.hasHtmlBtn, true, 'Expected "HTML Code" button');

          // Expanded modal size requirement: xl / 2xl / 3xl (>= 768px on 1440px viewport, NOT max-w-2xl)
          assert.equal(
            modalAudit.dialogClass.includes('max-w-2xl'),
            false,
            `StepEditor Email modal must NOT be max-w-2xl (pre-M3 lg), got class: ${modalAudit.dialogClass}`
          );
          assert.ok(
            modalAudit.dialogWidth >= 768,
            `Expected expanded Email StepEditor modal width >= 768px on 1440px viewport, got ${modalAudit.dialogWidth}px (class=${modalAudit.dialogClass})`
          );

          // Layout-agnostic two-column layout requirement (works regardless of which column holds Visual/HTML toggle)
          assert.ok(
            modalAudit.twoColumnEvidence !== null,
            `Expected two-column side-by-side EmailActionConfig layout (>=2 side-by-side column containers >=150px wide with vertical overlap), got null`
          );

          // No horizontal overflow clipping inside modal body
          assert.ok(
            modalAudit.bodyScrollWidth <= modalAudit.bodyClientWidth + 2,
            `Expected zero horizontal overflow clipping inside StepEditor modal: scrollWidth=${modalAudit.bodyScrollWidth}, clientWidth=${modalAudit.bodyClientWidth}`
          );

          // Verify merge-tag popover opens cleanly
          await page.click('#mkt-portal-root button[title="Cá nhân hóa tiêu đề"]');
          await page.waitForFunction(
            () => ((globalThis as any).document.getElementById('mkt-portal-root')?.innerText || '').includes('{{first_name}}'),
            { timeout: 5_000 }
          );

          // Close modal cleanly via Escape & switch to Báo cáo (FlowAnalyticsTab)
          await page.keyboard.press('Escape');
          await sleep(300);
          const switchedReport = await clickButtonByText(page, 'Báo cáo');
          assert.equal(switchedReport, true, 'Expected to switch to "Báo cáo" tab in FlowHeader');
          await page.waitForFunction(
            () => ((globalThis as any).document.body.innerText || '').includes('Hiệu suất vận hành'),
            { timeout: 10_000 }
          );

          assertCleanRuntime(page, netGuard, 'F10-T1-04 Automation Flows + Email Step Modal');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );

    it(
      'F10-T1-05: ZNS UI tabs render cleanly without .map crash/.php 404/501, and CampaignDetailDrawer + FlowAnalyticsTab render metrics',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
        const fixtures = await seedMarketingFixtures(auth, { sendCampaign: true, flowStatus: 'active', prefix: 'DrawerZns' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'marketing_standalone',
          },
          '/marketing/social-bot'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);

          // 1. Switch to "Zalo OA & ZNS" and exercise all 4 sub-tabs
          const clickedZalo = await clickButtonByText(page, 'Zalo OA & ZNS');
          assert.equal(clickedZalo, true, 'Expected "Zalo OA & ZNS" tab on /marketing/social-bot');

          for (const subTabLabel of ['Khách hàng Zalo', 'Kịch bản Zalo', 'Broadcast & ZBS', 'Mẫu tin ZNS']) {
            assertCleanRuntime(page, netGuard, `F10-T1-05 before Zalo sub-tab "${subTabLabel}"`);
            const ok = await clickButtonByText(page, subTabLabel);
            assert.equal(ok, true, `Expected Zalo sub-tab "${subTabLabel}" to be clickable`);
            await sleep(500);
            assertCleanRuntime(page, netGuard, `F10-T1-05 on Zalo sub-tab "${subTabLabel}"`);
            const mainCheck = await page.evaluate(() => {
              const doc = (globalThis as any).document;
              const mainText = (doc.querySelector('main')?.innerText || '').trim();
              return {
                len: mainText.length,
                hasErrorBoundary:
                  mainText.includes('Đã xảy ra lỗi') ||
                  mainText.includes('Đã xảy ra sự cố') ||
                  mainText.includes('Không thể tải nội dung này') ||
                  mainText.includes('Không có quyền truy cập'),
              };
            });
            assert.equal(
              mainCheck.hasErrorBoundary,
              false,
              `Expected no ErrorBoundary/AccessDenied inside <main> on Zalo sub-tab "${subTabLabel}"`
            );
            assert.ok(
              mainCheck.len > 100,
              `Expected non-empty <main> render (>100 chars) on Zalo sub-tab "${subTabLabel}", got ${mainCheck.len}`
            );
          }

          // 2. Navigate to /marketing/campaigns and open CampaignDetailDrawer
          await navigateRoute(page, '/marketing/campaigns');
          await page.waitForFunction(
            (name: string) => ((globalThis as any).document.body.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.campaignName
          );
          const clickedCampaign = await page.evaluate((name: string) => {
            const doc = (globalThis as any).document;
            const rows = Array.from(doc.querySelectorAll('tr, div.cursor-pointer')) as any[];
            const row = rows.find((r) => (r.textContent || '').includes(name));
            if (!row) return false;
            row.scrollIntoView({ block: 'center' });
            row.click();
            return true;
          }, fixtures.campaignName);
          assert.equal(clickedCampaign, true, 'Expected to click campaign row to open CampaignDetailDrawer');

          await page.waitForSelector('.campaign-detail-drawer', { timeout: 15_000 });
          const drawerMetrics = await page.evaluate(() => {
            const lowerTxt = (
              (globalThis as any).document.querySelector('.campaign-detail-drawer')?.innerText || ''
            ).toLowerCase();
            return {
              hasOpenRate: lowerTxt.includes('tỷ lệ mở') || lowerTxt.includes('open rate'),
              hasClickRate: lowerTxt.includes('tỷ lệ click') || lowerTxt.includes('ctr'),
              hasFunnel: lowerTxt.includes('phễu chuyển đổi') || lowerTxt.includes('funnel'),
            };
          });
          assert.equal(drawerMetrics.hasOpenRate, true, 'Expected Open Rate metric in CampaignDetailDrawer');
          assert.equal(drawerMetrics.hasClickRate, true, 'Expected CTR metric in CampaignDetailDrawer');
          assert.equal(drawerMetrics.hasFunnel, true, 'Expected Funnel chart section in CampaignDetailDrawer');

          // 3. Navigate to /marketing/flows -> open flow -> "Báo cáo" tab (FlowAnalyticsTab)
          await navigateRoute(page, '/marketing/flows');
          await page.waitForFunction(
            (name: string) => ((globalThis as any).document.body.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.flowName
          );
          const openedFlow = await page.evaluate((name: string) => {
            const doc = (globalThis as any).document;
            const candidates = Array.from(doc.querySelectorAll('tr, div.cursor-pointer')) as any[];
            const match = candidates.find((el) => (el.textContent || '').includes(name));
            if (!match) return false;
            match.click();
            return true;
          }, fixtures.flowName);
          assert.equal(openedFlow, true, 'Expected to open seeded flow');

          await page.waitForFunction(
            () => ((globalThis as any).document.body.innerText || '').includes('Thiết kế'),
            { timeout: 10_000 }
          );
          const clickedReport = await clickButtonByText(page, 'Báo cáo');
          assert.equal(clickedReport, true, 'Expected "Báo cáo" tab in FlowHeader');
          await page.waitForFunction(
            () => {
              const txt = (globalThis as any).document.body.innerText || '';
              return txt.includes('Hiệu suất vận hành') && txt.includes('Hành trình Khách hàng');
            },
            { timeout: 10_000 }
          );

          assertCleanRuntime(page, netGuard, 'F10-T1-05 Measurement Drawers');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );

    it(
      'F10-T1-06: Step-Modal Focus Tours (DomMetaSpotlightTour on /meta-report & MarketingSpotlightTour on /marketing)',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'domation_promax' });
        await seedMarketingFixtures(auth, { prefix: 'FocusTour' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'domation_promax',
          },
          '/meta-report'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);

          // Part 1: DomMetaSpotlightTour on /meta-report
          await page.waitForSelector('button[data-testid="open-dom-meta-tour"]', { timeout: 15_000 });
          await page.click('button[data-testid="open-dom-meta-tour"]');

          await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 10_000 });
          const step1Text = await page.evaluate(
            () => (globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]')?.innerText || ''
          );
          assert.ok(step1Text.includes('BƯỚC 1 / 5'), `Expected BƯỚC 1 / 5 in DomMetaSpotlightTour, got: ${step1Text}`);

          const nextOk = await clickButtonByText(page, 'Tiếp theo', {
            rootSelector: 'div[role="dialog"][aria-modal="true"]',
          });
          assert.equal(nextOk, true, 'Expected "Tiếp theo" button in DomMetaSpotlightTour');
          await page.waitForFunction(
            () =>
              ((globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]')?.innerText || '').includes(
                'BƯỚC 2 / 5'
              ),
            { timeout: 5_000 }
          );

          const prevOk = await clickButtonByText(page, 'Quay lại', {
            rootSelector: 'div[role="dialog"][aria-modal="true"]',
          });
          assert.equal(prevOk, true, 'Expected "Quay lại" button in DomMetaSpotlightTour');
          await page.waitForFunction(
            () =>
              ((globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]')?.innerText || '').includes(
                'BƯỚC 1 / 5'
              ),
            { timeout: 5_000 }
          );

          // Step through remaining steps 2..5 and click "Hoàn tất" so onFinish persists DOM_META_TOUR_STORAGE_KEY
          for (let stepNum = 2; stepNum <= 5; stepNum++) {
            const stepNextOk = await clickButtonByText(page, 'Tiếp theo', {
              rootSelector: 'div[role="dialog"][aria-modal="true"]',
            });
            assert.equal(stepNextOk, true, `Expected "Tiếp theo" at step ${stepNum - 1}`);
            await page.waitForFunction(
              (expected: string) =>
                ((globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]')?.innerText || '').includes(
                  expected
                ),
              { timeout: 5_000 },
              `BƯỚC ${stepNum} / 5`
            );
          }

          const finishOk = await clickButtonByText(page, 'Hoàn tất', {
            rootSelector: 'div[role="dialog"][aria-modal="true"]',
          });
          assert.equal(finishOk, true, 'Expected "Hoàn tất" button at step 5 in DomMetaSpotlightTour');

          await page.waitForFunction(
            () => !(globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]'),
            { timeout: 5_000 }
          );
          const metaTourDone = await page.evaluate(() =>
            (globalThis as any).localStorage.getItem('domation_dom_meta_tour_done_v1')
          );
          assert.equal(metaTourDone, '1', 'Expected domation_dom_meta_tour_done_v1 === "1" after finish');

          // Also verify "Bỏ qua tour" dismisses the tour cleanly
          await page.click('button[data-testid="open-dom-meta-tour"]');
          await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 5_000 });
          const skipOk = await clickButtonByText(page, 'Bỏ qua tour', {
            rootSelector: 'div[role="dialog"][aria-modal="true"]',
          });
          assert.equal(skipOk, true, 'Expected "Bỏ qua tour" button in DomMetaSpotlightTour');
          await page.waitForFunction(
            () => !(globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]'),
            { timeout: 5_000 }
          );

          // Part 2: MarketingSpotlightTour on /marketing (TRUE M3 contract — full step/back/finish/localStorage/skip parity)
          await navigateSpaRoute(page, '/marketing');
          const mktTourRouteAudit = await waitForMainRouteReady(page, '/marketing', 15_000);
          assert.equal(
            mktTourRouteAudit.pathname,
            '/marketing',
            'Expected pathname /marketing for MarketingSpotlightTour'
          );
          assert.equal(
            mktTourRouteAudit.hasAccessDenied,
            false,
            'Expected /marketing NOT to render AccessDeniedView'
          );
          assert.equal(
            mktTourRouteAudit.hasErrorBoundary,
            false,
            'Expected /marketing NOT to render ErrorBoundary'
          );
          assert.equal(
            mktTourRouteAudit.hasVisibleMktScope,
            true,
            'Expected visible .mkt-scope on /marketing'
          );

          const openMktTour = async () =>
            page.evaluate(() => {
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
              const byTestId = Array.from(scope.querySelectorAll('[data-testid="open-mkt-tour"]')).find((el: any) => {
                const cs = g.getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }) as any;
              if (byTestId) {
                byTestId.click();
                return true;
              }
              const byLabel = Array.from(scope.querySelectorAll('button')).find((b: any) => {
                if (!(b.textContent || '').includes('Tour Hướng Dẫn')) return false;
                const cs = g.getComputedStyle(b);
                if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
                const r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              }) as any;
              if (byLabel) {
                byLabel.click();
                return true;
              }
              return false;
            });

          const triggeredMktTour = await openMktTour();
          assert.equal(
            triggeredMktTour,
            true,
            'Expected Marketing Automation Focus Tour trigger ([data-testid="open-mkt-tour"] or "Tour Hướng Dẫn") on /marketing'
          );

          await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 8_000 });
          const mktTourState = await page.evaluate(() => {
            const g = globalThis as any;
            const doc = g.document;
            const dialog = doc.querySelector('div[role="dialog"][aria-modal="true"]');
            const activeScope = Array.from(doc.querySelectorAll('main .mkt-scope')).find(
              (el: any) =>
                el.style?.display !== 'contents' &&
                !(
                  Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                  el.querySelectorAll('button, a, input, select, textarea').length <= 1
                ) &&
                g.getComputedStyle(el).visibility !== 'hidden'
            ) as any;
            const tourTargets = activeScope
              ? Array.from(activeScope.querySelectorAll('[data-tour]')).filter((el: any) => {
                  const cs = g.getComputedStyle(el);
                  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                })
              : [];
            const txt = dialog?.innerText || '';
            const lowerTxt = txt.toLowerCase();
            return {
              hasDialog: Boolean(dialog),
              tourTargetsCount: tourTargets.length,
              hasNext: lowerTxt.includes('tiếp theo') || lowerTxt.includes('bước tiếp'),
              hasSkip: lowerTxt.includes('bỏ qua') || lowerTxt.includes('đóng'),
              initialText: txt,
            };
          });
          assert.equal(mktTourState.hasDialog, true, 'Expected MarketingSpotlightTour dialog[aria-modal="true"]');
          assert.ok(mktTourState.tourTargetsCount >= 1, 'Expected [data-tour] target elements on /marketing');
          assert.equal(mktTourState.hasNext, true, 'Expected Next ("Tiếp theo"/"Bước tiếp") control in MarketingSpotlightTour');
          assert.equal(mktTourState.hasSkip, true, 'Expected Skip/Close control in MarketingSpotlightTour');

          // Advance to step 2 and verify progression + "Quay lại"
          const mktNextOk =
            (await clickButtonByText(page, 'Tiếp theo', {
              rootSelector: 'div[role="dialog"][aria-modal="true"]',
            })) ||
            (await clickButtonByText(page, 'Bước tiếp', {
              rootSelector: 'div[role="dialog"][aria-modal="true"]',
            }));
          assert.equal(mktNextOk, true, 'Expected to click "Tiếp theo" / "Bước tiếp" in MarketingSpotlightTour');
          await page.waitForFunction(
            (prevTxt: string) => {
              const dialog = (globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]');
              return Boolean(dialog && (dialog.innerText || '') !== prevTxt);
            },
            { timeout: 5_000 },
            mktTourState.initialText
          );
          const mktStep2Text = await page.evaluate(
            () => (globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]')?.innerText || ''
          );
          assert.notEqual(
            mktStep2Text,
            mktTourState.initialText,
            'Expected MarketingSpotlightTour step 2 text to differ from step 1'
          );

          const mktPrevOk = await clickButtonByText(page, 'Quay lại', {
            rootSelector: 'div[role="dialog"][aria-modal="true"]',
          });
          assert.equal(mktPrevOk, true, 'Expected "Quay lại" button on step 2 of MarketingSpotlightTour');
          await page.waitForFunction(
            (step1Txt: string, step2Txt: string) => {
              const dialog = (globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]');
              const cur = dialog?.innerText || '';
              return Boolean(dialog && (cur === step1Txt || (cur !== step2Txt && cur.toLowerCase().includes('bước 1'))));
            },
            { timeout: 5_000 },
            mktTourState.initialText,
            mktStep2Text
          );

          // Step through remaining steps until "Hoàn tất" appears and finish tour
          let mktFinished = false;
          for (let guard = 0; guard < 12; guard++) {
            const hasFinish = await clickButtonByText(page, 'Hoàn tất', {
              rootSelector: 'div[role="dialog"][aria-modal="true"]',
            });
            if (hasFinish) {
              mktFinished = true;
              break;
            }
            const stepped =
              (await clickButtonByText(page, 'Tiếp theo', {
                rootSelector: 'div[role="dialog"][aria-modal="true"]',
              })) ||
              (await clickButtonByText(page, 'Bước tiếp', {
                rootSelector: 'div[role="dialog"][aria-modal="true"]',
              }));
            assert.equal(stepped, true, `Expected "Tiếp theo"/"Bước tiếp" or "Hoàn tất" at tour step iteration ${guard}`);
            await sleep(150);
          }
          assert.equal(mktFinished, true, 'Expected to reach and click "Hoàn tất" in MarketingSpotlightTour');

          await page.waitForFunction(
            () => !(globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]'),
            { timeout: 5_000 }
          );

          const mktTourPersisted = await page.evaluate(() => {
            const ls = (globalThis as any).localStorage;
            const keys: string[] = [];
            for (let i = 0; i < ls.length; i++) {
              const k = ls.key(i);
              if (k && /mkt.*tour|marketing.*tour/i.test(k) && ls.getItem(k)) {
                keys.push(`${k}=${ls.getItem(k)}`);
              }
            }
            return keys;
          });
          assert.ok(
            mktTourPersisted.length >= 1,
            `Expected localStorage persistence after completing MarketingSpotlightTour, found keys=${JSON.stringify(mktTourPersisted)}`
          );

          // Re-open MarketingSpotlightTour and verify "Bỏ qua" / "Bỏ qua tour" closes cleanly
          assert.equal(await openMktTour(), true, 'Expected to re-open MarketingSpotlightTour');
          await page.waitForSelector('div[role="dialog"][aria-modal="true"]', { timeout: 5_000 });
          const mktSkipOk =
            (await clickButtonByText(page, 'Bỏ qua', {
              rootSelector: 'div[role="dialog"][aria-modal="true"]',
            })) ||
            (await clickButtonByText(page, 'Đóng', {
              rootSelector: 'div[role="dialog"][aria-modal="true"]',
            }));
          assert.equal(mktSkipOk, true, 'Expected "Bỏ qua" / "Đóng" button in MarketingSpotlightTour');
          await page.waitForFunction(
            () => !(globalThis as any).document.querySelector('div[role="dialog"][aria-modal="true"]'),
            { timeout: 5_000 }
          );

          assertCleanRuntime(page, netGuard, 'F10-T1-06 Focus Tours');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );
  });

  // =========================================================================
  // Tier 2 — Boundary, Negative & Edge Cases (>=5 tests)
  // =========================================================================
  describe('Tier 2: Boundary, Negative & Cross-Mode Edge Cases', () => {
    it(
      'F10-T2-01: zero console/runtime errors & network integrity across all 13 Marketing routes with .mkt-scope styling',
      { timeout: 120_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'domation_promax' });
        await seedMarketingFixtures(auth, { prefix: 'All13Routes' });

        const spaRoutes = [
          '/marketing',
          '/marketing/flows',
          '/marketing/campaigns',
          '/marketing/templates',
          '/marketing/audience',
          '/marketing/surveys',
          '/marketing/vouchers',
          '/marketing/social-bot',
          '/marketing/ai-training',
          '/marketing/web-tracking',
          '/marketing/api-triggers',
        ];
        const aliasRoutes = ['/meta-report', '/capi'];

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'domation_promax',
          },
          spaRoutes[0]
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 25_000);
          for (const route of spaRoutes) {
            if (route !== spaRoutes[0]) {
              await navigateSpaRoute(page, route);
            }
            const check = await waitForMainRouteReady(page, route, 20_000);

            assert.equal(check.pathname, route, `Expected SPA navigation to land on ${route}, got ${check.pathname}`);
            assert.equal(check.hasAccessDenied, false, `Expected ${route} NOT to render AccessDeniedView`);
            assert.equal(check.hasErrorBoundary, false, `Expected ${route} NOT to render ErrorBoundary`);
            assert.ok(
              check.mainTextLength > 40,
              `Expected non-empty <main> render (>40 chars) on route ${route}, got mainTextLength=${check.mainTextLength}`
            );
            const diag = browserHarness.collectRuntimeDiagnostics(page);
            assert.equal(
              check.hasVisibleMktScope,
              true,
              `Expected visible main .mkt-scope styling wrapper on ${route}. snippet=${JSON.stringify(check.mainSnippet)} consoleErrors=${JSON.stringify(diag.consoleErrors)}`
            );
          }

          assertCleanRuntime(page, netGuard, 'F10-T2-01 all 11 /marketing/* SPA routes');
        } finally {
          await browserHarness.closePage(page);
        }

        // Verify /meta-report and /capi on a clean fresh page (so SSE sockets stay bounded <= 4)
        const aliasPage = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'domation_promax',
          },
          aliasRoutes[0]
        );
        const aliasNetGuard = attachNetworkGuard(aliasPage);

        try {
          await waitForAppReady(aliasPage, 25_000);
          for (const route of aliasRoutes) {
            if (route !== aliasRoutes[0]) {
              await navigateRoute(aliasPage, route);
            }
            const check = await waitForMainRouteReady(aliasPage, route, 20_000);
            assert.equal(check.pathname, route, `Expected navigation to land on ${route}, got ${check.pathname}`);
            assert.equal(check.hasAccessDenied, false, `Expected ${route} NOT to render AccessDeniedView`);
            assert.equal(check.hasErrorBoundary, false, `Expected ${route} NOT to render ErrorBoundary`);
            assert.ok(
              check.mainTextLength > 40,
              `Expected non-empty <main> render (>40 chars) on route ${route}, got mainTextLength=${check.mainTextLength}`
            );
            if (route === '/meta-report') {
              assert.ok(
                check.hasVisibleDomMetaScope || check.hasVisibleMktScope,
                `Expected visible main .dom-meta-scope or .mkt-scope on ${route}`
              );
            } else {
              const diag = browserHarness.collectRuntimeDiagnostics(aliasPage);
              assert.equal(
                check.hasVisibleMktScope,
                true,
                `Expected visible main .mkt-scope styling wrapper on ${route} (true M3 contract, including /capi). snippet=${JSON.stringify(check.mainSnippet)} consoleErrors=${JSON.stringify(diag.consoleErrors)}`
              );
            }
          }

          assertCleanRuntime(aliasPage, aliasNetGuard, 'F10-T2-01 /meta-report + /capi');
        } finally {
          await browserHarness.closePage(aliasPage);
        }
      }
    );

    it(
      'F10-T2-02: live mode switch & reload (marketing_standalone -> domation_promax) reveals CRM Auto while preserving data',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
        const fixtures = await seedMarketingFixtures(auth, { prefix: 'UpgradePreserve' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'marketing_standalone',
          },
          '/marketing'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);
          await page.waitForSelector('aside.responsive-sidebar', { timeout: 15_000 });

          const beforeUpgrade = await page.evaluate(() => {
            const sidebar = (globalThis as any).document.querySelector('aside.responsive-sidebar');
            return {
              hasDataLink: Boolean(sidebar?.querySelector('a[href="/data"]')),
              hasSidebarUpgradeText: (sidebar?.textContent || '').includes('Nâng cấp'),
            };
          });
          assert.equal(beforeUpgrade.hasDataLink, false, 'CRM Auto /data must be hidden before upgrade');
          assert.equal(beforeUpgrade.hasSidebarUpgradeText, false, 'Sidebar must NOT contain "Nâng cấp" box before upgrade');

          // Verify Upgrade ("Nâng cấp") button is accessible inside /settings?tab=package_upgrade
          await navigateSpaRoute(page, '/settings?tab=package_upgrade');
          await page.waitForFunction(
            () => ((globalThis as any).document.querySelector('main')?.innerText || '').includes('Nâng cấp'),
            { timeout: 15_000 }
          );

          // Upgrade via billing/package-entitlements API
          const upgradeRes = await harness.upgradePackage(auth, 'domation_promax', {
            billingCycle: 'monthly',
            paymentMethod: 'wallet',
          });
          assert.ok(upgradeRes, 'Expected upgradePackage to succeed');

          // Reload and wait for /api/v1/myerp/tenant-config hydration
          await Promise.all([
            page.waitForResponse(
              (res) => res.url().includes('/api/v1/myerp/tenant-config') && res.status() === 200,
              { timeout: 20_000 }
            ),
            page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
          ]);
          await waitForAppReady(page, 25_000);

          await page.waitForFunction(
            () => {
              const sidebar = (globalThis as any).document.querySelector('aside.responsive-sidebar');
              return Boolean(sidebar && sidebar.querySelector('a[href="/data"]'));
            },
            { timeout: 20_000 }
          );

          // Navigate to CRM Auto (/data) and confirm it renders cleanly without AccessDeniedView or redirecting back to /marketing
          await navigateSpaRoute(page, '/data');
          await page.waitForFunction(
            () => {
              const g = globalThis as any;
              const mainText = (g.document.querySelector('main')?.innerText || '').trim();
              return g.location.pathname === '/data' && mainText.includes('Quản lý Data');
            },
            { timeout: 15_000 }
          );

          // Navigate back to Marketing flows & campaigns and verify pre-upgrade seeded records remain intact
          await navigateSpaRoute(page, '/marketing/flows');
          await page.waitForFunction(
            (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.flowName
          );

          await navigateSpaRoute(page, '/marketing/campaigns');
          await page.waitForFunction(
            (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.campaignName
          );

          assertCleanRuntime(page, netGuard, 'F10-T2-02 live mode switch & reload');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );

    it(
      'F10-T2-03: public unauthenticated routes (/s/:slug?tenant=... survey & /claim/:id voucher) submit cleanly without /login redirect',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
        const fixtures = await seedMarketingFixtures(auth, { prefix: 'PublicRoute' });

        let ctx: BrowserContext | undefined;
        let page: Page | undefined;

        try {
          ctx = await browserHarness.browser.createBrowserContext();
          page = await ctx.newPage();
          const netGuard = attachNetworkGuard(page);

          // 1. Public Survey (/s/:slug?tenant=...)
          const surveyUrl = `${browserHarness.frontendBaseUrl}/s/${encodeURIComponent(
            fixtures.survey.slug
          )}?tenant=${encodeURIComponent(auth.tenantSlug)}`;
          await page.goto(surveyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await waitForAppReady(page, 25_000);

          const surveyPath = await page.evaluate(() => (globalThis as any).location.pathname);
          assert.ok(surveyPath.startsWith('/s/'), `Expected to stay on /s/:slug, got ${surveyPath}`);

          await page.waitForSelector('div[id^="block-"] input', { timeout: 15_000 });
          await page.type('div[id^="block-"] input', 'Nguyễn Văn E2E');

          const submittedSurvey = await clickButtonByText(page, 'Nộp');
          assert.equal(submittedSurvey, true, 'Expected "Nộp" submit button on PublicSurveyPage');

          await page.waitForFunction(
            () => {
              const h1 = (globalThis as any).document.querySelector('h1');
              return Boolean(h1 && (h1.textContent || '').includes('Cảm ơn'));
            },
            { timeout: 15_000 }
          );

          // 2. Public Voucher Claim (/claim/:id)
          const voucherUrl = `${browserHarness.frontendBaseUrl}/claim/${encodeURIComponent(fixtures.voucher.id)}`;
          await page.goto(voucherUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await waitForAppReady(page, 25_000);

          const voucherPath = await page.evaluate(() => (globalThis as any).location.pathname);
          assert.ok(voucherPath.startsWith('/claim/'), `Expected to stay on /claim/:id, got ${voucherPath}`);

          await page.waitForSelector('input[placeholder="Nhập tên của bạn"]', { timeout: 15_000 });
          await page.type('input[placeholder="Nhập tên của bạn"]', 'Trần Thị Voucher');
          await page.type('input[type="email"][placeholder="Cần chính xác để nhận mã"]', `voucher-${Date.now()}@e2e.vn`);
          await page.type('input[type="tel"][placeholder="0901234567"]', '0909555666');

          await page.click('button[type="submit"]');
          await page.waitForFunction(
            () => ((globalThis as any).document.body.innerText || '').includes('Chúc mừng bạn!'),
            { timeout: 15_000 }
          );

          const issuedCode = await page.evaluate(() => {
            const doc = (globalThis as any).document;
            const codeEl = doc.querySelector('p.font-mono.tabular-nums');
            return (codeEl?.textContent || '').trim();
          });
          assert.ok(
            issuedCode.startsWith('E2EUI-'),
            `Expected issued voucher code starting with E2EUI-, got: "${issuedCode}"`
          );

          assertCleanRuntime(page, netGuard, 'F10-T2-03 public survey & voucher');
        } finally {
          await Promise.allSettled([page?.close(), ctx?.close()]);
        }
      }
    );

    it(
      'F10-T2-04: mobile viewport (390x844) responsiveness, zero horizontal overflow & mobile sidebar drawer ESC toggle',
      { timeout: 90_000 },
      async () => {
        const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
        await seedMarketingFixtures(auth, { prefix: 'MobileUi' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'marketing_standalone',
          },
          '/marketing/flows'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
          await waitForAppReady(page, 30_000);
          await sleep(400);

          for (const route of ['/marketing/flows', '/marketing/campaigns']) {
            if (route !== '/marketing/flows') {
              await navigateRoute(page, route);
              await sleep(400);
            }
            const overflow = await page.evaluate(() => {
              const g = globalThis as any;
              return {
                scrollWidth: g.document.documentElement.scrollWidth,
                innerWidth: g.window.innerWidth,
              };
            });
            assert.ok(
              overflow.scrollWidth <= overflow.innerWidth + 2,
              `Expected no horizontal overflow at 390x844 on ${route}: scrollWidth=${overflow.scrollWidth}, innerWidth=${overflow.innerWidth}`
            );
          }

          // Verify mobile bottom nav is present and toggle mobile quick-navigation launcher via button.mobile-menu-btn + close via Escape
          await page.waitForSelector('.mobile-bottom-nav', { timeout: 10_000 });
          await page.waitForSelector('button.mobile-menu-btn', { timeout: 10_000 });
          await page.click('button.mobile-menu-btn');
          await page.waitForFunction(
            () => ((globalThis as any).document.body.textContent || '').includes('Menu điều hướng nhanh'),
            { timeout: 8_000 }
          );

          const drawerOverflow = await page.evaluate(() => {
            const g = globalThis as any;
            return {
              scrollWidth: g.document.documentElement.scrollWidth,
              innerWidth: g.window.innerWidth,
            };
          });
          assert.ok(
            drawerOverflow.scrollWidth <= drawerOverflow.innerWidth + 2,
            `Expected no horizontal overflow with mobile launcher open: scrollWidth=${drawerOverflow.scrollWidth}, innerWidth=${drawerOverflow.innerWidth}`
          );

          await page.keyboard.press('Escape');
          await page.waitForFunction(
            () => !((globalThis as any).document.body.textContent || '').includes('Menu điều hướng nhanh'),
            { timeout: 5_000 }
          );

          assertCleanRuntime(page, netGuard, 'F10-T2-04 mobile 390x844 responsiveness');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );

    it(
      'F10-T2-05: unauthenticated redirect to /login & authenticated ESC LIFO dismissal for CampaignDetailDrawer + SystemOverviewModal',
      { timeout: 90_000 },
      async () => {
        // Part A: Unauthenticated visit to /marketing/flows redirects cleanly to /login
        let unauthCtx: BrowserContext | undefined;
        let unauthPage: Page | undefined;

        try {
          unauthCtx = await browserHarness.browser.createBrowserContext();
          unauthPage = await unauthCtx.newPage();
          const unauthGuard = attachNetworkGuard(unauthPage);

          await unauthPage.goto(`${browserHarness.frontendBaseUrl}/marketing/flows`, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          await unauthPage.waitForFunction(
            () => (globalThis as any).location.pathname === '/login',
            { timeout: 15_000 }
          );
          await waitForAppReady(unauthPage, 15_000);
          assertCleanRuntime(unauthPage, unauthGuard, 'F10-T2-05 unauthenticated redirect');
        } finally {
          await Promise.allSettled([unauthPage?.close(), unauthCtx?.close()]);
        }

        // Part B: Authenticated ESC LIFO dismissal for stacked TestEmailModal over CampaignDetailDrawer + SystemOverviewModal
        const auth = await harness.registerTenant({ packageCode: 'marketing_standalone' });
        const fixtures = await seedMarketingFixtures(auth, { sendCampaign: true, prefix: 'EscLifo' });

        const page = await browserHarness.openAuthenticatedPage(
          {
            accessToken: auth.accessToken,
            tenantSlug: auth.tenantSlug,
            user: toBrowserUser(auth),
            packageCode: 'marketing_standalone',
          },
          '/marketing/campaigns'
        );
        const netGuard = attachNetworkGuard(page);

        try {
          await waitForAppReady(page, 30_000);
          await page.waitForFunction(
            (name: string) => ((globalThis as any).document.querySelector('main')?.innerText || '').includes(name),
            { timeout: 15_000 },
            fixtures.campaignName
          );

          // Open CampaignDetailDrawer -> stack TestEmailModal on top -> verify ESC closes top modal first (LIFO), then drawer second
          await page.evaluate((name: string) => {
            const doc = (globalThis as any).document;
            const rows = Array.from(doc.querySelectorAll('tr, div.cursor-pointer')) as any[];
            const row = rows.find((r) => (r.textContent || '').includes(name));
            row?.click();
          }, fixtures.campaignName);

          await page.waitForSelector('.campaign-detail-drawer', { timeout: 10_000 });

          const openedStackedModal = await clickButtonByText(page, 'Gửi Test Email', {
            rootSelector: '.campaign-detail-drawer',
          });
          assert.equal(openedStackedModal, true, 'Expected "Gửi Test Email" button inside CampaignDetailDrawer');
          await page.waitForFunction(
            () => ((globalThis as any).document.getElementById('mkt-portal-root')?.innerText || '').includes('Kiểm tra hiển thị'),
            { timeout: 10_000 }
          );
          await sleep(250);

          // 1st ESC must close ONLY the top TestEmailModal while keeping .campaign-detail-drawer mounted
          await page.keyboard.press('Escape');
          await page.waitForFunction(
            () => !((globalThis as any).document.getElementById('mkt-portal-root')?.innerText || '').includes('Kiểm tra hiển thị'),
            { timeout: 5_000 }
          );
          const drawerStillOpen = await page.evaluate(() =>
            Boolean((globalThis as any).document.querySelector('.campaign-detail-drawer'))
          );
          assert.equal(
            drawerStillOpen,
            true,
            'LIFO invariant: 1st Escape must dismiss top TestEmailModal while keeping CampaignDetailDrawer open'
          );

          // 2nd ESC must close CampaignDetailDrawer
          await page.keyboard.press('Escape');
          await page.waitForFunction(
            () => !(globalThis as any).document.querySelector('.campaign-detail-drawer'),
            { timeout: 5_000 }
          );

          // Open SystemOverviewModal on /marketing and dismiss with Escape
          await navigateSpaRoute(page, '/marketing');
          await page.waitForFunction(
            () => ((globalThis as any).document.querySelector('main')?.innerText || '').includes('Tổng quan hệ thống'),
            { timeout: 15_000 }
          );

          const openedOverview = await page.evaluate(() => {
            const g = globalThis as any;
            const doc = g.document;
            const activeScope = Array.from(doc.querySelectorAll('main .mkt-scope')).find(
              (el: any) =>
                el.style?.display !== 'contents' &&
                !(
                  Boolean(el.querySelector('[data-testid*="date-picker"]')) &&
                  el.querySelectorAll('button, a, input, select, textarea').length <= 1
                ) &&
                g.getComputedStyle(el).visibility !== 'hidden'
            ) as any;
            if (!activeScope) return false;
            const cards = Array.from(activeScope.querySelectorAll('button, div.cursor-pointer, a')) as any[];
            const target = cards.find((el) => {
              if (!(el.textContent || '').includes('Tổng quan hệ thống')) return false;
              const cs = g.getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (!target) return false;
            target.click();
            return true;
          });
          assert.equal(openedOverview, true, 'Expected to click "Tổng quan hệ thống" card on /marketing');

          await page.waitForFunction(
            () => {
              const doc = (globalThis as any).document;
              const portalText = doc.getElementById('mkt-portal-root')?.innerText || '';
              const mainText = doc.querySelector('main')?.innerText || '';
              const hasErrorBoundary =
                mainText.includes('Đã xảy ra lỗi') ||
                mainText.includes('Đã xảy ra sự cố') ||
                mainText.includes('Không thể tải nội dung này');
              const overviewLoaded =
                portalText.toLowerCase().includes('tổng quan hệ thống') &&
                (portalText.toLowerCase().includes('ai chat phản hồi') ||
                  !doc.querySelector('#mkt-portal-root .animate-pulse'));
              return hasErrorBoundary || overviewLoaded;
            },
            { timeout: 10_000 }
          );
          const overviewOpenCheck = await page.evaluate(() => {
            const doc = (globalThis as any).document;
            const mainText = (doc.querySelector('main')?.innerText || '').trim();
            const portalText = (doc.getElementById('mkt-portal-root')?.innerText || '').trim();
            return {
              hasErrorBoundary:
                mainText.includes('Đã xảy ra lỗi') ||
                mainText.includes('Đã xảy ra sự cố') ||
                mainText.includes('Không thể tải nội dung này'),
              hasModalText: portalText.toLowerCase().includes('tổng quan hệ thống'),
              mainSnippet: mainText.slice(0, 220),
            };
          });
          assert.equal(
            overviewOpenCheck.hasErrorBoundary,
            false,
            `Expected opening SystemOverviewModal NOT to trigger ErrorBoundary, got: ${overviewOpenCheck.mainSnippet}`
          );
          assert.equal(
            overviewOpenCheck.hasModalText,
            true,
            'Expected SystemOverviewModal ("Tổng quan Hệ thống") to mount inside #mkt-portal-root'
          );
          await sleep(250);
          await page.keyboard.press('Escape');
          await page.waitForFunction(
            () => !((globalThis as any).document.getElementById('mkt-portal-root')?.innerText || '').toLowerCase().includes('tổng quan hệ thống'),
            { timeout: 5_000 }
          );
          const overviewAfterEsc = await page.evaluate(() => {
            const mainText = ((globalThis as any).document.querySelector('main')?.innerText || '').trim();
            return {
              hasErrorBoundary:
                mainText.includes('Đã xảy ra lỗi') ||
                mainText.includes('Đã xảy ra sự cố') ||
                mainText.includes('Không thể tải nội dung này'),
              hasAccessDenied: mainText.includes('Không có quyền truy cập'),
            };
          });
          assert.equal(
            overviewAfterEsc.hasErrorBoundary,
            false,
            'Expected <main> NOT to render ErrorBoundary after Escape on SystemOverviewModal'
          );
          assert.equal(
            overviewAfterEsc.hasAccessDenied,
            false,
            'Expected <main> NOT to render AccessDeniedView after Escape on SystemOverviewModal'
          );

          assertCleanRuntime(page, netGuard, 'F10-T2-05 ESC LIFO');
        } finally {
          await browserHarness.closePage(page);
        }
      }
    );
  });
});
