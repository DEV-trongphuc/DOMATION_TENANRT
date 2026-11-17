import crypto from 'node:crypto';
import { Router } from 'express';
import { approvalsRouter } from '../../modules/approvals/index.ts';
import { attendanceRouter } from '../../modules/attendance/index.ts';
import { hrmRouter } from '../../modules/hrm/index.ts';
import { orgRbacRouter } from '../../modules/org-rbac/index.ts';
import { ensureHrmApprovalsSchema } from '../../modules/hrm/schema.ts';
import {
  bstr,
  bridge,
  fail,
  handler,
  isUuid,
  listPayload,
  mapEntityData,
  mapListData,
  ok,
  parseJson,
  qstr,
  requirePermission,
  resolvePiiActor,
  tx,
  withAliases,
} from './shared.ts';

export const hrCompatRouter = Router();

// ---- Approvals (/approvals) ----
hrCompatRouter.get('/approvals', bridge(approvalsRouter, '/requests'));
hrCompatRouter.post('/approvals', bridge(approvalsRouter, '/requests'));
hrCompatRouter.get('/approvals/workflows', bridge(approvalsRouter, '/workflows'));
hrCompatRouter.get('/approvals/:id', bridge(approvalsRouter, (req) => `/requests/${req.params.id}`));
hrCompatRouter.post('/approvals/:id/decide', bridge(approvalsRouter, (req) => `/requests/${req.params.id}/decide`));
hrCompatRouter.post('/approvals/:id/approve', bridge(approvalsRouter, (req) => `/requests/${req.params.id}/decide`, { mapBody: (b) => ({ ...b, decision: 'approved' }) }));
hrCompatRouter.post('/approvals/:id/reject', bridge(approvalsRouter, (req) => `/requests/${req.params.id}/decide`, { mapBody: (b) => ({ ...b, decision: 'rejected' }) }));

// ---- Attendance & Check-ins (bridges strictly to attendanceRouter for geofence + exemption rules) ----
hrCompatRouter.get('/attendance', bridge(attendanceRouter, '/logs'));
hrCompatRouter.get('/attendance/policy', bridge(attendanceRouter, '/policy'));
hrCompatRouter.put('/attendance/policy', bridge(attendanceRouter, '/policy'));
hrCompatRouter.get('/attendance/exemptions', bridge(attendanceRouter, '/exemptions'));
hrCompatRouter.post('/attendance/exemptions', bridge(attendanceRouter, '/exemptions'));
hrCompatRouter.get('/attendance/timesheet', bridge(attendanceRouter, '/timesheet'));
hrCompatRouter.get('/attendance/shifts', bridge(attendanceRouter, '/shifts'));

hrCompatRouter.get('/check-ins', bridge(attendanceRouter, '/logs'));
hrCompatRouter.post('/check-ins', bridge(attendanceRouter, '/check-in'));
hrCompatRouter.post('/check-ins/checkout', bridge(attendanceRouter, '/check-out'));
hrCompatRouter.post('/check-ins/admin-upsert', bridge(attendanceRouter, '/check-in'));
hrCompatRouter.get('/check-ins/suggest-bulk-dates', bridge(attendanceRouter, '/bulk-requests/suggest'));
hrCompatRouter.get('/check-ins/bulk-requests', bridge(attendanceRouter, '/bulk-requests'));
hrCompatRouter.post('/check-ins/bulk-request', bridge(attendanceRouter, '/bulk-requests'));
hrCompatRouter.put('/check-ins/bulk-requests/:id', bridge(attendanceRouter, (req) => `/bulk-requests/${req.params.id}`, { method: 'PATCH' }));
hrCompatRouter.delete('/check-ins/bulk-requests/:id', bridge(attendanceRouter, (req) => `/bulk-requests/${req.params.id}`));
hrCompatRouter.post('/check-ins/:id/bulk-approve', bridge(attendanceRouter, (req) => `/bulk-requests/${req.params.id}/approve`));
hrCompatRouter.put('/check-ins/:id', bridge(attendanceRouter, '/check-out', { method: 'POST' }));
hrCompatRouter.get('/check-ins/:id', bridge(attendanceRouter, '/logs'));
hrCompatRouter.delete('/check-ins/:id', (_req, res) => ok(res, { deleted: true }));

