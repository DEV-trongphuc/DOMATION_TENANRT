import { Router } from 'express';
import { requireTenantAuth } from '../../core/security/rbac.ts';
import { ensureCrm360Schema } from './schema.ts';
import { contacts360Router } from './contacts-360.routes.ts';
import { dealsCompaniesRouter } from './deals-companies.routes.ts';
import { activitiesWorkspaceRouter } from './activities-workspace.routes.ts';

export const crm360Router = Router();

crm360Router.use(requireTenantAuth);
crm360Router.use(async (_req, _res, next) => {
  try {
    await ensureCrm360Schema();
    next();
  } catch (err) {
    next(err);
  }
});

crm360Router.use(contacts360Router);
crm360Router.use(dealsCompaniesRouter);
crm360Router.use(activitiesWorkspaceRouter);

export const router = crm360Router;
export default crm360Router;
