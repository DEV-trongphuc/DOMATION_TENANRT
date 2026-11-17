import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Express, Router, RequestHandler } from 'express';
import { orgRbacRouter } from './org-rbac/index.ts';
import { audiencesRouter } from './audiences/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ModuleMountSpec {
  key: string;
  mountPath: string;
  moduleDir: string;
  router?: Router;
}

/**
 * Pluggable Ecosystem Module Registry
 * Wave 1 mounts `/api/v1/org-rbac` and `/api/v1/audiences` directly.
 * Wave 2 parallel module workers (`marketing`, `approvals`, `hrm`, `erp-ops`, `dom-agent`, `education-addon`)
 * can drop an `index.ts` exporting `router` (or `default`) inside `server/modules/<moduleDir>/index.ts`
 * and it is automatically discovered and dispatched at runtime WITHOUT touching `server/app.ts`!
 */
const EXPLICIT_MODULE_ROUTERS = new Map<string, Router>();

export function registerEcosystemModuleRouter(mountPath: string, router: Router): void {
  EXPLICIT_MODULE_ROUTERS.set(mountPath, router);
}

const WAVE2_DYNAMIC_SLOTS: ModuleMountSpec[] = [
  { key: 'marketing', mountPath: '/api/v1/marketing', moduleDir: 'marketing' },
  { key: 'public_marketing', mountPath: '/api/v1/public/marketing', moduleDir: 'marketing-public' },
  { key: 'approvals', mountPath: '/api/v1/approvals', moduleDir: 'approvals' },
  { key: 'hrm', mountPath: '/api/v1/hrm', moduleDir: 'hrm' },
  { key: 'attendance', mountPath: '/api/v1/attendance', moduleDir: 'attendance' },
  { key: 'payroll', mountPath: '/api/v1/payroll', moduleDir: 'payroll' },
  { key: 'erp_ops', mountPath: '/api/v1/erp-ops', moduleDir: 'erp-ops' },
  { key: 'projects', mountPath: '/api/v1/projects', moduleDir: 'projects' },
  { key: 'workchat', mountPath: '/api/v1/workchat', moduleDir: 'workchat' },
  { key: 'finance', mountPath: '/api/v1/finance', moduleDir: 'finance' },
  { key: 'inventory', mountPath: '/api/v1/inventory', moduleDir: 'inventory' },
  { key: 'dom_agent', mountPath: '/api/v1/dom-agent', moduleDir: 'dom-agent' },
  { key: 'education', mountPath: '/api/v1/education', moduleDir: 'education-addon' },
];

function createLazySlotDispatcher(spec: ModuleMountSpec): RequestHandler {
  let cachedRouter: Router | null | undefined;
  let loadingPromise: Promise<Router | null> | null = null;

  return async (req, res, next) => {
    const explicit = EXPLICIT_MODULE_ROUTERS.get(spec.mountPath);
    if (explicit) {
      explicit(req, res, next);
      return;
    }

    if (cachedRouter === undefined) {
      if (!loadingPromise) {
        loadingPromise = (async () => {
          const candidates = [
            path.join(__dirname, spec.moduleDir, 'index.ts'),
            path.join(__dirname, spec.moduleDir, 'index.js'),
          ];
          const found = candidates.find((p) => fs.existsSync(p));
          if (!found) {
            return null;
          }
          const mod = await import(pathToFileURL(found).href);
          return (mod.router || mod.default || null) as Router | null;
        })();
      }
      try {
        cachedRouter = await loadingPromise;
      } catch (err) {
        loadingPromise = null;
        next(err);
        return;
      }
    }

    if (cachedRouter) {
      cachedRouter(req, res, next);
      return;
    }

    next();
  };
}

export function mountEcosystemModules(app: Express): void {
  // Wave 1 Foundation Modules (100% Live)
  app.use('/api/v1/org-rbac', orgRbacRouter);
  app.use('/api/v1/audiences', audiencesRouter);

  // Wave 2 Zero-Conflict Auto-Discovery Slots
  for (const slot of WAVE2_DYNAMIC_SLOTS) {
    app.use(slot.mountPath, createLazySlotDispatcher(slot));
  }
}
