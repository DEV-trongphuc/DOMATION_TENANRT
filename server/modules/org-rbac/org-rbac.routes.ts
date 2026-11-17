import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import {
  DATA_SCOPES_ORDERED,
  GRANULAR_ACTIONS,
  normalizeActionsMap,
  normalizeDataScope,
  parseBoolMapSafe,
  requirePermission,
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../../core/security/rbac.ts';
import { executeMasterCron } from '../../cron/master-cron.ts';
import { ensureOrgRbacSchemaMiddleware } from './schema.ts';
import {
  INDUSTRY_TERMINOLOGY_PRESETS,
  SAAS_MODULES_CATALOG,
  VALID_INDUSTRY_KEYS,
  normalizeCanonicalModuleKey,
  resolveTenantEntitlementSnapshot,
} from '../../core/security/entitlements.ts';
import { normalizeTenantSettings } from '../../core/settings/tenant-settings.ts';
import {
  ensureDefaultSystemRolesSeeded,
  getOrgRbacBootstrapPayload,
  renderPolicyDocumentPreview,
  slugifyCode,
  slugifyKeyLower,
  updateTenantTerminologyAndEcosystemSettings,
  upsertDepartmentPermissionsBatch,
  upsertRolePermissionsBatch,
  wouldCreateDepartmentCycle,
} from './org-rbac.service.ts';
import { compileSegmentWhereSql } from '../audiences/segment-compiler.ts';

export const orgRbacRouter = Router();

orgRbacRouter.use(requireTenantAuth);
orgRbacRouter.use(ensureOrgRbacSchemaMiddleware);

function normalizeIpWhitelistInput(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 100)
      )
    );
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return normalizeIpWhitelistInput(parsed);
        }
      } catch {
        // Fallback to comma/newline split
      }
    }
    return Array.from(
      new Set(
        trimmed
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 100)
      )
    );
  }
  return [];
}

// ============================================================================
// 1. Unified Settings Bootstrap & Effective Permissions
// ============================================================================
orgRbacRouter.get(['/bootstrap', '/overview'], async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, (client) =>
      getOrgRbacBootstrapPayload(client, ctx.tenantId, ctx.userId)
    );
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'ORG_RBAC_BOOTSTRAP_FAILED', err?.message || 'Không thể tải cấu hình Tổ chức & Phân quyền.');
  }
});

orgRbacRouter.get('/effective-permissions', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const targetUserId = req.query.user_id ? String(req.query.user_id).trim() : ctx.userId;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (targetUserId !== ctx.userId) {
        const callerPerm = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
        if (!callerPerm.effectivePermissions.org_rbac?.actions.view) {
          throw new Error('FORBIDDEN_INSPECT_OTHER_USER');
        }
      }
      const resolved = await resolveUserEffectivePermissions(client, ctx.tenantId, targetUserId);
      return {
        user_id: targetUserId,
        user_org: resolved.userOrg,
        is_tenant_owner: Boolean(resolved.userOrg?.is_tenant_owner),
        enabled_modules: resolved.enabledModules,
        effective_permissions: resolved.effectivePermissions,
        screen_access: resolved.screen_access,
        quick_actions: resolved.quick_actions,
        default_route: resolved.default_route,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_INSPECT_OTHER_USER') {
      sendApiError(res, 403, 'FORBIDDEN_RBAC_PERMISSION', 'Không có quyền xem ma trận phân quyền của nhân sự khác.');
      return;
    }
    sendApiError(res, 500, 'EFFECTIVE_PERMISSIONS_FAILED', err?.message || 'Không thể tính toán quyền hiệu lực.');
  }
});

// ============================================================================
// 2. Branches CRUD (`/api/v1/org-rbac/branches`)
// ============================================================================
orgRbacRouter.get('/branches', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_branches WHERE tenant_id = $1 ORDER BY is_headquarters DESC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_BRANCHES_FAILED', err?.message || 'Không thể tải danh sách chi nhánh.');
  }
});

orgRbacRouter.post('/branches', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên chi nhánh không được để trống.');
      return;
    }
    const code = slugifyCode(b.code || name, 'BR');
    const id = crypto.randomUUID();

    const branchIpWhitelist = normalizeIpWhitelistInput(b.branch_ip_whitelist);

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (b.is_headquarters) {
        await client.query('UPDATE tenant_branches SET is_headquarters = false WHERE tenant_id = $1', [ctx.tenantId]);
      }
      await client.query(
        `INSERT INTO tenant_branches (
           id, tenant_id, code, name, legal_entity_name, tax_code,
           representative_name, representative_title, address, phone, email,
           gps_lat, gps_lng, gps_radius_meters, work_schedule, branch_ip_whitelist, is_headquarters, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18)`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          b.legal_entity_name ? String(b.legal_entity_name).trim() : null,
          b.tax_code ? String(b.tax_code).trim() : null,
          b.representative_name ? String(b.representative_name).trim() : null,
          b.representative_title ? String(b.representative_title).trim() : null,
          b.address ? String(b.address).trim() : null,
          b.phone ? String(b.phone).trim() : null,
          b.email ? String(b.email).trim() : null,
          b.gps_lat !== undefined && b.gps_lat !== null && b.gps_lat !== '' ? Number(b.gps_lat) : null,
          b.gps_lng !== undefined && b.gps_lng !== null && b.gps_lng !== '' ? Number(b.gps_lng) : null,
          Math.max(10, Math.min(50_000, Number(b.gps_radius_meters || 150))),
          JSON.stringify(b.work_schedule && typeof b.work_schedule === 'object' ? b.work_schedule : {}),
          JSON.stringify(branchIpWhitelist),
          Boolean(b.is_headquarters),
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_branches WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_BRANCH_FAILED', err?.message || 'Không thể tạo chi nhánh.');
  }
});

const updateBranchHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const id = req.params.id;
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (b.is_headquarters === true) {
        await client.query(
          'UPDATE tenant_branches SET is_headquarters = false WHERE tenant_id = $1 AND id != $2',
          [ctx.tenantId, id]
        );
      }
      const r = await client.query(
        `UPDATE tenant_branches
         SET name = COALESCE($3, name),
             code = COALESCE($4, code),
             legal_entity_name = CASE WHEN $5::boolean THEN $6 ELSE legal_entity_name END,
             tax_code = CASE WHEN $7::boolean THEN $8 ELSE tax_code END,
             representative_name = CASE WHEN $9::boolean THEN $10 ELSE representative_name END,
             representative_title = CASE WHEN $11::boolean THEN $12 ELSE representative_title END,
             address = CASE WHEN $13::boolean THEN $14 ELSE address END,
             phone = CASE WHEN $15::boolean THEN $16 ELSE phone END,
             email = CASE WHEN $17::boolean THEN $18 ELSE email END,
             gps_lat = CASE WHEN $19::boolean THEN $20 ELSE gps_lat END,
             gps_lng = CASE WHEN $21::boolean THEN $22 ELSE gps_lng END,
             gps_radius_meters = COALESCE($23, gps_radius_meters),
             work_schedule = COALESCE($24::jsonb, work_schedule),
             branch_ip_whitelist = COALESCE($25::jsonb, branch_ip_whitelist),
             is_headquarters = COALESCE($26, is_headquarters),
             is_active = COALESCE($27, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          id,
          b.name ? String(b.name).trim() : null,
          b.code ? slugifyCode(b.code, 'BR') : null,
          b.legal_entity_name !== undefined,
          b.legal_entity_name ? String(b.legal_entity_name).trim() : null,
          b.tax_code !== undefined,
          b.tax_code ? String(b.tax_code).trim() : null,
          b.representative_name !== undefined,
          b.representative_name ? String(b.representative_name).trim() : null,
          b.representative_title !== undefined,
          b.representative_title ? String(b.representative_title).trim() : null,
          b.address !== undefined,
          b.address ? String(b.address).trim() : null,
          b.phone !== undefined,
          b.phone ? String(b.phone).trim() : null,
          b.email !== undefined,
          b.email ? String(b.email).trim() : null,
          b.gps_lat !== undefined,
          b.gps_lat !== null && b.gps_lat !== '' ? Number(b.gps_lat) : null,
          b.gps_lng !== undefined,
          b.gps_lng !== null && b.gps_lng !== '' ? Number(b.gps_lng) : null,
          b.gps_radius_meters !== undefined ? Math.max(10, Number(b.gps_radius_meters)) : null,
          b.work_schedule !== undefined ? JSON.stringify(b.work_schedule) : null,
          b.branch_ip_whitelist !== undefined ? JSON.stringify(normalizeIpWhitelistInput(b.branch_ip_whitelist)) : null,
          typeof b.is_headquarters === 'boolean' ? b.is_headquarters : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'BRANCH_NOT_FOUND', 'Không tìm thấy chi nhánh.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_BRANCH_FAILED', err?.message || 'Không thể cập nhật chi nhánh.');
  }
};

orgRbacRouter.put('/branches/:id', requirePermission('org_rbac', 'manage_config'), updateBranchHandler);
orgRbacRouter.patch('/branches/:id', requirePermission('org_rbac', 'manage_config'), updateBranchHandler);

orgRbacRouter.delete('/branches/:id', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('UPDATE users SET branch_id = NULL WHERE tenant_id = $1 AND branch_id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      await client.query('DELETE FROM tenant_branches WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_BRANCH_FAILED', err?.message || 'Không thể xóa chi nhánh.');
  }
});

// ============================================================================
// 3. Multi-Level Departments CRUD (`/api/v1/org-rbac/departments`)
// ============================================================================
orgRbacRouter.get('/departments', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_departments WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_DEPARTMENTS_FAILED', err?.message || 'Không thể tải danh sách phòng ban.');
  }
});

orgRbacRouter.post('/departments', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên phòng ban không được để trống.');
      return;
    }
    const code = slugifyCode(b.code || name, 'DEPT');
    const id = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_departments (
           id, tenant_id, branch_id, parent_department_id, code, name, description,
           manager_user_id, default_role_id, sort_order, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          ctx.tenantId,
          b.branch_id || null,
          b.parent_department_id || null,
          code,
          name,
          b.description ? String(b.description).trim() : null,
          b.manager_user_id || null,
          b.default_role_id || null,
          Number(b.sort_order || 0),
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_departments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_DEPARTMENT_FAILED', err?.message || 'Không thể tạo phòng ban.');
  }
});

const updateDepartmentHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const id = req.params.id;
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (b.parent_department_id !== undefined) {
        const cycle = await wouldCreateDepartmentCycle(
          client,
          ctx.tenantId,
          id,
          b.parent_department_id || null
        );
        if (cycle) {
          throw new Error('DEPARTMENT_HIERARCHY_CYCLE');
        }
      }

      const r = await client.query(
        `UPDATE tenant_departments
         SET name = COALESCE($3, name),
             code = COALESCE($4, code),
             branch_id = CASE WHEN $5::boolean THEN $6 ELSE branch_id END,
             parent_department_id = CASE WHEN $7::boolean THEN $8 ELSE parent_department_id END,
             description = CASE WHEN $9::boolean THEN $10 ELSE description END,
             manager_user_id = CASE WHEN $11::boolean THEN $12 ELSE manager_user_id END,
             default_role_id = CASE WHEN $13::boolean THEN $14 ELSE default_role_id END,
             sort_order = COALESCE($15, sort_order),
             is_active = COALESCE($16, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          id,
          b.name ? String(b.name).trim() : null,
          b.code ? slugifyCode(b.code, 'DEPT') : null,
          b.branch_id !== undefined,
          b.branch_id || null,
          b.parent_department_id !== undefined,
          b.parent_department_id || null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          b.manager_user_id !== undefined,
          b.manager_user_id || null,
          b.default_role_id !== undefined,
          b.default_role_id || null,
          b.sort_order !== undefined ? Number(b.sort_order) : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });

    if (!updated) {
      sendApiError(res, 404, 'DEPARTMENT_NOT_FOUND', 'Không tìm thấy phòng ban.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    if (err?.message === 'DEPARTMENT_HIERARCHY_CYCLE') {
      sendApiError(res, 422, 'DEPARTMENT_HIERARCHY_CYCLE', 'Không thể chọn phòng ban trực thuộc chính nó (vòng lặp phân cấp).');
      return;
    }
    sendApiError(res, 500, 'UPDATE_DEPARTMENT_FAILED', err?.message || 'Không thể cập nhật phòng ban.');
  }
};

