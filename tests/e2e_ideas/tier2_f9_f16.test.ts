import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import {
  LIVE_PGLITE_DATA_DIR,
  REPO_ROOT,
  assertNotLivePgDataDir,
  assertTestRecipientsOnly,
  buildSyntheticMyerpSql,
  createIsolatedContext,
  makeTestRecipient,
  runCliSubprocess,
  seedIdeasTenant,
  seedSiblingTenant,
  signSnsNotification,
  triggerMasterCron,
  type IsolatedE2eContext,
  type SeededTenantContext,
} from './harness.ts';
import {
  withSystemPrivilege,
  withTenantTransaction,
  withUnscopedRlsCheck,
} from '../../server/core/database/transaction.ts';
import { upsertMasterContactInTx } from '../../server/modules/audiences/audiences.service.ts';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild') as typeof import('esbuild');

const ERP_REPO_ROOT = process.env.DOMATION_ERP_DIR
  ? path.resolve(process.env.DOMATION_ERP_DIR)
  : path.resolve(REPO_ROOT, '..', 'DOMATION_ERP_FULL');

const LANDING_REPO_ROOT = process.env.DOMATION_FRONTEND_DIR
  ? path.resolve(process.env.DOMATION_FRONTEND_DIR)
  : path.resolve(REPO_ROOT, '..', 'DOMATION_LANDINGPAGE');

function resolveBashPathEntries(stubBinDir: string): string[] {
  const entries = [stubBinDir];
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Users\\LENOVO\\PortableGit\\usr\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
      'C:\\Program Files (x86)\\Git\\usr\\bin',
    ];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'bash.exe'))) {
        entries.push(dir);
        break;
      }
    }
  } else {
    entries.push('/usr/bin', '/bin');
  }
  return entries;
}

function resolveChecklistPath(): string {
  const candidates = [
    path.join(REPO_ROOT, 'MANUAL_CUTOVER_CHECKLIST.md'),
    path.join(REPO_ROOT, 'docs', 'MANUAL_CUTOVER_CHECKLIST.md'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function rawHttpGetStatus(baseUrl: string, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path: rawPath,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function snapshotDirStats(dirPath: string): { exists: boolean; fileCount: number; maxMtimeMs: number } {
  if (!fs.existsSync(dirPath)) return { exists: false, fileCount: 0, maxMtimeMs: 0 };
  let fileCount = 0;
  let maxMtimeMs = 0;
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const st = fs.statSync(full);
      if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      if (ent.isDirectory()) walk(full);
      else fileCount += 1;
    }
  };
  walk(dirPath);
  return { exists: true, fileCount, maxMtimeMs };
}

function walkFiles(dirPath: string, filterFn: (p: string) => boolean, acc: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return acc;
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) walkFiles(full, filterFn, acc);
    else if (filterFn(full)) acc.push(full);
  }
  return acc;
}

