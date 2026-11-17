import { Router } from 'express';
import { APP_CONFIG } from '../config.ts';
import { hashPassword } from '../core/crypto/password.ts';
import { withTenantTransaction } from '../core/database/transaction.ts';
import { getTenantContext } from '../core/context/tenant-context.ts';
import { tenantRedis } from '../core/cache/tenant-redis.ts';
import { requireTenantAuth, requireRoles, sendApiError } from '../core/security/rbac.ts';
import { getTenantSettingsCached } from '../core/settings/tenant-cache.ts';
import {
  toggleSaleAdministrativeStatus,
  drainUnassignedLeads,
} from '../services/distribution.service.ts';
import { validateAndNormalizePhone } from '../services/phone.service.ts';
import { enforceTenantOperationalPolicy } from '../services/billing.service.ts';

export const usersRouter = Router();

usersRouter.use(requireTenantAuth);

// Lightweight Peer Directory for Lead Reassignment (accessible to Admin, Manager, or Sale when `allow_sale_reassign_lead` is enabled)
usersRouter.get('/peers', async (_req, res) => {
  try {
    const ctx = getTenantContext();
    if (ctx.userRole !== 'tenant_admin' && ctx.userRole !== 'manager') {
      const cfg = await getTenantSettingsCached(ctx.tenantId);
      if (!cfg.role_permissions.allow_sale_reassign_lead) {
        sendApiError(res, 403, 'FORBIDDEN_ROLE', 'Tài khoản của bạn chưa được cấp quyền điều chuyển Lead.');
        return;
      }
    }

    const items = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query(
        `SELECT u.id, u.full_name, u.email, u.role, u.is_external_agency,
                COALESCE(p.status, 'active') AS status,
                COALESCE(p.is_available, true) AS is_available,
                COALESCE(p.vacation_mode, false) AS vacation_mode
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         WHERE u.tenant_id = $1 AND COALESCE(p.status, 'active') = 'active'
         ORDER BY u.created_at ASC`,
        [ctx.tenantId]
      );

      return r.rows.map((row) => ({
        id: row.id,
        full_name: row.full_name,
        email: row.email,
        role: row.role,
        is_external_agency: row.is_external_agency,
        total_assigned_leads: 0,
        round_quota: {
          receive_ratio: 1,
          data_per_turn: 1,
          leads_received_in_round: 0,
          compensation_count: 0,
        },
        profile: {
          status: row.status,
          is_available: row.is_available,
          vacation_mode: row.vacation_mode,
          skipped_credit: 0,
        },
      }));
    });

    res.json({ success: true, data: { items } });
  } catch (err: any) {
    if (err?.message === 'FORBIDDEN_ROLE') {
      sendApiError(res, 403, 'FORBIDDEN_ROLE', 'Tài khoản của bạn chưa được cấp quyền điều chuyển Lead.');
      return;
    }
    sendApiError(res, 500, 'LIST_PEERS_FAILED', err?.message || 'Không thể tải danh sách đồng nghiệp.');
  }
});