orgRbacRouter.put('/departments/:id', requirePermission('org_rbac', 'manage_config'), updateDepartmentHandler);
orgRbacRouter.patch('/departments/:id', requirePermission('org_rbac', 'manage_config'), updateDepartmentHandler);

orgRbacRouter.delete('/departments/:id', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('UPDATE users SET department_id = NULL WHERE tenant_id = $1 AND department_id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      await client.query(
        'UPDATE tenant_departments SET parent_department_id = NULL WHERE tenant_id = $1 AND parent_department_id = $2',
        [ctx.tenantId, req.params.id]
      );
      await client.query('DELETE FROM tenant_departments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_DEPARTMENT_FAILED', err?.message || 'Không thể xóa phòng ban.');
  }
});

// ============================================================================
// 4. Teams & Positions CRUD (`/teams`, `/positions`)
// ============================================================================
orgRbacRouter.get('/teams', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_teams WHERE tenant_id = $1 ORDER BY created_at ASC', [
        ctx.tenantId,
      ]);
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TEAMS_FAILED', err?.message || 'Không thể tải danh sách đội nhóm.');
  }
});

orgRbacRouter.post('/teams', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên đội nhóm không được để trống.');
      return;
    }
    const id = crypto.randomUUID();
    const code = slugifyCode(b.code || name, 'TEAM');

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_teams (id, tenant_id, department_id, branch_id, code, name, description, leader_user_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          ctx.tenantId,
          b.department_id || null,
          b.branch_id || null,
          code,
          name,
          b.description ? String(b.description).trim() : null,
          b.leader_user_id || null,
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_teams WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TEAM_FAILED', err?.message || 'Không thể tạo đội nhóm.');
  }
});

const updateTeamHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_teams
         SET name = COALESCE($3, name),
             code = COALESCE($4, code),
             department_id = CASE WHEN $5::boolean THEN $6 ELSE department_id END,
             branch_id = CASE WHEN $7::boolean THEN $8 ELSE branch_id END,
             description = CASE WHEN $9::boolean THEN $10 ELSE description END,
             leader_user_id = CASE WHEN $11::boolean THEN $12 ELSE leader_user_id END,
             is_active = COALESCE($13, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.code ? slugifyCode(b.code, 'TEAM') : null,
          b.department_id !== undefined,
          b.department_id || null,
          b.branch_id !== undefined,
          b.branch_id || null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          b.leader_user_id !== undefined,
          b.leader_user_id || null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'TEAM_NOT_FOUND', 'Không tìm thấy đội nhóm.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_TEAM_FAILED', err?.message || 'Không thể cập nhật đội nhóm.');
  }
};

orgRbacRouter.put('/teams/:id', requirePermission('org_rbac', 'manage_config'), updateTeamHandler);
orgRbacRouter.patch('/teams/:id', requirePermission('org_rbac', 'manage_config'), updateTeamHandler);

orgRbacRouter.delete('/teams/:id', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('UPDATE users SET team_id = NULL WHERE tenant_id = $1 AND team_id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      await client.query('DELETE FROM tenant_teams WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, req.params.id]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_TEAM_FAILED', err?.message || 'Không thể xóa đội nhóm.');
  }
});

orgRbacRouter.get('/positions', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_positions WHERE tenant_id = $1 ORDER BY level_rank DESC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_POSITIONS_FAILED', err?.message || 'Không thể tải danh sách chức danh.');
  }
});

orgRbacRouter.post('/positions', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên chức danh không được để trống.');
      return;
    }
    const id = crypto.randomUUID();
    const code = slugifyCode(b.code || name, 'POS');

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_positions (id, tenant_id, department_id, code, name, level_rank, description, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          ctx.tenantId,
          b.department_id || null,
          code,
          name,
          Math.max(1, Math.min(99, Number(b.level_rank || 1))),
          b.description ? String(b.description).trim() : null,
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_positions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_POSITION_FAILED', err?.message || 'Không thể tạo chức danh.');
  }
});

const updatePositionHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_positions
         SET name = COALESCE($3, name),
             code = COALESCE($4, code),
             department_id = CASE WHEN $5::boolean THEN $6 ELSE department_id END,
             level_rank = COALESCE($7, level_rank),
             description = CASE WHEN $8::boolean THEN $9 ELSE description END,
             is_active = COALESCE($10, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.code ? slugifyCode(b.code, 'POS') : null,
          b.department_id !== undefined,
          b.department_id || null,
          b.level_rank !== undefined ? Math.max(1, Number(b.level_rank)) : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'POSITION_NOT_FOUND', 'Không tìm thấy chức danh.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_POSITION_FAILED', err?.message || 'Không thể cập nhật chức danh.');
  }
};

orgRbacRouter.put('/positions/:id', requirePermission('org_rbac', 'manage_config'), updatePositionHandler);
orgRbacRouter.patch('/positions/:id', requirePermission('org_rbac', 'manage_config'), updatePositionHandler);

orgRbacRouter.delete('/positions/:id', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('UPDATE users SET position_id = NULL WHERE tenant_id = $1 AND position_id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      await client.query('DELETE FROM tenant_positions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_POSITION_FAILED', err?.message || 'Không thể xóa chức danh.');
  }
});

// ============================================================================
// 5. Roles & Granular Permission Matrices (`/roles`, `/permissions`, `/user-overrides`)
// ============================================================================
orgRbacRouter.get('/roles', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultSystemRolesSeeded(client, ctx.tenantId);
      const r = await client.query(
        'SELECT * FROM tenant_roles WHERE tenant_id = $1 ORDER BY is_system DESC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ROLES_FAILED', err?.message || 'Không thể tải danh sách vai trò.');
  }
});

orgRbacRouter.post('/roles', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên vai trò không được để trống.');
      return;
    }
    const roleKey = slugifyKeyLower(b.role_key || name, 'role');
    const defaultScope = normalizeDataScope(b.default_data_scope, 'own');
    const screenAccess = parseBoolMapSafe(b.screen_access);
    const quickActions = parseBoolMapSafe(b.quick_actions);
    const defaultRoute = b.default_route ? String(b.default_route).trim().slice(0, 120) || '/' : '/';
    const id = crypto.randomUUID();

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultSystemRolesSeeded(client, ctx.tenantId);
      await client.query(
        `INSERT INTO tenant_roles (
           id, tenant_id, role_key, name, description, default_data_scope,
           screen_access, quick_actions, default_route, is_system, is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, false, $10)`,
        [
          id,
          ctx.tenantId,
          roleKey,
          name,
          b.description ? String(b.description).trim() : null,
          defaultScope,
          JSON.stringify(screenAccess),
          JSON.stringify(quickActions),
          defaultRoute,
          b.is_active !== false,
        ]
      );
      if (Array.isArray(b.permissions) && b.permissions.length > 0) {
        await upsertRolePermissionsBatch(client, ctx.tenantId, id, b.permissions);
      }
      const r = await client.query('SELECT * FROM tenant_roles WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_ROLE_FAILED', err?.message || 'Không thể tạo vai trò mới.');
  }
});

const updateRoleHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_roles
         SET name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             default_data_scope = COALESCE($6, default_data_scope),
             screen_access = COALESCE($7::jsonb, screen_access),
             quick_actions = COALESCE($8::jsonb, quick_actions),
             default_route = COALESCE($9, default_route),
             is_active = COALESCE($10, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          b.default_data_scope ? normalizeDataScope(b.default_data_scope, 'own') : null,
          b.screen_access !== undefined ? JSON.stringify(parseBoolMapSafe(b.screen_access)) : null,
          b.quick_actions !== undefined ? JSON.stringify(parseBoolMapSafe(b.quick_actions)) : null,
          b.default_route !== undefined ? String(b.default_route || '/').trim().slice(0, 120) || '/' : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      if (r.rows[0] && Array.isArray(b.permissions)) {
        await upsertRolePermissionsBatch(client, ctx.tenantId, req.params.id, b.permissions);
      }
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'ROLE_NOT_FOUND', 'Không tìm thấy vai trò.');
      return;
    }
    tenantRedis.invalidateEffectivePermissions(ctx.tenantId);
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ROLE_FAILED', err?.message || 'Không thể cập nhật vai trò.');
  }
};

