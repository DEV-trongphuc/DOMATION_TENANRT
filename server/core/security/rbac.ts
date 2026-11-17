import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  tenantStorage,
  platformStorage,
  getTenantContext,
  type TenantRole,
} from '../context/tenant-context.ts';
import { verifyTenantAccessToken, verifyPlatformAccessToken } from '../crypto/jwt.ts';
import { tenantRedis } from '../cache/tenant-redis.ts';
import { getTenantMetaCached } from '../settings/tenant-cache.ts';
import { withTenantTransaction } from '../database/transaction.ts';
import type { DbClient } from '../database/db-adapter.ts';
import {
  SAAS_MODULES_CATALOG,
  getAliasesForModuleKey,
  normalizeCanonicalModuleKey,
  resolveTenantEntitlementSnapshot,
  type SaasModuleKey,
} from './entitlements.ts';

// ============================================================================
// 7-Tier Data Scopes × 11 Granular Actions Catalog
// ============================================================================
export const DATA_SCOPES_ORDERED = [
  'none',
  'own',
  'team',
  'department',
  'sub_departments',
  'branch',
  'company',
] as const;

export type DataScope = (typeof DATA_SCOPES_ORDERED)[number];

export const GRANULAR_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'assign',
  'export',
  'import',
  'unmask_phone',
  'view_financials',
  'manage_config',
] as const;

export type GranularAction = (typeof GRANULAR_ACTIONS)[number];

export type ActionPermissionMap = Record<GranularAction, boolean>;

export interface ModuleEffectivePermission {
  module_key: string;
  scope: DataScope;
  data_scope: DataScope;
  actions: ActionPermissionMap;
}

export type EffectivePermissionsMatrix = Record<string, ModuleEffectivePermission>;

export interface UserOrgAuthSnapshot {
  user_id: string;
  role: string;
  role_id: string | null;
  branch_id: string | null;
  department_id: string | null;
  team_id: string | null;
  position_id: string | null;
  reports_to_user_id: string | null;
  is_tenant_owner: boolean;
  is_external_agency: boolean;
  is_system_bot: boolean;
}

const SCOPE_RANK: Record<DataScope, number> = {
  none: 0,
  own: 1,
  team: 2,
  department: 3,
  sub_departments: 4,
  branch: 5,
  company: 6,
};

export function normalizeDataScope(raw: unknown, fallback: DataScope = 'none'): DataScope {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'all') return 'company';
  if ((DATA_SCOPES_ORDERED as readonly string[]).includes(s)) {
    return s as DataScope;
  }
  return fallback;
}

export function maxDataScope(a: DataScope, b: DataScope): DataScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

export function minDataScope(a: DataScope, b: DataScope): DataScope {
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
}

export function buildEmptyActions(defaultVal = false): ActionPermissionMap {
  return {
    view: defaultVal,
    create: defaultVal,
    edit: defaultVal,
    delete: defaultVal,
    approve: defaultVal,
    assign: defaultVal,
    export: defaultVal,
    import: defaultVal,
    unmask_phone: defaultVal,
    view_financials: defaultVal,
    manage_config: defaultVal,
  };
}

export function normalizeActionsMap(
  raw: unknown,
  fallback: Partial<ActionPermissionMap> = {}
): ActionPermissionMap {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = buildEmptyActions(false);
  for (const act of GRANULAR_ACTIONS) {
    if (obj[act] !== undefined) {
      out[act] = Boolean(obj[act]);
    } else if (fallback[act] !== undefined) {
      out[act] = Boolean(fallback[act]);
    }
  }
  return out;
}

/**
 * Default system role template ONLY used when seeding initial `tenant_role_permissions`
 * or when a tenant has not yet customized a role's permission row in PostgreSQL/MariaDB.
 * Once saved in `tenant_role_permissions`, DB values override 100% with ZERO short-circuiting!
 */
