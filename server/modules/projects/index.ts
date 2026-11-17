import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requireEntitlement,
  requirePermission,
  requireTenantAuth,
  sendApiError,
} from '../../core/security/rbac.ts';
import { maskContactPiiIfDisallowed } from '../../core/security/pii-masker.ts';
import {
  clampLimit,
  ensureErpOpsSchema,
  parseJsonSafe,
  resolveActorContext,
} from '../erp-ops/schema.ts';

export const router = Router();

router.use(requireTenantAuth);
router.use(requireEntitlement('erp_projects_tasks'));
router.use(async (_req, _res, next) => {
  try {
    await ensureErpOpsSchema();
    next();
  } catch (err) {
    next(err);
  }
});

const DEFAULT_KANBAN_COLUMNS = [
  { key: 'todo', label: 'Cần làm', color: '#64748B' },
  { key: 'in_progress', label: 'Đang thực hiện', color: '#1E40FF' },
  { key: 'review', label: 'Chờ nghiệm thu', color: '#D97706' },
  { key: 'done', label: 'Hoàn thành', color: '#10B981', is_done: true },
];

const VALID_DEPENDENCY_TYPES = new Set(['FS', 'SS', 'FF', 'SF']);
const VALID_PROJECT_ROLES = new Set(['owner', 'manager', 'member', 'viewer']);

type TxClient = Parameters<Parameters<typeof withTenantTransaction>[1]>[0];

async function recomputeProjectProgressInTx(
  client: TxClient,
  tenantId: string,
  projectId: string | null | undefined
): Promise<void> {
  if (!projectId) return;
  const projRes = await client.query<{ task_columns_json: unknown }>(
    'SELECT task_columns_json FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1',
    [tenantId, projectId]
  );
  const cols = parseJsonSafe<Array<{ key: string; is_done?: boolean }>>(
    projRes.rows[0]?.task_columns_json,
    DEFAULT_KANBAN_COLUMNS
  );
  const doneKeys = new Set(cols.filter((c) => c.is_done || c.key === 'done').map((c) => c.key));
  doneKeys.add('done');

  const tasksRes = await client.query<{ status_key: string; progress_pct: number }>(
    'SELECT status_key, progress_pct FROM tenant_tasks WHERE tenant_id = $1 AND project_id = $2',
    [tenantId, projectId]
  );
  if (tasksRes.rows.length === 0) {
    await client.query(
      'UPDATE tenant_projects SET progress_pct = 0, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
      [tenantId, projectId]
    );
    return;
  }

  let totalPct = 0;
  for (const t of tasksRes.rows) {
    if (doneKeys.has(t.status_key)) {
      totalPct += 100;
    } else {
      totalPct += Math.min(99, Math.max(0, Number(t.progress_pct || 0)));
    }
  }
  const avgPct = Math.round(totalPct / tasksRes.rows.length);
  await client.query(
    'UPDATE tenant_projects SET progress_pct = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
    [tenantId, projectId, avgPct]
  );
}

async function hasDependencyPathInTx(
  client: TxClient,
  tenantId: string,
  fromTaskId: string,
  targetTaskId: string
): Promise<boolean> {
  if (fromTaskId === targetTaskId) return true;
  const visited = new Set<string>([fromTaskId]);
  const queue: string[] = [fromTaskId];
  let guard = 0;

  while (queue.length > 0 && guard < 100) {
    guard++;
    const current = queue.shift()!;
    const r = await client.query<{ predecessor_task_id: string }>(
      'SELECT predecessor_task_id FROM tenant_task_dependencies WHERE tenant_id = $1 AND task_id = $2',
      [tenantId, current]
    );
    for (const row of r.rows) {
      const predId = String(row.predecessor_task_id);
      if (predId === targetTaskId) return true;
      if (!visited.has(predId)) {
        visited.add(predId);
        queue.push(predId);
      }
    }
  }
  return false;
}

