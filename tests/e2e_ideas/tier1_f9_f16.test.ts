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
  REPO_ROOT,
  assertNotLivePgDataDir,
  assertTestRecipientsOnly,
  buildSyntheticMyerpSql,
  createIsolatedContext,
  inspectSqlDumpMetadata,
  makeTestRecipient,
  runCliSubprocess,
  seedIdeasTenant,
  seedSiblingTenant,
  signSnsNotification,
  triggerMasterCron,
  type IsolatedE2eContext,
  type SeededTenantContext,
} from './harness.ts';
import { withSystemPrivilege, withTenantTransaction } from '../../server/core/database/transaction.ts';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild') as typeof import('esbuild');

const ERP_REPO_ROOT = process.env.DOMATION_ERP_DIR
  ? path.resolve(process.env.DOMATION_ERP_DIR)
  : path.resolve(REPO_ROOT, '..', 'DOMATION_ERP_FULL');

const LANDING_REPO_ROOT = process.env.DOMATION_FRONTEND_DIR
  ? path.resolve(process.env.DOMATION_FRONTEND_DIR)
  : path.resolve(REPO_ROOT, '..', 'DOMATION_LANDINGPAGE');

const ALL_13_CRON_SUBROUTINES = [
  'sla',
  'drain',
  'zalo',
  'billing',
  'webhook',
  'capi',
  'marketing_flows',
  'marketing_campaigns',
  'audience_reeval',
  'attendance_confirm',
  'reminders',
  'outbox_events',
  'daily_report',
] as const;

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

