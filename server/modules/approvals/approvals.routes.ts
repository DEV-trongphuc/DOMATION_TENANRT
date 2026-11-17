import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  resolveUserEffectivePermissions,
  sendApiError,
} from '../../core/security/rbac.ts';
import { slugifyCode } from '../org-rbac/org-rbac.service.ts';
import { tenantRedis } from '../../core/cache/tenant-redis.ts';
import {
  DEFAULT_APPROVAL_WORKFLOW_TEMPLATES,
  ensureDefaultApprovalWorkflowsInTx,
  ensureHrmApprovalsSchemaMiddleware,
  parseJsonSafe,
  toBool,
  toNum,
} from '../hrm/schema.ts';
import {
  createApprovalRequestInTx,
  resolveDynamicApprovalStepsInTx,
} from './approval-engine.ts';

function normalizeWorkflowCategory(raw: unknown): string {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || 'custom_form';
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.map((v) => String(v || '').trim()).filter(Boolean)));
}

async function markApprovalsCustomOnlyInTx(client: any, tenantId: string, flag = true): Promise<void> {
  const tRes = await client.query(
    'SELECT slug, settings FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId]
  );
  const row = tRes.rows[0] as { slug?: string; settings?: unknown } | undefined;
  if (!row) return;
  const cur = parseJsonSafe<Record<string, unknown>>(row.settings, {});
  const next = {
    ...cur,
    approvals_custom_only: flag,
    approvals_custom_mode: flag,
    approvals_initialized: true,
  };
  await client.query('UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1', [
    tenantId,
    JSON.stringify(next),
  ]);
  if (row.slug) tenantRedis.invalidateTenantCache(tenantId, row.slug);
}

interface ApprovalCategoryDto {
  key: string;
  label: string;
  color: string;
  description: string;
  sort_order: number;
}

async function saveApprovalCategoriesInTx(
  client: any,
  tenantId: string,
  categories: ApprovalCategoryDto[]
): Promise<ApprovalCategoryDto[]> {
  const tRes = await client.query(
    'SELECT slug, settings FROM tenants WHERE id = $1 LIMIT 1',
    [tenantId]
  );
  const row = tRes.rows[0];
  const cur = parseJsonSafe<Record<string, unknown>>(row?.settings, {});
  const next = {
    ...cur,
    approval_categories: categories,
    approvals_custom_only: true,
    approvals_custom_mode: true,
    approvals_initialized: true,
  };
  await client.query('UPDATE tenants SET settings = $2::jsonb, updated_at = clock_timestamp() WHERE id = $1', [
    tenantId,
    JSON.stringify(next),
  ]);
  if (row?.slug) tenantRedis.invalidateTenantCache(tenantId, row.slug);
  return categories;
}

async function listApprovalCategoriesInTx(client: any, tenantId: string) {
  const [tRes, wfCatsRes] = await Promise.all([
    client.query('SELECT settings FROM tenants WHERE id = $1 LIMIT 1', [tenantId]),
    client.query(
      `SELECT DISTINCT category, category_label FROM tenant_approval_workflows WHERE tenant_id = $1 ORDER BY category ASC`,
      [tenantId]
    ),
  ]);
  const rawSettings = parseJsonSafe<Record<string, unknown>>(tRes.rows[0]?.settings, {});
  const configured = Array.isArray(rawSettings.approval_categories)
    ? (rawSettings.approval_categories as Array<Record<string, unknown>>)
    : [];
  const catMap = new Map<string, { key: string; label: string; color?: string; description?: string; sort_order: number }>();
  configured.forEach((c, idx) => {
    const k = normalizeWorkflowCategory(c?.key ?? c?.id);
    if (!k) return;
    catMap.set(k, {
      key: k,
      label: String(c?.label || c?.name || k).trim(),
      color: c?.color ? String(c.color).trim() : '#1E40FF',
      description: c?.description ? String(c.description).trim() : '',
      sort_order: Number(c?.sort_order ?? idx + 1),
    });
  });
  for (const r of wfCatsRes.rows) {
    const k = normalizeWorkflowCategory(r.category);
    if (!catMap.has(k)) {
      catMap.set(k, {
        key: k,
        label: r.category_label ? String(r.category_label).trim() : k,
        color: '#1E40FF',
        description: '',
        sort_order: catMap.size + 1,
      });
    }
  }
  return Array.from(catMap.values()).sort((a, b) => a.sort_order - b.sort_order);
}

const VALID_APPROVER_TYPES = new Set([
  'direct_manager',
  'team_leader',
  'department_head',
  'parent_department_head',
  'branch_director',
  'specific_role',
  'specific_user',
]);

export const approvalsRouter = Router();

approvalsRouter.use(ensureHrmApprovalsSchemaMiddleware);
approvalsRouter.use(requireTenantAuth);
approvalsRouter.use(requireEntitlement('approvals'));

// ============================================================================
// 1. Overview & Org Directory for Workflow Builder / Delegation Studio
// ============================================================================
approvalsRouter.get('/overview', requirePermission('approvals', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultApprovalWorkflowsInTx(client, ctx.tenantId);

      const [inboxCnt, mineStats, wfCnt, delCnt, usersRes, rolesRes, deptsRes, teamsRes, branchesRes] =
        await Promise.all([
          client.query<{ cnt: number }>(
            `SELECT COUNT(*)::int AS cnt
             FROM tenant_approval_step_logs l
             INNER JOIN tenant_approval_requests r ON r.tenant_id = l.tenant_id AND r.id = l.request_id
             WHERE l.tenant_id = $1 AND l.assigned_user_id = $2 AND l.status = 'pending' AND r.status = 'pending'`,
            [ctx.tenantId, ctx.userId]
          ),
          client.query<{
            pending_mine: number;
            approved_total: number;
            rejected_total: number;
          }>(
            `SELECT
               COALESCE(SUM(CASE WHEN status = 'pending' AND requester_user_id = $2 THEN 1 ELSE 0 END), 0) AS pending_mine,
               COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_total,
               COALESCE(SUM(CASE WHEN status IN ('rejected', 'returned') THEN 1 ELSE 0 END), 0) AS rejected_total
             FROM tenant_approval_requests
             WHERE tenant_id = $1`,
            [ctx.tenantId, ctx.userId]
          ),
          client.query<{ cnt: number }>(
            'SELECT COUNT(*)::int AS cnt FROM tenant_approval_workflows WHERE tenant_id = $1 AND is_active = true',
            [ctx.tenantId]
          ),
          client.query<{ cnt: number }>(
            'SELECT COUNT(*)::int AS cnt FROM tenant_approval_delegations WHERE tenant_id = $1 AND is_active = true',
            [ctx.tenantId]
          ),
          client.query(
            `SELECT id, full_name, email, role, role_id, branch_id, department_id, team_id, position_id, reports_to_user_id, avatar_url
             FROM users
             WHERE tenant_id = $1 AND COALESCE(is_system_bot, false) = false
             ORDER BY full_name ASC`,
            [ctx.tenantId]
          ),
          client.query(
            'SELECT id, role_key, name FROM tenant_roles WHERE tenant_id = $1 AND is_active = true ORDER BY name ASC',
            [ctx.tenantId]
          ),
          client.query(
            'SELECT id, code, name, parent_department_id, manager_user_id, branch_id FROM tenant_departments WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order ASC, name ASC',
            [ctx.tenantId]
          ),
          client.query(
            'SELECT id, code, name, department_id, branch_id, leader_user_id FROM tenant_teams WHERE tenant_id = $1 AND is_active = true ORDER BY name ASC',
            [ctx.tenantId]
          ),
          client.query(
            'SELECT id, code, name, manager_user_id, is_headquarters FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC, name ASC',
            [ctx.tenantId]
          ),
        ]);

      const categories = await listApprovalCategoriesInTx(client, ctx.tenantId);
      const st = mineStats.rows[0] || { pending_mine: 0, approved_total: 0, rejected_total: 0 };
      return {
        summary: {
          pending_to_approve: Number(inboxCnt.rows[0]?.cnt || 0),
          my_pending_requests: Number(st.pending_mine || 0),
          approved_requests: Number(st.approved_total || 0),
          rejected_or_returned: Number(st.rejected_total || 0),
          active_workflows: Number(wfCnt.rows[0]?.cnt || 0),
          active_delegations: Number(delCnt.rows[0]?.cnt || 0),
        },
        categories,
        directory: {
          users: usersRes.rows,
          roles: rolesRes.rows,
          departments: deptsRes.rows,
          teams: teamsRes.rows,
          branches: branchesRes.rows,
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'APPROVALS_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan phê duyệt.');
  }
});

approvalsRouter.get(['/categories', '/workflows/categories'], requirePermission('approvals', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const categories = await withTenantTransaction(ctx.tenantId, (client) =>
      listApprovalCategoriesInTx(client, ctx.tenantId)
    );
    res.json({ success: true, data: categories });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_APPROVAL_CATEGORIES_FAILED', err?.message || 'Không thể tải thể loại quy trình.');
  }
});