export function buildDefaultSystemRoleModulePermission(
  roleKey: string,
  moduleKey: string,
  options?: {
    isExternalAgency?: boolean;
    allowManagerExportCsv?: boolean;
    allowManagerManagePipelines?: boolean;
    allowSaleCreateLead?: boolean;
    allowSaleReassignLead?: boolean;
    piiMaskAllSales?: boolean;
  }
): { data_scope: DataScope; actions: ActionPermissionMap } {
  const r = String(roleKey || 'sale').trim().toLowerCase();
  if (r === 'tenant_admin' || r === 'owner' || r === 'admin') {
    return {
      data_scope: 'company',
      actions: buildEmptyActions(true),
    };
  }

  if (r === 'manager') {
    const adminOnlyModules = new Set(['billing', 'org_rbac', 'integrations_crm', 'integrations_marketing']);
    if (adminOnlyModules.has(moduleKey)) {
      return {
        data_scope: moduleKey === 'org_rbac' ? 'department' : 'none',
        actions: {
          ...buildEmptyActions(false),
          view: moduleKey === 'org_rbac',
        },
      };
    }
    return {
      data_scope: 'department',
      actions: {
        view: true,
        create: true,
        edit: true,
        delete: false,
        approve: true,
        assign: true,
        export: Boolean(options?.allowManagerExportCsv ?? true),
        import: true,
        unmask_phone: true,
        view_financials: moduleKey !== 'payroll',
        manage_config: moduleKey === 'pipelines' ? Boolean(options?.allowManagerManagePipelines) : false,
      },
    };
  }

  // Default for `sale` / general staff
  const saleVisibleModules = new Set([
    'leads',
    'dashboard_crm',
    'pipelines',
    'sale_portal',
    'tickets_data',
    'appointments',
    'audiences',
    'workspace_personal',
    'projects',
    'workchat',
    'enterprise_feed',
    'attendance',
    'dom_sales_copilot',
  ]);

  if (!saleVisibleModules.has(moduleKey)) {
    return {
      data_scope: 'none',
      actions: buildEmptyActions(false),
    };
  }

  const canUnmask = !options?.isExternalAgency && !options?.piiMaskAllSales;
  return {
    data_scope: 'own',
    actions: {
      view: true,
      create: moduleKey === 'leads' ? Boolean(options?.allowSaleCreateLead) : moduleKey !== 'pipelines',
      edit: moduleKey !== 'pipelines',
      delete: false,
      approve: false,
      assign: moduleKey === 'leads' ? Boolean(options?.allowSaleReassignLead) : false,
      export: false,
      import: false,
      unmask_phone: canUnmask,
      view_financials: false,
      manage_config: false,
    },
  };
}

export interface ResolvedUserRbacResult {
  userOrg: UserOrgAuthSnapshot | null;
  enabledModules: string[];
  effectivePermissions: EffectivePermissionsMatrix;
}

function mirrorModuleAliasesInMatrix(matrix: EffectivePermissionsMatrix): EffectivePermissionsMatrix {
  for (const mod of SAAS_MODULES_CATALOG) {
    const basePerm = matrix[mod.key];
    if (!basePerm) continue;
    for (const aliasKey of getAliasesForModuleKey(mod.key)) {
      if (!matrix[aliasKey]) {
        matrix[aliasKey] = {
          module_key: aliasKey,
          scope: basePerm.scope,
          data_scope: basePerm.data_scope,
          actions: { ...basePerm.actions },
        };
      }
    }
  }
  return matrix;
}

/**
 * ZERO-SHORT-CIRCUIT GRANULAR RBAC ENGINE
 * Exact Resolution Order:
 *   1. Entitlement Gate (`enabled_modules` of active SaaS package)
 *   2. Workspace Owner (`users.is_tenant_owner === true`)
 *   3. User Overrides (`Deny` strictly beats `Grant`) applied over:
 *   4. `Role Permissions ∪ Department Permissions`
 */
