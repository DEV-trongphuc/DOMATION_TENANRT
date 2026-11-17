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
import {
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

const VALID_CATEGORIES = new Set([
  'leave',
  'overtime',
  'cash_advance',
  'expense',
  'purchase_order',
  'sales_order',
  'contract',
  'custom_form',
  'attendance_explanation',
]);

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

      const [inboxCnt, mineStats, wfCnt, delCnt, usersRes, rolesRes, deptsRes, branchesRes] =
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
            `SELECT id, full_name, email, role, role_id, branch_id, department_id, team_id
             FROM users
             WHERE tenant_id = $1 AND is_system_bot = false
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
            'SELECT id, code, name, manager_user_id, is_headquarters FROM tenant_branches WHERE tenant_id = $1 AND is_active = true ORDER BY is_headquarters DESC, name ASC',
            [ctx.tenantId]
          ),
        ]);

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
        directory: {
          users: usersRes.rows,
          roles: rolesRes.rows,
          departments: deptsRes.rows,
          branches: branchesRes.rows,
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'APPROVALS_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan phê duyệt.');
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

    const category = VALID_CATEGORIES.has(String(b.category || '')) ? String(b.category) : 'custom_form';
    const wfId = crypto.randomUUID();
    const code = slugifyCode(b.code || `${category}_${wfId.slice(0, 6)}`, 'WF');
    const rawSteps = Array.isArray(b.steps) ? b.steps : [];

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_approval_workflows (
           id, tenant_id, code, name, description, category, form_schema,
           icon_name, color_hex, require_attachment, auto_approve_if_creator_is_approver,
           is_active, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)`,
        [
          wfId,
          ctx.tenantId,
          code,
          name,
          b.description ? String(b.description).trim() : null,
          category,
          JSON.stringify(Array.isArray(b.form_schema) ? b.form_schema : []),
          b.icon_name ? String(b.icon_name).trim() : 'FileCheck',
          b.color_hex ? String(b.color_hex).trim() : '#1E40FF',
          Boolean(b.require_attachment),
          b.auto_approve_if_creator_is_approver !== false,
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

      const nextCategory =
        b.category && VALID_CATEGORIES.has(String(b.category)) ? String(b.category) : cur.category;
      const nextSchema =
        b.form_schema !== undefined
          ? JSON.stringify(Array.isArray(b.form_schema) ? b.form_schema : [])
          : JSON.stringify(parseJsonSafe<any[]>(cur.form_schema, []));

      await client.query(
        `UPDATE tenant_approval_workflows
         SET name = $3,
             description = $4,
             category = $5,
             form_schema = $6::jsonb,
             color_hex = $7,
             require_attachment = $8,
             is_active = $9,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          wfId,
          b.name !== undefined ? String(b.name).trim() : cur.name,
          b.description !== undefined ? (b.description ? String(b.description).trim() : null) : cur.description,
          nextCategory,
          nextSchema,
          b.color_hex !== undefined ? String(b.color_hex).trim() : cur.color_hex,
          b.require_attachment !== undefined ? Boolean(b.require_attachment) : toBool(cur.require_attachment, false),
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

approvalsRouter.delete('/workflows/:id', requirePermission('approvals', 'manage_config'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const wfId = String(req.params.id);
    await withTenantTransaction(ctx.tenantId, async (client) => {
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
        return {
          ...row,
          amount_vnd: toNum(row.amount_vnd, 0),
          form_data: parseJsonSafe<Record<string, unknown>>(row.form_data, {}),
          attachments: parseJsonSafe<any[]>(row.attachments, []),
          resolved_steps_snapshot: parseJsonSafe<any[]>(row.resolved_steps_snapshot, []),
          step_logs: logs,
          can_current_user_act: canCurrentUserAct,
        };
      });
    });

    res.json({ success: true, data: items });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_REQUESTS_FAILED', err?.message || 'Không thể tải danh sách tờ trình phê duyệt.');
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
      return {
        ...row,
        amount_vnd: toNum(row.amount_vnd, 0),
        form_data: parseJsonSafe<Record<string, unknown>>(row.form_data, {}),
        attachments: parseJsonSafe<any[]>(row.attachments, []),
        step_logs: logs.rows,
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

    const result = await withTenantTransaction(ctx.tenantId, (client) =>
      createApprovalRequestInTx(client, {
        tenantId: ctx.tenantId,
        workflowId,
        requesterUserId: ctx.userId,
        title,
        description: b.description,
        amountVnd: toNum(b.amount_vnd, 0),
        currency: b.currency,
        startDate: b.start_date || null,
        endDate: b.end_date || null,
        formData: b.form_data && typeof b.form_data === 'object' ? b.form_data : {},
        attachments: Array.isArray(b.attachments) ? b.attachments : [],
        linkedEntityType: b.linked_entity_type || null,
        linkedEntityId: b.linked_entity_id || null,
      })
    );

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