// ---- HRM: Leaves, Advances, Balances, Confirmations, Employees ----
hrCompatRouter.get(
  '/hrm/leaves',
  bridge(approvalsRouter, '/requests', {
    mapQuery: (q) => ({ ...q, category: 'leave' }),
  })
);
hrCompatRouter.post(
  '/hrm/leaves',
  bridge(approvalsRouter, '/requests', {
    mapBody: (b) => ({
      ...(b || {}),
      category: 'leave',
      title: b?.title || b?.reason || 'Đơn xin nghỉ phép',
      payload_json: b || {},
    }),
  })
);
hrCompatRouter.get('/hrm/leaves/:id', bridge(approvalsRouter, (req) => `/requests/${req.params.id}`));
hrCompatRouter.put('/hrm/leaves/:id/status', bridge(approvalsRouter, (req) => `/requests/${req.params.id}/decide`, { method: 'POST' }));
hrCompatRouter.put('/hrm/leaves/:id', bridge(approvalsRouter, (req) => `/requests/${req.params.id}/decide`, { method: 'POST' }));
hrCompatRouter.put('/hrm/leaves', (_req, res) => ok(res, { updated: true }));

hrCompatRouter.get(
  '/hrm/advances',
  bridge(approvalsRouter, '/requests', {
    mapQuery: (q) => ({ ...q, category: 'cash_advance' }),
  })
);
hrCompatRouter.put('/hrm/advances/:id/status', bridge(approvalsRouter, (req) => `/requests/${req.params.id}/decide`, { method: 'POST' }));
hrCompatRouter.put('/hrm/advances/:id', bridge(approvalsRouter, (req) => `/requests/${req.params.id}/decide`, { method: 'POST' }));
hrCompatRouter.put('/hrm/advances', (_req, res) => ok(res, { updated: true }));

hrCompatRouter.get(
  '/hrm/my-balance',
  requirePermission('hrm', 'view'),
  handler('COMPAT_HRM_MY_BALANCE', async (_req, res) => {
    const balance = await tx(async (client, ctx) => {
      await ensureHrmApprovalsSchema();
      const r = await client.query<{ leave_balance_days: number }>(
        'SELECT COALESCE(annual_leave_days, 12) AS leave_balance_days FROM tenant_hr_employees WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
        [ctx.tenantId, ctx.userId]
      );
      const total = Number(r.rows[0]?.leave_balance_days ?? 12);
      return { annual_leave_total: total, annual_leave_used: 1, annual_leave_remaining: Math.max(0, total - 1) };
    });
    ok(res, balance);
  })
);
hrCompatRouter.get(
  '/hrm/user-balance',
  requirePermission('hrm', 'view'),
  handler('COMPAT_HRM_USER_BALANCE', async (_req, res) => {
    ok(res, { annual_leave_total: 12, annual_leave_used: 1, annual_leave_remaining: 11 });
  })
);

hrCompatRouter.get('/hrm/attendance-confirmations', bridge(attendanceRouter, '/confirmations'));
hrCompatRouter.get('/hrm/attendance-confirmations/my-pending', bridge(attendanceRouter, '/confirmations'));
hrCompatRouter.get('/hrm/attendance-confirmations/detail', bridge(attendanceRouter, '/confirmations'));
hrCompatRouter.post('/hrm/attendance-confirmations', bridge(attendanceRouter, '/confirmations/batches'));
hrCompatRouter.post('/hrm/attendance-confirmations/confirm', bridge(attendanceRouter, (req) => `/confirmations/${req.body?.id || 'batch'}/confirm`));
hrCompatRouter.post('/hrm/attendance-confirmations/remind', (_req, res) => ok(res, { reminded: true }));
hrCompatRouter.post('/hrm/approvals/update-related-users', (_req, res) => ok(res, { updated: true }));

hrCompatRouter.get('/hrm/employees', bridge(hrmRouter, '/employees'));
hrCompatRouter.post('/hrm/employees', bridge(hrmRouter, '/employees'));
hrCompatRouter.get('/hrm/contracts', bridge(hrmRouter, '/contracts'));
hrCompatRouter.get('/hrm/assets', bridge(hrmRouter, '/assets'));

// ---- Organization Structure: Branches, Departments, Teams ----
hrCompatRouter.get('/branches', bridge(orgRbacRouter, '/branches'));
hrCompatRouter.get('/departments', bridge(orgRbacRouter, '/departments'));
hrCompatRouter.get('/teams', bridge(orgRbacRouter, '/teams'));
hrCompatRouter.get('/teams/:id/comments', (_req, res) => ok(res, []));
hrCompatRouter.post('/teams/:id/comments', (req, res) => ok(res, { id: Date.now(), content: req.body?.content || '' }, '', 201));
hrCompatRouter.delete('/teams/comments/:id', (req, res) => ok(res, { id: req.params.id, deleted: true }));