async function applyPredecessorConstraintsToTaskInTx(
  client: TxClient,
  tenantId: string,
  taskId: string
): Promise<boolean> {
  const taskRes = await client.query<{
    id: string;
    start_date: string | Date | null;
    due_date: string | Date | null;
  }>('SELECT id, start_date, due_date FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
    tenantId,
    taskId,
  ]);
  const task = taskRes.rows[0];
  if (!task) return false;

  const depsRes = await client.query<{
    dependency_type: string;
    lag_days: number;
    pred_start: string | Date | null;
    pred_due: string | Date | null;
  }>(
    `SELECT d.dependency_type, d.lag_days,
            pred.start_date AS pred_start,
            pred.due_date AS pred_due
     FROM tenant_task_dependencies d
     INNER JOIN tenant_tasks pred
       ON pred.tenant_id = d.tenant_id AND pred.id = d.predecessor_task_id
     WHERE d.tenant_id = $1 AND d.task_id = $2`,
    [tenantId, taskId]
  );

  if (depsRes.rows.length === 0) return false;

  const nowMs = Date.now();
  const curStartMs = task.start_date ? new Date(task.start_date).getTime() : nowMs;
  const curDueMs = task.due_date ? new Date(task.due_date).getTime() : curStartMs + 86_400_000;
  const durationMs = Math.max(3_600_000, curDueMs - curStartMs);

  const candidateStarts: number[] = [];
  for (const dep of depsRes.rows) {
    const predStartMs = dep.pred_start ? new Date(dep.pred_start).getTime() : curStartMs;
    const predDueMs = dep.pred_due ? new Date(dep.pred_due).getTime() : predStartMs + 86_400_000;
    const lagMs = Math.round(Number(dep.lag_days || 0)) * 86_400_000;
    const depType = String(dep.dependency_type || 'FS').toUpperCase();

    if (depType === 'SS') {
      candidateStarts.push(predStartMs + lagMs);
    } else if (depType === 'FF') {
      candidateStarts.push(predDueMs + lagMs - durationMs);
    } else if (depType === 'SF') {
      candidateStarts.push(predStartMs + lagMs - durationMs);
    } else {
      candidateStarts.push(predDueMs + lagMs);
    }
  }

  if (candidateStarts.length === 0) return false;

  const targetStartMs = Math.max(...candidateStarts);
  const targetDueMs = targetStartMs + durationMs;

  if (Math.abs(targetStartMs - curStartMs) < 1000 && Math.abs(targetDueMs - curDueMs) < 1000) {
    return false;
  }

  await client.query(
    `UPDATE tenant_tasks
     SET start_date = $3,
         due_date = $4,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, taskId, new Date(targetStartMs).toISOString(), new Date(targetDueMs).toISOString()]
  );
  return true;
}

async function cascadeDownstreamTasksInTx(
  client: TxClient,
  tenantId: string,
  rootTaskId: string
): Promise<string[]> {
  const cascaded: string[] = [];
  const visited = new Set<string>([rootTaskId]);
  const queue: string[] = [rootTaskId];
  let guard = 0;

  while (queue.length > 0 && guard < 100) {
    guard++;
    const predId = queue.shift()!;
    const succRes = await client.query<{ task_id: string }>(
      'SELECT task_id FROM tenant_task_dependencies WHERE tenant_id = $1 AND predecessor_task_id = $2',
      [tenantId, predId]
    );
    for (const row of succRes.rows) {
      const succId = String(row.task_id);
      const shifted = await applyPredecessorConstraintsToTaskInTx(client, tenantId, succId);
      if (shifted && !cascaded.includes(succId)) {
        cascaded.push(succId);
      }
      if (!visited.has(succId)) {
        visited.add(succId);
        queue.push(succId);
      }
    }
  }
  return cascaded;
}

function normalizeRosterRow(row: Record<string, unknown>) {
  return {
    ...row,
    can_edit_tasks: Boolean(row.can_edit_tasks),
    can_manage_roster: Boolean(row.can_manage_roster),
    can_edit_whiteboard: Boolean(row.can_edit_whiteboard),
    allocation_pct: Number(row.allocation_pct ?? 100),
  };
}

// ============================================================================
// 1. Overview KPIs + Workspace Reference Lookups
// ============================================================================
router.get('/overview', requirePermission('projects', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const [projSummary, taskSummary, pomoSummary, ticketSummary, usersRes, pipelinesRes, stagesRes] =
        await Promise.all([
          client.query<{
            total_projects: string | number;
            active_projects: string | number;
            completed_projects: string | number;
          }>(
            `SELECT COUNT(*)::int AS total_projects,
                    COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_projects,
                    COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_projects
             FROM tenant_projects
             WHERE tenant_id = $1`,
            [ctx.tenantId]
          ),
          client.query<{
            total_tasks: string | number;
            done_tasks: string | number;
            in_progress_tasks: string | number;
            logged_minutes_total: string | number;
          }>(
            `SELECT COUNT(*)::int AS total_tasks,
                    COALESCE(SUM(CASE WHEN status_key = 'done' THEN 1 ELSE 0 END), 0) AS done_tasks,
                    COALESCE(SUM(CASE WHEN status_key = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress_tasks,
                    COALESCE(SUM(logged_minutes), 0) AS logged_minutes_total
             FROM tenant_tasks
             WHERE tenant_id = $1`,
            [ctx.tenantId]
          ),
          client.query<{ focus_sessions: string | number; focus_minutes: string | number }>(
            `SELECT COUNT(*)::int AS focus_sessions,
                    COALESCE(SUM(CASE WHEN mode = 'focus' THEN duration_minutes ELSE 0 END), 0) AS focus_minutes
             FROM tenant_pomodoro_sessions
             WHERE tenant_id = $1`,
            [ctx.tenantId]
          ),
          client.query<{
            total_tickets: string | number;
            open_tickets: string | number;
            breached_tickets: string | number;
          }>(
            `SELECT COUNT(*)::int AS total_tickets,
                    COALESCE(SUM(CASE WHEN status IN ('open', 'in_progress', 'waiting_customer') THEN 1 ELSE 0 END), 0) AS open_tickets,
                    COALESCE(SUM(CASE WHEN sla_breached = true OR (status NOT IN ('resolved', 'closed') AND resolution_due_at < clock_timestamp()) THEN 1 ELSE 0 END), 0) AS breached_tickets
             FROM tenant_helpdesk_tickets
             WHERE tenant_id = $1`,
            [ctx.tenantId]
          ),
          client.query(
            `SELECT id, full_name, email, role, department_id, branch_id
             FROM users
             WHERE tenant_id = $1 AND is_system_bot = false
             ORDER BY full_name ASC`,
            [ctx.tenantId]
          ),
          client.query('SELECT id, name, is_default FROM tenant_pipelines WHERE tenant_id = $1 ORDER BY is_default DESC', [
            ctx.tenantId,
          ]),
          client.query(
            `SELECT id, pipeline_id, stage_key, stage_name, color_hex
             FROM tenant_pipeline_stages
             WHERE tenant_id = $1
             ORDER BY stage_order ASC`,
            [ctx.tenantId]
          ),
        ]);

      return {
        summary: {
          total_projects: Number(projSummary.rows[0]?.total_projects || 0),
          active_projects: Number(projSummary.rows[0]?.active_projects || 0),
          completed_projects: Number(projSummary.rows[0]?.completed_projects || 0),
          total_tasks: Number(taskSummary.rows[0]?.total_tasks || 0),
          done_tasks: Number(taskSummary.rows[0]?.done_tasks || 0),
          in_progress_tasks: Number(taskSummary.rows[0]?.in_progress_tasks || 0),
          logged_minutes_total: Number(taskSummary.rows[0]?.logged_minutes_total || 0),
          focus_sessions: Number(pomoSummary.rows[0]?.focus_sessions || 0),
          focus_minutes: Number(pomoSummary.rows[0]?.focus_minutes || 0),
          total_tickets: Number(ticketSummary.rows[0]?.total_tickets || 0),
          open_tickets: Number(ticketSummary.rows[0]?.open_tickets || 0),
          breached_tickets: Number(ticketSummary.rows[0]?.breached_tickets || 0),
        },
        staff: usersRes.rows,
        pipelines: pipelinesRes.rows,
        stages: stagesRes.rows,
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'PROJECTS_OVERVIEW_FAILED', err?.message || 'Không thể tải tổng quan Dự án & Helpdesk.');
  }
});

// ============================================================================
// 2. Projects CRUD + Roster ACL + Kanban Columns + Whiteboard & Snapshots
// ============================================================================
router.get('/', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const limit = clampLimit(req.query.limit, 50, 200);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const scope = rbac.effectivePermissions.projects?.scope || 'company';
      const resolvedScope = await rsScopeOrCompany(client, ctx.tenantId, rbac.userOrg, scope, {
        tenantColumn: 'p.tenant_id',
        ownerColumn: 'p.owner_user_id',
        allowUnassignedForManagers: true,
      });

      let sql = `
        SELECT p.*,
               u.full_name AS owner_name,
               d.name AS department_name,
               (SELECT COUNT(*)::int FROM tenant_tasks t WHERE t.tenant_id = p.tenant_id AND t.project_id = p.id) AS task_count,
               (SELECT COUNT(*)::int FROM tenant_project_roster r WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id) AS roster_count,
               (SELECT COUNT(*)::int FROM tenant_task_whiteboard_snapshots ws WHERE ws.tenant_id = p.tenant_id AND ws.project_id = p.id) AS snapshot_count
        FROM tenant_projects p
        LEFT JOIN users u ON u.tenant_id = p.tenant_id AND u.id = p.owner_user_id
        LEFT JOIN tenant_departments d ON d.tenant_id = p.tenant_id AND d.id = p.department_id
        WHERE ${resolvedScope.clause}
      `;
      const params = [...resolvedScope.values];
      let pIdx = resolvedScope.nextIndex;

      if (statusFilter && statusFilter !== 'all') {
        sql += ` AND p.status = $${pIdx}`;
        params.push(statusFilter);
        pIdx++;
      }

      sql += ` ORDER BY p.created_at DESC LIMIT ${limit}`;
      const r = await client.query(sql, params);
      return r.rows.map((row) => ({
        ...row,
        budget_vnd: Number(row.budget_vnd || 0),
        progress_pct: Number(row.progress_pct || 0),
        task_count: Number(row.task_count || 0),
        roster_count: Number(row.roster_count || 0),
        snapshot_count: Number(row.snapshot_count || 0),
        task_columns: parseJsonSafe(row.task_columns_json, DEFAULT_KANBAN_COLUMNS),
        whiteboard_elements: parseJsonSafe(row.whiteboard_json, []),
      }));
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_PROJECTS_FAILED', err?.message || 'Không thể tải danh sách dự án.');
  }
});

async function rsScopeOrCompany(
  client: Parameters<typeof buildGranularScopeWhereClause>[0],
  tenantId: string,
  userOrg: Parameters<typeof buildGranularScopeWhereClause>[2] | null,
  scope: Parameters<typeof buildGranularScopeWhereClause>[3],
  opts: Parameters<typeof buildGranularScopeWhereClause>[4]
) {
  if (!userOrg) {
    return {
      clause: `${opts?.tenantColumn || 'tenant_id'} = $1`,
      values: [tenantId],
      nextIndex: 2,
    };
  }
  return buildGranularScopeWhereClause(client, tenantId, userOrg, scope, opts);
}

router.post('/', requirePermission('projects', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      sendApiError(res, 422, 'PROJECT_NAME_REQUIRED', 'Vui lòng nhập tên dự án.');
      return;
    }

    const code =
      String(body.code || '')
        .trim()
        .toUpperCase() || `PRJ-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const columns = Array.isArray(body.task_columns) && body.task_columns.length > 0
      ? body.task_columns
      : DEFAULT_KANBAN_COLUMNS;
    const whiteboard = Array.isArray(body.whiteboard_elements) ? body.whiteboard_elements : [];

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_projects (
           id, tenant_id, code, name, description, status, priority,
           owner_user_id, department_id, branch_id, start_date, due_date,
           budget_vnd, task_columns_json, whiteboard_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)`,
        [
          id,
          ctx.tenantId,
          code,
          name,
          body.description ? String(body.description) : null,
          body.status || 'active',
          body.priority || 'medium',
          body.owner_user_id || ctx.userId,
          body.department_id || null,
          body.branch_id || null,
          body.start_date || null,
          body.due_date || null,
          Math.max(0, Math.round(Number(body.budget_vnd || 0))),
          JSON.stringify(columns),
          JSON.stringify(whiteboard),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_projects WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      const row = r.rows[0];
      return {
        ...row,
        budget_vnd: Number(row.budget_vnd || 0),
        task_columns: parseJsonSafe(row.task_columns_json, DEFAULT_KANBAN_COLUMNS),
        whiteboard_elements: parseJsonSafe(row.whiteboard_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_PROJECT_FAILED', err?.message || 'Không thể khởi tạo dự án mới.');
  }
});

// ============================================================================
// 3. Tasks CRUD + Dependencies (Gantt Cascade) + Comments + Attachments
// ============================================================================
router.get('/tasks/list', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id.trim() : '';
    const leadId = typeof req.query.lead_id === 'string' ? req.query.lead_id.trim() : '';
    const statusKey = typeof req.query.status_key === 'string' ? req.query.status_key.trim() : '';
    const limit = clampLimit(req.query.limit, 100, 300);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { rbac, canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      const scope = rbac.effectivePermissions.projects?.scope || 'company';
      const resolvedScope = await rsScopeOrCompany(client, ctx.tenantId, rbac.userOrg, scope, {
        tenantColumn: 't.tenant_id',
        ownerColumn: 't.assignee_user_id',
        allowUnassignedForManagers: true,
      });

      let sql = `
        SELECT t.*,
               p.name AS project_name,
               u.full_name AS assignee_name,
               l.name AS lead_name,
               l.phone AS lead_phone,
               l.email AS lead_email,
               (SELECT COUNT(*)::int FROM tenant_task_comments tc WHERE tc.tenant_id = t.tenant_id AND tc.task_id = t.id) AS comments_count,
               (SELECT COUNT(*)::int FROM tenant_task_attachments ta WHERE ta.tenant_id = t.tenant_id AND ta.task_id = t.id) AS attachments_count
        FROM tenant_tasks t
        LEFT JOIN tenant_projects p ON p.tenant_id = t.tenant_id AND p.id = t.project_id
        LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_user_id
        LEFT JOIN leads l ON l.tenant_id = t.tenant_id AND l.id = t.lead_id
        WHERE ${resolvedScope.clause}
      `;
      const params = [...resolvedScope.values];
      let pIdx = resolvedScope.nextIndex;

      if (projectId && projectId !== 'all') {
        sql += ` AND t.project_id = $${pIdx}`;
        params.push(projectId);
        pIdx++;
      }
      if (leadId) {
        sql += ` AND t.lead_id = $${pIdx}`;
        params.push(leadId);
        pIdx++;
      }
      if (statusKey && statusKey !== 'all') {
        sql += ` AND t.status_key = $${pIdx}`;
        params.push(statusKey);
        pIdx++;
      }

      sql += ` ORDER BY t.sort_order ASC, t.created_at DESC LIMIT ${limit}`;
      const [r, depsRes] = await Promise.all([
        client.query(sql, params),
        client.query<{
          id: string;
          task_id: string;
          predecessor_task_id: string;
          dependency_type: string;
          lag_days: number;
          predecessor_title: string | null;
        }>(
          `SELECT d.id, d.task_id, d.predecessor_task_id, d.dependency_type, d.lag_days,
                  pt.title AS predecessor_title
           FROM tenant_task_dependencies d
           LEFT JOIN tenant_tasks pt ON pt.tenant_id = d.tenant_id AND pt.id = d.predecessor_task_id
           WHERE d.tenant_id = $1
           ORDER BY d.created_at ASC`,
          [ctx.tenantId]
        ),
      ]);

      const depsByTask = new Map<
        string,
        Array<{
          id: string;
          predecessor_task_id: string;
          predecessor_title: string | null;
          dependency_type: string;
          lag_days: number;
        }>
      >();
      for (const dep of depsRes.rows) {
        const key = String(dep.task_id);
        const list = depsByTask.get(key) || [];
        list.push({
          id: dep.id,
          predecessor_task_id: dep.predecessor_task_id,
          predecessor_title: dep.predecessor_title || null,
          dependency_type: dep.dependency_type || 'FS',
          lag_days: Number(dep.lag_days || 0),
        });
        depsByTask.set(key, list);
      }

      return r.rows.map((row) => {
        const maskedLead = row.lead_id
          ? maskContactPiiIfDisallowed(
              { phone: row.lead_phone, email: row.lead_email },
              canUnmaskLeads,
              tenantSettings
            )
          : { phone: null, email: null };
        const relationalDeps = depsByTask.get(String(row.id)) || [];
        const fallbackDeps = parseJsonSafe(row.dependencies_json, []);
        return {
          ...row,
          lead_phone: maskedLead.phone,
          lead_email: maskedLead.email,
          estimated_minutes: Number(row.estimated_minutes || 0),
          logged_minutes: Number(row.logged_minutes || 0),
          progress_pct: Number(row.progress_pct || 0),
          comments_count: Number(row.comments_count || 0),
          attachments_count: Number(row.attachments_count || 0),
          checklist: parseJsonSafe(row.checklist_json, []),
          dependencies: relationalDeps.length > 0 ? relationalDeps : fallbackDeps,
          dependency_links: relationalDeps,
        };
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TASKS_FAILED', err?.message || 'Không thể tải danh sách công việc.');
  }
});

router.post('/tasks', requirePermission('projects', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const title = String(body.title || '').trim();
    if (!title) {
      sendApiError(res, 422, 'TASK_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề công việc.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      const statusKey = String(body.status_key || 'todo');
      const startIso = body.start_date || new Date().toISOString();
      const dueIso = body.due_date || new Date(Date.now() + 3 * 86_400_000).toISOString();

      await client.query(
        `INSERT INTO tenant_tasks (
           id, tenant_id, project_id, lead_id, title, description, status_key, priority,
           assignee_user_id, reporter_user_id, start_date, due_date,
           estimated_minutes, progress_pct, sort_order, checklist_json, dependencies_json,
           completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18)`,
        [
          id,
          ctx.tenantId,
          body.project_id || null,
          body.lead_id || null,
          title,
          body.description ? String(body.description) : null,
          statusKey,
          body.priority || 'medium',
          body.assignee_user_id || ctx.userId,
          ctx.userId,
          startIso,
          dueIso,
          Math.max(5, Math.round(Number(body.estimated_minutes || 60))),
          statusKey === 'done' ? 100 : Math.min(100, Math.max(0, Math.round(Number(body.progress_pct || 0)))),
          Math.round(Number(body.sort_order || 0)),
          JSON.stringify(Array.isArray(body.checklist) ? body.checklist : []),
          JSON.stringify(Array.isArray(body.dependencies) ? body.dependencies : []),
          statusKey === 'done' ? new Date().toISOString() : null,
        ]
      );

      await recomputeProjectProgressInTx(client, ctx.tenantId, body.project_id);
      const r = await client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
      const row = r.rows[0];
      return {
        ...row,
        checklist: parseJsonSafe(row.checklist_json, []),
        dependencies: parseJsonSafe(row.dependencies_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TASK_FAILED', err?.message || 'Không thể tạo công việc mới.');
  }
});

router.get('/tasks/:taskId/dependencies', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.taskId;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const taskCheck = await client.query<{ id: string }>(
        'SELECT id FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, taskId]
      );
      if (!taskCheck.rows[0]) return null;

      const [predRes, succRes] = await Promise.all([
        client.query(
          `SELECT d.*,
                  pt.title AS predecessor_title,
                  pt.status_key AS predecessor_status_key,
                  pt.start_date AS predecessor_start_date,
                  pt.due_date AS predecessor_due_date
           FROM tenant_task_dependencies d
           LEFT JOIN tenant_tasks pt ON pt.tenant_id = d.tenant_id AND pt.id = d.predecessor_task_id
           WHERE d.tenant_id = $1 AND d.task_id = $2
           ORDER BY d.created_at ASC`,
          [ctx.tenantId, taskId]
        ),
        client.query(
          `SELECT d.*,
                  st.title AS successor_title,
                  st.status_key AS successor_status_key,
                  st.start_date AS successor_start_date,
                  st.due_date AS successor_due_date
           FROM tenant_task_dependencies d
           LEFT JOIN tenant_tasks st ON st.tenant_id = d.tenant_id AND st.id = d.task_id
           WHERE d.tenant_id = $1 AND d.predecessor_task_id = $2
           ORDER BY d.created_at ASC`,
          [ctx.tenantId, taskId]
        ),
      ]);

      const predecessors = predRes.rows.map((r) => ({ ...r, lag_days: Number(r.lag_days || 0) }));
      const successors = succRes.rows.map((r) => ({ ...r, lag_days: Number(r.lag_days || 0) }));

      return {
        task_id: taskId,
        items: predecessors,
        predecessors,
        successors,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_TASK_DEPENDENCIES_FAILED', err?.message || 'Không thể tải phụ thuộc công việc.');
  }
});

router.put('/tasks/:taskId/dependencies', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.taskId;
    const body = req.body || {};

    const rawList: Array<Record<string, unknown>> = Array.isArray(body.dependencies)
      ? body.dependencies
      : Array.isArray(body.predecessors)
        ? body.predecessors
        : body.predecessor_task_id
          ? [
              {
                predecessor_task_id: body.predecessor_task_id,
                dependency_type: body.dependency_type,
                lag_days: body.lag_days,
              },
            ]
          : [];

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const taskRes = await client.query<{ id: string; project_id: string | null }>(
        'SELECT id, project_id FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, taskId]
      );
      if (!taskRes.rows[0]) return { status: 'not_found' as const };
      const projectId = taskRes.rows[0].project_id || null;

      const normalizedDeps: Array<{
        predecessor_task_id: string;
        dependency_type: string;
        lag_days: number;
      }> = [];
      const seenPreds = new Set<string>();

      for (const entry of rawList) {
        const predId = String(entry?.predecessor_task_id || entry?.predecessor_id || '').trim();
        if (!predId) continue;
        if (predId === taskId) {
          return { status: 'self_dep' as const };
        }
        if (seenPreds.has(predId)) continue;
        seenPreds.add(predId);

        const predExists = await client.query<{ id: string }>(
          'SELECT id FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, predId]
        );
        if (!predExists.rows[0]) {
          return { status: 'pred_not_found' as const, predId };
        }

        const createsCycle = await hasDependencyPathInTx(client, ctx.tenantId, predId, taskId);
        if (createsCycle) {
          return { status: 'cycle' as const };
        }

        const rawType = String(entry?.dependency_type || 'FS').trim().toUpperCase();
        const depType = VALID_DEPENDENCY_TYPES.has(rawType) ? rawType : 'FS';
        const lagDays = Math.max(-365, Math.min(365, Math.round(Number(entry?.lag_days || 0))));

        normalizedDeps.push({
          predecessor_task_id: predId,
          dependency_type: depType,
          lag_days: lagDays,
        });
      }

      await client.query('DELETE FROM tenant_task_dependencies WHERE tenant_id = $1 AND task_id = $2', [
        ctx.tenantId,
        taskId,
      ]);

      for (const dep of normalizedDeps) {
        const depId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_task_dependencies (
             id, tenant_id, project_id, task_id, predecessor_task_id,
             dependency_type, lag_days, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            depId,
            ctx.tenantId,
            projectId,
            taskId,
            dep.predecessor_task_id,
            dep.dependency_type,
            dep.lag_days,
            ctx.userId,
          ]
        );
      }

      await client.query(
        `UPDATE tenant_tasks
         SET dependencies_json = $3::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, taskId, JSON.stringify(normalizedDeps)]
      );

      let cascadedIds: string[] = [];
      if (body.cascade !== false && normalizedDeps.length > 0) {
        const selfShifted = await applyPredecessorConstraintsToTaskInTx(client, ctx.tenantId, taskId);
        const downstream = await cascadeDownstreamTasksInTx(client, ctx.tenantId, taskId);
        cascadedIds = selfShifted ? [taskId, ...downstream] : downstream;
      }

      const [savedDepsRes, updatedTaskRes] = await Promise.all([
        client.query(
          `SELECT d.*, pt.title AS predecessor_title
           FROM tenant_task_dependencies d
           LEFT JOIN tenant_tasks pt ON pt.tenant_id = d.tenant_id AND pt.id = d.predecessor_task_id
           WHERE d.tenant_id = $1 AND d.task_id = $2
           ORDER BY d.created_at ASC`,
          [ctx.tenantId, taskId]
        ),
        client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          taskId,
        ]),
      ]);

      const updatedTask = updatedTaskRes.rows[0];
      return {
        status: 'ok' as const,
        data: {
          task_id: taskId,
          items: savedDepsRes.rows.map((r) => ({ ...r, lag_days: Number(r.lag_days || 0) })),
          cascaded_task_ids: cascadedIds,
          updated_task: {
            ...updatedTask,
            checklist: parseJsonSafe(updatedTask.checklist_json, []),
            dependencies: parseJsonSafe(updatedTask.dependencies_json, []),
          },
        },
      };
    });

    if (outcome.status === 'not_found') {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
      return;
    }
    if (outcome.status === 'self_dep') {
      sendApiError(res, 422, 'SELF_DEPENDENCY_INVALID', 'Công việc không thể phụ thuộc vào chính nó.');
      return;
    }
    if (outcome.status === 'pred_not_found') {
      sendApiError(res, 404, 'PREDECESSOR_TASK_NOT_FOUND', 'Không tìm thấy công việc tiền nhiệm.');
      return;
    }
    if (outcome.status === 'cycle') {
      sendApiError(
        res,
        422,
        'CIRCULAR_DEPENDENCY_DETECTED',
        'Phát hiện vòng lặp phụ thuộc (Circular Dependency) giữa các công việc.'
      );
      return;
    }

    res.json({ success: true, data: outcome.data });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_TASK_DEPENDENCIES_FAILED', err?.message || 'Không thể lưu phụ thuộc Gantt.');
  }
});

