import crypto from 'node:crypto';
import { Router } from 'express';
import { crm360Router } from '../../modules/crm-360/index.ts';
import { router as projectsRouter } from '../../modules/projects/index.ts';
import { router as educationRouter } from '../../modules/education-addon/index.ts';
import { ensureCrm360Schema } from '../../modules/crm-360/schema.ts';
import { ensureErpOpsSchema } from '../../modules/erp-ops/schema.ts';
import {
  bstr,
  bridge,
  fail,
  handler,
  isUuid,
  listPayload,
  mapEntityData,
  mapListData,
  num,
  ok,
  parseJson,
  requireAnyPermission,
  requirePermission,
  tx,
  withAliases,
} from './shared.ts';

export const workspaceCompatRouter = Router();

const mapTaskAliases = (row: any) =>
  withAliases(row, {
    subject: (r) => r.subject || r.title || 'Công việc',
    title: (r) => r.title || r.subject || 'Công việc',
    status: (r) => r.status || r.status_key || 'todo',
    status_key: (r) => r.status_key || r.status || 'todo',
    assignee_id: 'assignee_user_id',
    assigned_to: 'assignee_user_id',
    assignee_name: (r) => r.assignee_name || r.assigned_to_name || 'Chưa giao',
    created_by_name: (r) => r.created_by_name || r.reporter_name || 'Quản trị viên',
    subtasks: (r) => parseJson(r.checklist_json, Array.isArray(r.subtasks) ? r.subtasks : []),
    dependencies: (r) => parseJson(r.dependencies_json, []),
  });

// ---- Personal Workspace & Task Groups ----
workspaceCompatRouter.get(
  '/task-groups',
  requirePermission('workspace_personal', 'view'),
  handler('COMPAT_TASK_GROUPS_LIST', async (_req, res) => {
    const groups = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query(
        `SELECT * FROM tenant_workspace_task_groups
         WHERE tenant_id = $1 AND user_id = $2
         ORDER BY is_pinned DESC, sort_order ASC, created_at ASC`,
        [ctx.tenantId, ctx.userId]
      );
      return r.rows;
    });
    ok(res, groups);
  })
);

workspaceCompatRouter.post(
  '/task-groups',
  bridge(crm360Router, '/workspace/groups')
);
workspaceCompatRouter.put(
  '/task-groups/:id',
  bridge(crm360Router, (req) => `/workspace/groups/${req.params.id}`)
);
workspaceCompatRouter.delete(
  '/task-groups/:id',
  bridge(crm360Router, (req) => `/workspace/groups/${req.params.id}`)
);
workspaceCompatRouter.post(
  '/task-groups/reorder',
  bridge(crm360Router, '/workspace/groups/reorder')
);
workspaceCompatRouter.post(
  '/task-groups/:id/toggle-pin',
  requirePermission('workspace_personal', 'edit'),
  handler('COMPAT_TASK_GROUP_PIN', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID nhóm việc không hợp lệ.');
      return;
    }
    const updated = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query(
        `UPDATE tenant_workspace_task_groups
         SET is_pinned = NOT is_pinned, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND user_id = $3 RETURNING *`,
        [ctx.tenantId, id, ctx.userId]
      );
      return r.rows[0] || null;
    });
    ok(res, updated);
  })
);

// ---- Tasks (Workspace + Projects) ----
workspaceCompatRouter.get(
  '/tasks',
  bridge(projectsRouter, '/tasks/list', {
    transform: (payload) => mapListData(payload, mapTaskAliases),
  })
);
workspaceCompatRouter.post(
  '/tasks',
  bridge(crm360Router, '/workspace/tasks', {
    mapBody: (b) => ({
      ...b,
      title: b?.title || b?.subject || 'Công việc mới',
      assignee_user_id: isUuid(b?.assignee_user_id) ? b.assignee_user_id : isUuid(b?.assigned_to) ? b.assigned_to : undefined,
      checklist_json: b?.subtasks || b?.checklist_json,
    }),
    transform: (payload) => mapEntityData(payload, mapTaskAliases),
  })
);
workspaceCompatRouter.put(
  '/tasks/:id/status',
  requireAnyPermission([
    ['workspace_personal', 'edit'],
    ['projects', 'edit'],
  ]),
  handler('COMPAT_TASK_STATUS', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID công việc không hợp lệ.');
      return;
    }
    const statusKey = bstr(req.body, 'status', 'status_key') || 'todo';
    const updated = await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      const r = await client.query(
        `UPDATE tenant_tasks
         SET status_key = $1,
             progress_pct = CASE WHEN $1 IN ('done', 'completed') THEN 100 ELSE progress_pct END,
             completed_at = CASE WHEN $1 IN ('done', 'completed') THEN clock_timestamp() ELSE NULL END,
             updated_at = clock_timestamp()
         WHERE tenant_id = $2 AND id = $3 RETURNING *`,
        [statusKey, ctx.tenantId, id]
      );
      return r.rows[0] ? mapTaskAliases(r.rows[0]) : null;
    });
    if (!updated) {
      fail(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
      return;
    }
    ok(res, updated, 'Đã cập nhật trạng thái.');
  })
);