// 3.1 List Tenant Staff Roster (Single Hash-Aggregate Pass — Zero Correlated Subqueries)
usersRouter.get('/', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const tenantCfg = await getTenantSettingsCached(ctx.tenantId);
    const roleFilter = req.query.role ? String(req.query.role) : null;
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(tenantCfg.max_page_size || 200, Math.max(1, Number(req.query.limit || 50)));
    const offset = (page - 1) * limit;

    const data = await withTenantTransaction(ctx.tenantId, async (client) => {
      const params: unknown[] = [ctx.tenantId];
      let where = 'u.tenant_id = $1';
      if (roleFilter) {
        params.push(roleFilter);
        where += ` AND u.role = $${params.length}`;
      }
      if (statusFilter) {
        params.push(statusFilter);
        where += ` AND p.status = $${params.length}`;
      }

      const countRes = await client.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total
         FROM users u
         LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
         WHERE ${where}`,
        params
      );

      params.push(limit, offset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;
      const rowsRes = await client.query(
        `WITH page_users AS (
           SELECT
             u.id, u.full_name, u.email, u.phone, u.role, u.is_external_agency, u.created_at,
             p.status, p.is_available, p.vacation_mode, p.skipped_credit, p.work_schedule, p.zalo_chat_id,
             p.is_silent, p.invite_status, p.sheet_sync_url, p.sheet_tab_name
           FROM users u
           LEFT JOIN tenant_user_profiles p ON p.tenant_id = u.tenant_id AND p.user_id = u.id
           WHERE ${where}
           ORDER BY u.created_at ASC
           LIMIT $${limitIdx} OFFSET $${offsetIdx}
         ),
         rc_agg AS (
           SELECT
             rc.user_id,
             (ARRAY_AGG(rc.receive_ratio ORDER BY rc.created_at ASC))[1] AS receive_ratio,
             (ARRAY_AGG(rc.data_per_turn ORDER BY rc.created_at ASC))[1] AS data_per_turn,
             COALESCE(SUM(rc.leads_received_in_round), 0)::int AS leads_received_in_round,
             COALESCE(SUM(rc.compensation_count), 0)::int AS compensation_count
           FROM round_consultants rc
           WHERE rc.tenant_id = $1 AND rc.user_id IN (SELECT id FROM page_users)
           GROUP BY rc.user_id
         ),
         lead_agg AS (
           SELECT
             l.assigned_to AS user_id,
             COUNT(*)::int AS total_assigned_leads
           FROM leads l
           WHERE l.tenant_id = $1 AND l.assigned_to IN (SELECT id FROM page_users) AND l.is_deleted = false
           GROUP BY l.assigned_to
         ),
         cm_agg AS (
           SELECT
             cm.consultant_user_id AS user_id,
             COUNT(*)::int AS co_managers_count
           FROM consultant_managers cm
           WHERE cm.tenant_id = $1 AND cm.consultant_user_id IN (SELECT id FROM page_users)
           GROUP BY cm.consultant_user_id
         )
         SELECT
           pu.id, pu.full_name, pu.email, pu.phone, pu.role, pu.is_external_agency, pu.created_at,
           pu.status, pu.is_available, pu.vacation_mode, pu.skipped_credit, pu.work_schedule, pu.zalo_chat_id,
           pu.is_silent, pu.invite_status, pu.sheet_sync_url, pu.sheet_tab_name,
           COALESCE(rc_agg.receive_ratio, 1) AS receive_ratio,
           COALESCE(rc_agg.data_per_turn, 1) AS data_per_turn,
           COALESCE(rc_agg.leads_received_in_round, 0) AS leads_received_in_round,
           COALESCE(rc_agg.compensation_count, 0) AS compensation_count,
           COALESCE(lead_agg.total_assigned_leads, 0) AS total_assigned_leads,
           COALESCE(cm_agg.co_managers_count, 0) AS co_managers_count
         FROM page_users pu
         LEFT JOIN rc_agg ON rc_agg.user_id = pu.id
         LEFT JOIN lead_agg ON lead_agg.user_id = pu.id
         LEFT JOIN cm_agg ON cm_agg.user_id = pu.id
         ORDER BY pu.created_at ASC`,
        params
      );

      const items = rowsRes.rows.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        email: r.email,
        phone: r.phone,
        role: r.role,
        is_external_agency: r.is_external_agency,
        total_assigned_leads: r.total_assigned_leads,
        co_managers_count: r.co_managers_count || 0,
        round_quota: {
          receive_ratio: r.receive_ratio,
          data_per_turn: r.data_per_turn,
          leads_received_in_round: r.leads_received_in_round,
          compensation_count: r.compensation_count,
        },
        profile: {
          status: r.status || 'active',
          is_available: r.is_available ?? true,
          vacation_mode: r.vacation_mode ?? false,
          skipped_credit: r.skipped_credit ?? 0,
          work_schedule: r.work_schedule,
          zalo_chat_id: r.zalo_chat_id,
          is_silent: Boolean(r.is_silent),
          invite_status: r.invite_status || 'joined',
          sheet_sync_url: r.sheet_sync_url || null,
          sheet_tab_name: r.sheet_tab_name || null,
        },
      }));

      const total = countRes.rows[0]?.total || 0;
      return {
        items,
        pagination: {
          total,
          page,
          total_pages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    });

    res.json({ success: true, data });
  } catch (err: any) {
    sendApiError(res, 500, 'LIST_USERS_FAILED', err?.message || 'Không thể tải danh sách nhân sự.');
  }
});

// Op 06 & Op 07: Create Manager / Sale / External Agency Account
usersRouter.post('/', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const {
      full_name,
      email,
      phone,
      password,
      role = 'sale',
      is_external_agency = false,
      receive_ratio = 1,
      data_per_turn = 1,
      is_available = true,
      work_schedule,
      zalo_chat_id,
    } = req.body || {};

    // Strict RBAC Matrix Op 05 & Op 06 enforcement:
    // - Nobody in tenant space can create `tenant_admin` via staff endpoint (Op 05)
    // - `manager` can ONLY create `sale` accounts, never `manager` or `tenant_admin` (Op 06)
    if (role !== 'sale' && role !== 'manager') {
      sendApiError(res, 403, 'FORBIDDEN_ROLE_ASSIGNMENT', 'Chỉ được phép tạo tài khoản Sale/Đại lý hoặc Quản lý (Manager).');
      return;
    }
    if (ctx.userRole === 'manager' && role !== 'sale') {
      sendApiError(res, 403, 'FORBIDDEN_MANAGER_CREATE_MANAGER', 'Quản lý (Manager) chỉ được phép tạo tài khoản Sale / Đại lý.');
      return;
    }

    const cleanName = String(full_name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!cleanName || !cleanEmail) {
      sendApiError(res, 422, 'VALIDATION_ERROR', 'Họ tên và Email nhân sự là bắt buộc.');
      return;
    }

    const tenantCfg = await getTenantSettingsCached(ctx.tenantId);

    const rawPass = String(password || tenantCfg.default_staff_password || 'Sale@123456');

    let normalizedPhone: string | null = null;
    if (phone && String(phone).trim()) {
      const pCheck = validateAndNormalizePhone(String(phone), {
        default_dial_code: tenantCfg.default_dial_code,
        allow_international_phones: tenantCfg.allow_international_phones,
        allow_landline_phones: tenantCfg.allow_landline_phones,
        vn_mobile_prefixes: tenantCfg.vn_mobile_prefixes,
        custom_phone_regex: tenantCfg.custom_phone_regex,
        block_repeated_digits: tenantCfg.block_repeated_digits,
      });
      if (!pCheck.valid) {
        sendApiError(res, 422, 'INVALID_PHONE', pCheck.reason || 'Số điện thoại không hợp lệ.');
        return;
      }
      normalizedPhone = pCheck.normalizedE164;
    }

    const passwordHash = await hashPassword(rawPass, APP_CONFIG.bcryptRounds);

    const created = await withTenantTransaction(ctx.tenantId, async (client) => {
      await enforceTenantOperationalPolicy(client, ctx.tenantId, 'create_user');

      const dup = await client.query('SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 LIMIT 1', [
        ctx.tenantId,
        cleanEmail,
      ]);
      if (dup.rows.length > 0) {
        throw new Error('EMAIL_ALREADY_EXISTS');
      }

      const uRes = await client.query<{
        id: string;
        full_name: string;
        email: string;
        phone: string | null;
        role: string;
        is_external_agency: boolean;
      }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, phone, role, is_external_agency)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, full_name, email, phone, role, is_external_agency`,
        [ctx.tenantId, cleanEmail, passwordHash, cleanName, normalizedPhone, role, Boolean(is_external_agency)]
      );
      const newUser = uRes.rows[0];

      if (work_schedule && typeof work_schedule === 'object') {
        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, work_schedule, zalo_chat_id)
           VALUES ($1, $2, 'active', $3, false, $4::jsonb, $5)`,
          [
            ctx.tenantId,
            newUser.id,
            is_available !== false,
            JSON.stringify(work_schedule),
            zalo_chat_id ? String(zalo_chat_id).trim() : null,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode, zalo_chat_id)
           VALUES ($1, $2, 'active', $3, false, $4)`,
          [
            ctx.tenantId,
            newUser.id,
            is_available !== false,
            zalo_chat_id ? String(zalo_chat_id).trim() : null,
          ]
        );
      }

      // Attach to default active distribution round if role === 'sale'
      if (role === 'sale') {
        const roundRes = await client.query<{ id: string }>(
          'SELECT id FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC LIMIT 1',
          [ctx.tenantId]
        );
        if (roundRes.rows[0]?.id) {
          await client.query(
            `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, round_id, user_id)
             DO UPDATE SET receive_ratio = EXCLUDED.receive_ratio, data_per_turn = EXCLUDED.data_per_turn`,
            [
              ctx.tenantId,
              roundRes.rows[0].id,
              newUser.id,
              Math.max(1, Math.round(Number(receive_ratio || 1))),
              Math.max(1, Math.round(Number(data_per_turn || 1))),
            ]
          );
        }
      }

      return newUser;
    });

    tenantRedis.setCachedUserAuth(ctx.tenantId, created.id, {
      role: created.role as 'tenant_admin' | 'manager' | 'sale',
      isExternalAgency: Boolean(created.is_external_agency),
    });

    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('SUBSCRIPTION_EXPIRED')) {
      sendApiError(res, 402, 'SUBSCRIPTION_EXPIRED', msg);
      return;
    }
    if (msg.startsWith('PLAN_QUOTA_EXCEEDED')) {
      sendApiError(res, 402, 'PLAN_QUOTA_EXCEEDED', msg);
      return;
    }
    if (msg === 'EMAIL_ALREADY_EXISTS') {
      sendApiError(res, 409, 'EMAIL_ALREADY_EXISTS', 'Email nhân sự này đã tồn tại trong doanh nghiệp.');
      return;
    }
    sendApiError(res, 500, 'CREATE_USER_FAILED', msg || 'Không thể tạo nhân sự mới.');
  }
});

