import crypto from 'node:crypto';
import { Router } from 'express';
import { withTenantTransaction } from '../../core/database/transaction.ts';
import { getTenantContext } from '../../core/context/tenant-context.ts';
import {
  buildGranularScopeWhereClause,
  requireAnyPermission,
  requirePermission,
  sendApiError,
} from '../../core/security/rbac.ts';
import {
  maskContactPiiIfDisallowed,
  maskPiiInText,
} from '../../core/security/pii-masker.ts';
import {
  clampLimit,
  parseJsonSafe,
  resolveCrmActorContext,
} from './schema.ts';

export const activitiesWorkspaceRouter = Router();

// ============================================================================
// 1. Unified CRM Activities (/activities: List, Calendar & Breakdown Analytics)
// ============================================================================
activitiesWorkspaceRouter.get(
  '/activities',
  requirePermission('leads', 'view'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const page = Math.max(1, Number(req.query.page || 1));
      const limit = clampLimit(req.query.limit, 50, 200);
      const offset = (page - 1) * limit;
      const activityType = String(req.query.activity_type || req.query.type || '').trim();
      const statusFilter = String(req.query.status || '').trim();
      const ownerId = String(req.query.owner_id || '').trim();
      const leadId = String(req.query.lead_id || '').trim();
      const dealId = String(req.query.deal_id || '').trim();
      const companyId = String(req.query.company_id || '').trim();
      const search = String(req.query.search || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac, canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
          client,
          ctx.tenantId,
          ctx.userId
        );
        const scope = rbac.effectivePermissions.leads?.scope || 'own';
        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg!,
          scope,
          {
            tenantColumn: 'a.tenant_id',
            ownerColumn: 'a.owner_user_id',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const conds: string[] = [scopeSql.clause];
        const vals: unknown[] = [...scopeSql.values];
        let pIdx = scopeSql.nextIndex;

        if (activityType) {
          conds.push(`a.activity_type = $${pIdx}`);
          vals.push(activityType);
          pIdx++;
        }
        if (statusFilter === 'overdue') {
          conds.push("a.status != 'done' AND a.due_date IS NOT NULL AND a.due_date < clock_timestamp()");
        } else if (statusFilter) {
          conds.push(`a.status = $${pIdx}`);
          vals.push(statusFilter);
          pIdx++;
        }
        if (ownerId) {
          conds.push(`a.owner_user_id = $${pIdx}`);
          vals.push(ownerId);
          pIdx++;
        }
        if (leadId) {
          conds.push(`a.lead_id = $${pIdx}`);
          vals.push(leadId);
          pIdx++;
        }
        if (dealId) {
          conds.push(`a.deal_id = $${pIdx}`);
          vals.push(dealId);
          pIdx++;
        }
        if (companyId) {
          conds.push(`a.company_id = $${pIdx}`);
          vals.push(companyId);
          pIdx++;
        }
        if (search) {
          conds.push(
            `(LOWER(a.subject) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(a.body, '')) LIKE LOWER($${pIdx}) OR LOWER(COALESCE(l.name, '')) LIKE LOWER($${pIdx}))`
          );
          vals.push(`%${search}%`);
          pIdx++;
        }

        const whereStr = conds.join(' AND ');

        const [rowsRes, countRes, breakdownRes, staffRes, contactsRes, dealsRes, companiesRes] =
          await Promise.all([
            client.query<Record<string, any>>(
              `SELECT a.*,
                      l.name AS contact_name, l.phone AS contact_phone,
                      d.title AS deal_title,
                      c.name AS company_name
               FROM tenant_crm_activities a
               LEFT JOIN leads l ON l.tenant_id = a.tenant_id AND l.id = a.lead_id
               LEFT JOIN tenant_deals d ON d.tenant_id = a.tenant_id AND d.id = a.deal_id
               LEFT JOIN tenant_b2b_companies c ON c.tenant_id = a.tenant_id AND c.id = a.company_id
               WHERE ${whereStr}
               ORDER BY COALESCE(a.due_date, a.created_at) DESC, a.created_at DESC
               LIMIT $${pIdx} OFFSET $${pIdx + 1}`,
              [...vals, limit, offset]
            ),
            client.query<{ total: string | number; done_count: string | number; overdue_count: string | number }>(
              `SELECT COUNT(*) AS total,
                      COALESCE(SUM(CASE WHEN a.status = 'done' THEN 1 ELSE 0 END), 0) AS done_count,
                      COALESCE(SUM(CASE WHEN a.status != 'done' AND a.due_date IS NOT NULL AND a.due_date < clock_timestamp() THEN 1 ELSE 0 END), 0) AS overdue_count
               FROM tenant_crm_activities a
               LEFT JOIN leads l ON l.tenant_id = a.tenant_id AND l.id = a.lead_id
               WHERE ${whereStr}`,
              vals
            ),
            client.query<{ activity_type: string; cnt: string | number }>(
              `SELECT a.activity_type, COUNT(*) AS cnt
               FROM tenant_crm_activities a
               WHERE a.tenant_id = $1
               GROUP BY a.activity_type`,
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, full_name, email, role FROM users WHERE tenant_id = $1 AND is_system_bot = false ORDER BY full_name ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, name, phone, email FROM leads WHERE tenant_id = $1 AND is_deleted = false ORDER BY created_at DESC LIMIT 100',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, deal_code, title, amount_vnd FROM tenant_deals WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, code, name FROM tenant_b2b_companies WHERE tenant_id = $1 ORDER BY name ASC LIMIT 100',
              [ctx.tenantId]
            ),
          ]);

        const piiCfg = parseJsonSafe<Record<string, any>>(tenantSettings, {});
        const items = rowsRes.rows.map((r) => {
          const maskedContact = maskContactPiiIfDisallowed(
            { phone: r.contact_phone },
            canUnmaskLeads,
            piiCfg
          );
          return {
            ...r,
            body: canUnmaskLeads ? r.body : maskPiiInText(r.body, piiCfg),
            contact_phone: maskedContact.phone,
            mentions_json: parseJsonSafe(r.mentions_json, []),
            edit_history_json: parseJsonSafe(r.edit_history_json, []),
            metadata: parseJsonSafe(r.metadata, {}),
          };
        });

        const maskedContacts = contactsRes.rows.map((c: any) =>
          maskContactPiiIfDisallowed(c, canUnmaskLeads, piiCfg)
        );

        const cRow = countRes.rows[0];
        return {
          items,
          total: Number(cRow?.total || 0),
          page,
          limit,
          summary: {
            total: Number(cRow?.total || 0),
            done_count: Number(cRow?.done_count || 0),
            overdue_count: Number(cRow?.overdue_count || 0),
            by_type: breakdownRes.rows.map((b) => ({
              activity_type: b.activity_type,
              count: Number(b.cnt || 0),
            })),
          },
          staff: staffRes.rows,
          contacts: maskedContacts,
          deals: dealsRes.rows,
          companies: companiesRes.rows,
        };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ACTIVITIES_LIST_FAILED', err?.message || 'Không thể tải danh sách hoạt động CRM.');
    }
  }
);