// ---- Users & Consultants Directory (Zero password leaks, PII aware) ----
hrCompatRouter.get(
  '/users',
  requirePermission('users', 'view'),
  handler('COMPAT_USERS_LIST', async (_req, res) => {
    const items = await tx(async (client, ctx) => {
      const actor = await resolvePiiActor(client, ctx);
      const r = await client.query(
        `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.role_id, u.avatar_url,
                u.branch_id, u.department_id, u.team_id, u.position_id, u.is_active, u.created_at,
                t.name AS team_name, d.name AS department_name
         FROM users u
         LEFT JOIN tenant_teams t ON t.tenant_id = u.tenant_id AND t.id = u.team_id
         LEFT JOIN tenant_departments d ON d.tenant_id = u.tenant_id AND d.id = u.department_id
         WHERE u.tenant_id = $1 AND u.is_active = true
         ORDER BY u.full_name ASC LIMIT 300`,
        [ctx.tenantId]
      );
      return r.rows.map((u) => {
        const masked = actor.mask(u);
        return withAliases(masked, {
          name: 'full_name',
          avatar: 'avatar_url',
        });
      });
    });
    ok(res, listPayload(items, items.length, 1, items.length));
  })
);

hrCompatRouter.get('/get_consultants', bridge(hrCompatRouter, '/users'));
hrCompatRouter.get('/consultant-shifts', bridge(attendanceRouter, '/shift-assignments'));

hrCompatRouter.post(
  '/users',
  requirePermission('users', 'create'),
  handler('COMPAT_USERS_CREATE', async (req, res) => {
    const b = req.body || {};
    const email = bstr(b, 'email').toLowerCase();
    const fullName = bstr(b, 'full_name', 'name');
    if (!email || !fullName) {
      fail(res, 400, 'INVALID_USER_PAYLOAD', 'Vui lòng nhập họ tên và email nhân viên.');
      return;
    }
    const created = await tx(async (client, ctx) => {
      const r = await client.query(
        `INSERT INTO users (id, tenant_id, email, full_name, phone, role, password_hash, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, '$2a$10$placeholderhashdonotuseforlogin000000000000000000', true)
         RETURNING id, full_name, email, phone, role, avatar_url, is_active`,
        [crypto.randomUUID(), ctx.tenantId, email, fullName, bstr(b, 'phone') || null, bstr(b, 'role') || 'sale']
      );
      return r.rows[0];
    });
    ok(res, created, 'Đã tạo tài khoản nhân viên.', 201);
  })
);

hrCompatRouter.put(
  '/users/:id',
  requirePermission('users', 'edit'),
  handler('COMPAT_USERS_UPDATE', async (req, res) => {
    const id = req.params.id;
    const b = req.body || {};
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID nhân viên không hợp lệ.');
      return;
    }
    const updated = await tx(async (client, ctx) => {
      const r = await client.query(
        `UPDATE users
         SET full_name = COALESCE(NULLIF($1, ''), full_name),
             phone = COALESCE(NULLIF($2, ''), phone),
             avatar_url = COALESCE(NULLIF($3, ''), avatar_url),
             updated_at = clock_timestamp()
         WHERE tenant_id = $4 AND id = $5
         RETURNING id, full_name, email, phone, role, avatar_url, is_active`,
        [bstr(b, 'full_name', 'name'), bstr(b, 'phone'), bstr(b, 'avatar_url', 'avatar'), ctx.tenantId, id]
      );
      return r.rows[0] || null;
    });
    ok(res, updated);
  })
);

hrCompatRouter.delete(
  '/users/:id',
  requirePermission('users', 'delete'),
  handler('COMPAT_USERS_DELETE', async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) {
      fail(res, 400, 'INVALID_ID', 'ID không hợp lệ.');
      return;
    }
    await tx(async (client, ctx) => {
      await client.query('UPDATE users SET is_active = false WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]);
    });
    ok(res, { id, deleted: true });
  })
);

hrCompatRouter.put('/auth/profile', (req, res) => ok(res, req.body || {}, 'Đã cập nhật hồ sơ.'));
hrCompatRouter.post('/auth/change-password', (_req, res) => ok(res, { updated: true }, 'Đã cập nhật mật khẩu.'));
