import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import {
  classifyRequestProtectionScope,
  createAntiAgentGuardMiddleware,
  DOMATION_AI_TXT_BODY,
  DOMATION_LICENSE_POLICY_TXT,
  DOMATION_LLMS_TXT_BODY,
  DOMATION_ROBOTS_TXT_BODY,
  DOMATION_SECURITY_TXT_BODY,
  DOMATION_TDMREP_JSON,
} from '../server/middleware/anti-agent-guard.ts';
import { apiRequest, startTestServer } from './helpers.ts';

function startSoftPolicyGuardServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createAntiAgentGuardMiddleware({ enforceInTest: true }));
  app.get('/.well-known/tdmrep.json', (_req, res) => res.json(DOMATION_TDMREP_JSON));
  app.get('/.well-known/security.txt', (_req, res) => res.type('text/plain').send(DOMATION_SECURITY_TXT_BODY));
  app.get('/ai.txt', (_req, res) => res.type('text/plain').send(DOMATION_AI_TXT_BODY));
  app.get('/license-policy.txt', (_req, res) => res.type('text/plain').send(DOMATION_LICENSE_POLICY_TXT));
  app.get(['/llms.txt', '/llms-full.txt'], (_req, res) => res.type('text/plain').send(DOMATION_LLMS_TXT_BODY));
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send(DOMATION_ROBOTS_TXT_BODY));
  app.all('*', (req, res) => {
    res.json({ ok: true, path: req.path, scope: classifyRequestProtectionScope(req) });
  });
  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test('Soft Copyright & AI Policy: serves /robots.txt, /llms.txt, /ai.txt, /license-policy.txt, /.well-known/tdmrep.json & security.txt on real Express app', async () => {
  const srv = await startTestServer();
  try {
    const tdmRes = await fetch(`${srv.baseUrl}/.well-known/tdmrep.json`);
    assert.equal(tdmRes.status, 200);
    const tdmJson = (await tdmRes.json()) as Record<string, any>;
    assert.equal(tdmJson.reservation, 1);
    assert.equal(tdmJson.enforcement_mode, 'soft_legal_policy_no_bot_blocking');
    assert.ok(String(tdmJson.policy_url).includes('/ai.txt'));

    const aiRes = await fetch(`${srv.baseUrl}/ai.txt`);
    assert.equal(aiRes.status, 200);
    const aiText = await aiRes.text();
    assert.match(aiText, /Codex/i);
    assert.match(aiText, /Antigravity/i);
    assert.match(aiText, /Claude/i);
    assert.match(aiText, /CẤM TUYỆT ĐỐI/i);

    const robotsRes = await fetch(`${srv.baseUrl}/robots.txt`);
    assert.equal(robotsRes.status, 200);
    const robotsText = await robotsRes.text();
    assert.match(robotsText, /Allow:\s*\//);
    assert.doesNotMatch(robotsText, /Disallow:\s*\//i, 'Soft policy must NOT Disallow bots in robots.txt');
    assert.match(robotsText, /llms\.txt/i);
    assert.match(robotsText, /Content-Signal:\s*search=yes/i);

    const llmsRes = await fetch(`${srv.baseUrl}/llms.txt`);
    assert.equal(llmsRes.status, 200);
    const llmsText = await llmsRes.text();
    assert.match(llmsText, /MANDATORY LEGAL LICENSE/i);
    assert.match(llmsText, /DOM AI Assistant/i);
    assert.match(llmsText, /CẤM TUYỆT ĐỐI CLONE UI\/UX/i);

    const licenseRes = await fetch(`${srv.baseUrl}/license-policy.txt`);
    assert.equal(licenseRes.status, 200);
    assert.match(await licenseRes.text(), /PROPRIETARY INTELLECTUAL PROPERTY/i);

    const secRes = await fetch(`${srv.baseUrl}/.well-known/security.txt`);
    assert.equal(secRes.status, 200);
    assert.match(await secRes.text(), /Contact:\s*mailto:turniodev@gmail\.com/i);

    const sdkRes = await fetch(`${srv.baseUrl}/api/v1/public/marketing/sdk.js`);
    assert.equal(sdkRes.status, 200);
    const sdkText = await sdkRes.text();
    assert.match(sdkText, /Proprietary Commercial Software/i);
  } finally {
    await srv.close();
  }
});

test('Soft Policy Mode: NEVER blocks ANY SEO bot, AI crawler, or coding agent (zero 403 UA blocks), while attaching full copyright, TDM, Content-Signal & Link(llms.txt) headers immediately', async () => {
  const guardSrv = await startSoftPolicyGuardServer();
  try {
    const paths = ['/', '/dom-ai', '/data', '/meta-report', '/crm', '/erp', '/boost', '/llms.txt', '/robots.txt', '/assets/c-abc12345.js', '/api/v1/health'];
    const allBotsAndAgents = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 AppleWebKit/537.36 (compatible; OAI-SearchBot/1.0)',
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
      'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
      'OpenAI-Codex/1.0',
      'Antigravity/2.0',
      'Claude-User/1.0',
      'Firecrawl/1.0',
      'Scrapy/2.11',
      'HTTrack 3.49',
      'Mozilla/5.0 HeadlessChrome/131.0.0.0',
      'Playwright/1.50',
    ];

    for (const p of paths) {
      for (const ua of allBotsAndAgents) {
        const res = await fetch(`${guardSrv.baseUrl}${p}`, { headers: { 'User-Agent': ua } });
        assert.equal(res.status, 200, `Soft policy must NEVER block ${p} for UA ${ua}`);
        assert.equal(res.headers.get('tdm-reservation'), '1');
        assert.equal(res.headers.get('tdm-policy'), 'https://domation.net/.well-known/tdmrep.json');
        assert.equal(res.headers.get('content-signal'), 'search=yes, ai-input=yes, ai-train=no');
        assert.match(res.headers.get('link') || '', /rel="llms-txt"/i);
        assert.match(res.headers.get('link') || '', /rel="license"/i);
        assert.match(res.headers.get('x-ai-agent-policy') || '', /STRICTLY PROHIBITED/i);
        assert.match(res.headers.get('x-copyright-notice') || '', /DOMATION/i);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        if (!p.startsWith('/api/') && !p.startsWith('/assets/')) {
          assert.equal(res.headers.get('x-robots-tag'), null, `Public SEO page ${p} must never emit X-Robots-Tag noindex`);
        }
      }
    }
  } finally {
    await guardSrv.close();
  }
});

test('Real Application Security: JWT Auth guards private APIs, URL sanitizer blocks javascript: XSS, and rate limiter enforces 429 on public endpoints', async () => {
  const srv = await startTestServer();
  try {
    // 1. Private APIs reject unauthenticated requests with 401 (real auth, not UA blocking)
    const unauthLeads = await fetch(`${srv.baseUrl}/api/v1/leads`);
    assert.equal(unauthLeads.status, 401);
    const unauthPortals = await fetch(`${srv.baseUrl}/api/v1/dom-ai-portal/portals`);
    assert.equal(unauthPortals.status, 401);

    // 2. Register tenant and verify XSS URL sanitization on DOM AI Portal creation
    const reg = await apiRequest(srv.baseUrl, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        company_name: 'SecAudit Corp',
        tenant_slug: 'secaudit',
        admin_name: 'Sec Admin',
        work_email: 'sec@secaudit.vn',
        phone: '0901234567',
        password: 'SecurePassword123!',
        industry: 'technology',
        seed_demo_leads: false,
      },
    });
    assert.equal(reg.status, 201);
    const token = reg.json.data.access_token;
    const slug = reg.json.data.tenant.slug;

    const createPortal = await apiRequest(srv.baseUrl, '/api/v1/dom-ai-portal/portals', {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: {
        name: 'Sec Portal',
        slug: 'sec-portal-xss',
        logo_url: 'javascript:alert(document.cookie)',
        auth_mode: 'public_bypass',
      },
    });
    assert.equal(createPortal.status, 201);
    assert.equal(createPortal.json.data.logo_url, '', 'javascript: logo_url must be stripped to empty string');

    const createDoc = await apiRequest(srv.baseUrl, `/api/v1/dom-ai-portal/portals/${createPortal.json.data.id}/documents`, {
      method: 'POST',
      token,
      tenantSlug: slug,
      body: {
        title: 'XSS Attachment Test',
        content: 'Valid knowledge body content',
        attachment_url: 'javascript:alert(1)',
        thumbnail_url: 'data:text/html,<script>alert(1)</script>',
      },
    });
    assert.equal(createDoc.status, 201);
    assert.equal(createDoc.json.data.attachment_url, '');
    assert.equal(createDoc.json.data.thumbnail_url, '');

    // 3. Sliding-window rate limiter returns 429 after burst on public OTP endpoint (when enforced via header)
    let hit429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${srv.baseUrl}/api/v1/public/marketing/otp/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Test-Enforce-Rate-Limit': '1',
        },
        body: JSON.stringify({
          tenant_slug: slug,
          channel: 'email',
          recipient: 'ratelimit.test@secaudit.vn',
          purpose: 'sec_test',
        }),
      });
      if (r.status === 429) {
        hit429 = true;
        const j = (await r.json()) as Record<string, any>;
        assert.equal(j.error?.code, 'RATE_LIMIT_EXCEEDED');
        assert.ok(Number(r.headers.get('retry-after')) >= 1);
        break;
      }
    }
    assert.equal(hit429, true, 'Expected 429 RATE_LIMIT_EXCEEDED after >10 OTP sends/min');
  } finally {
    await srv.close();
  }
});