activitiesWorkspaceRouter.post(
  '/activities',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const subject = String(b.subject || '').trim();
      if (!subject) {
        sendApiError(res, 400, 'INVALID_ACTIVITY_SUBJECT', 'Vui lòng nhập tiêu đề hoạt động.');
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const actId = crypto.randomUUID();
        const actType = String(b.activity_type || b.type || 'call').trim();
        const status = String(b.status || 'planned').trim();
        const priority = ['low', 'medium', 'high', 'urgent'].includes(String(b.priority || ''))
          ? String(b.priority)
          : 'medium';
        const ownerUserId = b.owner_user_id ? String(b.owner_user_id) : ctx.userId;

        let linkedTaskId: string | null = b.task_id ? String(b.task_id) : null;
        if (actType === 'task' && !linkedTaskId) {
          linkedTaskId = crypto.randomUUID();
          await client.query(
            `INSERT INTO tenant_tasks (
               id, tenant_id, lead_id, deal_id, company_id, title, description,
               status_key, priority, assignee_user_id, reporter_user_id, due_date, category
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'customer')`,
            [
              linkedTaskId,
              ctx.tenantId,
              b.lead_id || null,
              b.deal_id || null,
              b.company_id || null,
              subject.slice(0, 255),
              b.body ? String(b.body) : null,
              status === 'done' ? 'done' : 'todo',
              priority,
              ownerUserId,
              ctx.userId,
              b.due_date || null,
            ]
          );
        }

        await client.query(
          `INSERT INTO tenant_crm_activities (
             id, tenant_id, activity_type, subject, body, status, priority,
             due_date, completed_at, duration_minutes, lead_id, company_id, deal_id, task_id,
             owner_user_id, owner_name, mentions_json, edit_history_json, metadata, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, '[]', $18, $19
           )`,
          [
            actId,
            ctx.tenantId,
            actType,
            subject.slice(0, 255),
            b.body ? String(b.body) : null,
            status,
            priority,
            b.due_date || null,
            status === 'done' ? new Date().toISOString() : null,
            Math.max(0, Math.round(Number(b.duration_minutes || 15))),
            b.lead_id || null,
            b.company_id || null,
            b.deal_id || null,
            linkedTaskId,
            ownerUserId,
            actorName,
            JSON.stringify(Array.isArray(b.mentions) ? b.mentions : []),
            JSON.stringify(b.metadata && typeof b.metadata === 'object' ? b.metadata : {}),
            ctx.userId,
          ]
        );

        if (b.lead_id) {
          await client.query(
            'UPDATE leads SET last_engaged_at = clock_timestamp(), updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2',
            [ctx.tenantId, String(b.lead_id)]
          );
        }

        const r = await client.query('SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          actId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ACTIVITY_CREATE_FAILED', err?.message || 'Không thể lưu hoạt động.');
    }
  }
);

activitiesWorkspaceRouter.put(
  '/activities/:id',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const actId = String(req.params.id || '').trim();
      const b = req.body || {};

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const curRes = await client.query<Record<string, any>>(
          'SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, actId]
        );
        if (curRes.rows.length === 0) return null;
        const cur = curRes.rows[0];

        const prevHist = parseJsonSafe<any[]>(cur.edit_history_json, []);
        const nextHist =
          b.body !== undefined && b.body !== cur.body
            ? [
                {
                  edited_by_id: ctx.userId,
                  edited_by_name: actorName,
                  edited_at: new Date().toISOString(),
                  old_body: cur.body,
                  old_subject: cur.subject,
                },
                ...prevHist,
              ].slice(0, 3)
            : prevHist;

        const nextStatus = b.status !== undefined ? String(b.status) : cur.status;
        await client.query(
          `UPDATE tenant_crm_activities
           SET activity_type = $3,
               subject = $4,
               body = $5,
               status = $6,
               priority = $7,
               due_date = $8,
               completed_at = $9,
               edit_history_json = $10,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            actId,
            b.activity_type !== undefined ? String(b.activity_type) : cur.activity_type,
            b.subject !== undefined ? String(b.subject).trim().slice(0, 255) : cur.subject,
            b.body !== undefined ? b.body || null : cur.body,
            nextStatus,
            b.priority !== undefined ? String(b.priority) : cur.priority,
            b.due_date !== undefined ? b.due_date || null : cur.due_date,
            nextStatus === 'done' && !cur.completed_at ? new Date().toISOString() : cur.completed_at,
            JSON.stringify(nextHist),
          ]
        );

        const fresh = await client.query('SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          actId,
        ]);
        return fresh.rows[0];
      });

      if (!updated) {
        sendApiError(res, 404, 'ACTIVITY_NOT_FOUND', 'Không tìm thấy hoạt động.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ACTIVITY_UPDATE_FAILED', err?.message || 'Không thể cập nhật hoạt động.');
    }
  }
);

activitiesWorkspaceRouter.patch(
  '/activities/:id/toggle-done',
  requirePermission('leads', 'edit'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const actId = String(req.params.id || '').trim();
      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const cur = await client.query<{ status: string }>(
          'SELECT status FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, actId]
        );
        if (cur.rows.length === 0) return null;
        const nextStatus = cur.rows[0].status === 'done' ? 'planned' : 'done';
        await client.query(
          `UPDATE tenant_crm_activities
           SET status = $3,
               completed_at = CASE WHEN $3 = 'done' THEN clock_timestamp() ELSE NULL END,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ctx.tenantId, actId, nextStatus]
        );
        const r = await client.query('SELECT * FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          actId,
        ]);
        return r.rows[0];
      });
      if (!updated) {
        sendApiError(res, 404, 'ACTIVITY_NOT_FOUND', 'Không tìm thấy hoạt động.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ACTIVITY_TOGGLE_FAILED', err?.message || 'Không thể đổi trạng thái hoạt động.');
    }
  }
);

activitiesWorkspaceRouter.delete(
  '/activities/:id',
  requirePermission('leads', 'delete'),
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query('DELETE FROM tenant_crm_activities WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          String(req.params.id),
        ]);
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_ACTIVITY_DELETE_FAILED', err?.message || 'Không thể xóa hoạt động.');
    }
  }
);

