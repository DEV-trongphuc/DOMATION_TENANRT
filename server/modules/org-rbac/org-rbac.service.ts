import crypto from 'node:crypto';
import type { DbClient } from '../../core/database/db-adapter.ts';
import {
  DATA_SCOPES_ORDERED,
  GRANULAR_ACTIONS,
  buildDefaultSystemRoleModulePermission,
  normalizeActionsMap,
  normalizeDataScope,
  parseBoolMapSafe,
  resolveUserEffectivePermissions,
  type DataScope,
} from '../../core/security/rbac.ts';
import {
  INDUSTRY_TERMINOLOGY_PRESETS,
  SAAS_MODULES_CATALOG,
  VALID_INDUSTRY_KEYS,
  buildModulesForPackage,
  normalizeCanonicalModuleKey,
  normalizeIndustryKey,
  resolveTenantEntitlementSnapshot,
  resolveTenantTerminology,
} from '../../core/security/entitlements.ts';
import { normalizeTenantSettings } from '../../core/settings/tenant-settings.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';

export function slugifyCode(raw: unknown, fallbackPrefix = 'ITEM'): string {
  const cleaned = String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (cleaned) return cleaned;
  return `${fallbackPrefix}_${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

export function slugifyKeyLower(raw: unknown, fallbackPrefix = 'custom'): string {
  const cleaned = String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  if (cleaned) return cleaned;
  return `${fallbackPrefix}_${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Idempotently seeds the 3 baseline system roles (`tenant_admin`, `manager`, `sale`)
 * and links unlinked `users.role_id` so every tenant immediately has editable matrices in Settings.
 */
export async function ensureDefaultSystemRolesSeeded(
  client: DbClient,
  tenantId: string
): Promise<void> {
  const existingRes = await client.query<{ id: string; role_key: string }>(
    'SELECT id, role_key FROM tenant_roles WHERE tenant_id = $1',
    [tenantId]
  );
  const byKey = new Map(existingRes.rows.map((r) => [r.role_key.toLowerCase(), r.id]));

  const systemSeeds: Array<{ key: string; name: string; desc: string; scope: DataScope }> = [
    {
      key: 'tenant_admin',
      name: 'Quản trị viên Doanh nghiệp',
      desc: 'Quản trị cấu hình hệ thống, người dùng và dữ liệu toàn công ty.',
      scope: 'company',
    },
    {
      key: 'manager',
      name: 'Trưởng phòng / Quản lý',
      desc: 'Quản lý nhân sự, phê duyệt và theo dõi dữ liệu trong phạm vi phòng ban.',
      scope: 'department',
    },
    {
      key: 'sale',
      name: 'Chuyên viên Kinh doanh / Tư vấn',
      desc: 'Tiếp nhận và chăm sóc dữ liệu khách hàng cá nhân được phân bổ.',
      scope: 'own',
    },
  ];

  const tSettingsRes = await client.query<{ settings: Record<string, any> }>(
    'SELECT settings FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId]
  );
  const sObj = tSettingsRes.rows[0]?.settings || {};
  const legacyRp = sObj.role_permissions || {};

  for (const seed of systemSeeds) {
    let roleId = byKey.get(seed.key);
    if (!roleId) {
      roleId = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_roles (
           id, tenant_id, role_key, name, description, default_data_scope,
           screen_access, quick_actions, default_route, is_system, is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, '{}'::jsonb, '/', true, true)
         ON CONFLICT (tenant_id, role_key) DO NOTHING`,
        [roleId, tenantId, seed.key, seed.name, seed.desc, seed.scope]
      );
      const fetched = await client.query<{ id: string }>(
        'SELECT id FROM tenant_roles WHERE tenant_id = $1 AND role_key = $2 LIMIT 1',
        [tenantId, seed.key]
      );
      roleId = fetched.rows[0]?.id;
      if (roleId) byKey.set(seed.key, roleId);
    }

    if (roleId) {
      const cntRes = await client.query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM tenant_role_permissions WHERE tenant_id = $1 AND role_id = $2',
        [tenantId, roleId]
      );
      if (Number(cntRes.rows[0]?.cnt || 0) < SAAS_MODULES_CATALOG.length) {
        for (const mod of SAAS_MODULES_CATALOG) {
          const defPerm = buildDefaultSystemRoleModulePermission(seed.key, mod.key, {
            allowManagerExportCsv: Boolean(legacyRp.allow_manager_export_csv),
            allowManagerManagePipelines: Boolean(legacyRp.allow_manager_manage_pipelines),
            allowSaleCreateLead: Boolean(legacyRp.allow_sale_create_lead),
            allowSaleReassignLead: Boolean(legacyRp.allow_sale_reassign_lead),
            piiMaskAllSales: Boolean(sObj.pii_mask_all_sales),
          });
          await client.query(
            `INSERT INTO tenant_role_permissions (id, tenant_id, role_id, module_key, data_scope, actions, screen_access, quick_actions)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, '{}'::jsonb)
             ON CONFLICT (tenant_id, role_id, module_key) DO NOTHING`,
            [
              crypto.randomUUID(),
              tenantId,
              roleId,
              mod.key,
              defPerm.data_scope,
              JSON.stringify(defPerm.actions),
            ]
          );
        }
      }

      // Link existing users matching this role_key who have role_id IS NULL
      await client.query(
        `UPDATE users
         SET role_id = $3
         WHERE tenant_id = $1 AND LOWER(role) = $2 AND role_id IS NULL`,
        [tenantId, seed.key, roleId]
      );
    }
  }
}

/**
 * Checks whether setting `parentDepartmentId` on `departmentId` would create a cycle.
 */
export async function wouldCreateDepartmentCycle(
  client: DbClient,
  tenantId: string,
  departmentId: string,
  candidateParentId: string | null | undefined
): Promise<boolean> {
  if (!candidateParentId) return false;
  if (candidateParentId === departmentId) return true;

  const allRes = await client.query<{ id: string; parent_department_id: string | null }>(
    'SELECT id, parent_department_id FROM tenant_departments WHERE tenant_id = $1',
    [tenantId]
  );
  const parentMap = new Map(allRes.rows.map((r) => [r.id, r.parent_department_id]));

  let cursor: string | null | undefined = candidateParentId;
  const visited = new Set<string>([departmentId]);
  while (cursor) {
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = parentMap.get(cursor) || null;
  }
  return false;
}

export async function upsertRolePermissionsBatch(
  client: DbClient,
  tenantId: string,
  roleId: string,
  items: Array<{
    module_key: string;
    data_scope?: string;
    scope?: string;
    actions?: unknown;
    screen_access?: unknown;
    quick_actions?: unknown;
  }>
): Promise<any[]> {
  const existingRes = await client.query<{
    module_key: string;
    screen_access?: unknown;
    quick_actions?: unknown;
  }>(
    'SELECT module_key, screen_access, quick_actions FROM tenant_role_permissions WHERE tenant_id = $1 AND role_id = $2',
    [tenantId, roleId]
  );
  const existingMap = new Map(existingRes.rows.map((r) => [r.module_key, r]));

  for (const item of items) {
    const mKey = normalizeCanonicalModuleKey(item?.module_key);
    if (!mKey) continue;
    const scope = normalizeDataScope(item.data_scope ?? item.scope, 'none');
    const actions = normalizeActionsMap(item.actions);
    const prev = existingMap.get(mKey);
    const screenAccess =
      item.screen_access !== undefined
        ? parseBoolMapSafe(item.screen_access)
        : parseBoolMapSafe(prev?.screen_access);
    const quickActions =
      item.quick_actions !== undefined
        ? parseBoolMapSafe(item.quick_actions)
        : parseBoolMapSafe(prev?.quick_actions);

    await client.query(
      `INSERT INTO tenant_role_permissions (id, tenant_id, role_id, module_key, data_scope, actions, screen_access, quick_actions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
       ON CONFLICT (tenant_id, role_id, module_key)
       DO UPDATE SET
         data_scope = EXCLUDED.data_scope,
         actions = EXCLUDED.actions,
         screen_access = EXCLUDED.screen_access,
         quick_actions = EXCLUDED.quick_actions,
         updated_at = clock_timestamp()`,
      [
        crypto.randomUUID(),
        tenantId,
        roleId,
        mKey,
        scope,
        JSON.stringify(actions),
        JSON.stringify(screenAccess),
        JSON.stringify(quickActions),
      ]
    );
  }

  tenantRedis.invalidateEffectivePermissions(tenantId);

  const res = await client.query(
    'SELECT * FROM tenant_role_permissions WHERE tenant_id = $1 AND role_id = $2 ORDER BY module_key ASC',
    [tenantId, roleId]
  );
  return res.rows;
}

export async function upsertDepartmentPermissionsBatch(
  client: DbClient,
  tenantId: string,
  departmentId: string,
  items: Array<{ module_key: string; data_scope?: string; scope?: string; actions?: unknown }>
): Promise<any[]> {
  for (const item of items) {
    const mKey = normalizeCanonicalModuleKey(item?.module_key);
    if (!mKey) continue;
    const scope = normalizeDataScope(item.data_scope ?? item.scope, 'none');
    const actions = normalizeActionsMap(item.actions);
    await client.query(
      `INSERT INTO tenant_department_permissions (id, tenant_id, department_id, module_key, data_scope, actions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (tenant_id, department_id, module_key)
       DO UPDATE SET
         data_scope = EXCLUDED.data_scope,
         actions = EXCLUDED.actions,
         updated_at = clock_timestamp()`,
      [crypto.randomUUID(), tenantId, departmentId, mKey, scope, JSON.stringify(actions)]
    );
  }

  tenantRedis.invalidateEffectivePermissions(tenantId);

  const res = await client.query(
    'SELECT * FROM tenant_department_permissions WHERE tenant_id = $1 AND department_id = $2 ORDER BY module_key ASC',
    [tenantId, departmentId]
  );
  return res.rows;
}

export async function updateTenantTerminologyAndEcosystemSettings(
  client: DbClient,
  tenantId: string,
  input: {
    industry_key?: unknown;
    apply_preset?: boolean;
    terminology?: Record<string, unknown> | null;
    education_addon?: boolean;
    enable_ideas_mascot?: boolean;
    revenue_source?: string;
    brand_logo_url?: string;
    brand_display_name?: string;
    ai_agent_name?: string;
    ai_avatar_url?: string;
    pipeline_tabs?: Array<Record<string, unknown>>;
  }
) {
  const curRes = await client.query<{
    id: string;
    slug: string;
    name: string;
    industry: string;
    industry_key: string;
    package_code: string;
    plan_tier: string;
    subscription_plan_code: string | null;
    crm_erp_upgrade_status: string | null;
    enabled_modules: unknown;
    entitlements: Record<string, unknown>;
    settings: Record<string, unknown>;
  }>(
    `SELECT id, slug, name, industry, industry_key, package_code, plan_tier,
            subscription_plan_code, crm_erp_upgrade_status, enabled_modules, entitlements, settings
     FROM tenants
     WHERE id = $1
     FOR UPDATE`,
    [tenantId]
  );
  const cur = curRes.rows[0];
  if (!cur) throw new Error('TENANT_NOT_FOUND');

  const curSettings = cur.settings && typeof cur.settings === 'object' ? cur.settings : {};
  const curEnt = cur.entitlements && typeof cur.entitlements === 'object' ? cur.entitlements : {};

  const nextIndustryKey =
    input.industry_key !== undefined
      ? normalizeIndustryKey(input.industry_key)
      : normalizeIndustryKey(cur.industry_key || curSettings.industry_key || cur.industry);

  // If apply_preset is true, clear custom terminology overrides so industry preset shines cleanly
  let nextTerminologyOverrides: Record<string, unknown> =
    input.apply_preset
      ? {}
      : curSettings.terminology && typeof curSettings.terminology === 'object'
        ? { ...(curSettings.terminology as Record<string, unknown>) }
        : {};

  if (input.terminology && typeof input.terminology === 'object') {
    if (input.apply_preset) {
      nextTerminologyOverrides = { ...input.terminology };
    } else {
      nextTerminologyOverrides = { ...nextTerminologyOverrides, ...input.terminology };
    }
  }

  const nextEduAddon =
    input.education_addon !== undefined
      ? Boolean(input.education_addon)
      : input.industry_key !== undefined && nextIndustryKey === 'education'
        ? true
        : Boolean(curEnt.education_addon ?? curSettings.education_addon ?? false);

  const nextMascot =
    input.enable_ideas_mascot !== undefined
      ? Boolean(input.enable_ideas_mascot)
      : Boolean(curEnt.enable_ideas_mascot ?? curSettings.enable_ideas_mascot ?? false);

  const mergedSettings = normalizeTenantSettings({
    ...curSettings,
    industry_key: nextIndustryKey,
    terminology: nextTerminologyOverrides,
    education_addon: nextEduAddon,
    enable_ideas_mascot: nextMascot,
    ...(input.revenue_source !== undefined ? { revenue_source: input.revenue_source } : {}),
    ...(input.brand_logo_url !== undefined ? { brand_logo_url: input.brand_logo_url } : {}),
    ...(input.brand_display_name !== undefined ? { brand_display_name: input.brand_display_name } : {}),
    ...(input.ai_agent_name !== undefined ? { ai_agent_name: input.ai_agent_name } : {}),
    ...(input.ai_avatar_url !== undefined ? { ai_avatar_url: input.ai_avatar_url } : {}),
    ...(input.pipeline_tabs !== undefined ? { pipeline_tabs: input.pipeline_tabs } : {}),
  });

  const currentSnap = resolveTenantEntitlementSnapshot({
    ...cur,
    industry_key: nextIndustryKey,
    settings: mergedSettings,
    entitlements: {
      ...curEnt,
      education_addon: nextEduAddon,
      enable_ideas_mascot: nextMascot,
    },
  });

  const nextModules = buildModulesForPackage(currentSnap.package_code, {
    educationAddon: nextEduAddon,
  });

  const nextEntitlements = {
    ...currentSnap.entitlements,
    package_code: currentSnap.package_code,
    education_addon: nextEduAddon,
    enable_ideas_mascot: nextMascot,
  };

  await client.query(
    `UPDATE tenants
     SET industry = $2,
         industry_key = $2,
         enabled_modules = $3::jsonb,
         entitlements = $4::jsonb,
         settings = $5::jsonb,
         updated_at = clock_timestamp()
     WHERE id = $1`,
    [
      tenantId,
      nextIndustryKey,
      JSON.stringify(nextModules),
      JSON.stringify(nextEntitlements),
      JSON.stringify(mergedSettings),
    ]
  );

  tenantRedis.invalidateTenantCache(tenantId, cur.slug);

  return {
    slug: cur.slug,
    industry_key: nextIndustryKey,
    terminology: resolveTenantTerminology(nextIndustryKey, mergedSettings.terminology),
    terminology_overrides: mergedSettings.terminology,
    education_addon: nextEduAddon,
    enable_ideas_mascot: nextMascot,
    revenue_source: mergedSettings.revenue_source,
    brand_logo_url: mergedSettings.brand_logo_url,
    ai_agent_name: mergedSettings.ai_agent_name,
    ai_avatar_url: mergedSettings.ai_avatar_url,
    pipeline_tabs: mergedSettings.pipeline_tabs,
    enabled_modules: nextModules,
    entitlements: nextEntitlements,
    industry_presets: INDUSTRY_TERMINOLOGY_PRESETS,
    valid_industries: VALID_INDUSTRY_KEYS,
  };
}

export async function renderPolicyDocumentPreview(
  client: DbClient,
  tenantId: string,
  contentHtml: string
): Promise<string> {
  const [tRes, bRes] = await Promise.all([
    client.query<{ name: string; domain: string | null; settings: Record<string, any> }>(
      'SELECT name, domain, settings FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId]
    ),
    client.query<{
      name: string;
      legal_entity_name: string | null;
      tax_code: string | null;
      representative_name: string | null;
      representative_title: string | null;
      address: string | null;
      phone: string | null;
      email: string | null;
    }>(
      `SELECT name, legal_entity_name, tax_code, representative_name, representative_title, address, phone, email
       FROM tenant_branches
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY is_headquarters DESC, created_at ASC
       LIMIT 1`,
      [tenantId]
    ),
  ]);

  const t = tRes.rows[0];
  const hq = bRes.rows[0];
  const vars: Record<string, string> = {
    'company.name': t?.settings?.brand_display_name || t?.name || 'Doanh nghiệp',
    'company.legal_name': hq?.legal_entity_name || t?.name || 'Doanh nghiệp',
    'company.tax_code': hq?.tax_code || '',
    'company.domain': t?.domain || '',
    'branch.name': hq?.name || 'Trụ sở chính',
    'branch.representative': hq?.representative_name || '',
    'branch.representative_title': hq?.representative_title || 'Đại diện Pháp luật',
    'branch.address': hq?.address || '',
    'branch.phone': hq?.phone || '',
    'branch.email': hq?.email || t?.settings?.support_email || '',
  };

  return String(contentHtml || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, k: string) => {
    return vars[k] !== undefined ? vars[k] : `{{${k}}}`;
  });
}

export async function getOrgRbacBootstrapPayload(
  client: DbClient,
  tenantId: string,
  userId: string
) {
  await ensureDefaultSystemRolesSeeded(client, tenantId);

  const [
    tenantRes,
    branchesRes,
    deptsRes,
    teamsRes,
    positionsRes,
    rolesRes,
    rolePermsRes,
    deptPermsRes,
    overridesRes,
    stageRulesRes,
    kpisRes,
    policiesRes,
    usersRes,
    customFieldsRes,
    leadScoringRes,
    notificationRulesRes,
    emailTemplatesRes,
    entityTabsRes,
    tagsRes,
    resolvedRbac,
  ] = await Promise.all([
    client.query(
      `SELECT id, slug, name, industry, industry_key, package_code, plan_tier,
              subscription_plan_code, crm_erp_upgrade_status, enabled_modules, entitlements, settings
       FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    ),
    client.query('SELECT * FROM tenant_branches WHERE tenant_id = $1 ORDER BY is_headquarters DESC, created_at ASC', [
      tenantId,
    ]),
    client.query('SELECT * FROM tenant_departments WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC', [
      tenantId,
    ]),
    client.query('SELECT * FROM tenant_teams WHERE tenant_id = $1 ORDER BY created_at ASC', [tenantId]),
    client.query('SELECT * FROM tenant_positions WHERE tenant_id = $1 ORDER BY level_rank DESC, created_at ASC', [
      tenantId,
    ]),
    client.query('SELECT * FROM tenant_roles WHERE tenant_id = $1 ORDER BY is_system DESC, created_at ASC', [
      tenantId,
    ]),
    client.query('SELECT * FROM tenant_role_permissions WHERE tenant_id = $1 ORDER BY module_key ASC', [tenantId]),
    client.query('SELECT * FROM tenant_department_permissions WHERE tenant_id = $1 ORDER BY module_key ASC', [
      tenantId,
    ]),
    client.query(
      `SELECT ov.*, u.full_name AS user_name, u.email AS user_email
       FROM tenant_user_permission_overrides ov
       LEFT JOIN users u ON u.tenant_id = ov.tenant_id AND u.id = ov.user_id
       WHERE ov.tenant_id = $1
       ORDER BY ov.created_at DESC`,
      [tenantId]
    ),
    client.query('SELECT * FROM tenant_stage_transition_rules WHERE tenant_id = $1 ORDER BY created_at ASC', [
      tenantId,
    ]),
    client.query('SELECT * FROM tenant_custom_kpis WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC', [
      tenantId,
    ]),
    client.query('SELECT * FROM tenant_policy_documents WHERE tenant_id = $1 ORDER BY updated_at DESC', [tenantId]),
    client.query(
      `SELECT id, full_name, email, phone, role, role_id, branch_id, department_id, team_id,
              position_id, reports_to_user_id, is_tenant_owner, is_system_bot, is_external_agency
       FROM users
       WHERE tenant_id = $1
       ORDER BY is_tenant_owner DESC, created_at ASC`,
      [tenantId]
    ),
    client.query(
      'SELECT * FROM tenant_custom_fields WHERE tenant_id = $1 ORDER BY entity_type ASC, sort_order ASC, created_at ASC',
      [tenantId]
    ),
    client.query(
      'SELECT * FROM tenant_lead_scoring_rules WHERE tenant_id = $1 ORDER BY priority ASC, created_at ASC',
      [tenantId]
    ),
    client.query(
      'SELECT * FROM tenant_notification_rules WHERE tenant_id = $1 ORDER BY event_key ASC, created_at ASC',
      [tenantId]
    ),
    client.query(
      'SELECT * FROM tenant_email_templates WHERE tenant_id = $1 ORDER BY is_system DESC, created_at DESC',
      [tenantId]
    ),
    client.query(
      'SELECT * FROM tenant_entity_tabs WHERE tenant_id = $1 ORDER BY entity_type ASC, sort_order ASC, created_at ASC',
      [tenantId]
    ),
    client.query('SELECT * FROM tenant_tags WHERE tenant_id = $1 ORDER BY name ASC', [tenantId]),
    resolveUserEffectivePermissions(client, tenantId, userId),
  ]);

  const tRow = tenantRes.rows[0] || {};
  const entSnap = resolveTenantEntitlementSnapshot(tRow);
  const normSettings = normalizeTenantSettings(tRow.settings);

  return {
    branches: branchesRes.rows,
    departments: deptsRes.rows,
    teams: teamsRes.rows,
    positions: positionsRes.rows,
    roles: rolesRes.rows,
    role_permissions: rolePermsRes.rows,
    department_permissions: deptPermsRes.rows,
    user_overrides: overridesRes.rows,
    users_org: usersRes.rows,
    stage_rules: stageRulesRes.rows,
    stage_transition_rules: stageRulesRes.rows,
    custom_kpis: kpisRes.rows,
    policies: policiesRes.rows,
    policy_documents: policiesRes.rows,
    custom_fields: customFieldsRes.rows,
    lead_scoring_rules: leadScoringRes.rows,
    notification_rules: notificationRulesRes.rows,
    email_templates: emailTemplatesRes.rows,
    entity_tabs: entityTabsRes.rows,
    tags: tagsRes.rows,
    industry_key: entSnap.industry_key,
    terminology: entSnap.terminology,
    terminology_overrides: normSettings.terminology,
    education_addon: entSnap.entitlements.education_addon,
    enable_ideas_mascot: entSnap.entitlements.enable_ideas_mascot,
    revenue_source: normSettings.revenue_source,
    brand_logo_url: normSettings.brand_logo_url,
    ai_agent_name: normSettings.ai_agent_name,
    ai_avatar_url: normSettings.ai_avatar_url,
    pipeline_tabs: normSettings.pipeline_tabs,
    effective_permissions: resolvedRbac.effectivePermissions,
    screen_access: resolvedRbac.screen_access,
    quick_actions: resolvedRbac.quick_actions,
    default_route: resolvedRbac.default_route,
    is_tenant_owner: Boolean(resolvedRbac.userOrg?.is_tenant_owner),
    industry_presets: INDUSTRY_TERMINOLOGY_PRESETS,
    modules_catalog: SAAS_MODULES_CATALOG,
    scopes_catalog: DATA_SCOPES_ORDERED,
    actions_catalog: GRANULAR_ACTIONS,
  };
}