// 3.3 Sale Self-Service Operational Availability Toggle (`PATCH /users/me/availability`)
usersRouter.patch('/me/availability', async (req, res) => {
  try {
    const ctx = getTenantContext();
    const { is_available, vacation_mode, work_schedule, zalo_chat_id } = req.body || {};

    const outcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const curRes = await client.query<{
        status: string;
        is_available: boolean;
        vacation_mode: boolean;
      }>(
        `SELECT status, is_available, vacation_mode
         FROM tenant_user_profiles
         WHERE tenant_id = $1 AND user_id = $2
         FOR UPDATE`,
        [ctx.tenantId, ctx.userId]
      );

      if (!curRes.rows[0]) {
        await client.query(
          `INSERT INTO tenant_user_profiles (tenant_id, user_id, status, is_available, vacation_mode)
           VALUES ($1, $2, 'active', true, false)`,
          [ctx.tenantId, ctx.userId]
        );
      } else if (curRes.rows[0].status !== 'active') {
        throw new Error('ADMIN_STATUS_INACTIVE');
      }

      const nextAvailable = typeof is_available === 'boolean' ? is_available : (curRes.rows[0]?.is_available ?? true);
      const nextVacation = typeof vacation_mode === 'boolean' ? vacation_mode : (curRes.rows[0]?.vacation_mode ?? false);

      await client.query(
        `UPDATE tenant_user_profiles
         SET is_available = $3,
             vacation_mode = $4,
             work_schedule = COALESCE($5::jsonb, work_schedule),
             zalo_chat_id = CASE WHEN $6::boolean THEN $7 ELSE zalo_chat_id END
         WHERE tenant_id = $1 AND user_id = $2`,
        [
          ctx.tenantId,
          ctx.userId,
          nextAvailable,
          nextVacation,
          work_schedule ? JSON.stringify(work_schedule) : null,
          zalo_chat_id !== undefined,
          zalo_chat_id ? String(zalo_chat_id).trim() : null,
        ]
      );

      // If toggling offline or into vacation_mode, auto-recall unaccepted leads & cancel running SLA timers
      let recalledCount = 0;
      const slaMembersToCancel: string[] = [];
      if (!nextAvailable || nextVacation) {
        const unacc = await client.query<{ id: string; stage_id: string }>(
          `UPDATE leads
           SET status = 'recalled', assigned_to = NULL, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND assigned_to = $2 AND is_accepted = false AND status = 'assigned'
           RETURNING id, stage_id`,
          [ctx.tenantId, ctx.userId]
        );
        recalledCount = unacc.rows.length;
        if (recalledCount > 0) {
          for (const r of unacc.rows) {
            slaMembersToCancel.push(`${r.id}:${r.stage_id}`);
          }
          await client.query(
            `INSERT INTO lead_timeline_events (
              tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
            )
            SELECT $1, unnest($2::uuid[]), 'self_offline_recall', 'system', $3, $4, $5, $6, $7, '{}'::jsonb`,
            [
              ctx.tenantId,
              unacc.rows.map((r) => r.id),
              ctx.userId,
              ctx.userRole,
              ctx.userName || 'Sale',
              'AUTO_RECALL: Hoàn trả lead chưa tiếp nhận khi Sale bật chế độ Tạm nghỉ / Offline',
              nextVacation ? 'Sale bật chế độ Nghỉ phép (Vacation Mode)' : 'Sale tắt công tắc nhận số',
            ]
          );
        }
      }

      return { nextAvailable, nextVacation, recalledCount, slaMembersToCancel };
    });

    for (const member of outcome.slaMembersToCancel) {
      await tenantRedis.zrem('sla_queue', member, ctx.tenantId);
    }

    // If Sale toggled BACK online (`is_available = true && !vacation_mode`), drain unassigned queue (if enabled in settings)!
    let drainedCount = 0;
    if (outcome.nextAvailable && !outcome.nextVacation) {
      drainedCount = await drainUnassignedLeads(ctx.tenantId, ctx.userId, ctx.userName || 'Sale');
    }

    res.json({
      success: true,
      data: {
        is_available: outcome.nextAvailable,
        vacation_mode: outcome.nextVacation,
        unaccepted_leads_recalled: outcome.recalledCount,
        pending_leads_drained: drainedCount,
      },
    });
  } catch (err: any) {
    if (err?.message === 'ADMIN_STATUS_INACTIVE') {
      sendApiError(res, 403, 'ACCOUNT_INACTIVE', 'Tài khoản đang bị Quản trị viên tạm khóa, không thể bật nhận data.');
      return;
    }
    sendApiError(res, 500, 'AVAILABILITY_TOGGLE_FAILED', err?.message || 'Không thể cập nhật trạng thái nhận số.');
  }
});