// ============================================================================
// 2. Personal Workspace (/workspace) & WorkspaceTaskDrawer
// ============================================================================
const workspaceViewGuard = requireAnyPermission([
  ['workspace_personal', 'view'],
  ['projects', 'view'],
  ['sale_portal', 'view'],
  ['leads', 'view'],
]);

const workspaceEditGuard = requireAnyPermission([
  ['workspace_personal', 'edit'],
  ['projects', 'edit'],
  ['sale_portal', 'edit'],
  ['leads', 'edit'],
]);

activitiesWorkspaceRouter.get(
  '/workspace/bootstrap',
  workspaceViewGuard,
  async (_req, res) => {
    try {
      const ctx = getTenantContext();
      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { rbac } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const projPerm =
          rbac.effectivePermissions.workspace_personal ||
          rbac.effectivePermissions.projects ||
          rbac.effectivePermissions.leads;
        const scope = projPerm?.scope || 'own';

        const scopeSql = await buildGranularScopeWhereClause(
          client,
          ctx.tenantId,
          rbac.userOrg!,
          scope,
          {
            tenantColumn: 't.tenant_id',
            ownerColumn: 't.assignee_user_id',
            startParamIndex: 1,
            allowUnassignedForManagers: true,
          }
        );

        const [prefsRes, groupsRes, tasksRes, pomoRes, staffRes, teamsRes, projectsRes] =
          await Promise.all([
            client.query(
              'SELECT * FROM tenant_workspace_preferences WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
              [ctx.tenantId, ctx.userId]
            ),
            client.query<Record<string, any>>(
              `SELECT * FROM tenant_workspace_task_groups
               WHERE tenant_id = $1 AND user_id = $2
               ORDER BY is_pinned DESC, sort_order ASC, created_at ASC`,
              [ctx.tenantId, ctx.userId]
            ),
            client.query<Record<string, any>>(
              `SELECT t.*,
                      u.full_name AS assignee_name,
                      rep.full_name AS reporter_name,
                      p.name AS project_name,
                      l.name AS contact_name,
                      d.title AS deal_title,
                      c.name AS company_name,
                      (SELECT COUNT(*) FROM tenant_task_comments tc WHERE tc.tenant_id = t.tenant_id AND tc.task_id = t.id) AS comments_count,
                      (SELECT COUNT(*) FROM tenant_task_attachments ta WHERE ta.tenant_id = t.tenant_id AND ta.task_id = t.id) AS attachments_count,
                      (SELECT COUNT(*) FROM tenant_task_dependencies td WHERE td.tenant_id = t.tenant_id AND td.task_id = t.id) AS dependencies_count
               FROM tenant_tasks t
               LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_user_id
               LEFT JOIN users rep ON rep.tenant_id = t.tenant_id AND rep.id = t.reporter_user_id
               LEFT JOIN tenant_projects p ON p.tenant_id = t.tenant_id AND p.id = t.project_id
               LEFT JOIN leads l ON l.tenant_id = t.tenant_id AND l.id = t.lead_id
               LEFT JOIN tenant_deals d ON d.tenant_id = t.tenant_id AND d.id = t.deal_id
               LEFT JOIN tenant_b2b_companies c ON c.tenant_id = t.tenant_id AND c.id = t.company_id
               WHERE (${scopeSql.clause} OR (t.tenant_id = $1 AND t.reporter_user_id = $${scopeSql.nextIndex}))
               ORDER BY t.sort_order ASC, t.created_at DESC
               LIMIT 300`,
              [...scopeSql.values, ctx.userId]
            ),
            client.query(
              `SELECT ps.*, t.title AS task_title
               FROM tenant_pomodoro_sessions ps
               LEFT JOIN tenant_tasks t ON t.tenant_id = ps.tenant_id AND t.id = ps.task_id
               WHERE ps.tenant_id = $1 AND ps.user_id = $2
               ORDER BY ps.created_at DESC
               LIMIT 30`,
              [ctx.tenantId, ctx.userId]
            ),
            client.query(
              'SELECT id, full_name, email, role, team_id, department_id FROM users WHERE tenant_id = $1 AND is_system_bot = false ORDER BY full_name ASC',
              [ctx.tenantId]
            ),
            client.query(
              'SELECT id, name, leader_user_id AS leader_id FROM tenant_teams WHERE tenant_id = $1 ORDER BY name ASC',
              [ctx.tenantId]
            ),
            client.query(
              "SELECT id, code, name FROM tenant_projects WHERE tenant_id = $1 AND status != 'archived' ORDER BY created_at DESC LIMIT 100",
              [ctx.tenantId]
            ),
          ]);

        const tasks: Array<Record<string, any>> = tasksRes.rows.map((t: Record<string, any>) => ({
          ...t,
          checklist_json: parseJsonSafe(t.checklist_json, []),
          dependencies_json: parseJsonSafe(t.dependencies_json, []),
          participant_ids_json: parseJsonSafe(t.participant_ids_json, []),
          tags_json: parseJsonSafe(t.tags_json, []),
          is_muted: Boolean(t.is_muted),
          is_hidden: Boolean(t.is_hidden),
          comments_count: Number(t.comments_count || 0),
          attachments_count: Number(t.attachments_count || 0),
          dependencies_count: Number(t.dependencies_count || 0),
        }));

        const computeStats = (subset: any[]) => {
          const total = subset.length;
          const completed = subset.filter((x) => x.status_key === 'done').length;
          return {
            total_tasks: total,
            completed_tasks: completed,
            pending_tasks: total - completed,
            progress_percent: total > 0 ? Math.round((completed / total) * 100) : 0,
          };
        };

        const myTasks = tasks.filter(
          (t) => !t.is_hidden && (t.assignee_user_id === ctx.userId || t.reporter_user_id === ctx.userId)
        );
        const groups = groupsRes.rows.map((g) => {
          const gTasks = myTasks.filter((t) => String(t.group_id || '') === String(g.id));
          return {
            ...g,
            is_pinned: Boolean(g.is_pinned),
            ...computeStats(gTasks),
          };
        });

        const summary = {
          all: computeStats(myTasks),
          personal: computeStats(myTasks.filter((t) => t.category === 'personal' || (!t.project_id && !t.lead_id))),
          unassigned: computeStats(myTasks.filter((t) => !t.group_id)),
        };

        const prefRow = prefsRes.rows[0] as Record<string, any> | undefined;
        return {
          preferences: {
            wallpaper_url: String(prefRow?.wallpaper_url || ''),
            grid_columns: Number(prefRow?.grid_columns || 3),
            overlay_opacity: Number(prefRow?.overlay_opacity ?? 15),
            hide_completed: Boolean(prefRow?.hide_completed),
            settings_json: parseJsonSafe(prefRow?.settings_json, {}),
          },
          groups,
          summary,
          tasks,
          pomodoro_sessions: pomoRes.rows,
          staff: staffRes.rows,
          teams: teamsRes.rows,
          projects: projectsRes.rows,
        };
      });

      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_WORKSPACE_BOOTSTRAP_FAILED', err?.message || 'Không thể tải Bàn làm việc cá nhân.');
    }
  }
);