router.get('/tasks/:taskId/comments', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.taskId;
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_task_comments
         WHERE tenant_id = $1 AND task_id = $2
         ORDER BY created_at ASC`,
        [ctx.tenantId, taskId]
      );
      return r.rows.map((row) => ({
        ...row,
        mentions: parseJsonSafe<string[]>(row.mentions_json, []),
        attachments: parseJsonSafe<unknown[]>(row.attachments_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TASK_COMMENTS_FAILED', err?.message || 'Không thể tải bình luận công việc.');
  }
});

router.post('/tasks/:taskId/comments', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.taskId;
    const body = req.body || {};
    const content = String(body.content || '').trim();
    if (!content) {
      sendApiError(res, 422, 'COMMENT_REQUIRED', 'Vui lòng nhập nội dung thảo luận.');
      return;
    }

    const extractedMentions = Array.isArray(body.mentions)
      ? body.mentions.map((m: unknown) => String(m)).filter(Boolean)
      : Array.from(content.matchAll(/@([a-zA-Z0-9._\u00C0-\u1EF9-]+)/g)).map((m) => m[1]);
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tk = await client.query<{ id: string }>(
        'SELECT id FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, taskId]
      );
      if (!tk.rows[0]) return null;

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_task_comments (
           id, tenant_id, task_id, author_user_id, author_name,
           content, mentions_json, attachments_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
        [
          id,
          ctx.tenantId,
          taskId,
          ctx.userId,
          ctx.userName || 'Thành viên',
          content,
          JSON.stringify(extractedMentions),
          JSON.stringify(attachments),
        ]
      );

      const r = await client.query('SELECT * FROM tenant_task_comments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      const row = r.rows[0];
      return {
        ...row,
        mentions: parseJsonSafe<string[]>(row.mentions_json, []),
        attachments: parseJsonSafe<unknown[]>(row.attachments_json, []),
      };
    });

    if (!created) {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TASK_COMMENT_FAILED', err?.message || 'Không thể gửi bình luận công việc.');
  }
});

router.delete(
  '/tasks/:taskId/comments/:commentId',
  requirePermission('projects', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const { taskId, commentId } = req.params;
      const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          'DELETE FROM tenant_task_comments WHERE tenant_id = $1 AND task_id = $2 AND id = $3',
          [ctx.tenantId, taskId, commentId]
        );
        return r.rowCount > 0;
      });
      if (!deleted) {
        sendApiError(res, 404, 'COMMENT_NOT_FOUND', 'Không tìm thấy bình luận.');
        return;
      }
      res.json({ success: true, data: { id: commentId, task_id: taskId, deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'DELETE_TASK_COMMENT_FAILED', err?.message || 'Không thể xóa bình luận.');
    }
  }
);

router.get('/tasks/:taskId/attachments', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.taskId;
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_task_attachments
         WHERE tenant_id = $1 AND task_id = $2
         ORDER BY created_at DESC`,
        [ctx.tenantId, taskId]
      );
      return r.rows.map((row) => ({
        ...row,
        size_bytes: Number(row.size_bytes || 0),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TASK_ATTACHMENTS_FAILED', err?.message || 'Không thể tải tệp đính kèm.');
  }
});

