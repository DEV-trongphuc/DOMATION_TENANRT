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
import { withTenantTransaction, withSystemPrivilege } from '../database/transaction.ts';
import { getDatabasePool, type DbClient } from '../database/db-adapter.ts';
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
    const adminOnlyModules = new Set([
      'settings',
      'billing',
      'org_rbac',
      'integrations_crm',
      'integrations_marketing',
    ]);
    if (adminOnlyModules.has(moduleKey)) {
      return {
        data_scope: moduleKey === 'org_rbac' ? 'department' : 'none',
        actions: {
          ...buildEmptyActions(false),
          view: moduleKey === 'org_rbac',
        },
      };
    }
    if (moduleKey === 'users') {
      return {
        data_scope: 'department',
        actions: {
          ...buildEmptyActions(false),
          view: true,
          create: true,
          edit: true,
          assign: true,
          unmask_phone: true,
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
    'approvals',
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

export type ScreenAccessMap = Record<string, boolean>;
export type QuickActionsMap = Record<string, boolean>;

export interface ResolvedUserRbacResult {
  userOrg: UserOrgAuthSnapshot | null;
  enabledModules: string[];
  effectivePermissions: EffectivePermissionsMatrix;
  screen_access: ScreenAccessMap;
  quick_actions: QuickActionsMap;
  default_route: string;
}

const rbacSchemaInitializedPools = new WeakSet<object>();
const rbacSchemaPendingPools = new WeakMap<object, Promise<void>>();

async function addMariaDbRbacColumnIfMissing(
  client: DbClient,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const res = await client.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (Number(res.rows[0]?.cnt || 0) === 0) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export async function ensureRbacScreenColumns(): Promise<void> {
  let pool: ReturnType<typeof getDatabasePool>;
  try {
    pool = getDatabasePool();
  } catch {
    return;
  }
  if (rbacSchemaInitializedPools.has(pool)) {
    return;
  }
  let running = rbacSchemaPendingPools.get(pool);
  if (!running) {
    running = (async () => {
      await withSystemPrivilege(async (client) => {
        if (client.dialect === 'mariadb' || pool.dialect === 'mariadb') {
          await addMariaDbRbacColumnIfMissing(client, 'tenant_roles', 'screen_access', 'JSON NULL');
          await addMariaDbRbacColumnIfMissing(client, 'tenant_roles', 'quick_actions', 'JSON NULL');
          await addMariaDbRbacColumnIfMissing(
            client,
            'tenant_roles',
            'default_route',
            "VARCHAR(120) NOT NULL DEFAULT '/'"
          );
          await addMariaDbRbacColumnIfMissing(client, 'tenant_role_permissions', 'screen_access', 'JSON NULL');
          await addMariaDbRbacColumnIfMissing(client, 'tenant_role_permissions', 'quick_actions', 'JSON NULL');
          await client.query(`UPDATE tenant_roles SET screen_access = '{}' WHERE screen_access IS NULL`);
          await client.query(`UPDATE tenant_roles SET quick_actions = '{}' WHERE quick_actions IS NULL`);
          await client.query(`UPDATE tenant_role_permissions SET screen_access = '{}' WHERE screen_access IS NULL`);
          await client.query(`UPDATE tenant_role_permissions SET quick_actions = '{}' WHERE quick_actions IS NULL`);
        } else {
          const pgAlters = [
            `ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS screen_access JSONB NOT NULL DEFAULT '{}'::jsonb`,
            `ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS quick_actions JSONB NOT NULL DEFAULT '{}'::jsonb`,
            `ALTER TABLE tenant_roles ADD COLUMN IF NOT EXISTS default_route VARCHAR(120) NOT NULL DEFAULT '/'`,
            `ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS screen_access JSONB NOT NULL DEFAULT '{}'::jsonb`,
            `ALTER TABLE tenant_role_permissions ADD COLUMN IF NOT EXISTS quick_actions JSONB NOT NULL DEFAULT '{}'::jsonb`,
          ];
          for (const stmt of pgAlters) {
            await client.query(stmt);
          }
        }
      });
      rbacSchemaInitializedPools.add(pool);
    })().finally(() => {
      rbacSchemaPendingPools.delete(pool);
    });
    rbacSchemaPendingPools.set(pool, running);
  }
  await running;
}

export function parseBoolMapSafe(val: unknown): Record<string, boolean> {
  let raw = val;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k || '').trim();
    if (!key) continue;
    out[key] = Boolean(v);
  }
  return out;
}

export const MODULE_TO_DEFAULT_SCREENS: Record<string, readonly string[]> = {
  dashboard_crm: ['/', '/dashboard'],
  leads: ['/leads', '/contacts', '/databank'],
  rounds: ['/rounds', '/fair-share'],
  routing_rules: ['/routing-rules'],
  pipelines: ['/pipelines'],
  gatekeeper: ['/gatekeeper'],
  tickets_data: ['/tickets-data'],
  ads_capi: ['/ads-capi'],
  sale_portal: ['/sale-portal'],
  appointments: ['/appointments'],
  integrations_crm: ['/integrations', '/connect'],
  dom_sales_copilot: ['/dom-sales-copilot'],
  dashboard_marketing: ['/marketing'],
  audiences: ['/audiences'],
  mkt_templates: ['/marketing/templates'],
  mkt_forms: ['/marketing/forms'],
  mkt_surveys: ['/marketing/surveys'],
  mkt_campaigns: ['/marketing/campaigns'],
  mkt_flows: ['/marketing/flows'],
  mkt_vouchers: ['/marketing/vouchers'],
  mkt_web_tracking: ['/marketing/web-tracking'],
  mkt_social_bot: ['/marketing/social-bot'],
  mkt_ai_bot: ['/marketing/ai-bot'],
  integrations_marketing: ['/marketing/connect'],
  dashboard_growth: ['/growth'],
  revenue_attribution: ['/growth/attribution'],
  hrm: ['/erp/hrm', '/hrm'],
  attendance: ['/erp/attendance', '/attendance'],
  payroll: ['/erp/payroll', '/payroll'],
  approvals: ['/erp/approvals', '/approvals'],
  workspace_personal: ['/workspace', '/activities'],
  projects: ['/erp/projects', '/projects'],
  workchat: ['/erp/workchat', '/workchat'],
  enterprise_feed: ['/feed', '/erp/feed'],
  helpdesk: ['/support-tickets', '/helpdesk'],
  crm_b2b: ['/deals', '/companies'],
  deals: ['/deals', '/crm/deals'],
  companies: ['/companies', '/crm/companies'],
  finance: ['/erp/finance', '/finance', '/deposits', '/expenses', '/cash-flow', '/invoices'],
  quotes_orders: ['/quotes', '/sales-orders', '/purchase-orders'],
  inventory_assets: ['/products', '/suppliers', '/inventory'],
  cloud_files_ocr: ['/erp/cloud-files', '/cloud-files'],
  reports_bi: ['/reports'],
  dom_agent: ['/dom-agent'],
  education: ['/erp/education', '/education'],
  settings: ['/settings'],
  org_rbac: ['/settings/rbac', '/org-rbac'],
  users: ['/accounts', '/users'],
  billing: ['/billing'],
};

function computeScreenAccessQuickActionsAndRoute(options: {
  matrix: EffectivePermissionsMatrix;
  enabledSet: Set<string>;
  isOwner: boolean;
  roleScreenAccess?: Record<string, boolean>;
  roleQuickActions?: Record<string, boolean>;
  roleDefaultRoute?: string | null;
  moduleScreenOverrides?: Record<string, boolean>;
  moduleQuickOverrides?: Record<string, boolean>;
}): { screen_access: ScreenAccessMap; quick_actions: QuickActionsMap; default_route: string } {
  const screenAccess: ScreenAccessMap = {};
  const { matrix, enabledSet, isOwner } = options;

  for (const mod of SAAS_MODULES_CATALOG) {
    const mKey = mod.key;
    const perm = matrix[mKey];
    const entitled = enabledSet.has(mKey) || Boolean(mod.always_enabled);
    const allowed = entitled && Boolean(perm && perm.scope !== 'none' && perm.actions?.view);
    screenAccess[mKey] = allowed;
    for (const alias of getAliasesForModuleKey(mKey)) {
      screenAccess[alias] = allowed;
    }
    const routes = MODULE_TO_DEFAULT_SCREENS[mKey] || [];
    for (const route of routes) {
      if (screenAccess[route] === undefined) {
        screenAccess[route] = allowed;
      } else {
        screenAccess[route] = screenAccess[route] || allowed;
      }
    }
  }

  // Explicitly lock `/deals` & `/companies` individually if `deals` or `companies` perms exist cleanly
  if (matrix.deals) {
    const dealsAllowed = enabledSet.has('deals') && matrix.deals.scope !== 'none' && Boolean(matrix.deals.actions?.view);
    screenAccess.deals = dealsAllowed;
    screenAccess['/deals'] = dealsAllowed;
    screenAccess['/crm/deals'] = dealsAllowed;
  }
  if (matrix.companies) {
    const companiesAllowed =
      enabledSet.has('companies') && matrix.companies.scope !== 'none' && Boolean(matrix.companies.actions?.view);
    screenAccess.companies = companiesAllowed;
    screenAccess['/companies'] = companiesAllowed;
    screenAccess['/crm/companies'] = companiesAllowed;
  }

  const quickActions: QuickActionsMap = {
    create_lead: Boolean(matrix.leads?.scope !== 'none' && matrix.leads?.actions?.create),
    export_leads: Boolean(matrix.leads?.scope !== 'none' && matrix.leads?.actions?.export),
    claim_databank: Boolean(matrix.leads?.scope !== 'none' && matrix.leads?.actions?.view),
    create_deal: Boolean(
      (matrix.deals?.scope !== 'none' && matrix.deals?.actions?.create) ||
        (matrix.crm_b2b?.scope !== 'none' && matrix.crm_b2b?.actions?.create)
    ),
    create_task: Boolean(
      (matrix.projects?.scope !== 'none' && matrix.projects?.actions?.create) ||
        (matrix.workspace_personal?.scope !== 'none' && matrix.workspace_personal?.actions?.create)
    ),
    create_quote: Boolean(
      (matrix.quotes_orders?.scope !== 'none' && matrix.quotes_orders?.actions?.create) ||
        (matrix.finance?.scope !== 'none' && matrix.finance?.actions?.create)
    ),
    create_expense: Boolean(matrix.finance?.scope !== 'none' && matrix.finance?.actions?.create),
    checkin_attendance: Boolean(matrix.attendance?.scope !== 'none' && matrix.attendance?.actions?.view),
    submit_approval: Boolean(matrix.approvals?.scope !== 'none' && matrix.approvals?.actions?.create),
    open_dom_agent: Boolean(
      (matrix.dom_agent?.scope !== 'none' && matrix.dom_agent?.actions?.view) ||
        (matrix.dom_sales_copilot?.scope !== 'none' && matrix.dom_sales_copilot?.actions?.view)
    ),
    manage_settings: Boolean(matrix.settings?.scope !== 'none' && matrix.settings?.actions?.manage_config),
    manage_users: Boolean(
      matrix.users?.scope !== 'none' && (matrix.users?.actions?.create || matrix.users?.actions?.edit)
    ),
  };

  // Apply explicit module-level and role-level screen/quick overrides (unless Owner safeguard overrides recovery)
  const applyScreenOverrides = (src?: Record<string, boolean>) => {
    if (!src) return;
    for (const [k, val] of Object.entries(src)) {
      const canonical = normalizeCanonicalModuleKey(k);
      if (canonical) {
        const mod = SAAS_MODULES_CATALOG.find((m) => m.key === canonical);
        const entitled = enabledSet.has(canonical) || Boolean(mod?.always_enabled);
        screenAccess[k] = entitled ? Boolean(val) : false;
      } else {
        screenAccess[k] = Boolean(val);
      }
    }
  };
  applyScreenOverrides(options.moduleScreenOverrides);
  applyScreenOverrides(options.roleScreenAccess);

  const applyQuickOverrides = (src?: Record<string, boolean>) => {
    if (!src) return;
    for (const [k, val] of Object.entries(src)) {
      quickActions[k] = Boolean(val);
    }
  };
  applyQuickOverrides(options.moduleQuickOverrides);
  applyQuickOverrides(options.roleQuickActions);

  // OWNER SAFEGUARD: ONLY `users.is_tenant_owner === true` retains immutable access to Settings & Accounts recovery
  if (isOwner) {
    for (const recoveryKey of [
      'settings',
      'org_rbac',
      'users',
      'billing',
      '/settings',
      '/settings/rbac',
      '/org-rbac',
      '/accounts',
      '/users',
      '/billing',
    ]) {
      screenAccess[recoveryKey] = true;
    }
    quickActions.manage_settings = true;
    quickActions.manage_users = true;
  }

  let defaultRoute = String(options.roleDefaultRoute || '').trim() || '/';
  if (defaultRoute !== '/' && screenAccess[defaultRoute] === false && !isOwner) {
    const firstAllowed = Object.entries(screenAccess).find(([k, v]) => k.startsWith('/') && v === true)?.[0];
    defaultRoute = firstAllowed || '/';
  } else if (defaultRoute === '/' && screenAccess['/'] === false && !isOwner) {
    const firstAllowed = Object.entries(screenAccess).find(([k, v]) => k.startsWith('/') && v === true)?.[0];
    if (firstAllowed) {
      defaultRoute = firstAllowed;
    }
  }

  return {
    screen_access: screenAccess,
    quick_actions: quickActions,
    default_route: defaultRoute,
  };
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
    if (cached && cached.screen_access) {
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
    return {
      userOrg: null,
      enabledModules: [],
      effectivePermissions: {},
      screen_access: {},
      quick_actions: {},
      default_route: '/',
    };
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
    return {
      userOrg: null,
      enabledModules: entSnap.enabled_modules,
      effectivePermissions: emptyMatrix,
      screen_access: {},
      quick_actions: {},
      default_route: '/',
    };
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
    const ownerScreenMeta = computeScreenAccessQuickActionsAndRoute({
      matrix: ownerMatrix,
      enabledSet,
      isOwner: true,
    });
    const ownerResult: ResolvedUserRbacResult = {
      userOrg,
      enabledModules: entSnap.enabled_modules,
      effectivePermissions: ownerMatrix,
      ...ownerScreenMeta,
    };
    tenantRedis.setCachedEffectivePermissions(tenantId, userId, ownerResult, 30);
    return ownerResult;
  }

  // Resolve effective role_id if user only has string `role` matching `tenant_roles.role_key`
  let resolvedRoleId = userOrg.role_id;
  let resolvedRoleIsSystem = !userOrg.role_id;
  let roleScreenAccess: Record<string, boolean> = {};
  let roleQuickActions: Record<string, boolean> = {};
  let roleDefaultRoute = '/';
  if (resolvedRoleId) {
    const rSys = await client.query<{
      is_system: boolean;
      role_key: string;
      screen_access?: unknown;
      quick_actions?: unknown;
      default_route?: string | null;
    }>(
      'SELECT is_system, role_key, screen_access, quick_actions, default_route FROM tenant_roles WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, resolvedRoleId]
    );
    resolvedRoleIsSystem = Boolean(rSys.rows[0]?.is_system);
    roleScreenAccess = parseBoolMapSafe(rSys.rows[0]?.screen_access);
    roleQuickActions = parseBoolMapSafe(rSys.rows[0]?.quick_actions);
    roleDefaultRoute = String(rSys.rows[0]?.default_route || '/').trim() || '/';
  } else if (userOrg.role) {
    const roleLookup = await client.query<{
      id: string;
      is_system: boolean;
      screen_access?: unknown;
      quick_actions?: unknown;
      default_route?: string | null;
    }>(
      `SELECT id, is_system, screen_access, quick_actions, default_route FROM tenant_roles
       WHERE tenant_id = $1 AND LOWER(role_key) = LOWER($2) AND is_active = true
       LIMIT 1`,
      [tenantId, userOrg.role]
    );
    resolvedRoleId = roleLookup.rows[0]?.id || null;
    if (roleLookup.rows[0]) {
      resolvedRoleIsSystem = Boolean(roleLookup.rows[0].is_system);
      roleScreenAccess = parseBoolMapSafe(roleLookup.rows[0].screen_access);
      roleQuickActions = parseBoolMapSafe(roleLookup.rows[0].quick_actions);
      roleDefaultRoute = String(roleLookup.rows[0].default_route || '/').trim() || '/';
    }
  }

  const [rolePermsRes, deptPermsRes, overridesRes] = await Promise.all([
    resolvedRoleId
      ? client.query<{
          module_key: string;
          data_scope: string;
          actions: unknown;
          screen_access?: unknown;
          quick_actions?: unknown;
        }>(
          `SELECT module_key, data_scope, actions, screen_access, quick_actions
           FROM tenant_role_permissions
           WHERE tenant_id = $1 AND role_id = $2`,
          [tenantId, resolvedRoleId]
        )
      : Promise.resolve({
          rows: [] as Array<{
            module_key: string;
            data_scope: string;
            actions: unknown;
            screen_access?: unknown;
            quick_actions?: unknown;
          }>,
        }),
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
  const moduleScreenOverrides: Record<string, boolean> = {};
  const moduleQuickOverrides: Record<string, boolean> = {};
  for (const rp of rolePermsRes.rows) {
    const normKey = normalizeCanonicalModuleKey(rp.module_key) || rp.module_key;
    rolePermMap.set(normKey, {
      scope: normalizeDataScope(rp.data_scope, 'none'),
      actions: normalizeActionsMap(rp.actions),
    });
    const mScreens = parseBoolMapSafe(rp.screen_access);
    for (const [sk, sv] of Object.entries(mScreens)) {
      moduleScreenOverrides[sk] = sv;
    }
    const mQuicks = parseBoolMapSafe(rp.quick_actions);
    for (const [qk, qv] of Object.entries(mQuicks)) {
      moduleQuickOverrides[qk] = qv;
    }
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
    } else if ((mKey === 'deals' || mKey === 'companies') && rolePermMap.has('crm_b2b')) {
      const legacyCrmB2b = rolePermMap.get('crm_b2b')!;
      effectiveScope = legacyCrmB2b.scope;
      effectiveActions = { ...legacyCrmB2b.actions };
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
  const screenMeta = computeScreenAccessQuickActionsAndRoute({
    matrix,
    enabledSet,
    isOwner: false,
    roleScreenAccess,
    roleQuickActions,
    roleDefaultRoute,
    moduleScreenOverrides,
    moduleQuickOverrides,
  });
  const resolvedResult: ResolvedUserRbacResult = {
    userOrg,
    enabledModules: entSnap.enabled_modules,
    effectivePermissions: matrix,
    ...screenMeta,
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
    const xAuthToken = req.header('X-Auth-Token');
    const queryToken = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
    const actionQuery = String(req.query?.action || '').trim();
    const isSseQueryAuth =
      Boolean(queryToken) &&
      (req.path === '/api.php' ||
        req.path.includes('sse') ||
        req.path.endsWith('/chat/stream') ||
        actionQuery === 'get_sse_updates' ||
        actionQuery === 'chat/stream');
    const bearerMatch = authHeader ? authHeader.match(/^\s*Bearer\s+(.+)$/i) : null;
    let token = '';
    if (bearerMatch && bearerMatch[1]) {
      token = bearerMatch[1].trim();
    } else if (xAuthToken && xAuthToken.trim()) {
      token = xAuthToken.trim();
    } else if (isSseQueryAuth) {
      token = queryToken;
    } else if (tenantStorage.getStore()) {
      next();
      return;
    } else {
      sendApiError(res, 401, 'AUTHENTICATION_REQUIRED', 'Vui lòng đăng nhập để truy cập tài nguyên này.');
      return;
    }

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
      let resolved =
        (req as any).rbacResolved ||
        tenantRedis.getCachedEffectivePermissions<ResolvedUserRbacResult>(ctx.tenantId, ctx.userId);
      if (!resolved) {
        await ensureRbacScreenColumns();
        resolved = await withTenantTransaction(ctx.tenantId, (client) =>
          resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId)
        );
      }
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

export async function getResolvedUserRbac(
  req: Request,
  client?: DbClient
): Promise<ResolvedUserRbacResult> {
  const ctx = getTenantContext();
  const fromReq = (req as any).rbacResolved as ResolvedUserRbacResult | undefined;
  if (fromReq && fromReq.screen_access) {
    return fromReq;
  }
  const fromCache = tenantRedis.getCachedEffectivePermissions<ResolvedUserRbacResult>(ctx.tenantId, ctx.userId);
  if (fromCache && fromCache.screen_access) {
    (req as any).rbacResolved = fromCache;
    return fromCache;
  }
  if (!client) {
    await ensureRbacScreenColumns();
  }
  const resolved = client
    ? await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId)
    : await withTenantTransaction(ctx.tenantId, (tx) =>
        resolveUserEffectivePermissions(tx, ctx.tenantId, ctx.userId)
      );
  (req as any).rbacResolved = resolved;
  return resolved;
}

export function checkEffectivePermission(
  resolved: ResolvedUserRbacResult,
  moduleKey: SaasModuleKey | string,
  action: GranularAction
): { entitled: boolean; allowed: boolean; scope: DataScope } {
  const canonicalKey = normalizeCanonicalModuleKey(moduleKey) || String(moduleKey);
  const modDesc = SAAS_MODULES_CATALOG.find((m) => m.key === canonicalKey);
  const entitled =
    Boolean(modDesc?.always_enabled) ||
    resolved.enabledModules.includes(canonicalKey) ||
    resolved.enabledModules.includes(String(moduleKey));
  if (!entitled) {
    return { entitled: false, allowed: false, scope: 'none' };
  }
  const perm = resolved.effectivePermissions[canonicalKey] || resolved.effectivePermissions[String(moduleKey)];
  if (!perm || perm.scope === 'none' || !perm.actions?.[action]) {
    return { entitled: true, allowed: false, scope: perm?.scope || 'none' };
  }
  return { entitled: true, allowed: true, scope: perm.scope };
}

/**
 * Zero-Short-Circuit Granular Permission Middleware (`moduleKey` × `action`)
 */
export function requirePermission(moduleKey: SaasModuleKey | string, action: GranularAction) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const resolved = await getResolvedUserRbac(req);
      const check = checkEffectivePermission(resolved, moduleKey, action);
      if (!check.entitled) {
        sendApiError(
          res,
          403,
          'MODULE_NOT_ENTITLED',
          `Phân hệ '${moduleKey}' chưa được mở khóa trong gói cước hiện tại.`
        );
        return;
      }
      if (!check.allowed) {
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
 * Requires AT LEAST ONE `(moduleKey, action)` pair to be both entitled and granted.
 */
export function requireAnyPermission(checks: Array<[SaasModuleKey | string, GranularAction]>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const resolved = await getResolvedUserRbac(req);
      let anyEntitled = false;
      for (const [moduleKey, action] of checks) {
        const resCheck = checkEffectivePermission(resolved, moduleKey, action);
        if (resCheck.entitled) anyEntitled = true;
        if (resCheck.entitled && resCheck.allowed) {
          next();
          return;
        }
      }
      if (!anyEntitled) {
        sendApiError(
          res,
          403,
          'MODULE_NOT_ENTITLED',
          `Phân hệ yêu cầu chưa được mở khóa trong gói cước hiện tại.`
        );
        return;
      }
      sendApiError(
        res,
        403,
        'FORBIDDEN_RBAC_PERMISSION',
        `Tài khoản không có quyền thực hiện thao tác này theo ma trận phân quyền.`
      );
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