activitiesWorkspaceRouter.put(
  '/workspace/preferences',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const saved = await withTenantTransaction(ctx.tenantId, async (client) => {
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM tenant_workspace_preferences WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
          [ctx.tenantId, ctx.userId]
        );
        const wallpaperUrl = String(b.wallpaper_url ?? '');
        const gridCols = Math.max(1, Math.min(4, Number(b.grid_columns || 3)));
        const overlayOpacity = Math.max(0, Math.min(85, Number(b.overlay_opacity ?? 15)));
        const hideCompleted = Boolean(b.hide_completed);
        const settingsJson = JSON.stringify(
          b.settings_json && typeof b.settings_json === 'object' ? b.settings_json : {}
        );

        if (existing.rows.length > 0) {
          await client.query(
            `UPDATE tenant_workspace_preferences
             SET wallpaper_url = $3, grid_columns = $4, overlay_opacity = $5, hide_completed = $6, settings_json = $7, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND user_id = $2`,
            [ctx.tenantId, ctx.userId, wallpaperUrl, gridCols, overlayOpacity, hideCompleted, settingsJson]
          );
        } else {
          await client.query(
            `INSERT INTO tenant_workspace_preferences (
               id, tenant_id, user_id, wallpaper_url, grid_columns, overlay_opacity, hide_completed, settings_json
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [crypto.randomUUID(), ctx.tenantId, ctx.userId, wallpaperUrl, gridCols, overlayOpacity, hideCompleted, settingsJson]
          );
        }
        return {
          wallpaper_url: wallpaperUrl,
          grid_columns: gridCols,
          overlay_opacity: overlayOpacity,
          hide_completed: hideCompleted,
        };
      });
      res.json({ success: true, data: saved });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_WORKSPACE_PREFS_FAILED', err?.message || 'Không thể lưu tùy biến giao diện.');
    }
  }
);

// TaskGroupSection CRUD & Drag Reorder
activitiesWorkspaceRouter.post(
  '/workspace/groups',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name) {
        sendApiError(res, 400, 'INVALID_GROUP_NAME', 'Vui lòng nhập tên nhóm công việc.');
        return;
      }
      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const gId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_workspace_task_groups (
             id, tenant_id, user_id, name, color_hex, icon_name, sort_order, is_pinned
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            gId,
            ctx.tenantId,
            ctx.userId,
            name.slice(0, 120),
            String(b.color_hex || '#1E40FF').slice(0, 20),
            String(b.icon_name || 'Folder').slice(0, 50),
            Number(b.sort_order || 0),
            Boolean(b.is_pinned),
          ]
        );
        const r = await client.query('SELECT * FROM tenant_workspace_task_groups WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          gId,
        ]);
        return r.rows[0];
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_GROUP_CREATE_FAILED', err?.message || 'Không thể tạo nhóm công việc.');
    }
  }
);

activitiesWorkspaceRouter.put(
  '/workspace/groups/:id',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const gId = String(req.params.id || '').trim();
      const b = req.body || {};
      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const cur = await client.query<Record<string, any>>(
          'SELECT * FROM tenant_workspace_task_groups WHERE tenant_id = $1 AND id = $2 AND user_id = $3 LIMIT 1',
          [ctx.tenantId, gId, ctx.userId]
        );
        if (cur.rows.length === 0) return null;
        const row = cur.rows[0];
        await client.query(
          `UPDATE tenant_workspace_task_groups
           SET name = $3, color_hex = $4, icon_name = $5, is_pinned = $6, sort_order = $7, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            gId,
            b.name !== undefined ? String(b.name).trim().slice(0, 120) : row.name,
            b.color_hex !== undefined ? String(b.color_hex) : row.color_hex,
            b.icon_name !== undefined ? String(b.icon_name) : row.icon_name,
            b.is_pinned !== undefined ? Boolean(b.is_pinned) : Boolean(row.is_pinned),
            b.sort_order !== undefined ? Number(b.sort_order) : Number(row.sort_order || 0),
          ]
        );
        const r = await client.query('SELECT * FROM tenant_workspace_task_groups WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          gId,
        ]);
        return r.rows[0];
      });
      if (!updated) {
        sendApiError(res, 404, 'TASK_GROUP_NOT_FOUND', 'Không tìm thấy nhóm công việc.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_GROUP_UPDATE_FAILED', err?.message || 'Không thể cập nhật nhóm công việc.');
    }
  }
);

activitiesWorkspaceRouter.post(
  '/workspace/groups/reorder',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const orderedIds = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids : [];
      await withTenantTransaction(ctx.tenantId, async (client) => {
        for (let i = 0; i < orderedIds.length; i++) {
          await client.query(
            'UPDATE tenant_workspace_task_groups SET sort_order = $3, updated_at = clock_timestamp() WHERE tenant_id = $1 AND user_id = $2 AND id = $4',
            [ctx.tenantId, ctx.userId, i, String(orderedIds[i])]
          );
        }
      });
      res.json({ success: true, data: { reordered: orderedIds.length } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_GROUP_REORDER_FAILED', err?.message || 'Không thể sắp xếp nhóm công việc.');
    }
  }
);

activitiesWorkspaceRouter.delete(
  '/workspace/groups/:id',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const gId = String(req.params.id || '').trim();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'UPDATE tenant_tasks SET group_id = NULL WHERE tenant_id = $1 AND group_id = $2',
          [ctx.tenantId, gId]
        );
        await client.query(
          'DELETE FROM tenant_workspace_task_groups WHERE tenant_id = $1 AND id = $2 AND user_id = $3',
          [ctx.tenantId, gId, ctx.userId]
        );
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_GROUP_DELETE_FAILED', err?.message || 'Không thể xóa nhóm công việc.');
    }
  }
);

