import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cors from 'cors';
import { APP_CONFIG } from './config.ts';
import { executeMasterCron } from './cron/master-cron.ts';
import {
  antiAgentGuardMiddleware,
  applyCommercialIpHeaders,
  DOMATION_AI_TXT_BODY,
  DOMATION_LICENSE_POLICY_TXT,
  DOMATION_LLMS_TXT_BODY,
  DOMATION_ROBOTS_TXT_BODY,
  DOMATION_SECURITY_TXT_BODY,
  DOMATION_TDMREP_JSON,
} from './middleware/anti-agent-guard.ts';
import { gzipMiddleware } from './middleware/gzip.ts';
import { authRouter } from './routes/auth.routes.ts';
import { adminRouter } from './routes/admin.routes.ts';
import { usersRouter } from './routes/users.routes.ts';
import { pipelinesRouter } from './routes/pipelines.routes.ts';
import { leadsRouter } from './routes/leads.routes.ts';
import { integrationsRouter, publicWebhooksRouter } from './routes/integrations.routes.ts';
import { billingRouter } from './routes/billing.routes.ts';
import { workspaceRouter, analyticsRouter } from './routes/workspace.routes.ts';
import { operationsRouter } from './routes/operations.routes.ts';
import { publicRouter } from './routes/public.routes.ts';
import { legacyRouter } from './routes/legacy.routes.ts';
import { myerpCompatRouter } from './routes/myerp-compat.routes.ts';
import { publicMarketingPhpCompatRouter } from './routes/myerp-compat/marketing-php-bridges.ts';
import { mountEcosystemModules } from './modules/index.ts';
import { domAiPortalRouter, publicDomAiPortalRouter } from './modules/dom-ai-portal/index.ts';
import { ensureRbacScreenColumns, requireAnyPermission, requireTenantAuth, sendApiError } from './core/security/rbac.ts';
import { getTenantContext } from './core/context/tenant-context.ts';
import { replayWebhookDlqItem } from './services/webhook.service.ts';
import { ensureZnsDispatcherRegistered } from './services/zalo-zns.service.ts';