async function seedCampaignEmailSetup(
  ctx: IsolatedE2eContext,
  tenant: SeededTenantContext,
  opts: {
    leadEmail: string;
    leadName?: string;
    templateHtml?: string;
    subject?: string;
  }
): Promise<{ leadId: string; audienceId: string; templateId: string; campaignId: string }> {
  assertTestRecipientsOnly([opts.leadEmail]);
  const leadRes = await ctx.apiJson<{ data: { id?: string; lead_id?: string } }>('/api/v1/leads', {
    method: 'POST',
    token: tenant.accessToken,
    tenantSlug: tenant.tenantSlug,
    body: {
      name: opts.leadName ?? 'Tier2 Test Lead',
      email: opts.leadEmail,
      phone: `090${String(Math.floor(1000000 + Math.random() * 8999999))}`,
      status: 'marketing_nurture',
      email_consent: 'subscribed',
    },
  });
  const leadId = String(leadRes.data.lead_id || leadRes.data.id || '');
  const audRes = await ctx.apiJson<{ data: { id: string } }>('/api/v1/audiences', {
    method: 'POST',
    token: tenant.accessToken,
    tenantSlug: tenant.tenantSlug,
    body: {
      name: `T2-Aud-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      audience_type: 'static_data',
      initial_lead_ids: [leadId],
    },
  });
  const tplRes = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/templates', {
    method: 'POST',
    token: tenant.accessToken,
    tenantSlug: tenant.tenantSlug,
    body: {
      name: `T2-Tpl-${Date.now()}`,
      subject: opts.subject ?? 'Tier2 Subject',
      compiled_html:
        opts.templateHtml ??
        '<html><body><a href="https://ideas.edu.vn/mba">Info</a><a href="{{unsubscribe_url}}">Unsub</a></body></html>',
    },
  });
  const campRes = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/campaigns', {
    method: 'POST',
    token: tenant.accessToken,
    tenantSlug: tenant.tenantSlug,
    body: {
      name: `T2-Camp-${Date.now()}`,
      channel: 'email',
      audience_id: audRes.data.id,
      template_id: tplRes.data.id,
      subject_a: opts.subject ?? 'Tier2 Subject',
    },
  });
  return { leadId, audienceId: audRes.data.id, templateId: tplRes.data.id, campaignId: campRes.data.id };
}

async function withBundledErpModule<T>(
  entryRelPath: string,
  defineEnv: Record<string, string>,
  mockWindow: Record<string, unknown>,
  fn: (mod: any, storage: Map<string, string>) => Promise<T> | T,
  initialStorage: Record<string, string> = {}
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-erp-t2-'));
  const outFile = path.join(tmpDir, 'bundle.mjs');
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevStorage = g.localStorage;
  try {
    await esbuild.build({
      entryPoints: [path.join(ERP_REPO_ROOT, 'src', entryRelPath)],
      outfile: outFile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: true,
      define: {
        'import.meta.env': JSON.stringify(defineEnv),
        'import.meta.env.VITE_API_ORIGIN': JSON.stringify(defineEnv.VITE_API_ORIGIN ?? ''),
        'import.meta.env.VITE_API_URL': JSON.stringify(defineEnv.VITE_API_URL ?? ''),
        'import.meta.env.VITE_DEFAULT_TENANT_SLUG': JSON.stringify(defineEnv.VITE_DEFAULT_TENANT_SLUG ?? 'ecolife'),
        'import.meta.env.VITE_APP_TITLE': JSON.stringify(defineEnv.VITE_APP_TITLE ?? 'DOMATION ERP'),
      },
    });
    const storageMap = new Map<string, string>(Object.entries(initialStorage));
    const localStorageShim = {
      getItem: (k: string) => (storageMap.has(k) ? storageMap.get(k)! : null),
      setItem: (k: string, v: string) => {
        storageMap.set(k, String(v));
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
      clear: () => {
        storageMap.clear();
      },
    };
    g.localStorage = localStorageShim;
    g.window = {
      fetch: async () => new Response('{}', { status: 200 }),
      ...mockWindow,
      localStorage: localStorageShim,
    };
    const mod = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}-${Math.random()}`);
    return await fn(mod, storageMap);
  } finally {
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevStorage === undefined) delete g.localStorage;
    else g.localStorage = prevStorage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Feature F9: Backend Domain Cutover (domation.net) — Boundary & Negative
// ============================================================================
describe('Tier 2 — F9: Backend Domain Cutover Boundaries', () => {
  it('[F9][T2] production host-header spoofing prevention rejects evil.com and localhost:9999', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAppPublicUrl = process.env.APP_PUBLIC_URL;
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const form = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/forms', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Spoof Guard Form',
          fields: [{ id: 'f1', key: 'email', label: 'Email', type: 'email', required: true }],
        },
      });

      process.env.NODE_ENV = 'production';
      for (const appUrl of ['https://data.domation.net', '']) {
        process.env.APP_PUBLIC_URL = appUrl;
        for (const badHost of ['evil.com', 'localhost:9999']) {
          const embed = await ctx.apiJson<{ data: { snippets: Record<string, string> } }>(
            `/api/v1/marketing/forms/${form.data.id}/embed-config`,
            {
              token: ideas.accessToken,
              tenantSlug: 'ideas',
              headers: { 'X-Forwarded-Host': badHost, 'X-Forwarded-Proto': 'http' },
            }
          );
          assert.ok(embed.data.snippets.iframe.includes('https://data.domation.net/'));
          assert.equal(embed.data.snippets.iframe.includes(badHost), false);

          const sdk = await ctx.apiRaw('/api/v1/public/marketing/sdk.js', {
            query: { site_key: 'wp_ideas_spoof' },
            headers: { 'X-Forwarded-Host': badHost, 'X-Forwarded-Proto': 'http' },
          });
          assert.equal(sdk.status, 200);
          assert.ok(sdk.rawText.includes('https://data.domation.net/api/v1/public/marketing/track'));
          assert.equal(sdk.rawText.includes(badHost), false);
        }
      }
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevAppPublicUrl === undefined) delete process.env.APP_PUBLIC_URL;
      else process.env.APP_PUBLIC_URL = prevAppPublicUrl;
      await ctx.close();
    }
  });

  it('[F9][T2] development local-loopback override preserves 127.0.0.1 and comma-separated X-Forwarded-Host uses first host', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      process.env.NODE_ENV = 'development';
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const form = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/forms', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Localhost Dev Form',
          fields: [{ id: 'f1', key: 'email', label: 'Email', type: 'email', required: true }],
        },
      });

      const localEmbed = await ctx.apiJson<{ data: { snippets: Record<string, string> } }>(
        `/api/v1/marketing/forms/${form.data.id}/embed-config`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.ok(localEmbed.data.snippets.iframe.includes(ctx.baseUrl));

      const multiProxyEmbed = await ctx.apiJson<{ data: { snippets: Record<string, string> } }>(
        `/api/v1/marketing/forms/${form.data.id}/embed-config`,
        {
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          headers: {
            'X-Forwarded-Host': 'data.domation.net, proxy.internal',
            'X-Forwarded-Proto': 'https',
          },
        }
      );
      assert.ok(multiProxyEmbed.data.snippets.iframe.includes('https://data.domation.net/'));
      assert.equal(multiProxyEmbed.data.snippets.iframe.includes('proxy.internal'), false);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      await ctx.close();
    }
  });

  it('[F9][T2] click tracker rejects dangerous schemes, protocol-relative URLs, empty url, and strips CRLF', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const { campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: makeTestRecipient('f9-click-sec'),
      });
      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const claimId = msg.html.match(/\/track\/open\/([0-9a-f-]+)/i)?.[1];
      assert.ok(claimId);

      for (const badUrl of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.com', '']) {
        const clickResp: { data: { redirect_url: string } } = await ctx.apiJson<{ data: { redirect_url: string } }>(
          `/api/v1/public/marketing/track/click/${claimId}`,
          { query: { url: badUrl, json: '1' } }
        );
        assert.equal(clickResp.data.redirect_url, 'https://domation.net', `Unsafe URL ${badUrl} must fall back`);
      }

      const crlfRes = await ctx.apiJson<{ data: { redirect_url: string } }>(
        `/api/v1/public/marketing/track/click/${claimId}`,
        { query: { url: 'https://ideas.edu.vn/ok\r\nSet-Cookie:evil=1', json: '1' } }
      );
      assert.equal(/[\r\n]/.test(crlfRes.data.redirect_url), false);
      assert.ok(crlfRes.data.redirect_url.startsWith('https://ideas.edu.vn/ok'));
    } finally {
      await ctx.close();
    }
  });

  it('[F9][T2] open/click idempotency preserves counters and non-downgrade from clicked to opened, plus invalid UUID safety', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const { campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: makeTestRecipient('f9-idem'),
      });
      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const claimId = msg.html.match(/\/track\/open\/([0-9a-f-]+)/i)?.[1];
      assert.ok(claimId);

      for (let i = 0; i < 3; i++) {
        assert.equal((await fetch(`${ctx.baseUrl}/api/v1/public/marketing/track/open/${claimId}`)).status, 200);
      }
      await ctx.apiJson(`/api/v1/public/marketing/track/click/${claimId}`, {
        query: { url: 'https://ideas.edu.vn/mba', json: '1' },
      });
      // Replaying open AFTER click must NOT downgrade status back to 'opened'
      assert.equal((await fetch(`${ctx.baseUrl}/api/v1/public/marketing/track/open/${claimId}`)).status, 200);

      const detail = await ctx.apiJson<{
        data: { campaign: { opened_count: number; clicked_count: number }; claims: Array<{ status: string }> };
      }>(`/api/v1/marketing/campaigns/${campaignId}/detail`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(detail.data.campaign.opened_count, 1);
      assert.equal(detail.data.campaign.clicked_count, 1);
      assert.equal(detail.data.claims[0].status, 'clicked');

      const badOpen = await fetch(`${ctx.baseUrl}/api/v1/public/marketing/track/open/not-a-uuid`);
      assert.equal(badOpen.status, 200);
      assert.equal(badOpen.headers.get('content-type'), 'image/gif');
    } finally {
      await ctx.close();
    }
  });

  it('[F9][T2] unsubscribe rejects missing, tampered, wrong-channel, wrong-tenant HMAC signatures and invalid UUIDs', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const sibling = await seedSiblingTenant(ctx, 'ecolife');
      const recipient = makeTestRecipient('f9-unsub-tamper');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const unsubUrl = new URL(
        msg.html.match(/https?:\/\/[^"'\s<]*\/api\/v1\/public\/marketing\/unsubscribe\?[^"'\s<]+/i)![0].replace(
          /&amp;/g,
          '&'
        )
      );
      const validSig = unsubUrl.searchParams.get('sig')!;
      const flippedSig = (validSig[0] === 'a' ? 'b' : 'a') + validSig.slice(1);

      const cases: Array<Record<string, string>> = [
        { tenant_id: ideas.tenantId, lead_id: leadId, channel: 'email' },
        { tenant_id: ideas.tenantId, lead_id: leadId, channel: 'email', sig: flippedSig },
        { tenant_id: ideas.tenantId, lead_id: leadId, channel: 'zns', sig: validSig },
        { tenant_id: sibling.tenantId, lead_id: leadId, channel: 'email', sig: validSig },
        { tenant_id: ideas.tenantId, lead_id: 'not-a-uuid', channel: 'email', sig: validSig },
      ];
      for (const query of cases) {
        const res = await ctx.apiRaw('/api/v1/public/marketing/unsubscribe', { query });
        assert.equal(res.status, 403, `Expected 403 for query ${JSON.stringify(query)}, got ${res.status}`);
        assert.equal(res.json?.error?.code, 'INVALID_UNSUBSCRIBE_SIGNATURE');
      }

      const leadsRes = await ctx.apiJson<{ data: { items: Array<{ id: string; email_consent: string }> } }>(
        '/api/v1/leads',
        { token: ideas.accessToken, tenantSlug: 'ideas', query: { search: recipient } }
      );
      assert.equal(leadsRes.data.items.find((l) => l.id === leadId)?.email_consent, 'subscribed');
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F10: Legacy Media Assets & Link Rewriting — Boundary & Negative
// ============================================================================
describe('Tier 2 — F10: /uploadss/* Boundaries & M3 Rewrite Preservation', () => {
  it('[F10][T2] /uploadss/* blocks raw, percent-encoded, nested, backslash, and null-byte path traversal variants with 403', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-trav-');
      process.env.UPLOADS_DIR = uploadsDir;
      fs.writeFileSync(path.join(uploadsDir, 'ok.txt'), 'ok', 'utf8');

      for (const badPath of [
        '/uploadss/../.env',
        '/uploadss/%2e%2e/.env',
        '/uploadss/%2E%2E/package.json',
        '/uploadss/ai_generated/../../.env',
        '/uploadss/..%5cpackage.json',
        '/uploadss/test%00.png',
      ]) {
        const res = await rawHttpGetStatus(ctx.baseUrl, badPath);
        assert.equal(res.status, 403, `Expected 403 for ${badPath}, got ${res.status}`);
      }
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T2] /uploadss/* blocks symlink escaping outside UPLOADS_DIR with 403', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-sym-root-');
      const outsideDir = ctx.createTempDir('f10-sym-outside-');
      process.env.UPLOADS_DIR = uploadsDir;
      const secretFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(secretFile, 'TOP_SECRET_OUTSIDE', 'utf8');

      const linkFile = path.join(uploadsDir, 'escape.txt');
      let probeUrl = '/uploadss/escape.txt';
      try {
        fs.symlinkSync(secretFile, linkFile, 'file');
      } catch (err: any) {
        if (process.platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
          // Directory junction works unprivileged on Windows and exercises realpath escape check
          const linkDir = path.join(uploadsDir, 'escape-dir');
          fs.symlinkSync(outsideDir, linkDir, 'junction');
          probeUrl = '/uploadss/escape-dir/secret.txt';
        } else {
          throw err;
        }
      }

      const res = await rawHttpGetStatus(ctx.baseUrl, probeUrl);
      assert.equal(res.status, 403, `Symlink/junction escape must return 403, got ${res.status}`);
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T2] /uploadss/* rejects POST, PUT, DELETE, PATCH with 405 and malformed %ZZ URI with 400', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-methods-');
      process.env.UPLOADS_DIR = uploadsDir;
      fs.writeFileSync(path.join(uploadsDir, 'banner.jpg'), 'JPG', 'utf8');

      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${ctx.baseUrl}/uploadss/banner.jpg`, { method });
        assert.equal(res.status, 405, `Method ${method} on /uploadss/* must return 405`);
      }

      const badUri = await rawHttpGetStatus(ctx.baseUrl, '/uploadss/%ZZbad');
      assert.equal(badUri.status, 400);
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T2] /uploadss, /uploadss/, directory path, and missing asset return 404 with empty body', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-404-');
      process.env.UPLOADS_DIR = uploadsDir;
      fs.mkdirSync(path.join(uploadsDir, 'ai_generated'), { recursive: true });

      for (const reqPath of ['/uploadss', '/uploadss/', '/uploadss/ai_generated', '/uploadss/does-not-exist.png']) {
        const res = await fetch(`${ctx.baseUrl}${reqPath}`);
        assert.equal(res.status, 404, `Expected 404 for ${reqPath}, got ${res.status}`);
        assert.equal(await res.text(), '', `Expected empty body for ${reqPath}`);
      }
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T2] /uploadss/* serves URL-encoded space/parentheses filenames and zero-byte binary assets accurately', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-enc-');
      process.env.UPLOADS_DIR = uploadsDir;
      fs.writeFileSync(path.join(uploadsDir, 'course guide (2026).pdf'), 'PDF_SPACE_CONTENT', 'utf8');
      fs.writeFileSync(path.join(uploadsDir, 'empty.png'), Buffer.alloc(0));

      const spaceRes = await fetch(`${ctx.baseUrl}/uploadss/course%20guide%20(2026).pdf`);
      assert.equal(spaceRes.status, 200);
      assert.equal(await spaceRes.text(), 'PDF_SPACE_CONTENT');

      const emptyRes = await fetch(`${ctx.baseUrl}/uploadss/empty.png`);
      assert.equal(emptyRes.status, 200);
      assert.equal((await emptyRes.arrayBuffer()).byteLength, 0);
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T2] M3 CLI migrate-myerp-ideas.ts preserves non-IDEAS external URLs and JSON structure while rewriting uploadss links', async () => {
    const migrateScript = path.join(REPO_ROOT, 'scripts', 'migrate-myerp-ideas.ts');
    assert.equal(
      fs.existsSync(migrateScript),
      true,
      'M3 deliverable missing: scripts/migrate-myerp-ideas.ts is required to verify non-IDEAS URL preservation'
    );

    const dump = buildSyntheticMyerpSql();
    let ctx1: IsolatedE2eContext | null = null;
    let ctx2: IsolatedE2eContext | null = null;
    let pgDir = '';

    try {
      ctx1 = await createIsolatedContext({
        dbMode: 'tempdir',
        cleanupDataDir: false,
        seedSuperAdmin: true,
      });
      pgDir = assertNotLivePgDataDir(ctx1.dataDir!, REPO_ROOT, 'F10 T2 pgDir');

      const ecolife = await seedSiblingTenant(ctx1, 'ecolife', { packageCode: 'growth_combo' });
      const ecoTpl = await ctx1.apiJson<{ data: { id: string } }>('/api/v1/marketing/templates', {
        method: 'POST',
        token: ecolife.accessToken,
        tenantSlug: 'ecolife',
        body: {
          name: 'Ecolife Untouched External Template',
          subject: 'Ecolife Promo',
          compiled_html:
            '<html><body><img src="https://cdn.ecolife-partner.example/hero.png"/><a href="https://automation.ideas.edu.vn/legacy-keep">Keep Sibling</a></body></html>',
        },
      });

      await ctx1.close();
      ctx1 = null;

      const cliRes = await runCliSubprocess(
        ['scripts/migrate-myerp-ideas.ts', '--sql', dump.sqlPath, '--tenant', 'ideas'],
        {
          runner: 'tsx',
          env: {
            PGLITE_DATA_DIR: pgDir,
            NODE_ENV: 'production',
            OUTBOUND_SILENT_MODE: 'true',
          },
        }
      );
      assert.equal(cliRes.status, 0, `Migration CLI failed: ${cliRes.stderr}\n${cliRes.stdout}`);

      ctx2 = await createIsolatedContext({
        dbMode: 'tempdir',
        dataDir: pgDir,
        cleanupDataDir: false,
        seedSuperAdmin: false,
      });

      // Sibling ecolife's URLs must remain untouched
      await withTenantTransaction(ecolife.tenantId, async (client) => {
        const r = await client.query<{ compiled_html: string }>(
          'SELECT compiled_html FROM mkt_email_templates WHERE tenant_id = $1 AND id = $2',
          [ecolife.tenantId, ecoTpl.data.id]
        );
        assert.ok(r.rows[0]?.compiled_html.includes('https://cdn.ecolife-partner.example/hero.png'));
        assert.ok(r.rows[0]?.compiled_html.includes('https://automation.ideas.edu.vn/legacy-keep'));
      });

      const tenantRes = await withSystemPrivilege((client) =>
        client.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'ideas'`)
      );
      assert.equal(tenantRes.rows.length, 1, 'Expected migrated ideas tenant in isolated DB');
      const ideasTenantId = tenantRes.rows[0].id;

      // Migrated IDEAS templates must have non-null JSON blocks, rewrite uploadss/ URLs, and preserve non-uploadss URLs
      const tplRes = await withSystemPrivilege((client) =>
        client.query<{ compiled_html: string; blocks_json: unknown }>(
          'SELECT compiled_html, blocks_json FROM mkt_email_templates WHERE tenant_id = $1',
          [ideasTenantId]
        )
      );
      assert.ok(tplRes.rows.length >= 1, 'Expected >= 1 migrated mkt_email_templates row for ideas');
      for (const row of tplRes.rows) {
        assert.ok(
          row.blocks_json !== null && typeof row.blocks_json === 'object',
          'mkt_email_templates.blocks_json must be a non-null JSON array/object'
        );
        const blocksText = JSON.stringify(row.blocks_json);
        assert.equal(
          /(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn\/backend)\/uploadss/i.test(row.compiled_html),
          false,
          'mkt_email_templates.compiled_html still has legacy uploadss URL'
        );
        assert.equal(
          /(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn\/backend)\/uploadss/i.test(blocksText),
          false,
          'mkt_email_templates.blocks_json still has legacy uploadss URL'
        );
      }
      assert.ok(
        tplRes.rows.some((r) => r.compiled_html.includes('https://data.domation.net/uploadss/')),
        'Expected rewritten https://data.domation.net/uploadss/ URL in mkt_email_templates.compiled_html'
      );
      assert.ok(
        tplRes.rows.some((r) => r.compiled_html.includes('timer.php?target=2026-12-01')),
        'Expected non-uploadss URL timer.php?target=2026-12-01 preserved in mkt_email_templates.compiled_html'
      );
      assert.ok(
        tplRes.rows.some((r) => JSON.stringify(r.blocks_json).includes('https://data.domation.net/uploadss/')),
        'Expected rewritten https://data.domation.net/uploadss/ URL in mkt_email_templates.blocks_json'
      );

      // Migrated IDEAS flows must have non-null JSON steps and rewrite uploadss/ URLs
      const flowRes = await withSystemPrivilege((client) =>
        client.query<{ steps_json: unknown }>(
          'SELECT steps_json FROM mkt_flows WHERE tenant_id = $1',
          [ideasTenantId]
        )
      );
      assert.ok(flowRes.rows.length >= 1, 'Expected >= 1 migrated mkt_flows row for ideas');
      for (const row of flowRes.rows) {
        assert.ok(
          row.steps_json !== null && typeof row.steps_json === 'object',
          'mkt_flows.steps_json must be a non-null JSON array/object'
        );
        assert.equal(
          /(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn\/backend)\/uploadss/i.test(JSON.stringify(row.steps_json)),
          false,
          'mkt_flows.steps_json still has legacy uploadss URL'
        );
      }
      assert.ok(
        flowRes.rows.some((r) => JSON.stringify(r.steps_json).includes('https://data.domation.net/uploadss/')),
        'Expected rewritten https://data.domation.net/uploadss/ URL in mkt_flows.steps_json'
      );

      // Migrated IDEAS short links must rewrite uploadss target_url while keeping non-uploadss go/ link if present
      const slRes = await withSystemPrivilege((client) =>
        client.query<{ target_url: string; qr_design_json: unknown }>(
          'SELECT target_url, qr_design_json FROM mkt_short_links WHERE tenant_id = $1',
          [ideasTenantId]
        )
      );
      assert.ok(slRes.rows.length >= 1, 'Expected >= 1 migrated mkt_short_links row for ideas');
      for (const row of slRes.rows) {
        assert.equal(
          /(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn\/backend)\/uploadss/i.test(row.target_url),
          false,
          'mkt_short_links.target_url still has legacy uploadss URL'
        );
      }
      assert.ok(
        slRes.rows.some((r) => r.target_url.includes('https://data.domation.net/uploadss/')),
        'Expected rewritten https://data.domation.net/uploadss/ URL in mkt_short_links.target_url'
      );
      const qrWithGo = slRes.rows.find((r) => JSON.stringify(r.qr_design_json || {}).includes('/go/'));
      if (qrWithGo) {
        assert.ok(
          JSON.stringify(qrWithGo.qr_design_json).includes('go/95c20d1d'),
          'Expected non-uploadss go/95c20d1d link preserved in mkt_short_links.qr_design_json'
        );
      }
    } finally {
      if (ctx1) await ctx1.close();
      if (ctx2) await ctx2.close();
      dump.cleanup();
      if (pgDir) {
        assertNotLivePgDataDir(pgDir, REPO_ROOT, 'F10 T2 cleanup pgDir');
        fs.rmSync(pgDir, { recursive: true, force: true });
      }
    }
  });
});

// ============================================================================
// Feature F11: AWS SES/SNS Webhook — Boundary & Negative
// ============================================================================
describe('Tier 2 — F11: AWS SES/SNS Webhook Boundaries', () => {
  it('[F11][T2] SigningCertURL SSRF and scheme/host/path/query/userinfo/suffix bypasses return 403 INVALID_SNS_CERT_URL', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const recipient = makeTestRecipient('f11-ssrf');
      const badCertUrls = [
        'http://sns.ap-southeast-2.amazonaws.com/cert.pem',
        'https://evil.example.com/cert.pem',
        'https://sns.ap-southeast-2.amazonaws.com.evil.com/cert.pem',
        'https://sns.ap-southeast-2.amazonaws.com/../evil.pem',
        'https://sns.ap-southeast-2.amazonaws.com/%2e%2e/evil.pem',
        'https://sns.ap-southeast-2.amazonaws.com/cert.pem?q=1',
        'https://user:pass@sns.ap-southeast-2.amazonaws.com/cert.pem',
        'https://sns.ap-southeast-2.amazonaws.com/cert.txt',
      ];
      for (const signingCertUrl of badCertUrls) {
        const req = signSnsNotification(
          ctx.snsSigner,
          { eventType: 'Delivery', recipients: [recipient] },
          { signingCertUrl }
        );
        const res = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
          method: 'POST',
          headers: req.headers,
          body: req.rawBody,
        });
        assert.equal(res.status, 403, `Expected 403 for ${signingCertUrl}, got ${res.status}`);
        assert.equal(res.json?.error?.code, 'INVALID_SNS_CERT_URL');
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T2] cryptographic signature tampering, message tampering, unsupported SignatureVersion 3, and forged SubscribeURL return 403', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const recipient = makeTestRecipient('f11-tamper');

      const sigTampered = signSnsNotification(
        ctx.snsSigner,
        { eventType: 'Delivery', recipients: [recipient] },
        { tamperSignature: true }
      );
      assert.equal(
        (await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: sigTampered.headers, body: sigTampered.rawBody })).status,
        403
      );

      for (const sigVer of ['1', '2'] as const) {
        const msgTampered = signSnsNotification(
          ctx.snsSigner,
          { eventType: 'Delivery', recipients: [recipient] },
          { signatureVersion: sigVer, tamperMessage: '{"notificationType":"Tampered"}' }
        );
        assert.equal(
          (await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: msgTampered.headers, body: msgTampered.rawBody })).status,
          403
        );
      }

      const badVer = ctx.snsSigner.signEnvelope(
        {
          Type: 'Notification',
          MessageId: crypto.randomUUID(),
          TopicArn: 'arn:aws:sns:ap-southeast-2:123456789012:ses-events',
          Message: JSON.stringify({ notificationType: 'Delivery' }),
          Timestamp: new Date().toISOString(),
          SignatureVersion: '3' as unknown as '2',
          SigningCertURL: ctx.snsSigner.signingCertUrl,
        },
        { signatureVersion: '3' as unknown as '2' }
      );
      assert.equal(
        (await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: badVer.headers, body: badVer.rawBody })).status,
        403
      );

      const forgedSub = ctx.snsSigner.signSubscriptionConfirmation({
        subscribeUrl: 'https://evil.com/steal-token',
      });
      assert.equal(
        (await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: forgedSub.headers, body: forgedSub.rawBody })).status,
        403
      );
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T2] malformed JSON, missing envelope fields, invalid inner SES JSON, and not-spam complaint boundary handling', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const badJson = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
        body: '{bad-json',
      });
      assert.equal(badJson.status, 400);
      assert.equal(badJson.json?.error?.code, 'INVALID_SNS_PAYLOAD');

      const missingTopic = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        body: { Type: 'Notification', MessageId: crypto.randomUUID() },
      });
      assert.equal(missingTopic.status, 400);
      assert.equal(missingTopic.json?.error?.code, 'INVALID_SNS_ENVELOPE');

      const subNoToken = ctx.snsSigner.signSubscriptionConfirmation();
      const subNoTokenObj = { ...subNoToken.envelope } as Record<string, unknown>;
      delete subNoTokenObj.Token;
      assert.equal(
        (await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
          method: 'POST',
          headers: subNoToken.headers,
          body: JSON.stringify(subNoTokenObj),
        })).status,
        400
      );

      const badInner = ctx.snsSigner.signNotification('{not-json-ses-event');
      const badInnerRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: badInner.headers,
        body: badInner.rawBody,
      });
      assert.equal(badInnerRes.status, 400);
      assert.equal(badInnerRes.json?.error?.code, 'INVALID_SES_EVENT');

      const recipient = makeTestRecipient('f11-notspam');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });
      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [smtpMsg] = await ctx.smtp.waitForMessages(1, 5000);

      const notSpam = signSnsNotification(ctx.snsSigner, {
        eventType: 'Complaint',
        complaintFeedbackType: 'not-spam',
        recipients: [recipient],
        messageId: smtpMsg.id,
      });
      const notSpamRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: notSpam.headers,
        body: notSpam.rawBody,
      });
      assert.equal(notSpamRes.status, 200);
      assert.equal(notSpamRes.json?.data?.processed, false);
      assert.equal(notSpamRes.json?.data?.ignored, true);
      assert.equal(notSpamRes.json?.data?.reason, 'not-spam');

      const leadsRes = await ctx.apiJson<{ data: { items: Array<{ id: string; email_consent: string }> } }>(
        '/api/v1/leads',
        { token: ideas.accessToken, tenantSlug: 'ideas', query: { search: recipient } }
      );
      assert.equal(leadsRes.data.items.find((l) => l.id === leadId)?.email_consent, 'subscribed');
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T2] idempotent SNS replay does not double-count bounces/timeline and Delivery never downgrades opened/clicked claims', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const permEmail = makeTestRecipient('f11-replay-perm');
      const openEmail = makeTestRecipient('f11-nodowngrade');
      const s1 = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: permEmail });
      const s2 = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: openEmail });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${s1.campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      await ctx.apiJson(`/api/v1/marketing/campaigns/${s2.campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg1, msg2] = await ctx.smtp.waitForMessages(2, 5000);

      const permSnsId = crypto.randomUUID();
      const permReq = signSnsNotification(
        ctx.snsSigner,
        { eventType: 'Bounce', bounceType: 'Permanent', recipients: [permEmail], messageId: msg1.id },
        { messageId: permSnsId }
      );
      assert.equal((await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: permReq.headers, body: permReq.rawBody })).status, 200);
      assert.equal((await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: permReq.headers, body: permReq.rawBody })).status, 200);

      const d1 = await ctx.apiJson<{ data: { campaign: { bounced_count: number } } }>(
        `/api/v1/marketing/campaigns/${s1.campaignId}/detail`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(d1.data.campaign.bounced_count, 1);

      const tl1 = await ctx.apiJson<{ data: Array<{ event_type: string }> }>(
        `/api/v1/leads/${s1.leadId}/timeline`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      const bounceEvents = (Array.isArray(tl1.data) ? tl1.data : []).filter((e) => e.event_type === 'email_bounced');
      assert.equal(bounceEvents.length, 1);

      // Open claim, then send Delivery -> status must remain 'opened'
      const openPath = msg2.html.match(/\/api\/v1\/public\/marketing\/track\/open\/([0-9a-f-]+)/i)?.[0];
      assert.ok(openPath);
      await fetch(`${ctx.baseUrl}${openPath}`);

      const delivReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Delivery',
        recipients: [openEmail],
        messageId: msg2.id,
      });
      assert.equal((await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: delivReq.headers, body: delivReq.rawBody })).status, 200);

      const d2 = await ctx.apiJson<{ data: { claims: Array<{ status: string }> } }>(
        `/api/v1/marketing/campaigns/${s2.campaignId}/detail`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(d2.data.claims[0].status, 'opened');
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T2] multi-tenant Step C/D mail.source disambiguation, flow header_message_id correlation, and multi-recipient diagnosticCode', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        configureLoopbackSmtp: true,
        fromEmail: 'noreply@test-sink.domation.local',
      });
      const ecolife = await seedSiblingTenant(ctx, 'ecolife');
      const sharedEmail = makeTestRecipient('f11-collision');

      let ideasLeadId = '';
      let ecoLeadId = '';
      await withTenantTransaction(ideas.tenantId, async (client) => {
        const up = await upsertMasterContactInTx(client, ideas.tenantId, {
          name: 'Ideas Collision',
          phone: '0907111001',
          email: sharedEmail,
        });
        ideasLeadId = up.leadId;
        await client.query(
          `INSERT INTO lead_timeline_events (
             id, tenant_id, lead_id, event_type, event_category, actor_role, actor_name, title, content, metadata
           ) VALUES ($1, $2, $3, 'mkt_email_sent', 'communication', 'tenant_admin', 'Flow', 'Email', 'SES', $4::jsonb)`,
          [
            crypto.randomUUID(),
            ideas.tenantId,
            ideasLeadId,
            JSON.stringify({ message_id: 'ses-flow-hdr-unused', header_message_id: 'msg_flow_hdr_t2@autodata.vn' }),
          ]
        );
      });
      await withTenantTransaction(ecolife.tenantId, async (client) => {
        await client.query(
          `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"ses_sender_email":"eco@test-sink.domation.local"}'::jsonb WHERE id = $1`,
          [ecolife.tenantId]
        );
        const up = await upsertMasterContactInTx(client, ecolife.tenantId, {
          name: 'Eco Collision',
          phone: '0907111002',
          email: sharedEmail,
        });
        ecoLeadId = up.leadId;
      });

      const bounceReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Bounce',
        bounceType: 'Permanent',
        recipients: [sharedEmail],
        sourceEmail: 'noreply@test-sink.domation.local',
        messageId: 'untracked-outer-id',
      });
      const res = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: bounceReq.headers,
        body: bounceReq.rawBody,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json?.data?.matched_count, 1);

      await withTenantTransaction(ideas.tenantId, async (client) => {
        const r = await client.query<{ email_consent: string }>('SELECT email_consent FROM leads WHERE id = $1', [ideasLeadId]);
        assert.equal(r.rows[0]?.email_consent, 'bounced');
      });
      await withTenantTransaction(ecolife.tenantId, async (client) => {
        const r = await client.query<{ email_consent: string }>('SELECT email_consent FROM leads WHERE id = $1', [ecoLeadId]);
        assert.equal(r.rows[0]?.email_consent, 'subscribed');
      });

      // Multi-recipient diagnosticCode per recipient
      const r1 = makeTestRecipient('f11-diag1');
      const r2 = makeTestRecipient('f11-diag2');
      const campId = crypto.randomUUID();
      let l2Id = '';
      await withTenantTransaction(ideas.tenantId, async (client) => {
        const u1 = await upsertMasterContactInTx(client, ideas.tenantId, { name: 'D1', phone: '0907222001', email: r1 });
        const u2 = await upsertMasterContactInTx(client, ideas.tenantId, { name: 'D2', phone: '0907222002', email: r2 });
        l2Id = u2.leadId;
        await client.query(
          `INSERT INTO mkt_campaigns (id, tenant_id, name, channel, status, total_targeted, sent_count)
           VALUES ($1, $2, 'Multi Diag', 'email', 'completed', 2, 2)`,
          [campId, ideas.tenantId]
        );
        await client.query(
          `INSERT INTO mkt_send_claims (id, tenant_id, campaign_id, lead_id, channel, status, sent_at, metadata)
           VALUES ($1, $2, $3, $4, 'email', 'sent', clock_timestamp(), '{"message_id":"ses-multi-t2"}'::jsonb),
                  ($5, $2, $3, $6, 'email', 'sent', clock_timestamp(), '{"message_id":"ses-multi-t2"}'::jsonb)`,
          [crypto.randomUUID(), ideas.tenantId, campId, u1.leadId, crypto.randomUUID(), l2Id]
        );
      });

      const multiReq = ctx.snsSigner.signNotification({
        notificationType: 'Bounce',
        mail: {
          messageId: 'ses-multi-t2',
          destination: [r1, r2],
        },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [
            { emailAddress: r1, diagnosticCode: 'smtp; 550 diag-one' },
            { emailAddress: r2, diagnosticCode: 'smtp; 552 diag-two' },
          ],
        },
      } as unknown as Record<string, unknown>);
      assert.equal((await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: multiReq.headers, body: multiReq.rawBody })).status, 200);

      await withTenantTransaction(ideas.tenantId, async (client) => {
        const c2 = await client.query<{ error_message: string }>(
          'SELECT error_message FROM mkt_send_claims WHERE tenant_id = $1 AND lead_id = $2',
          [ideas.tenantId, l2Id]
        );
        assert.ok(String(c2.rows[0]?.error_message || '').includes('diag-two'));
      });
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F12: External AWS SES/SNS & Manual Cutover Checklist — Boundary & Negative
// ============================================================================
describe('Tier 2 — F12: External Cutover & Checklist Security Boundaries', () => {
  it('[F12][T2] MANUAL_CUTOVER_CHECKLIST.md contains zero raw AWS IAM keys, Meta tokens, Google API keys, or secrets', () => {
    const checklistPath = resolveChecklistPath();
    assert.equal(
      fs.existsSync(checklistPath),
      true,
      `M4 deliverable missing: ${checklistPath} must exist for secret-redaction check`
    );

    const content = fs.readFileSync(checklistPath, 'utf8');
    assert.equal(/\bAKIA[0-9A-Z]{16}\b/.test(content), false, 'Checklist leaked raw AWS Access Key ID');
    assert.equal(/\bEAA[A-Za-z0-9_]{20,}\b/.test(content), false, 'Checklist leaked raw Meta access token');
    assert.equal(/\bAIza[0-9A-Za-z_-]{35}\b/.test(content), false, 'Checklist leaked raw Google API key');
    const secretMatches = Array.from(
      content.matchAll(
        /(?:secret|password|smtp_pass|vault_master_secret|cron_secret|access_token|api_key)\s*[:=]\s*["'`]?([A-Za-z0-9+/=_-]{24,})["'`]?/gi
      )
    );
    const leakedSecrets = secretMatches
      .map((m) => m[1])
      .filter(
        (val) =>
          !/^(?:redacted|placeholder|replace_with|your_|example|change_me|x{16,}|\*{8,})/i.test(val) &&
          !/redacted|placeholder/i.test(val)
      );
    assert.equal(
      leakedSecrets.length,
      0,
      `Checklist leaked raw secret/password value: ${leakedSecrets.join(', ')}`
    );
  });

  it('[F12][T2] MANUAL_CUTOVER_CHECKLIST.md never recommends localhost, 127.0.0.1, or crm.domation.net/api as target callbacks', () => {
    const checklistPath = resolveChecklistPath();
    assert.equal(
      fs.existsSync(checklistPath),
      true,
      `M4 deliverable missing: ${checklistPath} must exist for callback URL hygiene check`
    );

    const content = fs.readFileSync(checklistPath, 'utf8');
    const negationOrReplacementRe =
      /(?:\bdo\s+not\b|\bdon't\b|\bnever\b|\bavoid\b|\bmust\s+not\b|\binstead\s+of\b|\breplace\b[^\n]*\bwith\b|\bnot\s+(?:use|point|set|configure|recommend)\b|\bforbidden\b|\bdisallowed\b)/i;
    const forbiddenPatterns: Array<{ label: string; re: RegExp }> = [
      { label: 'localhost', re: /\blocalhost(?::\d+)?\b/i },
      { label: '127.0.0.1', re: /\b127\.0\.0\.1(?::\d+)?\b/ },
      { label: 'crm.domation.net/api/', re: /crm\.domation\.net\/api\//i },
      { label: 'crm.domation.net/backend', re: /crm\.domation\.net\/backend/i },
    ];
    for (const [idx, line] of content.split(/\r?\n/).entries()) {
      if (negationOrReplacementRe.test(line)) continue;
      for (const { label, re } of forbiddenPatterns) {
        assert.equal(
          re.test(line),
          false,
          `Checklist line ${idx + 1} must not recommend ${label}: ${line.trim()}`
        );
      }
    }
  });

  it('[F12][T2] SNS SubscriptionConfirmation rejects evil SubscribeURL, HTTP SubscribeURL, and traversal SigningCertURL with 403 and zero fetch', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      ctx.mockFetch.clearRequests();

      const evilSub = ctx.snsSigner.signSubscriptionConfirmation({
        subscribeUrl: 'https://evil.example.com/confirm',
      });
      const httpSub = ctx.snsSigner.signSubscriptionConfirmation({
        subscribeUrl: 'http://sns.ap-southeast-2.amazonaws.com/?Action=ConfirmSubscription&Token=1',
      });
      const travCert = ctx.snsSigner.signSubscriptionConfirmation({
        signingCertUrl: 'https://sns.ap-southeast-2.amazonaws.com/%2e%2e/cert.pem',
      });

      for (const req of [evilSub, httpSub, travCert]) {
        const res = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
          method: 'POST',
          headers: req.headers,
          body: req.rawBody,
        });
        assert.equal(res.status, 403);
      }
      assert.equal(ctx.mockFetch.getRequests().filter((r) => !r.url.endsWith('.pem')).length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F12][T2] inbound webhook enforces _enforce_hmac signature validation (401) and X-Idempotency-Key dedup (200 DUPLICATE_SKIPPED)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const wh = await ctx.apiJson<{ data: { token: string; signing_secret: string } }>(
        '/api/v1/integrations/webhooks',
        {
          method: 'POST',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          body: {
            name: 'Strict HMAC Webhook',
            webhook_type: 'inbound',
            is_active: true,
            field_mappings: { _enforce_hmac: true },
          },
        }
      );

      const payload = JSON.stringify({ name: 'HMAC Lead', phone: '0909888111' });
      const missingSig = await ctx.apiRaw(`/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      assert.equal(missingSig.status, 401);
      assert.equal(missingSig.json?.error?.code, 'INVALID_WEBHOOK_SIGNATURE');

      const sig = crypto.createHmac('sha256', wh.data.signing_secret).update(payload).digest('hex');
      const first = await ctx.apiRaw(`/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${sig}`,
          'X-Idempotency-Key': 'idem-key-001',
        },
        body: payload,
      });
      assert.equal(first.status, 202);

      const dup = await ctx.apiRaw(`/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${sig}`,
          'X-Idempotency-Key': 'idem-key-001',
        },
        body: payload,
      });
      assert.equal(dup.status, 200);
      assert.equal(dup.json?.status, 'DUPLICATE_SKIPPED');
    } finally {
      await ctx.close();
    }
  });

  it('[F12][T2] Meta social inbound verification rejects wrong verify_token, wrong hub.mode, and unknown tenant without echoing challenge', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      await ctx.apiJson('/api/v1/integrations/vault/meta_messenger', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { verify_token: 'correct_verify_tok', app_secret: 'app_sec_1' },
      });

      const wrongTok = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong_tok', 'hub.challenge': 'SECRET_CHAL' },
      });
      assert.equal(wrongTok.status, 403);
      assert.equal(wrongTok.rawText.includes('SECRET_CHAL'), false);

      const wrongMode = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        query: { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'correct_verify_tok', 'hub.challenge': 'SECRET_CHAL' },
      });
      assert.equal(wrongMode.status, 403);
      assert.equal(wrongMode.rawText.includes('SECRET_CHAL'), false);

      const unknownTenant = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/unknown-tenant-xyz', {
        query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'correct_verify_tok', 'hub.challenge': 'SECRET_CHAL' },
      });
      assert.equal(unknownTenant.status, 404);
      assert.equal(unknownTenant.rawText.includes('SECRET_CHAL'), false);
    } finally {
      await ctx.close();
    }
  });

  it('[F12][T2] suspended tenant or inactive inbound webhook rejects POST with 404 WEBHOOK_NOT_FOUND_OR_INACTIVE and persists zero leads', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const wh = await ctx.apiJson<{ data: { id: string; token: string } }>('/api/v1/integrations/webhooks', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { name: 'Disable Test Hook', webhook_type: 'inbound', is_active: true },
      });

      await ctx.apiJson(`/api/v1/integrations/webhooks/${wh.data.id}`, {
        method: 'PATCH',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { is_active: false },
      });

      const inactiveRes = await ctx.apiRaw(`/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        body: { name: 'Should Not Save', phone: '0909000111' },
      });
      assert.equal(inactiveRes.status, 404);
      assert.equal(inactiveRes.json?.error?.code, 'WEBHOOK_NOT_FOUND_OR_INACTIVE');

      const leads = await ctx.apiJson<{ data: { items: unknown[] } }>('/api/v1/leads', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(leads.data.items.length, 0);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F13: Frontend & Meta Report Domain Cutover — Boundary & Negative
// ============================================================================
describe('Tier 2 — F13: Frontend & Meta Report Cutover Boundaries', () => {
  it('[F13][T2] DOMATION_ERP_FULL isInternalApiUrl() rejects origin-prefix spoofing, protocol-relative URLs, and javascript: schemes', async () => {
    const captured: Array<{ url: string; auth: string | null; slug: string | null }> = [];
    const prodEnv = {
      VITE_API_ORIGIN: 'https://data.domation.net',
      VITE_DEFAULT_TENANT_SLUG: 'ecolife',
      VITE_APP_TITLE: 'DOMATION ERP',
    };
    const mockWin = {
      location: { hostname: 'crm.domation.net', origin: 'https://crm.domation.net', search: '?tenant=ideas' },
      fetch: async (input: unknown, init?: { headers?: Record<string, string> }) => {
        const headers = new Headers(init?.headers || {});
        captured.push({
          url: String(input),
          auth: headers.get('Authorization'),
          slug: headers.get('X-Tenant-Slug'),
        });
        return new Response('{}', { status: 200 });
      },
    };

    await withBundledErpModule(
      'components/marketing/utils/config.ts',
      prodEnv,
      mockWin,
      async (cfgMod) => {
        assert.equal(cfgMod.isInternalApiUrl('https://data.domation.net.evil.com/api/v1/leads'), false);
        assert.equal(cfgMod.isInternalApiUrl('//evil.com/api/v1/leads'), false);
        assert.equal(cfgMod.isInternalApiUrl('javascript:alert(1)'), false);
        assert.equal(cfgMod.isInternalApiUrl('https://data.domation.net/api/v1/leads'), true);

        const winFetch = (globalThis as Record<string, any>).window.fetch as (u: string) => Promise<unknown>;
        await winFetch('https://data.domation.net.evil.com/api/v1/myerp/automation/flows');
        await winFetch('https://data.domation.net/api/v1/myerp/automation/flows');

        assert.equal(captured[0].auth, null);
        assert.equal(captured[0].slug, null);
        assert.equal(captured[1].auth, 'Bearer jwt-secret-t2');
        assert.equal(captured[1].slug, 'ideas');
      },
      { domation_token: 'jwt-secret-t2', domation_tenant_slug: 'ideas' }
    );
  });

  it('[F13][T2] DOMATION_ERP_FULL getActiveTenantSlug() normalizes uppercase query, rejects traversal, and purges poisoned localStorage', async () => {
    const devEnv = {
      VITE_API_ORIGIN: 'https://data.domation.net',
      VITE_DEFAULT_TENANT_SLUG: 'ecolife',
      VITE_APP_TITLE: 'DOMATION ERP',
    };

    await withBundledErpModule(
      'config/env.ts',
      devEnv,
      { location: { hostname: 'crm.domation.net', origin: 'https://crm.domation.net', search: '?tenant=IDEAS' } },
      (envMod, storage) => {
        assert.equal(envMod.getActiveTenantSlug(), 'ideas');
        assert.equal(storage.get('domation_tenant_slug'), 'ideas');
      },
      { domation_tenant_slug: 'ecolife' }
    );

    await withBundledErpModule(
      'config/env.ts',
      devEnv,
      { location: { hostname: 'crm.domation.net', origin: 'https://crm.domation.net', search: '?tenant=../../evil' } },
      (envMod, storage) => {
        assert.equal(envMod.getActiveTenantSlug(), 'ecolife');
        assert.equal(storage.has('domation_tenant_slug'), false);
      }
    );

    await withBundledErpModule(
      'config/env.ts',
      devEnv,
      { location: { hostname: 'crm.domation.net', origin: 'https://crm.domation.net', search: '' } },
      (envMod, storage) => {
        assert.equal(envMod.getActiveTenantSlug(), 'ecolife');
        assert.equal(storage.has('domation_tenant_slug'), false);
      },
      { domation_tenant_slug: '../../evil' }
    );
  });

  it('[F13][T2] handleAutodataBridgeHttp enforces CORS preflight, missing backend 503, unknown route 404, and dead upstream 503', async () => {
    const bridgePath = path.join(LANDING_REPO_ROOT, 'lib', 'autodataBridge.ts');
    const bridgeMod = (await import(pathToFileURL(bridgePath).href)) as {
      handleAutodataBridgeHttp: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        explicitApiUrl?: string
      ) => Promise<void>;
    };

    let currentUpstream: string | undefined = undefined;
    const srv = http.createServer((req, res) => {
      void bridgeMod.handleAutodataBridgeHttp(req, res, currentUpstream);
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const prevEnvUrl = process.env.AUTODATA_API_URL;
    try {
      delete process.env.AUTODATA_API_URL;
      const addr = srv.address();
      assert.ok(addr && typeof addr !== 'string');
      const base = `http://127.0.0.1:${addr.port}`;

      const preflight = await fetch(`${base}/api/v1/health`, { method: 'OPTIONS' });
      assert.equal(preflight.status, 204);
      const allowHeaders = preflight.headers.get('access-control-allow-headers') || '';
      assert.ok(allowHeaders.includes('X-Tenant-Slug'));
      assert.ok(allowHeaders.includes('X-Webhook-Signature'));
      assert.ok(allowHeaders.includes('X-Idempotency-Key'));

      const unconfigured = await fetch(`${base}/api/v1/health`);
      assert.equal(unconfigured.status, 503);
      assert.equal(((await unconfigured.json()) as { error: { code: string } }).error.code, 'BACKEND_UNAVAILABLE');

      currentUpstream = 'http://127.0.0.1:9';
      const unknown = await fetch(`${base}/unknown/path`);
      assert.equal(unknown.status, 404);
      assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'UNKNOWN_PROXY_ROUTE');

      const dead = await fetch(`${base}/api/v1/health`);
      assert.equal(dead.status, 503);
      assert.equal(((await dead.json()) as { error: { code: string } }).error.code, 'BACKEND_UNAVAILABLE');
    } finally {
      if (prevEnvUrl === undefined) delete process.env.AUTODATA_API_URL;
      else process.env.AUTODATA_API_URL = prevEnvUrl;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('[F13][T2] DOMATION_LANDINGPAGE detectMetaPathSlug() rejects reserved paths and normalizes uppercase IDEAS slug', () => {
    const metaSrc = fs.readFileSync(path.join(LANDING_REPO_ROOT, 'src', 'MetaAdReport.tsx'), 'utf8');
    const reservedMatch = metaSrc.match(/const META_RESERVED_PATHS = new Set\(\[[\s\S]*?\]\);/);
    const detectMatch = metaSrc.match(/function detectMetaPathSlug\(\): string \| null \{[\s\S]*?\n\}/);
    assert.ok(reservedMatch && detectMatch);

    const evalSlug = (hostname: string, pathname: string): string | null => {
      const code = `
        const window = { location: { hostname: ${JSON.stringify(hostname)}, pathname: ${JSON.stringify(pathname)} } };
        ${reservedMatch[0]}
        ${detectMatch[0].replace('function detectMetaPathSlug(): string | null', 'function detectMetaPathSlug()')}
        detectMetaPathSlug();
      `;
      return vm.runInNewContext(code) as string | null;
    };

    for (const [host, p] of [
      ['domation.net', '/meta-report/login'],
      ['domation.net', '/meta-report/privacy'],
      ['meta.domation.net', '/workspaces'],
      ['meta.domation.net', '/meta-report'],
    ]) {
      assert.equal(evalSlug(host, p), null, `Reserved path ${host}${p} must return null`);
    }
    assert.equal(evalSlug('domation.net', '/meta-report/IDEAS/'), 'ideas');
    assert.equal(evalSlug('meta.domation.net', '/Ideas'), 'ideas');
  });

  it('[F13][T2] /api/v1/public/dom-meta/:slug/access enforces public_view=false (403), missing/suspended tenant (404), and uppercase slug (200)', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const sa = await (await import('./harness.ts')).loginSuperAdmin(ctx);
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo' });

      const disabledRes = await ctx.apiRaw('/api/v1/public/dom-meta/ideas/access');
      assert.equal(disabledRes.status, 403);
      assert.equal(disabledRes.json?.error?.code, 'PUBLIC_VIEW_DISABLED');

      const missingRes = await ctx.apiRaw('/api/v1/public/dom-meta/nonexistent-tenant-999/access');
      assert.equal(missingRes.status, 404);
      assert.equal(missingRes.json?.error?.code, 'WORKSPACE_NOT_FOUND');

      await ctx.apiJson('/api/v1/integrations/dom-meta/share', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { public_view: true },
      });
      const upperRes = await ctx.apiRaw('/api/v1/public/dom-meta/IDEAS/access');
      assert.equal(upperRes.status, 200);
      assert.equal(upperRes.json?.data?.tenant?.slug, 'ideas');

      await ctx.apiJson(`/api/v1/admin/tenants/${ideas.tenantId}`, {
        method: 'PATCH',
        token: sa.token,
        body: { status: 'suspended' },
      });
      const suspendedRes = await ctx.apiRaw('/api/v1/public/dom-meta/ideas/access');
      assert.equal(suspendedRes.status, 404);
      assert.equal(suspendedRes.json?.error?.code, 'WORKSPACE_NOT_FOUND');
    } finally {
      await ctx.close();
    }
  });

  it('[F13][T2] DOMATION_LANDINGPAGE built dist/ contains required entrypoints and zero legacy/localhost API leaks', () => {
    const distDir = path.join(LANDING_REPO_ROOT, 'dist');
    for (const rel of ['index.html', 'data/index.html', 'meta-report/index.html', 'ideas/index.html']) {
      assert.equal(fs.existsSync(path.join(distDir, rel)), true, `Missing dist artifact ${rel}`);
    }
    const bundleFiles = walkFiles(distDir, (p) => p.endsWith('.js') || p.endsWith('.html'));
    const forbidden = [
      'crm.domation.net',
      'localhost:3100',
      '127.0.0.1:3100',
      'https://domation.net/api/v1/webhooks',
      '?token=',
      'myerp.ideas.edu.vn',
      'automation.ideas.edu.vn/uploadss',
      'automation.ideas.edu.vn/api',
      'automation.ideas.edu.vn/mail_api',
    ];
    for (const f of bundleFiles) {
      const text = fs.readFileSync(f, 'utf8');
      for (const bad of forbidden) {
        assert.equal(text.includes(bad), false, `Found forbidden pattern '${bad}' in ${path.relative(distDir, f)}`);
      }
    }
  });
});

// ============================================================================
// Feature F14: Master Cronjob Consolidation & PGlite Safety — Boundary & Negative
// ============================================================================
describe('Tier 2 — F14: Master Cronjob & PGlite Safety Boundaries', () => {
  it('[F14][T2] X-Cron-Secret constant-time boundary rejects empty, whitespace, truncated, extended, and 1-char-flipped secrets and accepts GET ?secret=', async () => {
    const secret = 'ExactLengthSecret2026';
    const ctx = await createIsolatedContext({ dbMode: 'memory', cronSecret: secret });
    try {
      const flipped = `${secret.slice(0, -1)}7`;
      for (const badSecret of ['', '   ', secret.slice(0, -1), `${secret}X`, flipped]) {
        const res = await ctx.apiRaw('/api/v1/operations/cron/master', {
          method: 'POST',
          headers: { 'X-Cron-Secret': badSecret },
        });
        assert.equal(res.status, 401, `Expected 401 for secret '${badSecret}'`);
        assert.equal(res.json?.error?.code, 'UNAUTHORIZED_CRON_TICK');
      }

      const okGet = await ctx.apiRaw('/api/v1/operations/cron/master', {
        method: 'GET',
        query: { secret, subroutines: 'sla' },
      });
      assert.equal(okGet.status, 200);
      assert.equal(okGet.json?.success, true);
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T2] concurrent master cron ticks prevent overlap without 500 errors or duplicate claims', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const [r1, r2] = await Promise.all([
        triggerMasterCron(ctx, { tenantId: ideas.tenantId }),
        triggerMasterCron(ctx, { tenantId: ideas.tenantId }),
      ]);
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      const ranCleanly = [r1, r2].filter((r) => !r.skipped && !r.locked);
      assert.ok(ranCleanly.length >= 1, 'At least one concurrent tick must complete');
      const skippedOrLocked = [r1, r2].filter((r) => r.skipped || r.locked);
      assert.ok(skippedOrLocked.length <= 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T2] direct CLI server/cron/master-cron.ts refuses execution when postmaster.pid exists and ALLOW_OFFLINE_PGLITE_CRON is unset', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const pgDir = ctx.createTempDir('f14-pid-refuse-');
      fs.writeFileSync(path.join(pgDir, 'postmaster.pid'), '12345\n', 'utf8');

      const res = await ctx.runCli(['server/cron/master-cron.ts'], {
        runner: 'tsx',
        env: {
          PGLITE_DATA_DIR: pgDir,
          ALLOW_OFFLINE_PGLITE_CRON: '',
        },
      });
      assert.equal(res.status, 1);
      assert.ok(res.stderr.includes('Refusing direct CLI execution against PGlite'));
      assert.ok(res.stderr.includes("ALLOW_OFFLINE_PGLITE_CRON !== 'true'"));
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T2] scripts/run-master-cron.sh HTTP failure exits 1 without PGlite CLI fallback even when ALLOW_OFFLINE_PGLITE_CRON=true', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const appDir = ctx.createTempDir('f14-http-fail-');
      const stubBin = path.join(appDir, 'bin');
      fs.mkdirSync(stubBin, { recursive: true });
      fs.writeFileSync(path.join(stubBin, 'curl'), '#!/usr/bin/env bash\nexit 22\n', { mode: 0o755 });
      fs.writeFileSync(path.join(appDir, '.env'), 'CRON_SECRET=test-tok-2026\n', 'utf8');

      const res = await ctx.runCli([path.join(REPO_ROOT, 'scripts', 'run-master-cron.sh')], {
        runner: 'bash',
        env: {
          Path: undefined,
          PATH: resolveBashPathEntries(stubBin).join(path.delimiter),
          APP_DIR: appDir,
          ALLOW_OFFLINE_PGLITE_CRON: 'true',
        },
      });
      assert.equal(res.status, 1);
      assert.ok(res.stderr.includes('HTTP master cron request failed; refusing unsafe concurrent PGlite CLI fallback.'));
      assert.equal(fs.existsSync(path.join(appDir, '.autodata-pgdata', 'postmaster.pid')), false);
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T2] NODE_ENV=production disables in-process setInterval cron timers in server/index.ts', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const tmpDir = ctx.createTempDir('f14-prod-timers-');
      const pgDir = ctx.createTempDir('f14-prod-pg-');
      const preloadPath = path.join(tmpDir, 'probe-timers.mjs');
      fs.writeFileSync(
        preloadPath,
        [
          'const recorded = [];',
          'const origSetInterval = globalThis.setInterval;',
          'globalThis.setInterval = function(fn, delay, ...args) {',
          '  if (Number(delay) >= 60000) recorded.push(Number(delay));',
          '  return origSetInterval.call(this, fn, delay, ...args);',
          '};',
          'const origLog = console.log;',
          'console.log = function(...args) {',
          '  origLog.apply(console, args);',
          '  const msg = args.map(String).join(" ");',
          '  if (msg.includes("Multi-Tenant Engine listening")) {',
          '    origLog("CRON_INTERVALS_JSON=" + JSON.stringify(recorded));',
          '    setTimeout(() => process.exit(0), 50);',
          '  }',
          '};',
        ].join('\n'),
        'utf8'
      );

      const res = await ctx.runCli(
        ['--import', pathToFileURL(preloadPath).href, 'server/index.ts'],
        {
          runner: 'tsx',
          timeoutMs: 30_000,
          env: {
            NODE_ENV: 'production',
            PORT: '0',
            PGLITE_DATA_DIR: pgDir,
            SERVE_SPA: 'false',
            OUTBOUND_SILENT_MODE: 'true',
          },
        }
      );
      assert.equal(res.status, 0, `server/index.ts probe failed: ${res.stderr}\n${res.stdout}`);
      const m = res.stdout.match(/CRON_INTERVALS_JSON=(\[[^\]]*\])/);
      assert.ok(m, `Expected CRON_INTERVALS_JSON in stdout: ${res.stdout}`);
      assert.deepEqual(JSON.parse(m[1]), []);
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T2] unknown subroutine names and empty subroutines: [] complete cleanly with zero errors and zero invalid rows', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      for (const subs of [['nonexistent_sub'], []]) {
        const res = await ctx.apiRaw('/api/v1/operations/cron/master', {
          method: 'POST',
          headers: { 'X-Cron-Secret': ctx.cronSecret },
          body: { subroutines: subs, tenant_id: ideas.tenantId },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json?.data?.locked, false);
        assert.deepEqual(res.json?.data?.stats?.errors, []);
      }

      const statusRes = await ctx.apiJson<{ data: { runs: Array<{ subroutine_key: string }> } }>(
        '/api/v1/org-rbac/cron-status',
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(statusRes.data.runs.some((r) => r.subroutine_key === 'nonexistent_sub'), false);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F15: Live Production Deployment & Non-Disruption — Boundary & Negative
// ============================================================================
describe('Tier 2 — F15: Multi-Tenant & Deployment Security Boundaries', () => {
  it('[F15][T2] cross-tenant UUID probing across leads timeline, flows, campaigns, and enroll returns 404 NOT_FOUND', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const ecolife = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'growth_combo' });
      const ecoSetup = await seedCampaignEmailSetup(ctx, ecolife, {
        leadEmail: makeTestRecipient('f15-eco-probe'),
      });
      const ecoFlow = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/flows', {
        method: 'POST',
        token: ecolife.accessToken,
        tenantSlug: 'ecolife',
        body: { name: 'Eco Private Flow', trigger_type: 'manual_enroll', status: 'active', steps: [] },
      });

      const probes: Array<{ method: string; path: string; body?: unknown }> = [
        { method: 'GET', path: `/api/v1/leads/${ecoSetup.leadId}/timeline` },
        { method: 'GET', path: `/api/v1/marketing/flows/${ecoFlow.data.id}` },
        { method: 'GET', path: `/api/v1/marketing/campaigns/${ecoSetup.campaignId}/detail` },
        { method: 'POST', path: `/api/v1/marketing/campaigns/${ecoSetup.campaignId}/send` },
        { method: 'POST', path: `/api/v1/marketing/flows/${ecoFlow.data.id}/enroll`, body: { lead_id: ecoSetup.leadId } },
      ];
      for (const p of probes) {
        const res = await ctx.apiRaw(p.path, {
          method: p.method,
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          ...(p.body ? { body: p.body } : {}),
        });
        assert.equal(res.status, 404, `Cross-tenant probe ${p.method} ${p.path} must return 404, got ${res.status}`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T2] ambiguous multi-tenant SNS bounce leaves both ideas and ecolife subscribed while disambiguated mail.source updates only ideas', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        configureLoopbackSmtp: true,
        fromEmail: 'systemnoti@test-sink.domation.local',
      });
      const ecolife = await seedSiblingTenant(ctx, 'ecolife', { packageCode: 'growth_combo' });
      const sharedEmail = makeTestRecipient('f15-ambig');

      let ideasLeadId = '';
      let ecoLeadId = '';
      await withTenantTransaction(ideas.tenantId, async (client) => {
        ideasLeadId = (await upsertMasterContactInTx(client, ideas.tenantId, { name: 'I', phone: '0908111001', email: sharedEmail })).leadId;
      });
      await withTenantTransaction(ecolife.tenantId, async (client) => {
        await client.query(
          `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '{"ses_sender_email":"eco@test-sink.domation.local"}'::jsonb WHERE id = $1`,
          [ecolife.tenantId]
        );
        ecoLeadId = (await upsertMasterContactInTx(client, ecolife.tenantId, { name: 'E', phone: '0908111002', email: sharedEmail })).leadId;
      });

      const ambigReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Bounce',
        bounceType: 'Permanent',
        recipients: [sharedEmail],
        sourceEmail: 'unknown-sender@test-sink.domation.local',
        messageId: 'unknown-msg-id-1',
      });
      const ambigRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: ambigReq.headers,
        body: ambigReq.rawBody,
      });
      assert.equal(ambigRes.status, 200);
      assert.equal(ambigRes.json?.data?.matched_count, 0);

      await withTenantTransaction(ideas.tenantId, async (c) => {
        assert.equal((await c.query<{ email_consent: string }>('SELECT email_consent FROM leads WHERE id = $1', [ideasLeadId])).rows[0].email_consent, 'subscribed');
      });
      await withTenantTransaction(ecolife.tenantId, async (c) => {
        assert.equal((await c.query<{ email_consent: string }>('SELECT email_consent FROM leads WHERE id = $1', [ecoLeadId])).rows[0].email_consent, 'subscribed');
      });

      const disambigReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Bounce',
        bounceType: 'Permanent',
        recipients: [sharedEmail],
        sourceEmail: 'systemnoti@test-sink.domation.local',
        messageId: 'unknown-msg-id-2',
      });
      const disambigRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: disambigReq.headers,
        body: disambigReq.rawBody,
      });
      assert.equal(disambigRes.status, 200);
      assert.equal(disambigRes.json?.data?.matched_count, 1);

      await withTenantTransaction(ideas.tenantId, async (c) => {
        assert.equal((await c.query<{ email_consent: string }>('SELECT email_consent FROM leads WHERE id = $1', [ideasLeadId])).rows[0].email_consent, 'bounced');
      });
      await withTenantTransaction(ecolife.tenantId, async (c) => {
        assert.equal((await c.query<{ email_consent: string }>('SELECT email_consent FROM leads WHERE id = $1', [ecoLeadId])).rows[0].email_consent, 'subscribed');
      });
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T2] unscoped RLS boundary check under autodata_app with empty app.current_tenant_id returns 0 rows across tenant tables', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      await seedCampaignEmailSetup(ctx, ideas, { leadEmail: makeTestRecipient('f15-rls') });
      await triggerMasterCron(ctx, { tenantId: ideas.tenantId, subroutines: ['sla'] });

      await withUnscopedRlsCheck(async (client) => {
        for (const tbl of ['leads', 'tenant_integrations', 'mkt_campaigns', 'mkt_suppression_list', 'tenant_cron_runs']) {
          const r = await client.query<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM ${tbl}`);
          assert.equal(Number(r.rows[0]?.cnt || 0), 0, `Unscoped RLS query on ${tbl} must return 0 rows`);
        }
      });
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T2] suspended/expired sibling ecolife-automation does not disrupt active ideas or ecolife during global master cron', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const sa = await (await import('./harness.ts')).loginSuperAdmin(ctx);
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const eco = await seedSiblingTenant(ctx, 'ecolife');
      const ecoAuto = await seedSiblingTenant(ctx, 'ecolife-automation');

      await ctx.apiJson(`/api/v1/admin/tenants/${ecoAuto.tenantId}`, {
        method: 'PATCH',
        token: sa.token,
        body: { status: 'suspended' },
      });

      const cronRes = await triggerMasterCron(ctx, { subroutines: ['sla', 'drain', 'billing'] });
      assert.equal(cronRes.status, 200);
      assert.deepEqual(cronRes.stats.errors, []);

      const ideasMe = await ctx.apiJson<{ data: { tenant: { status: string } } }>('/api/v1/auth/me', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(ideasMe.data.tenant.status, 'active');

      const ecoMe = await ctx.apiJson<{ data: { tenant: { status: string } } }>('/api/v1/auth/me', {
        token: eco.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(ecoMe.data.tenant.status, 'active');
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T2] backend .htaccess and Express /uploadss/* reject traversal into .env, .autodata-pgdata, and server/config.ts', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const htaccess = fs.readFileSync(path.join(REPO_ROOT, '.htaccess'), 'utf8');
      for (const token of ['\\.env.*', '.autodata-pgdata', 'server', 'dist-server', 'tests', 'scripts', 'node_modules', '[F,L]', 'Require all denied']) {
        assert.ok(htaccess.includes(token), `Expected '${token}' in root .htaccess`);
      }

      for (const badPath of [
        '/uploadss/../.env',
        '/uploadss/%2e%2e/.autodata-pgdata/PG_VERSION',
        '/uploadss/..%5cserver%5cconfig.ts',
      ]) {
        const res = await rawHttpGetStatus(ctx.baseUrl, badPath);
        assert.equal(res.status, 403, `Expected 403 for ${badPath}`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T2] live .autodata-pgdata remains untouched across tempdir context, deploy-direct.py --dry-run, and multi-tenant HTTP suite', async () => {
    const before = snapshotDirStats(LIVE_PGLITE_DATA_DIR);
    const ctx = await createIsolatedContext({ dbMode: 'tempdir' });
    const dataDir = ctx.dataDir!;
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      await seedSiblingTenant(ctx, 'ecolife');
      await triggerMasterCron(ctx, { tenantId: ideas.tenantId, subroutines: ['sla'] });
    } finally {
      await ctx.close();
    }
    assert.equal(fs.existsSync(dataDir), false, 'Temp dataDir must be cleaned up on close()');

    const after = snapshotDirStats(LIVE_PGLITE_DATA_DIR);
    assert.equal(after.exists, before.exists);
    assert.equal(after.fileCount, before.fileCount);
    assert.equal(after.maxMtimeMs, before.maxMtimeMs);
  });
});

// ============================================================================
// Feature F16: E2E Test Suite & Isolated Smoke Verification — Boundary & Negative
// ============================================================================
describe('Tier 2 — F16: E2E Safety & Smoke Edge Boundaries', () => {
  it('[F16][T2] assertTestRecipientsOnly blocks comma lists, semicolons, CRLF header injection, suffix spoofing, subdomains, and empty strings', () => {
    for (const bad of [
      'a@test-sink.domation.local, b@gmail.com',
      'a@test-sink.domation.local; b@gmail.com',
      'a@test-sink.domation.local\r\nBcc: c@gmail.com',
      'a@test-sink.domation.local.evil.vn',
      'a@sub.test-sink.domation.local',
      '',
    ]) {
      assert.throws(() => assertTestRecipientsOnly([bad]), /UNSAFE_TEST_RECIPIENT/);
    }
  });

  it('[F16][T2] MockSmtpServer 554 DATA rejection records failed campaign claim with 0 SMTP messages captured', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const { campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: makeTestRecipient('f16-smtp-554'),
      });
      ctx.smtp.setRejectMode({ stage: 'data', code: 554, message: '5.6.0 Message rejected' });
      try {
        const sendRes = await ctx.apiJson<{ data: { newly_sent: number; failed_count: number } }>(
          `/api/v1/marketing/campaigns/${campaignId}/send`,
          { method: 'POST', token: ideas.accessToken, tenantSlug: 'ideas' }
        );
        assert.equal(sendRes.data.newly_sent, 0);
        assert.equal(sendRes.data.failed_count, 1);
        assert.equal(ctx.smtp.messages.length, 0);

        const detail = await ctx.apiJson<{ data: { claims: Array<{ status: string; error_message?: string }> } }>(
          `/api/v1/marketing/campaigns/${campaignId}/detail`,
          { token: ideas.accessToken, tenantSlug: 'ideas' }
        );
        assert.equal(detail.data.claims[0].status, 'failed');
        assert.ok(String(detail.data.claims[0].error_message || '').includes('554'));
      } finally {
        ctx.smtp.setRejectMode(null);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T2] tracking & unsubscribe tampering boundaries: non-UUID open GIF, javascript: click redirect, and tampered unsubscribe HMAC', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f16-tamper');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });
      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const claimId = msg.html.match(/\/track\/open\/([0-9a-f-]+)/i)?.[1];
      assert.ok(claimId);

      const badOpen = await fetch(`${ctx.baseUrl}/api/v1/public/marketing/track/open/not-a-uuid`);
      assert.equal(badOpen.status, 200);
      assert.equal(badOpen.headers.get('content-type'), 'image/gif');

      const badClick = await ctx.apiJson<{ data: { redirect_url: string } }>(
        `/api/v1/public/marketing/track/click/${claimId}`,
        { query: { url: 'javascript:alert(1)', json: '1' } }
      );
      assert.equal(badClick.data.redirect_url, 'https://domation.net');

      const badUnsub = await ctx.apiRaw('/api/v1/public/marketing/unsubscribe', {
        query: { tenant_id: ideas.tenantId, lead_id: leadId, channel: 'email', sig: 'tampered' },
      });
      assert.equal(badUnsub.status, 403);
      assert.equal(badUnsub.json?.error?.code, 'INVALID_UNSUBSCRIBE_SIGNATURE');
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T2] duplicate open, click, unsubscribe, and SNS bounce replays remain strictly idempotent on campaign counters and timeline', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f16-dup-all');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });
      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const openPath = msg.html.match(/\/api\/v1\/public\/marketing\/track\/open\/[0-9a-f-]+/i)![0];
      const clickPath = msg.html.match(/\/api\/v1\/public\/marketing\/track\/click\/[0-9a-f-]+\?url=[^"'\s&]+/i)![0];
      const unsubPath = msg.html.match(/\/api\/v1\/public\/marketing\/unsubscribe\?[^"'\s<]+/i)![0].replace(/&amp;/g, '&');

      for (let i = 0; i < 3; i++) await fetch(`${ctx.baseUrl}${openPath}`);
      for (let i = 0; i < 3; i++) await ctx.apiJson(`${clickPath}&json=1`);
      for (let i = 0; i < 2; i++) await ctx.apiJson(unsubPath);

      const snsId = crypto.randomUUID();
      const snsReq = signSnsNotification(
        ctx.snsSigner,
        { eventType: 'Bounce', bounceType: 'Permanent', recipients: [recipient], messageId: msg.id },
        { messageId: snsId }
      );
      await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: snsReq.headers, body: snsReq.rawBody });
      await ctx.apiRaw('/api/v1/webhooks/ses-sns', { method: 'POST', headers: snsReq.headers, body: snsReq.rawBody });

      const detail = await ctx.apiJson<{
        data: { campaign: { opened_count: number; clicked_count: number; unsubscribed_count: number; bounced_count: number } };
      }>(`/api/v1/marketing/campaigns/${campaignId}/detail`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(detail.data.campaign.opened_count, 1);
      assert.equal(detail.data.campaign.clicked_count, 1);
      assert.equal(detail.data.campaign.unsubscribed_count, 1);
      assert.equal(detail.data.campaign.bounced_count, 1);

      const tl = await ctx.apiJson<{ data: Array<{ event_type: string }> }>(
        `/api/v1/leads/${leadId}/timeline`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      const bounceRows = (Array.isArray(tl.data) ? tl.data : []).filter((e) => e.event_type === 'email_bounced');
      assert.equal(bounceRows.length, 1);
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T2] outbound fetch guard blocks unexpected external HTTP calls and records 0 Zalo calls during flow & campaign execution', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f16-fetch-guard');
      const { leadId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });

      const flow = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Blocked External & ZNS Flow',
          trigger_type: 'manual_enroll',
          status: 'active',
          steps: [
            { id: 's1', type: 'zalo_zns', label: 'Legacy ZNS', config: { template_id: 'T1' }, nextStepId: 's2' },
            { id: 's2', type: 'webhook_http', label: 'External Hook', config: { url: 'https://example.org/hook' }, nextStepId: 's3' },
            { id: 's3', type: 'send_email', label: 'Safe Email', config: { subject: 'After Guard' }, nextStepId: null },
          ],
        },
      });
      ctx.mockFetch.clearRequests();

      const enrollRes = await ctx.apiJson<{ data: { status: string } }>(
        `/api/v1/marketing/flows/${flow.data.id}/enroll`,
        { method: 'POST', token: ideas.accessToken, tenantSlug: 'ideas', body: { lead_id: leadId } }
      );
      assert.equal(enrollRes.data.status, 'completed');
      await triggerMasterCron(ctx, { subroutines: ['marketing_flows', 'marketing_campaigns'], tenantId: ideas.tenantId });

      assert.equal(ctx.mockFetch.getRequests('zalo').length, 0);
      assert.equal(ctx.mockFetch.getRequests().filter((r) => !r.blocked).length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T2] LIVE_PGLITE_DATA_DIR guard and run-e2e-ideas.mjs invalid --tier=99 / unknown-flag exit code 2 boundary', async () => {
    assert.throws(() => assertNotLivePgDataDir('./.autodata-pgdata'), /REFUSED_LIVE_PGLITE_DATA_DIR/);
    assert.throws(
      () => assertNotLivePgDataDir(path.join(LIVE_PGLITE_DATA_DIR, 'base')),
      /REFUSED_LIVE_PGLITE_DATA_DIR/
    );

    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const badTier = await ctx.runCli(['tests/e2e_ideas/run-e2e-ideas.mjs', '--tier=99'], { runner: 'node' });
      assert.equal(badTier.status, 2);
      assert.ok(badTier.stderr.includes('Invalid --tier value'));

      const unknownFlag = await ctx.runCli(['tests/e2e_ideas/run-e2e-ideas.mjs', '--unknown-flag'], { runner: 'node' });
      assert.equal(unknownFlag.status, 2);
      assert.ok(unknownFlag.stderr.includes('Unknown argument'));
    } finally {
      await ctx.close();
    }
  });
});