// WorkspaceTaskDrawer Full Detail + Checklists + Dependencies + Comments + Attachments + Pomodoro
activitiesWorkspaceRouter.post(
  '/workspace/tasks',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const title = String(b.title || b.subject || '').trim();
      if (!title) {
        sendApiError(res, 400, 'INVALID_TASK_TITLE', 'Vui lòng nhập tiêu đề công việc.');
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const taskId = crypto.randomUUID();
        const priority = ['low', 'medium', 'high', 'urgent'].includes(String(b.priority || ''))
          ? String(b.priority)
          : 'medium';
        const statusKey = String(b.status_key || 'todo');
        const checklist = Array.isArray(b.checklist_json) ? b.checklist_json : [];

        await client.query(
          `INSERT INTO tenant_tasks (
             id, tenant_id, project_id, lead_id, deal_id, company_id, group_id,
             title, description, status_key, priority, assignee_user_id, reporter_user_id,
             start_date, due_date, estimated_minutes, progress_pct, sort_order,
             checklist_json, category, is_muted, is_hidden, participant_ids_json, tags_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18,
             $19, $20, $21, $22, $23, $24
           )`,
          [
            taskId,
            ctx.tenantId,
            b.project_id || null,
            b.lead_id || null,
            b.deal_id || null,
            b.company_id || null,
            b.group_id || null,
            title.slice(0, 255),
            b.description ? String(b.description) : null,
            statusKey,
            priority,
            b.assignee_user_id || ctx.userId,
            ctx.userId,
            b.start_date || null,
            b.due_date || null,
            Math.max(5, Math.round(Number(b.estimated_minutes || 45))),
            statusKey === 'done' ? 100 : Math.max(0, Math.min(100, Number(b.progress_pct || 0))),
            Number(b.sort_order || 0),
            JSON.stringify(checklist),
            String(b.category || (b.lead_id || b.deal_id ? 'customer' : b.project_id ? 'project' : 'personal')),
            Boolean(b.is_muted),
            Boolean(b.is_hidden),
            JSON.stringify(Array.isArray(b.participant_ids_json) ? b.participant_ids_json : []),
            JSON.stringify(Array.isArray(b.tags_json) ? b.tags_json : []),
          ]
        );

        const r = await client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          taskId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_CREATE_FAILED', err?.message || 'Không thể tạo công việc.');
    }
  }
);

activitiesWorkspaceRouter.get(
  '/workspace/tasks/:id',
  workspaceViewGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const taskId = String(req.params.id || '').trim();

      const data = await withTenantTransaction(ctx.tenantId, async (client) => {
        const taskRes = await client.query<Record<string, any>>(
          `SELECT t.*,
                  u.full_name AS assignee_name,
                  rep.full_name AS reporter_name,
                  p.name AS project_name,
                  l.name AS contact_name,
                  d.title AS deal_title,
                  c.name AS company_name
           FROM tenant_tasks t
           LEFT JOIN users u ON u.tenant_id = t.tenant_id AND u.id = t.assignee_user_id
           LEFT JOIN users rep ON rep.tenant_id = t.tenant_id AND rep.id = t.reporter_user_id
           LEFT JOIN tenant_projects p ON p.tenant_id = t.tenant_id AND p.id = t.project_id
           LEFT JOIN leads l ON l.tenant_id = t.tenant_id AND l.id = t.lead_id
           LEFT JOIN tenant_deals d ON d.tenant_id = t.tenant_id AND d.id = t.deal_id
           LEFT JOIN tenant_b2b_companies c ON c.tenant_id = t.tenant_id AND c.id = t.company_id
           WHERE t.tenant_id = $1 AND t.id = $2
           LIMIT 1`,
          [ctx.tenantId, taskId]
        );
        if (taskRes.rows.length === 0) return null;
        const t = taskRes.rows[0];

        const [depsRes, commentsRes, attachmentsRes, pomoRes, candidateTasksRes] =
          await Promise.all([
            client.query(
              `SELECT td.*,
                      COALESCE(td.depends_on_task_id, td.predecessor_task_id) AS depends_on_task_id,
                      other.title AS depends_on_title,
                      other.status_key AS depends_on_status
               FROM tenant_task_dependencies td
               LEFT JOIN tenant_tasks other
                 ON other.tenant_id = td.tenant_id
                AND other.id = COALESCE(td.depends_on_task_id, td.predecessor_task_id)
               WHERE td.tenant_id = $1 AND td.task_id = $2
               ORDER BY td.created_at ASC`,
              [ctx.tenantId, taskId]
            ),
            client.query(
              `SELECT * FROM tenant_task_comments
               WHERE tenant_id = $1 AND task_id = $2
               ORDER BY created_at ASC`,
              [ctx.tenantId, taskId]
            ),
            client.query(
              `SELECT * FROM tenant_task_attachments
               WHERE tenant_id = $1 AND task_id = $2
               ORDER BY created_at DESC`,
              [ctx.tenantId, taskId]
            ),
            client.query(
              `SELECT * FROM tenant_pomodoro_sessions
               WHERE tenant_id = $1 AND task_id = $2
               ORDER BY created_at DESC LIMIT 20`,
              [ctx.tenantId, taskId]
            ),
            client.query(
              `SELECT id, title, status_key, priority
               FROM tenant_tasks
               WHERE tenant_id = $1 AND id != $2
               ORDER BY created_at DESC LIMIT 100`,
              [ctx.tenantId, taskId]
            ),
          ]);

        return {
          task: {
            ...t,
            checklist_json: parseJsonSafe(t.checklist_json, []),
            participant_ids_json: parseJsonSafe(t.participant_ids_json, []),
            tags_json: parseJsonSafe(t.tags_json, []),
            is_muted: Boolean(t.is_muted),
            is_hidden: Boolean(t.is_hidden),
          },
          dependencies: depsRes.rows,
          comments: commentsRes.rows.map((cm: any) => ({
            ...cm,
            mentions_json: parseJsonSafe(cm.mentions_json, []),
            attachments_json: parseJsonSafe(cm.attachments_json, []),
          })),
          attachments: attachmentsRes.rows,
          pomodoro_sessions: pomoRes.rows,
          candidate_tasks: candidateTasksRes.rows,
        };
      });

      if (!data) {
        sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
        return;
      }
      res.json({ success: true, data });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_GET_FAILED', err?.message || 'Không thể tải chi tiết công việc.');
    }
  }
);