export async function resolveUserEffectivePermissions(
  client: DbClient,
  tenantId: string,
  userId: string
): Promise<ResolvedUserRbacResult> {
  if (tenantId && userId) {
    const cached = tenantRedis.getCachedEffectivePermissions<ResolvedUserRbacResult>(tenantId, userId);
    if (cached) {
      return cached;
    }
  }

  const [tenantRes, userRes] = await Promise.all([
    client.query<{
      package_code?: string;
      plan_tier: string;
      subscription_plan_code: string | null;
      crm_erp_upgrade_status: string | null;
      industry: string;
      industry_key?: string;
      enabled_modules?: unknown;
      entitlements?: unknown;
      settings: Record<string, unknown>;
    }>(
      `SELECT package_code, plan_tier, subscription_plan_code, crm_erp_upgrade_status,
              industry, industry_key, enabled_modules, entitlements, settings
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    ),
    client.query<{
      id: string;
      role: string;
      role_id: string | null;
      branch_id: string | null;
      department_id: string | null;
      team_id: string | null;
      position_id: string | null;
      reports_to_user_id: string | null;
      is_tenant_owner: boolean;
      is_external_agency: boolean;
      is_system_bot: boolean;
    }>(
      `SELECT id, role, role_id, branch_id, department_id, team_id, position_id,
              reports_to_user_id, is_tenant_owner, is_external_agency, is_system_bot
       FROM users
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, userId]
    ),
  ]);

  const tRow = tenantRes.rows[0];
  const uRow = userRes.rows[0];
  if (!tRow) {
    return { userOrg: null, enabledModules: [], effectivePermissions: {} };
  }

  const entSnap = resolveTenantEntitlementSnapshot(tRow);
  const enabledSet = new Set<string>(entSnap.enabled_modules);
  const settingsObj = (tRow.settings && typeof tRow.settings === 'object' ? tRow.settings : {}) as Record<
    string,
    any
  >;
  const legacyRolePerms = settingsObj.role_permissions || {};

  if (!uRow) {
    const emptyMatrix: EffectivePermissionsMatrix = {};
    for (const m of SAAS_MODULES_CATALOG) {
      emptyMatrix[m.key] = {
        module_key: m.key,
        scope: 'none',
        data_scope: 'none',
        actions: buildEmptyActions(false),
      };
    }
    mirrorModuleAliasesInMatrix(emptyMatrix);
    return { userOrg: null, enabledModules: entSnap.enabled_modules, effectivePermissions: emptyMatrix };
  }

  const userOrg: UserOrgAuthSnapshot = {
    user_id: uRow.id,
    role: uRow.role,
    role_id: uRow.role_id || null,
    branch_id: uRow.branch_id || null,
    department_id: uRow.department_id || null,
    team_id: uRow.team_id || null,
    position_id: uRow.position_id || null,
    reports_to_user_id: uRow.reports_to_user_id || null,
    is_tenant_owner: Boolean(uRow.is_tenant_owner),
    is_external_agency: Boolean(uRow.is_external_agency),
    is_system_bot: Boolean(uRow.is_system_bot),
  };

  // Fast-path for Workspace Owner (`is_tenant_owner === true`): Entitlement Gate + Full Company Scope (0 extra SQL queries)
  if (userOrg.is_tenant_owner) {
    const ownerMatrix: EffectivePermissionsMatrix = {};
    for (const mod of SAAS_MODULES_CATALOG) {
      const mKey = mod.key;
      if (!enabledSet.has(mKey) && !mod.always_enabled) {
        ownerMatrix[mKey] = {
          module_key: mKey,
          scope: 'none',
          data_scope: 'none',
          actions: buildEmptyActions(false),
        };
      } else {
        ownerMatrix[mKey] = {
          module_key: mKey,
          scope: 'company',
          data_scope: 'company',
          actions: buildEmptyActions(true),
        };
      }
    }
    mirrorModuleAliasesInMatrix(ownerMatrix);
    const ownerResult: ResolvedUserRbacResult = {
      userOrg,
      enabledModules: entSnap.enabled_modules,
      effectivePermissions: ownerMatrix,
    };
    tenantRedis.setCachedEffectivePermissions(tenantId, userId, ownerResult, 30);
    return ownerResult;
  }

  // Resolve effective role_id if user only has string `role` matching `tenant_roles.role_key`
  let resolvedRoleId = userOrg.role_id;
  let resolvedRoleIsSystem = !userOrg.role_id;
  if (resolvedRoleId) {
    const rSys = await client.query<{ is_system: boolean; role_key: string }>(
      'SELECT is_system, role_key FROM tenant_roles WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, resolvedRoleId]
    );
    resolvedRoleIsSystem = Boolean(rSys.rows[0]?.is_system);
  } else if (userOrg.role) {
    const roleLookup = await client.query<{ id: string; is_system: boolean }>(
      `SELECT id, is_system FROM tenant_roles
       WHERE tenant_id = $1 AND LOWER(role_key) = LOWER($2) AND is_active = true
       LIMIT 1`,
      [tenantId, userOrg.role]
    );
    resolvedRoleId = roleLookup.rows[0]?.id || null;
    if (roleLookup.rows[0]) {
      resolvedRoleIsSystem = Boolean(roleLookup.rows[0].is_system);
    }
  }

  const [rolePermsRes, deptPermsRes, overridesRes] = await Promise.all([
    resolvedRoleId
      ? client.query<{ module_key: string; data_scope: string; actions: unknown }>(
          `SELECT module_key, data_scope, actions
           FROM tenant_role_permissions
           WHERE tenant_id = $1 AND role_id = $2`,
          [tenantId, resolvedRoleId]
        )
      : Promise.resolve({ rows: [] as Array<{ module_key: string; data_scope: string; actions: unknown }> }),
    userOrg.department_id
      ? client.query<{ module_key: string; data_scope: string; actions: unknown }>(
          `SELECT module_key, data_scope, actions
           FROM tenant_department_permissions
           WHERE tenant_id = $1 AND department_id = $2`,
          [tenantId, userOrg.department_id]
        )
      : Promise.resolve({ rows: [] as Array<{ module_key: string; data_scope: string; actions: unknown }> }),
    client.query<{
      module_key: string;
      effect: string;
      data_scope: string | null;
      actions: unknown;
      expires_at: string | Date | null;
    }>(
      `SELECT module_key, effect, data_scope, actions, expires_at
       FROM tenant_user_permission_overrides
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId]
    ),
  ]);

  const rolePermMap = new Map<string, { scope: DataScope; actions: ActionPermissionMap }>();
  for (const rp of rolePermsRes.rows) {
    const normKey = normalizeCanonicalModuleKey(rp.module_key) || rp.module_key;
    rolePermMap.set(normKey, {
      scope: normalizeDataScope(rp.data_scope, 'none'),
      actions: normalizeActionsMap(rp.actions),
    });
  }

  const deptPermMap = new Map<string, { scope: DataScope; actions: ActionPermissionMap }>();
  for (const dp of deptPermsRes.rows) {
    const normKey = normalizeCanonicalModuleKey(dp.module_key) || dp.module_key;
    deptPermMap.set(normKey, {
      scope: normalizeDataScope(dp.data_scope, 'none'),
      actions: normalizeActionsMap(dp.actions),
    });
  }

  const nowMs = Date.now();
  const grantOverrides = new Map<string, { scope: DataScope | null; rawActions: Record<string, unknown> }>();
  const denyOverrides = new Map<string, { scope: DataScope | null; rawActions: Record<string, unknown> }>();

  for (const ov of overridesRes.rows) {
    if (ov.expires_at && new Date(ov.expires_at).getTime() <= nowMs) {
      continue;
    }
    const normKey = normalizeCanonicalModuleKey(ov.module_key) || ov.module_key;
    const parsedScope = ov.data_scope ? normalizeDataScope(ov.data_scope, 'none') : null;
    const rawAct = ov.actions && typeof ov.actions === 'object' ? (ov.actions as Record<string, unknown>) : {};
    if (ov.effect === 'deny') {
      denyOverrides.set(normKey, { scope: parsedScope, rawActions: rawAct });
    } else {
      grantOverrides.set(normKey, { scope: parsedScope, rawActions: rawAct });
    }
  }

  const matrix: EffectivePermissionsMatrix = {};

  for (const mod of SAAS_MODULES_CATALOG) {
    const mKey = mod.key;

    // ------------------------------------------------------------------------
    // STEP 1: ENTITLEMENT GATE (Strict Package Boundary)
    // ------------------------------------------------------------------------
    if (!enabledSet.has(mKey) && !mod.always_enabled) {
      matrix[mKey] = {
        module_key: mKey,
        scope: 'none',
        data_scope: 'none',
        actions: buildEmptyActions(false),
      };
      continue;
    }

    // ------------------------------------------------------------------------
    // STEP 2: WORKSPACE OWNER (`is_tenant_owner === true`)
    // ------------------------------------------------------------------------
    if (userOrg.is_tenant_owner) {
      matrix[mKey] = {
        module_key: mKey,
        scope: 'company',
        data_scope: 'company',
        actions: buildEmptyActions(true),
      };
      continue;
    }

    // ------------------------------------------------------------------------
    // STEP 3: ROLE PERMISSIONS ∪ DEPARTMENT PERMISSIONS (Zero Short-Circuit)
    // ------------------------------------------------------------------------
    const explicitRolePerm = rolePermMap.get(mKey);
    const explicitDeptPerm = deptPermMap.get(mKey);

    let effectiveScope: DataScope = 'none';
    let effectiveActions: ActionPermissionMap = buildEmptyActions(false);

    if (explicitRolePerm || explicitDeptPerm) {
      // Strictly honor DB-configured Role & Department matrices (even if set to 'none' / false!)
      if (explicitRolePerm && explicitDeptPerm) {
        effectiveScope = maxDataScope(explicitRolePerm.scope, explicitDeptPerm.scope);
        for (const act of GRANULAR_ACTIONS) {
          effectiveActions[act] = Boolean(explicitRolePerm.actions[act] || explicitDeptPerm.actions[act]);
        }
      } else if (explicitRolePerm) {
        effectiveScope = explicitRolePerm.scope;
        effectiveActions = { ...explicitRolePerm.actions };
      } else if (explicitDeptPerm) {
        effectiveScope = explicitDeptPerm.scope;
        effectiveActions = { ...explicitDeptPerm.actions };
      }
    } else if (!resolvedRoleId || resolvedRoleIsSystem) {
      // Fallback ONLY when no DB row exists yet for this module on a system role
      const fallback = buildDefaultSystemRoleModulePermission(userOrg.role, mKey, {
        isExternalAgency: userOrg.is_external_agency,
        allowManagerExportCsv: Boolean(legacyRolePerms.allow_manager_export_csv),
        allowManagerManagePipelines: Boolean(legacyRolePerms.allow_manager_manage_pipelines),
        allowSaleCreateLead: Boolean(legacyRolePerms.allow_sale_create_lead),
        allowSaleReassignLead: Boolean(legacyRolePerms.allow_sale_reassign_lead),
        piiMaskAllSales: Boolean(settingsObj.pii_mask_all_sales),
      });
      effectiveScope = fallback.data_scope;
      effectiveActions = fallback.actions;
    }

    // External agency baseline safety on system roles unless explicitly granted by custom role/dept/override
    if (userOrg.is_external_agency && (!explicitRolePerm || resolvedRoleIsSystem) && !explicitDeptPerm) {
      effectiveActions.unmask_phone = false;
    }

    // ------------------------------------------------------------------------
    // STEP 4: USER OVERRIDES (`Grant` then `Deny` — `Deny` strictly wins!)
    // ------------------------------------------------------------------------
    const grantOv = grantOverrides.get(mKey);
    if (grantOv) {
      if (grantOv.scope) {
        effectiveScope = maxDataScope(effectiveScope, grantOv.scope);
      }
      let grantedAnyAction = false;
      for (const act of GRANULAR_ACTIONS) {
        if (grantOv.rawActions[act] === true) {
          effectiveActions[act] = true;
          grantedAnyAction = true;
        }
      }
      if (grantedAnyAction && effectiveScope === 'none' && grantOv.scope === null) {
        effectiveScope = 'own';
      }
    }

    const denyOv = denyOverrides.get(mKey);
    if (denyOv) {
      if (denyOv.scope === 'none') {
        effectiveScope = 'none';
        effectiveActions = buildEmptyActions(false);
      } else {
        if (denyOv.scope) {
          effectiveScope = minDataScope(effectiveScope, denyOv.scope);
        }
        for (const act of GRANULAR_ACTIONS) {
          // In a 'deny' override, `{ unmask_phone: true }` (or explicit `false`) revokes that action
          if (denyOv.rawActions[act] === true) {
            effectiveActions[act] = false;
          }
        }
      }
    }

    if (effectiveScope === 'none') {
      effectiveActions = buildEmptyActions(false);
    }

    matrix[mKey] = {
      module_key: mKey,
      scope: effectiveScope,
      data_scope: effectiveScope,
      actions: effectiveActions,
    };
  }

  mirrorModuleAliasesInMatrix(matrix);
  const resolvedResult: ResolvedUserRbacResult = {
    userOrg,
    enabledModules: entSnap.enabled_modules,
    effectivePermissions: matrix,
  };
  tenantRedis.setCachedEffectivePermissions(tenantId, userId, resolvedResult, 30);
  return resolvedResult;
}

/**
 * Cycle-safe BFS descendant department resolver (works identically across PG, PGlite & MariaDB)
 */
export function resolveDescendantDepartmentIds(
  allDepartments: Array<{ id: string; parent_department_id: string | null }>,
  rootDepartmentId: string
): string[] {
  const visited = new Set<string>([rootDepartmentId]);
  const queue: string[] = [rootDepartmentId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const d of allDepartments) {
      if (d.parent_department_id === cur && !visited.has(d.id)) {
        visited.add(d.id);
        queue.push(d.id);
      }
    }
  }
  return Array.from(visited);
}

/**
 * Builds a parameterized SQL WHERE clause enforcing the 7-Tier Data Scope
 * (`none` | `own` | `team` | `department` | `sub_departments` | `branch` | `company`)
 */
export async function buildGranularScopeWhereClause(
  client: DbClient,
  tenantId: string,
  userOrg: UserOrgAuthSnapshot,
  scope: DataScope,
  options?: {
    tenantColumn?: string;
    ownerColumn?: string;
    startParamIndex?: number;
    allowUnassignedForManagers?: boolean;
  }
): Promise<{ clause: string; values: unknown[]; nextIndex: number }> {
  const startIdx = options?.startParamIndex ?? 1;
  const tenantCol = options?.tenantColumn || 'leads.tenant_id';
  const ownerCol = options?.ownerColumn || 'leads.assigned_to';
  const pTenant = `$${startIdx}`;

  if (scope === 'none') {
    return {
      clause: `${tenantCol} = ${pTenant} AND 1 = 0`,
      values: [tenantId],
      nextIndex: startIdx + 1,
    };
  }

  if (scope === 'company') {
    return {
      clause: `${tenantCol} = ${pTenant}`,
      values: [tenantId],
      nextIndex: startIdx + 1,
    };
  }

  const pUser = `$${startIdx + 1}`;
  if (scope === 'own') {
    return {
      clause: `${tenantCol} = ${pTenant} AND ${ownerCol} = ${pUser}`,
      values: [tenantId, userOrg.user_id],
      nextIndex: startIdx + 2,
    };
  }

  const unassignedOr = options?.allowUnassignedForManagers ? `${ownerCol} IS NULL OR ` : '';

  if (scope === 'team') {
    if (!userOrg.team_id) {
      return {
        clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser})`,
        values: [tenantId, userOrg.user_id],
        nextIndex: startIdx + 2,
      };
    }
    const pTeam = `$${startIdx + 2}`;
    return {
      clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser} OR ${ownerCol} IN (SELECT u_sc.id FROM users u_sc WHERE u_sc.tenant_id = ${pTenant} AND u_sc.team_id = ${pTeam}))`,
      values: [tenantId, userOrg.user_id, userOrg.team_id],
      nextIndex: startIdx + 3,
    };
  }

  if (scope === 'department') {
    if (!userOrg.department_id) {
      return {
        clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser})`,
        values: [tenantId, userOrg.user_id],
        nextIndex: startIdx + 2,
      };
    }
    const pDept = `$${startIdx + 2}`;
    return {
      clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser} OR ${ownerCol} IN (SELECT u_sc.id FROM users u_sc WHERE u_sc.tenant_id = ${pTenant} AND u_sc.department_id = ${pDept}))`,
      values: [tenantId, userOrg.user_id, userOrg.department_id],
      nextIndex: startIdx + 3,
    };
  }

  if (scope === 'sub_departments') {
    if (!userOrg.department_id) {
      return {
        clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser})`,
        values: [tenantId, userOrg.user_id],
        nextIndex: startIdx + 2,
      };
    }
    const allDeptsRes = await client.query<{ id: string; parent_department_id: string | null }>(
      'SELECT id, parent_department_id FROM tenant_departments WHERE tenant_id = $1',
      [tenantId]
    );
    const deptIds = resolveDescendantDepartmentIds(allDeptsRes.rows, userOrg.department_id);
    const placeholders = deptIds.map((_, idx) => `$${startIdx + 2 + idx}`).join(', ');
    return {
      clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser} OR ${ownerCol} IN (SELECT u_sc.id FROM users u_sc WHERE u_sc.tenant_id = ${pTenant} AND u_sc.department_id IN (${placeholders})))`,
      values: [tenantId, userOrg.user_id, ...deptIds],
      nextIndex: startIdx + 2 + deptIds.length,
    };
  }

  // scope === 'branch'
  if (!userOrg.branch_id) {
    return {
      clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser})`,
      values: [tenantId, userOrg.user_id],
      nextIndex: startIdx + 2,
    };
  }
  const pBranch = `$${startIdx + 2}`;
  return {
    clause: `${tenantCol} = ${pTenant} AND (${unassignedOr}${ownerCol} = ${pUser} OR ${ownerCol} IN (SELECT u_sc.id FROM users u_sc WHERE u_sc.tenant_id = ${pTenant} AND u_sc.branch_id = ${pBranch}))`,
    values: [tenantId, userOrg.user_id, userOrg.branch_id],
    nextIndex: startIdx + 3,
  };
}