approvalsRouter.post(['/categories', '/workflows/categories'], requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const label = String(b.label || b.name || b.key || '').trim();
    if (!label) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên thể loại quy trình không được để trống.');
      return;
    }
    const key = normalizeWorkflowCategory(b.key ?? b.id ?? label);
    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await listApprovalCategoriesInTx(client, ctx.tenantId);
      const list: ApprovalCategoryDto[] = existing.map((c, idx) => ({
        key: c.key,
        label: c.label,
        color: c.color || '#1E40FF',
        description: c.description || '',
        sort_order: Number(c.sort_order ?? idx + 1),
      }));
      const item: ApprovalCategoryDto = {
        key,
        label,
        color: b.color ? String(b.color).trim() : '#1E40FF',
        description: b.description ? String(b.description).trim() : '',
        sort_order: Number(b.sort_order ?? list.length + 1),
      };
      const idx = list.findIndex((c) => c.key === key);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...item };
      } else {
        list.push(item);
      }
      await saveApprovalCategoriesInTx(client, ctx.tenantId, list);
      return { category: item, categories: list };
    });
    res.status(201).json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_APPROVAL_CATEGORY_FAILED', err?.message || 'Không thể tạo thể loại quy trình.');
  }
});

approvalsRouter.put(['/categories', '/workflows/categories'], requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const rawCats = Array.isArray(req.body?.categories) ? req.body.categories : Array.isArray(req.body) ? req.body : [];
    const normalized: ApprovalCategoryDto[] = rawCats
      .map((c: any, idx: number) => {
        const key = normalizeWorkflowCategory(c?.key ?? c?.id ?? c?.label);
        const label = String(c?.label || c?.name || key).trim();
        if (!label) return null;
        return {
          key,
          label,
          color: c?.color ? String(c.color).trim() : '#1E40FF',
          description: c?.description ? String(c.description).trim() : '',
          sort_order: Number(c?.sort_order ?? idx + 1),
        };
      })
      .filter((x: ApprovalCategoryDto | null): x is ApprovalCategoryDto => Boolean(x));

    const saved = await withTenantTransaction(ctx.tenantId, (client) =>
      saveApprovalCategoriesInTx(client, ctx.tenantId, normalized)
    );
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_APPROVAL_CATEGORIES_FAILED', err?.message || 'Không thể lưu thể loại quy trình.');
  }
});

approvalsRouter.put(['/categories/:key', '/workflows/categories/:key'], requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const key = normalizeWorkflowCategory(req.params.key);
    const b = req.body || {};
    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await listApprovalCategoriesInTx(client, ctx.tenantId);
      const list: ApprovalCategoryDto[] = existing.map((c, idx) => ({
        key: c.key,
        label: c.label,
        color: c.color || '#1E40FF',
        description: c.description || '',
        sort_order: Number(c.sort_order ?? idx + 1),
      }));
      const idx = list.findIndex((c) => c.key === key);
      const nextLabel = String(b.label || b.name || (idx >= 0 ? list[idx].label : key)).trim();
      const updatedItem: ApprovalCategoryDto = {
        key,
        label: nextLabel,
        color: b.color ? String(b.color).trim() : (idx >= 0 ? list[idx].color : '#1E40FF'),
        description: b.description !== undefined ? String(b.description).trim() : (idx >= 0 ? list[idx].description : ''),
        sort_order: Number(b.sort_order ?? (idx >= 0 ? list[idx].sort_order : list.length + 1)),
      };
      if (idx >= 0) list[idx] = updatedItem;
      else list.push(updatedItem);
      await saveApprovalCategoriesInTx(client, ctx.tenantId, list);
      await client.query(
        'UPDATE tenant_approval_workflows SET category_label = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND category = $2',
        [ctx.tenantId, key, nextLabel]
      );
      return { category: updatedItem, categories: list };
    });
    res.json({ success: true, data: saved });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_APPROVAL_CATEGORY_FAILED', err?.message || 'Không thể cập nhật thể loại quy trình.');
  }
});

approvalsRouter.delete(['/categories/:key', '/workflows/categories/:key'], requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const key = normalizeWorkflowCategory(req.params.key);
    const remaining = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await listApprovalCategoriesInTx(client, ctx.tenantId);
      const filtered: ApprovalCategoryDto[] = existing
        .filter((c) => c.key !== key)
        .map((c, idx) => ({
          key: c.key,
          label: c.label,
          color: c.color || '#1E40FF',
          description: c.description || '',
          sort_order: Number(c.sort_order ?? idx + 1),
        }));
      return saveApprovalCategoriesInTx(client, ctx.tenantId, filtered);
    });
    res.json({ success: true, data: { deleted: true, key, categories: remaining } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_APPROVAL_CATEGORY_FAILED', err?.message || 'Không thể xóa thể loại quy trình.');
  }
});

// ============================================================================
// 2. Workflows & Dynamic Steps Studio (`/workflows`)
// ============================================================================
approvalsRouter.get('/workflows', requirePermission('approvals', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      await ensureDefaultApprovalWorkflowsInTx(client, ctx.tenantId);
      const [wfRes, stepsRes] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_approval_workflows WHERE tenant_id = $1 ORDER BY is_active DESC, created_at ASC',
          [ctx.tenantId]
        ),
        client.query(
          `SELECT s.*, r.name AS approver_role_name, u.full_name AS approver_user_name
           FROM tenant_approval_workflow_steps s
           LEFT JOIN tenant_roles r ON r.tenant_id = s.tenant_id AND r.id = s.approver_role_id
           LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.approver_user_id
           WHERE s.tenant_id = $1
           ORDER BY s.step_order ASC, s.created_at ASC`,
          [ctx.tenantId]
        ),
      ]);

      const stepsByWf = new Map<string, any[]>();
      for (const st of stepsRes.rows) {
        const wfId = String(st.workflow_id);
        const list = stepsByWf.get(wfId) || [];
        list.push({
          ...st,
          min_amount_threshold: toNum(st.min_amount_threshold, 0),
          max_amount_threshold:
            st.max_amount_threshold !== null && st.max_amount_threshold !== undefined
              ? toNum(st.max_amount_threshold, 0)
              : null,
          sla_hours: Number(st.sla_hours || 24),
          require_signature: toBool(st.require_signature, false),
        });
        stepsByWf.set(wfId, list);
      }

      return wfRes.rows.map((w) => ({
        ...w,
        form_schema: parseJsonSafe<any[]>(w.form_schema, []),
        default_watcher_ids: parseJsonSafe<string[]>(w.default_watcher_ids, []),
        default_watcher_roles: parseJsonSafe<string[]>(w.default_watcher_roles, []),
        require_attachment: toBool(w.require_attachment, false),
        auto_approve_if_creator_is_approver: toBool(w.auto_approve_if_creator_is_approver, true),
        is_active: toBool(w.is_active, true),
        steps: stepsByWf.get(String(w.id)) || [],
      }));
    });

    res.json({ success: true, data: items });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_WORKFLOWS_FAILED', err?.message || 'Không thể tải danh sách luồng phê duyệt.');
  }
});

