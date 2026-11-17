import { getTenantContext, type TenantContext } from '../context/tenant-context.ts';

export interface QueryCriteria {
  where?: Record<string, unknown>;
  params?: unknown[];
  [key: string]: unknown;
}

/**
 * Layer 3 Concrete Implementation: Application Repository Query Decorator
 * Strictly injects `tenant_id` filters and verifies active TenantContext.
 */
export function applyTenantFilter<T extends QueryCriteria>(criteria: T, explicitCtx?: TenantContext): T {
  const ctx = explicitCtx || getTenantContext();
  if (!ctx || !ctx.tenantId) {
    throw new Error('TENANT_CONTEXT_MISSING_ERROR: Query decorator invoked outside of active TenantContext');
  }

  return {
    ...criteria,
    where: {
      ...(criteria.where || {}),
      tenant_id: ctx.tenantId,
    },
  };
}

/**
 * Lead Repository Decorator: Enforces RBAC Op 13 / Op 14 / Op 15 query boundaries
 */
export function buildScopedLeadWhereClause(
  ctx: TenantContext,
  startParamIndex = 1
): { clause: string; values: unknown[]; nextIndex: number } {
  const pTenant = `$${startParamIndex}`;
  if (ctx.userRole === 'sale') {
    const pUser = `$${startParamIndex + 1}`;
    return {
      clause: `leads.tenant_id = ${pTenant} AND leads.assigned_to = ${pUser}`,
      values: [ctx.tenantId, ctx.userId],
      nextIndex: startParamIndex + 2,
    };
  }

  if (ctx.userRole === 'manager') {
    return {
      clause: `leads.tenant_id = ${pTenant} AND (
        leads.assigned_to IS NULL OR
        leads.assigned_to = $${startParamIndex + 1} OR
        leads.assigned_to IN (
          SELECT rc.user_id FROM round_consultants rc
          INNER JOIN distribution_rounds dr ON dr.id = rc.round_id AND dr.tenant_id = ${pTenant}
          WHERE dr.tenant_id = ${pTenant}
        )
      )`,
      values: [ctx.tenantId, ctx.userId],
      nextIndex: startParamIndex + 2,
    };
  }

  // Tenant Admin views all tenant leads (Op 13)
  return {
    clause: `leads.tenant_id = ${pTenant}`,
    values: [ctx.tenantId],
    nextIndex: startParamIndex + 1,
  };
}