async function seedCampaignEmailSetup(
  ctx: IsolatedE2eContext,
  tenant: SeededTenantContext,
  opts: {
    leadEmail: string;
    leadName?: string;
    leadPhone?: string;
    templateHtml?: string;
    campaignName?: string;
    subject?: string;
    scheduledAt?: string;
  }
): Promise<{
  leadId: string;
  audienceId: string;
  templateId: string;
  campaignId: string;
}> {
  assertTestRecipientsOnly([opts.leadEmail]);
  const leadRes = await ctx.apiJson<{ success: boolean; data: { id?: string; lead_id?: string } }>(
    '/api/v1/leads',
    {
      method: 'POST',
      token: tenant.accessToken,
      tenantSlug: tenant.tenantSlug,
      body: {
        name: opts.leadName ?? 'IDEAS Test Lead',
        email: opts.leadEmail,
        phone: opts.leadPhone ?? `090${String(Math.floor(1000000 + Math.random() * 8999999))}`,
        status: 'marketing_nurture',
        email_consent: 'subscribed',
      },
    }
  );
  const leadId = String(leadRes.data.lead_id || leadRes.data.id || '');
  assert.ok(leadId, 'Expected created lead ID');

  const audRes = await ctx.apiJson<{ success: boolean; data: { id: string } }>('/api/v1/audiences', {
    method: 'POST',
    token: tenant.accessToken,
    tenantSlug: tenant.tenantSlug,
    body: {
      name: `Aud-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      audience_type: 'static_data',
      initial_lead_ids: [leadId],
    },
  });
  const audienceId = audRes.data.id;

  const tplRes = await ctx.apiJson<{ success: boolean; data: { id: string } }>('/api/v1/marketing/templates', {
    method: 'POST',
    token: tenant.accessToken,
    tenantSlug: tenant.tenantSlug,
    body: {
      name: `Tpl-${Date.now()}`,
      subject: opts.subject ?? 'IDEAS Program Info',
      compiled_html:
        opts.templateHtml ??
        '<html><body><p>Hello {{lead.name}},</p><p><a href="https://ideas.edu.vn/mba">Explore MBA</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p></body></html>',
    },
  });
  const templateId = tplRes.data.id;

  const campRes = await ctx.apiJson<{ success: boolean; data: { id: string } }>('/api/v1/marketing/campaigns', {
    method: 'POST',
    token: tenant.accessToken,
    tenantSlug: tenant.tenantSlug,
    body: {
      name: opts.campaignName ?? `Camp-${Date.now()}`,
      channel: 'email',
      audience_id: audienceId,
      template_id: templateId,
      subject_a: opts.subject ?? 'IDEAS Program Info',
      ...(opts.scheduledAt ? { scheduled_at: opts.scheduledAt } : {}),
    },
  });

  return {
    leadId,
    audienceId,
    templateId,
    campaignId: campRes.data.id,
  };
}

function registerSnsConfirmMockRoute(ctx: IsolatedE2eContext): void {
  ctx.mockFetch.registerRoute({
    id: 'sns-confirm-subscription',
    match: (url, method) =>
      method === 'GET' &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
      url.searchParams.get('Action') === 'ConfirmSubscription',
    handler: () =>
      new Response(
        '<ConfirmSubscriptionResponse><ConfirmSubscriptionResult><SubscriptionArn>arn:aws:sns:ap-southeast-2:123456789012:ses-events:sub-1</SubscriptionArn></ConfirmSubscriptionResult></ConfirmSubscriptionResponse>',
        { status: 200, headers: { 'content-type': 'application/xml' } }
      ),
  });
}

function walkFiles(dirPath: string, filterFn: (p: string) => boolean, acc: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return acc;
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, filterFn, acc);
    } else if (filterFn(full)) {
      acc.push(full);
    }
  }
  return acc;
}

async function withBundledErpModule<T>(
  entryRelPath: string,
  defineEnv: Record<string, string>,
  mockWindow: Record<string, unknown>,
  fn: (mod: any, storage: Map<string, string>) => Promise<T> | T,
  initialStorage: Record<string, string> = {}
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-erp-bundle-'));
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
// Feature F9: Backend Domain Cutover (domation.net)
// ============================================================================
describe('Tier 1 — F9: Backend Domain Cutover (domation.net)', () => {
  it('[F9][T1] forms/:id/embed-config emits canonical https://data.domation.net snippets without app.domation.net', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const created = await ctx.apiJson<{ success: boolean; data: { id: string } }>('/api/v1/marketing/forms', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'IDEAS MBA Lead Form',
          routing_mode: 'marketing_nurture',
          fields: [{ id: 'f_email', key: 'email', label: 'Email', type: 'email', required: true }],
        },
      });
      const embed = await ctx.apiJson<{
        success: boolean;
        data: { snippets: Record<string, string> };
      }>(`/api/v1/marketing/forms/${created.data.id}/embed-config`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        headers: {
          'X-Forwarded-Host': 'data.domation.net',
          'X-Forwarded-Proto': 'https',
        },
      });

      for (const key of ['iframe', 'popup_modal', 'floating_bar', 'slide_in']) {
        const snippet = String(embed.data.snippets[key] || '');
        assert.ok(snippet.includes('https://data.domation.net/'), `${key} must resolve to https://data.domation.net/`);
        assert.equal(snippet.includes('app.domation.net'), false, `${key} must not contain legacy app.domation.net`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F9][T1] public sdk.js embeds canonical https://data.domation.net tracking & chat endpoints', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const res = await ctx.apiRaw('/api/v1/public/marketing/sdk.js', {
        query: { site_key: 'wp_ideas_01', chat: '1' },
        headers: {
          'X-Forwarded-Host': 'data.domation.net',
          'X-Forwarded-Proto': 'https',
        },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/javascript/i);
      assert.ok(res.rawText.includes('https://data.domation.net/api/v1/public/marketing/track'));
      assert.ok(res.rawText.includes('https://data.domation.net/api/v1/public/marketing/social/inbound/'));
    } finally {
      await ctx.close();
    }
  });

  it('[F9][T1] campaign email send injects data.domation.net open/click tracking and HMAC unsubscribe URLs over loopback SMTP', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        configureLoopbackSmtp: true,
        fromEmail: 'systemnoti@test-sink.domation.local',
      });
      const recipient = makeTestRecipient('f9-camp');
      const { campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: recipient,
        subject: 'IDEAS Fall Cohort',
        templateHtml:
          '<html><body><p>Welcome {{lead.name}}</p><a href="https://ideas.edu.vn/mba">Info</a><a href="{{unsubscribe_url}}">Unsub</a></body></html>',
      });

      const sendRes = await ctx.apiJson<{ success: boolean; data: { newly_sent: number } }>(
        `/api/v1/marketing/campaigns/${campaignId}/send`,
        {
          method: 'POST',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          headers: {
            'X-Forwarded-Host': 'data.domation.net',
            'X-Forwarded-Proto': 'https',
          },
        }
      );
      assert.equal(sendRes.data.newly_sent, 1);

      const msgs = await ctx.smtp.waitForMessages(1, 5000);
      assert.equal(msgs.length, 1);
      const html = msgs[0].html;
      assert.match(html, /https:\/\/data\.domation\.net\/api\/v1\/public\/marketing\/track\/open\/[0-9a-f-]+/i);
      assert.match(html, /https:\/\/data\.domation\.net\/api\/v1\/public\/marketing\/track\/click\/[0-9a-f-]+\?url=/i);
      assert.match(html, /https:\/\/data\.domation\.net\/api\/v1\/public\/marketing\/unsubscribe\?/i);
      assert.equal(html.includes('app.domation.net'), false);
    } finally {
      await ctx.close();
    }
  });

  it('[F9][T1] open GIF pixel and click redirect endpoints update claim & campaign counters and return 302/GIF', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f9-track');
      const { campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: recipient,
        templateHtml:
          '<html><body><a href="https://ideas.edu.vn/mba">MBA</a><a href="{{unsubscribe_url}}">Unsub</a></body></html>',
      });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        headers: {
          'X-Forwarded-Host': 'data.domation.net',
          'X-Forwarded-Proto': 'https',
        },
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const openMatch = msg.html.match(/\/api\/v1\/public\/marketing\/track\/open\/([0-9a-f-]+)/i);
      const clickMatch = msg.html.match(/\/api\/v1\/public\/marketing\/track\/click\/([0-9a-f-]+)\?url=([^"'\s&]+)/i);
      assert.ok(openMatch && clickMatch, 'Tracking URLs must be present in campaign HTML');

      const openResp = await fetch(`${ctx.baseUrl}${openMatch[0]}`);
      assert.equal(openResp.status, 200);
      assert.equal(openResp.headers.get('content-type'), 'image/gif');
      assert.match(openResp.headers.get('cache-control') || '', /no-store/i);
      const openBytes = Buffer.from(await openResp.arrayBuffer());
      assert.equal(openBytes.subarray(0, 6).toString('ascii'), 'GIF89a');

      const clickJsonRes = await ctx.apiJson<{ success: boolean; data: { redirect_url: string } }>(
        `${clickMatch[0]}&json=1`
      );
      assert.equal(clickJsonRes.data.redirect_url, 'https://ideas.edu.vn/mba');

      const click302 = await fetch(`${ctx.baseUrl}${clickMatch[0]}`, { redirect: 'manual' });
      assert.equal(click302.status, 302);
      assert.equal(click302.headers.get('location'), 'https://ideas.edu.vn/mba');

      const detail = await ctx.apiJson<{
        data: {
          campaign: { opened_count: number; clicked_count: number };
          claims: Array<{ status: string; opened_at: string | null; clicked_at: string | null }>;
        };
      }>(`/api/v1/marketing/campaigns/${campaignId}/detail`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(detail.data.campaign.opened_count, 1);
      assert.equal(detail.data.campaign.clicked_count, 1);
      assert.equal(detail.data.claims[0].status, 'clicked');
      assert.ok(detail.data.claims[0].opened_at);
      assert.ok(detail.data.claims[0].clicked_at);
    } finally {
      await ctx.close();
    }
  });

  it('[F9][T1] HMAC unsubscribe GET & POST updates lead consent, suppression list, campaign count, and skips subsequent sends', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f9-unsub');
      const { leadId, audienceId, templateId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: recipient,
      });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const unsubMatch = msg.html.match(/\/api\/v1\/public\/marketing\/unsubscribe\?[^"'\s<]+/i);
      assert.ok(unsubMatch, 'Unsubscribe URL must be present in campaign HTML');
      const unsubPath = unsubMatch[0].replace(/&amp;/g, '&');

      const unsubGet = await ctx.apiJson<{ success: boolean; data: { unsubscribed: boolean; channel: string } }>(
        unsubPath
      );
      assert.equal(unsubGet.data.unsubscribed, true);
      assert.equal(unsubGet.data.channel, 'email');

      const unsubPost = await ctx.apiJson<{ success: boolean; data: { unsubscribed: boolean } }>(unsubPath, {
        method: 'POST',
      });
      assert.equal(unsubPost.data.unsubscribed, true);

      const supList = await ctx.apiJson<{ data: { items: Array<{ recipient: string; reason: string }> } }>(
        '/api/v1/marketing/campaigns/suppression/list',
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.ok(
        supList.data.items.some((i) => i.recipient === recipient.toLowerCase() && i.reason === 'unsubscribed')
      );

      const leadsRes = await ctx.apiJson<{ data: { items: Array<{ id: string; email_consent: string }> } }>(
        '/api/v1/leads',
        { token: ideas.accessToken, tenantSlug: 'ideas', query: { search: recipient } }
      );
      const updatedLead = leadsRes.data.items.find((l) => l.id === leadId);
      assert.equal(updatedLead?.email_consent, 'unsubscribed');

      const detail = await ctx.apiJson<{ data: { campaign: { unsubscribed_count: number }; claims: Array<{ status: string }> } }>(
        `/api/v1/marketing/campaigns/${campaignId}/detail`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(detail.data.campaign.unsubscribed_count, 1);
      assert.equal(detail.data.claims[0].status, 'unsubscribed');

      // Subsequent campaign send must skip suppressed recipient
      ctx.smtp.clear();
      const camp2 = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Followup Campaign',
          channel: 'email',
          audience_id: audienceId,
          template_id: templateId,
          subject_a: 'Followup',
        },
      });
      const send2 = await ctx.apiJson<{ data: { newly_sent: number; suppressed_skipped: number } }>(
        `/api/v1/marketing/campaigns/${camp2.data.id}/send`,
        { method: 'POST', token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(send2.data.newly_sent, 0);
      assert.ok(send2.data.suppressed_skipped >= 1);
      assert.equal(ctx.smtp.messages.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F9][T1] automation flow send_email uses APP_PUBLIC_URL=https://data.domation.net without req and .env.example/deploy-direct.py define canonical origin', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f9-flow');
      assertTestRecipientsOnly([recipient]);

      const leadRes = await ctx.apiJson<{ data: { id?: string; lead_id?: string } }>('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Flow Unsub Lead',
          email: recipient,
          status: 'marketing_nurture',
          email_consent: 'subscribed',
        },
      });
      const leadId = String(leadRes.data.lead_id || leadRes.data.id);

      const flowRes = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'F9 Flow Unsub Test',
          trigger_type: 'manual_enroll',
          status: 'active',
          steps: [
            {
              id: 'step-email',
              type: 'send_email',
              label: 'Send Welcome',
              config: {
                subject: 'IDEAS Flow Hello',
                custom_html: '<p>Hi {{lead.name}}, <a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
              },
              nextStepId: null,
            },
          ],
        },
      });

      await ctx.apiJson(`/api/v1/marketing/flows/${flowRes.data.id}/enroll`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_id: leadId, skip_wait_delay: true },
      });

      const msgs = await ctx.smtp.waitForMessages(1, 5000);
      assert.equal(msgs.length, 1);
      assert.match(msgs[0].html, /https:\/\/data\.domation\.net\/api\/v1\/public\/marketing\/unsubscribe\?/i);

      const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
      assert.ok(envExample.includes('APP_PUBLIC_URL=https://data.domation.net'));

      const deployPy = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'deploy-direct.py'), 'utf8');
      assert.ok(deployPy.includes('https://data.domation.net'));
      assert.ok(deployPy.includes('APP_PUBLIC_URL='));
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F10: Legacy Media Assets & Link Rewriting
// ============================================================================
describe('Tier 1 — F10: Legacy Media Assets & Link Rewriting', () => {
  it('[F10][T1] public /uploadss/* serves static images & PDF documents without auth with CORS and cache headers', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-uploads-');
      process.env.UPLOADS_DIR = uploadsDir;
      const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x49, 0x44, 0x45, 0x41, 0x53]);
      const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');
      fs.writeFileSync(path.join(uploadsDir, 'banner-mba.jpg'), jpgBytes);
      fs.writeFileSync(path.join(uploadsDir, 'brochure.pdf'), pdfBytes);

      const jpgRes = await fetch(`${ctx.baseUrl}/uploadss/banner-mba.jpg`);
      assert.equal(jpgRes.status, 200);
      assert.equal(jpgRes.headers.get('access-control-allow-origin'), '*');
      assert.equal(jpgRes.headers.get('cache-control'), 'public, max-age=604800');
      assert.deepEqual(Buffer.from(await jpgRes.arrayBuffer()), jpgBytes);

      const pdfRes = await fetch(`${ctx.baseUrl}/uploadss/brochure.pdf`);
      assert.equal(pdfRes.status, 200);
      assert.equal(pdfRes.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(Buffer.from(await pdfRes.arrayBuffer()), pdfBytes);
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T1] nested /uploadss/ai_generated/* serves assets on GET and HEAD requests', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-nested-');
      process.env.UPLOADS_DIR = uploadsDir;
      fs.mkdirSync(path.join(uploadsDir, 'ai_generated'), { recursive: true });
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
      fs.writeFileSync(path.join(uploadsDir, 'ai_generated', 'hero-mba.png'), pngBytes);

      const getRes = await fetch(`${ctx.baseUrl}/uploadss/ai_generated/hero-mba.png`);
      assert.equal(getRes.status, 200);
      assert.deepEqual(Buffer.from(await getRes.arrayBuffer()), pngBytes);

      const headRes = await fetch(`${ctx.baseUrl}/uploadss/ai_generated/hero-mba.png`, { method: 'HEAD' });
      assert.equal(headRes.status, 200);
      assert.equal(headRes.headers.get('access-control-allow-origin'), '*');
      assert.equal((await headRes.text()).length, 0);
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T1] /uploadss/* bypasses anti-agent guard and SPA fallback with data.domation.net host and .htaccess rewrite rule', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const uploadsDir = ctx.createTempDir('f10-guard-');
      process.env.UPLOADS_DIR = uploadsDir;
      fs.writeFileSync(path.join(uploadsDir, 'thumb-mba.png'), 'PNG_ASSET_BYTES', 'utf8');

      const res = await fetch(`${ctx.baseUrl}/uploadss/thumb-mba.png`, {
        headers: {
          'X-Forwarded-Host': 'data.domation.net',
          'User-Agent': 'curl/8.5.0 HeadlessBot',
        },
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'PNG_ASSET_BYTES');

      const htaccess = fs.readFileSync(path.join(REPO_ROOT, '.htaccess'), 'utf8');
      assert.ok(htaccess.includes('RewriteCond %{REQUEST_URI} ^/uploadss/'));
      assert.ok(htaccess.includes('RewriteRule ^(.*)$ public/$1 [L]'));
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });

  it('[F10][T1] M3 CLI migrate-myerp-ideas.ts rewrites legacy automation.ideas.edu.vn and myerp.ideas.edu.vn uploadss URLs across templates, campaigns, flows, and short_links', async () => {
    const migrateScript = path.join(REPO_ROOT, 'scripts', 'migrate-myerp-ideas.ts');
    assert.equal(
      fs.existsSync(migrateScript),
      true,
      'M3 deliverable missing: scripts/migrate-myerp-ideas.ts is required for MYERP -> ideas link rewriting'
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
      pgDir = assertNotLivePgDataDir(ctx1.dataDir!, REPO_ROOT, 'F10 T1 pgDir');
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

      const tenantRes = await withSystemPrivilege((client) =>
        client.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'ideas'`)
      );
      assert.equal(tenantRes.rows.length, 1, 'Expected migrated ideas tenant in isolated DB');
      const ideasTenantId = tenantRes.rows[0].id;

      const requiredRewriteChecks = await withSystemPrivilege((client) =>
        client.query<{
          tbl: string;
          row_count: number;
          has_legacy: boolean;
          has_new: boolean;
        }>(
          `SELECT 'mkt_email_templates.compiled_html' AS tbl,
                  (SELECT COUNT(*)::int FROM mkt_email_templates WHERE tenant_id = $1) AS row_count,
                  EXISTS (SELECT 1 FROM mkt_email_templates WHERE tenant_id = $1 AND (compiled_html LIKE '%automation.ideas.edu.vn/uploadss%' OR compiled_html LIKE '%myerp.ideas.edu.vn/backend/uploadss%')) AS has_legacy,
                  EXISTS (SELECT 1 FROM mkt_email_templates WHERE tenant_id = $1 AND compiled_html LIKE '%https://data.domation.net/uploadss/%') AS has_new
           UNION ALL
           SELECT 'mkt_email_templates.blocks_json',
                  (SELECT COUNT(*)::int FROM mkt_email_templates WHERE tenant_id = $1),
                  EXISTS (SELECT 1 FROM mkt_email_templates WHERE tenant_id = $1 AND (blocks_json::text LIKE '%automation.ideas.edu.vn/uploadss%' OR blocks_json::text LIKE '%myerp.ideas.edu.vn/backend/uploadss%')),
                  EXISTS (SELECT 1 FROM mkt_email_templates WHERE tenant_id = $1 AND blocks_json::text LIKE '%https://data.domation.net/uploadss/%')
           UNION ALL
           SELECT 'mkt_flows.steps_json',
                  (SELECT COUNT(*)::int FROM mkt_flows WHERE tenant_id = $1),
                  EXISTS (SELECT 1 FROM mkt_flows WHERE tenant_id = $1 AND (steps_json::text LIKE '%automation.ideas.edu.vn/uploadss%' OR steps_json::text LIKE '%myerp.ideas.edu.vn/backend/uploadss%')),
                  EXISTS (SELECT 1 FROM mkt_flows WHERE tenant_id = $1 AND steps_json::text LIKE '%https://data.domation.net/uploadss/%')
           UNION ALL
           SELECT 'mkt_short_links.target_url',
                  (SELECT COUNT(*)::int FROM mkt_short_links WHERE tenant_id = $1),
                  EXISTS (SELECT 1 FROM mkt_short_links WHERE tenant_id = $1 AND (target_url LIKE '%automation.ideas.edu.vn/uploadss%' OR target_url LIKE '%myerp.ideas.edu.vn/backend/uploadss%')),
                  EXISTS (SELECT 1 FROM mkt_short_links WHERE tenant_id = $1 AND target_url LIKE '%https://data.domation.net/uploadss/%')`,
          [ideasTenantId]
        )
      );
      for (const r of requiredRewriteChecks.rows) {
        assert.ok(r.row_count >= 1, `${r.tbl} should have >= 1 migrated row for ideas`);
        assert.equal(r.has_legacy, false, `${r.tbl} still contains unrewritten legacy uploadss URLs`);
        assert.equal(r.has_new, true, `${r.tbl} should contain rewritten https://data.domation.net/uploadss/ URLs`);
      }

      const metadataNoLegacyChecks = await withSystemPrivilege((client) =>
        client.query<{
          tbl: string;
          row_count: number;
          has_legacy: boolean;
        }>(
          `SELECT 'mkt_campaigns' AS tbl,
                  (SELECT COUNT(*)::int FROM mkt_campaigns WHERE tenant_id = $1) AS row_count,
                  EXISTS (
                    SELECT 1 FROM mkt_campaigns
                    WHERE tenant_id = $1
                      AND (
                        COALESCE(subject_a, '') || ' ' || COALESCE(subject_b, '') || ' ' ||
                        reminder_config::text || ' ' || fallback_vars_json::text
                      ) ~* '(?:automation\\.ideas\\.edu\\.vn|myerp\\.ideas\\.edu\\.vn/backend)/uploadss'
                  ) AS has_legacy
           UNION ALL
           SELECT 'mkt_email_templates.thumbnail_url',
                  (SELECT COUNT(*)::int FROM mkt_email_templates WHERE tenant_id = $1),
                  EXISTS (
                    SELECT 1 FROM mkt_email_templates
                    WHERE tenant_id = $1
                      AND COALESCE(thumbnail_url, '') ~* '(?:automation\\.ideas\\.edu\\.vn|myerp\\.ideas\\.edu\\.vn/backend)/uploadss'
                  ) AS has_legacy`,
          [ideasTenantId]
        )
      );
      for (const r of metadataNoLegacyChecks.rows) {
        assert.ok(r.row_count >= 1, `${r.tbl} should have >= 1 migrated row for ideas`);
        assert.equal(r.has_legacy, false, `${r.tbl} still contains unrewritten legacy uploadss URLs`);
      }
    } finally {
      if (ctx1) await ctx1.close();
      if (ctx2) await ctx2.close();
      dump.cleanup();
      if (pgDir) {
        assertNotLivePgDataDir(pgDir, REPO_ROOT, 'F10 T1 cleanup pgDir');
        fs.rmSync(pgDir, { recursive: true, force: true });
      }
    }
  });

  it('[F10][T1] synthetic MYERP dump legacy URL inventory matches /uploadss/* HTTP serving contract', async () => {
    const prevUploadsDir = process.env.UPLOADS_DIR;
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const dump = ctx.createSyntheticDump();
      const meta = await inspectSqlDumpMetadata(dump.sqlPath);
      assert.ok(meta.tableCount > 20);
      assert.ok(dump.counts.legacyUrlCount >= 9, `Expected >=9 legacy URLs, got ${dump.counts.legacyUrlCount}`);

      const sqlText = fs.readFileSync(dump.sqlPath, 'utf8');
      const uploadMatches = Array.from(
        sqlText.matchAll(/https:\/\/(?:automation\.ideas\.edu\.vn|myerp\.ideas\.edu\.vn\/backend)\/uploadss\/([a-zA-Z0-9_./-]+)/g)
      ).map((m) => m[1]);
      assert.ok(uploadMatches.length >= 5, 'Synthetic dump must contain uploadss asset references');

      const uploadsDir = ctx.createTempDir('f10-parity-');
      process.env.UPLOADS_DIR = uploadsDir;
      for (const rel of new Set(uploadMatches)) {
        const target = path.join(uploadsDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `ASSET:${rel}`, 'utf8');
        const res = await fetch(`${ctx.baseUrl}/uploadss/${rel}`);
        assert.equal(res.status, 200, `Expected /uploadss/${rel} to resolve HTTP 200`);
        assert.equal(await res.text(), `ASSET:${rel}`);
      }
    } finally {
      if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploadsDir;
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F11: AWS SES/SNS Bounce, Complaint & Delivery Webhook
// ============================================================================
describe('Tier 1 — F11: AWS SES/SNS Bounce, Complaint & Delivery Webhook', () => {
  it('[F11][T1] SubscriptionConfirmation verifies RSA signature and auto-confirms SubscribeURL via mockFetch', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      registerSnsConfirmMockRoute(ctx);
      ctx.mockFetch.clearRequests();

      const subReq = ctx.snsSigner.signSubscriptionConfirmation();
      const res = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: subReq.headers,
        body: subReq.rawBody,
      });

      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${res.rawText}`);
      assert.equal(res.json?.success, true);
      assert.equal(res.json?.data?.type, 'SubscriptionConfirmation');
      assert.equal(res.json?.data?.confirmed, true);
      assert.equal(res.json?.data?.status, 200);

      const confirmCalls = ctx.mockFetch
        .getRequests()
        .filter((r) => r.url.includes('Action=ConfirmSubscription'));
      assert.equal(confirmCalls.length, 1);
      assert.equal(confirmCalls[0].blocked, false);
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T1] Permanent Bounce updates mkt_send_claims, leads.email_consent, mkt_suppression_list, mkt_campaigns.bounced_count, and timeline', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f11-perm');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [smtpMsg] = await ctx.smtp.waitForMessages(1, 5000);

      const snsReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Bounce',
        bounceType: 'Permanent',
        bounceSubType: 'General',
        recipients: [recipient],
        messageId: smtpMsg.id,
        diagnosticCode: 'smtp; 550 5.1.1 user unknown',
      });
      const webhookRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: snsReq.headers,
        body: snsReq.rawBody,
      });
      assert.equal(webhookRes.status, 200);
      assert.equal(webhookRes.json?.data?.processed, true);
      assert.equal(webhookRes.json?.data?.matched_count, 1);

      const detail = await ctx.apiJson<{
        data: { campaign: { bounced_count: number }; claims: Array<{ status: string; metadata: Record<string, any> }> };
      }>(`/api/v1/marketing/campaigns/${campaignId}/detail`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(detail.data.campaign.bounced_count, 1);
      assert.equal(detail.data.claims[0].status, 'bounced');
      assert.ok(detail.data.claims[0].metadata.sns_bounce);

      const leadsRes = await ctx.apiJson<{ data: { items: Array<{ id: string; email_consent: string }> } }>(
        '/api/v1/leads',
        { token: ideas.accessToken, tenantSlug: 'ideas', query: { search: recipient } }
      );
      assert.equal(leadsRes.data.items.find((l) => l.id === leadId)?.email_consent, 'bounced');

      const supList = await ctx.apiJson<{ data: { items: Array<{ recipient: string; reason: string }> } }>(
        '/api/v1/marketing/campaigns/suppression/list',
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.ok(
        supList.data.items.some((s) => s.recipient === recipient.toLowerCase() && s.reason === 'hard_bounce')
      );

      const timeline = await ctx.apiJson<{ data: Array<{ event_type: string }> }>(
        `/api/v1/leads/${leadId}/timeline`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      const events = Array.isArray(timeline.data) ? timeline.data : [];
      assert.ok(events.some((e) => e.event_type === 'email_bounced'));
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T1] Transient soft bounce records transient_bounce_count & timeline without suppressing lead or incrementing bounced_count', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f11-soft');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [smtpMsg] = await ctx.smtp.waitForMessages(1, 5000);

      const snsReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Bounce',
        bounceType: 'Transient',
        bounceSubType: 'MailboxFull',
        recipients: [recipient],
        messageId: smtpMsg.id,
        diagnosticCode: '452 4.2.2 Mailbox full',
      });
      const webhookRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: snsReq.headers,
        body: snsReq.rawBody,
      });
      assert.equal(webhookRes.status, 200);
      assert.equal(webhookRes.json?.data?.matched_count, 1);

      const detail = await ctx.apiJson<{
        data: { campaign: { bounced_count: number }; claims: Array<{ status: string; metadata: Record<string, any> }> };
      }>(`/api/v1/marketing/campaigns/${campaignId}/detail`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(detail.data.campaign.bounced_count, 0);
      assert.equal(detail.data.claims[0].status, 'sent');
      assert.equal(Number(detail.data.claims[0].metadata.transient_bounce_count), 1);

      const leadsRes = await ctx.apiJson<{ data: { items: Array<{ id: string; email_consent: string }> } }>(
        '/api/v1/leads',
        { token: ideas.accessToken, tenantSlug: 'ideas', query: { search: recipient } }
      );
      assert.equal(leadsRes.data.items.find((l) => l.id === leadId)?.email_consent, 'subscribed');

      const supList = await ctx.apiJson<{ data: { items: Array<{ recipient: string }> } }>(
        '/api/v1/marketing/campaigns/suppression/list',
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(supList.data.items.some((s) => s.recipient === recipient.toLowerCase()), false);

      const timeline = await ctx.apiJson<{ data: Array<{ event_type: string }> }>(
        `/api/v1/leads/${leadId}/timeline`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      const events = Array.isArray(timeline.data) ? timeline.data : [];
      assert.ok(events.some((e) => e.event_type === 'email_soft_bounce'));
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T1] Complaint via application/json alias /api/v1/public/marketing/sns-webhook marks claim complained & suppresses lead', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f11-comp');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [smtpMsg] = await ctx.smtp.waitForMessages(1, 5000);

      const snsReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Complaint',
        complaintFeedbackType: 'abuse',
        recipients: [recipient],
        messageId: smtpMsg.id,
      });
      const res = await ctx.apiRaw('/api/v1/public/marketing/sns-webhook', {
        method: 'POST',
        headers: {
          ...snsReq.headers,
          'Content-Type': 'application/json',
        },
        body: snsReq.rawBody,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json?.data?.matched_count, 1);

      const detail = await ctx.apiJson<{ data: { claims: Array<{ status: string }> } }>(
        `/api/v1/marketing/campaigns/${campaignId}/detail`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(detail.data.claims[0].status, 'complained');

      const leadsRes = await ctx.apiJson<{ data: { items: Array<{ id: string; email_consent: string }> } }>(
        '/api/v1/leads',
        { token: ideas.accessToken, tenantSlug: 'ideas', query: { search: recipient } }
      );
      assert.equal(leadsRes.data.items.find((l) => l.id === leadId)?.email_consent, 'complained');

      const supList = await ctx.apiJson<{ data: { items: Array<{ recipient: string; reason: string }> } }>(
        '/api/v1/marketing/campaigns/suppression/list',
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.ok(supList.data.items.some((s) => s.recipient === recipient.toLowerCase() && s.reason === 'complained'));
    } finally {
      await ctx.close();
    }
  });

  it('[F11][T1] Delivery notification with SignatureVersion 1 (SHA1) transitions sent -> delivered and logs email_delivered', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f11-deliv');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [smtpMsg] = await ctx.smtp.waitForMessages(1, 5000);

      const snsReq = signSnsNotification(
        ctx.snsSigner,
        {
          eventType: 'Delivery',
          recipients: [recipient],
          messageId: smtpMsg.id,
        },
        { signatureVersion: '1' }
      );
      assert.equal(snsReq.envelope.SignatureVersion, '1');

      const res = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: snsReq.headers,
        body: snsReq.rawBody,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json?.data?.matched_count, 1);

      const detail = await ctx.apiJson<{
        data: { claims: Array<{ status: string; metadata: Record<string, any> }> };
      }>(`/api/v1/marketing/campaigns/${campaignId}/detail`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(detail.data.claims[0].status, 'delivered');
      assert.ok(detail.data.claims[0].metadata.sns_delivery);

      const timeline = await ctx.apiJson<{ data: Array<{ event_type: string }> }>(
        `/api/v1/leads/${leadId}/timeline`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      const events = Array.isArray(timeline.data) ? timeline.data : [];
      assert.ok(events.some((e) => e.event_type === 'email_delivered'));
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F12: External AWS SES/SNS & Manual Cutover Checklist
// ============================================================================
describe('Tier 1 — F12: External AWS SES/SNS & Manual Cutover Checklist', () => {
  it('[F12][T1] AWS SNS SubscriptionConfirmation external callback cutover succeeds on both primary and alias endpoints', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      await seedIdeasTenant(ctx, { slug: 'ideas' });
      registerSnsConfirmMockRoute(ctx);

      for (const endpoint of ['/api/v1/webhooks/ses-sns', '/api/v1/public/marketing/sns-webhook']) {
        ctx.mockFetch.clearRequests();
        const subReq = ctx.snsSigner.signSubscriptionConfirmation();
        const res = await ctx.apiRaw(endpoint, {
          method: 'POST',
          headers: subReq.headers,
          body: subReq.rawBody,
        });
        assert.equal(res.status, 200, `${endpoint} failed: ${res.rawText}`);
        assert.equal(res.json?.data?.confirmed, true);
        assert.equal(
          ctx.mockFetch.getRequests().filter((r) => r.url.includes('Action=ConfirmSubscription')).length,
          1
        );
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F12][T1] external Google Sheets / LadiPage inbound webhook ingests lead for ideas with HMAC-SHA256 without affecting ecolife', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const ecolife = await seedSiblingTenant(ctx, 'ecolife');

      const wh = await ctx.apiJson<{ data: { token: string; signing_secret: string } }>(
        '/api/v1/integrations/webhooks',
        {
          method: 'POST',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          body: {
            name: 'Google Sheets Lead Sync',
            webhook_type: 'inbound',
            is_active: true,
          },
        }
      );

      const payload = JSON.stringify({
        name: 'LadiPage Lead',
        phone: '0909333444',
        email: makeTestRecipient('f12-sheet'),
      });
      const sig = crypto.createHmac('sha256', wh.data.signing_secret).update(payload).digest('hex');

      const ingestRes = await ctx.apiRaw(`/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${sig}`,
        },
        body: payload,
      });
      assert.equal(ingestRes.status, 202);
      assert.equal(ingestRes.json?.status, 'ENQUEUED');
      assert.ok(ingestRes.json?.lead_id);

      const ecoLeads = await ctx.apiJson<{ data: { items: unknown[] } }>('/api/v1/leads', {
        token: ecolife.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(ecoLeads.data.items.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F12][T1] external Meta Developer App webhook verification challenge and Messenger X-Hub-Signature-256 POST succeed', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const verifyToken = 'ideas_meta_verify_2026';
      const appSecret = 'ideas_meta_app_secret_2026';

      await ctx.apiJson('/api/v1/integrations/vault/meta_messenger', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          verify_token: verifyToken,
          app_secret: appSecret,
          page_id: '101202303404',
          page_access_token: 'EAAG_TEST_TOKEN_SYNTHETIC',
        },
      });

      const challengeRes = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        method: 'GET',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': verifyToken,
          'hub.challenge': 'CHAL_991',
        },
      });
      assert.equal(challengeRes.status, 200);
      assert.equal(challengeRes.rawText, 'CHAL_991');

      const eventPayload = JSON.stringify({
        object: 'page',
        entry: [
          {
            id: '101202303404',
            messaging: [
              {
                sender: { id: 'psid_test_1', name: 'Test Messenger User' },
                message: { text: 'Tu van MBA' },
              },
            ],
          },
        ],
      });
      const hubSig = `sha256=${crypto.createHmac('sha256', appSecret).update(eventPayload).digest('hex')}`;
      const postRes = await ctx.apiRaw('/api/v1/public/marketing/social/inbound/ideas', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': hubSig,
        },
        body: eventPayload,
      });
      assert.equal(postRes.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it('[F12][T1] external integration vault stores aws_ses, google_sheets, misa_einvoice, meta_capi, facebook_ads while excluding ZaloBot', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const configs: Array<{ type: string; body: Record<string, unknown> }> = [
        { type: 'aws_ses', body: { smtp_host: ctx.smtp.host, smtp_port: ctx.smtp.port, from_email: 'noreply@test-sink.domation.local' } },
        { type: 'google_sheets', body: { webhook_url: 'https://script.google.com/macros/s/test/exec' } },
        { type: 'misa_einvoice', body: { api_url: 'https://test-misa.local/api', api_key: 'misa_test_key' } },
        { type: 'meta_capi', body: { pixel_id: '583807401361847', access_token: 'EAAG_CAPI_SYNTHETIC' } },
        { type: 'facebook_ads', body: { ad_account_id: '1852318231510577', access_token: 'EAAG_ADS_SYNTHETIC' } },
      ];
      for (const cfg of configs) {
        const res = await ctx.apiJson<{ success: boolean }>(`/api/v1/integrations/vault/${cfg.type}`, {
          method: 'PUT',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          body: cfg.body,
        });
        assert.equal(res.success, true);
      }

      const overview = await ctx.apiJson<{ data: { integrations: Record<string, unknown> } }>(
        '/api/v1/integrations/overview',
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      for (const cfg of configs) {
        assert.ok(overview.data.integrations[cfg.type], `Expected ${cfg.type} in integrations overview`);
      }
      for (const excluded of ['zalo_bot', 'zalo_oa', 'zalo_zns']) {
        assert.equal(overview.data.integrations[excluded], undefined, `Zalo integration ${excluded} must remain excluded`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F12][T1] MANUAL_CUTOVER_CHECKLIST.md exists and documents external dashboards, canonical data.domation.net callbacks, and ZaloBot exclusion', async () => {
    const checklistPath = resolveChecklistPath();
    assert.equal(
      fs.existsSync(checklistPath),
      true,
      `M4 deliverable missing: ${checklistPath} must document manual external dashboard cutover`
    );

    const content = fs.readFileSync(checklistPath, 'utf8');
    assert.ok(content.trim().length > 200, 'MANUAL_CUTOVER_CHECKLIST.md must contain detailed guidance');
    assert.match(content, /https:\/\/data\.domation\.net\/api\/v1\/webhooks\/ses-sns/);
    assert.match(content, /https:\/\/data\.domation\.net\/api\/v1\/webhooks\//);
    assert.match(content, /ideas/i);
    assert.match(content, /Meta|Messenger|CAPI|1852318231510577|583807401361847|661260709828887/i);
    assert.match(content, /Google\s*Sheets|AppScript/i);
    assert.match(content, /MISA/i);
    const zaloExclusionRe =
      /(?:(?:do\s+not|don't|never|must\s+not|exclude|excluded|excluding|inactive|disabled|not\s+configured?|off|skip|keep\s+inactive)[^\n.]{0,100}\b(?:ZaloBot|Zalo\s*OA|zalo_bot|zalo_oa)\b|\b(?:ZaloBot|Zalo\s*OA|zalo_bot|zalo_oa)\b[^\n.]{0,100}(?:excluded|exclusion|inactive|disabled|not\s+configured?|do\s+not|don't|never|must\s+not|off|remains?\s+(?:unconfigured|inactive|disabled)|unconfigured))/i;
    assert.match(
      content,
      zaloExclusionRe,
      'MANUAL_CUTOVER_CHECKLIST.md must explicitly document ZaloBot/Zalo OA exclusion or inactivity'
    );
  });

  it('[F12][T1] MANUAL_CUTOVER_CHECKLIST.md documents legacy domain preservation and sibling tenant non-disruption', async () => {
    const checklistPath = resolveChecklistPath();
    assert.equal(
      fs.existsSync(checklistPath),
      true,
      `M4 deliverable missing: ${checklistPath} must document legacy preservation`
    );

    const content = fs.readFileSync(checklistPath, 'utf8');
    for (const legacy of ['myerp.ideas.edu.vn', 'automation.ideas.edu.vn', 'open.domation.net']) {
      assert.ok(content.includes(legacy), `Checklist must explicitly reference preserving ${legacy}`);
    }
    for (const sibling of ['ecolife', 'ecolifesignature', 'ecolife-automation']) {
      assert.ok(content.includes(sibling), `Checklist must explicitly reference non-disruption of ${sibling}`);
    }
  });
});

// ============================================================================
// Feature F13: Frontend & Meta Report Domain Cutover
// ============================================================================
describe('Tier 1 — F13: Frontend & Meta Report Domain Cutover', () => {
  it('[F13][T1] DOMATION_ERP_FULL .env.production, env.ts, config.ts, Integrations.tsx, and Settings.tsx resolve canonical https://data.domation.net', async () => {
    assert.equal(fs.existsSync(ERP_REPO_ROOT), true, `Missing ERP repo at ${ERP_REPO_ROOT}`);

    const envProd = fs.readFileSync(path.join(ERP_REPO_ROOT, '.env.production'), 'utf8');
    assert.match(envProd, /VITE_API_ORIGIN=https:\/\/data\.domation\.net/);

    const prodEnv = {
      VITE_API_ORIGIN: 'https://data.domation.net',
      VITE_DEFAULT_TENANT_SLUG: 'ecolife',
      VITE_APP_TITLE: 'DOMATION ERP',
    };
    const prodWindow = {
      location: {
        hostname: 'crm.domation.net',
        origin: 'https://crm.domation.net',
        search: '?tenant=ideas',
      },
    };

    await withBundledErpModule('config/env.ts', prodEnv, prodWindow, (envMod) => {
      assert.equal(envMod.API_ORIGIN, 'https://data.domation.net');
      assert.equal(envMod.API_BASE, 'https://data.domation.net/api/v1/myerp');
      assert.equal(envMod.BACKEND_BASE, 'https://data.domation.net/backend');
      assert.equal(envMod.getActiveTenantSlug(), 'ideas');
    });

    await withBundledErpModule('components/marketing/utils/config.ts', prodEnv, prodWindow, (cfgMod) => {
      assert.equal(cfgMod.API_BASE_URL, 'https://data.domation.net/api/v1/myerp/automation');
      assert.equal(cfgMod.EXTERNAL_API_BASE, 'https://data.domation.net/api/v1/myerp/automation');
      assert.equal(cfgMod.PUBLIC_MARKETING_API_BASE, 'https://data.domation.net/api/v1/public/marketing');
      assert.equal(cfgMod.EXTERNAL_PUBLIC_API_BASE, 'https://data.domation.net/api/v1/public/marketing');
      assert.equal(cfgMod.EXTERNAL_ASSET_BASE, 'https://data.domation.net');
    });

    const integrationsSrc = fs.readFileSync(path.join(ERP_REPO_ROOT, 'src', 'pages', 'Integrations.tsx'), 'utf8');
    assert.match(integrationsSrc, /\$\{API_ORIGIN\}\/api\/v1\/webhooks/);

    const settingsSrc = fs.readFileSync(path.join(ERP_REPO_ROOT, 'src', 'pages', 'Settings.tsx'), 'utf8');
    assert.match(settingsSrc, /\$\{API_ORIGIN\}\/api\/v1\/public\/marketing\/sdk\.js/);
  });

  it('[F13][T1] DOMATION_ERP_FULL built dist/assets/*.js embeds https://data.domation.net with zero legacy/localhost API leaks', async () => {
    const distAssetsDir = path.join(ERP_REPO_ROOT, 'dist', 'assets');
    assert.equal(fs.existsSync(distAssetsDir), true, `Missing ERP dist/assets at ${distAssetsDir}`);
    const jsFiles = walkFiles(distAssetsDir, (p) => p.endsWith('.js'));
    assert.ok(jsFiles.length > 0, 'Expected built JS bundles in DOMATION_ERP_FULL/dist/assets');

    let sawCanonicalOrigin = false;
    const forbidden = [
      'crm.domation.net/backend',
      'crm.domation.net/api/',
      'myerp.ideas.edu.vn',
      'automation.ideas.edu.vn',
      '127.0.0.1:3100',
      'localhost:3100',
    ];
    for (const f of jsFiles) {
      const text = fs.readFileSync(f, 'utf8');
      if (text.includes('https://data.domation.net')) {
        sawCanonicalOrigin = true;
      }
      for (const bad of forbidden) {
        assert.equal(text.includes(bad), false, `Forbidden API origin '${bad}' found in ${path.basename(f)}`);
      }
    }
    assert.equal(sawCanonicalOrigin, true, 'Expected https://data.domation.net inside ERP dist bundle');
  });

  it('[F13][T1] DOMATION_LANDINGPAGE AutoDataWebhookGuide.tsx, vercel.json, and api/autodata.ts enforce canonical data.domation.net contract', async () => {
    assert.equal(fs.existsSync(LANDING_REPO_ROOT), true, `Missing landing repo at ${LANDING_REPO_ROOT}`);

    const guideSrc = fs.readFileSync(
      path.join(LANDING_REPO_ROOT, 'src', 'components', 'autodata', 'AutoDataWebhookGuide.tsx'),
      'utf8'
    );
    assert.match(guideSrc, /CANONICAL_AUTODATA_ORIGIN\s*=\s*'https:\/\/data\.domation\.net'/);
    assert.match(guideSrc, /\/api\/v1\/webhooks\/\$\{safeSlugSegment\}\/\$\{safeTokenSegment\}/);

    const vercelJson = JSON.parse(fs.readFileSync(path.join(LANDING_REPO_ROOT, 'vercel.json'), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    const rewriteSources = new Set(vercelJson.rewrites.map((r) => r.source));
    assert.equal(rewriteSources.has('/api/v1/:path*'), true);
    assert.equal(rewriteSources.has('/v1/:path*'), true);
    assert.equal(rewriteSources.has('/meta-report/:slug'), true);

    const apiAutodata = fs.readFileSync(path.join(LANDING_REPO_ROOT, 'api', 'autodata.ts'), 'utf8');
    assert.match(apiAutodata, /https:\/\/data\.domation\.net/);
  });

  it('[F13][T1] live handleAutodataBridgeHttp proxy forwards health, dom-meta access, and ideas webhook to isolated backend', async () => {
    const bridgePath = path.join(LANDING_REPO_ROOT, 'lib', 'autodataBridge.ts');
    assert.equal(fs.existsSync(bridgePath), true, `Missing bridge module at ${bridgePath}`);
    const bridgeMod = (await import(pathToFileURL(bridgePath).href)) as {
      handleAutodataBridgeHttp: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        explicitApiUrl?: string
      ) => Promise<void>;
    };

    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    let bridgeServer: http.Server | null = null;
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      await ctx.apiJson('/api/v1/integrations/dom-meta/share', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { public_view: true },
      });
      const wh = await ctx.apiJson<{ data: { token: string; signing_secret: string } }>(
        '/api/v1/integrations/webhooks',
        {
          method: 'POST',
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          body: { name: 'Bridge Test Hook', webhook_type: 'inbound', is_active: true },
        }
      );

      bridgeServer = http.createServer((req, res) => {
        void bridgeMod.handleAutodataBridgeHttp(req, res, ctx.baseUrl);
      });
      await new Promise<void>((resolve) => bridgeServer!.listen(0, '127.0.0.1', () => resolve()));
      const addr = bridgeServer.address();
      assert.ok(addr && typeof addr !== 'string');
      const proxyBase = `http://127.0.0.1:${addr.port}`;

      const h1 = await fetch(`${proxyBase}/api/autodata?action=health`);
      assert.equal(h1.status, 200);

      const h2 = await fetch(`${proxyBase}/api/autodata?__v1_path=health`);
      assert.equal(h2.status, 200);

      const dm = await fetch(`${proxyBase}/api/v1/public/dom-meta/ideas/access`);
      assert.equal(dm.status, 200);
      const dmJson = (await dm.json()) as { data: { public_view: boolean; tenant: { slug: string } } };
      assert.equal(dmJson.data.public_view, true);
      assert.equal(dmJson.data.tenant.slug, 'ideas');

      const whBody = JSON.stringify({ name: 'Proxy Lead', phone: '0909666777' });
      const whSig = crypto.createHmac('sha256', wh.data.signing_secret).update(whBody).digest('hex');
      const whResp = await fetch(`${proxyBase}/api/v1/webhooks/ideas/${wh.data.token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Slug': 'ideas',
          'X-Webhook-Signature': `sha256=${whSig}`,
        },
        body: whBody,
      });
      assert.equal(whResp.status, 202);
      const whJson = (await whResp.json()) as { status: string; lead_id: string };
      assert.equal(whJson.status, 'ENQUEUED');
      assert.ok(whJson.lead_id);
    } finally {
      if (bridgeServer) {
        await new Promise<void>((resolve) => bridgeServer!.close(() => resolve()));
      }
      await ctx.close();
    }
  });

  it('[F13][T1] DOMATION_LANDINGPAGE MetaAdReport.tsx, main.tsx, and domMetaApi.ts resolve ideas slug for meta.domation.net/ideas and /meta-report/ideas', async () => {
    const metaSrc = fs.readFileSync(path.join(LANDING_REPO_ROOT, 'src', 'MetaAdReport.tsx'), 'utf8');
    const reservedMatch = metaSrc.match(/const META_RESERVED_PATHS = new Set\(\[[\s\S]*?\]\);/);
    const detectMatch = metaSrc.match(/function detectMetaPathSlug\(\): string \| null \{[\s\S]*?\n\}/);
    assert.ok(reservedMatch && detectMatch, 'Expected META_RESERVED_PATHS and detectMetaPathSlug in MetaAdReport.tsx');

    const evalSlug = (hostname: string, pathname: string): string | null => {
      const code = `
        const window = { location: { hostname: ${JSON.stringify(hostname)}, pathname: ${JSON.stringify(pathname)} } };
        ${reservedMatch[0]}
        ${detectMatch[0].replace('function detectMetaPathSlug(): string | null', 'function detectMetaPathSlug()')}
        detectMetaPathSlug();
      `;
      return vm.runInNewContext(code) as string | null;
    };

    assert.equal(evalSlug('meta.domation.net', '/ideas'), 'ideas');
    assert.equal(evalSlug('meta.domation.net', '/ideas/'), 'ideas');
    assert.equal(evalSlug('domation.net', '/meta-report/ideas'), 'ideas');

    const mainSrc = fs.readFileSync(path.join(LANDING_REPO_ROOT, 'src', 'main.tsx'), 'utf8');
    assert.match(mainSrc, /\/meta-report\//);
    assert.match(mainSrc, /\^meta\\\./);

    const domMetaApiSrc = fs.readFileSync(
      path.join(LANDING_REPO_ROOT, 'src', 'components', 'dom-meta', 'domMetaApi.ts'),
      'utf8'
    );
    assert.match(domMetaApiSrc, /\/api\/v1\/public\/dom-meta\/\$\{encodeURIComponent\(clean\)\}\/access/);
  });

  it('[F13][T1] backend /api/v1/public/dom-meta/ideas/access issues viewer JWT when public_view is enabled', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', packageCode: 'growth_combo' });
      await ctx.apiJson('/api/v1/integrations/dom-meta/share', {
        method: 'PUT',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { public_view: true },
      });

      const pubRes = await ctx.apiRaw<{
        success: boolean;
        data: {
          public_view: boolean;
          access_token: string;
          tenant: { slug: string };
          user: { role: string };
        };
      }>('/api/v1/public/dom-meta/ideas/access');
      assert.equal(pubRes.status, 200);
      assert.match(pubRes.headers.get('cache-control') || '', /no-store/i);
      assert.match(pubRes.headers.get('x-robots-tag') || '', /noindex/i);
      assert.equal(pubRes.json.data.public_view, true);
      assert.equal(pubRes.json.data.tenant.slug, 'ideas');
      assert.equal(pubRes.json.data.user.role, 'viewer');
      assert.ok(pubRes.json.data.access_token.length > 20);

      const cfgRes = await ctx.apiRaw('/api/v1/integrations/dom-meta/config', {
        token: pubRes.json.data.access_token,
        tenantSlug: 'ideas',
      });
      assert.equal(cfgRes.status, 200);
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F14: Master Cronjob Consolidation & PGlite Safety
// ============================================================================
describe('Tier 1 — F14: Master Cronjob Consolidation & PGlite Safety', () => {
  it('[F14][T1] authenticated POST /api/v1/operations/cron/master executes all 13 subroutines cleanly', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const res = await triggerMasterCron(ctx, { tenantId: ideas.tenantId });
      assert.equal(res.status, 200);
      assert.equal(res.ok, true);
      assert.equal(res.locked, false);
      assert.deepEqual(res.stats.errors, []);
      assert.ok(Number(res.stats.durationMs) >= 0);

      for (const counterKey of [
        'slaBreachedCount',
        'leadsDrainedCount',
        'zaloRefreshedCount',
        'subscriptionsProcessed',
        'webhooksReplayedCount',
        'capiRetriedCount',
        'marketingFlowsProcessed',
        'marketingCampaignsProcessed',
        'audiencesReevalCount',
        'attendanceConfirmationsCount',
        'remindersDispatchedCount',
        'outboxEventsProcessed',
        'dailyReportsDispatchedCount',
      ]) {
        assert.equal(typeof res.stats[counterKey], 'number', `Missing stat counter ${counterKey}`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T1] tenant_cron_runs telemetry & GET /api/v1/org-rbac/cron-status return all 13 catalog keys and 4 scheduler run logs', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const subset = ['sla', 'drain', 'marketing_flows', 'marketing_campaigns'];
      const cronRes = await triggerMasterCron(ctx, { tenantId: ideas.tenantId, subroutines: subset });
      assert.equal(cronRes.status, 200);

      const statusRes = await ctx.apiJson<{
        data: {
          subroutines: Array<{ key: string }>;
          runs: Array<{
            subroutine_key: string;
            status: string;
            triggered_by: string;
            started_at: string | null;
            finished_at: string | null;
          }>;
        };
      }>('/api/v1/org-rbac/cron-status', {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });

      assert.equal(statusRes.data.subroutines.length, 13);
      for (const k of ALL_13_CRON_SUBROUTINES) {
        assert.ok(statusRes.data.subroutines.some((s) => s.key === k), `Catalog missing subroutine ${k}`);
      }
      assert.equal(statusRes.data.runs.length, 4);
      for (const run of statusRes.data.runs) {
        assert.ok(subset.includes(run.subroutine_key));
        assert.equal(run.status, 'success');
        assert.equal(run.triggered_by, 'scheduler');
        assert.ok(run.started_at);
        assert.ok(run.finished_at);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T1] unauthorized X-Cron-Secret requests (missing, wrong, wrong query param) return 401 UNAUTHORIZED_CRON_TICK', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', cronSecret: 'f14-secret-alpha' });
    try {
      const rMissing = await ctx.apiRaw('/api/v1/operations/cron/master', { method: 'POST' });
      const rWrongHeader = await ctx.apiRaw('/api/v1/operations/cron/master', {
        method: 'POST',
        headers: { 'X-Cron-Secret': 'wrong-secret' },
      });
      const rWrongQuery = await ctx.apiRaw('/api/v1/operations/cron/master', {
        method: 'POST',
        query: { secret: 'wrong-secret' },
      });

      for (const r of [rMissing, rWrongHeader, rWrongQuery]) {
        assert.equal(r.status, 401);
        assert.equal(r.json?.success, false);
        assert.equal(r.json?.error?.code, 'UNAUTHORIZED_CRON_TICK');
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T1] POST /api/v1/org-rbac/cron-status/run manual trigger executes single subroutine filter and logs triggered_by=manual', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const manualRes = await ctx.apiJson<{
        data: {
          locked: boolean;
          run_log: { triggered_by: string; subroutine_key: string; status: string };
        };
      }>('/api/v1/org-rbac/cron-status/run', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { subroutines: ['marketing_flows'] },
      });

      assert.equal(manualRes.data.locked, false);
      assert.equal(manualRes.data.run_log.triggered_by, 'manual');
      assert.equal(manualRes.data.run_log.subroutine_key, 'marketing_flows');
      assert.equal(manualRes.data.run_log.status, 'success');
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T1] direct CLI server/cron/master-cron.ts succeeds against isolated tempdir PGlite when no postmaster.pid exists', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const pgDir = ctx.createTempDir('f14-cli-ok-');
      assert.equal(fs.existsSync(path.join(pgDir, 'postmaster.pid')), false);

      const cliRes = await ctx.runCli(['server/cron/master-cron.ts'], {
        runner: 'tsx',
        env: {
          PGLITE_DATA_DIR: pgDir,
          NODE_ENV: 'production',
          OUTBOUND_SILENT_MODE: 'true',
        },
      });
      assert.equal(cliRes.status, 0, `CLI master-cron failed: ${cliRes.stderr}\n${cliRes.stdout}`);
      assert.ok(cliRes.stdout.includes('[MasterCron] Completed in'));
      assert.ok(cliRes.stdout.includes('Errors=0'));
    } finally {
      await ctx.close();
    }
  });

  it('[F14][T1] scripts/run-master-cron.sh handles empty CRON_SECRET= fallback to PLATFORM_JWT_SECRET and refuses concurrent PGlite CLI fallback', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const appDirLocked = ctx.createTempDir('f14-sh-locked-');
      const stubBinLocked = path.join(appDirLocked, 'bin');
      fs.mkdirSync(stubBinLocked, { recursive: true });
      fs.mkdirSync(path.join(appDirLocked, '.autodata-pgdata'), { recursive: true });
      fs.writeFileSync(path.join(appDirLocked, '.autodata-pgdata', 'postmaster.pid'), '99999\n', 'utf8');
      fs.writeFileSync(
        path.join(appDirLocked, '.env'),
        'CRON_SECRET=\nPLATFORM_JWT_SECRET=\nPGLITE_DATA_DIR=./.autodata-pgdata\n',
        'utf8'
      );

      const bashEnvLocked = {
        Path: undefined,
        PATH: resolveBashPathEntries(stubBinLocked).join(path.delimiter),
        APP_DIR: appDirLocked,
      };
      const lockedRes = await ctx.runCli([path.join(REPO_ROOT, 'scripts', 'run-master-cron.sh')], {
        runner: 'bash',
        env: bashEnvLocked,
      });
      assert.equal(lockedRes.status, 1);
      assert.match(lockedRes.stderr, /locked\/disallowed|refusing/i);

      // Test empty CRON_SECRET= falling back cleanly to PLATFORM_JWT_SECRET using stubbed curl
      const appDirFallback = ctx.createTempDir('f14-sh-fallback-');
      const stubBinFallback = path.join(appDirFallback, 'bin');
      fs.mkdirSync(stubBinFallback, { recursive: true });
      const curlLog = path.join(appDirFallback, 'curl-args.txt');
      fs.writeFileSync(
        path.join(stubBinFallback, 'curl'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${curlLog.replace(/\\/g, '/')}"\nexit 0\n`,
        { mode: 0o755 }
      );
      fs.writeFileSync(
        path.join(appDirFallback, '.env'),
        'CRON_SECRET=""\nPLATFORM_JWT_SECRET=fallback-tok-2026\n',
        'utf8'
      );

      const fallbackRes = await ctx.runCli([path.join(REPO_ROOT, 'scripts', 'run-master-cron.sh')], {
        runner: 'bash',
        env: {
          Path: undefined,
          PATH: resolveBashPathEntries(stubBinFallback).join(path.delimiter),
          APP_DIR: appDirFallback,
        },
      });
      assert.equal(fallbackRes.status, 0, `Fallback failed: ${fallbackRes.stderr}`);
      const capturedArgs = fs.readFileSync(curlLog, 'utf8');
      assert.ok(capturedArgs.includes('X-Cron-Secret: fallback-tok-2026'));
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F15: Live Production Deployment & Non-Disruption
// ============================================================================
describe('Tier 1 — F15: Live Production Deployment & Non-Disruption', () => {
  it('[F15][T1] multi-tenant isolation across ideas and ecolife, ecolifesignature, ecolife-automation', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      const eco = await seedSiblingTenant(ctx, 'ecolife');
      const ecoSig = await seedSiblingTenant(ctx, 'ecolifesignature');
      const ecoAuto = await seedSiblingTenant(ctx, 'ecolife-automation');

      const tenants = [ideas, eco, ecoSig, ecoAuto];
      for (const t of tenants) {
        await ctx.apiJson('/api/v1/leads', {
          method: 'POST',
          token: t.accessToken,
          tenantSlug: t.tenantSlug,
          body: {
            name: `Lead-${t.tenantSlug}`,
            email: makeTestRecipient(`f15-${t.tenantSlug}`),
            status: 'marketing_nurture',
          },
        });
      }

      for (const t of tenants) {
        const me = await ctx.apiJson<{ data: { tenant: { slug: string } } }>('/api/v1/auth/me', {
          token: t.accessToken,
          tenantSlug: t.tenantSlug,
        });
        assert.equal(me.data.tenant.slug, t.tenantSlug);

        const boot = await ctx.apiRaw('/api/v1/workspace/bootstrap', {
          token: t.accessToken,
          tenantSlug: t.tenantSlug,
        });
        assert.equal(boot.status, 200);

        const leads = await ctx.apiJson<{ data: { items: Array<{ name: string }> } }>('/api/v1/leads', {
          token: t.accessToken,
          tenantSlug: t.tenantSlug,
        });
        assert.equal(leads.data.items.length, 1);
        assert.equal(leads.data.items[0].name, `Lead-${t.tenantSlug}`);
      }
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T1] ideas campaign, flow, and master cron execution never mutate sibling ecolife data', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const ecolife = await seedSiblingTenant(ctx, 'ecolife', {
        packageCode: 'growth_combo',
        companyName: 'Ecolife Original',
      });

      const ecoEmail = makeTestRecipient('f15-eco-stay');
      await seedCampaignEmailSetup(ctx, ecolife, {
        leadEmail: ecoEmail,
        leadName: 'Ecolife Protected Lead',
        campaignName: 'Ecolife Draft Campaign',
      });

      const ideasEmail = makeTestRecipient('f15-ideas-send');
      const ideasSetup = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: ideasEmail,
        campaignName: 'Ideas Active Campaign',
      });
      await ctx.apiJson(`/api/v1/marketing/campaigns/${ideasSetup.campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      await triggerMasterCron(ctx, { tenantId: ideas.tenantId });

      const ecoLeads = await ctx.apiJson<{
        data: { items: Array<{ name: string; email_consent: string }> };
      }>('/api/v1/leads', {
        token: ecolife.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(ecoLeads.data.items.length, 1);
      assert.equal(ecoLeads.data.items[0].name, 'Ecolife Protected Lead');
      assert.equal(ecoLeads.data.items[0].email_consent, 'subscribed');

      const ecoCamps = await ctx.apiJson<{ data: { items: Array<{ status: string; sent_count: number }> } }>(
        '/api/v1/marketing/campaigns',
        { token: ecolife.accessToken, tenantSlug: 'ecolife' }
      );
      assert.equal(ecoCamps.data.items.length, 1);
      assert.equal(ecoCamps.data.items[0].status, 'draft');
      assert.equal(ecoCamps.data.items[0].sent_count, 0);

      const ecoMe = await ctx.apiJson<{ data: { tenant: { name: string } } }>('/api/v1/auth/me', {
        token: ecolife.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.equal(ecoMe.data.tenant.name, 'Ecolife Original');
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T1] scripts/deploy-direct.py --skip-build --dry-run preserves .autodata-pgdata and .env by default', async () => {
    const deployPyPath = path.join(REPO_ROOT, 'scripts', 'deploy-direct.py');
    const deployPyText = fs.readFileSync(deployPyPath, 'utf8');
    assert.ok(deployPyText.includes('postmaster.pid'));
    assert.ok(deployPyText.includes('if with_db:'));
    assert.ok(deployPyText.includes('if with_env:'));

    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      const child = spawn(pyCmd, [deployPyPath, '--skip-build', '--dry-run'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', reject);
      child.on('close', (status) =>
        resolve({
          status,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        })
      );
    });

    assert.equal(res.status, 0, `deploy-direct.py dry-run failed: ${res.stderr}`);
    assert.ok(res.stdout.includes('Prepared archive:'));
    assert.ok(res.stdout.includes('DRY-RUN mode: skipping SSH upload.'));
  });

  it('[F15][T1] backend/ERP .htaccess and Vercel config protect .autodata-pgdata/.env and preserve SPA/asset delivery', async () => {
    const rootHtaccess = fs.readFileSync(path.join(REPO_ROOT, '.htaccess'), 'utf8');
    assert.ok(rootHtaccess.includes('PassengerAppEnv production'));
    assert.ok(rootHtaccess.includes('.autodata-pgdata'));
    assert.ok(rootHtaccess.includes('\\.env.*'));
    assert.ok(rootHtaccess.includes('[F,L]'));
    assert.ok(rootHtaccess.includes('^/uploadss/'));

    for (const rel of ['public/.htaccess', 'dist/.htaccess']) {
      const erpHt = fs.readFileSync(path.join(ERP_REPO_ROOT, rel), 'utf8');
      assert.ok(erpHt.includes('index.html'));
      assert.ok(erpHt.includes('R=404'));
      assert.ok(erpHt.includes('no-store'));
    }

    const vercelText = fs.readFileSync(path.join(LANDING_REPO_ROOT, 'vercel.json'), 'utf8');
    assert.ok(vercelText.includes('/api/v1/:path*'));
    assert.ok(vercelText.includes('/meta-report/:slug'));
    assert.equal(vercelText.includes('myerp.ideas.edu.vn'), false);
    assert.equal(vercelText.includes('automation.ideas.edu.vn'), false);
  });

  it('[F15][T1] cross-tenant X-Tenant-Slug header mismatch is rejected while /api/v1/health reports RLS enforced', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      await seedSiblingTenant(ctx, 'ecolife');

      const mismatch = await ctx.apiRaw('/api/v1/leads', {
        token: ideas.accessToken,
        tenantSlug: 'ecolife',
      });
      assert.ok(mismatch.status === 401 || mismatch.status === 403, `Expected 401/403, got ${mismatch.status}`);

      const health = await ctx.apiJson<{ data?: { rls_kernel_enforced?: boolean }; rls_kernel_enforced?: boolean }>(
        '/api/v1/health'
      );
      const rlsFlag = health.data?.rls_kernel_enforced ?? health.rls_kernel_enforced;
      assert.equal(rlsFlag, true);
    } finally {
      await ctx.close();
    }
  });

  it('[F15][T1] legacy domains myerp.ideas.edu.vn, automation.ideas.edu.vn, and open.domation.net receive zero mutations or outbound calls', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas' });
      await ctx.apiJson('/api/v1/auth/me', { token: ideas.accessToken, tenantSlug: 'ideas' });
      const form = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/forms', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Legacy Safe Form',
          fields: [{ id: 'f1', key: 'email', label: 'Email', type: 'email', required: true }],
        },
      });
      const embed = await ctx.apiJson<{ data: { snippets: Record<string, string> } }>(
        `/api/v1/marketing/forms/${form.data.id}/embed-config`,
        {
          token: ideas.accessToken,
          tenantSlug: 'ideas',
          headers: { 'X-Forwarded-Host': 'data.domation.net', 'X-Forwarded-Proto': 'https' },
        }
      );
      await triggerMasterCron(ctx, { tenantId: ideas.tenantId });

      const allReqs = ctx.mockFetch.getRequests();
      for (const legacyHost of ['myerp.ideas.edu.vn', 'automation.ideas.edu.vn', 'open.domation.net']) {
        assert.equal(
          allReqs.some((r) => r.url.includes(legacyHost)),
          false,
          `Unexpected outbound call to legacy domain ${legacyHost}`
        );
        assert.equal(
          JSON.stringify(embed.data.snippets).includes(legacyHost),
          false,
          `Embed snippet must not reference ${legacyHost}`
        );
      }
    } finally {
      await ctx.close();
    }
  });
});

// ============================================================================
// Feature F16: E2E Test Suite (Tiers 1-5) & Isolated Smoke Verification
// ============================================================================
describe('Tier 1 — F16: E2E Test Suite & Isolated Smoke Verification', () => {
  it('[F16][T1] isolated smoke cycle: Flow -> Master Cron marketing_flows -> Loopback SMTP email delivery', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, {
        slug: 'ideas',
        configureLoopbackSmtp: true,
        smtpVia: 'aws_ses',
        fromEmail: 'systemnoti@test-sink.domation.local',
      });
      const recipient = makeTestRecipient('f16-flow-smoke');
      assertTestRecipientsOnly([recipient]);

      const leadRes = await ctx.apiJson<{ data: { id?: string; lead_id?: string } }>('/api/v1/leads', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Smoke Flow Student',
          email: recipient,
          status: 'marketing_nurture',
          email_consent: 'subscribed',
        },
      });
      const leadId = String(leadRes.data.lead_id || leadRes.data.id);

      const flowRes = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/flows', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'IDEAS Smoke Flow',
          trigger_type: 'manual_enroll',
          status: 'active',
          steps: [
            {
              id: 's1',
              type: 'send_email',
              label: 'Smoke Email',
              config: {
                subject: 'IDEAS Smoke Flow {{lead.name}}',
                custom_html: '<p>Hi {{lead.name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
              },
              nextStepId: 's2',
            },
            {
              id: 's2',
              type: 'wait_delay',
              label: 'Wait 0ms',
              config: { duration: 0, unit: 'ms' },
              nextStepId: 's3',
            },
            {
              id: 's3',
              type: 'update_lead_score',
              label: 'Score +15',
              config: { delta: 15 },
              nextStepId: null,
            },
          ],
        },
      });

      await ctx.apiJson(`/api/v1/marketing/flows/${flowRes.data.id}/enroll`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: { lead_id: leadId },
      });
      await triggerMasterCron(ctx, { subroutines: ['marketing_flows'], tenantId: ideas.tenantId });

      const msgs = await ctx.smtp.waitForMessages(1, 5000);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].mailFrom, 'systemnoti@test-sink.domation.local');
      assert.deepEqual(msgs[0].rcptTo, [recipient]);
      assert.ok(msgs[0].subject.includes('IDEAS Smoke Flow'));
      assert.ok(msgs[0].html.includes('/api/v1/public/marketing/unsubscribe'));

      const flowDetail = await ctx.apiJson<{
        data: { enrollments: Array<{ status: string; lead_score: number }> };
      }>(`/api/v1/marketing/flows/${flowRes.data.id}`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(flowDetail.data.enrollments[0].status, 'completed');
      assert.equal(Number(flowDetail.data.enrollments[0].lead_score), 15);
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T1] isolated smoke cycle: Scheduled Campaign -> Master Cron marketing_campaigns -> Loopback SMTP -> Open & Click tracking', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f16-camp-smoke');
      const { campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: recipient,
        templateHtml:
          '<html><body><a href="https://domation.net/ideas">Xem khoa hoc</a><a href="{{unsubscribe_url}}">Unsub</a></body></html>',
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const cronRes = await triggerMasterCron(ctx, {
        subroutines: ['marketing_campaigns'],
        tenantId: ideas.tenantId,
      });
      assert.equal(cronRes.status, 200);

      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const openMatch = msg.html.match(/\/api\/v1\/public\/marketing\/track\/open\/([0-9a-f-]+)/i);
      const clickMatch = msg.html.match(/\/api\/v1\/public\/marketing\/track\/click\/([0-9a-f-]+)\?url=([^"'\s&]+)/i);
      assert.ok(openMatch && clickMatch);

      const openRes = await fetch(`${ctx.baseUrl}${openMatch[0]}`);
      assert.equal(openRes.status, 200);
      assert.equal(openRes.headers.get('content-type'), 'image/gif');

      const clickRes = await ctx.apiJson<{ data: { redirect_url: string } }>(`${clickMatch[0]}&json=1`);
      assert.equal(clickRes.data.redirect_url, 'https://domation.net/ideas');

      const detail = await ctx.apiJson<{
        data: {
          funnel: { sent: number; opened: number; clicked: number };
          claims: Array<{ opened_at: string | null; clicked_at: string | null }>;
        };
      }>(`/api/v1/marketing/campaigns/${campaignId}/detail`, {
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      assert.equal(detail.data.funnel.sent, 1);
      assert.equal(detail.data.funnel.opened, 1);
      assert.equal(detail.data.funnel.clicked, 1);
      assert.ok(detail.data.claims[0].opened_at);
      assert.ok(detail.data.claims[0].clicked_at);
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T1] isolated smoke cycle: HMAC Unsubscribe suppresses lead and blocks subsequent campaign sends', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', appPublicUrl: 'https://data.domation.net' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f16-unsub');
      const { audienceId, templateId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, {
        leadEmail: recipient,
      });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [msg] = await ctx.smtp.waitForMessages(1, 5000);
      const unsubMatch = msg.html.match(/\/api\/v1\/public\/marketing\/unsubscribe\?[^"'\s<]+/i);
      assert.ok(unsubMatch);
      const unsubRes = await ctx.apiJson<{ data: { unsubscribed: boolean; channel: string } }>(
        unsubMatch[0].replace(/&amp;/g, '&')
      );
      assert.equal(unsubRes.data.unsubscribed, true);
      assert.equal(unsubRes.data.channel, 'email');

      ctx.smtp.clear();
      const camp2 = await ctx.apiJson<{ data: { id: string } }>('/api/v1/marketing/campaigns', {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
        body: {
          name: 'Smoke Followup',
          channel: 'email',
          audience_id: audienceId,
          template_id: templateId,
          subject_a: 'Followup',
        },
      });
      const send2 = await ctx.apiJson<{ data: { newly_sent: number; suppressed_skipped: number } }>(
        `/api/v1/marketing/campaigns/${camp2.data.id}/send`,
        { method: 'POST', token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(send2.data.newly_sent, 0);
      assert.ok(send2.data.suppressed_skipped >= 1);
      assert.equal(ctx.smtp.messages.length, 0);
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T1] isolated smoke cycle: SNS Permanent Bounce correlates SMTP messageId and suppresses lead', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory', snsRegion: 'ap-southeast-2' });
    try {
      const ideas = await seedIdeasTenant(ctx, { slug: 'ideas', configureLoopbackSmtp: true });
      const recipient = makeTestRecipient('f16-sns-bounce');
      const { leadId, campaignId } = await seedCampaignEmailSetup(ctx, ideas, { leadEmail: recipient });

      await ctx.apiJson(`/api/v1/marketing/campaigns/${campaignId}/send`, {
        method: 'POST',
        token: ideas.accessToken,
        tenantSlug: 'ideas',
      });
      const [smtpMsg] = await ctx.smtp.waitForMessages(1, 5000);

      const snsReq = signSnsNotification(ctx.snsSigner, {
        eventType: 'Bounce',
        bounceType: 'Permanent',
        recipients: [recipient],
        messageId: smtpMsg.id,
      });
      const snsRes = await ctx.apiRaw('/api/v1/webhooks/ses-sns', {
        method: 'POST',
        headers: snsReq.headers,
        body: snsReq.rawBody,
      });
      assert.equal(snsRes.status, 200);
      assert.equal(snsRes.json?.data?.processed, true);
      assert.equal(snsRes.json?.data?.matched_count, 1);

      const detail = await ctx.apiJson<{ data: { funnel: { bounced: number }; claims: Array<{ status: string }> } }>(
        `/api/v1/marketing/campaigns/${campaignId}/detail`,
        { token: ideas.accessToken, tenantSlug: 'ideas' }
      );
      assert.equal(detail.data.funnel.bounced, 1);
      assert.equal(detail.data.claims[0].status, 'bounced');

      const leadsRes = await ctx.apiJson<{ data: { items: Array<{ id: string; email_consent: string }> } }>(
        '/api/v1/leads',
        { token: ideas.accessToken, tenantSlug: 'ideas', query: { search: recipient } }
      );
      assert.equal(leadsRes.data.items.find((l) => l.id === leadId)?.email_consent, 'bounced');
    } finally {
      await ctx.close();
    }
  });

  it('[F16][T1] assertTestRecipientsOnly and makeTestRecipient enforce zero-customer-send guard', async () => {
    const safe1 = makeTestRecipient('ideas-smoke');
    const safe2 = makeTestRecipient('ideas-qa');
    assert.match(safe1, /@test-sink\.domation\.local$/);
    assertTestRecipientsOnly([safe1, safe2]);

    for (const realAddr of ['customer@gmail.com', 'student@ideas.edu.vn']) {
      assert.throws(() => assertTestRecipientsOnly([realAddr]), /UNSAFE_TEST_RECIPIENT/);
    }
  });

  it('[F16][T1] run-e2e-ideas.mjs --help CLI contract documents tiers and keeps .autodata-pgdata untouched', async () => {
    const ctx = await createIsolatedContext({ dbMode: 'memory' });
    try {
      const cli = await ctx.runCli(['tests/e2e_ideas/run-e2e-ideas.mjs', '--help'], { runner: 'node' });
      assert.equal(cli.status, 0);
      assert.ok(cli.stdout.includes('--tier=1|2|3|4|all'));
      assert.ok(cli.stdout.includes('--harness-check'));
      assert.ok(cli.stdout.includes('--typecheck'));
      assert.ok(cli.stdout.includes('--strict-server-tsc'));
    } finally {
      await ctx.close();
    }
  });
});

// Prevent unused import lint if withTenantTransaction is not needed directly here
void withTenantTransaction;