/**
 * RFC 7807 Standardized Error Envelope Helper
 */
export function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Array<{ field?: string; issue: string }>
): void {
  if (status >= 500 && process.env.DEBUG_API === '1') {
    console.error(`[API ${status} ${code}]`, message);
  }
  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      details: details || [],
      timestamp: new Date().toISOString(),
      trace_id: `req-${crypto.randomUUID().slice(0, 12)}`,
    },
  });
}

/**
 * Extracts requested tenant slug from `X-Tenant-Slug` header or Host subdomain (`{slug}.autodata.vn`).
 */
export function extractRequestedTenantSlug(req: Request): string | null {
  const headerSlug = req.header('X-Tenant-Slug')?.trim().toLowerCase();
  if (headerSlug) return headerSlug;

  const host = (req.hostname || req.header('host') || '').split(':')[0].toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host.startsWith('admin.') || host.startsWith('api.')) {
    return null;
  }
  const parts = host.split('.');
  if (parts.length >= 3 && (host.endsWith('.autodata.vn') || host.endsWith('.localhost'))) {
    return parts[0];
  }
  return null;
}

/**
 * Layer 1 + Layer 2 Authentication & Tenant Isolation Middleware
 */
export async function requireTenantAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendApiError(res, 401, 'AUTHENTICATION_REQUIRED', 'Vui lòng đăng nhập để truy cập tài nguyên này.');
      return;
    }

    const token = authHeader.slice(7).trim();
    let claims;
    try {
      claims = verifyTenantAccessToken(token);
    } catch (err: any) {
      sendApiError(res, 401, err?.message || 'INVALID_TOKEN', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
      return;
    }

    const requestedSlug = extractRequestedTenantSlug(req);
    if (requestedSlug && requestedSlug !== claims.tenantSlug.toLowerCase()) {
      sendApiError(
        res,
        403,
        'TENANT_CONTEXT_MISMATCH',
        'Token tenant claim does not match the requested subdomain organization.',
        [
          {
            field: 'X-Tenant-Slug',
            issue: `Subdomain '${requestedSlug}' does not match token tenant '${claims.tenantId}' (${claims.tenantSlug})`,
          },
        ]
      );
      return;
    }

    const isRevoked = await tenantRedis.isUserBlacklisted(claims.tenantId, claims.sub);
    if (isRevoked) {
      sendApiError(
        res,
        401,
        'ACCOUNT_DEACTIVATED',
        'Tài khoản của bạn đã bị vô hiệu hóa bởi Quản trị viên. Vui lòng liên hệ ban quản lý.'
      );
      return;
    }

    const tenantMeta = await getTenantMetaCached(claims.tenantId);
    const tenantStatus = tenantMeta ? tenantMeta.status : 'missing';

    if (tenantStatus === 'suspended' || tenantStatus === 'cancelled' || tenantStatus === 'missing') {
      sendApiError(res, 403, 'TENANT_SUSPENDED', 'Tổ chức của bạn hiện đang tạm ngưng hoạt động.');
      return;
    }

    const liveUserAuth = tenantRedis.getCachedUserAuth(claims.tenantId, claims.sub);
    const effectiveRole = liveUserAuth ? liveUserAuth.role : claims.role;
    const effectiveExternalAgency = liveUserAuth
      ? liveUserAuth.isExternalAgency
      : Boolean(claims.isExternalAgency);

    tenantStorage.run(
      {
        tenantId: claims.tenantId,
        tenantSlug: claims.tenantSlug,
        userId: claims.sub,
        userEmail: claims.email,
        userName: claims.name,
        userRole: effectiveRole,
        isExternalAgency: effectiveExternalAgency,
        planTier: claims.planTier,
        impersonatedBySuperAdminId: claims.impersonatedBy,
      },
      () => next()
    );
  } catch (err: any) {
    sendApiError(res, 500, 'AUTH_INTERNAL_ERROR', err?.message || 'Lỗi xác thực hệ thống.');
  }
}