router.post('/tasks/:taskId/attachments', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.taskId;
    const body = req.body || {};
    const fileName = String(body.file_name || body.name || '').trim();
    if (!fileName) {
      sendApiError(res, 422, 'ATTACHMENT_NAME_REQUIRED', 'Vui lòng nhập tên tệp đính kèm.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tk = await client.query<{ id: string }>(
        'SELECT id FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, taskId]
      );
      if (!tk.rows[0]) return null;

      const id = crypto.randomUUID();
      const safeSlug = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
      const fileUrl =
        String(body.file_url || body.url || '').trim() ||
        `/storage/tenants/${ctx.tenantId}/tasks/${taskId}/${id.slice(0, 8)}_${safeSlug}`;
      const mimeType = String(body.mime_type || 'application/octet-stream').trim().slice(0, 120);
      const sizeBytes = Math.max(0, Math.round(Number(body.size_bytes || 0)));

      await client.query(
        `INSERT INTO tenant_task_attachments (
           id, tenant_id, task_id, file_name, file_url, mime_type,
           size_bytes, uploaded_by, uploaded_by_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          ctx.tenantId,
          taskId,
          fileName,
          fileUrl,
          mimeType,
          sizeBytes,
          ctx.userId,
          ctx.userName || 'Thành viên',
        ]
      );

      const r = await client.query('SELECT * FROM tenant_task_attachments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        size_bytes: Number(r.rows[0].size_bytes || 0),
      };
    });

    if (!created) {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TASK_ATTACHMENT_FAILED', err?.message || 'Không thể đính kèm tệp.');
  }
});

router.delete(
  '/tasks/:taskId/attachments/:attId',
  requirePermission('projects', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const { taskId, attId } = req.params;
      const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
        const r = await client.query(
          'DELETE FROM tenant_task_attachments WHERE tenant_id = $1 AND task_id = $2 AND id = $3',
          [ctx.tenantId, taskId, attId]
        );
        return r.rowCount > 0;
      });
      if (!deleted) {
        sendApiError(res, 404, 'ATTACHMENT_NOT_FOUND', 'Không tìm thấy tệp đính kèm.');
        return;
      }
      res.json({ success: true, data: { id: attId, task_id: taskId, deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'DELETE_TASK_ATTACHMENT_FAILED', err?.message || 'Không thể xóa tệp đính kèm.');
    }
  }
);

router.patch('/tasks/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        taskId,
      ]);
      if (!existing.rows[0]) return null;
      const cur = existing.rows[0];

      const nextStatus = body.status_key !== undefined ? String(body.status_key) : cur.status_key;
      const nextPct =
        nextStatus === 'done'
          ? 100
          : body.progress_pct !== undefined
            ? Math.min(100, Math.max(0, Math.round(Number(body.progress_pct))))
            : Number(cur.progress_pct || 0);
      const nextCompletedAt =
        nextStatus === 'done' ? cur.completed_at || new Date().toISOString() : null;

      const datesChanged = body.start_date !== undefined || body.due_date !== undefined;

      await client.query(
        `UPDATE tenant_tasks
         SET title = $3,
             description = $4,
             status_key = $5,
             priority = $6,
             assignee_user_id = $7,
             start_date = $8,
             due_date = $9,
             estimated_minutes = $10,
             progress_pct = $11,
             sort_order = $12,
             checklist_json = $13::jsonb,
             dependencies_json = $14::jsonb,
             completed_at = $15,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          taskId,
          body.title !== undefined ? String(body.title).trim() : cur.title,
          body.description !== undefined ? body.description : cur.description,
          nextStatus,
          body.priority || cur.priority,
          body.assignee_user_id !== undefined ? body.assignee_user_id || null : cur.assignee_user_id,
          body.start_date !== undefined ? body.start_date || null : cur.start_date,
          body.due_date !== undefined ? body.due_date || null : cur.due_date,
          body.estimated_minutes !== undefined
            ? Math.max(5, Math.round(Number(body.estimated_minutes)))
            : Number(cur.estimated_minutes || 60),
          nextPct,
          body.sort_order !== undefined ? Math.round(Number(body.sort_order)) : Number(cur.sort_order || 0),
          JSON.stringify(
            Array.isArray(body.checklist) ? body.checklist : parseJsonSafe(cur.checklist_json, [])
          ),
          JSON.stringify(
            Array.isArray(body.dependencies) ? body.dependencies : parseJsonSafe(cur.dependencies_json, [])
          ),
          nextCompletedAt,
        ]
      );

      let cascadedTaskIds: string[] = [];
      if (datesChanged && body.cascade_dependencies !== false) {
        cascadedTaskIds = await cascadeDownstreamTasksInTx(client, ctx.tenantId, taskId);
      }

      await recomputeProjectProgressInTx(client, ctx.tenantId, cur.project_id);
      const r = await client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, taskId]);
      const row = r.rows[0];
      return {
        ...row,
        checklist: parseJsonSafe(row.checklist_json, []),
        dependencies: parseJsonSafe(row.dependencies_json, []),
        cascaded_task_ids: cascadedTaskIds,
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_TASK_FAILED', err?.message || 'Không thể cập nhật công việc.');
  }
});