orgRbacRouter.put('/roles/:id', requirePermission('org_rbac', 'manage_config'), updateRoleHandler);
orgRbacRouter.patch('/roles/:id', requirePermission('org_rbac', 'manage_config'), updateRoleHandler);

orgRbacRouter.delete('/roles/:id', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      const check = await client.query<{ is_system: boolean }>(
        'SELECT is_system FROM tenant_roles WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, req.params.id]
      );
      if (check.rows[0]?.is_system) {
        throw new Error('CANNOT_DELETE_SYSTEM_ROLE');
      }
      await client.query('UPDATE users SET role_id = NULL WHERE tenant_id = $1 AND role_id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
      await client.query('DELETE FROM tenant_roles WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, req.params.id]);
    });
    tenantRedis.invalidateEffectivePermissions(ctx.tenantId);
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    if (err?.message === 'CANNOT_DELETE_SYSTEM_ROLE') {
      sendApiError(res, 422, 'CANNOT_DELETE_SYSTEM_ROLE', 'Vai trò mặc định của hệ thống chỉ có thể chỉnh sửa quyền, không thể xóa.');
      return;
    }
    sendApiError(res, 500, 'DELETE_ROLE_FAILED', err?.message || 'Không thể xóa vai trò.');
  }
});

// Unified & Specific Permission Matrix Endpoints
orgRbacRouter.get(['/permissions', '/role-permissions', '/department-permissions'], async (req, res) => {
  try {
    const ctx = getTenantContext();
    const roleId = req.query.role_id ? String(req.query.role_id).trim() : null;
    const deptId = req.query.department_id ? String(req.query.department_id).trim() : null;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultSystemRolesSeeded(client, ctx.tenantId);
      const [rpRes, dpRes, ovRes] = await Promise.all([
        roleId
          ? client.query('SELECT * FROM tenant_role_permissions WHERE tenant_id = $1 AND role_id = $2', [
              ctx.tenantId,
              roleId,
            ])
          : client.query('SELECT * FROM tenant_role_permissions WHERE tenant_id = $1', [ctx.tenantId]),
        deptId
          ? client.query('SELECT * FROM tenant_department_permissions WHERE tenant_id = $1 AND department_id = $2', [
              ctx.tenantId,
              deptId,
            ])
          : client.query('SELECT * FROM tenant_department_permissions WHERE tenant_id = $1', [ctx.tenantId]),
        client.query('SELECT * FROM tenant_user_permission_overrides WHERE tenant_id = $1', [ctx.tenantId]),
      ]);
      return {
        role_permissions: rpRes.rows,
        department_permissions: dpRes.rows,
        user_overrides: ovRes.rows,
        modules_catalog: SAAS_MODULES_CATALOG,
        scopes_catalog: DATA_SCOPES_ORDERED,
        actions_catalog: GRANULAR_ACTIONS,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_PERMISSIONS_FAILED', err?.message || 'Không thể tải ma trận phân quyền.');
  }
});

orgRbacRouter.get('/roles/:roleId/permissions', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_role_permissions WHERE tenant_id = $1 AND role_id = $2 ORDER BY module_key ASC',
        [ctx.tenantId, req.params.roleId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_ROLE_PERMS_FAILED', err?.message || 'Không thể tải quyền vai trò.');
  }
});

orgRbacRouter.put(
  '/roles/:roleId/permissions',
  requirePermission('org_rbac', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const items = Array.isArray(b?.permissions)
        ? b.permissions
        : Array.isArray(b?.items)
          ? b.items
          : Array.isArray(b)
            ? b
            : [];
      const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
        if (b.screen_access !== undefined || b.quick_actions !== undefined || b.default_route !== undefined) {
          await client.query(
            `UPDATE tenant_roles
             SET screen_access = COALESCE($3::jsonb, screen_access),
                 quick_actions = COALESCE($4::jsonb, quick_actions),
                 default_route = COALESCE($5, default_route),
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [
              ctx.tenantId,
              req.params.roleId,
              b.screen_access !== undefined ? JSON.stringify(parseBoolMapSafe(b.screen_access)) : null,
              b.quick_actions !== undefined ? JSON.stringify(parseBoolMapSafe(b.quick_actions)) : null,
              b.default_route !== undefined ? String(b.default_route || '/').trim().slice(0, 120) || '/' : null,
            ]
          );
        }
        return upsertRolePermissionsBatch(client, ctx.tenantId, req.params.roleId, items);
      });
      res.json({ success: true, data: saved });
    } catch (err: any) {
      sendApiError(res, 500, 'SAVE_ROLE_PERMS_FAILED', err?.message || 'Không thể lưu quyền vai trò.');
    }
  }
);

orgRbacRouter.get('/departments/:departmentId/permissions', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_department_permissions WHERE tenant_id = $1 AND department_id = $2 ORDER BY module_key ASC',
        [ctx.tenantId, req.params.departmentId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_DEPT_PERMS_FAILED', err?.message || 'Không thể tải quyền phòng ban.');
  }
});

orgRbacRouter.put(
  '/departments/:departmentId/permissions',
  requirePermission('org_rbac', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const items = Array.isArray(req.body?.permissions)
        ? req.body.permissions
        : Array.isArray(req.body)
          ? req.body
          : [];
      const saved = await withTenantTransaction(ctx.tenantId, (client) =>
        upsertDepartmentPermissionsBatch(client, ctx.tenantId, req.params.departmentId, items)
      );
      res.json({ success: true, data: saved });
    } catch (err: any) {
      sendApiError(res, 500, 'SAVE_DEPT_PERMS_FAILED', err?.message || 'Không thể lưu quyền phòng ban.');
    }
  }
);

// Bulk Put `/permissions`, `/role-permissions`, `/department-permissions`
orgRbacRouter.put(
  ['/permissions', '/role-permissions', '/department-permissions'],
  requirePermission('org_rbac', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        let rolePerms: any[] | undefined;
        let deptPerms: any[] | undefined;

        if (b.role_id && Array.isArray(b.permissions)) {
          rolePerms = await upsertRolePermissionsBatch(client, ctx.tenantId, String(b.role_id), b.permissions);
        }
        if (b.department_id && Array.isArray(b.permissions)) {
          deptPerms = await upsertDepartmentPermissionsBatch(
            client,
            ctx.tenantId,
            String(b.department_id),
            b.permissions
          );
        }
        if (Array.isArray(b.role_permissions)) {
          for (const item of b.role_permissions) {
            if (item?.role_id) {
              await upsertRolePermissionsBatch(client, ctx.tenantId, String(item.role_id), [item]);
            }
          }
          const r = await client.query('SELECT * FROM tenant_role_permissions WHERE tenant_id = $1', [ctx.tenantId]);
          rolePerms = r.rows;
        }
        if (Array.isArray(b.department_permissions)) {
          for (const item of b.department_permissions) {
            if (item?.department_id) {
              await upsertDepartmentPermissionsBatch(client, ctx.tenantId, String(item.department_id), [item]);
            }
          }
          const d = await client.query('SELECT * FROM tenant_department_permissions WHERE tenant_id = $1', [
            ctx.tenantId,
          ]);
          deptPerms = d.rows;
        }

        return { role_permissions: rolePerms, department_permissions: deptPerms };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'BULK_SAVE_PERMISSIONS_FAILED', err?.message || 'Không thể lưu ma trận phân quyền.');
    }
  }
);

// User Overrides (`Grant` / `Deny`)
orgRbacRouter.get('/user-overrides', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const userId = req.query.user_id ? String(req.query.user_id).trim() : null;
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = userId
        ? await client.query(
            `SELECT ov.*, u.full_name AS user_name, u.email AS user_email
             FROM tenant_user_permission_overrides ov
             LEFT JOIN users u ON u.tenant_id = ov.tenant_id AND u.id = ov.user_id
             WHERE ov.tenant_id = $1 AND ov.user_id = $2
             ORDER BY ov.created_at DESC`,
            [ctx.tenantId, userId]
          )
        : await client.query(
            `SELECT ov.*, u.full_name AS user_name, u.email AS user_email
             FROM tenant_user_permission_overrides ov
             LEFT JOIN users u ON u.tenant_id = ov.tenant_id AND u.id = ov.user_id
             WHERE ov.tenant_id = $1
             ORDER BY ov.created_at DESC`,
            [ctx.tenantId]
          );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_OVERRIDES_FAILED', err?.message || 'Không thể tải danh sách ngoại lệ cá nhân.');
  }
});

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const saveUserOverrideHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const rawUserRef = String(req.params.userId || b.user_id || b.email || '').trim();
    const rawModuleKey = String(b.module_key || '').trim();
    const moduleKey = normalizeCanonicalModuleKey(rawModuleKey) || rawModuleKey;
    const effect = b.effect === 'deny' ? 'deny' : 'grant';
    if (!rawUserRef || !moduleKey) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần chọn nhân sự (user_id / email) và phân hệ (module_key).');
      return;
    }

    const rawScope = b.data_scope ?? b.scope;
    const dataScope = rawScope ? normalizeDataScope(rawScope, 'own') : null;
    const actions = normalizeActionsMap(b.actions);
    const id = crypto.randomUUID();

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const userRes = UUID_V4_PATTERN.test(rawUserRef)
        ? await client.query<{ id: string; full_name: string; email: string }>(
            'SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [ctx.tenantId, rawUserRef]
          )
        : await client.query<{ id: string; full_name: string; email: string }>(
            'SELECT id, full_name, email FROM users WHERE tenant_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1',
            [ctx.tenantId, rawUserRef]
          );

      const resolvedUser = userRes.rows[0];
      if (!resolvedUser) {
        return null;
      }

      await client.query(
        `INSERT INTO tenant_user_permission_overrides (
           id, tenant_id, user_id, module_key, effect, data_scope, actions, reason, expires_at, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
         ON CONFLICT (tenant_id, user_id, module_key, effect)
         DO UPDATE SET
           data_scope = EXCLUDED.data_scope,
           actions = EXCLUDED.actions,
           reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at,
           updated_at = clock_timestamp()`,
        [
          id,
          ctx.tenantId,
          resolvedUser.id,
          moduleKey,
          effect,
          dataScope,
          JSON.stringify(actions),
          b.reason ? String(b.reason).trim() : null,
          b.expires_at || null,
          ctx.userId,
        ]
      );
      const r = await client.query(
        `SELECT ov.*, u.full_name AS user_name, u.email AS user_email
         FROM tenant_user_permission_overrides ov
         LEFT JOIN users u ON u.tenant_id = ov.tenant_id AND u.id = ov.user_id
         WHERE ov.tenant_id = $1 AND ov.user_id = $2 AND ov.module_key = $3 AND ov.effect = $4
         LIMIT 1`,
        [ctx.tenantId, resolvedUser.id, moduleKey, effect]
      );
      return r.rows[0] || {
        id,
        tenant_id: ctx.tenantId,
        user_id: resolvedUser.id,
        user_name: resolvedUser.full_name,
        user_email: resolvedUser.email,
        module_key: moduleKey,
        effect,
        data_scope: dataScope,
        actions,
      };
    });

    if (!saved) {
      sendApiError(res, 404, 'USER_NOT_FOUND', `Không tìm thấy nhân sự '${rawUserRef}' trong doanh nghiệp.`);
      return;
    }

    tenantRedis.invalidateEffectivePermissions(ctx.tenantId, saved.user_id);
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_OVERRIDE_FAILED', err?.message || 'Không thể lưu quyền ngoại lệ cá nhân.');
  }
};

orgRbacRouter.post('/user-overrides', requirePermission('org_rbac', 'manage_config'), saveUserOverrideHandler);
orgRbacRouter.put('/users/:userId/overrides', requirePermission('org_rbac', 'manage_config'), saveUserOverrideHandler);

orgRbacRouter.delete('/user-overrides/:id', requirePermission('org_rbac', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_user_permission_overrides WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    tenantRedis.invalidateEffectivePermissions(ctx.tenantId);
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_OVERRIDE_FAILED', err?.message || 'Không thể xóa ngoại lệ cá nhân.');
  }
});

// Assign Org Structure & Custom Role on Staff Member
orgRbacRouter.patch(
  '/users/:userId/org-assignment',
  requirePermission('org_rbac', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const targetUserId = req.params.userId;
      const b = req.body || {};

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        let nextRoleKey: string | null = b.role ? String(b.role).trim() : null;
        if (b.role_id && !nextRoleKey) {
          const rKeyRes = await client.query<{ role_key: string }>(
            'SELECT role_key FROM tenant_roles WHERE tenant_id = $1 AND id = $2 LIMIT 1',
            [ctx.tenantId, b.role_id]
          );
          nextRoleKey = rKeyRes.rows[0]?.role_key || null;
        }

        const r = await client.query(
          `UPDATE users
           SET role_id = CASE WHEN $3::boolean THEN $4 ELSE role_id END,
               role = COALESCE($5, role),
               branch_id = CASE WHEN $6::boolean THEN $7 ELSE branch_id END,
               department_id = CASE WHEN $8::boolean THEN $9 ELSE department_id END,
               team_id = CASE WHEN $10::boolean THEN $11 ELSE team_id END,
               position_id = CASE WHEN $12::boolean THEN $13 ELSE position_id END,
               reports_to_user_id = CASE WHEN $14::boolean THEN $15 ELSE reports_to_user_id END,
               is_system_bot = COALESCE($16, is_system_bot),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2
           RETURNING id, full_name, email, role, role_id, branch_id, department_id, team_id,
                     position_id, reports_to_user_id, is_tenant_owner, is_system_bot`,
          [
            ctx.tenantId,
            targetUserId,
            b.role_id !== undefined,
            b.role_id || null,
            nextRoleKey,
            b.branch_id !== undefined,
            b.branch_id || null,
            b.department_id !== undefined,
            b.department_id || null,
            b.team_id !== undefined,
            b.team_id || null,
            b.position_id !== undefined,
            b.position_id || null,
            b.reports_to_user_id !== undefined,
            b.reports_to_user_id || null,
            typeof b.is_system_bot === 'boolean' ? b.is_system_bot : null,
          ]
        );
        return r.rows[0] || null;
      });

      if (!updated) {
        sendApiError(res, 404, 'USER_NOT_FOUND', 'Không tìm thấy nhân sự.');
        return;
      }
      tenantRedis.invalidateUserAuth(ctx.tenantId, targetUserId);
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'UPDATE_USER_ORG_FAILED', err?.message || 'Không thể cập nhật vị trí tổ chức.');
    }
  }
);

// ============================================================================
// 6. Dynamic Terminology, Industry Presets & Ecosystem Settings (`/terminology`)
// ============================================================================
orgRbacRouter.get('/terminology', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT industry, industry_key, package_code, plan_tier, subscription_plan_code,
                crm_erp_upgrade_status, enabled_modules, entitlements, settings
         FROM tenants WHERE id = $1 LIMIT 1`,
        [ctx.tenantId]
      );
      const tRow = r.rows[0] || {};
      const snap = resolveTenantEntitlementSnapshot(tRow);
      const normSettings = normalizeTenantSettings(tRow.settings);
      return {
        industry_key: snap.industry_key,
        terminology: snap.terminology,
        terminology_overrides: normSettings.terminology,
        education_addon: snap.entitlements.education_addon,
        enable_ideas_mascot: snap.entitlements.enable_ideas_mascot,
        revenue_source: normSettings.revenue_source,
        brand_logo_url: normSettings.brand_logo_url,
        ai_agent_name: normSettings.ai_agent_name,
        ai_avatar_url: normSettings.ai_avatar_url,
        pipeline_tabs: normSettings.pipeline_tabs,
        industry_presets: INDUSTRY_TERMINOLOGY_PRESETS,
        valid_industries: VALID_INDUSTRY_KEYS,
      };
    });
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_TERMINOLOGY_FAILED', err?.message || 'Không thể tải từ điển thuật ngữ.');
  }
});

const saveTerminologyHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const saved = await withTenantTransaction(ctx.tenantId, (client) =>
      updateTenantTerminologyAndEcosystemSettings(client, ctx.tenantId, req.body || {})
    );
    tenantRedis.invalidateTenantCache(ctx.tenantId, saved.slug || ctx.tenantSlug);
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_TERMINOLOGY_FAILED', err?.message || 'Không thể lưu cấu hình thuật ngữ đa ngành.');
  }
};

orgRbacRouter.put('/terminology', requirePermission('settings', 'manage_config'), saveTerminologyHandler);
orgRbacRouter.patch('/terminology', requirePermission('settings', 'manage_config'), saveTerminologyHandler);

// ============================================================================
// 7. Dynamic Stage Transition Rules & Stage Funnel Metadata
// ============================================================================
orgRbacRouter.get(['/stage-rules', '/stage-transition-rules'], async (req, res) => {
  try {
    const ctx = getTenantContext();
    const pipelineId = req.query.pipeline_id ? String(req.query.pipeline_id).trim() : null;
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = pipelineId
        ? await client.query(
            'SELECT * FROM tenant_stage_transition_rules WHERE tenant_id = $1 AND pipeline_id = $2 ORDER BY created_at ASC',
            [ctx.tenantId, pipelineId]
          )
        : await client.query(
            'SELECT * FROM tenant_stage_transition_rules WHERE tenant_id = $1 ORDER BY created_at ASC',
            [ctx.tenantId]
          );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_STAGE_RULES_FAILED', err?.message || 'Không thể tải luật chuyển bước.');
  }
});