export function createApp(): Express {
  ensureZnsDispatcherRegistered();
  const app = express();
  app.disable('x-powered-by');

  // Commercial IP policy headers + internal-route Anti-Agent Guard (never blocks public SEO/GEO search bots)
  app.use(antiAgentGuardMiddleware);

  // Authoritative Soft Commercial Copyright, W3C TDM Reservation & AI Agent Policy endpoints (ZERO bot blocking)
  app.get('/.well-known/tdmrep.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(DOMATION_TDMREP_JSON);
  });

  app.get('/.well-known/security.txt', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(DOMATION_SECURITY_TXT_BODY);
  });

  app.get('/ai.txt', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(DOMATION_AI_TXT_BODY);
  });

  app.get('/license-policy.txt', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(DOMATION_LICENSE_POLICY_TXT);
  });

  app.get(['/llms.txt', '/llms-full.txt'], (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(DOMATION_LLMS_TXT_BODY);
  });

  app.get('/robots.txt', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(DOMATION_ROBOTS_TXT_BODY);
  });

  app.use(
    cors({
      origin: true,
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Tenant-Slug',
        'X-Portal-Token',
        'X-Visitor-Id',
        'X-Webhook-Signature',
        'X-Idempotency-Key',
        'X-Auth-Token',
        'X-HTTP-Method-Override',
        'X-Bypass-Cache',
        'X-Test-Enforce-Rate-Limit',
      ],
    })
  );

  // High-concurrency async libuv-threadpool Gzip compression for API payloads > 1KB (MAX_INFLIGHT_GZIP = 128)
  app.use(gzipMiddleware);

  // Preserve zero-copy raw Buffer reference for cryptographic HMAC-SHA256 webhook verification
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // Translate legacy /api/autodata?action=... bridge URLs natively when frontend hits data.domation.net directly
  const autodataActionRouteMap: Record<string, string> = {
    bootstrap: '/api/v1/billing/bootstrap-public',
    health: '/api/v1/health',
    'check-slug': '/api/v1/auth/check-slug',
    register: '/api/v1/auth/register',
    login: '/api/v1/auth/login',
    google: '/api/v1/auth/google',
    'google-login': '/api/v1/auth/google-login',
    'google-create-workspace': '/api/v1/auth/google-create-workspace',
    'switch-workspace': '/api/v1/auth/switch-workspace',
    'create-workspace': '/api/v1/auth/create-workspace',
    'workspace-overview': '/api/v1/workspace/bootstrap',
    topup: '/api/v1/billing/topup',
    subscribe: '/api/v1/billing/subscribe',
    renew: '/api/v1/billing/renew',
    cancel: '/api/v1/billing/cancel',
    'auto-renew': '/api/v1/billing/auto-renew',
    'switch-package': '/api/v1/billing/switch-package',
    'billing-overview': '/api/v1/billing/overview',
    billing_overview: '/api/v1/billing/overview',
    'billing-catalog': '/api/v1/billing/catalog',
    'upgrade-request': '/api/v1/billing/upgrade-request',
    'personal-lead': '/api/v1/leads/personal',
    'telegram-config': '/api/v1/integrations/telegram/config',
    'telegram-test': '/api/v1/integrations/telegram/test',
    'zalo-updates': '/api/v1/integrations/zalo/updates',
    'zalo-verify': '/api/v1/integrations/zalo/verify',
    'webhook-test': '/api/v1/leads/quick-test',
    consultation: '/api/v1/public/consultation',
  };
  app.use((req, _res, next) => {
    if (req.path !== '/api/autodata') {
      next();
      return;
    }
    const parsed = new URL(req.originalUrl || req.url, 'http://localhost');
    const action = (parsed.searchParams.get('action') || '').trim();
    if (action) {
      const extra = new URLSearchParams(parsed.searchParams);
      extra.delete('action');
      const mapped = autodataActionRouteMap[action];
      const qs = extra.toString();
      req.url = mapped
        ? `${mapped}${qs ? `?${qs}` : ''}`
        : `/api/v1/legacy?action=${encodeURIComponent(action)}${qs ? `&${qs}` : ''}`;
    }
    next();
  });

  app.get('/api/v1/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        service: 'Auto Data Multi-Tenant SaaS Engine',
        version: '1.0.0',
        rls_kernel_enforced: true,
        capi_version: 'v21.0',
        uptime_seconds: Math.round(process.uptime()),
      },
    });
  });

  // Core API v1 routes
  app.use('/api/v1', async (_req, _res, next) => {
    try {
      await ensureRbacScreenColumns();
    } catch {
      // Non-fatal fallback; per-route middleware also guards schema initialization
    }
    next();
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/pipelines', pipelinesRouter);
  app.use('/api/v1/leads', leadsRouter);
  app.use('/api/v1/integrations', integrationsRouter);
  app.use('/api/v1/billing', billingRouter);
  app.use('/api/v1/workspace', workspaceRouter);
  app.use('/api/v1/analytics', analyticsRouter);
  app.use('/api/v1/public/dom-ai', publicDomAiPortalRouter);
  app.use('/api/v1/dom-ai-portal', domAiPortalRouter);
  app.use('/api/v1/public', publicRouter);

  // MYERP Compatibility API for the cloned MYERP frontend (bridges onto AutoData PG schema + Wave-2 modules)
  app.use('/api/v1/myerp', myerpCompatRouter);
  app.use('/backend', myerpCompatRouter);

  // Pluggable Multi-Product SaaS Ecosystem Modules (Org-RBAC, Audiences, + Wave 2 Slots)
  mountEcosystemModules(app);

  // Internal Master Cron HTTP endpoint (runs consolidated 13 subroutines inside live Passenger/PGlite process)
  let cronTickInFlight = false;
  app.all('/api/v1/operations/cron/master', async (req, res) => {
    const expectedSecret = (APP_CONFIG.cronSecret || APP_CONFIG.platformJwtSecret || '').trim();
    const provided = String(req.headers['x-cron-secret'] || req.query?.secret || '').trim();
    const expectedBuf = Buffer.from(expectedSecret);
    const providedBuf = Buffer.from(provided);
    const authorized =
      expectedBuf.length > 0 &&
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!authorized) {
      sendApiError(res, 401, 'UNAUTHORIZED_CRON_TICK', 'Invalid or missing cron secret.');
      return;
    }

    if (cronTickInFlight) {
      res.json({ success: true, data: { skipped: true, reason: 'already_running' } });
      return;
    }

    cronTickInFlight = true;
    try {
      const rawSubs = Array.isArray(req.body?.subroutines)
        ? req.body.subroutines
        : typeof req.query?.subroutines === 'string'
          ? req.query.subroutines
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
      const rawTenantId = req.body?.tenant_id ?? req.body?.tenantId ?? req.query?.tenant_id ?? req.query?.tenantId;
      const tenantId = typeof rawTenantId === 'string' ? rawTenantId.trim() || undefined : undefined;
      const result = await executeMasterCron({
        ...(rawSubs && rawSubs.length > 0 ? { subroutines: rawSubs.map(String) } : {}),
        ...(tenantId ? { tenantId } : {}),
      });
      res.json({ success: true, data: result });
    } catch (err: any) {
      sendApiError(res, 500, 'CRON_EXECUTION_FAILED', err?.message || 'Master cron failed.');
    } finally {
      cronTickInFlight = false;
    }
  });

  app.use('/api/v1/operations', operationsRouter);
  app.use('/api/v1/legacy', legacyRouter);

  // Direct DLQ replay alias matching OpenAPI spec (`POST /api/v1/webhooks/dlq/:id/replay`)
  app.post(
    '/api/v1/webhooks/dlq/:id/replay',
    requireTenantAuth,
    requireAnyPermission([['integrations_crm', 'manage_config'], ['integrations_marketing', 'manage_config'], ['settings', 'manage_config']]),
    async (req, res) => {
    try {
      const ctx = getTenantContext();
      const outcome = await replayWebhookDlqItem(ctx.tenantId, req.params.id);
      res.json({
        success: true,
        message: 'DLQ event re-enqueued for outbound delivery attempt.',
        data: outcome,
      });
    } catch (err: any) {
      sendApiError(res, 500, 'REPLAY_DLQ_FAILED', err?.message || 'Failed to replay DLQ item.');
    }
  });

  // Public high-throughput webhook ingress mounted on both `/api/v1/webhooks` and `/v1/webhooks`
  app.use('/api/v1/webhooks', publicWebhooksRouter);
  app.use('/v1/webhooks', publicWebhooksRouter);

  // Legacy migrated media assets (/uploadss/*) served unconditionally before SPA fallback
  app.use('/uploadss', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }
    const rawUrlPath = String(req.url || '/').split('?')[0];
    if (
      /%2e/i.test(rawUrlPath) ||
      rawUrlPath.includes('..') ||
      rawUrlPath.includes('\\') ||
      rawUrlPath.includes('\0')
    ) {
      res.status(403).end();
      return;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(req.path || '/');
    } catch {
      res.status(400).end();
      return;
    }
    if (decodedPath.includes('..') || decodedPath.includes('\\') || decodedPath.includes('\0')) {
      res.status(403).end();
      return;
    }
    const relPath = decodedPath.replace(/^\/+/, '');
    if (!relPath) {
      res.status(404).end();
      return;
    }
    const candidateRoots = [
      process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : '',
      path.resolve(process.cwd(), 'public', 'uploadss'),
      path.resolve(process.cwd(), 'uploadss'),
    ].filter(Boolean);

    for (const rootDir of candidateRoots) {
      try {
        if (!fs.existsSync(rootDir)) continue;
        const realRoot = fs.realpathSync(rootDir);
        const resolved = path.resolve(realRoot, relPath);
        if (!resolved.startsWith(realRoot + path.sep)) {
          res.status(403).end();
          return;
        }
        if (!fs.existsSync(resolved)) continue;
        const realFile = fs.realpathSync(resolved);
        if (!realFile.startsWith(realRoot + path.sep)) {
          res.status(403).end();
          return;
        }
        const stat = fs.statSync(realFile);
        if (!stat.isFile()) continue;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.sendFile(realFile);
        return;
      } catch {
        continue;
      }
    }
    res.status(404).end();
  });

  // Public migrated media & template thumbnails (/uploads/*) served read-only before SPA fallback
  app.use('/uploads', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }
    const rawReqPath = (req.path || '').replace(/^\/+/, '');
    let decodedPath = '';
    try {
      decodedPath = decodeURIComponent(rawReqPath);
    } catch {
      res.status(400).end();
      return;
    }
    if (
      !decodedPath ||
      rawReqPath.includes('..') ||
      decodedPath.includes('..') ||
      decodedPath.includes('\\') ||
      decodedPath.includes('\0')
    ) {
      res.status(400).end();
      return;
    }
    const uploadRoots = [
      process.env.UPLOADS_PUBLIC_DIR ? path.resolve(process.env.UPLOADS_PUBLIC_DIR) : '',
      path.resolve(process.cwd(), 'public', 'uploads'),
      path.resolve(process.cwd(), 'uploads'),
    ].filter(Boolean);
    for (const root of uploadRoots) {
      try {
        if (!fs.existsSync(root)) continue;
        const rootReal = fs.realpathSync(root);
        const candidate = path.resolve(rootReal, decodedPath);
        if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) continue;
        const resolved = fs.realpathSync(candidate);
        if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) continue;
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) continue;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.sendFile(resolved);
        return;
      } catch {
        continue;
      }
    }
    res.status(404).end();
  });

  const distDir = path.resolve(process.cwd(), 'dist');
  const distDataHtml = path.join(distDir, 'data', 'index.html');
  const distRootHtml = path.join(distDir, 'index.html');
  const serveSpaHtml = process.env.SERVE_SPA !== 'false' && (fs.existsSync(distDataHtml) || fs.existsSync(distRootHtml));

  if (serveSpaHtml) {
    app.use(
      express.static(distDir, {
        index: false,
        redirect: false,
        maxAge: '1h',
        setHeaders(res, filePath) {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            applyCommercialIpHeaders(res, 'internal_asset');
          }
        },
      })
    );
  }

  const sendHtmlNoCache = (res: express.Response, htmlFilePath: string) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(htmlFilePath);
  };

  // Headless Backend Kernel Root Status (or serve SPA HTML when browser visits data.domation.net)
  app.get('/', (req, res) => {
    const accept = String(req.headers.accept || '');
    if (serveSpaHtml && accept.includes('text/html')) {
      sendHtmlNoCache(res, fs.existsSync(distDataHtml) ? distDataHtml : distRootHtml);
      return;
    }
    res.json({
      success: true,
      service: 'DOMATION AutoData Backend Kernel',
      mode: 'headless_api_and_cron',
      version: '2.0.0',
      health: '/api/v1/health',
    });
  });

  // Public MYERP .php aliases when frontends post directly to /api/*.php
  app.all(['/api/voucher_claim.php', '/api/survey_public.php', '/api/surveys.php', '/api/track.php'], (req, res, next) => {
    const subPath = req.path.replace(/^\/api/, '');
    req.url = req.url.replace(/^\/api/, '') || subPath;
    publicMarketingPhpCompatRouter(req, res, next);
  });

  // Structured JSON 404 handler for unmatched API / Webhook routes
  app.use('/api', (req, res) => {
    sendApiError(res, 404, 'ENDPOINT_NOT_FOUND', `Route ${req.method} ${req.originalUrl} does not exist.`);
  });
  app.use('/v1', (req, res) => {
    sendApiError(res, 404, 'ENDPOINT_NOT_FOUND', `Route ${req.method} ${req.originalUrl} does not exist.`);
  });

  if (serveSpaHtml) {
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/api' || req.path.startsWith('/v1/') || req.path === '/v1') {
        next();
        return;
      }
      if (path.extname(req.path)) {
        res.status(404).end();
        return;
      }
      const accept = String(req.headers.accept || '');
      if (accept.includes('text/html') || accept.includes('*/*') || !accept) {
        const cleanRel = req.path.replace(/^\/+|\/+$/g, '');
        if (cleanRel) {
          const candidate = path.resolve(distDir, cleanRel, 'index.html');
          if (candidate.startsWith(distDir + path.sep) && fs.existsSync(candidate)) {
            sendHtmlNoCache(res, candidate);
            return;
          }
        }
        sendHtmlNoCache(res, fs.existsSync(distDataHtml) ? distDataHtml : distRootHtml);
        return;
      }
      next();
    });
  }

  return app;
}