activitiesWorkspaceRouter.put(
  '/workspace/tasks/:id',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const taskId = String(req.params.id || '').trim();
      const b = req.body || {};

      const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
        const curRes = await client.query<Record<string, any>>(
          'SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1',
          [ctx.tenantId, taskId]
        );
        if (curRes.rows.length === 0) return null;
        const cur = curRes.rows[0];

        const nextChecklist = Array.isArray(b.checklist_json)
          ? b.checklist_json
          : parseJsonSafe<any[]>(cur.checklist_json, []);
        let nextProgress =
          b.progress_pct !== undefined ? Number(b.progress_pct) : Number(cur.progress_pct || 0);
        if (Array.isArray(b.checklist_json) && nextChecklist.length > 0 && b.progress_pct === undefined) {
          const doneCount = nextChecklist.filter((c: any) => Boolean(c.done || c.completed)).length;
          nextProgress = Math.round((doneCount / nextChecklist.length) * 100);
        }

        const nextStatus = b.status_key !== undefined ? String(b.status_key) : cur.status_key;
        if (nextStatus === 'done') nextProgress = 100;

        await client.query(
          `UPDATE tenant_tasks
           SET title = $3,
               description = $4,
               status_key = $5,
               priority = $6,
               assignee_user_id = $7,
               project_id = $8,
               lead_id = $9,
               deal_id = $10,
               company_id = $11,
               group_id = $12,
               start_date = $13,
               due_date = $14,
               estimated_minutes = $15,
               progress_pct = $16,
               checklist_json = $17,
               category = $18,
               is_muted = $19,
               is_hidden = $20,
               participant_ids_json = $21,
               tags_json = $22,
               completed_at = CASE WHEN $5 = 'done' AND completed_at IS NULL THEN clock_timestamp() WHEN $5 != 'done' THEN NULL ELSE completed_at END,
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [
            ctx.tenantId,
            taskId,
            b.title !== undefined ? String(b.title).trim().slice(0, 255) : cur.title,
            b.description !== undefined ? b.description || null : cur.description,
            nextStatus,
            b.priority !== undefined ? String(b.priority) : cur.priority,
            b.assignee_user_id !== undefined ? b.assignee_user_id || null : cur.assignee_user_id,
            b.project_id !== undefined ? b.project_id || null : cur.project_id,
            b.lead_id !== undefined ? b.lead_id || null : cur.lead_id,
            b.deal_id !== undefined ? b.deal_id || null : cur.deal_id,
            b.company_id !== undefined ? b.company_id || null : cur.company_id,
            b.group_id !== undefined ? b.group_id || null : cur.group_id,
            b.start_date !== undefined ? b.start_date || null : cur.start_date,
            b.due_date !== undefined ? b.due_date || null : cur.due_date,
            b.estimated_minutes !== undefined ? Math.max(5, Number(b.estimated_minutes)) : Number(cur.estimated_minutes || 45),
            Math.max(0, Math.min(100, nextProgress)),
            JSON.stringify(nextChecklist),
            b.category !== undefined ? String(b.category) : cur.category,
            b.is_muted !== undefined ? Boolean(b.is_muted) : Boolean(cur.is_muted),
            b.is_hidden !== undefined ? Boolean(b.is_hidden) : Boolean(cur.is_hidden),
            JSON.stringify(
              Array.isArray(b.participant_ids_json)
                ? b.participant_ids_json
                : parseJsonSafe(cur.participant_ids_json, [])
            ),
            JSON.stringify(Array.isArray(b.tags_json) ? b.tags_json : parseJsonSafe(cur.tags_json, [])),
          ]
        );

        const fresh = await client.query('SELECT * FROM tenant_tasks WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          taskId,
        ]);
        return fresh.rows[0];
      });

      if (!updated) {
        sendApiError(res, 404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_UPDATE_FAILED', err?.message || 'Không thể cập nhật công việc.');
    }
  }
);

activitiesWorkspaceRouter.post(
  '/workspace/tasks/reorder',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const orderedIds = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids : [];
      await withTenantTransaction(ctx.tenantId, async (client) => {
        for (let i = 0; i < orderedIds.length; i++) {
          await client.query(
            'UPDATE tenant_tasks SET sort_order = $2, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $3',
            [ctx.tenantId, i, String(orderedIds[i])]
          );
        }
      });
      res.json({ success: true, data: { reordered: orderedIds.length } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_REORDER_FAILED', err?.message || 'Không thể sắp xếp thứ tự công việc.');
    }
  }
);

activitiesWorkspaceRouter.delete(
  '/workspace/tasks/:id',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const taskId = String(req.params.id || '').trim();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'DELETE FROM tenant_task_dependencies WHERE tenant_id = $1 AND (task_id = $2 OR depends_on_task_id = $2 OR predecessor_task_id = $2)',
          [ctx.tenantId, taskId]
        );
        await client.query('DELETE FROM tenant_task_comments WHERE tenant_id = $1 AND task_id = $2', [
          ctx.tenantId,
          taskId,
        ]);
        await client.query('DELETE FROM tenant_task_attachments WHERE tenant_id = $1 AND task_id = $2', [
          ctx.tenantId,
          taskId,
        ]);
        await client.query('DELETE FROM tenant_tasks WHERE tenant_id = $1 AND id = $2', [
          ctx.tenantId,
          taskId,
        ]);
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_DELETE_FAILED', err?.message || 'Không thể xóa công việc.');
    }
  }
);

// Task Dependencies (`tenant_task_dependencies`)
activitiesWorkspaceRouter.post(
  '/workspace/tasks/:id/dependencies',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const taskId = String(req.params.id || '').trim();
      const dependsOnId = String(req.body?.depends_on_task_id || req.body?.predecessor_task_id || '').trim();
      const depType = ['blocks', 'blocked_by', 'relates_to', 'FS', 'SS', 'FF', 'SF'].includes(
        String(req.body?.dependency_type || '')
      )
        ? String(req.body.dependency_type)
        : 'blocked_by';

      if (!dependsOnId || dependsOnId === taskId) {
        sendApiError(res, 400, 'INVALID_TASK_DEPENDENCY', 'Công việc phụ thuộc không hợp lệ.');
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const depId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_task_dependencies (
             id, tenant_id, task_id, predecessor_task_id, depends_on_task_id, dependency_type, note, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [depId, ctx.tenantId, taskId, dependsOnId, dependsOnId, depType, req.body?.note || null, ctx.userId]
        );
        const r = await client.query(
          `SELECT td.*,
                  COALESCE(td.depends_on_task_id, td.predecessor_task_id) AS depends_on_task_id,
                  other.title AS depends_on_title,
                  other.status_key AS depends_on_status
           FROM tenant_task_dependencies td
           LEFT JOIN tenant_tasks other
             ON other.tenant_id = td.tenant_id
            AND other.id = COALESCE(td.depends_on_task_id, td.predecessor_task_id)
           WHERE td.tenant_id = $1 AND td.id = $2 LIMIT 1`,
          [ctx.tenantId, depId]
        );
        return r.rows[0];
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_DEP_ADD_FAILED', err?.message || 'Không thể thêm ràng buộc công việc.');
    }
  }
);

activitiesWorkspaceRouter.delete(
  '/workspace/tasks/:id/dependencies/:depId',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'DELETE FROM tenant_task_dependencies WHERE tenant_id = $1 AND task_id = $2 AND id = $3',
          [ctx.tenantId, String(req.params.id), String(req.params.depId)]
        );
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_DEP_DELETE_FAILED', err?.message || 'Không thể gỡ ràng buộc.');
    }
  }
);

// Task @Mention Comments (`tenant_task_comments`)
activitiesWorkspaceRouter.post(
  '/workspace/tasks/:id/comments',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const taskId = String(req.params.id || '').trim();
      const content = String(req.body?.content || '').trim();
      if (!content) {
        sendApiError(res, 400, 'EMPTY_TASK_COMMENT', 'Nội dung bình luận không được để trống.');
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const cId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_task_comments (
             id, tenant_id, task_id, author_user_id, author_name, content, mentions_json, attachments_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            cId,
            ctx.tenantId,
            taskId,
            ctx.userId,
            actorName,
            content,
            JSON.stringify(Array.isArray(req.body?.mentions) ? req.body.mentions : []),
            JSON.stringify(Array.isArray(req.body?.attachments) ? req.body.attachments : []),
          ]
        );
        const r = await client.query('SELECT * FROM tenant_task_comments WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          cId,
        ]);
        return r.rows[0];
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_COMMENT_ADD_FAILED', err?.message || 'Không thể gửi bình luận.');
    }
  }
);

activitiesWorkspaceRouter.delete(
  '/workspace/tasks/:id/comments/:commentId',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'DELETE FROM tenant_task_comments WHERE tenant_id = $1 AND task_id = $2 AND id = $3',
          [ctx.tenantId, String(req.params.id), String(req.params.commentId)]
        );
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_COMMENT_DELETE_FAILED', err?.message || 'Không thể xóa bình luận.');
    }
  }
);

// Task Attachments (`tenant_task_attachments`)
activitiesWorkspaceRouter.post(
  '/workspace/tasks/:id/attachments',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const taskId = String(req.params.id || '').trim();
      const fileName = String(req.body?.file_name || '').trim();
      const fileUrl = String(req.body?.file_url || '').trim();
      if (!fileName || !fileUrl) {
        sendApiError(res, 400, 'INVALID_TASK_ATTACHMENT', 'Vui lòng nhập tên tệp và đường dẫn đính kèm.');
        return;
      }

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
        const attId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_task_attachments (
             id, tenant_id, task_id, file_name, file_url, mime_type, size_bytes, uploaded_by, uploaded_by_name
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            attId,
            ctx.tenantId,
            taskId,
            fileName.slice(0, 255),
            fileUrl,
            String(req.body?.mime_type || 'application/octet-stream'),
            Math.max(0, Math.round(Number(req.body?.size_bytes || 0))),
            ctx.userId,
            actorName,
          ]
        );
        const r = await client.query('SELECT * FROM tenant_task_attachments WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          attId,
        ]);
        return r.rows[0];
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_ATTACHMENT_ADD_FAILED', err?.message || 'Không thể đính kèm tệp.');
    }
  }
);

activitiesWorkspaceRouter.delete(
  '/workspace/tasks/:id/attachments/:attId',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'DELETE FROM tenant_task_attachments WHERE tenant_id = $1 AND task_id = $2 AND id = $3',
          [ctx.tenantId, String(req.params.id), String(req.params.attId)]
        );
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TASK_ATTACHMENT_DELETE_FAILED', err?.message || 'Không thể xóa tệp đính kèm.');
    }
  }
);

// Focus Sticky Pomodoro Session Logger
activitiesWorkspaceRouter.post(
  '/workspace/pomodoro',
  workspaceEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      const b = req.body || {};
      const durationMinutes = Math.max(1, Math.min(240, Math.round(Number(b.duration_minutes || 25))));
      const mode = ['focus', 'short_break', 'long_break'].includes(String(b.mode || ''))
        ? String(b.mode)
        : 'focus';
      const taskId = b.task_id ? String(b.task_id) : null;

      const created = await withTenantTransaction(ctx.tenantId, async (client) => {
        const sId = crypto.randomUUID();
        await client.query(
          `INSERT INTO tenant_pomodoro_sessions (
             id, tenant_id, task_id, user_id, duration_minutes, mode, note, started_at, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
          [
            sId,
            ctx.tenantId,
            taskId,
            ctx.userId,
            durationMinutes,
            mode,
            b.note ? String(b.note) : null,
            b.started_at || new Date(Date.now() - durationMinutes * 60_000).toISOString(),
          ]
        );

        if (taskId && mode === 'focus') {
          await client.query(
            `UPDATE tenant_tasks
             SET logged_minutes = COALESCE(logged_minutes, 0) + $3,
                 updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND id = $2`,
            [ctx.tenantId, taskId, durationMinutes]
          );
        }

        const r = await client.query('SELECT * FROM tenant_pomodoro_sessions WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
          ctx.tenantId,
          sId,
        ]);
        return r.rows[0];
      });

      res.status(201).json({ success: true, data: created });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_POMODORO_LOG_FAILED', err?.message || 'Không thể lưu phiên Tập trung Pomodoro.');
    }
  }
);

