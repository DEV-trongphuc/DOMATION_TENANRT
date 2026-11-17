import { AsyncLocalStorage } from 'node:async_hooks';

export type TenantRole = 'tenant_admin' | 'manager' | 'sale' | (string & {});
export type PlanTier =
  | 'starter'
  | 'growth'
  | 'enterprise'
  | 'autodata_crm'
  | 'marketing_standalone'
  | 'growth_combo'
  | 'domation_promax';

export interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  userEmail?: string;
  userName?: string;
  userRole: TenantRole;
  isExternalAgency: boolean;
  isTenantOwner?: boolean;
  roleId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  planTier: PlanTier;
  impersonatedBySuperAdminId?: string;
}

export interface PlatformAdminContext {
  adminId: string;
  email: string;
  fullName: string;
  role: 'super_admin';
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();
export const platformStorage = new AsyncLocalStorage<PlatformAdminContext>();

export function getTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx || !ctx.tenantId) {
    throw new Error('TENANT_CONTEXT_MISSING_FATAL: Operation executed outside of scoped tenant lifecycle');
  }
  return ctx;
}

export function tryGetTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore();
}

export function getPlatformContext(): PlatformAdminContext {
  const ctx = platformStorage.getStore();
  if (!ctx || ctx.role !== 'super_admin') {
    throw new Error('PLATFORM_CONTEXT_MISSING_FATAL: Operation executed outside of platform superadmin context');
  }
  return ctx;
}