orgRbacRouter.post(
  ['/stage-rules', '/stage-transition-rules'],
  requirePermission('pipelines', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      if (!b.pipeline_id || !b.to_stage_id) {
        sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần chọn Pipeline (pipeline_id) và Bước đích (to_stage_id).');
        return;
      }
      const id = crypto.randomUUID();

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO tenant_stage_transition_rules (
             id, tenant_id, pipeline_id, from_stage_id, to_stage_id, rule_name,
             required_fields, allowed_role_ids, allowed_roles, require_note,
             max_sla_hours, score_delta, auto_task_templates, notify_role_ids,
             trigger_flow_id, capi_event_override, is_active
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17)`,
          [
            id,
            ctx.tenantId,
            b.pipeline_id,
            b.from_stage_id || null,
            b.to_stage_id,
            b.rule_name ? String(b.rule_name).trim() : null,
            JSON.stringify(Array.isArray(b.required_fields) ? b.required_fields : []),
            JSON.stringify(Array.isArray(b.allowed_role_ids) ? b.allowed_role_ids : []),
            JSON.stringify(Array.isArray(b.allowed_roles) ? b.allowed_roles : []),
            Boolean(b.require_note),
            Math.max(0, Number(b.max_sla_hours || 0)),
            Math.round(Number(b.score_delta || 0)),
            JSON.stringify(Array.isArray(b.auto_task_templates) ? b.auto_task_templates : []),
            JSON.stringify(Array.isArray(b.notify_role_ids) ? b.notify_role_ids : []),
            b.trigger_flow_id || null,
            b.capi_event_override ? String(b.capi_event_override).trim() : null,
            b.is_active !== false,
          ]
        );
        const r = await client.query('SELECT * FROM tenant_stage_transition_rules WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          id,
        ]);
        return r.rows[0];
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CREATE_STAGE_RULE_FAILED', err?.message || 'Không thể tạo luật chuyển bước.');
    }
  }
);

const updateStageRuleHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_stage_transition_rules
         SET from_stage_id = CASE WHEN $3::boolean THEN $4 ELSE from_stage_id END,
             to_stage_id = COALESCE($5, to_stage_id),
             rule_name = CASE WHEN $6::boolean THEN $7 ELSE rule_name END,
             required_fields = COALESCE($8::jsonb, required_fields),
             allowed_role_ids = COALESCE($9::jsonb, allowed_role_ids),
             allowed_roles = COALESCE($10::jsonb, allowed_roles),
             require_note = COALESCE($11, require_note),
             max_sla_hours = COALESCE($12, max_sla_hours),
             score_delta = COALESCE($13, score_delta),
             auto_task_templates = COALESCE($14::jsonb, auto_task_templates),
             notify_role_ids = COALESCE($15::jsonb, notify_role_ids),
             trigger_flow_id = CASE WHEN $16::boolean THEN $17 ELSE trigger_flow_id END,
             capi_event_override = CASE WHEN $18::boolean THEN $19 ELSE capi_event_override END,
             is_active = COALESCE($20, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.from_stage_id !== undefined,
          b.from_stage_id || null,
          b.to_stage_id || null,
          b.rule_name !== undefined,
          b.rule_name ? String(b.rule_name).trim() : null,
          b.required_fields !== undefined ? JSON.stringify(b.required_fields) : null,
          b.allowed_role_ids !== undefined ? JSON.stringify(b.allowed_role_ids) : null,
          b.allowed_roles !== undefined ? JSON.stringify(b.allowed_roles) : null,
          typeof b.require_note === 'boolean' ? b.require_note : null,
          b.max_sla_hours !== undefined ? Math.max(0, Number(b.max_sla_hours)) : null,
          b.score_delta !== undefined ? Math.round(Number(b.score_delta)) : null,
          b.auto_task_templates !== undefined ? JSON.stringify(b.auto_task_templates) : null,
          b.notify_role_ids !== undefined ? JSON.stringify(b.notify_role_ids) : null,
          b.trigger_flow_id !== undefined,
          b.trigger_flow_id || null,
          b.capi_event_override !== undefined,
          b.capi_event_override ? String(b.capi_event_override).trim() : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'STAGE_RULE_NOT_FOUND', 'Không tìm thấy luật chuyển bước.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_STAGE_RULE_FAILED', err?.message || 'Không thể cập nhật luật chuyển bước.');
  }
};

orgRbacRouter.put(
  ['/stage-rules/:id', '/stage-transition-rules/:id'],
  requirePermission('pipelines', 'manage_config'),
  updateStageRuleHandler
);
orgRbacRouter.patch(
  ['/stage-rules/:id', '/stage-transition-rules/:id'],
  requirePermission('pipelines', 'manage_config'),
  updateStageRuleHandler
);

orgRbacRouter.delete(
  ['/stage-rules/:id', '/stage-transition-rules/:id'],
  requirePermission('pipelines', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query('DELETE FROM tenant_stage_transition_rules WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          req.params.id,
        ]);
      });
      res.json({ success: true, data: { deleted: true, id: req.params.id } });
    } catch (err: any) {
      sendApiError(res, 500, 'DELETE_STAGE_RULE_FAILED', err?.message || 'Không thể xóa luật chuyển bước.');
    }
  }
);

orgRbacRouter.patch(
  '/stages/:stageId/meta',
  requirePermission('pipelines', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const validFunnels = new Set([
        'new_uncontacted',
        'engaged_qualified',
        'negotiation_proposal',
        'closed_won',
        'closed_lost',
        'nurturing',
      ]);
      const funnel =
        b.funnel_category && validFunnels.has(String(b.funnel_category))
          ? String(b.funnel_category)
          : null;

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          `UPDATE tenant_pipeline_stages
           SET funnel_category = COALESCE($3, funnel_category),
               score_delta = COALESCE($4, score_delta),
               required_fields = COALESCE($5::jsonb, required_fields),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2
           RETURNING *`,
          [
            ctx.tenantId,
            req.params.stageId,
            funnel,
            b.score_delta !== undefined ? Math.round(Number(b.score_delta)) : null,
            b.required_fields !== undefined ? JSON.stringify(b.required_fields) : null,
          ]
        );
        return r.rows[0] || null;
      });

      if (!updated) {
        sendApiError(res, 404, 'STAGE_NOT_FOUND', 'Không tìm thấy bước Pipeline.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'UPDATE_STAGE_META_FAILED', err?.message || 'Không thể cập nhật thuộc tính bước phễu.');
    }
  }
);

// ============================================================================
// 8. Custom KPIs CRUD & Evaluation (`/custom-kpis`)
// ============================================================================
orgRbacRouter.get('/custom-kpis', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_custom_kpis WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CUSTOM_KPIS_FAILED', err?.message || 'Không thể tải danh sách chỉ số KPI.');
  }
});

orgRbacRouter.post('/custom-kpis', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên chỉ số KPI không được để trống.');
      return;
    }
    const id = crypto.randomUUID();
    const kpiKey = slugifyKeyLower(b.kpi_key || name, 'kpi');
    const allowedOps = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CONVERSION_RATE']);
    const metricOp = allowedOps.has(String(b.metric_op || '').toUpperCase())
      ? String(b.metric_op).toUpperCase()
      : 'COUNT';

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_custom_kpis (
           id, tenant_id, kpi_key, name, description, module_key, source_entity,
           metric_op, target_field, filter_branches, target_value, unit, color_hex, sort_order, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)`,
        [
          id,
          ctx.tenantId,
          kpiKey,
          name,
          b.description ? String(b.description).trim() : null,
          String(b.module_key || 'crm').trim(),
          String(b.source_entity || 'leads').trim(),
          metricOp,
          b.target_field ? String(b.target_field).trim() : null,
          JSON.stringify(Array.isArray(b.filter_branches) ? b.filter_branches : []),
          Number(b.target_value || 0),
          String(b.unit || '').trim(),
          String(b.color_hex || '#1E40FF').trim(),
          Number(b.sort_order || 0),
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_custom_kpis WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_KPI_FAILED', err?.message || 'Không thể tạo chỉ số KPI tùy biến.');
  }
});

const updateCustomKpiHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const allowedOps = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CONVERSION_RATE']);
    const metricOp =
      b.metric_op && allowedOps.has(String(b.metric_op).toUpperCase())
        ? String(b.metric_op).toUpperCase()
        : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_custom_kpis
         SET name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             module_key = COALESCE($6, module_key),
             metric_op = COALESCE($7, metric_op),
             target_field = CASE WHEN $8::boolean THEN $9 ELSE target_field END,
             filter_branches = COALESCE($10::jsonb, filter_branches),
             target_value = COALESCE($11, target_value),
             unit = COALESCE($12, unit),
             color_hex = COALESCE($13, color_hex),
             sort_order = COALESCE($14, sort_order),
             is_active = COALESCE($15, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          b.module_key ? String(b.module_key).trim() : null,
          metricOp,
          b.target_field !== undefined,
          b.target_field ? String(b.target_field).trim() : null,
          b.filter_branches !== undefined ? JSON.stringify(b.filter_branches) : null,
          b.target_value !== undefined ? Number(b.target_value) : null,
          b.unit !== undefined ? String(b.unit).trim() : null,
          b.color_hex ? String(b.color_hex).trim() : null,
          b.sort_order !== undefined ? Number(b.sort_order) : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'KPI_NOT_FOUND', 'Không tìm thấy chỉ số KPI.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_KPI_FAILED', err?.message || 'Không thể cập nhật chỉ số KPI.');
  }
};

orgRbacRouter.put('/custom-kpis/:id', requirePermission('settings', 'manage_config'), updateCustomKpiHandler);
orgRbacRouter.patch('/custom-kpis/:id', requirePermission('settings', 'manage_config'), updateCustomKpiHandler);

orgRbacRouter.delete('/custom-kpis/:id', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_custom_kpis WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_KPI_FAILED', err?.message || 'Không thể xóa chỉ số KPI.');
  }
});

const evaluateCustomKpiHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const kpiRes = await client.query('SELECT * FROM tenant_custom_kpis WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        req.params.id,
      ]);
      const kpi = kpiRes.rows[0];
      if (!kpi) return null;

      const hasBranches = Array.isArray(kpi.filter_branches) && kpi.filter_branches.length > 0;
      const compiled = hasBranches
        ? compileSegmentWhereSql(ctx.tenantId, kpi.filter_branches)
        : { whereClause: 'l.tenant_id = $1 AND l.is_deleted = false', params: [ctx.tenantId] };

      let value = 0;
      const op = String(kpi.metric_op || 'COUNT').toUpperCase();
      if (op === 'CONVERSION_RATE') {
        const convRes = await client.query<{ total: number; won: number }>(
          `SELECT COUNT(*)::int AS total,
                  COALESCE(SUM(CASE WHEN s.is_won_stage = true THEN 1 ELSE 0 END), 0)::int AS won
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}`,
          compiled.params
        );
        const tot = Number(convRes.rows[0]?.total || 0);
        const won = Number(convRes.rows[0]?.won || 0);
        value = tot > 0 ? Number(((won / tot) * 100).toFixed(2)) : 0;
      } else if (op === 'COUNT') {
        const cRes = await client.query<{ val: number }>(
          `SELECT COUNT(*)::int AS val
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}`,
          compiled.params
        );
        value = Number(cRes.rows[0]?.val || 0);
      } else {
        const col =
          kpi.target_field === 'lead_score'
            ? 'l.lead_score'
            : 'l.total_revenue_vnd';
        const sqlFn = op === 'AVG' ? 'AVG' : op === 'MIN' ? 'MIN' : op === 'MAX' ? 'MAX' : 'SUM';
        const aggRes = await client.query<{ val: string | number | null }>(
          `SELECT COALESCE(${sqlFn}(${col}), 0) AS val
           FROM leads l
           LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = l.tenant_id AND s.id = l.stage_id
           WHERE ${compiled.whereClause}`,
          compiled.params
        );
        value = Number(aggRes.rows[0]?.val || 0);
      }

      return {
        kpi,
        computed_value: value,
        target_value: Number(kpi.target_value || 0),
        evaluated_at: new Date().toISOString(),
      };
    });

    if (!result) {
      sendApiError(res, 404, 'KPI_NOT_FOUND', 'Không tìm thấy chỉ số KPI.');
      return;
    }
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendApiError(res, 500, 'EVALUATE_KPI_FAILED', err?.message || 'Không thể tính toán giá trị KPI.');
  }
};

orgRbacRouter.get('/custom-kpis/:id/evaluate', evaluateCustomKpiHandler);
orgRbacRouter.post('/custom-kpis/:id/evaluate', evaluateCustomKpiHandler);