// ============================================================================
// 3. TicketDrawer Support / SLA Tickets Endpoints
// ============================================================================
const ticketViewGuard = requireAnyPermission([
  ['helpdesk', 'view'],
  ['tickets_data', 'view'],
  ['leads', 'view'],
]);

const ticketEditGuard = requireAnyPermission([
  ['helpdesk', 'edit'],
  ['tickets_data', 'edit'],
  ['leads', 'edit'],
]);

activitiesWorkspaceRouter.post('/tickets', ticketEditGuard, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const b = req.body || {};
    const subject = String(b.subject || '').trim();
    if (!subject) {
      sendApiError(res, 400, 'INVALID_TICKET_SUBJECT', 'Vui lòng nhập tiêu đề phiếu hỗ trợ.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tkId = crypto.randomUUID();
      const code = `TK-${Date.now().toString().slice(-6)}`;
      const slaRespHours = Math.max(0.5, Number(b.sla_response_hours || 2));
      const slaResoHours = Math.max(1, Number(b.sla_resolution_hours || 24));
      const respDue = new Date(Date.now() + slaRespHours * 3600_000).toISOString();
      const resoDue = new Date(Date.now() + slaResoHours * 3600_000).toISOString();
      const priority = ['low', 'medium', 'high', 'urgent'].includes(String(b.priority || ''))
        ? String(b.priority)
        : 'medium';

      await client.query(
        `INSERT INTO tenant_helpdesk_tickets (
           id, tenant_id, ticket_code, subject, description, category, priority, status,
           lead_id, customer_name, customer_contact, assignee_user_id, created_by_user_id,
           sla_response_hours, sla_resolution_hours, response_due_at, resolution_due_at, attachments_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'open',
           $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17
         )`,
        [
          tkId,
          ctx.tenantId,
          code,
          subject.slice(0, 255),
          b.description ? String(b.description) : null,
          String(b.category || 'customer_support'),
          priority,
          b.lead_id || null,
          b.customer_name ? String(b.customer_name) : null,
          b.customer_contact ? String(b.customer_contact) : null,
          b.assignee_user_id || ctx.userId,
          ctx.userId,
          slaRespHours,
          slaResoHours,
          respDue,
          resoDue,
          JSON.stringify(Array.isArray(b.attachments_json) ? b.attachments_json : []),
        ]
      );
      const r = await client.query('SELECT * FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        tkId,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CRM_TICKET_CREATE_FAILED', err?.message || 'Không thể tạo phiếu hỗ trợ.');
  }
});