/**
 * Legacy Role Guard preserved for backward compatibility with existing Auto Data V2 routes
 */
export function requireRoles(...allowedRoles: TenantRole[]) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const ctx = getTenantContext();
      if (!allowedRoles.includes(ctx.userRole)) {
        sendApiError(
          res,
          403,
          'FORBIDDEN_INSUFFICIENT_ROLE',
          `Quyền hạn '${ctx.userRole}' không được phép thực hiện thao tác này. Yêu cầu: ${allowedRoles.join(', ')}.`
        );
        return;
      }
      next();
    } catch {
      sendApiError(res, 401, 'TENANT_CONTEXT_MISSING', 'Không tìm thấy ngữ cảnh doanh nghiệp.');
    }
  };
}

/**
 * Entitlement Gate Middleware: Rejects access when tenant's active SaaS package does not include `moduleKey`
 */
export function requireEntitlement(moduleKey: SaasModuleKey | string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext();
      const canonicalKey = normalizeCanonicalModuleKey(moduleKey) || String(moduleKey);
      const resolved =
        (req as any).rbacResolved ||
        tenantRedis.getCachedEffectivePermissions<ResolvedUserRbacResult>(ctx.tenantId, ctx.userId) ||
        (await withTenantTransaction(ctx.tenantId, (client) =>
          resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId)
        ));
      (req as any).rbacResolved = resolved;
      if (!resolved.enabledModules.includes(canonicalKey) && !resolved.enabledModules.includes(String(moduleKey))) {
        sendApiError(
          res,
          403,
          'MODULE_NOT_ENTITLED',
          `Phân hệ '${moduleKey}' không thuộc gói cước hiện tại của doanh nghiệp. Vui lòng nâng cấp gói để mở khóa tức thì.`
        );
        return;
      }
      next();
    } catch (err: any) {
      sendApiError(res, 500, 'ENTITLEMENT_CHECK_FAILED', err?.message || 'Không thể kiểm tra quyền gói cước.');
    }
  };
}