// 3.2 Update Sale Administrative Status (Master Toggle Switch + Session Blacklist)
usersRouter.post('/:id/admin-status', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const targetUserId = req.params.id;
    const {
      status,
      reassignment_mode = 'retain',
      target_user_id,
      reason,
    } = req.body || {};

    if (!['active', 'inactive', 'suspended', 'terminated'].includes(status)) {
      sendApiError(res, 422, 'INVALID_STATUS', 'Trạng thái quản trị không hợp lệ.');
      return;
    }

    if (targetUserId === ctx.userId && status !== 'active') {
      sendApiError(res, 422, 'CANNOT_DEACTIVATE_SELF', 'Không thể tự khóa tài khoản quản trị của chính bạn.');
      return;
    }

    const result = await toggleSaleAdministrativeStatus({
      tenantId: ctx.tenantId,
      targetUserId,
      newStatus: status,
      reassignmentMode: reassignment_mode,
      transferToUserId: target_user_id || undefined,
      reason,
      actorId: ctx.userId,
      actorRole: ctx.userRole,
      actorName: ctx.userName || 'Admin',
    });

    res.json({
      success: true,
      data: {
        user_id: targetUserId,
        previous_status: result.previousStatus,
        new_status: result.newStatus,
        leads_recalled: result.leadsRecalled,
        leads_transferred: result.leadsTransferred,
        session_revoked: result.sessionRevoked,
      },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'ADMIN_STATUS_TOGGLE_FAILED', err?.message || 'Không thể cập nhật trạng thái nhân sự.');
  }
});