// ============================================================================
// 9. Company Policy Documents & DOM Agent Knowledge Sync (`/policies` & `/policy-documents`)
// ============================================================================
orgRbacRouter.get(['/policies', '/policy-documents'], async (req, res) => {
  try {
    const ctx = getTenantContext();
    const cat = req.query.category ? String(req.query.category).trim() : null;
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = cat
        ? await client.query(
            'SELECT * FROM tenant_policy_documents WHERE tenant_id = $1 AND doc_category = $2 ORDER BY updated_at DESC',
            [ctx.tenantId, cat]
          )
        : await client.query(
            'SELECT * FROM tenant_policy_documents WHERE tenant_id = $1 ORDER BY updated_at DESC',
            [ctx.tenantId]
          );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_POLICIES_FAILED', err?.message || 'Không thể tải danh sách điều khoản & nội quy.');
  }
});

orgRbacRouter.post(
  ['/policies', '/policy-documents'],
  requirePermission('settings', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const title = String(b.title || '').trim();
      if (!title) {
        sendApiError(res, 422, 'VALIDATION_ERROR', 'Tiêu đề văn bản / chính sách không được để trống.');
        return;
      }
      const id = crypto.randomUUID();
      const docKey = slugifyKeyLower(b.doc_key || title, 'policy');
      const status =
        b.status === 'draft' || b.status === 'archived' || b.status === 'published'
          ? b.status
          : 'published';

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const syncNow = Boolean(b.sync_to_dom_agent);
        await client.query(
          `INSERT INTO tenant_policy_documents (
             id, tenant_id, doc_key, title, doc_category, content_html, content_markdown,
             variables_schema, version, status, sync_to_dom_agent, last_synced_dom_agent_at,
             allowed_department_ids, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8::jsonb, 1, $9, $10, CASE WHEN $10::boolean THEN clock_timestamp() ELSE NULL END,
             $11::jsonb, $12
           )`,
          [
            id,
            ctx.tenantId,
            docKey,
            title,
            String(b.doc_category || 'company_policy').trim(),
            String(b.content_html || b.content || ''),
            b.content_markdown ? String(b.content_markdown) : null,
            JSON.stringify(Array.isArray(b.variables_schema) ? b.variables_schema : []),
            status,
            syncNow,
            JSON.stringify(Array.isArray(b.allowed_department_ids) ? b.allowed_department_ids : []),
            ctx.userId,
          ]
        );
        const r = await client.query('SELECT * FROM tenant_policy_documents WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          id,
        ]);
        return r.rows[0];
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CREATE_POLICY_FAILED', err?.message || 'Không thể lưu văn bản chính sách.');
    }
  }
);

const updatePolicyHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const status =
      b.status === 'draft' || b.status === 'archived' || b.status === 'published' ? b.status : null;

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_policy_documents
         SET title = COALESCE($3, title),
             doc_category = COALESCE($4, doc_category),
             content_html = COALESCE($5, content_html),
             content_markdown = CASE WHEN $6::boolean THEN $7 ELSE content_markdown END,
             variables_schema = COALESCE($8::jsonb, variables_schema),
             status = COALESCE($9, status),
             sync_to_dom_agent = COALESCE($10, sync_to_dom_agent),
             allowed_department_ids = COALESCE($11::jsonb, allowed_department_ids),
             version = version + 1,
             updated_by = $12,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.title ? String(b.title).trim() : null,
          b.doc_category ? String(b.doc_category).trim() : null,
          b.content_html !== undefined ? String(b.content_html) : b.content !== undefined ? String(b.content) : null,
          b.content_markdown !== undefined,
          b.content_markdown ? String(b.content_markdown) : null,
          b.variables_schema !== undefined ? JSON.stringify(b.variables_schema) : null,
          status,
          typeof b.sync_to_dom_agent === 'boolean' ? b.sync_to_dom_agent : null,
          b.allowed_department_ids !== undefined ? JSON.stringify(b.allowed_department_ids) : null,
          ctx.userId,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'POLICY_NOT_FOUND', 'Không tìm thấy văn bản chính sách.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_POLICY_FAILED', err?.message || 'Không thể cập nhật văn bản chính sách.');
  }
};

orgRbacRouter.put(
  ['/policies/:id', '/policy-documents/:id'],
  requirePermission('settings', 'manage_config'),
  updatePolicyHandler
);
orgRbacRouter.patch(
  ['/policies/:id', '/policy-documents/:id'],
  requirePermission('settings', 'manage_config'),
  updatePolicyHandler
);

orgRbacRouter.delete(
  ['/policies/:id', '/policy-documents/:id'],
  requirePermission('settings', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query('DELETE FROM tenant_policy_documents WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          req.params.id,
        ]);
      });
      res.json({ success: true, data: { deleted: true, id: req.params.id } });
    } catch (err: any) {
      sendApiError(res, 500, 'DELETE_POLICY_FAILED', err?.message || 'Không thể xóa văn bản chính sách.');
    }
  }
);

orgRbacRouter.post(
  ['/policies/:id/sync-dom-agent', '/policy-documents/:id/sync-dom-agent'],
  requirePermission('settings', 'manage_config'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const result = await withTenantTransaction(ctx.tenantId, async (client) => {
        const upd = await client.query(
          `UPDATE tenant_policy_documents
           SET sync_to_dom_agent = true,
               last_synced_dom_agent_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2
           RETURNING *`,
          [ctx.tenantId, req.params.id]
        );
        const doc = upd.rows[0];
        if (!doc) return null;
        const renderedPreview = await renderPolicyDocumentPreview(client, ctx.tenantId, doc.content_html || '');
        return {
          document: doc,
          rendered_preview_html: renderedPreview,
          synced_at: doc.last_synced_dom_agent_at,
          agent_name: 'DOM Agent',
        };
      });
      if (!result) {
        sendApiError(res, 404, 'POLICY_NOT_FOUND', 'Không tìm thấy văn bản chính sách cần đồng bộ.');
        return;
      }
      res.json({ success: true, data: result });
    } catch (err: any) {
      sendApiError(res, 500, 'SYNC_DOM_AGENT_FAILED', err?.message || 'Không thể đồng bộ tri thức cho DOM Agent.');
    }
  }
);

// ============================================================================
// 12. Dynamic Custom Fields CRUD (`/api/v1/org-rbac/custom-fields`)
// ============================================================================
orgRbacRouter.get('/custom-fields', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const entityType = req.query.entity_type ? String(req.query.entity_type).trim().toLowerCase() : null;
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'tenant_id = $1';
      if (entityType) {
        params.push(entityType);
        where += ' AND entity_type = $2';
      }
      const r = await client.query(
        `SELECT * FROM tenant_custom_fields WHERE ${where} ORDER BY entity_type ASC, sort_order ASC, created_at ASC`,
        params
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_CUSTOM_FIELDS_FAILED', err?.message || 'Không thể tải danh sách trường tùy chỉnh.');
  }
});

orgRbacRouter.post('/custom-fields', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const fieldLabel = String(b.field_label || b.label || '').trim();
    if (!fieldLabel) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Nhãn trường tùy chỉnh (field_label) không được để trống.');
      return;
    }
    const entityType = String(b.entity_type || 'lead').trim().toLowerCase();
    const fieldKey = slugifyKeyLower(b.field_key || fieldLabel, 'cf');
    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_custom_fields (
           id, tenant_id, entity_type, field_key, field_label, field_type, options_json,
           is_required, is_filterable, show_in_table, default_value, validation_regex, placeholder, sort_order, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          id,
          ctx.tenantId,
          entityType,
          fieldKey,
          fieldLabel,
          String(b.field_type || 'text').trim().toLowerCase(),
          JSON.stringify(Array.isArray(b.options_json ?? b.options) ? (b.options_json ?? b.options) : []),
          Boolean(b.is_required),
          b.is_filterable !== false,
          b.show_in_table !== false,
          b.default_value !== undefined && b.default_value !== null ? String(b.default_value) : null,
          b.validation_regex ? String(b.validation_regex) : null,
          b.placeholder ? String(b.placeholder).slice(0, 255) : null,
          Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0,
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_custom_fields WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_CUSTOM_FIELD_FAILED', err?.message || 'Không thể tạo trường tùy chỉnh.');
  }
});

const updateCustomFieldHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_custom_fields
         SET field_label = COALESCE($3, field_label),
             field_type = COALESCE($4, field_type),
             options_json = COALESCE($5::jsonb, options_json),
             is_required = COALESCE($6, is_required),
             is_filterable = COALESCE($7, is_filterable),
             show_in_table = COALESCE($8, show_in_table),
             default_value = CASE WHEN $9::boolean THEN $10 ELSE default_value END,
             validation_regex = CASE WHEN $11::boolean THEN $12 ELSE validation_regex END,
             placeholder = CASE WHEN $13::boolean THEN $14 ELSE placeholder END,
             sort_order = COALESCE($15, sort_order),
             is_active = COALESCE($16, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.field_label ?? b.label ? String(b.field_label ?? b.label).trim() : null,
          b.field_type ? String(b.field_type).trim().toLowerCase() : null,
          (b.options_json ?? b.options) !== undefined
            ? JSON.stringify(Array.isArray(b.options_json ?? b.options) ? (b.options_json ?? b.options) : [])
            : null,
          typeof b.is_required === 'boolean' ? b.is_required : null,
          typeof b.is_filterable === 'boolean' ? b.is_filterable : null,
          typeof b.show_in_table === 'boolean' ? b.show_in_table : null,
          b.default_value !== undefined,
          b.default_value !== null ? String(b.default_value) : null,
          b.validation_regex !== undefined,
          b.validation_regex ? String(b.validation_regex) : null,
          b.placeholder !== undefined,
          b.placeholder ? String(b.placeholder).slice(0, 255) : null,
          Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'CUSTOM_FIELD_NOT_FOUND', 'Không tìm thấy trường tùy chỉnh.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_CUSTOM_FIELD_FAILED', err?.message || 'Không thể cập nhật trường tùy chỉnh.');
  }
};
orgRbacRouter.put('/custom-fields/:id', requirePermission('settings', 'manage_config'), updateCustomFieldHandler);
orgRbacRouter.patch('/custom-fields/:id', requirePermission('settings', 'manage_config'), updateCustomFieldHandler);

orgRbacRouter.delete('/custom-fields/:id', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_custom_fields WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_CUSTOM_FIELD_FAILED', err?.message || 'Không thể xóa trường tùy chỉnh.');
  }
});