approvalsRouter.post('/workflows', requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Tên quy trình phê duyệt không được để trống.');
      return;
    }

    const category = normalizeWorkflowCategory(b.category);
    const categoryLabel = b.category_label ? String(b.category_label).trim() : null;
    const defaultWatcherIds = normalizeStringArray(b.default_watcher_ids);
    const defaultWatcherRoles = normalizeStringArray(b.default_watcher_roles);
    const wfId = crypto.randomUUID();
    const code = slugifyCode(b.code || `${category}_${wfId.slice(0, 6)}`, 'WF');
    const rawSteps = Array.isArray(b.steps) ? b.steps : [];

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await markApprovalsCustomOnlyInTx(client, ctx.tenantId, true);
      await client.query(
        `INSERT INTO tenant_approval_workflows (
           id, tenant_id, code, name, description, category, category_label, form_schema,
           icon_name, color_hex, require_attachment, auto_approve_if_creator_is_approver,
           default_watcher_ids, default_watcher_roles, is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16)`,
        [
          wfId,
          ctx.tenantId,
          code,
          name,
          b.description ? String(b.description).trim() : null,
          category,
          categoryLabel,
          JSON.stringify(Array.isArray(b.form_schema) ? b.form_schema : []),
          b.icon_name ? String(b.icon_name).trim() : 'FileCheck',
          b.color_hex ? String(b.color_hex).trim() : '#1E40FF',
          Boolean(b.require_attachment),
          b.auto_approve_if_creator_is_approver !== false,
          JSON.stringify(defaultWatcherIds),
          JSON.stringify(defaultWatcherRoles),
          b.is_active !== false,
          ctx.userId,
        ]
      );

      const effectiveSteps =
        rawSteps.length > 0
          ? rawSteps
          : [
              {
                step_order: 1,
                step_name: 'Quản lý trực tiếp duyệt',
                approver_type: 'direct_manager',
                min_amount_threshold: 0,
                max_amount_threshold: null,
                approval_mode: 'any_one',
                fallback_strategy: 'tenant_admin',
                sla_hours: 24,
              },
            ];

      for (let i = 0; i < effectiveSteps.length; i++) {
        const st = effectiveSteps[i] || {};
        const apType = VALID_APPROVER_TYPES.has(String(st.approver_type || ''))
          ? String(st.approver_type)
          : 'direct_manager';
        const mode = st.approval_mode === 'all_must_approve' ? 'all_must_approve' : 'any_one';
        const fallback =
          st.fallback_strategy === 'escalate_parent_dept' ? 'escalate_parent_dept' : 'tenant_admin';
        await client.query(
          `INSERT INTO tenant_approval_workflow_steps (
             id, tenant_id, workflow_id, step_order, step_name, approver_type,
             approver_role_id, approver_user_id, min_amount_threshold, max_amount_threshold,
             approval_mode, fallback_strategy, sla_hours, require_signature
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            crypto.randomUUID(),
            ctx.tenantId,
            wfId,
            Number(st.step_order || i + 1),
            String(st.step_name || `Bước ${i + 1}`).trim(),
            apType,
            st.approver_role_id || null,
            st.approver_user_id || null,
            Math.max(0, toNum(st.min_amount_threshold, 0)),
            st.max_amount_threshold !== null && st.max_amount_threshold !== undefined && st.max_amount_threshold !== ''
              ? toNum(st.max_amount_threshold, 0)
              : null,
            mode,
            fallback,
            Math.max(1, Number(st.sla_hours || 24)),
            Boolean(st.require_signature),
          ]
        );
      }

      const [wfRow, stRows] = await Promise.all([
        client.query('SELECT * FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          wfId,
        ]),
        client.query(
          'SELECT * FROM tenant_approval_workflow_steps WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY step_order ASC',
          [ctx.tenantId, wfId]
        ),
      ]);
      return {
        ...wfRow.rows[0],
        form_schema: parseJsonSafe<any[]>(wfRow.rows[0]?.form_schema, []),
        default_watcher_ids: parseJsonSafe<string[]>(wfRow.rows[0]?.default_watcher_ids, []),
        default_watcher_roles: parseJsonSafe<string[]>(wfRow.rows[0]?.default_watcher_roles, []),
        steps: stRows.rows,
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_WORKFLOW_FAILED', err?.message || 'Không thể tạo quy trình phê duyệt.');
  }
});

const updateWorkflowHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const wfId = String(req.params.id);
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query(
        'SELECT * FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, wfId]
      );
      if (existing.rows.length === 0) return null;
      const cur = existing.rows[0];
      await markApprovalsCustomOnlyInTx(client, ctx.tenantId, true);

      const nextCategory = b.category !== undefined ? normalizeWorkflowCategory(b.category) : cur.category;
      const nextCategoryLabel =
        b.category_label !== undefined
          ? (b.category_label ? String(b.category_label).trim() : null)
          : cur.category_label;
      const nextSchema =
        b.form_schema !== undefined
          ? JSON.stringify(Array.isArray(b.form_schema) ? b.form_schema : [])
          : JSON.stringify(parseJsonSafe<any[]>(cur.form_schema, []));
      const nextWatcherIds =
        b.default_watcher_ids !== undefined
          ? JSON.stringify(normalizeStringArray(b.default_watcher_ids))
          : JSON.stringify(parseJsonSafe<string[]>(cur.default_watcher_ids, []));
      const nextWatcherRoles =
        b.default_watcher_roles !== undefined
          ? JSON.stringify(normalizeStringArray(b.default_watcher_roles))
          : JSON.stringify(parseJsonSafe<string[]>(cur.default_watcher_roles, []));

      await client.query(
        `UPDATE tenant_approval_workflows
         SET name = $3,
             description = $4,
             category = $5,
             category_label = $6,
             form_schema = $7::jsonb,
             icon_name = $8,
             color_hex = $9,
             require_attachment = $10,
             auto_approve_if_creator_is_approver = $11,
             default_watcher_ids = $12::jsonb,
             default_watcher_roles = $13::jsonb,
             is_active = $14,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          wfId,
          b.name !== undefined ? String(b.name).trim() : cur.name,
          b.description !== undefined ? (b.description ? String(b.description).trim() : null) : cur.description,
          nextCategory,
          nextCategoryLabel,
          nextSchema,
          b.icon_name !== undefined ? String(b.icon_name).trim() : (cur.icon_name || 'FileCheck'),
          b.color_hex !== undefined ? String(b.color_hex).trim() : cur.color_hex,
          b.require_attachment !== undefined ? Boolean(b.require_attachment) : toBool(cur.require_attachment, false),
          b.auto_approve_if_creator_is_approver !== undefined
            ? Boolean(b.auto_approve_if_creator_is_approver)
            : toBool(cur.auto_approve_if_creator_is_approver, true),
          nextWatcherIds,
          nextWatcherRoles,
          b.is_active !== undefined ? Boolean(b.is_active) : toBool(cur.is_active, true),
        ]
      );

      if (Array.isArray(b.steps)) {
        await client.query(
          'DELETE FROM tenant_approval_workflow_steps WHERE tenant_id = $1 AND workflow_id = $2',
          [ctx.tenantId, wfId]
        );
        for (let i = 0; i < b.steps.length; i++) {
          const st = b.steps[i] || {};
          const apType = VALID_APPROVER_TYPES.has(String(st.approver_type || ''))
            ? String(st.approver_type)
            : 'direct_manager';
          const mode = st.approval_mode === 'all_must_approve' ? 'all_must_approve' : 'any_one';
          const fallback =
            st.fallback_strategy === 'escalate_parent_dept' ? 'escalate_parent_dept' : 'tenant_admin';
          await client.query(
            `INSERT INTO tenant_approval_workflow_steps (
               id, tenant_id, workflow_id, step_order, step_name, approver_type,
               approver_role_id, approver_user_id, min_amount_threshold, max_amount_threshold,
               approval_mode, fallback_strategy, sla_hours, require_signature
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              crypto.randomUUID(),
              ctx.tenantId,
              wfId,
              Number(st.step_order || i + 1),
              String(st.step_name || `Bước ${i + 1}`).trim(),
              apType,
              st.approver_role_id || null,
              st.approver_user_id || null,
              Math.max(0, toNum(st.min_amount_threshold, 0)),
              st.max_amount_threshold !== null && st.max_amount_threshold !== undefined && st.max_amount_threshold !== ''
                ? toNum(st.max_amount_threshold, 0)
                : null,
              mode,
              fallback,
              Math.max(1, Number(st.sla_hours || 24)),
              Boolean(st.require_signature),
            ]
          );
        }
      }

      const [wfRow, stRows] = await Promise.all([
        client.query('SELECT * FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          wfId,
        ]),
        client.query(
          'SELECT * FROM tenant_approval_workflow_steps WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY step_order ASC',
          [ctx.tenantId, wfId]
        ),
      ]);
      return {
        ...wfRow.rows[0],
        form_schema: parseJsonSafe<any[]>(wfRow.rows[0]?.form_schema, []),
        default_watcher_ids: parseJsonSafe<string[]>(wfRow.rows[0]?.default_watcher_ids, []),
        default_watcher_roles: parseJsonSafe<string[]>(wfRow.rows[0]?.default_watcher_roles, []),
        steps: stRows.rows,
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'WORKFLOW_NOT_FOUND', 'Không tìm thấy quy trình phê duyệt.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_WORKFLOW_FAILED', err?.message || 'Không thể cập nhật quy trình phê duyệt.');
  }
};

approvalsRouter.put('/workflows/:id', requirePermission('approvals', 'manage_config'), updateWorkflowHandler);
approvalsRouter.patch('/workflows/:id', requirePermission('approvals', 'manage_config'), updateWorkflowHandler);

const clearAllWorkflowsHandler = async (_req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await markApprovalsCustomOnlyInTx(client, ctx.tenantId, true);
      await client.query(
        `DELETE FROM tenant_approval_workflows w
         WHERE w.tenant_id = $1
           AND NOT EXISTS (SELECT 1 FROM tenant_approval_requests r WHERE r.tenant_id = w.tenant_id AND r.workflow_id = w.id)`,
        [ctx.tenantId]
      );
      await client.query(
        `UPDATE tenant_approval_workflows SET is_active = false, updated_at = clock_timestamp() WHERE tenant_id = $1`,
        [ctx.tenantId]
      );
    });
    res.json({ success: true, data: { cleared: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'CLEAR_WORKFLOWS_FAILED', err?.message || 'Không thể xóa danh sách quy trình mẫu.');
  }
};

approvalsRouter.post('/workflows/clear', requirePermission('approvals', 'manage_config'), clearAllWorkflowsHandler);
approvalsRouter.delete('/workflows/all', requirePermission('approvals', 'manage_config'), clearAllWorkflowsHandler);

approvalsRouter.post('/workflows/import-presets', requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const requestedCodes = Array.isArray(req.body?.codes)
      ? req.body.codes.map((c: unknown) => String(c || '').trim()).filter(Boolean)
      : [];
    const templates =
      requestedCodes.length > 0
        ? DEFAULT_APPROVAL_WORKFLOW_TEMPLATES.filter((t) => requestedCodes.includes(t.code))
        : DEFAULT_APPROVAL_WORKFLOW_TEMPLATES;

    const imported = await withTenantTransaction(ctx.tenantId, async (client) => {
      await markApprovalsCustomOnlyInTx(client, ctx.tenantId, true);
      const out: any[] = [];
      for (const tpl of templates) {
        const existingRes = await client.query<{ id: string; is_active: boolean }>(
          'SELECT id, is_active FROM tenant_approval_workflows WHERE tenant_id = $1 AND code = $2 LIMIT 1',
          [ctx.tenantId, tpl.code]
        );
        let wfId = existingRes.rows[0]?.id ? String(existingRes.rows[0].id) : '';
        if (wfId) {
          await client.query(
            `UPDATE tenant_approval_workflows
             SET is_active = true,
                 name = COALESCE(NULLIF(name, ''), $3),
                 category_label = COALESCE(category_label, $4),
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, wfId, tpl.name, tpl.category_label]
          );
          const stCnt = await client.query<{ cnt: number }>(
            'SELECT COUNT(*)::int AS cnt FROM tenant_approval_workflow_steps WHERE tenant_id = $1 AND workflow_id = $2',
            [ctx.tenantId, wfId]
          );
          if (Number(stCnt.rows[0]?.cnt || 0) === 0) {
            for (const st of tpl.steps) {
              await client.query(
                `INSERT INTO tenant_approval_workflow_steps (
                   id, tenant_id, workflow_id, step_order, step_name, approver_type,
                   min_amount_threshold, max_amount_threshold, approval_mode, fallback_strategy, sla_hours
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                  crypto.randomUUID(),
                  ctx.tenantId,
                  wfId,
                  st.step_order,
                  st.step_name,
                  st.approver_type,
                  st.min_amount_threshold,
                  st.max_amount_threshold,
                  st.approval_mode,
                  st.fallback_strategy,
                  st.sla_hours,
                ]
              );
            }
          }
        } else {
          wfId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_approval_workflows (
               id, tenant_id, code, name, description, category, category_label, form_schema, icon_name, color_hex, is_active, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, true, $11)`,
            [
              wfId,
              ctx.tenantId,
              tpl.code,
              tpl.name,
              tpl.description,
              tpl.category,
              tpl.category_label,
              JSON.stringify(tpl.form_schema),
              tpl.icon_name,
              tpl.color_hex,
              ctx.userId,
            ]
          );
          for (const st of tpl.steps) {
            await client.query(
              `INSERT INTO tenant_approval_workflow_steps (
                 id, tenant_id, workflow_id, step_order, step_name, approver_type,
                 min_amount_threshold, max_amount_threshold, approval_mode, fallback_strategy, sla_hours
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                crypto.randomUUID(),
                ctx.tenantId,
                wfId,
                st.step_order,
                st.step_name,
                st.approver_type,
                st.min_amount_threshold,
                st.max_amount_threshold,
                st.approval_mode,
                st.fallback_strategy,
                st.sla_hours,
              ]
            );
          }
        }
        const [wfRow, stRows] = await Promise.all([
          client.query('SELECT * FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, wfId]),
          client.query('SELECT * FROM tenant_approval_workflow_steps WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY step_order ASC', [ctx.tenantId, wfId]),
        ]);
        if (wfRow.rows[0]) {
          out.push({
            ...wfRow.rows[0],
            form_schema: parseJsonSafe<any[]>(wfRow.rows[0].form_schema, []),
            default_watcher_ids: parseJsonSafe<string[]>(wfRow.rows[0].default_watcher_ids, []),
            default_watcher_roles: parseJsonSafe<string[]>(wfRow.rows[0].default_watcher_roles, []),
            steps: stRows.rows,
          });
        }
      }
      return out;
    });

    res.status(201).json({ success: true, data: { imported_count: imported.length, items: imported } });
  } catch (err: any) {
    sendApiError(res, 500, 'IMPORT_WORKFLOW_PRESETS_FAILED', err?.message || 'Không thể nhập bộ quy trình mẫu.');
  }
});

approvalsRouter.delete('/workflows/:id', requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const wfId = String(req.params.id);
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await markApprovalsCustomOnlyInTx(client, ctx.tenantId, true);
      const reqCnt = await client.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM tenant_approval_requests WHERE tenant_id = $1 AND workflow_id = $2',
        [ctx.tenantId, wfId]
      );
      if (Number(reqCnt.rows[0]?.cnt || 0) > 0) {
        await client.query(
          'UPDATE tenant_approval_workflows SET is_active = false, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
          [ctx.tenantId, wfId]
        );
      } else {
        await client.query('DELETE FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          wfId,
        ]);
      }
    });
    res.json({ success: true, data: { deleted: true, id: wfId } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_WORKFLOW_FAILED', err?.message || 'Không thể xóa quy trình phê duyệt.');
  }
});

approvalsRouter.post('/workflows/:id/simulate', requirePermission('approvals', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const wfId = String(req.params.id);
    const requesterId = req.body?.requester_user_id ? String(req.body.requester_user_id) : ctx.userId;
    const amountVnd = toNum(req.body?.amount_vnd, 0);

    const steps = await withTenantTransaction(ctx.tenantId, async (client) => {
      const wfRes = await client.query(
        'SELECT category FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, wfId]
      );
      if (wfRes.rows.length === 0) throw new Error('WORKFLOW_NOT_FOUND');
      return resolveDynamicApprovalStepsInTx(client, {
        tenantId: ctx.tenantId,
        workflowId: wfId,
        requesterUserId: requesterId,
        amountVnd,
        category: String(wfRes.rows[0].category || 'custom_form'),
      });
    });

    res.json({ success: true, data: { steps } });
  } catch (err: any) {
    if (err?.message === 'WORKFLOW_NOT_FOUND') {
      sendApiError(res, 404, 'WORKFLOW_NOT_FOUND', 'Không tìm thấy quy trình phê duyệt.');
      return;
    }
    sendApiError(res, 500, 'SIMULATE_WORKFLOW_FAILED', err?.message || 'Không thể mô phỏng luồng duyệt.');
  }
});

// ============================================================================
// 3. Out-of-Office Delegation Manager (`/delegations`)
// ============================================================================
approvalsRouter.get('/delegations', requirePermission('approvals', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const rows = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT d.*,
                u1.full_name AS delegator_name, u1.email AS delegator_email,
                u2.full_name AS delegate_name, u2.email AS delegate_email
         FROM tenant_approval_delegations d
         LEFT JOIN users u1 ON u1.tenant_id = d.tenant_id AND u1.id = d.delegator_user_id
         LEFT JOIN users u2 ON u2.tenant_id = d.tenant_id AND u2.id = d.delegate_user_id
         WHERE d.tenant_id = $1
         ORDER BY d.is_active DESC, d.valid_until DESC`,
        [ctx.tenantId]
      );
      return r.rows.map((item) => ({
        ...item,
        categories: parseJsonSafe<string[]>(item.categories, []),
        is_active: toBool(item.is_active, true),
      }));
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_DELEGATIONS_FAILED', err?.message || 'Không thể tải danh sách ủy quyền.');
  }
});

approvalsRouter.post('/delegations', requirePermission('approvals', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const delegatorUserId = b.delegator_user_id ? String(b.delegator_user_id) : ctx.userId;
    const delegateUserId = String(b.delegate_user_id || '').trim();
    if (!delegateUserId || delegatorUserId === delegateUserId) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Người nhận ủy quyền không hợp lệ hoặc trùng với người ủy quyền.');
      return;
    }

    const validFrom = b.valid_from ? new Date(b.valid_from) : new Date();
    const validUntil = b.valid_until
      ? new Date(b.valid_until)
      : new Date(Date.now() + 7 * 24 * 3600_000);
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validUntil.getTime()) || validUntil <= validFrom) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Thời hạn ủy quyền không hợp lệ.');
      return;
    }

    const id = crypto.randomUUID();
    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      if (delegatorUserId !== ctx.userId) {
        const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
        if (!rbac.effectivePermissions.approvals?.actions.manage_config) {
          throw new Error('FORBIDDEN_DELEGATE_OTHER');
        }
      }
      await client.query(
        `INSERT INTO tenant_approval_delegations (
           id, tenant_id, delegator_user_id, delegate_user_id, categories,
           valid_from, valid_until, reason, is_active
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, true)`,
        [
          id,
          ctx.tenantId,
          delegatorUserId,
          delegateUserId,
          JSON.stringify(Array.isArray(b.categories) ? b.categories : []),
          validFrom.toISOString(),
          validUntil.toISOString(),
          b.reason ? String(b.reason).trim() : null,
        ]
      );
      const r = await client.query(
        `SELECT d.*, u1.full_name AS delegator_name, u2.full_name AS delegate_name
         FROM tenant_approval_delegations d
         LEFT JOIN users u1 ON u1.tenant_id = d.tenant_id AND u1.id = d.delegator_user_id
         LEFT JOIN users u2 ON u2.tenant_id = d.tenant_id AND u2.id = d.delegate_user_id
         WHERE d.tenant_id = $1 AND d.id = $2`,
        [ctx.tenantId, id]
      );
      return {
        ...r.rows[0],
        categories: parseJsonSafe<string[]>(r.rows[0]?.categories, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_DELEGATE_OTHER') {
      sendApiError(res, 403, 'FORBIDDEN_RBAC_PERMISSION', 'Chỉ Quản trị viên mới được tạo ủy quyền thay người khác.');
      return;
    }
    sendApiError(res, 500, 'CREATE_DELEGATION_FAILED', err?.message || 'Không thể tạo ủy quyền phê duyệt.');
  }
});