/**
 * Zero-Short-Circuit Granular Permission Middleware (`moduleKey` × `action`)
 */
export function requirePermission(moduleKey: SaasModuleKey | string, action: GranularAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ctx = getTenantContext();
      const canonicalKey = normalizeCanonicalModuleKey(moduleKey) || String(moduleKey);
      const resolved =
        (req as any).rbacResolved ||
        tenantRedis.getCachedEffectivePermissions<ResolvedUserRbacResult>(ctx.tenantId, ctx.userId) ||
        (await withTenantTransaction(ctx.tenantId, (client) =>
          resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId)
        ));
      (req as any).rbacResolved = resolved;

      if (!resolved.enabledModules.includes(canonicalKey) && !resolved.enabledModules.includes(String(moduleKey))) {
        const modDesc = SAAS_MODULES_CATALOG.find((m) => m.key === canonicalKey);
        if (!modDesc?.always_enabled) {
          sendApiError(
            res,
            403,
            'MODULE_NOT_ENTITLED',
            `Phân hệ '${moduleKey}' chưa được mở khóa trong gói cước hiện tại.`
          );
          return;
        }
      }

      const perm = resolved.effectivePermissions[canonicalKey] || resolved.effectivePermissions[String(moduleKey)];
      if (!perm || perm.scope === 'none' || !perm.actions[action]) {
        sendApiError(
          res,
          403,
          'FORBIDDEN_RBAC_PERMISSION',
          `Tài khoản không có quyền '${action}' trên phân hệ '${moduleKey}'.`
        );
        return;
      }

      next();
    } catch (err: any) {
      sendApiError(res, 500, 'RBAC_CHECK_FAILED', err?.message || 'Không thể kiểm tra phân quyền chi tiết.');
    }
  };
}

/**
 * Segregated Platform Super Admin Authentication Middleware (`/api/v1/admin/*`)
 */
export async function requirePlatformSuperAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendApiError(res, 401, 'PLATFORM_AUTH_REQUIRED', 'Yêu cầu xác thực Platform Super Admin.');
    return;
  }

  const token = authHeader.slice(7).trim();
  try {
    const claims = verifyPlatformAccessToken(token);
    platformStorage.run(
      {
        adminId: claims.sub,
        email: claims.email,
        fullName: claims.name,
        role: 'super_admin',
      },
      () => next()
    );
  } catch {
    sendApiError(res, 403, 'PLATFORM_FORBIDDEN', 'Token không thuộc thẩm quyền Platform Super Admin.');
  }
}