router.delete('/tasks/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const taskId = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const cur = await client.query<{ project_id: string | null }>(
        'SELECT project_id FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, taskId]
      );
      if (!cur.rows[0]) return false;
      await client.query('DELETE FROM tenant_tasks WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, taskId]);
      await recomputeProjectProgressInTx(client, ctx.tenantId, cur.rows[0].project_id);
      return true;
    });
    if (!deleted) {
      sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
      return;
    }
    res.json({ success: true, data: { id: taskId, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_TASK_FAILED', err?.message || 'Không thể xóa công việc.');
  }
});

// ============================================================================
// 4. Focus Pomodoro Timer Logging
// ============================================================================
router.get('/pomodoro/sessions', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const limit = clampLimit(req.query.limit, 30, 100);
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT s.*, t.title AS task_title, u.full_name AS user_name
         FROM tenant_pomodoro_sessions s
         LEFT JOIN tenant_tasks t ON t.tenant_id = s.tenant_id AND t.id = s.task_id
         LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
         WHERE s.tenant_id = $1
         ORDER BY s.created_at DESC
         LIMIT ${limit}`,
        [ctx.tenantId]
      );
      return r.rows;
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_POMODORO_FAILED', err?.message || 'Không thể tải lịch sử Pomodoro.');
  }
});

router.post('/pomodoro/sessions', requirePermission('projects', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const durationMinutes = Math.max(1, Math.min(240, Math.round(Number(body.duration_minutes || 25))));
    const mode = ['focus', 'short_break', 'long_break'].includes(String(body.mode))
      ? String(body.mode)
      : 'focus';
    const taskId = body.task_id ? String(body.task_id) : null;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_pomodoro_sessions (
           id, tenant_id, task_id, user_id, duration_minutes, mode, note
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          ctx.tenantId,
          taskId,
          ctx.userId,
          durationMinutes,
          mode,
          body.note ? String(body.note) : null,
        ]
      );

      let updatedTaskMinutes: number | null = null;
      if (taskId && mode === 'focus') {
        await client.query(
          `UPDATE tenant_tasks
           SET logged_minutes = logged_minutes + $3,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, taskId, durationMinutes]
        );
        const tr = await client.query<{ logged_minutes: number }>(
          'SELECT logged_minutes FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, taskId]
        );
        updatedTaskMinutes = Number(tr.rows[0]?.logged_minutes || 0);
      }

      const r = await client.query('SELECT * FROM tenant_pomodoro_sessions WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        updated_task_logged_minutes: updatedTaskMinutes,
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'LOG_POMODORO_FAILED', err?.message || 'Không thể ghi nhận phiên Pomodoro.');
  }
});