approvalsRouter.patch('/delegations/:id', requirePermission('approvals', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);
    const isActive = Boolean(req.body?.is_active);

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const check = await client.query(
        'SELECT * FROM tenant_approval_delegations WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (check.rows.length === 0) return null;
      await client.query(
        'UPDATE tenant_approval_delegations SET is_active = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id, isActive]
      );
      const r = await client.query('SELECT * FROM tenant_approval_delegations WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'DELEGATION_NOT_FOUND', 'Không tìm thấy bản ghi ủy quyền.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_DELEGATION_FAILED', err?.message || 'Không thể cập nhật trạng thái ủy quyền.');
  }
});

approvalsRouter.delete('/delegations/:id', requirePermission('approvals', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query('DELETE FROM tenant_approval_delegations WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        req.params.id,
      ]);
    });
    res.json({ success: true, data: { deleted: true, id: req.params.id } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_DELEGATION_FAILED', err?.message || 'Không thể xóa ủy quyền.');
  }
});

// ============================================================================
// 4. Approval Requests Inbox, Tracker & Action Engine (`/requests`)
// ============================================================================
approvalsRouter.get('/requests', requirePermission('approvals', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const viewMode = String(req.query.view || 'all').trim().toLowerCase();
    const statusFilter = req.query.status ? String(req.query.status).trim() : null;
    const categoryFilter = req.query.category ? String(req.query.category).trim() : null;

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const apprScope = rbac.effectivePermissions.approvals?.scope || 'own';

      const params: unknown[] = [];
      let where = '';

      if (viewMode === 'inbox') {
        params.push(ctx.tenantId, ctx.userId);
        where = `r.tenant_id = $1 AND r.status = 'pending' AND EXISTS (
          SELECT 1 FROM tenant_approval_step_logs sl
          WHERE sl.tenant_id = r.tenant_id
            AND sl.request_id = r.id
            AND sl.assigned_user_id = $2
            AND sl.status = 'pending'
        )`;
      } else if (viewMode === 'mine') {
        params.push(ctx.tenantId, ctx.userId);
        where = 'r.tenant_id = $1 AND r.requester_user_id = $2';
      } else if (viewMode === 'following') {
        params.push(ctx.tenantId, ctx.userId, JSON.stringify([ctx.userId]));
        where = `r.tenant_id = $1 AND (
          r.requester_user_id = $2
          OR COALESCE(r.form_data->'related_user_ids', '[]'::jsonb) @> $3::jsonb
          OR COALESCE(r.form_data->'watcher_ids', '[]'::jsonb) @> $3::jsonb
          OR EXISTS (
            SELECT 1 FROM tenant_approval_step_logs slf
            WHERE slf.tenant_id = r.tenant_id AND slf.request_id = r.id AND slf.assigned_user_id = $2
          )
        )`;
      } else {
        const scopeSql = rbac.userOrg
          ? await buildGranularScopeWhereClause(client, ctx.tenantId, rbac.userOrg, apprScope, {
              tenantColumn: 'r.tenant_id',
              ownerColumn: 'r.requester_user_id',
              startParamIndex: 1,
            })
          : { clause: 'r.tenant_id = $1', values: [ctx.tenantId], nextIndex: 2 };
        params.push(...scopeSql.values, ctx.userId);
        const pMe = `$${params.length}`;
        where = `(${scopeSql.clause} OR EXISTS (
          SELECT 1 FROM tenant_approval_step_logs sl2
          WHERE sl2.tenant_id = r.tenant_id AND sl2.request_id = r.id AND sl2.assigned_user_id = ${pMe}
        ))`;
      }

      if (statusFilter && statusFilter !== 'all') {
        params.push(statusFilter);
        where += ` AND r.status = $${params.length}`;
      }
      if (categoryFilter && categoryFilter !== 'all') {
        params.push(categoryFilter);
        where += ` AND r.category = $${params.length}`;
      }

      const reqRows = await client.query(
        `SELECT r.*, w.name AS workflow_name, w.color_hex AS workflow_color,
                u.full_name AS requester_name, u.email AS requester_email,
                d.name AS requester_department_name
         FROM tenant_approval_requests r
         LEFT JOIN tenant_approval_workflows w ON w.tenant_id = r.tenant_id AND w.id = r.workflow_id
         LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.requester_user_id
         LEFT JOIN tenant_departments d ON d.tenant_id = u.tenant_id AND d.id = u.department_id
         WHERE ${where}
         ORDER BY r.created_at DESC
         LIMIT 150`,
        params
      );

      const reqIds = reqRows.rows.map((x) => String(x.id));
      const logsByReq = new Map<string, any[]>();
      if (reqIds.length > 0) {
        const ph = reqIds.map((_, idx) => `$${idx + 2}`).join(', ');
        const logRows = await client.query(
          `SELECT l.*, u.full_name AS assigned_user_name, u.email AS assigned_user_email,
                  du.full_name AS delegated_from_user_name
           FROM tenant_approval_step_logs l
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_user_id
           LEFT JOIN users du ON du.tenant_id = l.tenant_id AND du.id = l.delegated_from_user_id
           WHERE l.tenant_id = $1 AND l.request_id IN (${ph})
           ORDER BY l.step_order ASC, l.created_at ASC`,
          [ctx.tenantId, ...reqIds]
        );
        for (const lg of logRows.rows) {
          const rid = String(lg.request_id);
          const arr = logsByReq.get(rid) || [];
          arr.push(lg);
          logsByReq.set(rid, arr);
        }
      }

      return reqRows.rows.map((row) => {
        const logs = logsByReq.get(String(row.id)) || [];
        const canCurrentUserAct = logs.some(
          (l) => String(l.assigned_user_id) === ctx.userId && l.status === 'pending' && row.status === 'pending'
        );
        const activePendingLog = logs.find((l) => l.status === 'pending') || null;
        const dueAtStr = activePendingLog?.due_at ? String(activePendingLog.due_at) : null;
        const remainingHours = dueAtStr
          ? Math.round(((new Date(dueAtStr).getTime() - Date.now()) / 3_600_000) * 10) / 10
          : null;
        const slaState =
          row.status !== 'pending' || remainingHours === null
            ? 'completed'
            : remainingHours < 0
              ? 'overdue_escalated'
              : remainingHours <= 4
                ? 'due_soon'
                : 'on_track';

        return {
          ...row,
          amount_vnd: toNum(row.amount_vnd, 0),
          form_data: parseJsonSafe<Record<string, unknown>>(row.form_data, {}),
          attachments: parseJsonSafe<any[]>(row.attachments, []),
          resolved_steps_snapshot: parseJsonSafe<any[]>(row.resolved_steps_snapshot, []),
          step_logs: logs,
          can_current_user_act: canCurrentUserAct,
          sla_status: {
            due_at: dueAtStr,
            remaining_hours: remainingHours,
            is_overdue: remainingHours !== null && remainingHours < 0 && row.status === 'pending',
            escalation_state: slaState,
          },
        };
      });
    });

    res.json({ success: true, data: items });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_REQUESTS_FAILED', err?.message || 'Không thể tải danh sách tờ trình phê duyệt.');
  }
});