// ============================================================================
// 13. Lead Scoring Rules CRUD (`/api/v1/org-rbac/lead-scoring-rules`)
// ============================================================================
orgRbacRouter.get('/lead-scoring-rules', requirePermission('settings', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_lead_scoring_rules WHERE tenant_id = $1 ORDER BY priority ASC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_LEAD_SCORING_FAILED', err?.message || 'Không thể tải luật chấm điểm Lead.');
  }
});

orgRbacRouter.post('/lead-scoring-rules', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên luật chấm điểm không được để trống.');
      return;
    }
    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_lead_scoring_rules (
           id, tenant_id, name, description, trigger_type, condition_json,
           score_delta, max_applications, priority, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
        [
          id,
          ctx.tenantId,
          name,
          b.description ? String(b.description).trim() : null,
          String(b.trigger_type || 'field_match').trim().toLowerCase(),
          JSON.stringify(
            (b.condition_json ?? b.conditions) && typeof (b.condition_json ?? b.conditions) === 'object'
              ? (b.condition_json ?? b.conditions)
              : {}
          ),
          Math.trunc(Number(b.score_delta ?? b.points ?? 10) || 0),
          Math.max(1, Math.trunc(Number(b.max_applications ?? 1) || 1)),
          Math.trunc(Number(b.priority ?? 100) || 100),
          b.is_active !== false,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_lead_scoring_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_LEAD_SCORING_FAILED', err?.message || 'Không thể tạo luật chấm điểm Lead.');
  }
});

const updateLeadScoringHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_lead_scoring_rules
         SET name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             trigger_type = COALESCE($6, trigger_type),
             condition_json = COALESCE($7::jsonb, condition_json),
             score_delta = COALESCE($8, score_delta),
             max_applications = COALESCE($9, max_applications),
             priority = COALESCE($10, priority),
             is_active = COALESCE($11, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          b.trigger_type ? String(b.trigger_type).trim().toLowerCase() : null,
          (b.condition_json ?? b.conditions) !== undefined
            ? JSON.stringify(
                (b.condition_json ?? b.conditions) && typeof (b.condition_json ?? b.conditions) === 'object'
                  ? (b.condition_json ?? b.conditions)
                  : {}
              )
            : null,
          b.score_delta !== undefined || b.points !== undefined
            ? Math.trunc(Number(b.score_delta ?? b.points) || 0)
            : null,
          b.max_applications !== undefined ? Math.max(1, Math.trunc(Number(b.max_applications) || 1)) : null,
          b.priority !== undefined ? Math.trunc(Number(b.priority) || 100) : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'LEAD_SCORING_RULE_NOT_FOUND', 'Không tìm thấy luật chấm điểm.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_LEAD_SCORING_FAILED', err?.message || 'Không thể cập nhật luật chấm điểm.');
  }
};
orgRbacRouter.put('/lead-scoring-rules/:id', requirePermission('settings', 'manage_config'), updateLeadScoringHandler);
orgRbacRouter.patch('/lead-scoring-rules/:id', requirePermission('settings', 'manage_config'), updateLeadScoringHandler);

orgRbacRouter.delete('/lead-scoring-rules/:id', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_lead_scoring_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_LEAD_SCORING_FAILED', err?.message || 'Không thể xóa luật chấm điểm.');
  }
});

// ============================================================================
// 14. Notification Routing Rules (`/api/v1/org-rbac/notification-rules`)
// ============================================================================
orgRbacRouter.get('/notification-rules', requirePermission('settings', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_notification_rules WHERE tenant_id = $1 ORDER BY event_key ASC, created_at ASC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_NOTIFICATION_RULES_FAILED', err?.message || 'Không thể tải cấu hình thông báo.');
  }
});