// Update Consultant Profile, Operational Toggles (by Admin/Manager), Work Schedule, Ratio & Batch Turn
usersRouter.patch('/:id', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const targetUserId = req.params.id;
    const {
      full_name,
      email,
      phone,
      role,
      password,
      is_external_agency,
      is_available,
      vacation_mode,
      skipped_credit,
      work_schedule,
      zalo_chat_id,
      is_silent,
      sheet_sync_url,
      sheet_tab_name,
      receive_ratio,
      data_per_turn,
    } = req.body || {};

    let nextEmail: string | null = null;
    if (email !== undefined) {
      if (ctx.userRole !== 'tenant_admin') {
        sendApiError(res, 403, 'FORBIDDEN_EMAIL_UPDATE', 'Chỉ Tenant Admin mới được đổi email nhân sự.');
        return;
      }
      const cleaned = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
        sendApiError(res, 422, 'INVALID_EMAIL', 'Định dạng email không hợp lệ.');
        return;
      }
      nextEmail = cleaned;
    }

    if (role !== undefined) {
      if (ctx.userRole !== 'tenant_admin' || (role !== 'sale' && role !== 'manager')) {
        sendApiError(res, 403, 'FORBIDDEN_ROLE_ASSIGNMENT', 'Chỉ Tenant Admin mới được đổi vai trò giữa Sale và Manager.');
        return;
      }
    }

    let passwordHash: string | null = null;
    if (password && String(password).length >= 8) {
      passwordHash = await hashPassword(String(password), APP_CONFIG.bcryptRounds);
    }

    const patchOutcome = await withTenantTransaction(ctx.tenantId, async (client) => {
      const tenantCfg = await getTenantSettingsCached(ctx.tenantId, client);

      let normalizedPhone: string | null = null;
      let hasPhoneUpdate = false;
      if (phone !== undefined) {
        hasPhoneUpdate = true;
        const rawPhoneStr = String(phone || '').trim();
        if (rawPhoneStr) {
          const pCheck = validateAndNormalizePhone(rawPhoneStr, {
            default_dial_code: tenantCfg.default_dial_code,
            allow_international_phones: tenantCfg.allow_international_phones,
            allow_landline_phones: tenantCfg.allow_landline_phones,
            vn_mobile_prefixes: tenantCfg.vn_mobile_prefixes,
            custom_phone_regex: tenantCfg.custom_phone_regex,
            block_repeated_digits: tenantCfg.block_repeated_digits,
          });
          if (!pCheck.valid) {
            throw new Error(`INVALID_PHONE:${pCheck.reason || 'Số điện thoại không hợp lệ.'}`);
          }
          normalizedPhone = pCheck.normalizedE164;
        } else {
          normalizedPhone = null;
        }
      }

      if (nextEmail) {
        const dupEmailRes = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE tenant_id = $1 AND LOWER(email) = $2 AND id <> $3 LIMIT 1',
          [ctx.tenantId, nextEmail, targetUserId]
        );
        if (dupEmailRes.rows.length > 0) {
          throw new Error('EMAIL_ALREADY_EXISTS');
        }
      }

      const uUpd = await client.query<{
        full_name: string;
        role: 'tenant_admin' | 'manager' | 'sale';
        is_external_agency: boolean;
      }>(
        `UPDATE users
         SET full_name = COALESCE($3, full_name),
             phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
             is_external_agency = COALESCE($6, is_external_agency),
             role = COALESCE($7, role),
             role_id = CASE
               WHEN $7::text IS NOT NULL THEN (
                 SELECT tr.id FROM tenant_roles tr
                 WHERE tr.tenant_id = $1 AND LOWER(tr.role_key) = LOWER($7)
                 LIMIT 1
               )
               ELSE role_id
             END,
             password_hash = COALESCE($8, password_hash),
             email = COALESCE($9, email),
             account_id = CASE WHEN $9::text IS NOT NULL THEN NULL ELSE account_id END,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2
         RETURNING full_name, role, is_external_agency`,
        [
          ctx.tenantId,
          targetUserId,
          full_name ? String(full_name).trim() : null,
          hasPhoneUpdate,
          normalizedPhone,
          typeof is_external_agency === 'boolean' ? is_external_agency : null,
          role || null,
          passwordHash,
          nextEmail,
        ]
      );
      const updatedUserRow = uUpd.rows[0] || null;
      const resolvedFullName = updatedUserRow?.full_name || (full_name ? String(full_name).trim() : 'Sale');

      const pUpd = await client.query<{ is_available: boolean; vacation_mode: boolean; status: string }>(
        `UPDATE tenant_user_profiles
         SET is_available = COALESCE($3, is_available),
             vacation_mode = COALESCE($4, vacation_mode),
             work_schedule = COALESCE($5::jsonb, work_schedule),
             zalo_chat_id = CASE WHEN $6::boolean THEN $7 ELSE zalo_chat_id END,
             skipped_credit = COALESCE($8, skipped_credit),
             is_silent = COALESCE($9, is_silent),
             sheet_sync_url = CASE WHEN $10::boolean THEN $11 ELSE sheet_sync_url END,
             sheet_tab_name = CASE WHEN $12::boolean THEN $13 ELSE sheet_tab_name END,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND user_id = $2
         RETURNING is_available, vacation_mode, status`,
        [
          ctx.tenantId,
          targetUserId,
          typeof is_available === 'boolean' ? is_available : null,
          typeof vacation_mode === 'boolean' ? vacation_mode : null,
          work_schedule ? JSON.stringify(work_schedule) : null,
          zalo_chat_id !== undefined,
          zalo_chat_id ? String(zalo_chat_id).trim() : null,
          typeof skipped_credit === 'number' ? Math.max(0, Math.round(skipped_credit)) : null,
          typeof is_silent === 'boolean' ? is_silent : null,
          sheet_sync_url !== undefined,
          sheet_sync_url ? String(sheet_sync_url).trim() : null,
          sheet_tab_name !== undefined,
          sheet_tab_name ? String(sheet_tab_name).trim() : null,
        ]
      );

      if ((typeof receive_ratio === 'number' && receive_ratio >= 1) || (typeof data_per_turn === 'number' && data_per_turn >= 1)) {
        const updRes = await client.query(
          `UPDATE round_consultants
           SET receive_ratio = COALESCE($3, receive_ratio),
               data_per_turn = COALESCE($4, data_per_turn),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND user_id = $2`,
          [
            ctx.tenantId,
            targetUserId,
            typeof receive_ratio === 'number' && receive_ratio >= 1 ? Math.floor(receive_ratio) : null,
            typeof data_per_turn === 'number' && data_per_turn >= 1 ? Math.floor(data_per_turn) : null,
          ]
        );
        if ((updRes.rowCount || 0) === 0) {
          const roundRes = await client.query<{ id: string }>(
            'SELECT id FROM distribution_rounds WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC LIMIT 1',
            [ctx.tenantId]
          );
          if (roundRes.rows[0]?.id) {
            await client.query(
              `INSERT INTO round_consultants (tenant_id, round_id, user_id, receive_ratio, data_per_turn)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT DO NOTHING`,
              [
                ctx.tenantId,
                roundRes.rows[0].id,
                targetUserId,
                typeof receive_ratio === 'number' && receive_ratio >= 1 ? Math.floor(receive_ratio) : 1,
                typeof data_per_turn === 'number' && data_per_turn >= 1 ? Math.floor(data_per_turn) : 1,
              ]
            );
          }
        }
      }

      const slaMembersToCancel: string[] = [];
      let recalledCount = 0;
      const prof = pUpd.rows[0];
      const toggledAvailability = typeof is_available === 'boolean' || typeof vacation_mode === 'boolean';
      if (toggledAvailability && prof && (!prof.is_available || prof.vacation_mode)) {
        const unacc = await client.query<{ id: string; stage_id: string }>(
          `UPDATE leads
           SET status = 'recalled', assigned_to = NULL, updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND assigned_to = $2 AND is_accepted = false AND status = 'assigned'
           RETURNING id, stage_id`,
          [ctx.tenantId, targetUserId]
        );
        recalledCount = unacc.rows.length;
        if (recalledCount > 0) {
          for (const r of unacc.rows) {
            slaMembersToCancel.push(`${r.id}:${r.stage_id}`);
          }
          await client.query(
            `INSERT INTO lead_timeline_events (
              tenant_id, lead_id, event_type, event_category, actor_id, actor_role, actor_name, title, content, metadata
            )
            SELECT $1, unnest($2::uuid[]), 'admin_offline_recall', 'system', $3, $4, $5, $6, $7, '{}'::jsonb`,
            [
              ctx.tenantId,
              unacc.rows.map((r) => r.id),
              ctx.userId,
              ctx.userRole,
              ctx.userName || 'Manager',
              `AUTO_RECALL: Thu hồi lead chưa tiếp nhận khi tắt Online / bật Nghỉ phép cho ${resolvedFullName}`,
              prof.vacation_mode ? 'Chuyển sang chế độ Nghỉ phép' : 'Tắt công tắc nhận số Online',
            ]
          );
        }
      }

      const shouldDrain =
        toggledAvailability &&
        Boolean(prof && prof.status === 'active' && prof.is_available && !prof.vacation_mode);

      return { updatedUserRow, resolvedFullName, slaMembersToCancel, recalledCount, shouldDrain };
    });

    if (patchOutcome.updatedUserRow) {
      tenantRedis.setCachedUserAuth(ctx.tenantId, targetUserId, {
        role: patchOutcome.updatedUserRow.role,
        isExternalAgency: Boolean(patchOutcome.updatedUserRow.is_external_agency),
      });
    }
    if (passwordHash && targetUserId !== ctx.userId) {
      await tenantRedis.blacklistUser(ctx.tenantId, targetUserId, 'password_changed');
    }

    for (const member of patchOutcome.slaMembersToCancel) {
      await tenantRedis.zrem('sla_queue', member, ctx.tenantId);
    }

    // If Admin toggled user online and not on vacation, drain unassigned leads if configured
    if (patchOutcome.shouldDrain) {
      await drainUnassignedLeads(ctx.tenantId, targetUserId, patchOutcome.resolvedFullName).catch(() => {});
    }

    res.json({
      success: true,
      data: {
        id: targetUserId,
        updated: true,
        unaccepted_leads_recalled: patchOutcome.recalledCount,
      },
    });
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (msg.startsWith('INVALID_PHONE:')) {
      sendApiError(res, 422, 'INVALID_PHONE', msg.slice('INVALID_PHONE:'.length));
      return;
    }
    if (msg === 'EMAIL_ALREADY_EXISTS') {
      sendApiError(res, 409, 'EMAIL_ALREADY_EXISTS', 'Email nhân sự này đã tồn tại trong doanh nghiệp.');
      return;
    }
    sendApiError(res, 500, 'UPDATE_USER_FAILED', msg || 'Không thể cập nhật thông tin nhân sự.');
  }
});