async function safeOptionalQueryInTx(client: any, sql: string, params: unknown[]): Promise<any[]> {
  const sp = `sp_appr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    await client.query(`SAVEPOINT ${sp}`);
    const r = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return r.rows || [];
  } catch {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    } catch {
      // ignore rollback failure
    }
    return [];
  }
}

async function resolveLinkedEntityPreviewInTx(
  client: any,
  tenantId: string,
  row: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const category = String(row.category || '').toLowerCase();
  const linkedType = String(row.linked_entity_type || category).toLowerCase();
  const linkedId = row.linked_entity_id ? String(row.linked_entity_id) : null;
  const formData = parseJsonSafe<Record<string, unknown>>(row.form_data, {});

  const branchRows = await safeOptionalQueryInTx(
    client,
    'SELECT name, legal_entity_name, tax_code, address FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC LIMIT 1',
    [tenantId]
  );
  const hq = branchRows[0] || {};

  // 1. Leave / Overtime / Attendance Explanation -> Employee Leave Balance & Dept Overlap
  if (category === 'leave' || category === 'overtime' || category === 'attendance_explanation') {
    const empRows = await safeOptionalQueryInTx(
      client,
      `SELECT e.employee_code, e.full_name, e.annual_leave_quota, e.annual_leave_used, e.compensatory_leave_balance,
              e.department_id, d.name AS department_name
       FROM tenant_hr_employees e
       LEFT JOIN tenant_departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       WHERE e.tenant_id = $1 AND e.user_id = $2
       LIMIT 1`,
      [tenantId, row.requester_user_id]
    );
    const emp = empRows[0] || null;
    const quota = emp ? toNum(emp.annual_leave_quota, 12) : 12;
    const used = emp ? toNum(emp.annual_leave_used, 0) : 0;

    let overlappingDeptLeaves: any[] = [];
    if (emp?.department_id && row.start_date) {
      overlappingDeptLeaves = await safeOptionalQueryInTx(
        client,
        `SELECT r.id, r.request_code, r.title, r.start_date, r.end_date, r.status, u.full_name AS requester_name
         FROM tenant_approval_requests r
         INNER JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.requester_user_id
         WHERE r.tenant_id = $1
           AND r.category = 'leave'
           AND r.status IN ('pending', 'approved')
           AND r.id <> $2
           AND u.department_id = $3
         ORDER BY r.created_at DESC LIMIT 5`,
        [tenantId, row.id, emp.department_id]
      );
    }

    return {
      preview_type: 'leave_balance',
      employee: emp
        ? {
            employee_code: emp.employee_code,
            full_name: emp.full_name,
            department_name: emp.department_name || null,
            annual_leave_quota: quota,
            annual_leave_used: used,
            annual_leave_remaining: Math.max(0, quota - used),
            compensatory_leave_balance: toNum(emp.compensatory_leave_balance, 0),
          }
        : {
            annual_leave_quota: 12,
            annual_leave_used: 0,
            annual_leave_remaining: 12,
          },
      requested_days: toNum(formData.total_days ?? formData.days, 1),
      leave_type: formData.leave_type || null,
      overlapping_department_leaves: overlappingDeptLeaves,
    };
  }

  // 2. Purchase Order / Sales Order -> Vendor/Customer & Line Items Preview
  if (category === 'purchase_order' || category === 'sales_order' || linkedType === 'purchase_order' || linkedType === 'sales_order') {
    const isPo = category === 'purchase_order' || linkedType === 'purchase_order';
    let orderDoc: any = null;
    let lineItems: any[] = Array.isArray(formData.items) ? (formData.items as any[]) : [];

    if (linkedId) {
      const orderTable = isPo ? 'tenant_purchase_orders' : 'tenant_sales_orders';
      const itemTable = isPo ? 'tenant_purchase_order_items' : 'tenant_sales_order_items';
      const fkCol = isPo ? 'purchase_order_id' : 'sales_order_id';
      const oRows = await safeOptionalQueryInTx(
        client,
        `SELECT * FROM ${orderTable} WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, linkedId]
      );
      orderDoc = oRows[0] || null;
      const iRows = await safeOptionalQueryInTx(
        client,
        `SELECT * FROM ${itemTable} WHERE tenant_id = $1 AND ${fkCol} = $2 ORDER BY created_at ASC`,
        [tenantId, linkedId]
      );
      if (iRows.length > 0) lineItems = iRows;
      else if (orderDoc?.items_json) {
        lineItems = parseJsonSafe<any[]>(orderDoc.items_json, lineItems);
      }
    }

    return {
      preview_type: isPo ? 'purchase_order' : 'sales_order',
      legal_entity: hq,
      partner_name: orderDoc?.supplier_name || orderDoc?.customer_name || formData.vendor_name || formData.customer_name || null,
      order_code: orderDoc?.po_code || orderDoc?.so_code || row.request_code,
      delivery_days: formData.delivery_days || null,
      total_amount_vnd: toNum(orderDoc?.total_amount_vnd ?? row.amount_vnd, 0),
      line_items: lineItems,
    };
  }

  // 3. Deposit / Cash Advance -> Milestone Tranches & Dynamic VietQR Bank Info
  if (category === 'cash_advance' || linkedType === 'deposit') {
    let milestones: any[] = Array.isArray(formData.milestones) ? (formData.milestones as any[]) : [];
    if (linkedId) {
      const mRows = await safeOptionalQueryInTx(
        client,
        'SELECT * FROM tenant_deposit_milestones WHERE tenant_id = $1 AND (deposit_id = $2 OR id = $2) ORDER BY tranche_number ASC',
        [tenantId, linkedId]
      );
      if (mRows.length > 0) milestones = mRows;
    }
    return {
      preview_type: 'deposit_milestone',
      legal_entity: hq,
      amount_vnd: toNum(row.amount_vnd, 0),
      beneficiary_bank: formData.beneficiary_bank || null,
      beneficiary_account: formData.beneficiary_account || null,
      milestones,
    };
  }

  // 4. Expense / Contract / Custom -> Voucher Receipt & VAT Preview
  let expenseDoc: any = null;
  if (linkedId) {
    const eRows = await safeOptionalQueryInTx(
      client,
      'SELECT * FROM tenant_expenses WHERE tenant_id = $1 AND id = $2 LIMIT 1',
      [tenantId, linkedId]
    );
    expenseDoc = eRows[0] || null;
  }

  return {
    preview_type: 'expense_receipt',
    legal_entity: hq,
    expense_category: expenseDoc?.category || formData.expense_category || category,
    amount_vnd: toNum(expenseDoc?.amount_vnd ?? row.amount_vnd, 0),
    vat_amount_vnd: toNum(expenseDoc?.vat_amount_vnd ?? formData.vat_amount_vnd, 0),
    has_vat_invoice: Boolean(expenseDoc?.has_vat_invoice ?? formData.has_vat_invoice),
    beneficiary_bank: formData.beneficiary_bank || null,
    beneficiary_account: formData.beneficiary_account || null,
    items: Array.isArray(formData.items) ? formData.items : [],
  };
}

