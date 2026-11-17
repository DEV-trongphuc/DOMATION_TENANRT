import type { Express, Router, RequestHandler } from 'express';
import { orgRbacRouter } from './org-rbac/index.ts';
import { audiencesRouter } from './audiences/index.ts';
import { router as marketingRouter } from './marketing/index.ts';
import { router as publicMarketingRouter } from './marketing-public/index.ts';
import { router as approvalsRouter } from './approvals/index.ts';
import { router as hrmRouter } from './hrm/index.ts';
import { router as attendanceRouter } from './attendance/index.ts';
import { router as payrollRouter } from './payroll/index.ts';
import { router as erpOpsRouter } from './erp-ops/index.ts';
import { router as projectsRouter } from './projects/index.ts';
import { router as workchatRouter } from './workchat/index.ts';
import { router as financeRouter } from './finance/index.ts';
import { router as inventoryRouter } from './inventory/index.ts';
import { router as domAgentRouter } from './dom-agent/index.ts';
import { router as educationRouter } from './education-addon/index.ts';
import { router as crm360Router } from './crm-360/index.ts';

export interface ModuleMountSpec {
  key: string;
  mountPath: string;
  moduleDir: string;
  router: Router;
}

/**
 * Pluggable Ecosystem Module Registry
 * Static imports guarantee both esbuild production bundles (`dist-server/index.mjs`)
 * and Event Bus listeners (flows, stage-to-task automation) initialize immediately on boot.
 */
const EXPLICIT_MODULE_ROUTERS = new Map<string, Router>();

export function registerEcosystemModuleRouter(mountPath: string, router: Router): void {
  EXPLICIT_MODULE_ROUTERS.set(mountPath, router);
}

const WAVE2_STATIC_SLOTS: ModuleMountSpec[] = [
  { key: 'marketing', mountPath: '/api/v1/marketing', moduleDir: 'marketing', router: marketingRouter },
  { key: 'public_marketing', mountPath: '/api/v1/public/marketing', moduleDir: 'marketing-public', router: publicMarketingRouter },
  { key: 'approvals', mountPath: '/api/v1/approvals', moduleDir: 'approvals', router: approvalsRouter },
  { key: 'hrm', mountPath: '/api/v1/hrm', moduleDir: 'hrm', router: hrmRouter },
  { key: 'attendance', mountPath: '/api/v1/attendance', moduleDir: 'attendance', router: attendanceRouter },
  { key: 'payroll', mountPath: '/api/v1/payroll', moduleDir: 'payroll', router: payrollRouter },
  { key: 'erp_ops', mountPath: '/api/v1/erp-ops', moduleDir: 'erp-ops', router: erpOpsRouter },
  { key: 'projects', mountPath: '/api/v1/projects', moduleDir: 'projects', router: projectsRouter },
  { key: 'workchat', mountPath: '/api/v1/workchat', moduleDir: 'workchat', router: workchatRouter },
  { key: 'finance', mountPath: '/api/v1/finance', moduleDir: 'finance', router: financeRouter },
  { key: 'inventory', mountPath: '/api/v1/inventory', moduleDir: 'inventory', router: inventoryRouter },
  { key: 'dom_agent', mountPath: '/api/v1/dom-agent', moduleDir: 'dom-agent', router: domAgentRouter },
  { key: 'education', mountPath: '/api/v1/education', moduleDir: 'education-addon', router: educationRouter },
  { key: 'crm_360', mountPath: '/api/v1/crm-360', moduleDir: 'crm-360', router: crm360Router },
];

function createSlotDispatcher(spec: ModuleMountSpec): RequestHandler {
  return (req, res, next) => {
    const targetRouter = EXPLICIT_MODULE_ROUTERS.get(spec.mountPath) || spec.router;
    targetRouter(req, res, next);
  };
}

export function mountEcosystemModules(app: Express): void {
  // Wave 1 Foundation Modules (100% Live)
  app.use('/api/v1/org-rbac', orgRbacRouter);
  app.use('/api/v1/audiences', audiencesRouter);

  // Wave 2 Ecosystem Modules (bundled statically + overridable for tests)
  for (const slot of WAVE2_STATIC_SLOTS) {
    app.use(slot.mountPath, createSlotDispatcher(slot));
  }
}