// ============================================================================
// 5. Stage -> Task Automation Templates (`WorkflowTaskTemplates`)
// ============================================================================
router.get('/workflow-templates/list', requirePermission('projects', 'view'), async (_req, res) => {
  try {
    const ctx = getTenantContext();
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT wt.*,
                p.name AS pipeline_name,
                s.stage_name,
                pr.name AS project_name,
                u.full_name AS assignee_name
         FROM tenant_workflow_task_templates wt
         LEFT JOIN tenant_pipelines p ON p.tenant_id = wt.tenant_id AND p.id = wt.pipeline_id
         LEFT JOIN tenant_pipeline_stages s ON s.tenant_id = wt.tenant_id AND s.id = wt.stage_id
         LEFT JOIN tenant_projects pr ON pr.tenant_id = wt.tenant_id AND pr.id = wt.project_id
         LEFT JOIN users u ON u.tenant_id = wt.tenant_id AND u.id = wt.default_assignee_id
         WHERE wt.tenant_id = $1
         ORDER BY wt.sort_order ASC, wt.created_at DESC`,
        [ctx.tenantId]
      );
      return r.rows.map((row) => ({
        ...row,
        checklist: parseJsonSafe(row.checklist_json, []),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_WORKFLOW_TEMPLATES_FAILED', err?.message || 'Không thể tải mẫu tự động sinh việc.');
  }
});

router.post('/workflow-templates', requirePermission('projects', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const titleTemplate = String(body.title_template || '').trim();
    if (!titleTemplate) {
      sendApiError(res, 422, 'TEMPLATE_TITLE_REQUIRED', 'Vui lòng nhập tiêu đề công việc mẫu.');
      return;
    }
    if (!body.stage_id && !body.stage_key) {
      sendApiError(res, 422, 'STAGE_TARGET_REQUIRED', 'Vui lòng chọn bước Pipeline kích hoạt tự động.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_workflow_task_templates (
           id, tenant_id, pipeline_id, stage_id, stage_key, project_id,
           title_template, description_template, priority, due_offset_hours,
           default_assignee_id, checklist_json, sort_order, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
        [
          id,
          ctx.tenantId,
          body.pipeline_id || null,
          body.stage_id || null,
          body.stage_key ? String(body.stage_key).trim() : null,
          body.project_id || null,
          titleTemplate,
          body.description_template ? String(body.description_template) : null,
          body.priority || 'medium',
          Math.max(1, Math.round(Number(body.due_offset_hours || 24))),
          body.default_assignee_id || null,
          JSON.stringify(Array.isArray(body.checklist) ? body.checklist : []),
          Math.round(Number(body.sort_order || 0)),
          body.is_active !== false,
        ]
      );
      const r = await client.query(
        'SELECT * FROM tenant_workflow_task_templates WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      return {
        ...r.rows[0],
        checklist: parseJsonSafe(r.rows[0].checklist_json, []),
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_WORKFLOW_TEMPLATE_FAILED', err?.message || 'Không thể lưu mẫu tự động hóa.');
  }
});

router.delete('/workflow-templates/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const id = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'DELETE FROM tenant_workflow_task_templates WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      return r.rowCount > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'WORKFLOW_TEMPLATE_NOT_FOUND', 'Không tìm thấy mẫu tự động hóa.');
      return;
    }
    res.json({ success: true, data: { id, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_WORKFLOW_TEMPLATE_FAILED', err?.message || 'Không thể xóa mẫu tự động hóa.');
  }
});

// ============================================================================
// 6. Helpdesk Customer SLA (`TicketsPage` — Distinct from AutoData Data-Compensation Tickets)
// ============================================================================
function decorateTicketSla(row: Record<string, any>) {
  const nowMs = Date.now();
  const resDueMs = row.resolution_due_at ? new Date(row.resolution_due_at).getTime() : nowMs;
  const respDueMs = row.response_due_at ? new Date(row.response_due_at).getTime() : nowMs;
  const isClosed = row.status === 'resolved' || row.status === 'closed';
  const resolutionBreached = !isClosed && resDueMs < nowMs;
  const responseBreached = !row.first_responded_at && !isClosed && respDueMs < nowMs;
  const effectiveBreached = Boolean(row.sla_breached || resolutionBreached || responseBreached);
  const remainingMinutes = isClosed ? 0 : Math.round((resDueMs - nowMs) / 60_000);

  return {
    ...row,
    sla_response_hours: Number(row.sla_response_hours || 2),
    sla_resolution_hours: Number(row.sla_resolution_hours || 24),
    sla_breached: effectiveBreached,
    response_breached: responseBreached,
    resolution_remaining_minutes: remainingMinutes,
    attachments: parseJsonSafe(row.attachments_json, []),
  };
}

router.get('/tickets/list', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const priority = typeof req.query.priority === 'string' ? req.query.priority.trim() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const limit = clampLimit(req.query.limit, 60, 200);

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { canUnmaskLeads, tenantSettings } = await resolveActorContext(client, ctx.tenantId, ctx.userId);
      let sql = `
        SELECT tk.*,
               u.full_name AS assignee_name,
               l.name AS lead_name,
               l.phone AS lead_phone,
               l.email AS lead_email
        FROM tenant_helpdesk_tickets tk
        LEFT JOIN users u ON u.tenant_id = tk.tenant_id AND u.id = tk.assignee_user_id
        LEFT JOIN leads l ON l.tenant_id = tk.tenant_id AND l.id = tk.lead_id
        WHERE tk.tenant_id = $1
      `;
      const params: unknown[] = [ctx.tenantId];
      let pIdx = 2;

      if (status && status !== 'all') {
        sql += ` AND tk.status = $${pIdx}`;
        params.push(status);
        pIdx++;
      }
      if (priority && priority !== 'all') {
        sql += ` AND tk.priority = $${pIdx}`;
        params.push(priority);
        pIdx++;
      }
      if (search) {
        sql += ` AND (LOWER(tk.subject) LIKE LOWER($${pIdx}) OR LOWER(tk.ticket_code) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(tk.customer_name, '')) LIKE LOWER($${pIdx}))`;
        params.push(`%${search}%`);
        pIdx++;
      }

      sql += ` ORDER BY tk.created_at DESC LIMIT ${limit}`;
      const r = await client.query(sql, params);
      return r.rows.map((row) => {
        const masked = maskContactPiiIfDisallowed(
          { phone: row.lead_phone || row.customer_contact, email: row.lead_email },
          canUnmaskLeads,
          tenantSettings
        );
        return decorateTicketSla({
          ...row,
          lead_phone: masked.phone,
          lead_email: masked.email,
          customer_contact: canUnmaskLeads ? row.customer_contact : masked.phone || row.customer_contact,
        });
      });
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_HELPDESK_TICKETS_FAILED', err?.message || 'Không thể tải danh sách Ticket CSKH.');
  }
});

router.post('/tickets', requirePermission('projects', 'create'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const body = req.body || {};
    const subject = String(body.subject || '').trim();
    if (!subject) {
      sendApiError(res, 422, 'TICKET_SUBJECT_REQUIRED', 'Vui lòng nhập tiêu đề yêu cầu hỗ trợ.');
      return;
    }

    const priority = ['low', 'medium', 'high', 'urgent'].includes(String(body.priority))
      ? String(body.priority)
      : 'medium';
    const defaultRespHours = priority === 'urgent' ? 0.5 : priority === 'high' ? 2 : priority === 'medium' ? 4 : 8;
    const defaultResHours = priority === 'urgent' ? 4 : priority === 'high' ? 12 : priority === 'medium' ? 24 : 48;

    const slaResponseHours =
      body.sla_response_hours !== undefined ? Math.max(0.1, Number(body.sla_response_hours)) : defaultRespHours;
    const slaResolutionHours =
      body.sla_resolution_hours !== undefined ? Math.max(0.25, Number(body.sla_resolution_hours)) : defaultResHours;

    const nowMs = Date.now();
    const responseDueAt = body.response_due_at || new Date(nowMs + slaResponseHours * 3_600_000).toISOString();
    const resolutionDueAt = body.resolution_due_at || new Date(nowMs + slaResolutionHours * 3_600_000).toISOString();
    const slaBreached = new Date(resolutionDueAt).getTime() < nowMs || new Date(responseDueAt).getTime() < nowMs;

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const id = crypto.randomUUID();
      const ticketCode = `CSKH-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      let resolvedCustomerName = body.customer_name ? String(body.customer_name).trim() : null;
      let resolvedCustomerContact = body.customer_contact ? String(body.customer_contact).trim() : null;

      if (body.lead_id) {
        const lRes = await client.query<{ name: string; phone: string | null; email: string | null }>(
          'SELECT name, phone, email FROM leads WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, body.lead_id]
        );
        if (lRes.rows[0]) {
          resolvedCustomerName = resolvedCustomerName || lRes.rows[0].name;
          resolvedCustomerContact = resolvedCustomerContact || lRes.rows[0].phone || lRes.rows[0].email;
        }
      }

      await client.query(
        `INSERT INTO tenant_helpdesk_tickets (
           id, tenant_id, ticket_code, subject, description, category, priority, status,
           lead_id, customer_name, customer_contact, assignee_user_id, created_by_user_id,
           sla_response_hours, sla_resolution_hours, response_due_at, resolution_due_at,
           sla_breached, attachments_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)`,
        [
          id,
          ctx.tenantId,
          ticketCode,
          subject,
          body.description ? String(body.description) : null,
          body.category || 'customer_support',
          priority,
          body.lead_id || null,
          resolvedCustomerName,
          resolvedCustomerContact,
          body.assignee_user_id || ctx.userId,
          ctx.userId,
          slaResponseHours,
          slaResolutionHours,
          responseDueAt,
          resolutionDueAt,
          slaBreached,
          JSON.stringify(Array.isArray(body.attachments) ? body.attachments : []),
        ]
      );

      const r = await client.query('SELECT * FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return decorateTicketSla(r.rows[0]);
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_HELPDESK_TICKET_FAILED', err?.message || 'Không thể tạo Ticket CSKH.');
  }
});