approvalsRouter.get('/requests/:id/linked-preview', requirePermission('approvals', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);

    const preview = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'SELECT * FROM tenant_approval_requests WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, id]
      );
      if (!r.rows[0]) return null;
      return resolveLinkedEntityPreviewInTx(client, ctx.tenantId, r.rows[0]);
    });

    if (!preview) {
      sendApiError(res, 404, 'REQUEST_NOT_FOUND', 'Không tìm thấy tờ trình phê duyệt.');
      return;
    }
    res.json({ success: true, data: preview });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_LINKED_PREVIEW_FAILED', err?.message || 'Không thể tải thông tin chứng từ gốc.');
  }
});

approvalsRouter.get('/requests/:id', requirePermission('approvals', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = String(req.params.id);

    const detail = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT r.*, w.name AS workflow_name, w.form_schema, u.full_name AS requester_name, u.email AS requester_email
         FROM tenant_approval_requests r
         LEFT JOIN tenant_approval_workflows w ON w.tenant_id = r.tenant_id AND w.id = r.workflow_id
         LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.requester_user_id
         WHERE r.tenant_id = $1 AND r.id = $2
         LIMIT 1`,
        [ctx.tenantId, id]
      );
      if (r.rows.length === 0) return null;
      const logs = await client.query(
        `SELECT l.*, u.full_name AS assigned_user_name, du.full_name AS delegated_from_user_name
         FROM tenant_approval_step_logs l
         LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_user_id
         LEFT JOIN users du ON du.tenant_id = l.tenant_id AND du.id = l.delegated_from_user_id
         WHERE l.tenant_id = $1 AND l.request_id = $2
         ORDER BY l.step_order ASC, l.created_at ASC`,
        [ctx.tenantId, id]
      );
      const row = r.rows[0];
      const linkedPreview = await resolveLinkedEntityPreviewInTx(client, ctx.tenantId, row);
      const activePendingLog = logs.rows.find((l) => l.status === 'pending') || null;
      const dueAtStr = activePendingLog?.due_at ? String(activePendingLog.due_at) : null;
      const remainingHours = dueAtStr
        ? Math.round(((new Date(dueAtStr).getTime() - Date.now()) / 3_600_000) * 10) / 10
        : null;

      return {
        ...row,
        amount_vnd: toNum(row.amount_vnd, 0),
        form_data: parseJsonSafe<Record<string, unknown>>(row.form_data, {}),
        attachments: parseJsonSafe<any[]>(row.attachments, []),
        step_logs: logs.rows,
        linked_preview: linkedPreview,
        sla_status: {
          due_at: dueAtStr,
          remaining_hours: remainingHours,
          is_overdue: remainingHours !== null && remainingHours < 0 && row.status === 'pending',
          escalation_state:
            row.status !== 'pending' || remainingHours === null
              ? 'completed'
              : remainingHours < 0
                ? 'overdue_escalated'
                : remainingHours <= 4
                  ? 'due_soon'
                  : 'on_track',
        },
      };
    });

    if (!detail) {
      sendApiError(res, 404, 'REQUEST_NOT_FOUND', 'Không tìm thấy tờ trình phê duyệt.');
      return;
    }
    res.json({ success: true, data: detail });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_REQUEST_FAILED', err?.message || 'Không thể tải chi tiết tờ trình.');
  }
});

approvalsRouter.post('/requests', requirePermission('approvals', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const workflowId = String(b.workflow_id || '').trim();
    const title = String(b.title || '').trim();
    if (!workflowId || !title) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Vui lòng chọn quy trình phê duyệt và nhập tiêu đề tờ trình.');
      return;
    }

    const result = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rawFormData = b.form_data && typeof b.form_data === 'object' ? { ...(b.form_data as Record<string, unknown>) } : {};
      const wfMetaRes = await client.query<{ default_watcher_ids: unknown; default_watcher_roles: unknown }>(
        'SELECT default_watcher_ids, default_watcher_roles FROM tenant_approval_workflows WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, workflowId]
      );
      const wfMeta = wfMetaRes.rows[0];
      const defIds = parseJsonSafe<string[]>(wfMeta?.default_watcher_ids, []);
      const defRoles = parseJsonSafe<string[]>(wfMeta?.default_watcher_roles, []);
      let roleUserIds: string[] = [];
      if (defRoles.length > 0) {
        const lowerRoles = defRoles.map((r) => String(r || '').toLowerCase().trim()).filter(Boolean);
        if (lowerRoles.length > 0) {
          const uRes = await client.query<{ id: string }>(
            `SELECT id FROM users
             WHERE tenant_id = $1
               AND (LOWER(COALESCE(role, '')) = ANY($2::text[]) OR COALESCE(role_id::text, '') = ANY($2::text[]))
               AND COALESCE(is_system_bot, false) = false`,
            [ctx.tenantId, lowerRoles]
          );
          roleUserIds = uRes.rows.map((u) => String(u.id));
        }
      }
      const explicitWatchers = normalizeStringArray(b.watcher_ids ?? rawFormData.related_user_ids ?? rawFormData.watcher_ids);
      const mergedWatchers = Array.from(new Set([...defIds.map(String), ...roleUserIds, ...explicitWatchers])).filter(
        (uid) => uid && uid !== ctx.userId
      );
      if (mergedWatchers.length > 0 || rawFormData.related_user_ids !== undefined) {
        rawFormData.related_user_ids = mergedWatchers;
        rawFormData.watcher_ids = mergedWatchers;
      }

      return createApprovalRequestInTx(client, {
        tenantId: ctx.tenantId,
        workflowId,
        requesterUserId: ctx.userId,
        title,
        description: b.description,
        amountVnd: toNum(b.amount_vnd, 0),
        currency: b.currency,
        startDate: b.start_date || null,
        endDate: b.end_date || null,
        formData: rawFormData,
        attachments: Array.isArray(b.attachments) ? b.attachments : [],
        linkedEntityType: b.linked_entity_type || null,
        linkedEntityId: b.linked_entity_id || null,
      });
    });

    res.status(201).json({
      success: true,
      data: {
        ...result.request,
        amount_vnd: toNum(result.request.amount_vnd, 0),
        form_data: parseJsonSafe<Record<string, unknown>>(result.request.form_data, {}),
        step_logs: result.step_logs,
      },
    });
  } catch (err: any) {
    if (err?.message === 'WORKFLOW_NOT_FOUND') {
      sendApiError(res, 404, 'WORKFLOW_NOT_FOUND', 'Quy trình phê duyệt không tồn tại.');
      return;
    }
    sendApiError(res, 500, 'CREATE_REQUEST_FAILED', err?.message || 'Không thể khởi tạo tờ trình phê duyệt.');
  }
});

const decideRequestHandler = async (req: any, res: any) => {
  try {
    const ctx = getTenantContext();
    const requestId = String(req.params.id);
    const decision = String(req.body?.decision || req.body?.action || '').trim().toLowerCase();
    const comment = req.body?.comment ? String(req.body.comment).trim() : null;
    const signatureDataUrl = req.body?.signature_data_url ? String(req.body.signature_data_url) : null;

    if (!['approve', 'approved', 'reject', 'rejected', 'return', 'returned'].includes(decision)) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Hành động phê duyệt không hợp lệ (approve | reject | return).');
      return;
    }

    const normalizedDecision: 'approved' | 'rejected' | 'returned' = decision.startsWith('approv')
      ? 'approved'
      : decision.startsWith('reject')
        ? 'rejected'
        : 'returned';

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const reqRes = await client.query(
        'SELECT * FROM tenant_approval_requests WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, requestId]
      );
      if (reqRes.rows.length === 0) throw new Error('REQUEST_NOT_FOUND');
      const apprReq = reqRes.rows[0];
      if (apprReq.status !== 'pending') {
        throw new Error('REQUEST_ALREADY_CLOSED');
      }

      const curStepOrder = Number(apprReq.current_step_order || 1);
      const pendingLogsRes = await client.query(
        `SELECT * FROM tenant_approval_step_logs
         WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'pending'`,
        [ctx.tenantId, requestId, curStepOrder]
      );

      let myLog = pendingLogsRes.rows.find((l) => String(l.assigned_user_id) === ctx.userId);
      if (!myLog) {
        // Allow Workspace Owner / manage_config admin emergency override only if explicitly permitted
        const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
        if (rbac.userOrg?.is_tenant_owner && pendingLogsRes.rows.length > 0) {
          myLog = pendingLogsRes.rows[0];
        } else {
          throw new Error('NOT_ASSIGNED_APPROVER');
        }
      }

      await client.query(
        `UPDATE tenant_approval_step_logs
         SET status = $3,
             action_comment = $4,
             signature_data_url = COALESCE($5, signature_data_url),
             acted_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, myLog.id, normalizedDecision, comment, signatureDataUrl]
      );

      let finalRequestStatus = 'pending';
      let nextStepOrder = curStepOrder;

      if (normalizedDecision === 'rejected' || normalizedDecision === 'returned') {
        finalRequestStatus = normalizedDecision;
        await client.query(
          `UPDATE tenant_approval_step_logs
           SET status = 'skipped', updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND request_id = $2 AND status IN ('pending', 'waiting')`,
          [ctx.tenantId, requestId]
        );
        await client.query(
          `UPDATE tenant_approval_requests
           SET status = $3, completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, requestId, finalRequestStatus]
        );
      } else {
        // Approved on current step
        const stepMode = String(myLog.approval_mode || 'any_one');
        if (stepMode === 'any_one') {
          await client.query(
            `UPDATE tenant_approval_step_logs
             SET status = 'skipped', updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'pending'`,
            [ctx.tenantId, requestId, curStepOrder]
          );
        }

        const remainingCurStep = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM tenant_approval_step_logs
           WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'pending'`,
          [ctx.tenantId, requestId, curStepOrder]
        );

        if (Number(remainingCurStep.rows[0]?.cnt || 0) === 0) {
          // Check if there is a next step waiting
          const waitingNextRes = await client.query<{ next_order: number | null }>(
            `SELECT MIN(step_order) AS next_order
             FROM tenant_approval_step_logs
             WHERE tenant_id = $1 AND request_id = $2 AND status = 'waiting'`,
            [ctx.tenantId, requestId]
          );
          const nextOrd = waitingNextRes.rows[0]?.next_order
            ? Number(waitingNextRes.rows[0].next_order)
            : null;

          if (nextOrd !== null && nextOrd > curStepOrder) {
            nextStepOrder = nextOrd;
            await client.query(
              `UPDATE tenant_approval_step_logs
               SET status = 'pending', updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'waiting'`,
              [ctx.tenantId, requestId, nextStepOrder]
            );
            await client.query(
              `UPDATE tenant_approval_requests
               SET current_step_order = $3, updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [ctx.tenantId, requestId, nextStepOrder]
            );
          } else {
            finalRequestStatus = 'approved';
            await client.query(
              `UPDATE tenant_approval_requests
               SET status = 'approved', completed_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [ctx.tenantId, requestId]
            );
          }
        }
      }

      // Cross-module synchronization upon final decision
      if (finalRequestStatus === 'approved' || finalRequestStatus === 'rejected') {
        if (apprReq.linked_entity_type === 'attendance_explanation' && apprReq.linked_entity_id) {
          const expStatus = finalRequestStatus === 'approved' ? 'approved' : 'rejected';
          await client.query(
            `UPDATE tenant_hr_attendance_explanations
             SET status = $3, reviewed_by = $4, reviewed_at = clock_timestamp(), review_comment = $5, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, apprReq.linked_entity_id, expStatus, ctx.userId, comment]
          );

          if (expStatus === 'approved') {
            const expRowRes = await client.query(
              'SELECT * FROM tenant_hr_attendance_explanations WHERE tenant_id = $1 AND id = $2 LIMIT 1',
              [ctx.tenantId, apprReq.linked_entity_id]
            );
            const expRow = expRowRes.rows[0];
            if (expRow) {
              if (expRow.attendance_log_id) {
                await client.query(
                  `UPDATE tenant_hr_attendance_logs
                   SET status = 'explained',
                       attendance_code = 'X',
                       work_units = $3,
                       late_minutes = 0,
                       early_leave_minutes = 0,
                       updated_at = clock_timestamp()
                   WHERE tenant_id = $1 AND id = $2`,
                  [ctx.tenantId, expRow.attendance_log_id, toNum(expRow.requested_work_units, 1)]
                );
              } else {
                await client.query(
                  `INSERT INTO tenant_hr_attendance_logs (
                     id, tenant_id, user_id, employee_id, work_date, attendance_code,
                     within_geofence, work_units, status, note
                   ) VALUES ($1, $2, $3, $4, $5, 'X', true, $6, 'explained', $7)
                   ON CONFLICT (tenant_id, user_id, work_date)
                   DO UPDATE SET status = 'explained', attendance_code = 'X', work_units = EXCLUDED.work_units`,
                  [
                    crypto.randomUUID(),
                    ctx.tenantId,
                    expRow.user_id,
                    expRow.employee_id || null,
                    expRow.work_date,
                    toNum(expRow.requested_work_units, 1),
                    `Đã duyệt giải trình: ${expRow.reason}`,
                  ]
                );
              }
            }
          }
        }

        if (finalRequestStatus === 'approved' && apprReq.category === 'leave') {
          const fd = parseJsonSafe<Record<string, unknown>>(apprReq.form_data, {});
          const days = Math.max(0, toNum(fd.total_days ?? fd.days, 1));
          const leaveType = String(fd.leave_type || '').toLowerCase();
          if (days > 0 && !leaveType.includes('không lương')) {
            await client.query(
              `UPDATE tenant_hr_employees
               SET annual_leave_used = annual_leave_used + $3, updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND user_id = $2`,
              [ctx.tenantId, apprReq.requester_user_id, days]
            );
          }
        }
      }

      const [finalReq, finalLogs] = await Promise.all([
        client.query('SELECT * FROM tenant_approval_requests WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          requestId,
        ]),
        client.query(
          `SELECT l.*, u.full_name AS assigned_user_name, du.full_name AS delegated_from_user_name
           FROM tenant_approval_step_logs l
           LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.assigned_user_id
           LEFT JOIN users du ON du.tenant_id = l.tenant_id AND du.id = l.delegated_from_user_id
           WHERE l.tenant_id = $1 AND l.request_id = $2
           ORDER BY l.step_order ASC, l.created_at ASC`,
          [ctx.tenantId, requestId]
        ),
      ]);

      return {
        ...finalReq.rows[0],
        amount_vnd: toNum(finalReq.rows[0]?.amount_vnd, 0),
        form_data: parseJsonSafe<Record<string, unknown>>(finalReq.rows[0]?.form_data, {}),
        step_logs: finalLogs.rows,
      };
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    if (err?.message === 'REQUEST_NOT_FOUND') {
      sendApiError(res, 404, 'REQUEST_NOT_FOUND', 'Không tìm thấy tờ trình phê duyệt.');
      return;
    }
    if (err?.message === 'REQUEST_ALREADY_CLOSED') {
      sendApiError(res, 409, 'REQUEST_ALREADY_CLOSED', 'Tờ trình này đã kết thúc luồng phê duyệt.');
      return;
    }
    if (err?.message === 'NOT_ASSIGNED_APPROVER') {
      sendApiError(res, 403, 'NOT_ASSIGNED_APPROVER', 'Tài khoản của bạn không phải người duyệt ở bước hiện tại.');
      return;
    }
    sendApiError(res, 500, 'DECIDE_REQUEST_FAILED', err?.message || 'Không thể thực hiện phê duyệt tờ trình.');
  }
};

approvalsRouter.post('/requests/:id/decide', requirePermission('approvals', 'approve'), decideRequestHandler);
approvalsRouter.post('/requests/:id/action', requirePermission('approvals', 'approve'), decideRequestHandler);

// Batch Approve / Batch Reject (`/requests/batch-decide`)
approvalsRouter.post('/requests/batch-decide', requirePermission('approvals', 'approve'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const requestIds: string[] = Array.isArray(req.body?.request_ids)
      ? req.body.request_ids.map((x: unknown) => String(x || '').trim()).filter(Boolean)
      : [];
    const decisionRaw = String(req.body?.decision || req.body?.action || '').trim().toLowerCase();
    const comment = req.body?.comment ? String(req.body.comment).trim() : null;
    const signatureDataUrl = req.body?.signature_data_url ? String(req.body.signature_data_url) : null;

    if (requestIds.length === 0) {
      sendApiError(res, 422, 'REQUEST_IDS_REQUIRED', 'Vui lòng chọn ít nhất 1 tờ trình để phê duyệt hàng loạt.');
      return;
    }
    if (!['approve', 'approved', 'reject', 'rejected', 'return', 'returned'].includes(decisionRaw)) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Hành động hàng loạt không hợp lệ (approve | reject | return).');
      return;
    }

    const normalizedDecision: 'approved' | 'rejected' | 'returned' = decisionRaw.startsWith('approv')
      ? 'approved'
      : decisionRaw.startsWith('reject')
        ? 'rejected'
        : 'returned';

    const summary = await withTenantTransaction(ctx.tenantId, async (client) => {
      const rbac = await resolveUserEffectivePermissions(client, ctx.tenantId, ctx.userId);
      const isOwner = Boolean(rbac.userOrg?.is_tenant_owner);
      const succeededIds: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      for (const reqId of requestIds.slice(0, 100)) {
        const reqRes = await client.query(
          'SELECT * FROM tenant_approval_requests WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, reqId]
        );
        const apprReq = reqRes.rows[0];
        if (!apprReq) {
          skipped.push({ id: reqId, reason: 'REQUEST_NOT_FOUND' });
          continue;
        }
        if (apprReq.status !== 'pending') {
          skipped.push({ id: reqId, reason: 'REQUEST_ALREADY_CLOSED' });
          continue;
        }

        const curStepOrder = Number(apprReq.current_step_order || 1);
        const pendingLogsRes = await client.query(
          `SELECT * FROM tenant_approval_step_logs
           WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'pending'`,
          [ctx.tenantId, reqId, curStepOrder]
        );
        const myLog =
          pendingLogsRes.rows.find((l) => String(l.assigned_user_id) === ctx.userId) ||
          (isOwner ? pendingLogsRes.rows[0] : null);

        if (!myLog) {
          skipped.push({ id: reqId, reason: 'NOT_ASSIGNED_APPROVER' });
          continue;
        }

        await client.query(
          `UPDATE tenant_approval_step_logs
           SET status = $3,
               action_comment = $4,
               signature_data_url = COALESCE($5, signature_data_url),
               acted_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, myLog.id, normalizedDecision, comment, signatureDataUrl]
        );

        let finalStatus = 'pending';
        if (normalizedDecision === 'rejected' || normalizedDecision === 'returned') {
          finalStatus = normalizedDecision;
          await client.query(
            `UPDATE tenant_approval_step_logs
             SET status = 'skipped', updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND request_id = $2 AND status IN ('pending', 'waiting')`,
            [ctx.tenantId, reqId]
          );
          await client.query(
            `UPDATE tenant_approval_requests
             SET status = $3, completed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, reqId, finalStatus]
          );
        } else {
          if (String(myLog.approval_mode || 'any_one') === 'any_one') {
            await client.query(
              `UPDATE tenant_approval_step_logs
               SET status = 'skipped', updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'pending'`,
              [ctx.tenantId, reqId, curStepOrder]
            );
          }

          const remRes = await client.query<{ cnt: number }>(
            `SELECT COUNT(*)::int AS cnt
             FROM tenant_approval_step_logs
             WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'pending'`,
            [ctx.tenantId, reqId, curStepOrder]
          );
          if (Number(remRes.rows[0]?.cnt || 0) === 0) {
            const waitRes = await client.query<{ next_order: number | null }>(
              `SELECT MIN(step_order) AS next_order
               FROM tenant_approval_step_logs
               WHERE tenant_id = $1 AND request_id = $2 AND status = 'waiting'`,
              [ctx.tenantId, reqId]
            );
            const nextOrd = waitRes.rows[0]?.next_order ? Number(waitRes.rows[0].next_order) : null;
            if (nextOrd !== null && nextOrd > curStepOrder) {
              await client.query(
                `UPDATE tenant_approval_step_logs
                 SET status = 'pending', updated_at = clock_timestamp()
                 WHERE tenant_id = $1 AND request_id = $2 AND step_order = $3 AND status = 'waiting'`,
                [ctx.tenantId, reqId, nextOrd]
              );
              await client.query(
                `UPDATE tenant_approval_requests
                 SET current_step_order = $3, updated_at = clock_timestamp()
                 WHERE tenant_id = $1 AND id = $2`,
                [ctx.tenantId, reqId, nextOrd]
              );
            } else {
              finalStatus = 'approved';
              await client.query(
                `UPDATE tenant_approval_requests
                 SET status = 'approved', completed_at = clock_timestamp(), updated_at = clock_timestamp()
                 WHERE tenant_id = $1 AND id = $2`,
                [ctx.tenantId, reqId]
              );
            }
          }
        }

        if (finalStatus === 'approved' && apprReq.category === 'leave') {
          const fd = parseJsonSafe<Record<string, unknown>>(apprReq.form_data, {});
          const days = Math.max(0, toNum(fd.total_days ?? fd.days, 1));
          const leaveType = String(fd.leave_type || '').toLowerCase();
          if (days > 0 && !leaveType.includes('không lương')) {
            await client.query(
              `UPDATE tenant_hr_employees
               SET annual_leave_used = annual_leave_used + $3, updated_at = clock_timestamp()
               WHERE tenant_id = $1 AND user_id = $2`,
              [ctx.tenantId, apprReq.requester_user_id, days]
            );
          }
        }

        succeededIds.push(reqId);
      }

      return {
        decision: normalizedDecision,
        requested_count: requestIds.length,
        processed_count: succeededIds.length,
        succeeded_ids: succeededIds,
        skipped,
      };
    });

    res.json({ success: true, data: summary });
  } catch (err: any) {
    sendApiError(res, 500, 'BATCH_DECIDE_FAILED', err?.message || 'Không thể xử lý phê duyệt hàng loạt.');
  }
});