workspaceCompatRouter.post(
  '/tasks/:id/duplicate',
  requireAnyPermission([
    ['workspace_personal', 'create'],
    ['projects', 'create'],
  ]),
  handler('COMPAT_TASK_DUPLICATE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const created = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      const src = r.rows[0];
      if (!src) return null;
      const newId = crypto.randomUUID();
      const ins = await client.query(
        `INSERT INTO tenant_tasks (
          id, tenant_id, project_id, lead_id, group_id, title, description, status_key, priority,
          assignee_user_id, reporter_user_id, start_date, due_date, estimated_minutes, checklist_json, category
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'todo', $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [
          newId,
          ctx.tenantId,
          src.project_id,
          src.lead_id,
          src.group_id,
          `${src.title} (Bản sao)`,
          src.description,
          src.priority || 'medium',
          src.assignee_user_id || ctx.userId,
          ctx.userId,
          src.start_date,
          src.due_date,
          num(src.estimated_minutes, 60),
          typeof src.checklist_json === 'string' ? src.checklist_json : JSON.stringify(src.checklist_json || []),
          src.category || 'personal',
        ]
      );
      return mapTaskAliases(ins.rows[0]);
    });
    ok(res, created, 'Đã nhân bản công việc.', 201);
  })
);

workspaceCompatRouter.delete('/tasks/:id', bridge(projectsRouter, (req) => `/tasks/${req.params.id}`));

// ---- Activity / Task Drawer Sub-routes (scoped by #130 agreement) ----
workspaceCompatRouter.get(
  '/activities/:id/comments',
  bridge(projectsRouter, (req) => `/tasks/${req.params.id}/comments`)
);
workspaceCompatRouter.post(
  '/activities/:id/comments',
  bridge(projectsRouter, (req) => `/tasks/${req.params.id}/comments`)
);
workspaceCompatRouter.delete(
  '/activities/comments/:id',
  requireAnyPermission([
    ['workspace_personal', 'delete'],
    ['projects', 'delete'],
  ]),
  handler('COMPAT_TASK_COMMENT_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      await client.query('DELETE FROM tenant_task_comments WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    ok(res, { id, deleted: true });
  })
);
workspaceCompatRouter.get(
  '/activities/:id/dependencies',
  bridge(projectsRouter, (req) => `/tasks/${req.params.id}/dependencies`)
);
workspaceCompatRouter.post(
  '/activities/:id/dependencies',
  bridge(crm360Router, (req) => `/workspace/tasks/${req.params.id}/dependencies`)
);
workspaceCompatRouter.get(
  '/activities/:id/timeline',
  requirePermission('workspace_personal', 'view'),
  handler('COMPAT_ACTIVITY_TIMELINE', async (_req, res) => {
    ok(res, []);
  })
);
workspaceCompatRouter.get(
  '/activities/:id/hide-status',
  requirePermission('workspace_personal', 'view'),
  handler('COMPAT_TASK_HIDE_STATUS', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      ok(res, { is_hidden: false });
      return;
    }
    const row = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query('SELECT is_hidden FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0] || { is_hidden: false };
    });
    ok(res, { is_hidden: Boolean(row.is_hidden) });
  })
);
workspaceCompatRouter.post(
  '/activities/:id/toggle-hide',
  requirePermission('workspace_personal', 'edit'),
  handler('COMPAT_TASK_TOGGLE_HIDE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const row = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query(
        'UPDATE tenant_tasks SET is_hidden = NOT is_hidden, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 RETURNING is_hidden',
        [ctx.tenantId, id]
      );
      return r.rows[0] || { is_hidden: false };
    });
    ok(res, row);
  })
);
workspaceCompatRouter.get(
  '/activities/:id/mute-status',
  requirePermission('workspace_personal', 'view'),
  handler('COMPAT_TASK_MUTE_STATUS', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      ok(res, { is_muted: false });
      return;
    }
    const row = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query('SELECT is_muted FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      return r.rows[0] || { is_muted: false };
    });
    ok(res, { is_muted: Boolean(row.is_muted) });
  })
);
workspaceCompatRouter.post(
  '/activities/:id/toggle-mute',
  requirePermission('workspace_personal', 'edit'),
  handler('COMPAT_TASK_TOGGLE_MUTE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const row = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query(
        'UPDATE tenant_tasks SET is_muted = NOT is_muted, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 RETURNING is_muted',
        [ctx.tenantId, id]
      );
      return r.rows[0] || { is_muted: false };
    });
    ok(res, row);
  })
);
workspaceCompatRouter.post(
  '/activities/:id/move-group',
  requirePermission('workspace_personal', 'edit'),
  handler('COMPAT_TASK_MOVE_GROUP', async (req, res) => {
    const id = req.params.id;
    const groupId = isUuid(req.body?.group_id) ? req.body.group_id : null;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const row = await tx(async (client, ctx) => {
      await ensureCrm360Schema();
      const r = await client.query(
        'UPDATE tenant_tasks SET group_id = $1, updated_at = clock_timestamp() WHERE tenant_id = $2 AND id = $3 RETURNING *',
        [groupId, ctx.tenantId, id]
      );
      return r.rows[0] || null;
    });
    ok(res, row);
  })
);
workspaceCompatRouter.get(
  '/activities/:id/subtasks-comment-counts',
  requirePermission('workspace_personal', 'view'),
  handler('COMPAT_SUBTASKS_COMMENT_COUNTS', async (_req, res) => {
    ok(res, {});
  })
);

// ---- Workflow Task Templates ----
workspaceCompatRouter.get('/workflow-task-templates', bridge(projectsRouter, '/workflow-templates/list'));
workspaceCompatRouter.post('/workflow-task-templates', bridge(projectsRouter, '/workflow-templates'));
workspaceCompatRouter.delete('/workflow-task-templates/:id', bridge(projectsRouter, (req) => `/workflow-templates/${req.params.id}`));

// ---- Projects ----
workspaceCompatRouter.get('/projects', bridge(projectsRouter, '/'));
workspaceCompatRouter.post('/projects', bridge(projectsRouter, '/'));
workspaceCompatRouter.get(
  '/projects/:id',
  requirePermission('projects', 'view'),
  handler('COMPAT_PROJECT_DETAIL', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    const data = await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      const pRes = await client.query('SELECT * FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      const proj = pRes.rows[0];
      if (!proj) return null;
      const [tasksRes, rosterRes] = await Promise.all([
        client.query(
          'SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND project_id = $2 ORDER BY sort_order ASC, created_at DESC',
          [ctx.tenantId, id]
        ),
        client.query('SELECT * FROM tenant_project_roster WHERE tenant_id = $1 AND project_id = $2', [ctx.tenantId, id]),
      ]);
      return {
        ...proj,
        tasks: tasksRes.rows.map(mapTaskAliases),
        roster: rosterRes.rows,
      };
    });
    if (!data) {
      fail(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    ok(res, data);
  })
);
workspaceCompatRouter.put('/projects/:id', bridge(projectsRouter, (req) => `/${req.params.id}`, { method: 'PATCH' }));
workspaceCompatRouter.delete('/projects/:id', bridge(projectsRouter, (req) => `/${req.params.id}`));
workspaceCompatRouter.post(
  '/projects/:id/duplicate',
  requirePermission('projects', 'create'),
  handler('COMPAT_PROJECT_DUPLICATE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    const created = await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      const srcRes = await client.query('SELECT * FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        id,
      ]);
      const src = srcRes.rows[0];
      if (!src) return null;
      const newId = crypto.randomUUID();
      const newCode = `${src.code}-COPY-${Date.now().toString().slice(-4)}`;
      const ins = await client.query(
        `INSERT INTO tenant_projects (
          id, tenant_id, code, name, description, status, priority, owner_user_id, budget_vnd, progress_pct
        ) VALUES ($1, $2, $3, $4, $5, 'planning', $6, $7, $8, 0) RETURNING *`,
        [
          newId,
          ctx.tenantId,
          newCode,
          `${src.name} (Bản sao)`,
          src.description,
          src.priority || 'medium',
          src.owner_user_id || ctx.userId,
          num(src.budget_vnd, 0),
        ]
      );
      return ins.rows[0];
    });
    ok(res, created, 'Đã nhân bản dự án.', 201);
  })
);

// ---- Tickets & Education Classes ----
workspaceCompatRouter.get('/tickets', bridge(projectsRouter, '/tickets/list'));
workspaceCompatRouter.post('/tickets', bridge(crm360Router, '/tickets'));
workspaceCompatRouter.get('/tickets/:id', bridge(crm360Router, (req) => `/tickets/${req.params.id}`));
workspaceCompatRouter.put('/tickets/:id', bridge(crm360Router, (req) => `/tickets/${req.params.id}`));
workspaceCompatRouter.delete(
  '/tickets/:id',
  requirePermission('helpdesk', 'delete'),
  handler('COMPAT_TICKET_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await ensureErpOpsSchema();
      await client.query('DELETE FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    ok(res, { id, deleted: true });
  })
);
workspaceCompatRouter.get('/tickets/:id/comments', bridge(projectsRouter, (req) => `/tickets/${req.params.id}/comments`));
workspaceCompatRouter.post('/tickets/:id/comments', bridge(crm360Router, (req) => `/tickets/${req.params.id}/comments`));
workspaceCompatRouter.delete('/tickets/:id/comments/:commentId', bridge(crm360Router, (req) => `/tickets/${req.params.id}/comments/${req.params.commentId}`));

workspaceCompatRouter.get('/classes', bridge(educationRouter, '/classes'));
workspaceCompatRouter.get('/academic/class-gradebook/:id', bridge(educationRouter, (req) => `/classes/${req.params.id}/gradebook-matrix`));
workspaceCompatRouter.post('/academic/class-gradebook/:id', bridge(educationRouter, (req) => `/classes/${req.params.id}/gradebook-batch`));
