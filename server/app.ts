import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import cors from 'cors';
import { APP_CONFIG } from './config.ts';
import { executeMasterCron } from './cron/master-cron.ts';
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
import { mountEcosystemModules } from './modules/index.ts';
import { requireTenantAuth, requireRoles, sendApiError } from './core/security/rbac.ts';
import { getTenantContext } from './core/context/tenant-context.ts';
import { replayWebhookDlqItem } from './services/webhook.service.ts';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    cors({
      origin: true,
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Tenant-Slug',
        'X-Webhook-Signature',
        'X-Idempotency-Key',
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
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/pipelines', pipelinesRouter);
  app.use('/api/v1/leads', leadsRouter);
  app.use('/api/v1/integrations', integrationsRouter);
  app.use('/api/v1/billing', billingRouter);
  app.use('/api/v1/workspace', workspaceRouter);
  app.use('/api/v1/analytics', analyticsRouter);
  app.use('/api/v1/public', publicRouter);

  // Pluggable Multi-Product SaaS Ecosystem Modules (Org-RBAC, Audiences, + Wave 2 Slots)
  mountEcosystemModules(app);

  // Internal Master Cron HTTP endpoint (runs consolidated 6 subroutines inside live Passenger/PGlite process)
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
      const result = await executeMasterCron();
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
  app.post('/api/v1/webhooks/dlq/:id/replay', requireTenantAuth, requireRoles('tenant_admin'), async (req, res) => {
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