orgRbacRouter.post('/notification-rules', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const eventKey = String(b.event_key || '').trim();
    const name = String(b.name || eventKey).trim();
    if (!eventKey || !name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Cần cung cấp event_key và name cho quy tắc thông báo.');
      return;
    }
    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_notification_rules (
           id, tenant_id, event_key, name, description, recipient_strategy,
           target_roles_json, target_departments_json, target_user_ids_json,
           include_owner, include_team_leader, cc_emails, channels_json, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13::jsonb, $14, $15)`,
        [
          id,
          ctx.tenantId,
          eventKey,
          name,
          b.description ? String(b.description).trim() : null,
          String(b.recipient_strategy || 'assigned_and_managers').trim(),
          JSON.stringify(Array.isArray(b.target_roles_json ?? b.target_roles) ? (b.target_roles_json ?? b.target_roles) : []),
          JSON.stringify(
            Array.isArray(b.target_departments_json ?? b.target_departments)
              ? (b.target_departments_json ?? b.target_departments)
              : []
          ),
          JSON.stringify(
            Array.isArray(b.target_user_ids_json ?? b.target_user_ids)
              ? (b.target_user_ids_json ?? b.target_user_ids)
              : []
          ),
          b.include_owner !== false,
          Boolean(b.include_team_leader),
          JSON.stringify(Array.isArray(b.cc_emails) ? b.cc_emails : []),
          JSON.stringify(
            (b.channels_json ?? b.channels) && typeof (b.channels_json ?? b.channels) === 'object'
              ? (b.channels_json ?? b.channels)
              : { in_app: true, email: false, zalo: false, telegram: false }
          ),
          b.is_active !== false,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_notification_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_NOTIFICATION_RULE_FAILED', err?.message || 'Không thể tạo quy tắc thông báo.');
  }
});

const updateNotificationRuleHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_notification_rules
         SET event_key = COALESCE($3, event_key),
             name = COALESCE($4, name),
             description = CASE WHEN $5::boolean THEN $6 ELSE description END,
             recipient_strategy = COALESCE($7, recipient_strategy),
             target_roles_json = COALESCE($8::jsonb, target_roles_json),
             target_departments_json = COALESCE($9::jsonb, target_departments_json),
             target_user_ids_json = COALESCE($10::jsonb, target_user_ids_json),
             include_owner = COALESCE($11, include_owner),
             include_team_leader = COALESCE($12, include_team_leader),
             cc_emails = COALESCE($13::jsonb, cc_emails),
             channels_json = COALESCE($14::jsonb, channels_json),
             is_active = COALESCE($15, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.event_key ? String(b.event_key).trim() : null,
          b.name ? String(b.name).trim() : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
          b.recipient_strategy ? String(b.recipient_strategy).trim() : null,
          (b.target_roles_json ?? b.target_roles) !== undefined
            ? JSON.stringify(
                Array.isArray(b.target_roles_json ?? b.target_roles) ? (b.target_roles_json ?? b.target_roles) : []
              )
            : null,
          (b.target_departments_json ?? b.target_departments) !== undefined
            ? JSON.stringify(
                Array.isArray(b.target_departments_json ?? b.target_departments)
                  ? (b.target_departments_json ?? b.target_departments)
                  : []
              )
            : null,
          (b.target_user_ids_json ?? b.target_user_ids) !== undefined
            ? JSON.stringify(
                Array.isArray(b.target_user_ids_json ?? b.target_user_ids)
                  ? (b.target_user_ids_json ?? b.target_user_ids)
                  : []
              )
            : null,
          typeof b.include_owner === 'boolean' ? b.include_owner : null,
          typeof b.include_team_leader === 'boolean' ? b.include_team_leader : null,
          b.cc_emails !== undefined ? JSON.stringify(Array.isArray(b.cc_emails) ? b.cc_emails : []) : null,
          (b.channels_json ?? b.channels) !== undefined
            ? JSON.stringify(b.channels_json ?? b.channels)
            : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'NOTIFICATION_RULE_NOT_FOUND', 'Không tìm thấy quy tắc thông báo.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_NOTIFICATION_RULE_FAILED', err?.message || 'Không thể cập nhật quy tắc thông báo.');
  }
};
orgRbacRouter.put('/notification-rules/:id', requirePermission('settings', 'manage_config'), updateNotificationRuleHandler);
orgRbacRouter.patch('/notification-rules/:id', requirePermission('settings', 'manage_config'), updateNotificationRuleHandler);

orgRbacRouter.delete('/notification-rules/:id', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_notification_rules WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_NOTIFICATION_RULE_FAILED', err?.message || 'Không thể xóa quy tắc thông báo.');
  }
});

// ============================================================================
// 15. System Email Templates (`/api/v1/org-rbac/email-templates`)
// ============================================================================
orgRbacRouter.get('/email-templates', requirePermission('settings', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_email_templates WHERE tenant_id = $1 ORDER BY is_system DESC, created_at DESC',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_EMAIL_TEMPLATES_FAILED', err?.message || 'Không thể tải danh sách mẫu Email.');
  }
});

orgRbacRouter.post('/email-templates', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const subjectTemplate = String(b.subject_template || b.subject || '').trim();
    if (!name || !subjectTemplate) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên mẫu Email và tiêu đề (subject_template) là bắt buộc.');
      return;
    }
    const id = crypto.randomUUID();
    const templateKey = slugifyKeyLower(b.template_key || name, 'tpl');
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_email_templates (
           id, tenant_id, template_key, name, category, subject_template, body_html, body_text,
           variables_json, is_system, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
        [
          id,
          ctx.tenantId,
          templateKey,
          name,
          String(b.category || 'notification').trim().toLowerCase(),
          subjectTemplate,
          String(b.body_html || b.content_html || ''),
          b.body_text ? String(b.body_text) : null,
          JSON.stringify(Array.isArray(b.variables_json ?? b.variables) ? (b.variables_json ?? b.variables) : []),
          Boolean(b.is_system),
          b.is_active !== false,
          ctx.userId,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_email_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_EMAIL_TEMPLATE_FAILED', err?.message || 'Không thể tạo mẫu Email.');
  }
});

const updateEmailTemplateHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_email_templates
         SET name = COALESCE($3, name),
             category = COALESCE($4, category),
             subject_template = COALESCE($5, subject_template),
             body_html = COALESCE($6, body_html),
             body_text = CASE WHEN $7::boolean THEN $8 ELSE body_text END,
             variables_json = COALESCE($9::jsonb, variables_json),
             is_active = COALESCE($10, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim() : null,
          b.category ? String(b.category).trim().toLowerCase() : null,
          (b.subject_template ?? b.subject) ? String(b.subject_template ?? b.subject).trim() : null,
          b.body_html !== undefined || b.content_html !== undefined ? String(b.body_html ?? b.content_html) : null,
          b.body_text !== undefined,
          b.body_text ? String(b.body_text) : null,
          (b.variables_json ?? b.variables) !== undefined
            ? JSON.stringify(Array.isArray(b.variables_json ?? b.variables) ? (b.variables_json ?? b.variables) : [])
            : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'EMAIL_TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu Email.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_EMAIL_TEMPLATE_FAILED', err?.message || 'Không thể cập nhật mẫu Email.');
  }
};
orgRbacRouter.put('/email-templates/:id', requirePermission('settings', 'manage_config'), updateEmailTemplateHandler);
orgRbacRouter.patch('/email-templates/:id', requirePermission('settings', 'manage_config'), updateEmailTemplateHandler);

orgRbacRouter.delete('/email-templates/:id', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_email_templates WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_EMAIL_TEMPLATE_FAILED', err?.message || 'Không thể xóa mẫu Email.');
  }
});

// ============================================================================
// 16. Dynamic Entity Profile Tabs (`/api/v1/org-rbac/entity-tabs`)
// ============================================================================
orgRbacRouter.get('/entity-tabs', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const entityType = req.query.entity_type ? String(req.query.entity_type).trim().toLowerCase() : null;
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'tenant_id = $1';
      if (entityType) {
        params.push(entityType);
        where += ' AND entity_type = $2';
      }
      const r = await client.query(
        `SELECT * FROM tenant_entity_tabs WHERE ${where} ORDER BY entity_type ASC, sort_order ASC, created_at ASC`,
        params
      );
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_ENTITY_TABS_FAILED', err?.message || 'Không thể tải danh sách Tab thực thể.');
  }
});

orgRbacRouter.post('/entity-tabs', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const label = String(b.label || b.name || '').trim();
    if (!label) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên Tab (label) không được để trống.');
      return;
    }
    const entityType = String(b.entity_type || 'lead').trim().toLowerCase();
    const tabKey = slugifyKeyLower(b.tab_key || label, 'tab');
    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_entity_tabs (
           id, tenant_id, entity_type, tab_key, label, icon_name, tab_type,
           config_json, allowed_role_ids, sort_order, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
        [
          id,
          ctx.tenantId,
          entityType,
          tabKey,
          label,
          String(b.icon_name || 'Layers').trim(),
          String(b.tab_type || 'fields').trim().toLowerCase(),
          JSON.stringify(b.config_json && typeof b.config_json === 'object' ? b.config_json : {}),
          JSON.stringify(Array.isArray(b.allowed_role_ids) ? b.allowed_role_ids : []),
          Math.trunc(Number(b.sort_order ?? 0) || 0),
          b.is_active !== false,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_entity_tabs WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_ENTITY_TAB_FAILED', err?.message || 'Không thể tạo Tab thực thể.');
  }
});

const updateEntityTabHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_entity_tabs
         SET label = COALESCE($3, label),
             icon_name = COALESCE($4, icon_name),
             tab_type = COALESCE($5, tab_type),
             config_json = COALESCE($6::jsonb, config_json),
             allowed_role_ids = COALESCE($7::jsonb, allowed_role_ids),
             sort_order = COALESCE($8, sort_order),
             is_active = COALESCE($9, is_active),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          (b.label ?? b.name) ? String(b.label ?? b.name).trim() : null,
          b.icon_name ? String(b.icon_name).trim() : null,
          b.tab_type ? String(b.tab_type).trim().toLowerCase() : null,
          b.config_json !== undefined ? JSON.stringify(b.config_json || {}) : null,
          b.allowed_role_ids !== undefined
            ? JSON.stringify(Array.isArray(b.allowed_role_ids) ? b.allowed_role_ids : [])
            : null,
          b.sort_order !== undefined ? Math.trunc(Number(b.sort_order) || 0) : null,
          typeof b.is_active === 'boolean' ? b.is_active : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'ENTITY_TAB_NOT_FOUND', 'Không tìm thấy Tab thực thể.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_ENTITY_TAB_FAILED', err?.message || 'Không thể cập nhật Tab thực thể.');
  }
};
orgRbacRouter.put('/entity-tabs/:id', requirePermission('settings', 'manage_config'), updateEntityTabHandler);
orgRbacRouter.patch('/entity-tabs/:id', requirePermission('settings', 'manage_config'), updateEntityTabHandler);

orgRbacRouter.delete('/entity-tabs/:id', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_entity_tabs WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_ENTITY_TAB_FAILED', err?.message || 'Không thể xóa Tab thực thể.');
  }
});

// ============================================================================
// 17. Tenant Tags Management (`/api/v1/org-rbac/tags`)
// ============================================================================
orgRbacRouter.get('/tags', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('SELECT * FROM tenant_tags WHERE tenant_id = $1 ORDER BY name ASC', [
        ctx.tenantId,
      ]);
      return r.rows;
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TAGS_FAILED', err?.message || 'Không thể tải danh sách nhãn (Tags).');
  }
});

orgRbacRouter.post('/tags', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên nhãn (Tag) không được để trống.');
      return;
    }
    const id = crypto.randomUUID();
    const slug = slugifyKeyLower(b.slug || name, 'tag').slice(0, 100);
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_tags (id, tenant_id, name, slug, color_hex, category, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          ctx.tenantId,
          name.slice(0, 100),
          slug,
          String(b.color_hex || b.color || '#1E40FF').slice(0, 20),
          String(b.category || 'lead').slice(0, 50),
          b.description ? String(b.description).trim() : null,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_tags WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      return r.rows[0];
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TAG_FAILED', err?.message || 'Không thể tạo nhãn (Tag).');
  }
});

const updateTagHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `UPDATE tenant_tags
         SET name = COALESCE($3, name),
             slug = COALESCE($4, slug),
             color_hex = COALESCE($5, color_hex),
             category = COALESCE($6, category),
             description = CASE WHEN $7::boolean THEN $8 ELSE description END,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          req.params.id,
          b.name ? String(b.name).trim().slice(0, 100) : null,
          b.slug ? slugifyKeyLower(b.slug, 'tag').slice(0, 100) : null,
          (b.color_hex ?? b.color) ? String(b.color_hex ?? b.color).slice(0, 20) : null,
          b.category ? String(b.category).slice(0, 50) : null,
          b.description !== undefined,
          b.description ? String(b.description).trim() : null,
        ]
      );
      return r.rows[0] || null;
    });
    if (!updated) {
      sendApiError(res, 404, 'TAG_NOT_FOUND', 'Không tìm thấy nhãn (Tag).');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_TAG_FAILED', err?.message || 'Không thể cập nhật nhãn (Tag).');
  }
};
orgRbacRouter.put('/tags/:id', requirePermission('settings', 'manage_config'), updateTagHandler);
orgRbacRouter.patch('/tags/:id', requirePermission('settings', 'manage_config'), updateTagHandler);

orgRbacRouter.delete('/tags/:id', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_tags WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, req.params.id]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_TAG_FAILED', err?.message || 'Không thể xóa nhãn (Tag).');
  }
});

// ============================================================================
// 18. Master Cron Monitor & Trigger (`/api/v1/org-rbac/cron-status`)
// ============================================================================
const CRON_SUBROUTINES_CATALOG = [
  { key: 'sla', name: 'SLA Sweeper & Lead Escalation', schedule: '*/1 * * * *' },
  { key: 'drain', name: 'Unassigned Lead Drainer & Round Redistribution', schedule: '*/2 * * * *' },
  { key: 'zalo', name: 'Zalo OA Token Auto-Refresher', schedule: '0 * * * *' },
  { key: 'billing', name: 'Subscription & Trial Expiry Manager', schedule: '0 0 * * *' },
  { key: 'webhook', name: 'Webhook DLQ Auto-Replay Worker', schedule: '*/5 * * * *' },
  { key: 'capi', name: 'Meta CAPI Retry Queue Worker', schedule: '*/5 * * * *' },
];

orgRbacRouter.get('/cron-status', requirePermission('settings', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const runs = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_cron_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 50',
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({
      success: true,
      data: {
        subroutines: CRON_SUBROUTINES_CATALOG,
        runs,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CRON_STATUS_FAILED', err?.message || 'Không thể tải trạng thái tiến trình tự động.');
  }
});

orgRbacRouter.post('/cron-status/run', requirePermission('settings', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const validKeys = new Set(CRON_SUBROUTINES_CATALOG.map((c) => c.key));
    const requestedRaw = Array.isArray(req.body?.subroutines)
      ? req.body.subroutines
      : req.body?.subroutine_key
        ? [req.body.subroutine_key]
        : ['sla', 'drain', 'webhook', 'capi'];
    const requested = requestedRaw
      .map((s: unknown) => String(s || '').trim().toLowerCase())
      .filter((s: string) => validKeys.has(s));
    const runResult = await executeMasterCron({
      subroutines: requested.length > 0 ? requested : ['sla', 'drain', 'webhook', 'capi'],
      tenantId: ctx.tenantId,
    });

    const recorded = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      const processedCount =
        runResult.stats.slaBreachedCount +
        runResult.stats.leadsDrainedCount +
        runResult.stats.zaloRefreshedCount +
        runResult.stats.subscriptionsProcessed +
        runResult.stats.webhooksReplayedCount +
        runResult.stats.capiRetriedCount;
      await client.query(
        `INSERT INTO tenant_cron_runs (
           id, tenant_id, subroutine_key, status, items_processed, duration_ms,
           error_message, details_json, triggered_by, started_at, finished_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'manual', clock_timestamp(), clock_timestamp())`,
        [
          id,
          ctx.tenantId,
          requested.join(',') || 'all',
          runResult.locked ? 'skipped' : runResult.stats.errors.length > 0 ? 'failed' : 'success',
          processedCount,
          runResult.stats.durationMs,
          runResult.stats.errors.length > 0 ? runResult.stats.errors.join(' | ') : null,
          JSON.stringify(runResult.stats),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_cron_runs WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    res.json({
      success: true,
      data: {
        locked: runResult.locked,
        stats: runResult.stats,
        run_log: recorded,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'CRON_RUN_FAILED', err?.message || 'Không thể chạy tiến trình tự động.');
  }
});