router.patch('/tickets/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const ticketId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query(
        'SELECT * FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, ticketId]
      );
      if (!existing.rows[0]) return null;
      const cur = existing.rows[0];

      const nextStatus = body.status || cur.status;
      const nowIso = new Date().toISOString();
      const firstRespondedAt =
        cur.first_responded_at || (nextStatus !== 'open' ? nowIso : null);
      const resolvedAt =
        nextStatus === 'resolved' || nextStatus === 'closed' ? cur.resolved_at || nowIso : null;
      const wasResolutionLate =
        resolvedAt ? new Date(resolvedAt).getTime() > new Date(cur.resolution_due_at).getTime() : false;
      const nextBreached = Boolean(cur.sla_breached || wasResolutionLate);

      await client.query(
        `UPDATE tenant_helpdesk_tickets
         SET status = $3,
             priority = $4,
             assignee_user_id = $5,
             first_responded_at = $6,
             resolved_at = $7,
             sla_breached = $8,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          ticketId,
          nextStatus,
          body.priority || cur.priority,
          body.assignee_user_id !== undefined ? body.assignee_user_id || null : cur.assignee_user_id,
          firstRespondedAt,
          resolvedAt,
          nextBreached,
        ]
      );

      const r = await client.query('SELECT * FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        ticketId,
      ]);
      return decorateTicketSla(r.rows[0]);
    });

    if (!updated) {
      sendApiError(res, 404, 'TICKET_NOT_FOUND', 'Không tìm thấy Ticket CSKH.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_HELPDESK_TICKET_FAILED', err?.message || 'Không thể cập nhật Ticket CSKH.');
  }
});

router.get('/tickets/:id/comments', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const ticketId = req.params.id;
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_helpdesk_comments
         WHERE tenant_id = $1 AND ticket_id = $2
         ORDER BY created_at ASC`,
        [ctx.tenantId, ticketId]
      );
      return r.rows.map((row) => ({
        ...row,
        is_internal_note: Boolean(row.is_internal_note),
      }));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_TICKET_COMMENTS_FAILED', err?.message || 'Không thể tải phản hồi Ticket.');
  }
});

router.post('/tickets/:id/comments', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const ticketId = req.params.id;
    const content = String(req.body?.content || '').trim();
    if (!content) {
      sendApiError(res, 422, 'COMMENT_REQUIRED', 'Vui lòng nhập nội dung phản hồi.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tk = await client.query<{ id: string; first_responded_at: string | null }>(
        'SELECT id, first_responded_at FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, ticketId]
      );
      if (!tk.rows[0]) return null;

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_helpdesk_comments (
           id, tenant_id, ticket_id, author_user_id, author_name, content, is_internal_note
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          ctx.tenantId,
          ticketId,
          ctx.userId,
          ctx.userName || 'Chuyên viên CSKH',
          content,
          Boolean(req.body?.is_internal_note),
        ]
      );

      if (!tk.rows[0].first_responded_at && !req.body?.is_internal_note) {
        await client.query(
          `UPDATE tenant_helpdesk_tickets
           SET first_responded_at = clock_timestamp(),
               status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, ticketId]
        );
      }

      const r = await client.query('SELECT * FROM tenant_helpdesk_comments WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        id,
      ]);
      return {
        ...r.rows[0],
        is_internal_note: Boolean(r.rows[0].is_internal_note),
      };
    });

    if (!created) {
      sendApiError(res, 404, 'TICKET_NOT_FOUND', 'Không tìm thấy Ticket CSKH.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_TICKET_COMMENT_FAILED', err?.message || 'Không thể gửi phản hồi Ticket.');
  }
});

// ============================================================================
// 7. Project Member Roster ACL & Whiteboard Snapshots + Project Param Routes
// ============================================================================
router.get('/:id/roster', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT r.*,
                u.email AS user_email,
                u.role AS system_role,
                d.name AS department_name
         FROM tenant_project_roster r
         LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
         LEFT JOIN tenant_departments d ON d.tenant_id = u.tenant_id AND d.id = u.department_id
         WHERE r.tenant_id = $1 AND r.project_id = $2
         ORDER BY r.created_at ASC`,
        [ctx.tenantId, projectId]
      );
      return r.rows.map((row) => normalizeRosterRow(row as Record<string, unknown>));
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_PROJECT_ROSTER_FAILED', err?.message || 'Không thể tải danh sách thành viên dự án.');
  }
});

router.post('/:id/roster', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const body = req.body || {};
    const userId = String(body.user_id || '').trim();
    if (!userId) {
      sendApiError(res, 422, 'USER_ID_REQUIRED', 'Vui lòng chọn thành viên cần phân quyền vào dự án.');
      return;
    }

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const projCheck = await client.query<{ id: string }>(
        'SELECT id FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, projectId]
      );
      if (!projCheck.rows[0]) return { status: 'project_not_found' as const };

      let resolvedUserName = String(body.user_name || '').trim();
      if (!resolvedUserName) {
        const uRes = await client.query<{ full_name: string; email: string }>(
          'SELECT full_name, email FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, userId]
        );
        resolvedUserName = String(uRes.rows[0]?.full_name || uRes.rows[0]?.email || 'Thành viên');
      }

      const rawRole = String(body.role_in_project || 'member').trim().toLowerCase();
      const roleInProject = VALID_PROJECT_ROLES.has(rawRole) ? rawRole : 'member';
      const canEditTasks = body.can_edit_tasks !== undefined ? Boolean(body.can_edit_tasks) : true;
      const canManageRoster =
        body.can_manage_roster !== undefined
          ? Boolean(body.can_manage_roster)
          : roleInProject === 'owner' || roleInProject === 'manager';
      const canEditWhiteboard =
        body.can_edit_whiteboard !== undefined ? Boolean(body.can_edit_whiteboard) : true;
      const allocationPct = Math.max(0, Math.min(200, Math.round(Number(body.allocation_pct ?? 100))));

      const existingRes = await client.query<{ id: string }>(
        'SELECT id FROM tenant_project_roster WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3 LIMIT 1',
        [ctx.tenantId, projectId, userId]
      );

      let rosterId: string;
      if (existingRes.rows[0]) {
        rosterId = existingRes.rows[0].id;
        await client.query(
          `UPDATE tenant_project_roster
           SET user_name = $3,
               role_in_project = $4,
               can_edit_tasks = $5,
               can_manage_roster = $6,
               can_edit_whiteboard = $7,
               allocation_pct = $8,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            rosterId,
            resolvedUserName,
            roleInProject,
            canEditTasks,
            canManageRoster,
            canEditWhiteboard,
            allocationPct,
          ]
        );
      } else {
        rosterId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_project_roster (
             id, tenant_id, project_id, user_id, user_name,
             role_in_project, can_edit_tasks, can_manage_roster,
             can_edit_whiteboard, allocation_pct, added_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            rosterId,
            ctx.tenantId,
            projectId,
            userId,
            resolvedUserName,
            roleInProject,
            canEditTasks,
            canManageRoster,
            canEditWhiteboard,
            allocationPct,
            ctx.userId,
          ]
        );
      }

      const r = await client.query('SELECT * FROM tenant_project_roster WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        rosterId,
      ]);
      return {
        status: 'ok' as const,
        member: normalizeRosterRow(r.rows[0] as Record<string, unknown>),
      };
    });

    if (saved.status === 'project_not_found') {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    res.status(201).json({ success: true, data: saved.member });
  } catch (err: any) {
    sendApiError(res, 500, 'UPSERT_PROJECT_ROSTER_FAILED', err?.message || 'Không thể lưu phân quyền thành viên dự án.');
  }
});

router.delete('/:id/roster/:rosterId', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { id: projectId, rosterId } = req.params;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        'DELETE FROM tenant_project_roster WHERE tenant_id = $1 AND project_id = $2 AND id = $3',
        [ctx.tenantId, projectId, rosterId]
      );
      return r.rowCount > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'ROSTER_MEMBER_NOT_FOUND', 'Không tìm thấy thành viên trong dự án.');
      return;
    }
    res.json({ success: true, data: { id: rosterId, project_id: projectId, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_PROJECT_ROSTER_FAILED', err?.message || 'Không thể xóa thành viên khỏi dự án.');
  }
});

router.get('/:id/whiteboard/snapshots', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT * FROM tenant_task_whiteboard_snapshots
         WHERE tenant_id = $1 AND project_id = $2
         ORDER BY version_no DESC, created_at DESC`,
        [ctx.tenantId, projectId]
      );
      return r.rows.map((row) => {
        const elements = parseJsonSafe<unknown[]>(row.snapshot_json, []);
        return {
          ...row,
          version_no: Number(row.version_no || 1),
          snapshot_json: elements,
          elements,
        };
      });
    });
    res.json({ success: true, data: { items } });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_WB_SNAPSHOTS_FAILED', err?.message || 'Không thể tải lịch sử phiên bản Whiteboard.');
  }
});