// Op 25: Manual Grant of Compensation Lead Credits
usersRouter.post('/:id/compensation', requireRoles('tenant_admin', 'manager'), async (req, res) => {
  try {
    const ctx = getTenantContext();
    const targetUserId = req.params.id;
    const credits = Math.max(1, Number(req.body?.credits || 1));

    const updated = await withTenantTransaction(ctx.tenantId, async (client) => {
      const r = await client.query<{ round_id: string; compensation_count: number }>(
        `UPDATE round_consultants
         SET compensation_count = compensation_count + $3
         WHERE id = (
           SELECT rc.id
           FROM round_consultants rc
           INNER JOIN distribution_rounds dr ON dr.tenant_id = rc.tenant_id AND dr.id = rc.round_id
           WHERE rc.tenant_id = $1 AND rc.user_id = $2 AND dr.is_active = true
           ORDER BY dr.priority ASC, rc.created_at ASC
           LIMIT 1
         )
         RETURNING round_id, compensation_count`,
        [ctx.tenantId, targetUserId, credits]
      );
      if (r.rows[0]?.round_id) {
        await client.query(
          `INSERT INTO active_compensation_logs (
             tenant_id, round_id, consultant_user_id, admin_user_id, amount, reason, source_type
           ) VALUES ($1, $2, $3, $4, $5, $6, 'manual')`,
          [ctx.tenantId, r.rows[0].round_id, targetUserId, ctx.userId, credits, 'Cấp lượt bù từ màn Nhân sự']
        );
      }
      return r.rows[0] || { compensation_count: credits };
    });

    res.json({
      success: true,
      data: { user_id: targetUserId, granted_credits: credits, compensation_count: updated.compensation_count },
    });
  } catch (err: any) {
    sendApiError(res, 500, 'GRANT_COMPENSATION_FAILED', err?.message || 'Không thể cấp lượt bù data.');
  }
});