activitiesWorkspaceRouter.get('/tickets/:id', ticketViewGuard, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const tkId = String(req.params.id || '').trim();
    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { canUnmaskLeads, tenantSettings } = await resolveCrmActorContext(
        client,
        ctx.tenantId,
        ctx.userId
      );
      const tkRes = await client.query<Record<string, any>>(
        `SELECT tk.*, u.full_name AS assignee_name, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
         FROM tenant_helpdesk_tickets tk
         LEFT JOIN users u ON u.tenant_id = tk.tenant_id AND u.id = tk.assignee_user_id
         LEFT JOIN leads l ON l.tenant_id = tk.tenant_id AND l.id = tk.lead_id
         WHERE tk.tenant_id = $1 AND tk.id = $2
         LIMIT 1`,
        [ctx.tenantId, tkId]
      );
      if (tkRes.rows.length === 0) return null;
      const tk = tkRes.rows[0];

      const commentsRes = await client.query(
        'SELECT * FROM tenant_helpdesk_comments WHERE tenant_id = $1 AND ticket_id = $2 ORDER BY created_at ASC',
        [ctx.tenantId, tkId]
      );

      const maskedLead = maskContactPiiIfDisallowed(
        { phone: tk.lead_phone, email: tk.lead_email },
        canUnmaskLeads,
        parseJsonSafe(tenantSettings, {})
      );

      return {
        ticket: {
          ...tk,
          lead_phone: maskedLead.phone,
          lead_email: maskedLead.email,
          attachments_json: parseJsonSafe(tk.attachments_json, []),
        },
        comments: commentsRes.rows,
      };
    });

    if (!data) {
      sendApiError(res, 404, 'TICKET_NOT_FOUND', 'Không tìm thấy phiếu hỗ trợ.');
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'CRM_TICKET_GET_FAILED', err?.message || 'Không thể tải chi tiết phiếu hỗ trợ.');
  }
});

activitiesWorkspaceRouter.put('/tickets/:id', ticketEditGuard, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const tkId = String(req.params.id || '').trim();
    const b = req.body || {};

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query<Record<string, any>>(
        'SELECT * FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2 LIMIT 1',
        [ctx.tenantId, tkId]
      );
      if (curRes.rows.length === 0) return null;
      const cur = curRes.rows[0];
      const nextStatus = b.status !== undefined ? String(b.status) : cur.status;
      const nextPriority = b.priority !== undefined ? String(b.priority) : cur.priority;

      await client.query(
        `UPDATE tenant_helpdesk_tickets
         SET subject = $3,
             description = $4,
             category = $5,
             priority = $6,
             status = $7,
             assignee_user_id = $8,
             resolved_at = CASE WHEN $7 IN ('resolved', 'closed') AND resolved_at IS NULL THEN clock_timestamp() ELSE resolved_at END,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [
          ctx.tenantId,
          tkId,
          b.subject !== undefined ? String(b.subject).trim().slice(0, 255) : cur.subject,
          b.description !== undefined ? b.description || null : cur.description,
          b.category !== undefined ? String(b.category) : cur.category,
          nextPriority,
          nextStatus,
          b.assignee_user_id !== undefined ? b.assignee_user_id || null : cur.assignee_user_id,
        ]
      );
      const r = await client.query('SELECT * FROM tenant_helpdesk_tickets WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        tkId,
      ]);
      return r.rows[0];
    });

    if (!updated) {
      sendApiError(res, 404, 'TICKET_NOT_FOUND', 'Không tìm thấy phiếu hỗ trợ.');
      return;
    }
    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendApiError(res, 500, 'CRM_TICKET_UPDATE_FAILED', err?.message || 'Không thể cập nhật phiếu hỗ trợ.');
  }
});

activitiesWorkspaceRouter.post('/tickets/:id/comments', ticketEditGuard, async (req, res) => {
  try {
    const ctx = getTenantContext();
    const tkId = String(req.params.id || '').trim();
    const content = String(req.body?.content || '').trim();
    if (!content) {
      sendApiError(res, 400, 'EMPTY_TICKET_COMMENT', 'Nội dung phản hồi không được để trống.');
      return;
    }

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      const { actorName } = await resolveCrmActorContext(client, ctx.tenantId, ctx.userId);
      const cmId = crypto.randomUUID();
      await client.query(
        `INSERT INTO tenant_helpdesk_comments (
           id, tenant_id, ticket_id, author_user_id, author_name, content, is_internal_note
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [cmId, ctx.tenantId, tkId, ctx.userId, actorName, content, Boolean(req.body?.is_internal_note)]
      );
      await client.query(
        `UPDATE tenant_helpdesk_tickets
         SET first_responded_at = COALESCE(first_responded_at, clock_timestamp()),
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, tkId]
      );
      const r = await client.query('SELECT * FROM tenant_helpdesk_comments WHERE tenant_id = $1 AND id = $2 LIMIT 1', [
        ctx.tenantId,
        cmId,
      ]);
      return r.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    sendApiError(res, 500, 'CRM_TICKET_COMMENT_FAILED', err?.message || 'Không thể gửi phản hồi phiếu hỗ trợ.');
  }
});

activitiesWorkspaceRouter.delete(
  '/tickets/:id/comments/:commentId',
  ticketEditGuard,
  async (req, res) => {
    try {
      const ctx = getTenantContext();
      await withTenantTransaction(ctx.tenantId, async (client) => {
        await client.query(
          'DELETE FROM tenant_helpdesk_comments WHERE tenant_id = $1 AND ticket_id = $2 AND id = $3',
          [ctx.tenantId, String(req.params.id), String(req.params.commentId)]
        );
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (err: any) {
      sendApiError(res, 500, 'CRM_TICKET_COMMENT_DELETE_FAILED', err?.message || 'Không thể xóa phản hồi.');
    }
  }
);