router.post('/:id/whiteboard/snapshots', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const body = req.body || {};

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const projRes = await client.query<{ id: string; whiteboard_json: unknown }>(
        'SELECT id, whiteboard_json FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, projectId]
      );
      if (!projRes.rows[0]) return null;

      const verRes = await client.query<{ max_ver: string | number }>(
        `SELECT COALESCE(MAX(version_no), 0) AS max_ver
         FROM tenant_task_whiteboard_snapshots
         WHERE tenant_id = $1 AND project_id = $2`,
        [ctx.tenantId, projectId]
      );
      const nextVersion = Number(verRes.rows[0]?.max_ver || 0) + 1;

      const elements = Array.isArray(body.snapshot_json)
        ? body.snapshot_json
        : Array.isArray(body.elements)
          ? body.elements
          : parseJsonSafe<unknown[]>(projRes.rows[0].whiteboard_json, []);

      const snapshotName =
        String(body.snapshot_name || '').trim() || `Phiên bản v${nextVersion}`;
      const thumbnailNote = body.thumbnail_note
        ? String(body.thumbnail_note).trim()
        : `${elements.length} thẻ trên Bảng trắng`;

      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_task_whiteboard_snapshots (
           id, tenant_id, project_id, snapshot_name, version_no,
           snapshot_json, thumbnail_note, created_by, created_by_name
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          id,
          ctx.tenantId,
          projectId,
          snapshotName,
          nextVersion,
          JSON.stringify(elements),
          thumbnailNote,
          ctx.userId,
          ctx.userName || 'Thành viên',
        ]
      );

      const r = await client.query(
        'SELECT * FROM tenant_task_whiteboard_snapshots WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, id]
      );
      const row = r.rows[0];
      const parsedElements = parseJsonSafe<unknown[]>(row.snapshot_json, []);
      return {
        ...row,
        version_no: Number(row.version_no || nextVersion),
        snapshot_json: parsedElements,
        elements: parsedElements,
      };
    });

    if (!created) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CREATE_WB_SNAPSHOT_FAILED', err?.message || 'Không thể lưu bản chụp Whiteboard.');
  }
});

router.post(
  '/:id/whiteboard/snapshots/:snapshotId/restore',
  requirePermission('projects', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const { id: projectId, snapshotId } = req.params;

      const restored = await withTenantTransaction(ctx.tenantId, async (client) => {
        const snapRes = await client.query<{
          id: string;
          snapshot_name: string;
          version_no: number;
          snapshot_json: unknown;
        }>(
          `SELECT id, snapshot_name, version_no, snapshot_json
           FROM tenant_task_whiteboard_snapshots
           WHERE tenant_id = $1 AND project_id = $2 AND id = $3
           LIMIT 1`,
          [ctx.tenantId, projectId, snapshotId]
        );
        if (!snapRes.rows[0]) return null;
        const snap = snapRes.rows[0];
        const elements = parseJsonSafe<unknown[]>(snap.snapshot_json, []);

        await client.query(
          `UPDATE tenant_projects
           SET whiteboard_json = $3::jsonb,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, projectId, JSON.stringify(elements)]
        );

        return {
          project_id: projectId,
          snapshot_id: snapshotId,
          snapshot_name: snap.snapshot_name,
          restored_version_no: Number(snap.version_no || 1),
          elements,
        };
      });

      if (!restored) {
        sendApiError(res, 404, 'SNAPSHOT_NOT_FOUND', 'Không tìm thấy bản chụp Whiteboard cần khôi phục.');
        return;
      }
      res.json({ success: true, data: restored });
    } catch (err: any) {
      sendApiError(res, 500, 'RESTORE_WB_SNAPSHOT_FAILED', err?.message || 'Không thể khôi phục bản chụp Whiteboard.');
    }
  }
);

router.patch('/:id', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const body = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const existing = await client.query('SELECT * FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        projectId,
      ]);
      if (!existing.rows[0]) return null;
      const cur = existing.rows[0];

      const nextCols = Array.isArray(body.task_columns)
        ? JSON.stringify(body.task_columns)
        : JSON.stringify(parseJsonSafe(cur.task_columns_json, DEFAULT_KANBAN_COLUMNS));
      const nextBoard = Array.isArray(body.whiteboard_elements)
        ? JSON.stringify(body.whiteboard_elements)
        : JSON.stringify(parseJsonSafe(cur.whiteboard_json, []));

      await client.query(
        `UPDATE tenant_projects
         SET name = $3,
             description = $4,
             status = $5,
             priority = $6,
             start_date = $7,
             due_date = $8,
             budget_vnd = $9,
             task_columns_json = $10::jsonb,
             whiteboard_json = $11::jsonb,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          projectId,
          body.name !== undefined ? String(body.name).trim() : cur.name,
          body.description !== undefined ? body.description : cur.description,
          body.status || cur.status,
          body.priority || cur.priority,
          body.start_date !== undefined ? body.start_date || null : cur.start_date,
          body.due_date !== undefined ? body.due_date || null : cur.due_date,
          body.budget_vnd !== undefined ? Math.max(0, Math.round(Number(body.budget_vnd))) : Number(cur.budget_vnd || 0),
          nextCols,
          nextBoard,
        ]
      );

      const r = await client.query('SELECT * FROM tenant_projects WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        projectId,
      ]);
      const row = r.rows[0];
      return {
        ...row,
        budget_vnd: Number(row.budget_vnd || 0),
        task_columns: parseJsonSafe(row.task_columns_json, DEFAULT_KANBAN_COLUMNS),
        whiteboard_elements: parseJsonSafe(row.whiteboard_json, []),
      };
    });

    if (!updated) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_PROJECT_FAILED', err?.message || 'Không thể cập nhật dự án.');
  }
});

router.put('/:id/columns', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const columns = Array.isArray(req.body?.columns) ? req.body.columns : [];
    if (columns.length === 0) {
      sendApiError(res, 422, 'COLUMNS_REQUIRED', 'Danh sách cột Kanban không được để trống.');
      return;
    }

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const check = await client.query('SELECT id FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        projectId,
      ]);
      if (!check.rows[0]) return null;
      await client.query(
        'UPDATE tenant_projects SET task_columns_json = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, projectId, JSON.stringify(columns)]
      );
      await recomputeProjectProgressInTx(client, ctx.tenantId, projectId);
      return columns;
    });

    if (!updated) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    res.json({ success: true, data: { project_id: projectId, columns: updated } });
  } catch (err: any) {
    sendApiError(res, 500, 'UPDATE_COLUMNS_FAILED', err?.message || 'Không thể lưu cấu hình cột Kanban.');
  }
});

router.get('/:id/whiteboard', requirePermission('projects', 'view'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{ id: string; name: string; whiteboard_json: unknown }>(
        'SELECT id, name, whiteboard_json FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, projectId]
      );
      if (!r.rows[0]) return null;
      return {
        project_id: r.rows[0].id,
        project_name: r.rows[0].name,
        elements: parseJsonSafe(r.rows[0].whiteboard_json, []),
      };
    });
    if (!data) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'GET_WHITEBOARD_FAILED', err?.message || 'Không thể tải Whiteboard.');
  }
});

router.put('/:id/whiteboard', requirePermission('projects', 'edit'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const elements = Array.isArray(req.body?.elements) ? req.body.elements : [];

    const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
      const check = await client.query('SELECT id FROM tenant_projects WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        projectId,
      ]);
      if (!check.rows[0]) return null;
      await client.query(
        'UPDATE tenant_projects SET whiteboard_json = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
        [ctx.tenantId, projectId, JSON.stringify(elements)]
      );
      return elements;
    });

    if (!saved) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    res.json({ success: true, data: { project_id: projectId, elements: saved } });
  } catch (err: any) {
    sendApiError(res, 500, 'SAVE_WHITEBOARD_FAILED', err?.message || 'Không thể lưu bảng trắng cộng tác.');
  }
});

router.delete('/:id', requirePermission('projects', 'delete'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const projectId = req.params.id;
    const deleted = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query('DELETE FROM tenant_projects WHERE tenant_id = $1 AND id = $2', [
        ctx.tenantId,
        projectId,
      ]);
      return r.rowCount > 0;
    });
    if (!deleted) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Không tìm thấy dự án.');
      return;
    }
    res.json({ success: true, data: { id: projectId, deleted: true } });
  } catch (err: any) {
    sendApiError(res, 500, 'DELETE_PROJECT_FAILED', err?.message || 'Không thể xóa dự án.');
  }
});

export default router;
