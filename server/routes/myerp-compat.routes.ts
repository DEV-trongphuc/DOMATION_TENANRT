/**
 * MYERP Compatibility API — `/api/v1/myerp/*`
 *
 * Bridges every REST endpoint used by the cloned MYERP frontend
 * (`DOMATION_LANDINGPAGE/src/components/autodata/cloned/{pages,components,store}`) onto the
 * AutoData PostgreSQL schema and the Wave-2 ecosystem modules.
 *
 * Pipeline: methodOverride (`_method`) → authenticate (JWT + tenant ALS) → domain sub-routers → fallback.
 * Domain sub-routers live in `./myerp-compat/*.ts` and must only use `requirePermission`/`requireAnyPermission`
 * (never role hardcodes), `withTenantTransaction` (RLS) and `pii-masker` for phone/email exposure.
 */
import { Router } from 'express';
import { authenticate, fail, methodOverride, ok } from './myerp-compat/shared.ts';
import { crmCompatRouter } from './myerp-compat/crm.ts';
import { workspaceCompatRouter } from './myerp-compat/workspace.ts';
import { financeCompatRouter } from './myerp-compat/finance.ts';
import { hrCompatRouter } from './myerp-compat/hr.ts';
import { socialCompatRouter } from './myerp-compat/social.ts';
import { marketingCompatRouter } from './myerp-compat/marketing-config.ts';

export const myerpCompatRouter = Router();

myerpCompatRouter.use(methodOverride);

// Unauthenticated liveness probe for the compat layer (no tenant data).
myerpCompatRouter.get('/_health', (_req, res) => {
  ok(res, { service: 'myerp-compat', version: 1 });
});

myerpCompatRouter.use(authenticate);

myerpCompatRouter.use(crmCompatRouter);
myerpCompatRouter.use(workspaceCompatRouter);
myerpCompatRouter.use(financeCompatRouter);
myerpCompatRouter.use(hrCompatRouter);
myerpCompatRouter.use(socialCompatRouter);
myerpCompatRouter.use(marketingCompatRouter);

/**
 * Fallback for MYERP endpoints that have no AutoData equivalent yet:
 * - reads return an empty, well-formed MYERP list payload (keeps the cloned UI rendering instead of crashing),
 * - writes return HTTP 501 so the UI surfaces a clear "not supported" toast instead of silently "saving".
 */
myerpCompatRouter.use((req, res) => {
  res.setHeader('X-MyERP-Compat', 'unmapped');
  if (req.method === 'GET' || req.method === 'HEAD') {
    ok(res, { items: [], total: 0, page: 1, limit: 0 });
    return;
  }
  fail(
    res,
    501,
    'MYERP_COMPAT_NOT_IMPLEMENTED',
    `Endpoint ${req.method} ${req.originalUrl} chưa được hỗ trợ trên nền tảng DOMATION.`
  );
});
